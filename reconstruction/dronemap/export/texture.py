"""UV atlas generation and texture baking from keyframe imagery.

Vertex colours are the default because every tool reads them, but their
resolution is capped by the mesh tessellation — at 4 cm voxels that is a very
coarse texture no matter how sharp the source video is. Baking projects the
original keyframe pixels onto a UV atlas instead, so detail is limited by camera
resolution rather than by geometry.

The work is genuinely per-texel. An earlier version splatted one texel per
*vertex*, which fills roughly 0.5% of a 4096² atlas and carries no more
information than vertex colours already do. This version rasterises each
triangle, back-projects every covered texel to its 3D position, and samples the
source image there — so a single large triangle can carry thousands of real
pixels.

Per triangle, the keyframe with the most face-on, closest, unoccluded view wins.
Blending several views sounds better but ghosts badly under any pose error, which
monocular SLAM always has.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from ..types import se3_inv

log = logging.getLogger(__name__)


def bake_texture(mesh, keyframes: list, texture_size: int = 4096,
                 max_keyframes: int = 100, min_coverage: float = 0.02):
    """Return a copy of `mesh` carrying a baked UV texture."""
    import trimesh
    import xatlas
    from PIL import Image

    verts = np.asarray(mesh.vertices, np.float32)
    faces = np.asarray(mesh.faces, np.uint32)
    if len(faces) == 0:
        raise RuntimeError("cannot bake a texture for an empty mesh")

    log.info("unwrapping %d faces with xatlas...", len(faces))
    vmapping, indices, uvs = xatlas.parametrize(verts, faces)
    new_verts = verts[vmapping].astype(np.float64)
    new_faces = indices.astype(np.int64)
    normals = _vertex_normals(new_verts, new_faces)

    kfs = _select_keyframes(keyframes, max_keyframes)
    if not kfs:
        raise RuntimeError("no keyframes with imagery available for baking")
    log.info("baking from %d keyframes into a %d^2 atlas", len(kfs), texture_size)

    # Per-vertex view quality for every candidate keyframe, so each triangle can
    # be assigned to the camera that sees it best.
    quality = np.full((len(kfs), len(new_verts)), -1.0, np.float32)
    for k, kf in enumerate(kfs):
        quality[k] = _vertex_quality(kf, new_verts, normals)

    face_quality = quality[:, new_faces].min(axis=2)      # (n_kf, n_faces)
    best_kf = np.argmax(face_quality, axis=0)
    visible = face_quality[best_kf, np.arange(len(new_faces))] > 0

    tex = np.zeros((texture_size, texture_size, 3), np.uint8)
    filled = np.zeros((texture_size, texture_size), bool)
    uv_px = np.clip(uvs * (texture_size - 1), 0, texture_size - 1)

    n_done = 0
    for k, kf in enumerate(kfs):
        face_ids = np.flatnonzero(visible & (best_kf == k))
        if face_ids.size == 0:
            continue
        n_done += _bake_faces(kf, face_ids, new_faces, new_verts, uv_px,
                              tex, filled, texture_size)

    coverage = float(filled.mean())
    log.info("rasterised %d faces; atlas coverage %.1f%%", n_done, coverage * 100)
    if coverage < min_coverage:
        raise RuntimeError(f"texture coverage only {coverage:.1%}")

    _inpaint(tex, filled)

    out = trimesh.Trimesh(vertices=new_verts, faces=new_faces, process=False)
    # Image origin is top-left, UV origin is bottom-left.
    out.visual = trimesh.visual.TextureVisuals(
        uv=uvs, image=Image.fromarray(np.flipud(tex)))
    return out


def _select_keyframes(keyframes: list, limit: int) -> list:
    usable = [kf for kf in keyframes
              if kf.image is not None or kf.spill_path is not None]
    if len(usable) > limit:
        step = int(np.ceil(len(usable) / limit))
        usable = usable[::step]
    # Texture baking samples every selected image repeatedly; reload the
    # spilled ones for the bake (the selection is capped by `limit`, so this
    # is bounded RAM, and the caller's export ends the session anyway).
    for kf in usable:
        kf.load_payload()
    # Bake from the source-resolution frame when retained.
    for kf in usable:
        if kf.image_full is not None:
            kf.image = kf.image_full
            kf.intrinsics = kf.intrinsics.scaled(
                kf.image_full.shape[1], kf.image_full.shape[0])
    return [kf for kf in usable if kf.image is not None]


def _vertex_normals(verts, faces):
    normals = np.zeros_like(verts, np.float64)
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    for k in range(3):
        np.add.at(normals, faces[:, k], fn)
    return normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)


def _vertex_quality(kf, verts: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """How well this keyframe sees each vertex; -1 where it does not.

    Quality is ``cos(incidence) / depth``: a face seen straight on and close by
    gives the sharpest, least distorted sample.
    """
    T_cw = se3_inv(kf.T_wc)
    cam = verts @ T_cw[:3, :3].T + T_cw[:3, 3]
    z = cam[:, 2]
    K = kf.intrinsics
    h, w = kf.image.shape[:2]

    q = np.full(len(verts), -1.0, np.float32)
    ok = z > 1e-3
    if not ok.any():
        return q

    u = K.fx * cam[:, 0] / np.where(ok, z, 1.0) + K.cx
    v = K.fy * cam[:, 1] / np.where(ok, z, 1.0) + K.cy
    # One-pixel border so bilinear sampling never reads outside the image.
    ok &= (u >= 1) & (u < w - 1) & (v >= 1) & (v < h - 1)

    view = verts - kf.T_wc[:3, 3]
    view /= np.maximum(np.linalg.norm(view, axis=1, keepdims=True), 1e-12)
    # Magnitude, not sign: marching-cubes triangle winding (and therefore normal
    # orientation) is not guaranteed to face the camera, and it flips between
    # surfaces seen from inside versus outside. The test being made here is
    # "is this view grazing?", which |cos| answers regardless of orientation.
    # Using the signed value silently rejects nearly every face on a scene
    # viewed from the inside.
    facing = np.abs(np.einsum("ni,ni->n", normals, view))
    ok &= facing > 0.20

    if kf.depth is not None:
        # Occlusion test against this keyframe's own depth: a vertex behind the
        # recorded surface is hidden and must not contribute colour. The depth
        # map may be at a different (track) resolution than the image being
        # baked (full-res) -- index it in its own pixel grid.
        dh, dw = kf.depth.shape[:2]
        ui = np.clip(np.round(u * (dw / w)).astype(int), 0, dw - 1)
        vi = np.clip(np.round(v * (dh / h)).astype(int), 0, dh - 1)
        d = kf.depth[vi, ui]
        ok &= (d <= 0) | (z < d + 0.15)

    q[ok] = (facing[ok] / np.maximum(z[ok], 1e-3)).astype(np.float32)
    return q


def _bake_faces(kf, face_ids, faces, verts, uv_px, tex, filled, size) -> int:
    """Rasterise faces into the atlas, sampling this keyframe per texel."""
    import cv2

    T_cw = se3_inv(kf.T_wc)
    K = kf.intrinsics
    R, t = T_cw[:3, :3], T_cw[:3, 3]
    img = kf.image
    h, w = img.shape[:2]
    done = 0

    for fi in face_ids:
        tri = faces[fi]
        uv = uv_px[tri]
        p3 = verts[tri]

        x0 = int(np.floor(uv[:, 0].min()))
        x1 = int(np.ceil(uv[:, 0].max()))
        y0 = int(np.floor(uv[:, 1].min()))
        y1 = int(np.ceil(uv[:, 1].max()))
        if x1 < x0 or y1 < y0:
            continue
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)

        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        px = np.stack([gx.ravel(), gy.ravel()], axis=1).astype(np.float64)

        # Barycentric coordinates inside the UV triangle.
        v0 = uv[1] - uv[0]
        v1 = uv[2] - uv[0]
        denom = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(denom) < 1e-12:
            continue
        rel = px - uv[0]
        b1 = (rel[:, 0] * v1[1] - v1[0] * rel[:, 1]) / denom
        b2 = (v0[0] * rel[:, 1] - rel[:, 0] * v0[1]) / denom
        b0 = 1.0 - b1 - b2
        # Small negative tolerance closes the seams between adjacent triangles.
        inside = (b0 >= -1e-3) & (b1 >= -1e-3) & (b2 >= -1e-3)
        if not inside.any():
            continue

        bary = np.stack([b0[inside], b1[inside], b2[inside]], axis=1)
        world = bary @ p3
        cam = world @ R.T + t
        z = cam[:, 2]
        good = z > 1e-3
        if not good.any():
            continue

        su = (K.fx * cam[good, 0] / z[good] + K.cx).astype(np.float32)
        sv = (K.fy * cam[good, 1] / z[good] + K.cy).astype(np.float32)
        in_img = (su >= 0) & (su < w - 1) & (sv >= 0) & (sv < h - 1)
        if not in_img.any():
            continue

        colors = cv2.remap(img, su[in_img].reshape(-1, 1), sv[in_img].reshape(-1, 1),
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        colors = colors.reshape(-1, 3)

        tx = px[inside][good][in_img][:, 0].astype(np.int32)
        ty = px[inside][good][in_img][:, 1].astype(np.int32)
        tex[ty, tx] = colors
        filled[ty, tx] = True
        done += 1
    return done


def _inpaint(tex: np.ndarray, filled: np.ndarray) -> None:
    """Bleed colour into unfilled texels so chart seams do not render black."""
    import cv2

    holes = (~filled).astype(np.uint8)
    if holes.sum() == 0:
        return
    # Dilating a few times is enough for the thin gaps between charts, and far
    # cheaper than inpainting an atlas that is mostly empty background.
    grown = cv2.dilate(tex, np.ones((3, 3), np.uint8), iterations=4)
    tex[~filled] = grown[~filled]

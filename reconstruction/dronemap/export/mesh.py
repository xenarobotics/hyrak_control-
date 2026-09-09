"""Mesh post-processing and export to industry-standard formats.

Raw marching-cubes output is not a deliverable: vertices are duplicated per
triangle, isolated speckles float in space where a few noisy depth pixels
survived, and nothing carries material information. This module turns it into
something a downstream tool will accept.

Formats: ``.ply`` (vertex colours), ``.obj`` + ``.mtl`` (+ optional baked
texture), ``.glb``/``.gltf``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)


def weld_vertices(
    verts: np.ndarray, faces: np.ndarray, colors: Optional[np.ndarray] = None,
    precision: float = 1e-5,
) -> tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    """Merge coincident vertices produced independently by adjacent MC cells.

    Marching cubes emits every triangle with its own vertices, so a typical
    surface arrives with ~6x redundancy. Welding is what makes the mesh
    manifold-ish, and it is a prerequisite for normals, decimation and any
    connectivity-based cleanup.
    """
    if len(verts) == 0:
        return verts, faces, colors

    quantized = np.round(verts / precision).astype(np.int64)
    _, unique_idx, inverse = np.unique(
        quantized, axis=0, return_index=True, return_inverse=True
    )
    new_verts = verts[unique_idx]
    new_faces = inverse.reshape(-1)[faces.reshape(-1)].reshape(faces.shape)
    new_colors = colors[unique_idx] if colors is not None else None

    # Faces that collapsed to a degenerate sliver during welding.
    keep = (
        (new_faces[:, 0] != new_faces[:, 1])
        & (new_faces[:, 1] != new_faces[:, 2])
        & (new_faces[:, 0] != new_faces[:, 2])
    )
    new_faces = new_faces[keep]

    # Welding can also make two triangles identical (same three vertices).
    # Duplicates are not harmless: they double-shade in every renderer, and they
    # break watertightness checks and boolean operations downstream.
    if len(new_faces):
        _, unique_faces = np.unique(np.sort(new_faces, axis=1), axis=0,
                                    return_index=True)
        new_faces = new_faces[np.sort(unique_faces)]
    return new_verts, new_faces.astype(np.int32), new_colors


def remove_small_components(
    verts: np.ndarray, faces: np.ndarray, colors: Optional[np.ndarray],
    min_faces: int = 200,
) -> tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    """Drop connected components smaller than `min_faces`.

    Monocular depth noise produces small floating shells that are visually
    obvious and useless. Connectivity is the right discriminator: real surface is
    connected to the rest of the scene, noise generally is not.
    """
    if len(faces) == 0:
        return verts, faces, colors
    import scipy.sparse as sp
    import scipy.sparse.csgraph as csgraph

    n = len(verts)
    e0 = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    e1 = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    adj = sp.coo_matrix((np.ones(len(e0), np.int8), (e0, e1)), shape=(n, n))
    n_comp, labels = csgraph.connected_components(adj, directed=False)
    if n_comp <= 1:
        return verts, faces, colors

    face_labels = labels[faces[:, 0]]
    counts = np.bincount(face_labels, minlength=n_comp)
    keep_components = counts >= min_faces
    if not keep_components.any():
        # Everything is small: keep the largest rather than returning nothing.
        keep_components = np.zeros(n_comp, bool)
        keep_components[int(np.argmax(counts))] = True

    keep_faces = keep_components[face_labels]
    dropped = int((~keep_components).sum())
    faces = faces[keep_faces]
    used = np.unique(faces)
    remap = np.full(n, -1, np.int64)
    remap[used] = np.arange(len(used))
    log.info("removed %d small components (%d -> %d faces)",
             dropped, len(keep_faces), int(keep_faces.sum()))
    return (verts[used], remap[faces].astype(np.int32),
            colors[used] if colors is not None else None)


def compute_vertex_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals.

    Using the un-normalised face cross product weights each face by its area,
    which shades irregular marching-cubes triangles better than averaging unit
    normals would.
    """
    normals = np.zeros_like(verts, dtype=np.float64)
    if len(faces) == 0:
        return normals.astype(np.float32)
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    for k in range(3):
        np.add.at(normals, faces[:, k], fn)
    norm = np.linalg.norm(normals, axis=1, keepdims=True)
    return (normals / np.maximum(norm, 1e-12)).astype(np.float32)


def build_trimesh(verts, faces, colors=None, normals=None):
    import trimesh

    mesh = trimesh.Trimesh(
        vertices=np.asarray(verts, np.float64),
        faces=np.asarray(faces, np.int64),
        vertex_normals=normals,
        process=False,
        validate=False,
    )
    if colors is not None and len(colors) == len(verts):
        rgba = np.empty((len(colors), 4), np.uint8)
        rgba[:, :3] = colors
        rgba[:, 3] = 255
        mesh.visual.vertex_colors = rgba
    return mesh


def simplify(mesh, target_faces: int):
    """Quadric decimation, if the backend supports it."""
    if target_faces <= 0 or len(mesh.faces) <= target_faces:
        return mesh
    try:
        out = mesh.simplify_quadric_decimation(target_faces)
        log.info("decimated mesh %d -> %d faces", len(mesh.faces), len(out.faces))
        return out
    except Exception as exc:  # noqa: BLE001 - optional (fast-simplification)
        log.warning("mesh decimation unavailable (%s); exporting full resolution", exc)
        return mesh


def close_holes(mesh):
    """Fill small holes left by unobserved regions. Best-effort."""
    try:
        import trimesh

        filled = mesh.copy()
        trimesh.repair.fill_holes(filled)
        if filled.is_watertight or len(filled.faces) > len(mesh.faces):
            return filled
    except Exception as exc:  # noqa: BLE001
        log.debug("hole filling failed: %s", exc)
    return mesh


def export_mesh(
    verts: np.ndarray,
    faces: np.ndarray,
    colors: Optional[np.ndarray],
    output_dir: Path,
    basename: str = "map",
    formats: tuple[str, ...] = ("ply", "obj", "glb"),
    simplify_target: int = 0,
    remove_clusters: bool = True,
    min_cluster_faces: int = 200,
    textured: bool = False,
    keyframes: Optional[list] = None,
    texture_size: int = 4096,
) -> dict[str, Path]:
    """Post-process and write the mesh in each requested format."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}

    if len(verts) == 0 or len(faces) == 0:
        log.warning("mesh is empty; nothing to export")
        return written

    verts, faces, colors = weld_vertices(verts, faces, colors)
    log.info("welded to %d vertices / %d faces", len(verts), len(faces))
    if remove_clusters:
        verts, faces, colors = remove_small_components(verts, faces, colors,
                                                       min_cluster_faces)
    if len(faces) == 0:
        log.warning("all geometry removed by cleanup; nothing to export")
        return written

    normals = compute_vertex_normals(verts, faces)
    mesh = build_trimesh(verts, faces, colors, normals)
    if simplify_target > 0:
        mesh = simplify(mesh, simplify_target)

    if textured and keyframes:
        from .texture import bake_texture

        try:
            mesh = bake_texture(mesh, keyframes, texture_size=texture_size)
        except Exception as exc:  # noqa: BLE001
            log.warning("texture baking failed (%s); falling back to vertex colours",
                        exc)

    for fmt in formats:
        fmt = fmt.lower().lstrip(".")
        path = output_dir / f"{basename}.{fmt}"
        try:
            before = {p.name for p in output_dir.iterdir()}
            # Export by path, not to a string. For OBJ that is what makes trimesh
            # emit the companion .mtl and texture image; exporting to a string
            # yields geometry with UVs but no material, so a baked texture is
            # silently lost. GLB embeds the texture either way.
            mesh.export(path)
            written[fmt] = path

            if fmt == "stl" and not mesh.is_watertight:
                log.warning(
                    "%s is not watertight; most slicers will still print it, "
                    "but run close_holes / Poisson reconstruction first for a "
                    "manifold solid", path.name,
                )

            extra = ""
            if fmt == "obj":
                companions = sorted(
                    p.name for p in output_dir.iterdir()
                    if p.name not in before
                    and p.suffix.lower() in (".mtl", ".png", ".jpg", ".jpeg")
                )
                if companions:
                    extra = f"  (+ {', '.join(companions)})"
                elif textured:
                    log.warning("OBJ written without a material; the baked "
                                "texture will not be visible in this format")
            log.info("wrote %s (%.1f MB)%s", path, path.stat().st_size / 1e6, extra)
        except Exception as exc:  # noqa: BLE001 - one bad format must not lose the rest
            log.error("failed to export %s: %s", fmt, exc)

    return written

"""Session export: everything that happens when the stream ends.

Triggered by `on_stream_stop` -- an explicit control call, a signal, end of file,
or the transport going quiet. Produces a self-contained, dated session directory
holding the map, the trajectory, the configuration that produced them, and a
metrics report, so a run can be reproduced or audited later.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from ..types import Keyframe, se3_inv
from .mesh import export_mesh
from .pointcloud import estimate_normals, write_ply

log = logging.getLogger(__name__)


def session_dir(base: str | Path, name: str) -> Path:
    """Timestamped directory so consecutive runs never overwrite each other."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = Path(base) / f"{stamp}_{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_trajectory_tum(path: Path, keyframes: list[Keyframe]) -> Path:
    """TUM format: ``timestamp tx ty tz qx qy qz qw``.

    The de-facto interchange format for SLAM trajectories -- directly consumable
    by evo, TUM's own tools, and most evaluation scripts.
    """
    lines = ["# timestamp tx ty tz qx qy qz qw"]
    for kf in keyframes:
        t = kf.T_wc[:3, 3]
        q = _mat_to_quat(kf.T_wc[:3, :3])
        lines.append(
            f"{kf.timestamp:.6f} {t[0]:.6f} {t[1]:.6f} {t[2]:.6f} "
            f"{q[0]:.6f} {q[1]:.6f} {q[2]:.6f} {q[3]:.6f}"
        )
    path.write_text("\n".join(lines) + "\n")
    return path


def _mat_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> (qx, qy, qz, qw), via the numerically stable branch."""
    tr = np.trace(R)
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
            w = (R[2, 1] - R[1, 2]) / s
            x, y, z = 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
        elif i == 1:
            s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
            w = (R[0, 2] - R[2, 0]) / s
            x, y, z = (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
        else:
            s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
            w = (R[1, 0] - R[0, 1]) / s
            x, y, z = (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    return np.array([x, y, z, w])


def save_keyframes(out_dir: Path, keyframes: list[Keyframe], stride: int = 1) -> Path:
    """Dump RGB + depth + poses.

    This is exactly the input a 3D Gaussian Splatting trainer expects, so a
    photoreal pass can be run offline later without re-flying anything.
    """
    import cv2

    kf_dir = out_dir / "keyframes"
    (kf_dir / "images").mkdir(parents=True, exist_ok=True)
    (kf_dir / "depth").mkdir(parents=True, exist_ok=True)

    meta = []
    for kf in keyframes[::stride]:
        name = f"kf_{kf.kf_id:05d}"
        # Old keyframes may have spilled to disk under the RAM cap; reload one
        # at a time and drop again so the export itself stays bounded.
        was_spilled = kf.image is None and kf.spill_path is not None
        kf.load_payload()
        if kf.image is None:
            continue
        # Save the source-resolution frame when it was retained: REFINE
        # reprocesses these files, and writing the downscaled track image
        # silently threw away the resolution the camera actually delivered.
        img = kf.image_full if kf.image_full is not None else kf.image
        cv2.imwrite(str(kf_dir / "images" / f"{name}.png"),
                    cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
        if kf.depth is not None:
            # 16-bit millimetres: lossless to 1 mm and half the size of float32.
            np.save(kf_dir / "depth" / f"{name}.npy",
                    (np.clip(kf.depth, 0, 65.535) * 1000).astype(np.uint16))
        if was_spilled:
            kf.drop_payload()
        # Intrinsics scaled to the resolution of the image actually written,
        # so the metadata and the pixels agree for downstream consumers.
        h, w = img.shape[:2]
        K = kf.intrinsics.scaled(w, h)
        meta.append({
            "id": kf.kf_id, "name": name, "timestamp": kf.timestamp,
            "T_wc": kf.T_wc.tolist(),
            "intrinsics": {"fx": K.fx, "fy": K.fy, "cx": K.cx, "cy": K.cy,
                           "width": K.width, "height": K.height},
        })
    (kf_dir / "keyframes.json").write_text(json.dumps(meta, indent=2))
    log.info("saved %d keyframes to %s", len(meta), kf_dir)
    return kf_dir


def export_session(
    cfg,
    mapper,
    scene_map,
    out_dir: Optional[Path] = None,
    report: Optional[dict] = None,
) -> dict:
    """Run the full export pipeline. Returns a manifest of what was written."""
    ecfg = cfg.export
    out_dir = Path(out_dir) if out_dir else session_dir(ecfg.output_dir, cfg.session_name)
    log.info("exporting session to %s", out_dir)
    t0 = time.perf_counter()

    manifest: dict = {"dir": str(out_dir), "files": {}, "stats": {}}
    keyframes = scene_map.all_keyframes()
    min_w = cfg.fusion.min_extract_weight

    # Ordering is a durability decision: the cheap, irreplaceable artifacts
    # (trajectory, keyframes, point cloud, config) are written FIRST, the
    # expensive mesh LAST. Meshing a large scan can run for minutes (or hang
    # in texture unwrapping) and the process can be killed while it does -
    # with mesh-first ordering one such export lost an entire scan: the
    # directory was created and NOTHING was ever written. With this order a
    # killed mesh still leaves everything an offline reprocess needs.

    # -- trajectory, keyframes, config -------------------------------------
    if ecfg.save_trajectory and keyframes:
        manifest["files"]["trajectory"] = str(
            write_trajectory_tum(out_dir / "trajectory_tum.txt", keyframes))
    if ecfg.save_keyframes and keyframes:
        manifest["files"]["keyframes"] = str(save_keyframes(out_dir, keyframes))

    try:
        cfg.dump(out_dir / "config.yaml")
        manifest["files"]["config"] = str(out_dir / "config.yaml")
    except Exception as exc:  # noqa: BLE001
        log.warning("could not dump config: %s", exc)

    # -- point cloud -------------------------------------------------------
    xyz = np.zeros((0, 3), np.float32)
    rgb = np.zeros((0, 3), np.uint8)
    if ecfg.export_pointcloud or ecfg.export_splat:
        try:
            xyz, rgb = mapper.extract_point_cloud(min_weight=min_w)
            manifest["stats"]["surface_points"] = int(len(xyz))
        except Exception as exc:  # noqa: BLE001
            log.exception("point extraction failed: %s", exc)

    if ecfg.export_pointcloud and len(xyz):
        try:
            centroid = np.array([kf.T_wc[:3, 3] for kf in keyframes]).mean(axis=0) \
                if keyframes else xyz.mean(axis=0)
            normals = estimate_normals(xyz, k=16, viewpoint=centroid)
            manifest["files"]["pointcloud"] = str(
                write_ply(out_dir / "map_points.ply", xyz, rgb, normals))
        except Exception as exc:  # noqa: BLE001
            log.exception("point cloud export failed: %s", exc)

    # -- gaussian splat seeds ----------------------------------------------
    if ecfg.export_splat and len(xyz):
        try:
            from .splat import export_splats

            centroid = xyz.mean(axis=0)
            normals = estimate_normals(xyz, k=16, viewpoint=centroid)
            written = export_splats(out_dir, "map", xyz, rgb, normals,
                                    voxel_size=cfg.fusion.voxel_size_m)
            manifest["files"].update({k: str(v) for k, v in written.items()})
        except Exception as exc:  # noqa: BLE001
            log.exception("splat export failed: %s", exc)

    # -- mesh (LAST - see the ordering note above) -------------------------
    try:
        verts, faces, colors = mapper.extract_mesh(min_weight=min_w)
        manifest["stats"]["mesh_vertices_raw"] = int(len(verts))
        manifest["stats"]["mesh_faces_raw"] = int(len(faces))
        if len(verts):
            written = export_mesh(
                verts, faces, colors, out_dir, basename="map",
                formats=tuple(ecfg.formats),
                simplify_target=ecfg.mesh_simplify_target,
                remove_clusters=ecfg.remove_small_clusters,
                min_cluster_faces=ecfg.min_cluster_faces,
                textured=ecfg.textured,
                keyframes=keyframes,
                texture_size=ecfg.texture_size,
            )
            manifest["files"].update({k: str(v) for k, v in written.items()})
        else:
            log.warning("no mesh geometry to export")
    except Exception as exc:  # noqa: BLE001 - one failed format must not lose the rest
        log.exception("mesh export failed: %s", exc)
        manifest["mesh_error"] = str(exc)

    manifest["stats"].update({
        "keyframes": len(keyframes),
        "landmarks": scene_map.n_points,
        "export_seconds": round(time.perf_counter() - t0, 2),
    })
    if report:
        manifest["report"] = report
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))

    log.info("export complete in %.1fs -> %s", time.perf_counter() - t0, out_dir)
    for key, path in manifest["files"].items():
        log.info("  %-12s %s", key, path)
    return manifest

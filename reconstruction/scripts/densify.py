"""Dense reconstruction from a photogrammetry scan.

Takes a COLMAP sparse model produced by ``photoscan.py`` and turns its
constellation of points into a dense colored surface:

  COLMAP poses (accurate, arbitrary scale)
    + Depth Anything 3 per-frame depth (dense, metric)
    -> metric scale recovered by aligning DA3 depth to the sparse points
    -> every frame fused through the CUDA TSDF
    -> dense point cloud + mesh (PLY / GLB / STL)

The division of labour is deliberate: COLMAP supplies geometry-grade camera
poses (its whole job is multi-view consistency), while DA3 supplies the dense
per-pixel depth those poses are missing, cross-calibrated per frame against
COLMAP's own triangulated points so the fusion never trusts either source
alone.

Usage:
    python scripts/densify.py --scan data/photogrammetry/scan
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dronemap.config import Config  # noqa: E402
from dronemap.types import CameraIntrinsics  # noqa: E402

log = logging.getLogger("densify")


def pick_model(scan: Path, model: str) -> Path:
    import pycolmap

    if model != "auto":
        return scan / "sparse" / model
    best, best_n = None, -1
    for d in sorted((scan / "sparse").iterdir()):
        if not d.is_dir():
            continue
        n = pycolmap.Reconstruction(d).num_reg_images()
        if n > best_n:
            best, best_n = d, n
    if best is None:
        raise SystemExit(f"no COLMAP model under {scan}/sparse — run photoscan first")
    return best


def load_frames(rec, images_dir: Path):
    """Yield (name, rgb_undistorted, intrinsics, T_wc_colmap, sparse_uvz)."""
    for img in sorted(rec.images.values(), key=lambda i: i.name):
        cam = rec.cameras[img.camera_id]
        f, cx, cy, k1 = [float(v) for v in cam.params]
        w, h = int(cam.width), int(cam.height)
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        dist = np.array([k1, 0, 0, 0, 0], np.float64)

        bgr = cv2.imread(str(images_dir / img.name))
        if bgr is None:
            log.warning("missing image %s; skipping", img.name)
            continue
        rgb = cv2.cvtColor(cv2.undistort(bgr, K, dist), cv2.COLOR_BGR2RGB)

        cfw = img.cam_from_world() if callable(img.cam_from_world) else img.cam_from_world
        T_cw = np.eye(4)
        T_cw[:3, :] = cfw.matrix()
        T_wc = np.linalg.inv(T_cw)

        # Project this image's triangulated points to (u, v, z) in the
        # undistorted pinhole frame -- the anchors for depth alignment.
        uvz = []
        for p2 in img.points2D:
            if not p2.has_point3D():
                continue
            X = rec.points3D[p2.point3D_id].xyz
            Xc = T_cw[:3, :3] @ X + T_cw[:3, 3]
            if Xc[2] <= 0.05:
                continue
            u, v = f * Xc[0] / Xc[2] + cx, f * Xc[1] / Xc[2] + cy
            if 0 <= u < w and 0 <= v < h:
                uvz.append((u, v, Xc[2]))
        intr = CameraIntrinsics(width=w, height=h, fx=f, fy=f, cx=cx, cy=cy)
        yield img.name, rgb, intr, T_wc, np.array(uvz, np.float64)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", default="data/photogrammetry/scan")
    ap.add_argument("--model", default="auto", help="sparse model id, or auto = largest")
    ap.add_argument("--voxel", type=float, default=0.02, help="voxel size in metres")
    ap.add_argument("--max-depth", type=float, default=8.0)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    import pycolmap

    scan = Path(args.scan)
    model_dir = pick_model(scan, args.model)
    rec = pycolmap.Reconstruction(model_dir)
    log.info("model %s: %d images, %d sparse points",
             model_dir.name, rec.num_reg_images(), rec.num_points3D())

    cfg = Config()
    cfg.depth.backend = "da3"
    cfg.depth.model = "depth-anything/DA3METRIC-LARGE"
    cfg.depth.input_size = 504
    cfg.depth.max_depth_m = args.max_depth
    cfg.fusion.voxel_size_m = args.voxel
    cfg.fusion.max_integration_depth_m = args.max_depth
    cfg.export.formats = ["ply", "glb", "stl"]

    from dronemap.depth.base import build_depth_estimator

    est = build_depth_estimator(cfg)

    # Pass 1: depth for every frame + the DA3-vs-COLMAP depth ratios.
    frames, ratios = [], []
    t0 = time.time()
    for name, rgb, intr, T_wc, uvz in load_frames(rec, scan / "images"):
        depth = est.predict(rgb, intr)
        r = []
        for u, v, z in uvz:
            d = depth[int(round(v)), int(round(u))]
            if d > 0:
                r.append(d / z)
        frames.append({"name": name, "rgb": rgb, "intr": intr,
                       "T_wc": T_wc, "uvz": uvz, "depth": depth})
        ratios.extend(r)
    est.close()
    if len(ratios) < 30:
        raise SystemExit("too few depth/sparse correspondences to recover scale")
    k = float(np.median(ratios))
    spread = float(np.percentile(ratios, 75) / np.percentile(ratios, 25))
    log.info("metric scale: 1 COLMAP unit = %.3f m  "
             "(from %d anchors, IQR ratio %.2f; > ~1.5 means inconsistent depth)",
             k, len(ratios), spread)

    # Pass 2: fuse in metric units.
    from dronemap.fusion.base import build_mapper

    mapper = build_mapper(cfg)
    used = 0
    for fr in frames:
        T = fr["T_wc"].copy()
        T[:3, 3] *= k  # world (and camera centres) into metres
        depth = fr["depth"]
        # Per-frame refinement: pin DA3's depth to this frame's own sparse
        # anchors so small per-view scale wobble does not double surfaces.
        zs = [(depth[int(round(v)), int(round(u))], z * k)
              for u, v, z in fr["uvz"]
              if depth[int(round(v)), int(round(u))] > 0]
        if len(zs) >= 8:
            b = float(np.median([zc / zd for zd, zc in zs]))
            b = float(np.clip(b, 0.5, 2.0))
        else:
            b = 1.0
        mapper.integrate(depth * b, fr["rgb"], T, fr["intr"])
        used += 1
    log.info("fused %d frames in %.1fs total", used, time.time() - t0)

    # Extract + export.
    from dronemap.export.mesh import export_mesh
    from dronemap.export.pointcloud import estimate_normals, write_ply

    min_w = cfg.fusion.min_extract_weight
    xyz, rgb = mapper.extract_point_cloud(min_weight=min_w)
    log.info("dense cloud: %d points", len(xyz))
    if len(xyz):
        write_ply(scan / "dense_points.ply", xyz, rgb,
                  estimate_normals(xyz, viewpoint=None))
        log.info("wrote %s", scan / "dense_points.ply")

    verts, faces, colors = mapper.extract_mesh(min_weight=min_w)
    log.info("mesh: %d verts, %d faces", len(verts), len(faces))
    if len(verts):
        export_mesh(verts, faces, colors, scan, basename="dense_mesh",
                    formats=tuple(cfg.export.formats))
    print(f"\ndense reconstruction written to {scan}/dense_points.ply "
          f"and {scan}/dense_mesh.(ply|glb|stl)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

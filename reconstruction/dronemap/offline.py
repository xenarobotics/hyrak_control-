"""The offline (photogrammetry) pipeline as callable steps.

The same record -> SfM -> densify chain that ``scripts/photoscan.py`` and
``scripts/densify.py`` expose on the command line, but as functions with
structured returns and a progress callback, so the control panel can drive it
and show real phase/status instead of a spinner.

Every step reports through ``progress(phase, detail)`` and returns plain
dicts; nothing here prints.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

log = logging.getLogger(__name__)

Progress = Callable[[str, str], None]


def _noop(_phase: str, _detail: str) -> None:
    pass


def list_video_devices() -> list[dict]:
    """Enumerate /dev/video* capture devices with their human names."""
    out = []
    sys_root = Path("/sys/class/video4linux")
    if not sys_root.exists():
        return out
    for d in sorted(sys_root.iterdir(),
                    key=lambda p: int("".join(filter(str.isdigit, p.name)) or 0)):
        try:
            name = (d / "name").read_text().strip()
        except OSError:
            continue
        # v4l2 exposes a metadata node alongside each capture node; only the
        # capture one has an index file reading 0.
        try:
            if (d / "index").read_text().strip() != "0":
                continue
        except OSError:
            pass
        out.append({"device": f"/dev/{d.name}", "name": name})
    return out


def record_clip(device: str, seconds: int, out_dir: Path,
                progress: Progress = _noop) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    clip = out_dir / "footage.mp4"
    progress("recording", f"0/{seconds}s — move the camera in slow arcs")
    cmd = ["ffmpeg", "-f", "v4l2", "-input_format", "mjpeg",
           "-video_size", "1920x1080", "-i", device,
           "-t", str(seconds), "-c:v", "copy", "-y", str(clip),
           "-loglevel", "error"]
    proc = subprocess.Popen(cmd)
    t0 = time.time()
    while proc.poll() is None:
        time.sleep(1.0)
        progress("recording", f"{min(int(time.time()-t0), seconds)}/{seconds}s "
                              "— move the camera in slow arcs")
    if proc.returncode != 0:
        raise RuntimeError(f"recording failed (ffmpeg exit {proc.returncode}); "
                           "is the camera free and uncovered?")
    return clip


def extract_frames(video: Path, out_dir: Path, fps: float = 4.0,
                   min_brightness: float = 25.0, min_sharpness: float = 40.0,
                   progress: Progress = _noop) -> dict:
    imgdir = out_dir / "images"
    if imgdir.exists():
        shutil.rmtree(imgdir)
    imgdir.mkdir(parents=True)
    cap = cv2.VideoCapture(str(video))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / fps))
    i = kept = dark = blurred = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if g.mean() < min_brightness:
                dark += 1
            elif cv2.Laplacian(g, cv2.CV_64F).var() < min_sharpness:
                blurred += 1
            else:
                cv2.imwrite(str(imgdir / f"f{kept:05d}.jpg"), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 95])
                kept += 1
            if (kept + dark + blurred) % 20 == 0:
                progress("extracting frames",
                         f"{kept} kept / {blurred} blurred / {dark} dark")
        i += 1
    cap.release()
    return {"kept": kept, "blurred": blurred, "dark": dark}


def run_sfm(out_dir: Path, progress: Progress = _noop) -> dict:
    """COLMAP sparse reconstruction. Returns registration stats + grade."""
    import pycolmap

    db, imgs, sparse = out_dir / "database.db", out_dir / "images", out_dir / "sparse"
    db.unlink(missing_ok=True)
    for leftover in (out_dir / "database.db-wal", out_dir / "database.db-shm"):
        leftover.unlink(missing_ok=True)
    if sparse.exists():
        shutil.rmtree(sparse)
    sparse.mkdir()

    progress("matching", "extracting SIFT features")
    ropt = pycolmap.ImageReaderOptions(camera_model="SIMPLE_RADIAL")
    pycolmap.extract_features(db, imgs, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=ropt)
    progress("matching", "matching all image pairs")
    pycolmap.match_exhaustive(db)
    progress("mapping", "incremental reconstruction")
    recs = pycolmap.incremental_mapping(db, imgs, sparse)

    n_images = len(list(imgs.iterdir()))
    if not recs:
        return {"grade": "FAILED", "registered": 0, "images": n_images,
                "models": 0, "points": 0,
                "note": "no views connected — footage lacks overlap or texture"}
    best_id, best = max(recs.items(), key=lambda kv: kv[1].num_reg_images())
    best.export_PLY(out_dir / "sparse_points.ply")
    frac = best.num_reg_images() / max(n_images, 1)
    if len(recs) == 1 and frac > 0.8:
        grade, note = "GOOD", "one connected model"
    elif frac > 0.5:
        grade, note = "PARTIAL", "gaps where the camera moved too fast"
    else:
        grade, note = "FRAGMENTED", "not enough overlap, texture, or sharpness"
    return {"grade": grade, "note": note, "registered": best.num_reg_images(),
            "images": n_images, "models": len(recs),
            "points": best.num_points3D(), "best_model": str(best_id)}


#: Views per multi-view DA3 window. 8 costs ~320 ms / 2.5 GiB on the 8 GB
#: target GPU. Windows do not overlap: every window is pose-conditioned on
#: the same COLMAP scaffold, so cross-window consistency comes from the
#: registration, not from shared views.
MULTIVIEW_WINDOW = 8


def densify(scan_dir: Path, model: str = "auto", voxel: float = 0.02,
            max_depth: float = 8.0, multiview: bool = False,
            progress: Progress = _noop) -> dict:
    """COLMAP poses + DA3 depth -> metric dense cloud + mesh. Returns files.

    ``multiview=True`` runs DA3's native multi-view mode (windows of frames
    inferred together, pose-conditioned on COLMAP w2c) with per-window
    plausibility gating. MEASURED VERDICT (2026-09-05, DA3-LARGE, two real
    scans), which is why the default is False: per-frame DA3-METRIC depth +
    sparse-anchor snapping is the stronger configuration today. On a sharp
    1080p orbit, gated multi-view gave marginally thinner surfaces (1.41 vs
    1.51 cm median) at a 4x COVERAGE LOSS (33k vs 129k points -- windows are
    self-consistent but still conflict across window boundaries in the
    TSDF); on a soft 640x360 corridor every window was correctly rejected by
    the pose-residual gate (residuals 7-291% of scene depth) and the run
    converged to per-frame anyway. The path is kept for future checkpoints
    with stronger pose conditioning. Metric scale comes from single-view
    DA3-METRIC anchors either way; any multi-view failure falls back to the
    per-frame path.
    """
    import pycolmap

    from .config import Config
    from .depth.base import build_depth_estimator
    from .export.mesh import export_mesh
    from .export.pointcloud import estimate_normals, write_ply
    from .fusion.base import build_mapper
    from .types import CameraIntrinsics

    sparse_root = scan_dir / "sparse"
    if model == "auto":
        candidates = [d for d in sorted(sparse_root.iterdir()) if d.is_dir()]
        if not candidates:
            raise RuntimeError("no sparse model — run the scan step first")
        model_dir = max(candidates,
                        key=lambda d: pycolmap.Reconstruction(d).num_reg_images())
    else:
        model_dir = sparse_root / model
    rec = pycolmap.Reconstruction(model_dir)

    cfg = Config()
    cfg.depth.backend = "da3"
    cfg.depth.model = "depth-anything/DA3METRIC-LARGE"
    cfg.depth.input_size = 504
    cfg.depth.max_depth_m = max_depth
    cfg.fusion.voxel_size_m = voxel
    cfg.fusion.max_integration_depth_m = max_depth

    progress("densifying", "loading Depth Anything 3")
    est = build_depth_estimator(cfg)

    frames = []
    items = sorted(rec.images.values(), key=lambda i: i.name)
    for n, img in enumerate(items):
        cam = rec.cameras[img.camera_id]
        f, cx, cy, k1 = [float(v) for v in cam.params]
        w, h = int(cam.width), int(cam.height)
        bgr = cv2.imread(str(scan_dir / "images" / img.name))
        if bgr is None:
            continue
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        rgb = cv2.cvtColor(cv2.undistort(bgr, K, np.array([k1, 0, 0, 0, 0.0])),
                           cv2.COLOR_BGR2RGB)
        cfw = img.cam_from_world() if callable(img.cam_from_world) else img.cam_from_world
        T_cw = np.eye(4)
        T_cw[:3, :] = cfw.matrix()
        T_wc = np.linalg.inv(T_cw)
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
        frames.append({"rgb": rgb, "intr": intr, "T_wc": T_wc, "T_cw": T_cw,
                       "K3": np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]],
                                      np.float64),
                       "uvz": uvz, "depth": None})

    def _anchor_ratios(sel) -> list:
        """d_metric / z_colmap over the sparse anchors of selected frames."""
        out = []
        for fr in sel:
            depth = est.predict(fr["rgb"], fr["intr"])
            fr["_metric_depth"] = depth
            for u, v, z in fr["uvz"]:
                d = depth[int(round(v)), int(round(u))]
                if d > 0:
                    out.append(d / z)
        return out

    used_multiview = False
    est_alive = True
    if multiview and len(frames) >= 3:
        mv = None
        try:
            # Metric scale from a spread of single-view DA3-METRIC anchors:
            # the multi-view model below is the pose-conditioned any-view
            # variant (DA3-LARGE -- the METRIC checkpoint has no camera
            # encoder), and its aligned output is in COLMAP units.
            step = max(1, len(frames) // 12)
            anchors = frames[::step]
            progress("densifying",
                     f"metric anchors ({len(anchors)} frames)")
            ratios = _anchor_ratios(anchors)
            if len(ratios) < 30:
                raise RuntimeError("too few metric anchors")
            k = float(np.median(ratios))
            est.close()  # free VRAM before the second model loads
            est_alive = False

            import torch
            from depth_anything_3.api import DepthAnything3

            progress("densifying", "loading DA3 multi-view model")
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            mv = DepthAnything3.from_pretrained(
                "depth-anything/DA3-LARGE").to(dev).eval()

            n_win = (len(frames) + MULTIVIEW_WINDOW - 1) // MULTIVIEW_WINDOW
            chunks = [list(c) for c in np.array_split(frames, n_win)]
            n_mv = 0
            for wi, chunk in enumerate(chunks):
                progress("densifying",
                         f"consistent depth window {wi + 1}/{n_win}")
                try:
                    with torch.inference_mode():
                        # align_to_input_ext_scale=False: keep the model's own
                        # poses (umeyama-mapped into the COLMAP frame). The
                        # depth maps are consistent with THOSE poses, not with
                        # COLMAP's -- integrating with COLMAP poses leaves
                        # per-frame pose residuals that cancel each other in
                        # the TSDF (measured: the fused cloud collapsed to a
                        # fraction of the scene).
                        pred = mv.inference(
                            [fr["rgb"] for fr in chunk],
                            extrinsics=np.stack([fr["T_cw"] for fr in chunk]),
                            intrinsics=np.stack([fr["K3"] for fr in chunk]),
                            align_to_input_ext_scale=False,
                            process_res=int(cfg.depth.input_size),
                        )
                except Exception as exc:  # noqa: BLE001
                    # A near-static or too-short window makes the pose
                    # alignment degenerate; that window falls back to
                    # single-view below, the rest stay consistent.
                    log.warning("multi-view window %d/%d failed (%s); "
                                "will fill per-frame", wi + 1, n_win, exc)
                    continue
                # Gate on registration quality: compare the model's aligned
                # camera centres with COLMAP's. When they agree, the window's
                # consistent depth beats per-frame (measured: 1.30 vs 1.51 cm
                # surface thickness on a sharp orbit scan). When they don't
                # (colinear corridor windows, compressed input), forcing it in
                # THICKENS the fusion (1.73 vs 0.96 cm) -- those windows are
                # better served by per-frame depth + anchor snapping.
                c_model = np.array([np.linalg.inv(
                    np.vstack([np.asarray(pred.extrinsics[i], np.float64)[:3, :4],
                               [0, 0, 0, 1]]))[:3, 3] for i in range(len(chunk))])
                c_colmap = np.array([np.linalg.inv(fr["T_cw"])[:3, 3]
                                     for fr in chunk])
                zs_win = [z for fr in chunk for _, _, z in fr["uvz"]]
                scene_z = float(np.median(zs_win)) if zs_win else 1.0
                pose_res = float(np.mean(np.linalg.norm(c_model - c_colmap,
                                                        axis=1))) / max(scene_z, 1e-6)
                if pose_res > 0.05:
                    log.info("multi-view window %d/%d rejected: pose residual "
                             "%.1f%% of scene depth", wi + 1, n_win,
                             100 * pose_res)
                    continue

                depths, win_ratios = [], []
                for i, fr in enumerate(chunk):
                    d = np.asarray(pred.depth[i], np.float32)
                    h, w = fr["rgb"].shape[:2]
                    if d.shape != (h, w):
                        d = cv2.resize(d, (w, h), interpolation=cv2.INTER_LINEAR)
                    d[~np.isfinite(d)] = 0.0
                    depths.append(d)
                    for u, v, z in fr["uvz"]:
                        dv = d[int(round(v)), int(round(u))]
                        if dv > 0:
                            win_ratios.append(dv / z)
                # The umeyama scale inside align_to_input_ext_scale is only
                # as good as the model's own pose estimates -- measured up to
                # 2.2x off while the window stayed internally consistent to
                # ~2%. Snap the WHOLE window to the COLMAP sparse anchors
                # with one scalar: registration from the anchors,
                # cross-view consistency preserved.
                s_w = float(np.median(win_ratios)) if len(win_ratios) >= 8 else 1.0
                for i, (fr, d) in enumerate(zip(chunk, depths)):
                    # window units -> COLMAP units -> metres, and adopt the
                    # model's aligned pose so depth and pose stay the
                    # self-consistent pair they were predicted as.
                    fr["depth"] = d * (k / s_w)
                    ext = np.asarray(pred.extrinsics[i], np.float64)
                    T_cw = np.eye(4)
                    T_cw[:3, :] = ext[:3, :4]
                    # aligned poses are already in COLMAP units; only the
                    # depth needs the pred->COLMAP snap.
                    fr["T_wc"] = np.linalg.inv(T_cw)
                    fr.pop("_metric_depth", None)
                    n_mv += 1
            used_multiview = n_mv >= len(frames) // 2
        except Exception as exc:  # noqa: BLE001
            log.warning("multi-view densification failed (%s); "
                        "falling back to per-frame depth", exc)
        finally:
            if mv is not None:
                del mv
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass

    missing = [fr for fr in frames if fr["depth"] is None]
    if used_multiview and missing:
        if not est_alive:
            est = build_depth_estimator(cfg)
            est_alive = True
        progress("densifying", f"filling {len(missing)} frames per-frame")
        for fr in missing:
            depth = fr.pop("_metric_depth", None)
            fr["depth"] = depth if depth is not None \
                else est.predict(fr["rgb"], fr["intr"])

    if not used_multiview:
        if not est_alive:
            # The multi-view attempt released the estimator before failing.
            est = build_depth_estimator(cfg)
            est_alive = True
        ratios = []
        for n, fr in enumerate(frames):
            progress("densifying", f"depth {n + 1}/{len(frames)}")
            depth = fr.pop("_metric_depth", None)
            if depth is None:
                depth = est.predict(fr["rgb"], fr["intr"])
            fr["depth"] = depth
            for u, v, z in fr["uvz"]:
                d = depth[int(round(v)), int(round(u))]
                if d > 0:
                    ratios.append(d / z)
        if len(ratios) < 30:
            raise RuntimeError("too few depth anchors to recover metric scale")
        k = float(np.median(ratios))
    if est_alive:
        est.close()
    frames = [fr for fr in frames if fr["depth"] is not None]

    progress("densifying", "fusing TSDF volume")
    mapper = build_mapper(cfg)
    for fr in frames:
        T = fr["T_wc"].copy()
        T[:3, 3] *= k
        depth = fr["depth"]
        zs = [(depth[int(round(v)), int(round(u))], z * k)
              for u, v, z in fr["uvz"]
              if depth[int(round(v)), int(round(u))] > 0]
        # Per-frame residual scale against the sparse anchors. With
        # multi-view depth the maps are already cross-view consistent, so b
        # only corrects small per-window alignment wobble -- clip it tight
        # or it would reintroduce the very inconsistency we just removed.
        lo, hi = (0.5, 2.0)  # per-frame anchor snap needed in BOTH modes (measured)
        b = float(np.clip(np.median([zc / zd for zd, zc in zs]), lo, hi)) \
            if len(zs) >= 8 else 1.0
        mapper.integrate(depth * b, fr["rgb"], T, fr["intr"])

    progress("densifying", "extracting surface")
    files: dict[str, str] = {}
    min_w = cfg.fusion.min_extract_weight
    xyz, rgb = mapper.extract_point_cloud(min_weight=min_w)
    if len(xyz):
        write_ply(scan_dir / "dense_points.ply", xyz, rgb,
                  estimate_normals(xyz, viewpoint=None))
        files["dense_points"] = str(scan_dir / "dense_points.ply")
    verts, faces, colors = mapper.extract_mesh(min_weight=min_w)
    if len(verts):
        written = export_mesh(verts, faces, colors, scan_dir,
                              basename="dense_mesh",
                              formats=("ply", "glb", "stl"))
        files.update({f"mesh_{k}": str(v) for k, v in written.items()})
    # Release the volume AND CuPy's pool: freed-to-pool gigabytes are
    # invisible to PyTorch, so without this every offline scan starves the
    # next model load (live or offline) in the same process.
    mapper.close()
    return {"scale_m_per_unit": k, "frames_fused": len(frames),
            "depth_mode": "multiview" if used_multiview else "per-frame",
            "points": int(len(xyz)), "mesh_faces": int(len(faces)),
            "files": files}


#: SfM cost grows with the square of the image count; 200 frames keeps a scan
#: in the minutes range on this CPU. Beyond that, more frames add runtime much
#: faster than they add coverage.
MAX_SFM_FRAMES = 200


def _thin(paths: list, cap: int) -> list:
    if len(paths) <= cap:
        return paths
    idx = np.linspace(0, len(paths) - 1, cap).round().astype(int)
    return [paths[i] for i in sorted(set(idx))]


def scan_from_images(src_images: Path, out_dir: Path,
                     progress: Progress = _noop,
                     min_brightness: float = 25.0,
                     min_sharpness: float = 40.0) -> dict:
    """Photogrammetry over already-captured frames (a session's keyframes)."""
    imgdir = out_dir / "images"
    if imgdir.exists():
        shutil.rmtree(imgdir)
    imgdir.mkdir(parents=True)
    kept = dark = blurred = 0
    for f in _thin(sorted(src_images.iterdir()), MAX_SFM_FRAMES * 2):
        g = cv2.imread(str(f), 0)
        if g is None:
            continue
        if g.mean() < min_brightness:
            dark += 1
        elif cv2.Laplacian(g, cv2.CV_64F).var() < min_sharpness:
            blurred += 1
        else:
            shutil.copy(f, imgdir / f.name)
            kept += 1
        if (kept + dark + blurred) % 25 == 0:
            progress("selecting frames",
                     f"{kept} kept / {blurred} blurred / {dark} dark")
    fstats = {"kept": kept, "blurred": blurred, "dark": dark}
    if kept < 10:
        raise RuntimeError(
            f"only {kept} usable keyframes ({blurred} blurred, {dark} dark)")
    survivors = sorted(imgdir.iterdir())
    if len(survivors) > MAX_SFM_FRAMES:
        keep = set(_thin(survivors, MAX_SFM_FRAMES))
        for f in survivors:
            if f not in keep:
                f.unlink()
        fstats["thinned_to"] = MAX_SFM_FRAMES
        progress("selecting frames",
                 f"thinned {len(survivors)} -> {MAX_SFM_FRAMES} (SfM cost is quadratic)")
    sfm = run_sfm(out_dir, progress)
    result = {"frames": fstats, "sfm": sfm, "dir": str(out_dir)}
    if sfm["grade"] in ("GOOD", "PARTIAL"):
        result["dense"] = densify(out_dir, progress=progress)
    return result


def full_scan(device: str, seconds: int, out_dir: Path,
              progress: Progress = _noop) -> dict:
    """record -> extract -> SfM -> densify, one call. Returns a manifest."""
    clip = record_clip(device, seconds, out_dir, progress)
    fstats = extract_frames(clip, out_dir, progress=progress)
    if fstats["kept"] < 10:
        raise RuntimeError(
            f"only {fstats['kept']} usable frames "
            f"({fstats['blurred']} blurred, {fstats['dark']} dark) — "
            "add light or move slower")
    sfm = run_sfm(out_dir, progress)
    result = {"frames": fstats, "sfm": sfm, "dir": str(out_dir)}
    if sfm["grade"] in ("GOOD", "PARTIAL"):
        result["dense"] = densify(out_dir, progress=progress)
    return result

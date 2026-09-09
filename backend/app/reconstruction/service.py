"""3D reconstruction engine supervisor.

The engine is the vendored dronemap pipeline at <repo>/reconstruction - a
realtime monocular SLAM + metric-depth + CUDA TSDF stack with its own venv,
deliberately NOT importable from this backend (its dependency pins conflict
with ours, and a reconstruction crash must never take the platform down).

Cloud model: the camera is NEVER on this server - frames arrive through the
session pipeline (browser WebRTC, air-unit ingest, ...) exactly like every
other AI mode. The Reconstruction3D analyzer bridges those frames into the
engine over a local ZMQ socket; the engine's OWN ingest transports are not
used in platform mode. One sidecar process, loopback only, respawned when
the requested options change.

Sync on purpose: the vision worker pool constructs analyzers in a plain
executor thread, so engine start must be callable without an event loop.
Async proxying (routes.py) talks to the running sidecar with its own client.
"""
import logging
import os
import subprocess
import threading
import time
from pathlib import Path

import httpx

logger = logging.getLogger("verocore.reconstruction")

# backend/app/reconstruction/service.py -> hyrak_control/reconstruction
ENGINE_DIR = Path(__file__).resolve().parents[3] / "reconstruction"
VENV_PY = ENGINE_DIR / ".venv" / "bin" / "python"
DATA_ROOT = ENGINE_DIR / "data"
PORT = int(os.getenv("RECON_PORT", "8090"))
ZMQ_PORT = int(os.getenv("RECON_ZMQ_PORT", "8091"))
BASE = f"http://127.0.0.1:{PORT}"
START_TIMEOUT_S = 30.0

#: Quality presets = the engine's own config files.
PRESETS = ("indoor", "drone_1080p30", "brio_live", "default")

#: Options the panel may set BEFORE Start Analysis; the analyzer reads them
#: when it boots the engine. Kept server-side so the analyzer (which the
#: worker pool constructs with no arguments) can see what the user chose.
options: dict = {"preset": "indoor", "imu_fuse": False,
                 "mavlink_url": "udp:0.0.0.0:14550"}

_proc: subprocess.Popen | None = None
_spawned_with: tuple | None = None
_lock = threading.Lock()


def installed() -> bool:
    return VENV_PY.exists()


def _proc_alive() -> bool:
    return _proc is not None and _proc.poll() is None


def healthy() -> bool:
    try:
        return httpx.get(f"{BASE}/health", timeout=2.0).status_code == 200
    except Exception:
        return False


def engine_state() -> dict:
    # An engine we did not spawn (backend reloaded mid-scan) still counts
    # as running - the analyzer's session lives there.
    return {
        "installed": installed(),
        "running": _proc_alive() or healthy(),
        "port": PORT,
        "presets": list(PRESETS),
        "options": dict(options),
    }


def set_options(body: dict) -> dict:
    """Panel-chosen options for the NEXT scan (preset, IMU fuse)."""
    preset = body.get("preset")
    if preset is not None:
        if preset not in PRESETS:
            raise ValueError(f"unknown preset '{preset}'")
        options["preset"] = preset
    if "imu_fuse" in body:
        options["imu_fuse"] = bool(body["imu_fuse"])
    if body.get("mavlink_url"):
        options["mavlink_url"] = str(body["mavlink_url"])
    return dict(options)


def _zmq_sets(width: int, height: int) -> tuple[list[str], str]:
    """(--set list, config file) for a platform-fed ZMQ session.

    width/height are the TRUE dimensions of the frames the bridge delivers.
    They must reach the engine: its presets assume a 16:9 camera, and a 4:3
    webcam frame stretched onto a 16:9 tracking canvas gets anisotropic
    focal lengths - PnP then fails on the first real motion and the scan
    dies at LOST with one keyframe. Tracking resolution keeps the frame's
    own aspect, capped at 960 on the long side."""
    # 1280 tracking cap (was 960): with native-resolution frames now reaching
    # the bridge, KLT corners and landmark precision benefit from the extra
    # pixels, and this GPU's tracker budget covers it comfortably.
    scale = min(1.0, 1280 / max(width, height))
    tw = max(2, int(width * scale) // 2 * 2)
    th = max(2, int(height * scale) // 2 * 2)
    sets = [
        f"control.port={PORT}",
        f"control.data_root={DATA_ROOT}",
        "source.kind=zmq",
        f"source.uri=bind://tcp://127.0.0.1:{ZMQ_PORT}",
        # Ride out transient stalls: a WebRTC hiccup, the user pausing to line
        # up a shot, or a brief engine GC should NOT end a 10-minute scan. 45 s
        # is long enough to survive those yet still ends a genuinely dead feed
        # and exports what was captured. (The 75 s scan ended at 20 s here when
        # the engine stalled near the VRAM ceiling - the lower TSDF cap +
        # out-of-core tier make that stall far rarer, and this makes it
        # survivable when it does happen.)
        "source.stall_timeout_s=45",
        f"camera.width={width}", f"camera.height={height}",
        # Typical webcam/phone horizontal FOV. A calibrated camera profile
        # can replace this later; wrong-by-10-degrees tracks fine, wrong
        # ASPECT does not.
        "camera.hfov_deg=70",
        f"source.track_width={tw}", f"source.track_height={th}",
        # Save each keyframe's RGB+depth so a finished scan can be REFINED
        # (offline photogrammetry). Without this the reprocess has nothing
        # to work from ("no stored keyframes").
        "export.save_keyframes=true",
        # A LIVE scan must export in seconds. The indoor preset bakes a UV
        # texture atlas, and xatlas unwrapping a long scan's million-plus-face
        # mesh hangs for MINUTES - blocking the engine, which is what made the
        # iPad see "backend unreachable". Skip the bake and cap the mesh here;
        # the map keeps vertex colours (looks fine), and REFINE produces the
        # full high-resolution textured version offline when the user wants it.
        "export.textured=false",
        "export.mesh_simplify_target=250000",
        # Quality set from the engine session's measured analysis of the first
        # real user scan (corridor, judged "distorted"):
        # - da3: the flagship 334M metric model. The preset was SILENTLY
        #   running the 25M DA2 fallback - the single biggest quality miss.
        "depth.backend=da3",
        # - 756: 2.2x depth pixels for +42 ms/kf on this GPU (98 ms/1.6 GiB);
        #   the mapper is BA-bound at ~220 ms/kf, so depth is not the
        #   bottleneck until ~2x this.
        "depth.input_size=756",
        # - Density: the user's slow walk (0.15 m/s) never fired the
        #   translation trigger - every keyframe came from the 1 s timeout.
        #   Halve the timeout, lower the motion thresholds; 2 kf/s is well
        #   under the ~4.5 kf/s mapper ceiling.
        "keyframe.max_interval_s=0.5",
        "keyframe.trans_ratio=0.10",
        "keyframe.rot_deg=6",
        # Throttle: cap keyframe generation below the pipeline's real ceiling
        # so a fast pan cannot queue depth work that gets dropped anyway.
        # That ceiling moved: the mapper was ~2 kf/s (BoW describe() was
        # secretly 96 ms/kf) until engine commit 81313fc made it a float
        # sgemm - mapper is now ~14 kf/s and DEPTH INFERENCE (98 ms at 756)
        # is the binding constraint at ~10 kf/s. 0.15 s = 6.5/s: denser live
        # maps than the old 2.5/s cap for anyone moving briskly, with
        # headroom under the depth ceiling. A slow scanner is unaffected
        # (motion triggers rarely fire; the timeout floor still governs).
        "keyframe.min_interval_s=0.15",
        # Full-resolution keyframes for REFINE + texture baking (engine
        # commit 664b11e). The bridge delivers the source-res frame; without
        # this the engine keeps only the 1280 track image and REFINE silently
        # reprocesses at 720p - throwing away the 1080p the camera sent.
        "source.retain_full_res=true",
        # 1.5 GB TSDF working set. With the out-of-core host-RAM tier (engine
        # 664b11e) this cap no longer limits MAP SIZE - evicted blocks spill
        # to system RAM and page back on revisit - only the live working set.
        # Smaller cap = more headroom for DA3 + a co-resident Blender/browser
        # on the shared 8 GB card, which is what stalled the 75 s scan.
        "fusion.max_vram_gb=1.5",
    ]
    if options.get("preset") == "indoor":
        # Corridor/room-specific: monocular depth error grows ~quadratically
        # with range, and fusing the far end of a corridor smears geometry
        # (the user's p95 depth was 7.1 m). Fuse what is near; walk to the
        # rest. Outdoor/drone presets keep their long integration range.
        sets.append("fusion.max_integration_depth_m=6.0")
    if options.get("imu_fuse"):
        sets.append("scale.mode=mavlink")
        sets.append(f"scale.mavlink_url={options['mavlink_url']}")
    config = str(ENGINE_DIR / "configs" / f"{options['preset']}.yaml")
    return sets, config


def ensure_engine(sets: list[str], config: str) -> tuple[bool, str]:
    """Blocking: sidecar up with EXACTLY this configuration."""
    global _proc, _spawned_with
    if not installed():
        return False, ("Engine not installed - run reconstruction/install.sh "
                       "on the server once")
    key = (tuple(sets), config)
    with _lock:
        if _proc_alive() and _spawned_with == key and healthy():
            return True, "already running"
        _stop_proc_locked()
        # Whatever _stop_proc_locked believed, the port must be FREE before we
        # spawn or the new engine dies on bind ("address already in use").
        # A HUNG orphan (holds 8090, does not answer /health) is exactly the
        # case the health-gated cleanup missed and is why the iPad saw a blank
        # feed: the engine crashed on startup every time.
        _free_port_locked()

        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        log_f = open(DATA_ROOT / "engine.log", "ab")
        cmd = [str(VENV_PY), "-m", "dronemap.cli", "run",
               "--config", config, "--serve"]
        for s in sets:
            cmd += ["--set", s]
        logger.info(f"Starting reconstruction engine: preset={Path(config).stem} "
                    f"{[s for s in sets if not s.startswith('control.')]}")
        # Fence the engine's CPU appetite. Its bundle adjustment runs through
        # numpy/BLAS, which by default fans out across EVERY core - and as the
        # map grows that solve stretched to 648 ms/keyframe, monopolizing all
        # 24 cores in bursts. During those bursts the backend's software H.264
        # video decoder (same machine) got no CPU, fell behind, and the
        # incoming stream corrupted - the "H264Decoder Invalid data" freeze,
        # which looked like a network drop but was self-inflicted CPU
        # starvation. Cap BLAS threads so the video decoder always has cores.
        # nice(+10) keeps the engine below the real-time video path in the
        # scheduler without starving it.
        import os as _os
        # The engine's bundle adjustment is a small dense solve (~8x6 Schur),
        # so a handful of BLAS threads saturates it - fanning across 24 cores
        # was pure waste AND it starved the backend's video decoder, freezing
        # scans. 6 threads is plenty for the solve and leaves the rest of the
        # machine for the real-time video path. (Per the engine session, which
        # also fixed the deeper cause: an unbounded feature ratchet that grew
        # the mapper's work all session - commit ecd0884.)
        blas_cap = "6"
        env = {**_os.environ,
               "OMP_NUM_THREADS": blas_cap, "OPENBLAS_NUM_THREADS": blas_cap,
               "MKL_NUM_THREADS": blas_cap, "NUMEXPR_NUM_THREADS": blas_cap,
               "VECLIB_MAXIMUM_THREADS": blas_cap}
        _proc = subprocess.Popen(cmd, cwd=str(ENGINE_DIR),
                                 stdout=log_f, stderr=subprocess.STDOUT,
                                 env=env,
                                 preexec_fn=lambda: _os.nice(10))
        _spawned_with = key

        deadline = time.monotonic() + START_TIMEOUT_S
        while time.monotonic() < deadline:
            if _proc.poll() is not None:
                _spawned_with = None
                return False, ("Engine exited during startup - see "
                               f"{DATA_ROOT / 'engine.log'}")
            if healthy():
                return True, "started"
            time.sleep(0.5)
        return False, "Engine did not answer within 30 s - see engine.log"


def _free_port_locked() -> None:
    """Ensure no process is holding the engine's control port. Kills any
    orphaned copy of OUR vendored engine (unique binary path, so this is
    safe) whether or not it answers health checks, then waits for the port
    to actually release."""
    subprocess.run(["pkill", "-9", "-f", f"{VENV_PY} -m dronemap.cli"],
                   check=False)
    for _ in range(20):
        r = subprocess.run(
            ["bash", "-c",
             f"exec 3<>/dev/tcp/127.0.0.1/{PORT}"],
            capture_output=True)
        if r.returncode != 0:   # connection refused = port free
            return
        time.sleep(0.25)


def ensure_engine_idle() -> tuple[bool, str]:
    """Bring the engine up WITHOUT starting a capture session - for offline
    reprocessing (Refine) when no live scan is running. Uses the zmq source
    config so the process is identical to a live one; it just never gets
    frames and no /start is issued."""
    sets, config = _zmq_sets(1280, 720)
    return ensure_engine(sets, config)


def start_zmq_session(width: int, height: int) -> tuple[bool, str]:
    """Boot the engine for platform-fed frames and start a capture session.
    Blocking (seconds); called once the bridge knows the frame geometry.

    A new analyzer instance means a fresh scan, so force a fresh engine:
    resetting _spawned_with makes ensure_engine reap EVERY prior engine
    process (via _free_port_locked) before spawning. This is what stops
    engine processes accumulating - an OOM'd engine does not exit, it
    lingers holding ~1.5 GB of VRAM, and two or three of those stacked on
    an 8 GB card (shared with Blender/a browser) is why a new scan then
    dies with CUDA out-of-memory and 'keeps loading' forever."""
    global _spawned_with
    _spawned_with = None
    sets, config = _zmq_sets(width, height)
    ok, msg = ensure_engine(sets, config)
    if not ok:
        return False, msg
    try:
        r = httpx.post(f"{BASE}/start", timeout=10.0)
        if r.status_code == 409:
            # A session already lives (previous mode switch raced the stall
            # window). Stop it and retry once - the operator asked for a
            # FRESH scan.
            httpx.post(f"{BASE}/stop", params={"reason": "restart"}, timeout=10.0)
            time.sleep(2.0)
            r = httpx.post(f"{BASE}/start", timeout=10.0)
        if r.status_code >= 400:
            return False, f"Engine refused start: {r.text[:200]}"
        return True, "session starting"
    except httpx.HTTPError as e:
        return False, f"Engine unreachable: {e}"


def stop_session(reason: str = "platform") -> None:
    """End the capture session (auto-exports). Engine process stays warm."""
    try:
        httpx.post(f"{BASE}/stop", params={"reason": reason}, timeout=10.0)
    except httpx.HTTPError:
        pass


def poll_status() -> dict | None:
    try:
        r = httpx.get(f"{BASE}/status", timeout=1.5)
        return r.json() if r.status_code == 200 else None
    except Exception:
        return None


def _stop_proc_locked() -> None:
    global _proc, _spawned_with
    if _proc is None:
        # A backend reload (dev WatchFiles) replaces this process and loses
        # the child handle - the old sidecar keeps running and holds the
        # port, so the next spawn would die on bind. The engine is always
        # OUR vendored binary at a unique path, so a targeted pkill is safe.
        if healthy():
            logger.warning("Adopting orphaned reconstruction engine: killing it")
            subprocess.run(["pkill", "-f", f"{VENV_PY} -m dronemap.cli"],
                           check=False)
            time.sleep(1.0)
        return
    if _proc.poll() is None:
        # Polite stop first so a live session exports before the process dies.
        try:
            httpx.post(f"{BASE}/stop", params={"reason": "platform"}, timeout=3.0)
        except Exception:
            pass
        _proc.terminate()
        try:
            _proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None
    _spawned_with = None


def shutdown_engine() -> None:
    with _lock:
        _stop_proc_locked()
    logger.info("Reconstruction engine stopped")


def list_results_from_disk() -> list[dict]:
    """The engine's /results, computed here from the shared data root - so
    finished scans stay listed (and downloadable via the engine next boot)
    while the engine is idle. Mirrors the engine's response shape."""
    out = []
    for root, kind in ((DATA_ROOT / "sessions", "live"),
                       (DATA_ROOT / "photogrammetry", "offline")):
        if not root.exists():
            continue
        try:
            for d in root.iterdir():
                if not d.is_dir():
                    continue
                files = [
                    {"name": f.name, "size_mb": round(f.stat().st_size / 1e6, 1),
                     "path": str(f)}
                    for f in sorted(d.iterdir())
                    if f.is_file() and f.suffix in
                    (".ply", ".obj", ".glb", ".stl", ".mp4", ".txt", ".yaml")
                ]
                if files:
                    out.append({"name": d.name, "kind": kind,
                                "mtime": d.stat().st_mtime, "files": files})
        except OSError:
            continue
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


async def forward(method: str, path: str, *, params: dict | None = None,
                  timeout: float = 15.0) -> tuple[int, dict]:
    """JSON proxy to the sidecar. Returns (status_code, body_dict).

    Tries the port rather than gating on our child handle: after a backend
    reload the engine may be alive without us holding its Popen, and the
    analyzer's session must still be reachable through the proxy."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.request(method, f"{BASE}{path}", params=params)
            try:
                body = r.json()
            except Exception:
                body = {"detail": r.text[:300]}
            return r.status_code, body
    except httpx.ConnectError:
        return 503, {"detail": "Reconstruction engine is not running"}
    except httpx.HTTPError as e:
        return 502, {"detail": f"Engine unreachable: {e}"}

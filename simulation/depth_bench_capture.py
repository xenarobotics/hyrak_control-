#!/usr/bin/env python3
"""Capture a monocular-depth benchmark set from Gazebo: matched RGB frames and
TRUE depth from the OAK-D Lite on the x500_depth model.

Run through depth_bench.sh, which starts a PRIVATE gz server (own partition,
no PX4, no MAVLink) so this never touches a running sim or the backend.

The camera drone is placed with physics paused at positions around the
world's obstacles (3-15 m away, 2/5/10 m up, sometimes aimed off-centre),
the world is stepped just far enough for both sensors to render, and each
pair is saved as one .npz:
    rgb    uint8 (1080, 1920, 3)   IMX214, hfov 1.204 rad
    depth  float32 (480, 640)      StereoOV7251, hfov 1.274 rad, optical-axis
                                   depth in metres, inf/0 = no return
Both sensors share one pose on the model, so the benchmark can project the
true depth into the RGB image exactly (backend/tools/depth_bench_eval.py).
"""
from __future__ import annotations

import math
import os
import random
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

try:
    from gz.transport14 import Node
except Exception:
    from gz.transport13 import Node
from gz.msgs11.image_pb2 import Image

WORLD = os.environ.get("WORLD", "hyrak_obstacles")
MODEL = "x500_depth_1"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "depth_bench_frames")
N_MAX = int(os.environ.get("N_FRAMES", "160"))
WORLD_SDF = Path(os.environ["PX4_GZ_WORLDS"]) / f"{WORLD}.sdf"
RGB_TOPIC = f"/world/{WORLD}/model/{MODEL}/link/camera_link/sensor/IMX214/image"
DEPTH_TOPICS = ["/depth_camera",
                f"/world/{WORLD}/model/{MODEL}/link/camera_link/sensor/StereoOV7251/depth_image"]

_lock = threading.Lock()
_latest: dict[str, tuple[int, np.ndarray]] = {}
_count = {"rgb": 0, "depth": 0}


def _on_rgb(msg: Image) -> None:
    a = np.frombuffer(msg.data, np.uint8).reshape(msg.height, msg.width, -1)[:, :, :3].copy()
    with _lock:
        _count["rgb"] += 1
        _latest["rgb"] = (_count["rgb"], a)


def _on_depth(msg: Image) -> None:
    a = np.frombuffer(msg.data, np.float32).reshape(msg.height, msg.width).copy()
    with _lock:
        _count["depth"] += 1
        _latest["depth"] = (_count["depth"], a)


def gz_service(service: str, reqtype: str, req: str, timeout_ms: int = 5000) -> bool:
    r = subprocess.run(["gz", "service", "-s", service, "--reqtype", reqtype,
                        "--reptype", "gz.msgs.Boolean", "--timeout", str(timeout_ms), "--req", req],
                       capture_output=True, text=True)
    return "data: true" in r.stdout


def obstacles() -> list[tuple[float, float, float]]:
    """(x, y, top) of the world's obs_* models, from the world file."""
    txt = WORLD_SDF.read_text()
    out = []
    for m in re.finditer(r'<model name="obs_\d+">.*?<pose>([^<]+)</pose>.*?</model>', txt, re.S):
        x, y, z = (float(v) for v in m.group(1).split()[:3])
        out.append((x, y, 2.0 * z))          # box/cylinder centred at half height
    return out


def poses(obs, rng: random.Random):
    """Camera poses (x, y, z, yaw) looking at obstacles from 3-15 m."""
    for ox, oy, top in obs:
        for dist in (3.0, 6.0, 10.0, 15.0):
            for alt in (2.0, 5.0, 10.0):
                brg = rng.uniform(0, 2 * math.pi)
                x, y = ox + dist * math.cos(brg), oy + dist * math.sin(brg)
                yaw = math.atan2(oy - y, ox - x) + math.radians(rng.choice((0, 0, 15, -15, 25, -25)))
                yield x, y, alt, yaw


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    node = Node()
    node.subscribe(Image, RGB_TOPIC, _on_rgb)
    for t in DEPTH_TOPICS:
        node.subscribe(Image, t, _on_depth)

    ok = gz_service(f"/world/{WORLD}/create", "gz.msgs.EntityFactory",
                    f'sdf_filename: "model://x500_depth", name: "{MODEL}", '
                    f'pose {{ position {{ z: 5 }} }}', 10000)
    if not ok:
        print("could not spawn x500_depth - is the bench server up?", file=sys.stderr)
        return 1
    rng = random.Random(7)
    all_poses = list(poses(obstacles(), rng))
    rng.shuffle(all_poses)
    saved = 0
    for x, y, z, yaw in all_poses:
        if saved >= N_MAX:
            break
        qz, qw = math.sin(yaw / 2), math.cos(yaw / 2)
        gz_service(f"/world/{WORLD}/set_pose", "gz.msgs.Pose",
                   f'name: "{MODEL}", position {{ x: {x:.3f} y: {y:.3f} z: {z:.3f} }}, '
                   f'orientation {{ z: {qz:.6f} w: {qw:.6f} }}')
        with _lock:
            c0 = dict(_count)
        # 120 ms of sim time: both sensors render at least once; the model
        # drops ~7 cm under gravity meanwhile, identical for both sensors.
        gz_service(f"/world/{WORLD}/control", "gz.msgs.WorldControl", "pause: true, multi_step: 120")
        t_end = time.time() + 4.0
        while time.time() < t_end:
            with _lock:
                if _count["rgb"] > c0["rgb"] and _count["depth"] > c0["depth"]:
                    break
            time.sleep(0.02)
        with _lock:
            if "rgb" not in _latest or "depth" not in _latest or \
                    _count["rgb"] <= c0["rgb"] or _count["depth"] <= c0["depth"]:
                continue
            rgb, depth = _latest["rgb"][1], _latest["depth"][1]
        valid = np.isfinite(depth) & (depth > 0.3) & (depth < 19.0)
        if valid.mean() < 0.05:
            continue                         # nothing in range: sky only
        np.savez_compressed(OUT / f"f{saved:04d}.npz", rgb=rgb, depth=depth,
                            pose=np.array([x, y, z, yaw], np.float32))
        saved += 1
        print(f"saved {saved}/{N_MAX}  valid {valid.mean():.0%}", flush=True)
    print(f"done: {saved} pairs in {OUT}")
    return 0 if saved else 1


if __name__ == "__main__":
    sys.exit(main())

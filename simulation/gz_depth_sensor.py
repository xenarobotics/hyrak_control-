"""Gazebo depth camera -> HYRAK avoidance (step A: a TRUE range sensor in SITL).

Subscribes to the x500_depth model's OAK-D Lite depth camera (640x480
R_FLOAT32, 73 deg HFOV, 0.2-19.1 m), min-pools each frame to a coarse grid
and POSTs it to the backend's /api/avoidance/<drone>/depth_scan, stamped
with the wall-clock time the frame arrived. The backend places it with the
aircraft's pose at that moment, rejects the ground by height and integrates
it into the occupancy grid as a range sensor. With this running, the camera
model (mono) is ignored for the map, so the loop, geometry and actuation are
tested against correct ranges.

Like gz_cam_bridge.py it NEVER blocks the gz callback (lockstep sim): the
callback keeps only the newest frame; a worker thread pools and posts at up
to RATE_HZ and drops whatever it cannot keep up with.

Run (hyrak_sim.sh does this when MODEL=gz_x500_depth):
    GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_demo python3 gz_depth_sensor.py [drone_id|auto]
Env: HYRAK_API (default http://127.0.0.1:8001), HYRAK_TOKEN (default: the
repo .env SECRET_TOKEN), DEPTH_TOPICS (comma list), RATE_HZ (default 10).
"""
import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

try:
    from gz.transport14 import Node
except Exception:
    from gz.transport13 import Node
from gz.msgs11.image_pb2 import Image

DRONE = sys.argv[1] if len(sys.argv) > 1 else "auto"
API = os.environ.get("HYRAK_API", "http://127.0.0.1:8001").rstrip("/")
RATE_HZ = float(os.environ.get("RATE_HZ", "10"))
ROWS, COLS = 48, 64
HFOV_DEG = 73.0          # OakD-Lite StereoOV7251: horizontal_fov 1.274 rad
MAX_RANGE_M = 19.1       # its far clip
WORLD = os.environ.get("WORLD", "hyrak_obstacles")
TOPICS = [t for t in os.environ.get("DEPTH_TOPICS", "").split(",") if t] or [
    "/depth_camera",
    f"/world/{WORLD}/model/x500_depth_1/link/camera_link/sensor/StereoOV7251/depth_image",
    # the indoor vehicle carries the same OAK-D Lite (simulation/models/x500_indoor)
    f"/world/{WORLD}/model/x500_indoor_1/link/camera_link/sensor/StereoOV7251/depth_image",
]


def _token() -> str:
    tok = os.environ.get("HYRAK_TOKEN")
    if tok:
        return tok
    env = Path(__file__).resolve().parents[1] / ".env"
    try:
        for line in env.read_text().splitlines():
            if line.startswith("SECRET_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    # The backend's own default (app/config.py secret_token) when .env sets none.
    return "dev_token_change_in_production"


TOKEN = _token()
_latest = [None]          # (arrival wall time, width, height, bytes, topic)
_lock = threading.Lock()
_stats = {"recv": 0, "posted": 0, "dropped": 0, "errors": 0, "hits": 0}
_topic_seen: set = set()


def _cb_for(topic):
    def cb(msg: Image):
        # gz transport thread - MUST return at once.
        with _lock:
            if _latest[0] is not None:
                _stats["dropped"] += 1
            _latest[0] = (time.time(), msg.width, msg.height, bytes(msg.data), topic)
        _stats["recv"] += 1
    return cb


def _pool(depth: np.ndarray) -> np.ndarray:
    h, w = depth.shape
    rh, cw = h // ROWS, w // COLS
    d = depth[:rh * ROWS, :cw * COLS]
    d = np.where(np.isfinite(d) & (d > 0), d, np.where(np.isposinf(d), np.inf, np.nan))
    blocks = d.reshape(ROWS, rh, COLS, cw).transpose(0, 2, 1, 3).reshape(ROWS, COLS, rh * cw)
    with np.errstate(all="ignore"):
        out = np.nanmin(blocks, axis=2)
    # JSON: no data -> -1, nothing within range -> MAX_RANGE_M (the backend's convention)
    out = np.where(np.isnan(out), -1.0, np.where(np.isinf(out) | (out >= MAX_RANGE_M), MAX_RANGE_M, out))
    return out


def worker():
    period = 1.0 / RATE_HZ
    url = f"{API}/api/avoidance/{DRONE}/depth_scan"
    while True:
        t0 = time.time()
        with _lock:
            item, _latest[0] = _latest[0], None
        if item is not None:
            wall, w, h, data, topic = item
            if topic not in _topic_seen:
                _topic_seen.add(topic)
                print(f"depth frames arriving on {topic} ({w}x{h})", flush=True)
            try:
                depth = np.frombuffer(data, dtype=np.float32).reshape(h, w)
                pooled = _pool(depth)
                vfov = float(np.degrees(2 * np.arctan(np.tan(np.radians(HFOV_DEG) / 2) * h / w)))
                body = json.dumps({
                    "captured_wall": wall, "hfov_deg": HFOV_DEG, "vfov_deg": vfov,
                    "rows": ROWS, "cols": COLS, "max_range_m": MAX_RANGE_M,
                    "depth": [round(float(x), 2) for x in pooled.ravel()],
                    "source": "depth"}).encode()
                req = urllib.request.Request(url, data=body, method="POST", headers={
                    "content-type": "application/json", "X-Auth-Token": TOKEN})
                with urllib.request.urlopen(req, timeout=1.0) as r:
                    res = json.loads(r.read() or b"{}")
                _stats["posted"] += 1
                _stats["hits"] += int(res.get("hits", 0) or 0)
                if not res.get("ok") and _stats["posted"] % 50 == 1:
                    print(f"backend did not use the scan: {res.get('reason', res)}", flush=True)
            except Exception as e:
                _stats["errors"] += 1
                if _stats["errors"] % 50 == 1:
                    print(f"depth post failed: {e}", flush=True)
        # A status line every 5 s: `hyrak_sim.sh status` shows the last one,
        # so "up" is never mistaken for "delivering" (recv=0 = wrong topic).
        if time.time() - _stats.get("printed", 0.0) > 5.0:
            _stats["printed"] = time.time()
            print(f"depth sensor: posted={_stats['posted']} hits={_stats['hits']} errors={_stats['errors']}"
                  + ("" if _topic_seen else "  NO FRAMES YET - is the sim's depth camera publishing?"), flush=True)
        dt = period - (time.time() - t0)
        if dt > 0:
            time.sleep(dt)


node = Node()
for t in TOPICS:
    ok = node.subscribe(Image, t, _cb_for(t))
    print(f"subscribe {t} ok={ok}", flush=True)
threading.Thread(target=worker, daemon=True).start()
print(f"depth sensor -> {API} drone={DRONE} {ROWS}x{COLS} @<= {RATE_HZ:g} Hz", flush=True)
while True:
    time.sleep(5)
    print(f"depth: recv={_stats['recv']} posted={_stats['posted']} dropped={_stats['dropped']} "
          f"errors={_stats['errors']} hit-bins={_stats['hits']}", flush=True)

"""Bridge a Gazebo camera topic into the HyrakAirUnit virtual webcam - SAFELY.

Subscribes to the SITL drone's gz camera image topic and feeds frames to ffmpeg,
which writes them to the v4l2loopback device /dev/video10 ("HyrakAirUnit"). The
HYRAK app / browser then selects that camera as the drone's video feed.

CRITICAL: Gazebo SITL runs in lockstep, so a subscriber that blocks the camera
topic freezes the whole sim. Therefore the gz callback NEVER blocks - it only
drops the latest frame into a one-slot buffer and returns instantly. A separate
writer thread pushes the newest frame to ffmpeg and simply drops frames whenever
ffmpeg is behind. The sim can never stall on us.

Two outputs, chosen by the 4th argument:
  /dev/videoN         v4l2loopback virtual webcam (browser picks it as a camera)
  rtp://host:port     H.265 RTP - the SAME wire format the real air unit's
                      wfb_rx delivers, so the HYRAK backend reads it directly
                      with its "Air unit (UDP, server reads)" video source
                      (udp_video_source.py, default port 5600). No kernel
                      module, no browser capture, and the vision pipeline
                      (depth -> obstacle observations) runs on it server-side.

Run with GZ_PARTITION matching the sim (hyrak_demo):
    GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_demo python3 gz_cam_bridge.py \
        [topic] [WxH] [fps] [/dev/videoN | rtp://127.0.0.1:5600]
"""
import subprocess
import sys
import threading
import time

try:
    from gz.transport14 import Node
except Exception:
    from gz.transport13 import Node
from gz.msgs11.image_pb2 import Image

TOPIC = sys.argv[1] if len(sys.argv) > 1 else (
    "/world/hyrak_obstacles/model/x500_mono_cam_1/link/camera_link/sensor/camera/image")
W, H = (int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else "640x480").split("x"))
FPS = int(sys.argv[3]) if len(sys.argv) > 3 else 10
DEV = sys.argv[4] if len(sys.argv) > 4 else "/dev/video10"

_IN = ["ffmpeg", "-hide_banner", "-loglevel", "error",
       "-f", "rawvideo", "-pixel_format", "rgb24",
       "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "pipe:0"]
if DEV.startswith("rtp://"):
    # Keyframe every second and VPS/SPS/PPS repeated on each of them: the
    # backend attaches mid-stream (whenever the operator connects), and an
    # SDP-only receiver can decode from the next IDR only if the headers
    # ride in-band. zerolatency = no B-frames, no lookahead, one frame in
    # flight. Payload type 96 matches udp_video_source's SDP.
    _OUT = ["-an", "-c:v", "libx265", "-preset", "ultrafast", "-tune", "zerolatency",
            "-pix_fmt", "yuv420p", "-g", str(FPS), "-b:v", "1500k",
            "-x265-params", f"keyint={FPS}:min-keyint={FPS}:no-open-gop=1:repeat-headers=1:log-level=error",
            "-f", "rtp", "-payload_type", "96", DEV + "?pkt_size=1200"]
else:
    _OUT = ["-f", "v4l2", "-pix_fmt", "yuv420p", DEV]
ff = subprocess.Popen(_IN + _OUT, stdin=subprocess.PIPE)

_latest = [None]           # one-slot buffer: only the newest frame survives
_lock = threading.Lock()
_stop = [False]
_stats = {"recv": 0, "sent": 0, "dropped": 0}


def cb(msg: Image):
    # Runs on gz's transport thread - MUST return instantly, never block.
    with _lock:
        if _latest[0] is not None:
            _stats["dropped"] += 1
        _latest[0] = bytes(msg.data)
    _stats["recv"] += 1


def writer():
    period = 1.0 / FPS
    while not _stop[0] and ff.poll() is None:
        t0 = time.time()
        with _lock:
            frame = _latest[0]
            _latest[0] = None
        if frame is not None:
            try:
                ff.stdin.write(frame)      # blocking here is fine - own thread
                _stats["sent"] += 1
            except (BrokenPipeError, ValueError):
                break
        dt = period - (time.time() - t0)
        if dt > 0:
            time.sleep(dt)


node = Node()
ok = node.subscribe(Image, TOPIC, cb)
print(f"subscribe {TOPIC} ok={ok} -> {DEV} ({W}x{H}@{FPS}, frame-dropping)", flush=True)
if not ok:
    sys.exit(1)
threading.Thread(target=writer, daemon=True).start()
try:
    while ff.poll() is None:
        time.sleep(5)
        print(f"cam bridge: recv={_stats['recv']} sent={_stats['sent']} "
              f"dropped={_stats['dropped']}", flush=True)
finally:
    _stop[0] = True

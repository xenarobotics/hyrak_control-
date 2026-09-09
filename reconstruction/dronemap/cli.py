"""Command line entry point."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import Config, parse_set_overrides


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-28s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    for noisy in ("urllib3", "matplotlib", "PIL", "huggingface_hub", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dronemap",
        description="Real-time streaming 3D reconstruction for drone/robot video.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  # replay a recorded file through the full pipeline
  dronemap run --source file --uri flight.mp4

  # live RTSP from a drone, 1080p30, with NVDEC
  dronemap run -c configs/drone_1080p30.yaml --uri rtsp://192.168.1.10:8554/live

  # tune on the fly
  dronemap run --uri clip.mp4 --set fusion.voxel_size_m=0.02 --set keyframe.rot_deg=5

  # self-test against a synthetic scene with known ground truth
  dronemap selftest --frames 120
""",
    )
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run a reconstruction session")
    run.add_argument("-c", "--config", help="YAML config file")
    run.add_argument("--source", choices=["rtsp", "udp", "http", "file", "folder",
                                          "zmq", "webrtc", "v4l2"],
                     help="transport")
    run.add_argument("--uri", help="stream URI / file path / folder")
    run.add_argument("--session", help="session name (used in the output directory)")
    run.add_argument("--out", help="output directory")
    run.add_argument("--voxel", type=float, help="TSDF voxel size in metres")
    run.add_argument("--vram", type=float, help="TSDF VRAM budget in GB")
    run.add_argument("--no-viz", action="store_true", help="disable live visualisation")
    run.add_argument("--no-control", action="store_true", help="disable the HTTP server")
    run.add_argument("--mavlink", help="MAVLink URL for metric scale, e.g. udp:0.0.0.0:14550")
    run.add_argument("--scale", type=float, help="fixed metric scale factor")
    run.add_argument("--textured", action="store_true", help="bake a UV texture atlas")
    run.add_argument("--splat", action="store_true", help="also export 3DGS seeds")
    run.add_argument("--save-keyframes", action="store_true",
                     help="save RGB+depth keyframes (input for offline 3DGS training)")
    run.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                     help="override any config field, e.g. --set tracking.max_features=800")
    run.add_argument("--log-level", default="INFO")
    run.add_argument("--serve", action="store_true",
                     help="stay alive between sessions; start/stop from the "
                          "web panel at the control server's / page")

    st = sub.add_parser("selftest", help="end-to-end run against a synthetic scene")
    st.add_argument("--frames", type=int, default=120)
    st.add_argument("--trajectory", choices=["orbit", "forward"], default="orbit")
    st.add_argument("--width", type=int, default=640)
    st.add_argument("--height", type=int, default=360)
    st.add_argument("--gt-depth", action="store_true",
                    help="use ground-truth depth instead of the network, to isolate tracking")
    st.add_argument("--out", default="data/selftest")
    st.add_argument("--no-viz", action="store_true")
    st.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                    help="override any config field, e.g. --set fusion.voxel_size_m=0.02")
    st.add_argument("--log-level", default="INFO")

    cfgcmd = sub.add_parser("config", help="print the resolved configuration")
    cfgcmd.add_argument("-c", "--config")
    cfgcmd.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")

    ck = sub.add_parser("check", help="verify a video source is usable for SLAM")
    ck.add_argument("--uri", required=True, help="stream URI / device / folder")
    ck.add_argument("--source", choices=["rtsp", "udp", "http", "file", "folder",
                                         "zmq", "webrtc", "v4l2"])
    ck.add_argument("--frames", type=int, default=40)
    ck.add_argument("--width", type=int, help="capture width hint")
    ck.add_argument("--height", type=int, help="capture height hint")
    ck.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    ck.add_argument("--log-level", default="WARNING")

    info = sub.add_parser("info", help="report GPU, codecs and backend availability")
    return p


def _apply_cli(cfg: Config, args) -> Config:
    if getattr(args, "source", None):
        cfg.source.kind = args.source
    if getattr(args, "uri", None):
        cfg.source.uri = args.uri
        # A bare URI is unambiguous about its transport; infer it so the common
        # case does not need --source as well.
        if not getattr(args, "source", None):
            uri = args.uri
            if uri.startswith("rtsp://"):
                cfg.source.kind = "rtsp"
            elif uri.startswith(("udp://", "srt://")):
                cfg.source.kind = "udp"
            elif uri.startswith(("tcp://", "ipc://", "bind://")):
                cfg.source.kind = "zmq"
            elif uri.startswith(("http://", "https://")):
                # A bare HTTP URL is far more often an MJPEG/HLS stream (phone
                # camera apps, IP cameras) than a WebRTC signalling endpoint.
                # WebRTC needs an explicit --source webrtc.
                cfg.source.kind = "http"
            elif uri.startswith("/dev/video"):
                cfg.source.kind = "v4l2"
            elif Path(uri).is_dir():
                cfg.source.kind = "folder"
            elif Path(uri).exists():
                cfg.source.kind = "file"
    if getattr(args, "session", None):
        cfg.session_name = args.session
    if getattr(args, "out", None):
        cfg.export.output_dir = args.out
    if getattr(args, "voxel", None):
        cfg.fusion.voxel_size_m = args.voxel
    if getattr(args, "vram", None):
        cfg.fusion.max_vram_gb = args.vram
    if getattr(args, "no_viz", False):
        cfg.viz.backend = "none"
    if getattr(args, "no_control", False):
        cfg.control.enabled = False
    if getattr(args, "mavlink", None):
        cfg.scale.mode = "mavlink"
        cfg.scale.mavlink_url = args.mavlink
    if getattr(args, "scale", None):
        cfg.scale.mode = "fixed"
        cfg.scale.fixed_scale = args.scale
    if getattr(args, "textured", False):
        cfg.export.textured = True
    if getattr(args, "splat", False):
        cfg.export.export_splat = True
    if getattr(args, "save_keyframes", False):
        cfg.export.save_keyframes = True
    if getattr(args, "log_level", None):
        cfg.log_level = args.log_level
    return cfg


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "info":
        _setup_logging("INFO")
        return _cmd_info()

    overrides = parse_set_overrides(getattr(args, "set", []) or [])
    cfg = Config.load(getattr(args, "config", None), overrides)
    cfg = _apply_cli(cfg, args)
    _setup_logging(cfg.log_level)

    if args.command == "config":
        import yaml

        print(yaml.safe_dump(cfg.model_dump(mode="json"), sort_keys=False))
        return 0

    if args.command == "check":
        from .check import check_source, print_report

        if getattr(args, "width", None):
            cfg.camera.width = cfg.source.track_width = args.width
        if getattr(args, "height", None):
            cfg.camera.height = cfg.source.track_height = args.height
        cfg.source.retain_full_res = False
        rep = check_source(cfg, n_frames=args.frames)
        print_report(rep, cfg.source.uri)
        return 0 if rep.ok else 1

    if args.command == "selftest":
        from .selftest import run_selftest

        return run_selftest(cfg, args)

    if args.command == "run":
        if not cfg.source.uri:
            print("error: --uri is required (or set source.uri in the config)",
                  file=sys.stderr)
            return 2
        from .app import DroneMapApp

        if args.serve:
            from .control.supervisor import Supervisor

            Supervisor(cfg).serve_forever()
            return 0

        app = DroneMapApp(cfg)
        manifest = app.run()
        if app.lifecycle.info.error:
            print(f"session ended with an error: {app.lifecycle.info.error}",
                  file=sys.stderr)
            return 1
        if manifest.get("dir"):
            print(f"\nexported to: {manifest['dir']}")
        return 0
    return 2


def _cmd_info() -> int:
    import shutil
    import subprocess

    print("== dronemap environment ==\n")
    try:
        import torch

        print(f"torch          {torch.__version__}  cuda={torch.cuda.is_available()}")
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            print(f"gpu            {p.name}  {p.total_memory / 2**30:.1f} GiB  "
                  f"sm_{p.major}{p.minor}")
    except ImportError:
        print("torch          NOT INSTALLED")

    try:
        import cupy

        cupy.RawKernel(r'extern "C" __global__ void t(){}', "t")
        print(f"cupy           {cupy.__version__}  (NVRTC ok -> CUDA TSDF available)")
    except Exception as exc:  # noqa: BLE001
        print(f"cupy           unavailable ({type(exc).__name__}) -> Open3D fallback")

    for mod in ("cv2", "open3d", "rerun", "trimesh", "transformers", "fastapi"):
        try:
            m = __import__(mod)
            print(f"{mod:<15}{getattr(m, '__version__', 'ok')}")
        except ImportError:
            print(f"{mod:<15}NOT INSTALLED")

    if shutil.which("ffmpeg"):
        out = subprocess.run(["ffmpeg", "-hide_banner", "-decoders"],
                             capture_output=True, text=True).stdout
        hw = [d for d in ("h264_cuvid", "hevc_cuvid", "av1_cuvid") if d in out]
        print(f"\nffmpeg         present; NVDEC decoders: {', '.join(hw) or 'none'}")
    else:
        print("\nffmpeg         NOT FOUND (required for rtsp/udp/file ingest)")

    from .profiling.gpu_monitor import GpuMonitor

    mon = GpuMonitor()
    s = mon.sample()
    if s:
        print(f"\nVRAM           {s.used_mb:.0f} / {s.total_mb:.0f} MB used "
              f"({s.free_mb:.0f} MB free)")
        print(f"power          {s.power_w:.0f} / {s.power_limit_w:.0f} W")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

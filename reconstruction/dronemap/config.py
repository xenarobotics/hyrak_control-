"""Configuration schema.

One pydantic model per subsystem, composed into :class:`Config`. Values resolve
in the order  defaults < YAML file < ``--set a.b=c`` overrides < explicit CLI
flags, so a config file can be committed per platform and tweaked ad hoc from
the command line without editing it.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Literal, Optional

import yaml
from pydantic import BaseModel, Field, model_validator


class SourceConfig(BaseModel):
    """Where frames come from. One interface, several transports."""

    kind: Literal["rtsp", "udp", "http", "file", "folder", "zmq", "webrtc",
                  "v4l2"] = "file"
    uri: str = ""
    #: h264 | hevc | av1 -- selects the NVDEC decoder. "auto" probes the stream.
    codec: Literal["auto", "h264", "hevc", "av1"] = "auto"
    hwaccel: bool = True  # use NVDEC (h264_cuvid etc.) when available
    #: Resolution handed to tracking. Full-res frames are kept separately for
    #: texture baking, so lowering this costs accuracy, not texture quality.
    track_width: int = 960
    track_height: int = 540
    retain_full_res: bool = True
    #: Cap on ingest rate. 0 = as fast as the source delivers.
    target_fps: float = 30.0
    #: Replay sources only: honour original frame timing instead of running flat out.
    realtime_replay: bool = True
    loop: bool = False
    #: Seconds of silence from the transport before the session is declared ended.
    stall_timeout_s: float = 5.0
    #: Network sources (rtsp/udp/http) only: when the link drops mid-session,
    #: keep relaunching the decoder with backoff for up to this long before
    #: ending the session. An RF video link drops routinely; ending the scan
    #: (and auto-exporting a fragment) on every dropout would be wrong in
    #: exactly the flagship scenario. The tracker rides the gap as LOST and
    #: relocalization re-anchors when frames return. 0 disables.
    reconnect_window_s: float = 60.0
    #: ZMQ specific.
    zmq_topic: str = ""
    #: Fail the run rather than silently dropping frames (useful in CI).
    strict_no_drop: bool = False


class CameraConfig(BaseModel):
    """Intrinsics for the *source* resolution; rescaled per consumer."""

    width: int = 1920
    height: int = 1080
    fx: Optional[float] = None
    fy: Optional[float] = None
    cx: Optional[float] = None
    cy: Optional[float] = None
    #: Used only when fx/fy are absent. Typical drone cameras are 70-90 deg.
    hfov_deg: float = 82.0
    dist: list[float] = Field(default_factory=lambda: [0.0] * 5)
    calibration_file: Optional[str] = None  # OpenCV YAML/JSON from calibrate.py


class TrackingConfig(BaseModel):
    """Visual odometry front-end."""

    max_features: int = 1200
    #: Shi-Tomasi corner quality and spacing for redetection.
    quality_level: float = 0.01
    min_distance: float = 12.0
    #: Grid-based redetection keeps features spread out instead of clumping on
    #: one high-contrast structure, which is what makes PnP well-conditioned.
    grid_cols: int = 8
    grid_rows: int = 5
    redetect_ratio: float = 0.6  # redetect when tracks fall below this fraction

    klt_window: int = 21
    klt_levels: int = 3
    klt_fb_threshold: float = 1.0  # forward-backward consistency, pixels

    pnp_reproj_threshold: float = 3.0  # RANSAC inlier threshold, pixels
    pnp_min_inliers: int = 25
    pnp_iterations: int = 200

    orb_features: int = 1500  # descriptors extracted at keyframes only
    #: Motion-only bundle adjustment after PnP.
    motion_ba_iterations: int = 6
    huber_delta_px: float = 3.0

    #: Sliding-window bundle adjustment.
    local_ba_window: int = 8
    local_ba_max_points: int = 600
    local_ba_iterations: int = 12
    local_ba_enabled: bool = True
    #: Reject a bundle-adjustment step that moves any keyframe further than this
    #: (as a fraction of median scene depth). A window solve should refine, not
    #: relocate; a jump this large means the problem was ill-conditioned.
    local_ba_max_shift_ratio: float = 0.25
    #: A keyframe needs at least this many landmark observations inside the
    #: window to be optimized. With fewer, its pose is underconstrained and the
    #: solver is free to move it anywhere that reduces a handful of residuals.
    local_ba_min_obs_per_kf: int = 25

    #: Consecutive tracking failures tolerated before entering relocalization.
    max_lost_frames: int = 8


class KeyframeConfig(BaseModel):
    """Dynamic keyframe gate.

    A frame becomes a keyframe when translation parallax, rotation, or track
    attrition crosses a threshold -- this is what stops a hovering drone from
    flooding the mapper with redundant, zero-parallax views.
    """

    #: Translation threshold as a fraction of the current median scene depth.
    #: Scale-relative rather than absolute so it behaves the same at 2 m and 60 m.
    trans_ratio: float = 0.15
    #: Absolute floor/ceiling on that threshold, metres.
    min_trans_m: float = 0.05
    max_trans_m: float = 5.0
    #: Rotation threshold, degrees.
    rot_deg: float = 8.0
    #: Promote when the fraction of surviving tracks drops below this.
    track_ratio: float = 0.65
    #: Always promote after this long, so a static camera still refreshes.
    max_interval_s: float = 1.0
    #: Never promote faster than this, regardless of motion.
    min_interval_s: float = 0.05
    #: Hard cap on keyframes retained in RAM before spilling to disk.
    max_in_memory: int = 400


class DepthConfig(BaseModel):
    """Monocular metric depth."""

    backend: Literal["depth_anything", "da3", "trt", "none"] = "depth_anything"
    model: str = "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf"
    #: Network input side. 518 is DAv2's native patch grid; smaller is faster.
    input_size: int = 518
    fp16: bool = True
    #: Depth outside this range is discarded before fusion.
    min_depth_m: float = 0.3
    max_depth_m: float = 60.0
    #: Align predicted depth to sparse VO landmarks (scale + optional shift).
    #: This is what keeps network depth consistent with tracked geometry.
    align_to_map: bool = True
    #: Fit an offset as well as a scale. Correct for relative/inverse-depth
    #: checkpoints, which have an arbitrary offset; wrong for metric ones, where
    #: the extra degree of freedom just absorbs error. Auto-enabled for
    #: non-metric backends.
    align_shift: bool = False
    align_min_points: int = 12
    #: Only anchor to landmarks seen by at least this many keyframes. Anything
    #: less has not been triangulated -- it is still just back-projected depth,
    #: so aligning to it aligns depth against itself and lets scale drift
    #: compound keyframe over keyframe.
    align_min_observations: int = 2
    #: Exponential smoothing on the running alignment (0 = follow each fit
    #: exactly, 0.9 = heavily damped).
    align_smoothing: float = 0.7
    #: Largest fractional change in scale allowed per keyframe.
    align_max_step: float = 0.05
    #: Stop updating the alignment after this many keyframes (0 = never freeze).
    #: A metric checkpoint's scale is a property of the network, so aligning it
    #: is a one-time calibration. Continuing to refit every keyframe reopens the
    #: feedback path -- optimization nudges the landmarks, the next fit follows
    #: them, the depth it produces reinforces the nudge -- which shows up as
    #: slow, systematic scale drift over a long flight.
    align_freeze_after_kf: int = 40
    #: Reject an alignment that implies an implausible correction.
    align_max_scale: float = 5.0
    #: Edge-aware confidence: depth discontinuities are unreliable, so they get
    #: down-weighted rather than fused as if they were solid surfaces.
    edge_suppression: bool = True
    edge_threshold: float = 0.06
    #: TensorRT engine cache (built on first use when backend == "trt").
    trt_engine_path: str = "data/engines/depth.plan"
    trt_workspace_mb: int = 2048


class ScaleConfig(BaseModel):
    """Metric scale anchoring for monocular reconstruction."""

    mode: Literal["depth_net", "mavlink", "fixed", "none"] = "depth_net"
    fixed_scale: float = 1.0
    mavlink_url: str = "udp:0.0.0.0:14550"
    #: Trust region: reject scale updates that move more than this per keyframe.
    max_rate: float = 0.05
    #: Low-pass on the estimated scale; monocular scale is noisy per-frame.
    smoothing: float = 0.9


class FusionConfig(BaseModel):
    """Volumetric TSDF fusion."""

    backend: Literal["auto", "cuda", "open3d", "none"] = "auto"
    voxel_size_m: float = 0.04
    #: Truncation distance in voxels. 3-5 is the usual stable range.
    trunc_voxels: float = 4.0
    block_size: int = 8  # 8^3 voxels per hashed block
    #: Hard VRAM cap for the voxel store. The allocator refuses to exceed it and
    #: evicts least-recently-touched blocks to host RAM instead of OOMing.
    max_vram_gb: float = 3.0
    #: Depth beyond this is not integrated even if the network reports it.
    max_integration_depth_m: float = 30.0
    #: Host-RAM tier for evicted TSDF blocks (GB of system RAM). Evicted
    #: blocks spill here instead of being discarded and page back when the
    #: camera revisits the region, so the VRAM budget bounds the WORKING SET
    #: rather than the total map size -- long multi-room scans keep the
    #: geometry behind the camera. 0 disables (old discard behaviour).
    host_cache_gb: float = 8.0
    #: Subsample the depth map before casting. 1 = every pixel.
    depth_stride: int = 1
    #: Weight new observations less at grazing angles and far range.
    angle_weighting: bool = True
    range_weighting: bool = True
    #: Depth at which the range weight equals 1.0. Falloff is 1/d^2 relative to
    #: this, floored by `range_weight_floor` so distant surfaces still
    #: accumulate enough weight to survive extraction.
    range_ref_m: float = 3.0
    range_weight_floor: float = 0.08
    #: Accumulated weight a voxel needs before it counts as real surface. This
    #: is the primary accuracy/completeness dial. Measured on the validation
    #: scene (150 frames, 4 cm voxels, ground-truth depth):
    #:
    #:     0.10 -> 96.3% complete, 6.5 cm median error
    #:     0.25 -> 93.9% complete, 5.4 cm median error   (default)
    #:     0.50 -> 85.8% complete, 4.8 cm median error
    #:     0.75 -> 75.2% complete, 4.8 cm median error
    #:
    #: Raise it for a clean model of well-covered geometry; lower it for maximum
    #: coverage from a fast single pass. See docs/TUNING.md.
    min_extract_weight: float = 0.25
    max_weight: float = 64.0  # caps weight so the surface stays adaptable
    #: Re-integrate from corrected poses once drift correction exceeds this.
    reintegrate_trans_m: float = 0.10
    reintegrate_rot_deg: float = 3.0
    reintegrate_enabled: bool = True


class LoopClosureConfig(BaseModel):
    enabled: bool = True
    #: Keyframes to skip before a match is considered a genuine revisit.
    min_kf_gap: int = 30
    #: Bag-of-words similarity threshold in [0,1].
    match_threshold: float = 0.22
    #: Geometric verification.
    min_inliers: int = 40
    ransac_threshold_px: float = 4.0
    #: Vocabulary size for the online-clustered ORB vocabulary.
    vocab_size: int = 512
    #: A candidate must also score this fraction of the similarity that
    #: temporally adjacent keyframes achieve. Normalising against the local
    #: baseline lets one threshold work in both a bland corridor and a cluttered
    #: room, but set it too high and no genuine revisit ever qualifies:
    #: consecutive frames are near-identical, while a real revisit is seen from
    #: a slightly different pose and always scores well below them.
    baseline_ratio: float = 0.35
    pose_graph_iterations: int = 25


class VizConfig(BaseModel):
    backend: Literal["rerun", "viser", "none"] = "rerun"
    spawn_viewer: bool = True
    #: rerun serve address for remote viewing (browser / another machine).
    serve: bool = False
    serve_port: int = 9876
    #: Throttle: stream the live image every N frames to keep the link light.
    image_every_n: int = 3
    mesh_every_n_kf: int = 10  # incremental mesh refresh cadence
    max_points_preview: int = 400_000
    show_frusta: bool = True


class ExportConfig(BaseModel):
    output_dir: str = "data/sessions"
    formats: list[str] = Field(default_factory=lambda: ["ply", "obj", "glb"])
    #: Mesh post-processing.
    mesh_simplify_target: int = 0  # 0 = no decimation
    remove_small_clusters: bool = True
    min_cluster_faces: int = 200
    #: Bake a UV texture atlas from keyframe imagery instead of vertex colours.
    textured: bool = False
    texture_size: int = 4096
    #: Also emit a point cloud and a 3DGS-format .splat seeded from the TSDF.
    export_pointcloud: bool = True
    export_splat: bool = False
    save_trajectory: bool = True  # TUM format
    save_keyframes: bool = False  # RGB + depth, for offline 3DGS training


class ControlConfig(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8088
    #: Automatically export when the stream ends or stalls.
    auto_export_on_stop: bool = True
    #: Root for everything the control plane reads and writes besides live
    #: sessions (which follow ``export.output_dir``): photogrammetry scans,
    #: downloads. An embedding host injects its own absolute path here instead
    #: of inheriting paths relative to whatever the process cwd happens to be.
    data_root: str = "data"


class PipelineConfig(BaseModel):
    """How the stages are scheduled."""

    #: ``threaded`` decouples ingest/tracking/mapping/fusion across threads. That
    #: is essential for a live stream, where the socket must keep being drained
    #: and latency matters more than determinism -- but it means the mapper's
    #: corrections reach the tracker a variable number of frames late, so two
    #: runs over identical input do not produce identical maps.
    #:
    #: ``sequential`` runs every stage inline, one frame at a time. Reproducible,
    #: and more accurate offline, because bundle-adjustment and loop-closure
    #: corrections are applied before the next frame is tracked rather than
    #: several frames later. It cannot keep up with a live source.
    mode: Literal["threaded", "sequential"] = "threaded"
    #: Keyframe queue depth (tracker -> mapper). Each entry holds an RGB image
    #: plus predicted depth, so this is host-RAM-for-robustness: a deeper queue
    #: rides out bundle-adjustment spikes without dropping keyframes that
    #: already paid for depth inference. ~5 MB each at 640x480; with 32 GB of
    #: system RAM, raising this is nearly free.
    queue_keyframes: int = 4


class ProfilingConfig(BaseModel):
    enabled: bool = True
    nvml_interval_s: float = 1.0
    log_interval_s: float = 5.0
    trace_file: Optional[str] = None  # per-stage latency trace (JSONL)


class Config(BaseModel):
    source: SourceConfig = Field(default_factory=SourceConfig)
    camera: CameraConfig = Field(default_factory=CameraConfig)
    tracking: TrackingConfig = Field(default_factory=TrackingConfig)
    keyframe: KeyframeConfig = Field(default_factory=KeyframeConfig)
    depth: DepthConfig = Field(default_factory=DepthConfig)
    scale: ScaleConfig = Field(default_factory=ScaleConfig)
    fusion: FusionConfig = Field(default_factory=FusionConfig)
    loop: LoopClosureConfig = Field(default_factory=LoopClosureConfig)
    viz: VizConfig = Field(default_factory=VizConfig)
    export: ExportConfig = Field(default_factory=ExportConfig)
    control: ControlConfig = Field(default_factory=ControlConfig)
    pipeline: PipelineConfig = Field(default_factory=PipelineConfig)
    profiling: ProfilingConfig = Field(default_factory=ProfilingConfig)

    session_name: str = "session"
    seed: int = 0
    log_level: str = "INFO"

    @model_validator(mode="after")
    def _check(self) -> "Config":
        if self.fusion.trunc_voxels < 1.0:
            raise ValueError("fusion.trunc_voxels must be >= 1.0")
        if self.keyframe.min_interval_s > self.keyframe.max_interval_s:
            raise ValueError("keyframe.min_interval_s exceeds max_interval_s")
        if self.depth.min_depth_m >= self.depth.max_depth_m:
            raise ValueError("depth.min_depth_m must be < depth.max_depth_m")
        if not (0 < self.fusion.voxel_size_m < 10):
            raise ValueError("fusion.voxel_size_m out of range")
        return self

    # -- intrinsics ---------------------------------------------------------

    def build_intrinsics(self):
        """Resolve the camera block into a concrete `CameraIntrinsics`."""
        from .types import CameraIntrinsics

        c = self.camera
        if c.calibration_file:
            return load_calibration(c.calibration_file)
        if c.fx is None or c.fy is None:
            return CameraIntrinsics.from_fov(c.width, c.height, c.hfov_deg)
        return CameraIntrinsics(
            width=c.width,
            height=c.height,
            fx=c.fx,
            fy=c.fy,
            cx=c.cx if c.cx is not None else c.width * 0.5,
            cy=c.cy if c.cy is not None else c.height * 0.5,
            dist=tuple(c.dist),
        )

    # -- io -----------------------------------------------------------------

    @classmethod
    def load(cls, path: str | Path | None = None, overrides: dict[str, Any] | None = None) -> "Config":
        data: dict[str, Any] = {}
        if path:
            p = Path(path)
            if not p.exists():
                raise FileNotFoundError(f"config not found: {p}")
            data = yaml.safe_load(p.read_text()) or {}
            # `extends:` lets configs/drone_1080p30.yaml build on default.yaml
            # instead of restating every field.
            if "extends" in data:
                base_path = (p.parent / data.pop("extends")).resolve()
                base = yaml.safe_load(base_path.read_text()) or {}
                data = _deep_merge(base, data)
        if overrides:
            data = _deep_merge(data, overrides)
        return cls.model_validate(data)

    def dump(self, path: str | Path) -> None:
        Path(path).write_text(yaml.safe_dump(self.model_dump(mode="json"), sort_keys=False))


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def parse_set_overrides(pairs: list[str]) -> dict[str, Any]:
    """Turn ``["fusion.voxel_size_m=0.02", "viz.backend=none"]`` into a nested dict."""
    out: dict[str, Any] = {}
    for pair in pairs:
        if "=" not in pair:
            raise ValueError(f"--set expects key=value, got {pair!r}")
        key, raw = pair.split("=", 1)
        node = out
        parts = key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        try:
            value = yaml.safe_load(raw)  # gives ints/floats/bools/lists for free
        except yaml.YAMLError:
            value = raw
        node[parts[-1]] = value
    return out


def load_calibration(path: str | Path):
    """Load intrinsics from an OpenCV-style YAML/JSON calibration file."""
    from .types import CameraIntrinsics

    p = Path(path)
    text = p.read_text()
    if p.suffix in (".json",):
        import json

        d = json.loads(text)
    else:
        # OpenCV writes a %YAML:1.0 directive that PyYAML rejects.
        d = yaml.safe_load(text.replace("%YAML:1.0", "").replace("!!opencv-matrix", ""))
    if "camera_matrix" in d:  # OpenCV calibration output
        m = d["camera_matrix"]
        K = np.reshape(m["data"], (3, 3)) if isinstance(m, dict) else np.reshape(m, (3, 3))
        dist = d.get("distortion_coefficients", {})
        dist = dist.get("data", [0] * 5) if isinstance(dist, dict) else list(dist)
        return CameraIntrinsics(
            int(d.get("image_width", 0)), int(d.get("image_height", 0)),
            float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2]),
            tuple(float(x) for x in dist[:5]),
        )
    return CameraIntrinsics(
        int(d["width"]), int(d["height"]), float(d["fx"]), float(d["fy"]),
        float(d["cx"]), float(d["cy"]), tuple(d.get("dist", [0.0] * 5))[:5],
    )


import numpy as np  # noqa: E402  (used by load_calibration)

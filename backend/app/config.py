from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from functools import lru_cache
from pathlib import Path
import torch

ROOT_DIR = Path(__file__).parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Server
    secret_token: str = Field(default="dev_token_change_in_production")
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8001)
    log_level: str = Field(default="info")
    allowed_origins: list[str] = Field(default=["http://localhost:3000"])

    # Vision
    default_yolo_model: str = Field(default="yolov8m.pt")
    # Metric depth (depth-mapping mode + obstacle-avoidance sensing). Weights
    # must match the setting: ZoeDepth's NYU (indoor) weights read a post 30 m
    # away as 1.7 m on outdoor footage - every obstacle looked one step ahead.
    # The outdoor Depth-Anything-V2 metric model (40 ms on a 4070) reads 5-60 m.
    # Since 2026-09-27: Depth Anything 3 metric (lens-aware, ~35 % less shape
    # error than V2 outdoor on the Gazebo benchmark, 54 ms on the laptop
    # 4070; docs/avoidance/DEPTH_MODELS.md). Falls back to V2 outdoor if its
    # source checkout (DA3_SRC) is missing.
    depth_model: str = Field(default="depth-anything/DA3METRIC-LARGE")
    depth_viz_max_m: float = Field(default=60.0)   # colormap clip, metres
    # Farthest depth reading treated as an obstacle. Monocular metric depth
    # compresses with range (measured on the sim: 31 m reads 22.6, 58 m reads
    # 26, 100 m reads 23), so past this everything reads the same and a
    # tower 80 m away would look like a wall 25 m ahead. 20 here is ~25 m
    # true - the range a mono camera can honestly judge.
    depth_obstacle_max_m: float = Field(default=20.0)
    # Horizontal FOV of the drone's forward camera. Obstacle bearings come
    # straight from it, so a wrong value puts every obstacle at the wrong
    # angle (SIYI A8 ~81, gz x500 mono_cam 99.7, gz x500_depth IMX214 69).
    # Set CAMERA_HFOV_DEG in .env.
    camera_hfov_deg: float = Field(default=70.0)
    # A camera on the operator's machine (video source "camera": webcam,
    # USB camera) is a different lens from the drone's. Metric depth models
    # turn their output into metres through the focal length, so using the
    # drone's FOV for a webcam made every distance ~40 % short (a 99.7 deg
    # drone setting on a ~70 deg webcam). Typical webcams: 60-78 deg.
    webcam_hfov_deg: float = Field(default=70.0)
    # Fallback inference width for any mode not listed in
    # inference_width_by_mode below.
    inference_resize_width: int = Field(default=640)
    # Per-mode inference width. This is NOT a free knob: it sets the altitude
    # ceiling for small-object work, and it costs pixels quadratically.
    #
    # A 1.7m person at 25px (YOLO's practical detection floor) is ~31m slant
    # range at 640px but ~62m at 1280px - so crowd counting anywhere near the
    # 40-50m operating band NEEDS 1280, while a tracker following one large
    # nearby subject gains nothing from it and would just pay 4x the compute.
    # Hence per-mode rather than one global value.
    #
    # Plate OCR deliberately bypasses this entirely and runs on the full
    # frame (plate_tracker.py) - a 500mm plate needs ~120px across to read at
    # all, which no downscaled frame can provide.
    inference_width_by_mode: dict[str, int] = Field(
        default={
            # Small targets at altitude - the binding constraint on the band.
            "crowd-management": 1280,
            # 0 = NATIVE, no downscale. Plate reading is the one job where
            # every pixel is load-bearing: measured on real footage from this
            # rig, plates arrive 31-79px wide, which is already at the edge of
            # readable. Downscaling the detection pass also shrinks the vehicle
            # boxes the OCR crops are taken from, so it costs plate pixels
            # twice over. Compute is deliberately not the constraint here.
            "vehicle-plate-tracking": 0,
            # 1280, walked back from NATIVE after measuring it on this GPU:
            #
            #     960   10.1 ms/frame    99 fps ceiling
            #     1280  17.0 ms/frame    59 fps ceiling
            #     1920  40.0 ms/frame    25 fps ceiling
            #
            # Native was the honest reading of "no downscaling", but this mode
            # runs a person pass, a vehicle pass, colour, speed and OCR off one
            # frame, and in the air it measured 19.8 fps analysed at 40-47 ms
            # against 30 fps video. Overlay boxes then update on two frames out
            # of three, which is visible as annotations jumping - the reported
            # symptom, and the reason clicking was landing in the gap between
            # where a box was drawn and where it actually was.
            #
            # Plate quality does NOT pay for this. OCR crops are cut from the
            # full-resolution frame (see _read_plate), never from the resized
            # copy, so the only thing a narrower pass costs is a little box
            # precision. vision/profiles.py is told the width detection really
            # ran at, so its pixels-on-target maths follows this automatically.
            "traffic-management": 1280,
            # Subject is close and fills much of the frame. Face detection in
            # person-tracking has its own separate width (_FACE_DET_WIDTH).
            "human-tracking": 640,
            "person-tracking": 640,
            "object-detection": 640,
            # 0 = NATIVE, like plate reading, and for the same reason: every
            # pixel is load-bearing. The reconstruction analyzer bridges the
            # frame as received and never calls resize_for_inference, so this
            # entry is a guard against any future refactor applying the
            # default 640 uniformly - the engine does its own sensible
            # downscaling for tracking, and REFINE works from the full-res
            # keyframes. (The 640x360 corridor scan came from WebRTC's
            # maintain-framerate degradation, fixed sender-side in
            # videoSettings.ts, not from this table.)
            "3d-reconstruction": 0,
        }
    )

    # Per-frame millisecond budget for traffic-management's OPTIONAL analytics
    # - plate OCR and face recognition - on top of detection and speed.
    # vision/profiles.py spends it on whichever of the two the current optics
    # can actually resolve, so this is not a cap that binds at every altitude:
    # in the survey profile nothing is spent at all.
    #
    # 45ms buys 3 OCR calls a frame with faces off, or 2 with faces on. That
    # deliberately trades frame rate for plate acquisition speed, which is the
    # right trade for this mode: an unread plate is a lost record, whereas a
    # few dropped frames cost nothing that matters once a vehicle is tracked.
    traffic_optional_budget_ms: float = Field(default=45.0)

    def inference_width_for(self, mode: str) -> int:
        """Inference width for a mode name, falling back to the global default."""
        if not mode:
            return self.inference_resize_width
        return (self.inference_width_by_mode or {}).get(
            str(mode), self.inference_resize_width
        )
    max_concurrent_sessions: int = Field(default=4)
    force_cpu: bool = Field(default=False)

    # ------------------------------------------------------------------ #
    # Camera calibration - the fixed (non-gimbal) mount                    #
    # ------------------------------------------------------------------ #
    # Every metric vision output (speed, ground position, target distance)
    # is only as good as these numbers. HFOV in particular CANNOT be looked
    # up from the sensor part number - it is a property of the lens fitted,
    # so it must be measured on the bench:
    #
    #   place a target of known width W at known distance D, filling the
    #   frame edge to edge  ->  hfov_deg = 2*atan(W / (2*D))
    #
    # Better still, run an OpenCV checkerboard calibration and fill in the
    # distortion coefficients too: a wide lens has enough barrel distortion
    # to bias ground projection near the frame edges, which is exactly where
    # a tracked vehicle sits just before it leaves frame.
    camera_hfov_deg: float = Field(default=70.0)
    # Leave at 0.0 to derive from HFOV and the frame's aspect ratio, which is
    # correct for a rectilinear lens. Set explicitly only if measured, since a
    # fisheye's vertical FOV does not follow from its horizontal one.
    camera_vfov_deg: float = Field(default=0.0)
    # Radial/tangential distortion (k1, k2, p1, p2, k3) - OpenCV order.
    # All zeros = treat the lens as ideal rectilinear, i.e. skip undistortion.
    camera_distortion: list[float] = Field(default=[0.0, 0.0, 0.0, 0.0, 0.0])

    # Mount orientation, degrees, camera relative to the airframe. With no
    # gimbal the camera's world pose is drone attitude PLUS these offsets, so
    # they are a one-time rig measurement rather than a live sensor read.
    #
    # tilt is DEPRESSION below the horizon at frame centre. 40-47 deg is the
    # useful range for a 70 deg lens: VFOV is then 43 deg, so the frame spans
    # ~25-68 deg of depression at once - shallow enough at the top of frame to
    # read a plate, steep enough at the bottom for robust ground projection.
    # Ground-range error per degree of pitch is h/sin^2(theta), which is 1.75 m
    # per degree at 45 deg and 50 m altitude but 7.5 m per degree at 20 deg,
    # so shallow mounts are far less forgiving.
    camera_mount_tilt_deg: float = Field(default=45.0)
    camera_mount_yaw_deg: float = Field(default=0.0)
    camera_mount_roll_deg: float = Field(default=0.0)

    # Which telemetry field to believe for height above the ground the target
    # is standing on: "baro" | "gps" | "rangefinder".
    # Relative altitude error is what propagates into speed, so this matters
    # most when low: +-1.5m of baro drift is 15% at 10m but 3% at 50m.
    # GPS vertical (+-3-5m) is too coarse below ~50m. NOTE both are relative
    # to the launch point, so a target on ground at a different elevation
    # carries that offset straight into the estimate.
    agl_source: str = Field(default="baro")
    # Metres to subtract from reported altitude to get true height above the
    # target's ground plane, when launch elevation differs from the scene.
    agl_offset_m: float = Field(default=0.0)

    # ------------------------------------------------------------------ #
    # Speed estimation                                                     #
    # ------------------------------------------------------------------ #
    # Frames in the least-squares velocity fit. Do NOT differentiate two
    # frames: slope error is sigma_px * sqrt(12/(N(N^2-1)))/dt, so N=15 at
    # 30fps turns 1.5px of box jitter into <1 km/h, while N=2 would leave
    # several km/h of noise. Longer windows smooth harder but lag real
    # acceleration, and 0.5s is the point where jitter stops dominating.
    speed_fit_window_frames: int = Field(default=15)
    # Where metres-per-pixel comes from:
    #   "altitude" - AGL + HFOV. Error shrinks with height (3% at 50m).
    #   "object"   - a detected vehicle's known class width as a ruler.
    #                Flat ~4%, and independent of altitude AND attitude.
    #   "auto"     - use both, prefer the tighter, and flag disagreement.
    # "auto" is the point of having two: they fail for unrelated reasons, so
    # agreement is real evidence and disagreement is a reason to distrust the
    # reading rather than publish it.
    speed_scale_source: str = Field(default="auto")
    # Percent disagreement between the two scale sources above which a speed
    # reading is marked unreliable instead of reported.
    speed_scale_max_disagreement_pct: float = Field(default=10.0)
    # Known widths in metres by vehicle class, for the "object" ruler. Width
    # (not length) because it is measured perpendicular to the direction of
    # travel - which the tracker knows - and varies least across models.
    vehicle_widths_m: dict[str, float] = Field(
        default={"car": 1.80, "motorcycle": 0.80, "bus": 2.50, "truck": 2.45}
    )

    # ------------------------------------------------------------------ #
    # Auto-elevate - the chase fallback, NOT normal operation              #
    # ------------------------------------------------------------------ #
    # Only fires when a locked target outpaces the airframe's top speed. Two
    # separate ceilings because they fail differently: hitting the altitude
    # cap is a legal stop, while hitting the depression cap means still
    # flying but with analytics that have gone worthless. The operator has to
    # be told which one was reached.
    max_altitude_agl_m: float = Field(default=120.0)   # DGCA ceiling
    # THE FLOOR. Every tracking mode could command descent without bound -
    # the ceiling above had no counterpart - and a SITL vehicle-follow flew
    # itself into the ground: a sustained +0.5 m/s descent from the altitude
    # controller took it 6.6m -> 0m, then "invalid setpoints / blind land".
    # Nothing below this altitude is worth any framing improvement.
    min_altitude_agl_m: float = Field(default=1.0)

    # ── Crowd density thresholds ──────────────────────────────────────────
    # Server-side so they SURVIVE analyzer creation. They used to live only in
    # the browser and be pushed over a socket when the crowd panel mounted -
    # which lost a race it could not win: the panel mounts before the stream
    # negotiates, so the analyzer did not exist yet, the push no-op'd, and the
    # analyzer then came up on these defaults. The operator's custom numbers
    # were silently discarded every session.
    crowd_light_max: int = Field(default=8)
    crowd_moderate_max: int = Field(default=20)
    max_depression_deg: float = Field(default=70.0)    # recognition-quality cap

    # ── Follow tuning: the YAW axis, shared by every tracking mode ────────
    # Yaw is the primary axis on a fixed-mount airframe - it is the one that
    # decides whether the subject stays in frame at all - and these four
    # numbers are what an operator actually reaches for after a flight that
    # oscillated or lagged.
    #
    # They were reachable in exactly two modes. Human Tracking and Person
    # Tracker each carry the sliders in their own panel; crowd management,
    # traffic management and vehicle-plate tracking got the same PD stack with
    # no way to touch it, so those three flew on these numbers permanently and
    # a tuning session in Human Tracking taught you nothing transferable.
    # Here they are the DEFAULT every mode starts from; the two panels that
    # already had live sliders still override it for their own session.
    follow_yaw_kp: float = Field(default=30.0)
    follow_yaw_kd: float = Field(default=4.0)
    # Ceiling, not a target. PX4 stock MPC_YAWRAUTO_MAX is 60 deg/s, so 55
    # leaves margin rather than having setpoints silently rate-limited
    # upstream - which looks exactly like a tuning problem from the ground.
    follow_yaw_max_deg_s: float = Field(default=55.0)
    follow_yaw_deadband: float = Field(default=0.05)

    # WebRTC - Cloudflare TURN key (dashboard → Calls → TURN). The key ID +
    # API token are NOT username/password: the backend mints short-lived
    # credentials from them (app/webrtc/turn.py). Empty = STUN-only.
    turn_key_id: str = Field(default="")
    turn_api_token: str = Field(default="")

    # Zero-transcode RTSP relay uplink (app/webrtc/relay_video_source.py).
    # The desktop app pushes MPEG-TS over SRT straight to this host:port -
    # NOT over the HTTP API, so it does NOT travel through the cloudflared
    # tunnel (which proxies HTTP only). This must be a directly reachable
    # address with UDP 9000-9100 forwarded to the server, otherwise the
    # relay mode cannot connect and clients must fall back to WebRTC.
    # Empty = fall back to the API hostname, which is usually WRONG behind
    # a tunnel and will be reported to the client as unconfigured.
    relay_public_host: str = Field(default="")
    relay_default_transport: str = Field(default="srt")
    # Send a client that shares a network with us straight to our address on
    # that network, instead of out to relay_public_host and back. Removes an
    # internet round trip for local/LAN/VPN clients, and is the only way the
    # relay works at all on networks that block outbound UDP on high ports.
    # See _relay_host_for in webrtc/signaling.py. Turn OFF if a reverse proxy
    # does not set CF-Connecting-IP or X-Forwarded-For, since remote clients
    # would then look local and be handed an address they cannot reach.
    relay_prefer_local_host: bool = Field(default=True)
    # SRT receiver buffer, ms - the retransmit window, and a FLOOR on
    # glass-to-glass latency. SRT needs 2.5-4x RTT for a NAK plus resend to
    # complete; measured RTT to a CDN edge is ~35ms, so the old 60 was ~1.7x:
    # too tight to recover anything while still adding its full 60ms of delay.
    # Keep in step with DEFAULT_LATENCY_MS in webrtc/relay_video_source.py and
    # DEFAULT_RELAY_LATENCY_MS in frontend/src/lib/videoSource.ts - this value
    # is the one that actually wins (see allocate_video_relay).
    relay_latency_ms: int = Field(default=150)

    # Database - local Postgres for now; swapping to a managed provider
    # (Supabase/RDS are both Postgres) is just changing this URL.
    database_url: str = Field(
        default="postgresql+asyncpg://hyrak:hyrak_dev@127.0.0.1:5432/hyrak"
    )

    # Telemetry
    default_baud_rate: int = Field(default=57600)

    # Where the RF ground decoder's uplink listener (wfb_tx) runs.
    #
    # Not loopback: the decoder is its own board on the local network, not a
    # process on this machine. Downlink needs no equivalent setting - the
    # bridge binds 0.0.0.0 and receives from anywhere - but the uplink is a
    # send to a fixed listener, so a wrong value here gives perfect telemetry
    # and silently drops every command. A setting rather than a constant so a
    # different rig can override it in .env without touching code.
    rf_uplink_host: str = Field(default="192.168.50.12")

    # ── MAVLink stream rates, Hz ──────────────────────────────────────────
    # Two profiles, because the two links are genuinely different: a local UDP
    # hop to SITL has effectively unlimited headroom, while a 57600-baud SiK
    # radio is half-duplex and shared with the uplink.
    #
    # Configurable rather than hard-coded because the right number depends on
    # the radio in front of it - air data rate, ECC setting, and how far apart
    # the two ends are. The defaults are chosen against the observation that
    # QGroundControl over the same 3DR radio sustains comfortably more than
    # this; if a particular link cannot hold it the symptom is dropped
    # messages and "Socket closed" reconnects, and these are the knobs to turn
    # down. Only the three that feed the tracking geometry are exposed - the
    # dashboard streams are not worth a setting.
    # POSITION AND VELOCITY ARE ONE MESSAGE, not two. Both MAVSDK setters
    # drive GLOBAL_POSITION_INT and it takes the higher of the two
    # (telemetry_impl.cpp: max(_position_rate_hz, _velocity_ned_rate_hz)), so
    # a separate velocity dial can only ever raise the position rate, never
    # lower it or buy an independent stream. Exposing one was a trap: it read
    # as a third of the bandwidth budget that does not exist. Velocity comes
    # free with position, at the same rate.
    # THE RADIO FIGURES ARE BACK TO THE CONSERVATIVE ORIGINALS.
    #
    # They were raised to 8/10 Hz on the reasoning that QGroundControl sustains
    # more than that over the same 3DR radio. That inference was wrong in an
    # important way: QGC is not also running this application's uplink, and a
    # SiK radio is half-duplex - saturating the downlink starves the commands
    # going the other way. The code being edited already carried a warning
    # written from experience, that the higher rates "can saturate it and cause
    # exactly the kind of intermittent Socket closed disconnects that don't
    # happen in QGroundControl", and raising them anyway produced a link that
    # would not hold and commands that did not arrive.
    #
    # Raise them deliberately instead, one step at a time, watching
    # measured_rates on the telemetry page: if the measured figure tracks the
    # request there is headroom, and if it stops climbing that is the ceiling.
    # A number that has been measured on THIS radio is worth more than one
    # inferred from another ground station's behaviour.
    #
    # ATTITUDE ON THE RADIO IS 6 Hz, NOT 4, as of 2026-08-09 - one step, on
    # purpose, with the arithmetic done first rather than by analogy to QGC.
    # A MAVLink v2 ATTITUDE frame is 40 bytes, so 4 -> 6 Hz costs 80 B/s and
    # takes the whole downlink profile from ~440 to ~520 B/s. Against a
    # conservative 3DR ceiling (AIR_SPEED 64k, ECC on, half-duplex, framing
    # overhead) of ~1600 B/s that is 28% -> 32% of budget.
    #
    # The same arithmetic explains the earlier failure far better than the
    # guess that replaced it: 10/8 Hz came to ~920 B/s, 57% of that ceiling -
    # and 115%, i.e. over it, if AIR_SPEED is 32k rather than 64k. Nothing
    # here can read AIR_SPEED, which is why this moves one step at a time.
    # Opt-in capture-to-reaction latency probe (app/latency_probe.py). Writes
    # .logs/latency_probe.jsonl; also switchable at runtime via the API.
    latency_probe: bool = Field(default=False)
    telemetry_rate_position_radio: float = Field(default=2.0)
    telemetry_rate_position_udp: float = Field(default=4.0)
    telemetry_rate_attitude_radio: float = Field(default=6.0)
    telemetry_rate_attitude_udp: float = Field(default=10.0)
    mavsdk_server_host: str = Field(default="localhost")
    mavsdk_server_port: int = Field(default=50051)
    sitl_address: str = Field(default="udpin://0.0.0.0:14540")

    # Desktop app installers + electron-updater's manifest files
    # (latest.yml / latest-mac.yml / latest-linux.yml), served straight off
    # disk at /releases - see desktop/package.json's "generic" publish
    # provider (no GitHub involved) and frontend/src/lib/desktopReleases.ts.
    # CI (.github/workflows/desktop-release.yml) uploads new builds here.
    releases_dir: Path = Field(default=ROOT_DIR / "releases")

    @property
    def lan_origins(self) -> list[str]:
        """
        Frontend origin for whatever LAN IP this machine currently has - the
        CORS allowlist below is an exact-string match (no wildcard/regex
        support in either FastAPI's CORSMiddleware or python-engineio), and
        DHCP can reassign the LAN IP across reboots, so this is computed at
        startup instead of hardcoded in .env.
        """
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))  # doesn't actually send anything - just picks the outbound interface
            ip = s.getsockname()[0]
            s.close()
            return [f"http://{ip}:3000"]
        except Exception:
            return []

    @property
    def device(self) -> str:
        if self.force_cpu:
            return "cpu"
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    @property
    def gpu_count(self) -> int:
        return torch.cuda.device_count() if torch.cuda.is_available() else 0

    @property
    def gpu_info(self) -> list[dict]:
        if not torch.cuda.is_available():
            return []
        return [
            {
                "index": i,
                "name": torch.cuda.get_device_name(i),
                "memory_gb": round(
                    torch.cuda.get_device_properties(i).total_memory / 1e9, 1
                ),
            }
            for i in range(torch.cuda.device_count())
        ]


@lru_cache
def get_settings() -> Settings:
    """Returns cached settings instance. Import this everywhere."""
    return Settings()

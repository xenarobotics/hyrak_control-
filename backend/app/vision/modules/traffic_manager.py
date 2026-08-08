"""
Traffic management — the composed vehicle module.
=================================================

One mode covering everything the vehicle side of the brief asks for: how many
vehicles, what they are, what colour, what their plates read, how fast they are
going, and following one of them.

ALL FIVE ANALYTICS, PLUS AN HONEST STATEMENT OF WHAT IS IN RANGE
    Vehicles, plates, speed and colour; crowd counting borrowed from
    crowd_manager; face recognition borrowed from person_tracker's gallery.

    Those five do NOT share an altitude. Plates want low and oblique (a 500mm
    plate needs ~100px across, which is ~7m slant range on a 70deg 1080p lens).
    Crowd counting wants high and near-nadir. Faces want closer still. A module
    that simply claimed all five at once would be lying about the geometry.

    So the resolution is not to pick a subset and drop the rest — it is to run
    everything and REPORT which subjects the current altitude can actually
    resolve (vision/viability.py). At 50m a plate is 14px across; the reader
    refuses it and the readout says "descend to about 7m". That turns what
    looks like a broken analytic into a flight decision, and it is why this
    module can honestly offer all five.

ONE DETECTION PASS FOR PEOPLE AND VEHICLES
    People and vehicles are found in a SINGLE YOLO call over COCO classes
    [0,2,3,5,7] rather than one pass each. Detection is the most expensive
    per-frame item, so running it twice to get two lists would nearly double
    the module's cost for no new information.

THE OPTIMISATION THAT MAKES IT FIT IN ONE FRAME BUDGET
    Running every model on every frame does not fit. Measured on this hardware:

        YOLO vehicle detect+track @960   10.6 ms   every frame
        ego-motion + speed fit            ~5   ms   every frame
        colour classify                   ~0.2 ms   first sighting only
        fast-alpr                         14.7 ms   ONE crop per frame

    fast-alpr letterboxes its input to 384x384, so a call costs the same
    whatever it is given — 14.7ms for a full 1920 frame or for one vehicle crop.
    That single fact drives the whole design:

      * A plate on a 400px-wide vehicle is ~22px after a full-frame call
        letterboxes 1920 down to 384. That is far below readable. The SAME call
        on the vehicle's crop letterboxes 400 to 384 and yields ~107px. Reading
        plates from a full frame is not slow, it is close to impossible.
      * Because the cost is fixed per call, the budget is a NUMBER OF CALLS.
        One per frame, spent on the vehicle that most needs it — largest first
        among those without a confident read — keeps the total near 30ms.

    So the composition is not "run everything, hope it fits". It is a per-frame
    budget with an explicit priority, which is what the merge was for.
"""
import logging
import os
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.config import ROOT_DIR, get_settings
from app.vision import calibration
from app.vision.base import BaseAnalyzer
from app.vision.controllers import KalmanXY, PDController, VelocitySmoother
from app.vision.drawing import draw_badge, draw_ring, draw_tint_rect
from app.vision.geometry import camera_from_settings, pose_from_telemetry
from app.vision.modules.plate_tracker import _INDIA_PLATE_RE, _validate_and_correct
from app.vision.pursuit import (
    PursuitLimits, decide_elevation, is_outpaced, limit_descent, lock_state_for,
)
from app.vision.profiles import ProfileSelector
from app.vision.speed import SpeedEstimator
from app.vision.tracker_config import make_bytetrack_cfg
from app.vision.vehicle_color import classify_vehicle_color
from app.vision import viability

logger = logging.getLogger("verocore.vision.traffic_manager")

_TRACKER_CFG = make_bytetrack_cfg("verocore_traffic_")
_VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}
# Same prefix as vehicle-plate-tracking, so one id format reads across modes.
_VEHICLE_ID_PREFIX = "VH"
# COCO indices: 0 person, 2 car, 3 motorcycle, 5 bus, 7 truck. One call for
# both subject types — see the module docstring.
_DETECT_CLASSES = [0, 2, 3, 5, 7]

# ── Crowd density, borrowed from crowd_manager ───────────────────────────────
# Same 3x3 grid and the same per-zone colouring, so an operator reads it the
# same way in both modes. Thresholds are frame-relative headcounts and have no
# universally correct value — they depend entirely on framing and altitude,
# which is why they live in the persisted calibration rather than here. These
# two are only the fallback if calibration cannot be read.
_GRID_ROWS, _GRID_COLS = 3, 3
_DENSITY_LIGHT_MAX = 8
_DENSITY_MODERATE_MAX = 20

# Headcount trend, same shape and cadence as crowd_manager so the two modes
# read identically. A live count cannot tell a steady crowd from one that
# doubled in a minute; the trend is the number that can.
_HISTORY_POINTS = 150
_HISTORY_INTERVAL_S = 2.0

# ── Face recognition budget ──────────────────────────────────────────────────
# Paced in SECONDS, not frames, for the same reason as person_tracker: counting
# frames couples identification latency to the source frame rate, so a slow
# video makes names appear slowly. Each check crops up to 2 people at ~3.8ms.
_FACE_CHECK_INTERVAL_S = 0.12
_FACE_CROP_MAX_PEOPLE = 2
_FACE_VOTE_THRESHOLD = 0.45
_FACE_MIN_VOTES = 2
_FACE_CONFIRM_NOW = 0.62
_FACE_ID_MEMORY_S = 4.0

# ── OCR budget ───────────────────────────────────────────────────────────────
# The call costs 14.7ms regardless of input size (see the module docstring), so
# the budget is a COUNT OF CALLS, not pixels.
#
# The live number comes from vision/profiles.py, which spends more calls when
# faces are out of range and none at all when plates are. This constant is only
# the fallback for the frames before a profile exists.
_OCR_CALLS_PER_FRAME = 1
# Don't bother cropping a vehicle this small — after the detector letterboxes
# the crop to 384 there would be nothing left of the plate to read.
_OCR_MIN_VEHICLE_PX = 110
# A read at or above this is treated as final and the vehicle stops consuming
# OCR budget, freeing it for vehicles that still have no plate.
_OCR_GOOD_ENOUGH = 0.80
_OCR_MIN_CONF = 0.55
# Stop retrying a vehicle that has repeatedly failed — usually its plate simply
# is not facing us, and it would otherwise starve every other vehicle.
_OCR_MAX_ATTEMPTS = 12

# ── Guards against fabricated plates ────────────────────────────────────────
#
# All three of these exist because of the same observed failure. Left ungated,
# this module logged plates like WA01WMWH, WA02MM901, WA12MMSH and WAL7MM991 —
# all for the SAME vehicle, on consecutive frames — plus SUBSCRIBE and
# SUBSCR18, read off a video overlay. Every one of those crops was 40-50px
# wide. OCR does not fail loudly at that size; it invents a plausible string,
# and a plausible string is far worse than no reading at all because it looks
# like data.
#
# MINIMUM WIDTH. Below roughly 70px across a plate there is nothing to read,
# whatever the model claims. This is the single most effective of the three: no
# amount of confidence thresholding recovers information that is not in the
# pixels.
_PLATE_MIN_WIDTH_PX = 70
# Plate aspect. Indian single-row plates are ~4:1, two-row ~2:1, so anything
# outside this band is not a plate shape. Note this alone would NOT have
# stopped "SUBSCRIBE" (3.74) — which is exactly why the size and agreement
# gates are also needed.
_PLATE_ASPECT_MIN = 1.6
_PLATE_ASPECT_MAX = 6.0
# CROSS-FRAME AGREEMENT. One vehicle yielding five different strings is the
# signature of guessing. A reading is provisional until the same characters
# come back twice; only then is it logged or shown as confirmed. Same principle
# as the face-identification vote in person_tracker.
_PLATE_MIN_AGREEING_READS = 2

# Colour is re-read while confidence is still poor (a vehicle entering frame is
# often half-occluded), then frozen.
_COLOUR_GOOD_ENOUGH = 0.55

_LOCK_LOST_AFTER_S = 3.0
_DEFAULT_SIZE_RATIO = 0.22      # target vehicle height as a fraction of frame
# A person is a stable ~1.7m of vertical extent regardless of which way they
# face; a vehicle's apparent height swings with its heading. So the two need
# different hold targets, and only the person one can be given a meaningful
# metres equivalent. 0.30 matches human_tracker's default (~5m).
_DEFAULT_PERSON_SIZE_RATIO = 0.30
_HEIGHT_EMA_ALPHA = 0.12
_YAW_PRIORITY_THRESHOLD = 0.30
MAX_PURSUIT_SPEED_M_S = 2.5     # keep in step with dist_pd max_output

_CAPTURE_ROOT = os.path.join(str(ROOT_DIR), ".data", "plate_captures")


def _density_level(count: int, light_max: int = _DENSITY_LIGHT_MAX,
                   moderate_max: int = _DENSITY_MODERATE_MAX) -> str:
    """Thresholds are passed in, not read from module constants.

    They were constants here while crowd-management had already moved them to
    the persisted calibration, so the same crowd was graded differently
    depending on which mode was watching it — and an operator's custom values
    silently reverted to 8/20 on entering this mode.
    """
    if count <= light_max:
        return "green"
    if count <= moderate_max:
        return "orange"
    return "red"


def _section_of(cx: int, cy: int, w: int, h: int) -> int:
    """Which 3x3 grid cell a point falls in. Same layout as crowd_manager."""
    cell_w, cell_h = max(1, w // _GRID_COLS), max(1, h // _GRID_ROWS)
    c = min(_GRID_COLS - 1, cx // cell_w)
    r = min(_GRID_ROWS - 1, cy // cell_h)
    return int(r * _GRID_COLS + c)


class _Vehicle:
    """Everything known about one tracked vehicle, accumulated across frames.

    Plate and colour are kept on a BEST-CONFIDENCE basis rather than
    last-value: both peak on different frames as the vehicle turns, and the
    best read is the one worth keeping and logging.
    """
    __slots__ = (
        "track_id", "vehicle_id", "box", "type", "color", "color_conf",
        "plate", "plate_conf", "plate_box", "crop_path", "vehicle_path",
        "plate_votes", "plate_confirmed", "plate_grammar_ok",
        "speed_kmh", "speed_reliable", "ocr_attempts",
        "first_seen", "last_seen", "logged",
    )

    def __init__(self, track_id: int, box, vtype: str, vehicle_id: str = ""):
        self.track_id = track_id
        # This module's OWN durable identity, distinct from track_id: a
        # ByteTrack id resets on occlusion, so a vehicle that passes behind
        # something comes back as a different number and its colour, speed and
        # plate history are orphaned. Same scheme as vehicle-plate-tracking so
        # an operator reads one id format across both modes.
        self.vehicle_id = vehicle_id
        self.box = box
        self.type = vtype
        self.color = ""
        self.color_conf = 0.0
        self.plate = ""
        self.plate_conf = 0.0
        self.plate_box: Optional[list] = None
        self.crop_path: Optional[str] = None
        self.vehicle_path: Optional[str] = None
        # How many frames independently produced the CURRENT string. One
        # vehicle yielding five different plates is what this counts against.
        self.plate_votes = 0
        self.plate_confirmed = False
        self.plate_grammar_ok = False
        self.speed_kmh: Optional[float] = None
        self.speed_reliable = False
        self.ocr_attempts = 0
        self.first_seen = time.time()
        self.last_seen = time.time()
        self.logged = False

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.box
        return max(0, x2 - x1) * max(0, y2 - y1)

    @property
    def needs_ocr(self) -> bool:
        # A CONFIRMED plate stops consuming budget. Confidence alone is not
        # enough to stop: the fabricated reads that prompted these guards
        # scored up to 1.00.
        return (
            not self.plate_confirmed
            and self.ocr_attempts < _OCR_MAX_ATTEMPTS
        )

    @property
    def reportable_plate(self) -> Optional[str]:
        """The plate, or None if it has not earned being reported.

        Deliberately strict: a provisional read is shown live with a marker so
        an operator can see the system working, but it is never logged, never
        used as a filename, and never presented as a result.
        """
        return self.plate if (self.plate_confirmed and self.plate_grammar_ok) else None


def _make_state(session_id: str) -> Dict[str, Any]:
    capture_dir = os.path.join(_CAPTURE_ROOT, session_id)
    os.makedirs(capture_dir, exist_ok=True)
    return {
        "capture_dir": capture_dir,
        "vehicles": {},              # track_id -> _Vehicle
        "ids_seen": set(),           # unique count, by track id
        "vehicle_id_seq": 0,
        # plate text -> vehicle_id. What makes re-identification possible: a
        # re-read of the same characters is the same vehicle, not a guess.
        "plate_registry": {},
        "type_counts": {},
        "color_counts": {},
        "peak_in_frame": 0,
        "speed": SpeedEstimator(calibration.effective()["speed_fit_window_frames"]),
        # Round-robin cursor so OCR budget rotates rather than fixating on
        # whichever vehicle happens to sort first every frame.
        "ocr_cursor": 0,
        # ── People / crowd / faces ────────────────────────────────────────
        "person_ids_seen": set(),
        "peak_people": 0,
        # From the persisted calibration, so an operator's custom values apply
        # from the FIRST frame rather than whenever a socket push happens to
        # land after the analyzer exists — a race the push cannot win, since
        # the panel mounts before the stream negotiates.
        "light_max": calibration.effective()["crowd_light_max"],
        "moderate_max": calibration.effective()["crowd_moderate_max"],
        # Operator labels for the 9 cells. "North Gate is red" is actionable
        # over a radio; "cell 4 is red" is not.
        "zone_names": {},
        # Deque, not a list: a session can run for hours and only the tail is
        # ever drawn.
        "count_history": deque(maxlen=_HISTORY_POINTS),
        "last_history_t": 0.0,
        # track_id -> {person_id, name, votes, best_sim, confirmed, last_seen}
        "face_identities": {},
        "last_face_check_t": 0.0,
        # ── Capability profile ────────────────────────────────────────────
        # Per-session, so two clients at different altitudes cannot drag each
        # other's profile around. Holds the hysteresis latch.
        "profile": ProfileSelector(),
        # subject -> "auto" | "on" | "off". An operator can force an analytic
        # against the geometry: "on" to try a marginal read anyway, "off" to
        # stop paying for one they do not want.
        "profile_overrides": {},
        # ── Follow ────────────────────────────────────────────────────────
        "locked_track_id": None,
        # "vehicle" | "person" — which list the locked id was found in. Needed
        # because the hold distance and the labelling differ by kind.
        "locked_kind": None,
        "size_ratio": {
            "vehicle": _DEFAULT_SIZE_RATIO,
            "person": _DEFAULT_PERSON_SIZE_RATIO,
        },
        "altitude_mode": "auto",
        "altitude_nudge_v": 0.0,
        "locked_plate": "",
        "follow_request_track_id": None,
        "tracking": False,
        "last_seen_t": 0.0,
        "frames_lost": 0,
        "height_ema": None,
        "elevate": None,
        "yaw_pd": PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        "alt_pd": PDController(kp=1.5, kd=0.3, max_output=1.0, deadband=0.10),
        "dist_pd": PDController(kp=3.0, kd=0.8, max_output=2.5, deadband=0.04),
        "kalman": KalmanXY(),
        "smoother": VelocitySmoother(alpha=0.4),
    }


class TrafficManager(BaseAnalyzer):
    """
    Vehicle count, type, colour, plate, speed, and follow — in one pass.
    """

    MODE = "traffic-management"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device
        self.half = self.device == "cuda"

        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.half, verbose=False,
        )

        # fast-alpr is optional: without it every other analytic in this module
        # still works, so a missing dependency degrades rather than refusing to
        # load the mode.
        self.alpr = None
        try:
            from fast_alpr import ALPR
            self.alpr = ALPR(
                detector_model="yolo-v9-t-384-license-plate-end2end",
                ocr_model="cct-xs-v2-global-model",
            )
            self.alpr.predict(np.zeros((384, 384, 3), dtype=np.uint8))
        except Exception as e:
            logger.warning(
                f"fast-alpr unavailable ({e}) — traffic mode will run without "
                f"plate reading"
            )

        # Face recognition is likewise optional — without it the other four
        # analytics are unaffected, so a load failure degrades this mode rather
        # than refusing it.
        self.face_app = None
        try:
            import insightface
            providers = (
                [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                 "CPUExecutionProvider"]
                if torch.cuda.is_available() else ["CPUExecutionProvider"]
            )
            self.face_app = insightface.app.FaceAnalysis(
                name="buffalo_sc", providers=providers
            )
            self.face_app.prepare(
                ctx_id=0 if torch.cuda.is_available() else -1, det_size=(640, 640)
            )
            self.face_app.get(np.zeros((360, 640, 3), dtype=np.uint8))
        except Exception as e:
            logger.warning(
                f"InsightFace unavailable ({e}) — traffic mode will run without "
                f"face recognition"
            )

        self._gallery = None
        self._client_state: Dict[str, Dict[str, Any]] = {}
        missing = [n for n, ok in
                   (("ALPR", self.alpr), ("faces", self.face_app)) if not ok]
        logger.info(
            f"✅ TrafficManager ready on {self.device.upper()}"
            + (f" (no {', '.join(missing)})" if missing else "")
        )

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state(client_id)

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        self._client_state.pop(client_id, None)

    # ── Operator control ──────────────────────────────────────────────────

    def request_follow(self, client_id: str, track_id: Optional[int]) -> None:
        """
        Follow a specific subject — vehicle OR person — or None to release.

        One id space covers both because both come out of the SAME ByteTrack
        pass (one YOLO call over classes [0,2,3,5,7]), so a track id is unique
        across the two lists and the caller never has to say which kind it
        meant. That is the whole reason this mode can offer click-to-follow on
        anything in frame with a single event.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        if track_id is None:
            state["follow_request_track_id"] = None
            state["locked_track_id"] = None
            state["locked_kind"] = None
            state["locked_plate"] = ""
            state["tracking"] = False
            logger.info(f"Session {client_id[:8]}: lock released")
            return
        state["follow_request_track_id"] = int(track_id)
        logger.info(f"Session {client_id[:8]}: follow requested for track #{track_id}")

    def set_tracking_params(self, client_id: str, target_distance_ratio: float) -> None:
        """
        Adjust the "hold here" distance: target subject height as a fraction of
        frame height. Lower holds farther back, higher holds closer.

        Stored PER KIND, because the two are not interchangeable. A person is a
        stable ~1.7m of vertical extent whichever way they face, so a ratio maps
        to a rough range. A vehicle's apparent height depends on its heading as
        much as its distance — broadside shows the long axis, head-on shows only
        the narrow front — so the same range yields very different fills, and
        the only workable target is one the operator nudges while watching the
        actual fill. Sharing one value between them made a target tuned on a car
        drive the drone into the wrong hold distance the moment a person was
        picked instead.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        kind = state.get("locked_kind") or "vehicle"
        ratio = float(np.clip(target_distance_ratio, 0.05, 0.80))
        state["size_ratio"][kind] = ratio
        state["dist_pd"].reset()
        logger.info(
            f"Session {client_id[:8]}: {kind} hold distance -> {ratio:.2f} fill"
        )

    def set_altitude_mode(self, client_id: str, mode: str) -> None:
        """'fixed' holds the altitude Offboard started at (nudge still applies);
        'auto' lets the altitude PD keep the subject vertically centred.

        Auto-elevate overrides BOTH — holding a fleeing subject in frame at all
        outranks either altitude policy.
        """
        if client_id not in self._client_state or mode not in ("fixed", "auto"):
            return
        state = self._client_state[client_id]
        state["altitude_mode"] = mode
        if mode == "fixed":
            # A stale derivative would lurch the moment auto resumes.
            state["alt_pd"].reset()
        else:
            # Leaving fixed: drop any held nudge so it cannot fight the PD.
            state["altitude_nudge_v"] = 0.0
        logger.info(f"Session {client_id[:8]}: altitude mode -> {mode}")

    def set_altitude_nudge(self, client_id: str, velocity: float) -> None:
        """Manual altitude velocity for Fixed mode: -ve ascend, +ve descend
        (NED), 0 stop. Held while the operator presses, cleared on release.
        Ignored in Auto, which owns this axis."""
        if client_id not in self._client_state:
            return
        self._client_state[client_id]["altitude_nudge_v"] = float(
            np.clip(velocity, -1.5, 1.5)
        )

    def set_zone_names(self, client_id: str, names: Dict[str, str]) -> None:
        """Operator labels for the grid cells, keyed by cell index as a string.
        Same contract as crowd_manager so one panel control drives both."""
        st = self._client_state.get(client_id)
        if st is None:
            return
        st["zone_names"] = {
            str(k): str(v)[:24] for k, v in (names or {}).items() if str(v).strip()
        }
        logger.info(f"Session {client_id[:8]}: {len(st['zone_names'])} zone name(s) set")

    def set_thresholds(self, client_id: str, light_max: int, moderate_max: int) -> None:
        """Density band edges, written through to the persisted calibration.

        Persisted rather than held in session state for the reason crowd
        management already learned the hard way: register_client rebuilds state
        on every stream, so anything living only in the browser or only in a
        session reverts to the defaults the moment the stream reconnects.
        """
        st = self._client_state.get(client_id)
        if st is None:
            return
        lo = max(1, int(light_max))
        hi = max(lo + 1, int(moderate_max))
        st["light_max"], st["moderate_max"] = lo, hi
        calibration.save({"crowd_light_max": lo, "crowd_moderate_max": hi})
        logger.info(f"Session {client_id[:8]}: density thresholds -> {lo}/{hi}")

    def set_profile_override(self, client_id: str, subject: str, mode: str) -> None:
        """
        Force an analytic on or off against the geometry, or hand it back to
        "auto". Kept as an override rather than a mode switch so the automatic
        decision stays visible next to it — an operator who forces plate OCR on
        at 40m should still be able to read that it is 34px short.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        subject = str(subject).lower()
        mode = str(mode).lower()
        if subject not in ("plate", "face") or mode not in ("auto", "on", "off"):
            logger.warning(
                f"Session {client_id[:8]}: ignoring profile override "
                f"{subject!r}={mode!r} — not a recognised subject/mode"
            )
            return
        if mode == "auto":
            state["profile_overrides"].pop(subject, None)
        else:
            state["profile_overrides"][subject] = mode
        logger.info(f"Session {client_id[:8]}: profile override {subject} -> {mode}")

    def set_tracking(self, client_id: str, active: bool) -> None:
        state = self._client_state.get(client_id)
        if state is None:
            return
        state["tracking"] = bool(active)
        if not active:
            for k in ("yaw_pd", "alt_pd", "dist_pd"):
                state[k].reset()
            state["smoother"].reset()
            state["height_ema"] = None
            state["elevate"] = None
            # A held nudge would otherwise still be commanding vertical motion
            # the next time Follow arms.
            state["altitude_nudge_v"] = 0.0
            state["altitude_floor_reason"] = None
        logger.info(
            f"Session {client_id[:8]}: vehicle tracking "
            f"{'STARTED' if active else 'STOPPED'}"
        )

    # ── Durable vehicle identity ──────────────────────────────────────────

    def _new_vehicle_id(self, state: Dict[str, Any]) -> str:
        state["vehicle_id_seq"] += 1
        return f"{_VEHICLE_ID_PREFIX}-{state['vehicle_id_seq']:06d}"

    def _register_plate(self, state: Dict[str, Any], vehicle: "_Vehicle") -> None:
        """
        Attach the durable identity a plate reading implies.

        If this exact plate was already seen this session under a different
        vehicle_id, that earlier sighting's track fragmented and came back —
        re-attach the earlier identity rather than minting a new one. That is
        what stops one car being counted as three because it passed behind a
        bus twice.
        """
        registry = state["plate_registry"]
        existing = registry.get(vehicle.plate)
        if existing and existing != vehicle.vehicle_id:
            logger.info(
                f"vehicle #{vehicle.track_id}: plate {vehicle.plate} matches "
                f"{existing} — re-identified as the same vehicle "
                f"(was {vehicle.vehicle_id})"
            )
            vehicle.vehicle_id = existing
        else:
            registry[vehicle.plate] = vehicle.vehicle_id

    # ── Plate OCR, on a budget ────────────────────────────────────────────

    def _ocr_candidates(self, state, vehicles: List[_Vehicle],
                        budget: int) -> List[_Vehicle]:
        """
        Which vehicles get this frame's OCR calls.

        Priority: the locked vehicle first (its plate is the identity that
        survives a track id change), then largest-first among those still
        needing a read. Rotated by a cursor so a permanently unreadable vehicle
        at the front cannot starve the rest.

        `budget` is the number of calls the active profile allows this frame —
        0 when the optics cannot resolve a plate at this range, in which case
        the whole cost is reclaimed rather than spent inventing readings.
        """
        if budget <= 0:
            return []
        need = [
            v for v in vehicles
            if v.needs_ocr and min(v.box[2] - v.box[0], v.box[3] - v.box[1]) >= 0
            and (v.box[2] - v.box[0]) >= _OCR_MIN_VEHICLE_PX
        ]
        if not need:
            return []
        need.sort(key=lambda v: v.area, reverse=True)

        locked_id = state.get("locked_track_id")
        front = [v for v in need if v.track_id == locked_id]
        rest = [v for v in need if v.track_id != locked_id]
        if rest:
            cur = state["ocr_cursor"] % len(rest)
            rest = rest[cur:] + rest[:cur]
            state["ocr_cursor"] = (cur + 1) % max(1, len(rest))
        return (front + rest)[:budget]

    def _read_plate(self, frame_bgr, vehicle: _Vehicle, state) -> None:
        """
        Run ALPR on this vehicle's crop and keep the reading if it beats what we
        already had.

        The crop is why this works at all — see the module docstring. Padded
        slightly because a vehicle box often clips the bumper the plate sits on.
        """
        if self.alpr is None:
            return
        h, w = frame_bgr.shape[:2]
        x1, y1, x2, y2 = vehicle.box
        pw, ph = int((x2 - x1) * 0.08), int((y2 - y1) * 0.08)
        cx1, cy1 = max(0, x1 - pw), max(0, y1 - ph)
        cx2, cy2 = min(w, x2 + pw), min(h, y2 + ph)
        crop = frame_bgr[cy1:cy2, cx1:cx2]
        if crop.size == 0 or crop.shape[0] < 32 or crop.shape[1] < 32:
            return

        vehicle.ocr_attempts += 1
        try:
            results = self.alpr.predict(crop)
        except Exception as e:
            logger.debug(f"ALPR failed on vehicle #{vehicle.track_id}: {e}")
            return

        for r in results:
            box = getattr(r.detection, "bounding_box", None)
            if box is None or r.ocr is None:
                continue

            # ── Gate 1: is this even plate-shaped and big enough to read? ──
            pw = int(box.x2) - int(box.x1)
            ph = max(1, int(box.y2) - int(box.y1))
            if pw < _PLATE_MIN_WIDTH_PX:
                # The important one. At 40-50px OCR does not fail, it invents.
                logger.debug(
                    f"vehicle #{vehicle.track_id}: plate candidate {pw}x{ph}px "
                    f"below the {_PLATE_MIN_WIDTH_PX}px readable floor — ignored"
                )
                continue
            aspect = pw / ph
            if not (_PLATE_ASPECT_MIN <= aspect <= _PLATE_ASPECT_MAX):
                continue

            raw_conf = getattr(r.ocr, "confidence", 0.0)
            conf = (float(sum(raw_conf) / len(raw_conf))
                    if isinstance(raw_conf, list) and raw_conf else float(raw_conf or 0.0))
            if conf < _OCR_MIN_CONF:
                continue

            # ── Gate 2: does it look like a plate at all? ─────────────────
            raw = getattr(r.ocr, "text", "") or ""
            text = _validate_and_correct(raw)
            if not text:
                continue
            grammar_ok = bool(_INDIA_PLATE_RE.match(text))

            # ── Gate 3: has any other frame agreed? ───────────────────────
            if text == vehicle.plate:
                vehicle.plate_votes += 1
            elif conf > vehicle.plate_conf or not vehicle.plate:
                # A different string. Start it at one vote rather than
                # inheriting the old one's — that inheritance is what let five
                # different readings look like a settled answer.
                vehicle.plate = text
                vehicle.plate_votes = 1
                vehicle.plate_confirmed = False
            else:
                continue

            vehicle.plate_conf = max(vehicle.plate_conf, conf)
            vehicle.plate_grammar_ok = grammar_ok
            # Back to full-frame coordinates so the overlay draws in the right
            # place — the crop's origin has to be added back.
            vehicle.plate_box = [
                int(box.x1) + cx1, int(box.y1) + cy1,
                int(box.x2) + cx1, int(box.y2) + cy1,
            ]

            just_confirmed = (
                not vehicle.plate_confirmed
                and vehicle.plate_votes >= _PLATE_MIN_AGREEING_READS
                and grammar_ok
            )
            if just_confirmed:
                vehicle.plate_confirmed = True
                # A confirmed plate is the only evidence strong enough to merge
                # two track ids into one vehicle, so identity is attached here
                # rather than on any provisional read.
                self._register_plate(state, vehicle)
                logger.info(
                    f"vehicle #{vehicle.track_id}: plate {text} confirmed "
                    f"({vehicle.plate_votes} agreeing reads, conf={conf:.2f}, "
                    f"{pw}x{ph}px)"
                )
                self._save_evidence(frame_bgr, crop, box, vehicle, state)

    # ── Face recognition, borrowed from person_tracker's gallery ──────────

    def set_gallery(self, gallery) -> None:
        """Install the enrolled-face index (worker_pool calls this at session
        start). Shared across clients and replaced wholesale, never mutated, so
        the worker thread never reads a half-built index."""
        self._gallery = gallery
        if gallery is not None and not gallery.is_empty():
            logger.info(
                f"TrafficManager: face gallery installed — {gallery.size} face(s), "
                f"{gallery.person_count} person(s)"
            )

    def _identify_faces(self, frame_bgr, people: List[dict], state,
                        attempt: bool = True) -> Dict[int, dict]:
        """
        Name enrolled people among the detected persons.

        Same three properties as person_tracker, for the same reasons:

          * CROPS, not a downscaled whole frame — ~2x the face pixels, and
            recognition is resolution-starved at any drone standoff.
          * VOTES before publishing a name — one blurred frame produces a
            confident wrong name otherwise, and a wrong name looks exactly like
            a right one.
          * The name lives on the TRACK, so it survives the many frames where a
            face is turned away, rather than flickering.
        """
        gallery = getattr(self, "_gallery", None)
        if gallery is None or gallery.is_empty() or self.face_app is None:
            return {}

        now = time.monotonic()
        # `attempt` is the active profile's verdict: at any range where a face
        # is a handful of pixels the model cannot succeed, so running it is
        # pure cost. Names already earned are still reported for as long as
        # their track lives — they were established when the face WAS
        # resolvable, and dropping them on a climb would erase a good
        # identification rather than decline to make a new one.
        if not attempt or (now - state.get("last_face_check_t", 0.0)) < _FACE_CHECK_INTERVAL_S:
            live = {p["track_id"] for p in people}
            return {t: e for t, e in state["face_identities"].items()
                    if e["confirmed"] and t in live}
        state["last_face_check_t"] = now

        registry = state["face_identities"]
        h, w = frame_bgr.shape[:2]
        # Largest first: nearest people are the only ones whose faces carry
        # enough pixels to recognise.
        for person in sorted(
            people, key=lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]),
            reverse=True,
        )[:_FACE_CROP_MAX_PEOPLE]:
            x1, y1, x2, y2 = person["box"]
            bw, bh = x2 - x1, y2 - y1
            if bw < 24 or bh < 48:
                continue
            px, py = int(bw * 0.18), int(bh * 0.12)
            crop = frame_bgr[max(0, y1 - py):min(h, y2 + py),
                             max(0, x1 - px):min(w, x2 + px)]
            if crop.size == 0 or crop.shape[0] < 32 or crop.shape[1] < 32:
                continue
            try:
                faces = self.face_app.get(crop)
            except Exception:
                continue

            tid = person["track_id"]
            for face in faces:
                emb = np.asarray(face.embedding, dtype=np.float32).copy()
                n = float(np.linalg.norm(emb))
                if n <= 0:
                    continue
                emb /= n
                match = gallery.match(emb, threshold=_FACE_VOTE_THRESHOLD)
                if match is None:
                    continue

                entry = registry.get(tid)
                if entry is None or entry["person_id"] != match.person_id:
                    marg = gallery.margin(emb)
                    # Strong and unambiguous evidence needs no second opinion;
                    # making a confident identification wait is pure latency.
                    instant = (match.similarity >= _FACE_CONFIRM_NOW
                               and (marg is None or marg >= 0.12))
                    registry[tid] = {
                        "person_id": match.person_id, "name": match.name,
                        "votes": _FACE_MIN_VOTES if instant else 1,
                        "best_sim": float(match.similarity),
                        "last_sim": float(match.similarity),
                        "margin": marg, "last_seen": now, "confirmed": instant,
                    }
                    if instant:
                        logger.info(
                            f"Traffic: identified track #{tid} as {match.name} "
                            f"(sim={match.similarity:.3f}) — confirmed immediately"
                        )
                else:
                    entry["votes"] = min(entry["votes"] + 1, 6)
                    entry["best_sim"] = max(entry["best_sim"], float(match.similarity))
                    entry["last_sim"] = float(match.similarity)
                    entry["last_seen"] = now
                    if entry["votes"] >= _FACE_MIN_VOTES and not entry["confirmed"]:
                        entry["confirmed"] = True
                        logger.info(
                            f"Traffic: identified track #{tid} as {entry['name']} "
                            f"({entry['votes']} agreeing reads)"
                        )
                break       # one face per body

        live = {p["track_id"] for p in people}
        for tid in list(registry):
            if tid not in live and (now - registry[tid]["last_seen"]) > _FACE_ID_MEMORY_S:
                registry.pop(tid, None)
        return {t: e for t, e in registry.items() if e["confirmed"] and t in live}

    def _save_evidence(self, frame_bgr, crop, box, vehicle: _Vehicle, state) -> None:
        """
        Write BOTH images for a confirmed plate: the plate crop and the whole
        vehicle.

        Two changes from the first version, both from reviewing what it actually
        produced:

        * THE VEHICLE IMAGE IS SAVED TOO. A 45x13 plate crop on its own is
          unreviewable — you cannot tell whether it is a plate, a badge, or a
          "SUBSCRIBE" overlay. The vehicle shot is what makes a record
          checkable by a human afterwards.
        * FILENAMES USE THE TRACK ID, NOT THE OCR TEXT. Naming the file after
          the reading meant a fabricated string became a fabricated filename —
          which is precisely what "I only see made-up name codes" was looking
          at. The plate text belongs in the database row, where it sits next to
          its confidence.
        """
        stamp = datetime.now(timezone.utc).strftime("%H%M%S")
        base = f"v{vehicle.track_id:05d}_{stamp}"

        plate_crop = crop[max(0, int(box.y1)):int(box.y2),
                          max(0, int(box.x1)):int(box.x2)]
        if plate_crop.size:
            path = os.path.join(state["capture_dir"], f"{base}_plate.jpg")
            cv2.imwrite(path, plate_crop)
            vehicle.crop_path = path

        x1, y1, x2, y2 = vehicle.box
        h, w = frame_bgr.shape[:2]
        veh = frame_bgr[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
        if veh.size:
            path = os.path.join(state["capture_dir"], f"{base}_vehicle.jpg")
            cv2.imwrite(path, veh)
            vehicle.vehicle_path = path

    # ── Analysis ──────────────────────────────────────────────────────────

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        # ONE pass over people and vehicles. Detection is the most expensive
        # per-frame item, so a second pass to get the other list would nearly
        # double this module's cost for no new information.
        results = self.model.track(
            frame_proc, classes=_DETECT_CLASSES, imgsz=self.imgsz_for(frame_proc),
            device=self.device, half=self.half, verbose=False, conf=0.35,
            persist=True, tracker=_TRACKER_CFG,
        )

        client_id = next(iter(self._client_state), None)
        state = self._client_state.get(client_id) if client_id else None
        if state is None:
            return frame_bgr, {}

        registry: Dict[int, _Vehicle] = state["vehicles"]
        now = time.time()
        in_frame: List[_Vehicle] = []
        people: List[dict] = []

        if results and results[0].boxes is not None and len(results[0].boxes):
            boxes = results[0].boxes
            ids = (boxes.id.int().cpu().numpy()
                   if boxes.id is not None else [None] * len(boxes))
            for box, tid in zip(boxes, ids):
                name = self.model.names[int(box.cls[0])]
                if tid is None:
                    continue
                bx = box.xyxy[0].cpu().numpy()
                full = [int(bx[0] * sx), int(bx[1] * sy),
                        int(bx[2] * sx), int(bx[3] * sy)]
                tid = int(tid)

                if name == "person":
                    people.append({"track_id": tid, "box": full,
                                   "conf": round(float(box.conf[0]), 2)})
                    state["person_ids_seen"].add(tid)
                    continue
                if name not in _VEHICLE_CLASSES:
                    continue

                v = registry.get(tid)
                if v is None:
                    v = _Vehicle(tid, full, name, self._new_vehicle_id(state))
                    registry[tid] = v
                    state["ids_seen"].add(tid)
                    state["type_counts"][name] = state["type_counts"].get(name, 0) + 1
                else:
                    v.box = full
                    v.type = name
                v.last_seen = now
                in_frame.append(v)

                # Colour: re-read only while it is still unconvincing, then
                # frozen — a vehicle entering frame is often half-occluded.
                if v.color_conf < _COLOUR_GOOD_ENOUGH:
                    col, cconf = classify_vehicle_color(frame_bgr, full)
                    if cconf > v.color_conf:
                        was_counted = v.color_conf >= _COLOUR_GOOD_ENOUGH
                        v.color, v.color_conf = col, cconf
                        if (not was_counted and cconf >= _COLOUR_GOOD_ENOUGH
                                and col != "unknown"):
                            state["color_counts"][col] = (
                                state["color_counts"].get(col, 0) + 1
                            )

        state["peak_in_frame"] = max(state["peak_in_frame"], len(in_frame))

        # ── Speed ─────────────────────────────────────────────────────────
        ctx = self.frame_context(client_id)
        pose = pose_from_telemetry(ctx.telemetry) if ctx else None
        if ctx is not None and pose is not None:
            cal = calibration.effective()
            speeds = state["speed"].update(
                frame_bgr,
                now=ctx.captured_at,
                vehicles=[{"track_id": v.track_id, "box": v.box, "type": v.type}
                          for v in in_frame],
                cam=camera_from_settings(W, H),
                pose=pose,
                scale_mode=cal["speed_scale_source"],
                max_disagreement_pct=cal["speed_scale_max_disagreement_pct"],
                vehicle_widths_m=get_settings().vehicle_widths_m,
            )
            for v in in_frame:
                r = speeds.get(v.track_id)
                if r is not None:
                    v.speed_kmh, v.speed_reliable = round(r.kmh, 1), r.reliable

        # ── What the optics can deliver right now ─────────────────────────
        # Computed BEFORE any optional analytic runs, because it decides which
        # of them run at all. See vision/profiles.py: the decision is in pixels
        # on target, so a sensor or lens change moves the usable ranges by
        # itself and there is no altitude constant to keep in step.
        via = self._viability(ctx, pose, W, H, frame_proc.shape[1])
        profile = state["profile"].select(
            via["viability"],
            overrides=state["profile_overrides"],
            alpr_available=self.alpr is not None,
            faces_available=self.face_app is not None,
            budget_ms=get_settings().traffic_optional_budget_ms,
        )

        # ── Plate OCR, on the profile's budget ────────────────────────────
        for v in self._ocr_candidates(state, in_frame, profile.ocr_calls):
            self._read_plate(frame_bgr, v, state)

        # ── Faces + crowd density ─────────────────────────────────────────
        identities = self._identify_faces(
            frame_bgr, people, state, attempt=profile.faces
        )
        state["peak_people"] = max(state["peak_people"], len(people))

        section_counts: Dict[int, int] = {}
        for pr in people:
            x1, y1, x2, y2 = pr["box"]
            sec = _section_of((x1 + x2) // 2, (y1 + y2) // 2, W, H)
            section_counts[sec] = section_counts.get(sec, 0) + 1
        light_max = int(state.get("light_max", _DENSITY_LIGHT_MAX))
        moderate_max = int(state.get("moderate_max", _DENSITY_MODERATE_MAX))
        density = _density_level(len(people), light_max, moderate_max)

        if now - state.get("last_history_t", 0.0) >= _HISTORY_INTERVAL_S:
            state["last_history_t"] = now
            state["count_history"].append({"t": round(now, 1), "n": len(people)})
        hist = list(state["count_history"])
        # Rate of change over the last minute, people/min — the headline number
        # for "is this building". A steady 200 and a 200 that was 120 a minute
        # ago read identically from a live count and are entirely different
        # situations.
        trend_per_min = None
        if len(hist) >= 2:
            recent = [h for h in hist if now - h["t"] <= 60.0] or hist[-2:]
            span = recent[-1]["t"] - recent[0]["t"]
            if span > 1.0:
                trend_per_min = round(
                    (recent[-1]["n"] - recent[0]["n"]) * 60.0 / span, 1
                )

        # ── Follow ────────────────────────────────────────────────────────
        drone_command = self._follow(
            state, in_frame, people, client_id, W, H, ctx, pose
        )

        # ── Persist + retire ──────────────────────────────────────────────
        pending_db: List[dict] = []
        for tid, v in list(registry.items()):
            if now - v.last_seen < _LOCK_LOST_AFTER_S:
                continue
            # Only a CONFIRMED, grammar-valid plate is written. A provisional
            # read is shown live but never becomes a permanent record — that is
            # how SUBSCRIBE ended up in the database.
            if v.reportable_plate and not v.logged:
                v.logged = True
                pending_db.append({
                    "table": "plate_event",
                    "track_id": v.track_id,
                    "vehicle_id": v.vehicle_id or None,
                    "plate_text": v.reportable_plate,
                    "ocr_confidence": v.plate_conf,
                    "vehicle_type": v.type or "unknown",
                    "vehicle_color": v.color or "",
                    "vehicle_color_conf": v.color_conf,
                    "vehicle_box": v.box,
                    "plate_box": v.plate_box,
                    # The plate crop; the vehicle shot sits beside it on disk
                    # so a record can be checked by a human.
                    "image_path": v.crop_path,
                    # Only a reliable estimate is written to a permanent row.
                    "speed_est_kmh": v.speed_kmh if v.speed_reliable else None,
                })
            registry.pop(tid, None)

        locked_id = state.get("locked_track_id")
        seen_t = state.get("last_seen_t", 0.0)
        lost_s = (time.monotonic() - seen_t) if seen_t else 0.0
        lock, lock_msg = lock_state_for(
            visible=any(v.track_id == locked_id for v in in_frame),
            seconds_lost=lost_s,
            tracking=state.get("tracking", False) or locked_id is not None,
        )

        meta: Dict[str, Any] = {
            "vehicles": [
                {
                    "track_id": v.track_id,
                    "vehicle_id": v.vehicle_id or None,
                    "box": v.box,
                    "type": v.type,
                    "color": v.color or "unknown",
                    "color_conf": round(v.color_conf, 2),
                    # Confirmed vs provisional are separate fields so the
                    # overlay can show a read in progress WITHOUT it looking
                    # like a result.
                    "plate": v.reportable_plate,
                    "plate_provisional": (v.plate or None) if not v.reportable_plate else None,
                    "plate_conf": round(v.plate_conf, 2),
                    "plate_votes": v.plate_votes,
                    "plate_box": v.plate_box,
                    "speed_kmh": v.speed_kmh,
                    "speed_reliable": v.speed_reliable,
                    "locked": v.track_id == locked_id,
                }
                for v in sorted(in_frame, key=lambda x: x.area, reverse=True)
            ],
            "vehicles_in_frame": len(in_frame),
            "vehicle_count_unique": len(state["ids_seen"]),
            "peak_vehicles": state["peak_in_frame"],
            "vehicle_types": dict(state["type_counts"]),
            "vehicle_colors": dict(state["color_counts"]),
            "plates_read": sum(1 for v in registry.values() if v.reportable_plate),
            # ── People / crowd, borrowed from crowd_manager ───────────────
            "people": [{"id": pr["track_id"], "box": pr["box"]} for pr in people],
            "person_count": len(people),
            # Unique across the session vs in frame now — reported separately
            # because they answer different questions, and conflating them is
            # how headcount figures become fiction.
            "person_count_unique": len(state["person_ids_seen"]),
            "peak_count": state["peak_people"],
            "density_level": density,
            "section_counts": section_counts,
            "section_grid": [_GRID_ROWS, _GRID_COLS],
            "light_max": light_max,
            "moderate_max": moderate_max,
            "zone_names": dict(state.get("zone_names", {})),
            "count_history": hist,
            "trend_per_min": trend_per_min,
            # ── Faces, borrowed from person_tracker's gallery ─────────────
            "identities": [
                {
                    "track_id": tid, "person_id": e["person_id"], "name": e["name"],
                    "similarity": round(e["last_sim"], 3),
                    "best_similarity": round(e["best_sim"], 3),
                    "votes": e["votes"],
                    "margin": (round(e["margin"], 3)
                               if e.get("margin") is not None else None),
                }
                for tid, e in identities.items()
            ],
            "identified_count": len(identities),
            "faces_available": self.face_app is not None,
            "gallery_size": (self._gallery.person_count
                             if getattr(self, "_gallery", None) else 0),
            # Follow state
            "locked_track_id": locked_id,
            # Which kind was locked — the panel labels and the hold-distance
            # control both depend on it, and a person lock must not be
            # described as a vehicle.
            "locked_kind": state.get("locked_kind"),
            "locked_plate": state.get("locked_plate") or None,
            "target_distance_ratio": state["size_ratio"].get(
                state.get("locked_kind") or "vehicle", _DEFAULT_SIZE_RATIO
            ),
            "altitude_mode": state.get("altitude_mode", "auto"),
            # What the subject is ACTUALLY filling, in the same units as the
            # target. Shown together with it because "the drone only moves
            # backward" is indistinguishable from "this target is unreachable
            # at this range" unless both numbers are visible at once.
            "subject_fill_pct": (round(state["height_ema"] * 100.0, 1)
                                 if state.get("height_ema") is not None else None),
            # Why the floor is holding altitude, when it is. Silence here was
            # what made the SITL descent impossible to see coming.
            "altitude_floor_reason": state.get("altitude_floor_reason"),
            "tracking": state.get("tracking", False),
            "lock_state": lock.value,
            "lock_message": lock_msg,
            "seconds_lost": round(lost_s, 1),
            "elevate": state.get("elevate"),
            "drone_command": drone_command,
            # Honest about what speed is, everywhere it travels.
            "speed_is_estimate": True,
            "has_telemetry": pose is not None,
            "alpr_available": self.alpr is not None,
            # What this altitude can actually resolve. Without it a refused
            # plate read is indistinguishable from a broken plate reader — see
            # vision/viability.py.
            **via,
            # What was ATTEMPTED and why — the counterpart to viability, which
            # says only what is resolvable. Without this a skipped plate read is
            # indistinguishable from a failed one.
            "profile": profile.to_dict(),
        }
        if pending_db:
            meta["_pending_db"] = pending_db
        return frame_bgr, meta

    def _viability(self, ctx, pose, W: int, H: int, det_w: int) -> dict:
        """
        Which subjects the current altitude can resolve.

        Uses the SLANT RANGE to frame centre rather than the altitude, because
        that is the distance a subject in the middle of frame actually sits at —
        at a 45 degree mount they differ by a factor of 1.4.

        Effective widths differ per subject and matter: detection runs on a
        downscaled copy while plate OCR runs on a native-resolution crop, so
        using the frame width for everything would overstate detection and
        understate plate reading — the two errors that mislead most here.
        """
        cal = calibration.effective()
        slant = None
        if pose is not None:
            projected = pose.project_to_ground(
                camera_from_settings(ctx.width or W, ctx.height or H) if ctx
                else camera_from_settings(W, H),
                W / 2.0, H / 2.0,
            )
            if projected is not None:
                slant = projected[2]
        widths = {
            # det_w is the width of the array actually handed to YOLO, NOT
            # self.inference_width. The latter is a BUDGET, not a measurement:
            # it is 0 when the mode runs native, and it overstates the case
            # where a frame is already narrower than the target and gets passed
            # through unresized. Forwarding the 0 divided by zero in
            # range_for_px — inside the worker thread, so the mode emitted no
            # metadata at all while video kept streaming.
            "vehicle": det_w,
            "person": det_w,
            # Both run on per-subject crops at native resolution.
            "plate": W,
            "face": W,
        }
        items = viability.assess(
            cal["camera_hfov_deg"], W, slant, effective_width_px=widths
        )
        summary = viability.summarise(items)
        return {
            "slant_range_m": round(slant, 1) if slant else None,
            "viability": summary["subjects"],
            "viable_subjects": summary["usable"],
            "viability_headline": summary["headline"],
        }

    # ── Follow control ────────────────────────────────────────────────────

    def _follow(self, state, in_frame, people, client_id, W, H, ctx, pose):
        """
        Keep a locked subject framed — vehicle or person. Same three-axis PD
        shape as human_tracker (yaw primary, distance via apparent size,
        altitude secondary) plus the auto-elevate fallback when the subject
        outruns us.

        Both kinds resolve out of one id space: people and vehicles come from
        the same ByteTrack pass, so a track id identifies exactly one subject
        and this does not need to be told which kind was clicked.
        """
        def _find(tid):
            """(kind, box, vehicle_or_None) for a track id, or None."""
            for v in in_frame:
                if v.track_id == tid:
                    return "vehicle", v.box, v
            for p in people:
                if p["track_id"] == tid:
                    return "person", p["box"], None
            return None

        # An operator request takes effect as soon as that subject is in frame.
        wanted = state.get("follow_request_track_id")
        if wanted is not None:
            found = _find(wanted)
            if found is not None:
                kind, _, v = found
                state["locked_track_id"] = wanted
                state["locked_kind"] = kind
                state["follow_request_track_id"] = None
                state["kalman"].reset()
                state["height_ema"] = None
                state["locked_plate"] = (v.plate or "") if v is not None else ""
                logger.info(
                    f"Session {client_id[:8]}: locked {kind} #{wanted}"
                    + (f" ({v.plate})" if v is not None and v.plate else "")
                )

        locked_id = state.get("locked_track_id")
        if locked_id is None:
            state["elevate"] = None
            return None

        found = _find(locked_id)
        if found is None:
            state["frames_lost"] = state.get("frames_lost", 0) + 1
            # The plate is the identity that survives a track id change, so it
            # is kept rather than cleared — a re-read of the same characters is
            # the same vehicle, not a guess.
            return None

        kind, box, target = found
        state["locked_kind"] = kind
        state["frames_lost"] = 0
        state["last_seen_t"] = time.monotonic()
        if target is not None and target.plate and not state.get("locked_plate"):
            state["locked_plate"] = target.plate

        if not state.get("tracking"):
            state["elevate"] = None
            return None

        x1, y1, x2, y2 = box
        cx_n, cy_n = (x1 + x2) / (2 * W), (y1 + y2) / (2 * H)
        fx_n, fy_n = state["kalman"].update(cx_n, cy_n)

        h_raw = (y2 - y1) / H
        prev = state["height_ema"]
        h_ema = h_raw if prev is None else (
            _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev
        )
        state["height_ema"] = h_ema

        target_ratio = state["size_ratio"].get(
            kind, _DEFAULT_SIZE_RATIO if kind == "vehicle"
            else _DEFAULT_PERSON_SIZE_RATIO
        )
        err_yaw = fx_n - 0.5
        err_alt = fy_n - 0.5
        err_dist = target_ratio - h_ema

        yaw_deg_s = state["yaw_pd"].compute(err_yaw)
        # Fixed holds the altitude Offboard started at, so the only vertical
        # motion is whatever the operator is nudging. Auto lets the PD centre
        # the subject. Auto-elevate below overrides either.
        if state.get("altitude_mode") == "fixed":
            state["alt_pd"].reset()
            down_m_s = float(state.get("altitude_nudge_v") or 0.0)
        else:
            down_m_s = state["alt_pd"].compute(err_alt)

        yaw_factor = max(0.0, 1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
        if yaw_factor > 0.0:
            forward_m_s = state["dist_pd"].compute(err_dist) * yaw_factor
        else:
            state["dist_pd"].reset()
            forward_m_s = 0.0

        # Auto-elevate: only when the vehicle is genuinely pulling away, and
        # only inside both ceilings. Overrides the altitude axis because holding
        # the target in frame at all outranks holding it vertically centred.
        elevate = None
        if forward_m_s > 0:
            depression = None
            if pose is not None and ctx is not None:
                cam = camera_from_settings(ctx.width or W, ctx.height or H)
                depression = pose.depression_deg(cam, W / 2.0, H / 2.0)
            limits = PursuitLimits.from_settings()
            elevate = decide_elevation(
                target_outpacing=is_outpaced(
                    forward_m_s, MAX_PURSUIT_SPEED_M_S, limits,
                    target_growing_distance=err_dist > 0.01,
                ),
                agl_m=pose.agl_m if pose else None,
                depression_deg=depression,
                limits=limits,
            )
            if elevate.elevating:
                down_m_s = elevate.climb_m_s
        state["elevate"] = elevate.to_dict() if elevate else None

        # THE ALTITUDE FLOOR. Last thing before the command is emitted, so it
        # catches every source of descent — the altitude PD, an operator nudge,
        # anything added later — rather than each of them separately.
        #
        # This module was the ONLY follow-capable one without it: the other
        # five gained the guard after an unguarded descent flew a SITL aircraft
        # into the ground (+0.5 m/s held for 12s, 6.6m to 0m, ending in
        # "invalid setpoints / blind land"). The same code path existed here
        # untouched. See pursuit.limit_descent.
        down_m_s, floor_reason = limit_descent(
            down_m_s, pose.agl_m if pose else None, PursuitLimits.from_settings()
        )
        state["altitude_floor_reason"] = floor_reason

        cmd = state["smoother"].smooth({
            "type": "velocity",
            "forward_m_s": forward_m_s,
            "right_m_s": 0.0,
            "down_m_s": down_m_s,
            "yaw_deg_s": yaw_deg_s,
        })
        return {
            "type": "velocity",
            "forward_m_s": round(cmd["forward_m_s"], 3),
            "right_m_s": 0.0,
            "down_m_s": round(cmd["down_m_s"], 3),
            "yaw_deg_s": round(cmd["yaw_deg_s"], 2),
        }

    # ── Overlay ───────────────────────────────────────────────────────────

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]

        # ── Crowd grid, always visible ────────────────────────────────────
        # Drawn unconditionally rather than only once people occupy two cells:
        # "which zone is busiest" is the reason a grid exists, and a density map
        # that appears only after the crowd has spread out is no use.
        rows, cols = meta.get("section_grid", [_GRID_ROWS, _GRID_COLS])
        section_counts = meta.get("section_counts", {}) or {}
        if meta.get("person_count"):
            cell_w, cell_h = W // cols, H // rows
            for r in range(rows):
                for c in range(cols):
                    idx = r * cols + c
                    cnt = section_counts.get(idx, section_counts.get(str(idx), 0))
                    x1, y1 = c * cell_w, r * cell_h
                    x2 = W if c == cols - 1 else (c + 1) * cell_w
                    y2 = H if r == rows - 1 else (r + 1) * cell_h
                    if not cnt:
                        draw_tint_rect(frame_bgr, x1, y1, x2, y2, (90, 90, 90), alpha=0.0)
                        continue
                    # Each zone's OWN density, so a packed corner reads red even
                    # when the frame overall is quiet.
                    lvl = _density_level(cnt)
                    col = {"green": (0, 200, 0), "orange": (0, 165, 255),
                           "red": (0, 0, 230)}[lvl]
                    draw_tint_rect(frame_bgr, x1, y1, x2, y2, col, alpha=0.10)
                    draw_badge(frame_bgr, str(cnt), x1 + 6, y1 + 18, fg=col)

        # ── People, named where recognised ────────────────────────────────
        by_track = {i["track_id"]: i for i in meta.get("identities", [])}
        for pr in meta.get("people", []):
            x1, y1, x2, y2 = pr["box"]
            ident = by_track.get(pr["id"])
            if ident:
                draw_ring(frame_bgr, x1, y1, x2, y2, (153, 211, 52), 3)
                draw_badge(
                    frame_bgr,
                    f"{ident['name'].upper()}  {ident['similarity']:.2f}",
                    x1, max(16, y1 - 4), fg=(220, 120, 170),
                )
            else:
                draw_ring(frame_bgr, x1, y1, x2, y2, (36, 191, 251), 2)

        for v in meta.get("vehicles", []):
            x1, y1, x2, y2 = v["box"]
            locked = v.get("locked")
            color = (200, 220, 50) if locked else (170, 170, 170)
            draw_ring(frame_bgr, x1, y1, x2, y2, color, 3 if locked else 2)

            # Build the label from what is actually known, so a vehicle with no
            # plate still reads usefully instead of showing an empty field.
            bits = []
            if v.get("color") not in (None, "unknown") and v.get("color_conf", 0) >= 0.35:
                bits.append(v["color"])
            bits.append(v["type"])
            label = " ".join(bits)
            if v.get("plate"):
                label = f"{v['plate']}  {label}"
            kmh = v.get("speed_kmh")
            if kmh is not None:
                # "~" and a trailing "?" are load-bearing: a ground-sample
                # estimate must not look like a calibrated reading.
                label += f"  ~{kmh:.0f}km/h" + ("" if v.get("speed_reliable") else "?")
            draw_badge(frame_bgr, label, x1, max(16, y1 - 4), fg=color)

            if v.get("plate_box"):
                px1, py1, px2, py2 = v["plate_box"]
                draw_ring(frame_bgr, px1, py1, px2, py2, (0, 200, 0), 2, radius=5)

        draw_badge(
            frame_bgr,
            f"{meta.get('vehicles_in_frame', 0)} veh / "
            f"{meta.get('person_count', 0)} ppl / "
            f"{meta.get('plates_read', 0)} plates",
            12, 28, fg=(220, 220, 90),
        )
        y = 52
        # Naming what the altitude cannot resolve is the difference between "the
        # plate reader is broken" and "descend to read plates".
        headline = meta.get("viability_headline")
        if headline:
            draw_badge(frame_bgr, headline[:78], 12, y, fg=(0, 165, 255))
            y += 24
        if not meta.get("has_telemetry"):
            draw_badge(frame_bgr, "no telemetry - speed unavailable",
                       12, y, fg=(0, 165, 255))
        return frame_bgr

"""
Vehicle / number-plate tracking — identify, tag, and follow ONE vehicle.
=========================================================================

Distinct from traffic-management (vision/modules/traffic_manager.py), which
is the composed module answering "how much traffic, how many people, who is
here". This module answers a narrower question: "find THIS vehicle, keep
everything known about it attached to one identity, and — if asked — fly
after it."

A CUSTOM VEHICLE IDENTITY, SEPARATE FROM ByteTrack's track_id
    ByteTrack ids are cheap and disposable — an occlusion, a missed detection
    frame, or the vehicle briefly leaving frame all mint a new one for the
    SAME physical car. That is fine for per-frame tracking but wrong for
    "this is vehicle #4302 we saw three minutes ago", which is what an
    operator actually wants out of an identification system.

    So every vehicle gets its own id ("VH-000001", ...) the moment it is
    first tracked, independent of track_id. If its plate later reads and
    matches a plate already seen this session under a DIFFERENT vehicle_id
    (the earlier sighting's track fragmented), the vehicle_id is re-attached
    to the earlier identity rather than minting a new one — the same
    "durable identity survives a track-id change" idea traffic_manager uses
    for locking, applied here to the identity itself.

ONE OCR CALL PER FRAME, ON A VEHICLE CROP
    fast-alpr letterboxes its input to 384x384, so a call costs the same
    whatever it is given. A plate on a 400px-wide vehicle is ~22px after a
    full-frame call letterboxes 1920 down to 384 — unreadable. The SAME call
    on the vehicle's own crop letterboxes 400 to 384 and yields ~107px.
    Reading plates from a full frame is close to impossible; this module
    always reads from a crop, budgeted at one call per frame and spent on
    whichever vehicle most needs it (locked first, then largest).

FOLLOW + AUTO-ELEVATE
    Clicking a vehicle locks it; a separate Follow command arms the flight
    behaviour, so locking and flying are two deliberate steps. While
    following, the drone tracks the vehicle down at whatever altitude and
    speed that takes — a plate is no longer needed once the whole vehicle is
    locked, so climbing to hold the car in frame does not cost the module
    anything it still needs. Uses the same three-axis PD shape and
    auto-elevate fallback as human_tracker/traffic_manager (see
    vision/pursuit.py for the ladder).

Registration/owner lookup is intentionally left as a documented no-op
extension hook, same as before: resolving a plate to an owner needs an
authorized RTO/DMV data source, not something to fabricate or scrape.

Like the other analyzer modules, this runs in BaseAnalyzer's worker thread —
DB writes are queued onto meta["_pending_db"] for stream_track.py's recv()
(back in the event loop) to actually dispatch.
"""
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.config import ROOT_DIR, get_settings
from app.vision import calibration
from app.vision.base import BaseAnalyzer
from app.vision.controllers import (
    KalmanXY, PDController, VelocitySmoother, range_error_ratio,
)
from app.vision.drawing import draw_badge, draw_ring
from app.vision.geometry import (
    camera_from_settings, deforeshorten_size, pose_from_telemetry,
)
from app.vision.pursuit import (
    PursuitLimits, ROW_NUDGE_STEP, blind_command, clamp_row_target,
    decide_elevation, distance_axis, foot_row, is_outpaced, limit_climb,
    limit_descent, lock_state_for, new_row_pd, row_reference_is_stale,
    scale_forward, seconds_lost_for,
)
from app.vision.speed import SpeedEstimator
from app.vision.tracker_config import make_bytetrack_cfg
from app.vision.vehicle_color import classify_vehicle_color

logger = logging.getLogger("verocore.vision.plate_tracker")

try:
    from fast_alpr import ALPR
except ImportError:  # pragma: no cover — dependency declared in pyproject
    ALPR = None

# Every road user the COCO model can actually name. bicycle and train were
# missing, so a cyclist simply did not exist to this module — no id, no row,
# and nothing to lock onto.
#
# What COCO CANNOT give us is worth stating plainly: there is no class for an
# auto-rickshaw, tractor, or tempo. Those are detected, but reported as
# whichever of the classes below the model finds nearest — usually "car" or
# "truck". The vehicle_id, colour, speed and plate are all still correct; only
# the type label is approximate. Naming them properly needs a model trained on
# them, not a longer list here.
_VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle", "train"}
# COCO indices: 1 bicycle, 2 car, 3 motorcycle, 5 bus, 6 train, 7 truck.
# Filtered at the detector call itself, not after — cheaper than running the
# head over every COCO class and discarding what is not a vehicle.
_VEHICLE_CLASS_IDS = [1, 2, 3, 5, 6, 7]

_VEHICLE_TRACKER_CFG = make_bytetrack_cfg("verocore_veh_")

# ── OCR: recall first, quality recorded rather than enforced ────────────────
#
# EVERY vehicle in frame gets its own fast-alpr call, plus one whole-frame
# call, on every analysed frame. No per-frame call budget, no size
# pre-filter, no give-up counter. Compute is deliberately not the constraint
# for this mode.
#
# The whole-frame call is not redundant with the crops: it catches plates
# whose vehicle YOLO missed entirely (common at range, and a lit plate is
# often the highest-contrast thing in the scene). The crops are not redundant
# with the whole-frame call either: fast-alpr letterboxes its input to
# 384x384, so a plate on a 400px vehicle survives a crop call at ~107px but
# arrives at ~22px once a 1920-wide frame is letterboxed. Running both is
# what produces the most reads.
#
# WHY THE HARD QUALITY GATES ARE GONE
# A previous version gated reads on a 70px minimum plate width, a 1.6-6.0
# aspect band, agreement across two frames, AND a match against the Indian
# plate grammar. Measured against what this rig actually captures, every one
# of those was wrong:
#
#     plates arrive 31-79px wide  ->  the 70px floor rejected 22 of 25
#     they are not Indian-format  ->  the grammar gate rejected 25 of 25
#                                     (a real, correct read: "719257C")
#     OCR wobbles by a character  ->  exact two-frame agreement rarely held
#
# Together they rejected effectively everything: no image was saved and no
# row reached the database for an entire session. A gate strict enough to
# guarantee a perfect read discards every imperfect one, and at drone
# standoff every read is imperfect.
#
# So quality is RECORDED, not enforced. Each reading carries its confidence,
# its pixel width, how many frames agreed, and whether it matches a known
# plate grammar. The UI tones a weak read differently and the CSV carries the
# numbers — which lets a human judge a reading, instead of this module
# silently deciding on their behalf that it never happened.
_OCR_MIN_CONF = 0.35
# The only size floor, and it rejects specks rather than small plates: a
# 40x18px plate is 720, comfortably above this.
_MIN_PLATE_AREA = 500
# Agreement is COUNTED and surfaced, never required. Two independent frames
# producing identical characters is strong evidence; one frame is weaker
# evidence, not an absence of evidence.
_PLATE_AGREEMENT_STRONG = 2
# Overlap needed to call two plate boxes on consecutive frames the same
# plate, for readings YOLO gave us no vehicle box for. Loose (0.2, not the
# usual 0.5) because these boxes are small and move a long way frame to
# frame — the drone drifts and the vehicle moves — and fragmenting one plate
# into several identities is worse here than occasionally merging two.
_PLATE_ONLY_IOU = 0.2

# Colour is re-read while confidence is still poor (a vehicle entering frame
# is often half-occluded), then frozen.
_COLOUR_GOOD_ENOUGH = 0.55

# How long an out-of-frame vehicle is kept in the live registry before being
# retired (logged if it has a plate, then dropped). Separate from the
# pursuit lock's own "seconds lost" — this is about bookkeeping the vehicle
# record, not about whether the drone is still chasing it.
_VEHICLE_RETIRE_AFTER_S = 3.0

# ── Follow control ───────────────────────────────────────────────────────────
_DEFAULT_SIZE_RATIO = 0.22      # target vehicle height as a fraction of frame
_HEIGHT_EMA_ALPHA = 0.12
_YAW_PRIORITY_THRESHOLD = 0.30
# Forward authority never drops below this fraction, however far off
# boresight the vehicle sits. Without a floor, forward hits exactly zero well
# before the vehicle is anywhere near the frame edge — measured at ~20deg off
# axis — which spends most of a real chase yawing in place. See the note in
# _follow for the measurement.
_YAW_PRIORITY_FLOOR = 0.35
MAX_PURSUIT_SPEED_M_S = 2.5     # keep in step with dist_pd max_output

# PX4's Offboard mode requires a CONTINUOUS setpoint stream — MAVSDK's
# set_velocity_body sends exactly one MAVLink message per call, nothing
# repeats it on its own — and a gap past PX4's offboard-loss timeout hands
# control to PX4's own failsafe, whose default action (COM_OBL_ACT) on many
# airframes is LAND. So while tracking is armed, _follow must ALWAYS return a
# command, never None, even for the frames where the locked vehicle simply
# is not visible — those frames are routine here (a missed detection, an
# occlusion, the vehicle at the frame edge) in a way they are not for a
# continuous body track. What that command should BE is pursuit.blind_command:
# hold briefly, fade the translation out, sweep, then hover — never silence,
# and never a frozen full-speed command either.

_VEHICLE_ID_PREFIX = "VH"

_CAPTURE_ROOT = os.path.join(str(ROOT_DIR), ".data", "plate_captures")

# Common OCR confusions on plate-style fonts (applied only when the raw
# text doesn't already match the expected grammar).
_CONFUSION_MAP = str.maketrans({"O": "0", "I": "1", "S": "5", "B": "8"})
# Indian plate grammar: 2-letter state code, 1-2 digit RTO code, 1-3 letter
# series (optional), 4 digits — e.g. MH12AB1234, DL5CAB1234, TS09EA0001.
_INDIA_PLATE_RE = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$")


def fetch_registration_details(plate_text: str) -> dict:
    """
    Hook for looking up owner/registration info against an AUTHORIZED
    source (e.g. an RTO/Vahan integration, or a licensed vehicle-data
    API) — never wired to anything by default. Resolving a plate to an
    owner without that authorization is not something this codebase should
    fabricate or scrape. Left as a documented no-op; returns {} (=
    "not looked up / unavailable").
    """
    return {}


def _clean_plate_text(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


def _validate_and_correct(raw: str) -> str:
    """Cleans OCR output; if it doesn't match the Indian plate grammar,
    tries a digit/letter confusion correction before giving up. Never
    drops a reading outright — a non-matching but cleaned string is still
    returned (useful for non-Indian plates / partial reads)."""
    text = _clean_plate_text(raw)
    if not text:
        return ""
    if _INDIA_PLATE_RE.match(text):
        return text
    corrected = text.translate(_CONFUSION_MAP)
    return corrected if _INDIA_PLATE_RE.match(corrected) else text


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / float(area_a + area_b - inter)


class _Vehicle:
    """Everything known about one tracked vehicle, accumulated across frames
    and addressed by a persistent vehicle_id rather than the ByteTrack
    track_id it happens to hold right now.

    Plate and colour are kept on a BEST-CONFIDENCE basis rather than
    last-value: both peak on different frames as the vehicle turns, and the
    best read is the one worth keeping and logging.
    """
    __slots__ = (
        "track_id", "vehicle_id", "box", "type", "color", "color_conf",
        "plate", "plate_conf", "plate_box", "plate_px_w",
        "crop_path", "vehicle_path",
        "plate_votes", "plate_grammar_ok",
        "speed_kmh", "speed_reliable", "ocr_attempts",
        "first_seen", "last_seen", "logged",
    )

    def __init__(self, track_id: int, vehicle_id: str, box, vtype: str):
        self.track_id = track_id
        self.vehicle_id = vehicle_id
        self.box = box
        self.type = vtype
        self.color = ""
        self.color_conf = 0.0
        self.plate = ""
        self.plate_conf = 0.0
        self.plate_box: Optional[list] = None
        # Pixel width of the best read. The honest quality indicator, carried
        # all the way to the CSV so a reading can be judged after the fact.
        self.plate_px_w = 0
        self.crop_path: Optional[str] = None
        self.vehicle_path: Optional[str] = None
        # How many frames independently produced the CURRENT string. Surfaced
        # as evidence strength, not used to suppress the reading.
        self.plate_votes = 0
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
    def plate_strong(self) -> bool:
        """Whether the reading has independent corroboration. Drives how the
        UI tones it — never whether it is kept."""
        return bool(self.plate) and self.plate_votes >= _PLATE_AGREEMENT_STRONG


def _make_state(session_id: str) -> Dict[str, Any]:
    capture_dir = os.path.join(_CAPTURE_ROOT, session_id)
    os.makedirs(capture_dir, exist_ok=True)
    return {
        "capture_dir": capture_dir,
        "vehicles": {},              # track_id -> _Vehicle
        "vehicle_id_seq": 0,
        # plate text -> vehicle_id. What makes re-identification possible: a
        # track that fragments and comes back with the same plate is
        # recognised as the SAME vehicle rather than issued a new identity.
        "plate_registry": {},
        # Unique vehicles this session, by ByteTrack ID. A set, not a
        # counter, because IDs are revisited: the same car re-detected
        # after an occlusion must not count twice.
        "ids_seen": set(),
        "type_counts": {},
        "color_counts": {},
        "peak_in_frame": 0,
        "speed_note": None,
        # Effective calibration, not the raw .env default — an operator who
        # tuned the window in Settings expects it to apply.
        "speed": SpeedEstimator(calibration.effective()["speed_fit_window_frames"]),
        # Plates read where YOLO found no vehicle around them, tracked by
        # overlap on the plate box. Negative track ids, so they can never
        # collide with a ByteTrack id. See _unmatched_vehicle.
        "plate_only": {},
        "plate_only_seq": 0,
        # ── Follow ────────────────────────────────────────────────────────
        "locked_track_id": None,
        "locked_vehicle_id": None,
        "locked_plate": "",
        "follow_request_track_id": None,
        "tracking": False,
        "last_seen_t": 0.0,
        "frames_lost": 0,
        "height_ema": None,
        "elevate": None,
        # Operator-adjustable "hold here" distance, expressed as target vehicle
        # height / frame height. Was a hardcoded constant; made adjustable
        # because there is no altitude-independent right answer — see
        # set_tracking_params.
        "target_distance_ratio": _DEFAULT_SIZE_RATIO,
        # 'fixed' = hold the altitude Offboard started at; 'auto' = drive
        # altitude to keep the vehicle vertically centred. See _follow.
        "altitude_mode": "fixed",
        # m/s NED (-=up, +=down) from the operator's hold buttons. Fixed mode
        # only — auto mode owns the axis.
        "altitude_nudge_v": 0.0,
        # Keeps the Offboard setpoint stream alive across frames where the
        # locked vehicle is briefly not visible — see the Offboard-keepalive note.
        "last_drone_command": None,
        "last_yaw_dir": 1.0,
        "yaw_pd": PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        "alt_pd": PDController(kp=1.5, kd=0.3, max_output=1.0, deadband=0.10),
        # Units are FRACTION OF RANGE, not fill difference — see
        # controllers.range_error_ratio for why, and for the measured
        # dead zone this replaced (1.4m at 8.6m, 46m at 50m).
        "dist_pd": PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08),
        # The Fixed-altitude distance axis — see pursuit.new_row_pd.
        "row_pd": new_row_pd(),
        # Frame row Fixed mode holds the vehicle's ground contact on; None =
        # take it from the subject on the next frame.
        "target_row": None,
        "kalman": KalmanXY(),
        "smoother": VelocitySmoother(alpha=0.4),
    }


class PlateTracker(BaseAnalyzer):
    """
    Vehicle identity, plate, colour, type, speed, and follow — for whichever
    vehicles the drone sees, addressed by a persistent id rather than the raw
    tracker id.
    """

    MODE = "vehicle-plate-tracking"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        if ALPR is None:
            raise RuntimeError("fast-alpr not installed (add it to pyproject.toml)")
        settings = get_settings()
        self.device = settings.device
        self.half = self.device == "cuda"

        logger.info("Loading fast-alpr...")
        self.alpr = ALPR(
            detector_model="yolo-v9-t-384-license-plate-end2end",
            ocr_model="cct-xs-v2-global-model",
        )
        try:
            self.alpr.predict(np.zeros((384, 384, 3), dtype=np.uint8))
        except Exception as e:
            logger.warning(f"fast-alpr warm-up skipped: {e}")

        self.vehicle_model = YOLO(settings.default_yolo_model)
        self.vehicle_model.to(self.device)
        self.vehicle_model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.half, verbose=False,
        )

        self._client_state: Dict[str, Dict[str, Any]] = {}
        logger.info(f"✅ PlateTracker ready on {self.device.upper()}")

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state(client_id)

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        state = self._client_state.pop(client_id, None)
        if state is None:
            return
        # A vehicle in frame when the operator stops the session never gets
        # the chance to age out of the registry, so without this flush its row
        # — plate included — is silently discarded. That is exactly what "ran
        # a session, saw plates, nothing in the history afterward" looks like
        # from the outside.
        rows = [r for v in state["vehicles"].values()
                if (r := self._plate_event_row(v)) is not None]
        if not rows:
            return
        # Location has to be attached here too. The live path gets it in
        # stream_track.recv(), which is not involved once the session is
        # tearing down — so rows flushed here would otherwise be the only ones
        # missing lat/lng, which is worse than a consistent gap because it
        # looks like the GPS dropped out at the end of every flight.
        try:
            from app.sessions.manager import session_manager
            tel = session_manager.get_telemetry(client_id)
            pos = tel.snapshot.position if tel and tel.is_connected else None
            if pos is not None:
                for ev in rows:
                    ev.setdefault("lat", pos.latitude_deg)
                    ev.setdefault("lng", pos.longitude_deg)
                    ev.setdefault("alt_m", pos.relative_altitude_m)
        except Exception as e:
            logger.debug(f"No position for session-end plate flush: {e}")

        from app.vision.persistence import persist_events
        await persist_events(client_id, rows)
        logger.info(
            f"Session {client_id[:8]}: flushed {len(rows)} vehicle record(s) "
            f"still in frame at shutdown"
        )

    # ── Operator control ──────────────────────────────────────────────────

    def request_follow(self, client_id: str, track_id: Optional[int]) -> None:
        """Follow a specific vehicle, or None to release."""
        state = self._client_state.get(client_id)
        if state is None:
            return
        if track_id is None:
            state["follow_request_track_id"] = None
            state["locked_track_id"] = None
            state["locked_vehicle_id"] = None
            state["locked_plate"] = ""
            state["tracking"] = False
            logger.info(f"Session {client_id[:8]}: vehicle lock released")
            return
        state["follow_request_track_id"] = int(track_id)
        logger.info(f"Session {client_id[:8]}: follow requested for vehicle #{track_id}")

    def set_tracking_params(self, client_id: str, target_distance_ratio: float) -> None:
        """
        Adjust the "hold here" distance: target vehicle height as a fraction
        of frame height. Lower = hold farther back, higher = hold closer.

        WHY THIS HAS TO BE ADJUSTABLE RATHER THAN A FIXED CONSTANT.
        There is no altitude-independent right answer, and — unlike a
        person's standing height, which is a stable ~1.7m regardless of
        heading — a vehicle's apparent height in frame depends on its
        heading relative to the camera as much as its distance: a car driving
        broadside shows its long axis, the same car driving straight at the
        camera shows only its narrow front. The same physical range can
        produce very different fill percentages depending on which way the
        vehicle happens to be pointed.
        A fixed target that happens to be smaller than however large the
        vehicle actually appears at lock range means err_dist = target - h_ema
        is negative from the moment Follow arms and STAYS negative — the
        drone commands backward continuously, regardless of what the vehicle
        then does, because the target was simply unreachable at that range.
        That is indistinguishable from "forward is broken" unless the operator
        can see and adjust the target that's actually being chased.
        """
        if client_id not in self._client_state:
            return
        ratio = float(np.clip(target_distance_ratio, 0.08, 0.70))
        state = self._client_state[client_id]
        previous = state.get("target_distance_ratio", _DEFAULT_SIZE_RATIO)
        state["target_distance_ratio"] = ratio
        state["height_ema"] = None    # new target applies immediately

        # In Fixed altitude the forward axis reads the frame row, not apparent
        # size, so the ratio alone would not reach it — this control would go
        # dead in the default mode. The DIRECTION of change is applied to the
        # target row too, so one operator concept drives either sensor.
        if state.get("altitude_mode") != "auto" and state.get("target_row") is not None:
            # Closer means the ground contact sits lower in frame: a larger row.
            if ratio > previous:
                state["target_row"] = clamp_row_target(state["target_row"] + ROW_NUDGE_STEP)
            elif ratio < previous:
                state["target_row"] = clamp_row_target(state["target_row"] - ROW_NUDGE_STEP)
            state["row_pd"].reset()
        logger.info(f"Session {client_id[:8]}: vehicle follow distance -> {ratio:.2f}")

    def set_altitude_mode(self, client_id: str, mode: str) -> None:
        """'fixed' = hold the altitude Offboard started at (nudge buttons still
        apply). 'auto' = altitude PD keeps the vehicle vertically centred.

        Auto-elevate overrides BOTH — holding a fleeing vehicle in frame at all
        outranks either altitude policy.
        """
        if client_id not in self._client_state or mode not in ("fixed", "auto"):
            return
        state = self._client_state[client_id]
        state["altitude_mode"] = mode
        # Each mode hands the forward axis to a different sensor, so the PD the
        # other was using holds a derivative in units that no longer apply.
        if mode == "fixed":
            # Stale derivative would otherwise lurch the moment auto resumes.
            state["alt_pd"].reset()
            state["row_pd"].reset()
            # Re-take the row reference at the height we have actually reached.
            state["target_row"] = None
        else:
            # Leaving fixed: drop any held nudge so it cannot fight the PD.
            state["altitude_nudge_v"] = 0.0
            state["dist_pd"].reset()
        logger.info(f"Session {client_id[:8]}: vehicle altitude mode -> {mode}")

    def set_altitude_nudge(self, client_id: str, velocity: float) -> None:
        """Manual altitude velocity for Fixed mode: -ve ascend, +ve descend
        (NED), 0 stop. Sent while the operator holds the button, cleared on
        release. Ignored in Auto, which owns this axis."""
        if client_id not in self._client_state:
            return
        self._client_state[client_id]["altitude_nudge_v"] = float(
            np.clip(velocity, -1.5, 1.5)
        )

    def set_tracking(self, client_id: str, active: bool) -> None:
        state = self._client_state.get(client_id)
        if state is None:
            return
        state["tracking"] = bool(active)
        if not active:
            for k in ("yaw_pd", "alt_pd", "dist_pd", "row_pd"):
                state[k].reset()
            state["smoother"].reset()
            state["height_ema"] = None
            state["elevate"] = None
            state["last_drone_command"] = None
            # A held nudge must not survive disarming, or re-arming would
            # immediately command a climb nobody asked for.
            state["altitude_nudge_v"] = 0.0
        # Taken fresh at every lock: the framing on screen when the operator
        # arms Follow is the framing they asked for.
        state["target_row"] = None
        logger.info(
            f"Session {client_id[:8]}: vehicle tracking "
            f"{'STARTED' if active else 'STOPPED'}"
        )

    # ── Identity ──────────────────────────────────────────────────────────

    def _new_vehicle_id(self, state: Dict[str, Any]) -> str:
        state["vehicle_id_seq"] += 1
        return f"{_VEHICLE_ID_PREFIX}-{state['vehicle_id_seq']:06d}"

    def _register_plate(self, state: Dict[str, Any], vehicle: "_Vehicle") -> None:
        """
        Attach the durable identity implied by a plate reading.

        If this exact plate was already seen this session under a different
        vehicle_id, that earlier sighting's track fragmented and came back;
        re-attach the earlier identity instead of minting a new one.
        Otherwise this plate now belongs to this vehicle_id.
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

    # ── Plate OCR ─────────────────────────────────────────────────────────

    def _alpr_detections(self, img, ox: int, oy: int) -> List[dict]:
        """
        One fast-alpr call, normalised into plain dicts in FULL-FRAME
        coordinates (hence ox/oy, the crop's origin — without adding it back
        the overlay bracket and the logged box would both be meaningless).

        Applies only the two cheap sanity filters — a minimum area that
        rejects specks, and a minimum OCR confidence. Everything else about
        the reading's quality is measured and carried along rather than used
        to discard it; see the module-level note above _OCR_MIN_CONF.
        """
        if self.alpr is None or img is None or img.size == 0:
            return []
        if img.shape[0] < 16 or img.shape[1] < 16:
            return []
        try:
            results = self.alpr.predict(img)
        except Exception as e:
            logger.debug(f"ALPR call failed: {e}")
            return []

        out: List[dict] = []
        for r in results:
            box = getattr(r.detection, "bounding_box", None)
            if box is None or r.ocr is None:
                continue
            x1, y1 = int(box.x1), int(box.y1)
            x2, y2 = int(box.x2), int(box.y2)
            pw, ph = x2 - x1, max(1, y2 - y1)
            if pw * ph < _MIN_PLATE_AREA:
                continue

            raw_conf = getattr(r.ocr, "confidence", 0.0)
            # Some OCR models return one confidence per character; fast-alpr's
            # own code averages them the same way.
            conf = (float(sum(raw_conf) / len(raw_conf))
                    if isinstance(raw_conf, list) and raw_conf
                    else float(raw_conf or 0.0))
            if conf < _OCR_MIN_CONF:
                continue

            text = _validate_and_correct(getattr(r.ocr, "text", "") or "")
            if not text:
                continue

            out.append({
                "text": text,
                "conf": conf,
                "box": [x1 + ox, y1 + oy, x2 + ox, y2 + oy],
                "px_w": pw,
                "grammar_ok": bool(_INDIA_PLATE_RE.match(text)),
            })
        return out

    def _read_plates(self, frame_bgr, in_frame: List[_Vehicle], state) -> None:
        """
        Read every plate this frame can offer, then attach each to a vehicle.

        Whole frame PLUS one crop per vehicle — see the module note above
        _OCR_MIN_CONF for why both passes earn their keep. A detection is
        matched to the vehicle whose box contains its centre; readings that
        match no vehicle are still kept (via _unmatched_vehicle) because at
        range YOLO misses the car well before fast-alpr misses the plate, and
        dropping those was a large part of what went missing.

        AT MOST ONE READING PER VEHICLE PER FRAME.
        The two passes usually both see the same plate, so applying every
        detection would score one frame as two agreeing reads — and
        `plate_votes` is supposed to mean independent FRAMES, not passes over
        the same photons. Left unchecked, a single frame marked its own
        reading corroborated, which is precisely the "one confident wrong
        answer looks exactly like a right one" failure the vote count exists
        to expose. So the passes are pooled and only the best-confidence
        reading per vehicle is folded in.
        """
        if self.alpr is None:
            return
        h, w = frame_bgr.shape[:2]

        dets = self._alpr_detections(frame_bgr, 0, 0)
        for v in in_frame:
            x1, y1, x2, y2 = v.box
            # Padded: a vehicle box often clips the bumper the plate sits on.
            pw, ph = int((x2 - x1) * 0.10), int((y2 - y1) * 0.10)
            cx1, cy1 = max(0, x1 - pw), max(0, y1 - ph)
            cx2, cy2 = min(w, x2 + pw), min(h, y2 + ph)
            crop = frame_bgr[cy1:cy2, cx1:cx2]
            v.ocr_attempts += 1
            dets += self._alpr_detections(crop, cx1, cy1)

        # Best confidence first, so the strongest reading of a plate claims its
        # vehicle before any weaker duplicate of the same plate does.
        best: Dict[int, Tuple[_Vehicle, dict]] = {}
        for det in sorted(dets, key=lambda d: d["conf"], reverse=True):
            bx1, by1, bx2, by2 = det["box"]
            pcx, pcy = (bx1 + bx2) / 2.0, (by1 + by2) / 2.0
            owner = next(
                (v for v in in_frame
                 if v.box[0] <= pcx <= v.box[2] and v.box[1] <= pcy <= v.box[3]),
                None,
            )
            if owner is None:
                owner = self._unmatched_vehicle(state, det)
            prev = best.get(owner.track_id)
            if prev is None or det["conf"] > prev[1]["conf"]:
                best[owner.track_id] = (owner, det)

        for owner, det in best.values():
            self._apply_plate(owner, det, frame_bgr, state)

    def _unmatched_vehicle(self, state, det: dict) -> "_Vehicle":
        """
        A plate with no vehicle box around it still describes a vehicle.

        Tracked by overlap on the PLATE box across frames, in its own id space
        (negative track ids, so it can never collide with a ByteTrack id).
        Type stays "unknown" — it is genuinely unknown, and guessing "car"
        would put a fabricated field in a permanent row.
        """
        pool: Dict[int, _Vehicle] = state["plate_only"]
        best, best_iou = None, 0.0
        for v in pool.values():
            score = _iou(v.box, det["box"])
            if score > best_iou:
                best, best_iou = v, score
        if best is not None and best_iou >= _PLATE_ONLY_IOU:
            best.box = det["box"]
            best.last_seen = time.time()
            return best

        state["plate_only_seq"] += 1
        tid = -state["plate_only_seq"]
        v = _Vehicle(tid, self._new_vehicle_id(state), det["box"], "unknown")
        pool[tid] = v
        state["vehicles"][tid] = v
        state["ids_seen"].add(tid)
        return v

    def _apply_plate(self, v: _Vehicle, det: dict, frame_bgr, state) -> None:
        """
        Fold one reading into a vehicle, keeping the best-confidence view of
        its plate and saving fresh evidence whenever the view improves.

        Best-confidence rather than latest: a plate's legibility peaks on one
        particular frame as the vehicle turns, and that frame is the one worth
        keeping. Saving on every improvement (rather than once, on some
        "confirmed" event) is what the version the operator liked did, and it
        is why images actually appeared.
        """
        text, conf = det["text"], det["conf"]
        if text == v.plate:
            v.plate_votes += 1
            if conf <= v.plate_conf:
                return          # same string, no better look — nothing to redo
        elif conf > v.plate_conf or not v.plate:
            # A different string. Starts at one vote rather than inheriting the
            # previous string's count — that inheritance is what once let five
            # different readings look like a settled answer.
            v.plate = text
            v.plate_votes = 1
        else:
            return              # a weaker competing string — ignore

        v.plate_conf = max(v.plate_conf, conf)
        v.plate_px_w = det["px_w"]
        v.plate_grammar_ok = det["grammar_ok"]
        v.plate_box = det["box"]
        self._register_plate(state, v)
        self._save_evidence(frame_bgr, v, state)
        logger.info(
            f"vehicle {v.vehicle_id} (#{v.track_id}): plate {text} "
            f"conf={conf:.2f} {det['px_w']}px votes={v.plate_votes}"
            + ("" if det["grammar_ok"] else " [non-standard format]")
        )

    def _save_evidence(self, frame_bgr, vehicle: _Vehicle, state) -> None:
        """
        Write BOTH images: the plate crop and the whole vehicle.

        A ~40x18px plate crop on its own is unreviewable — you cannot tell a
        plate from a badge from a video overlay. The vehicle shot is what
        makes a row checkable by a human afterwards.

        Filenames use the persistent VEHICLE ID, never the OCR text: naming a
        file after the reading turns a shaky string into a shaky filename,
        and the text belongs in the database row next to its confidence.
        Overwritten in place as the read improves, so one vehicle leaves one
        pair of images rather than a pile of near-duplicates.
        """
        h, w = frame_bgr.shape[:2]
        base = vehicle.vehicle_id

        if vehicle.plate_box:
            x1, y1, x2, y2 = vehicle.plate_box
            # A hairline of surround, so a human can see it is a plate and not a
            # badge, without the crop becoming a picture of the bumper. Equal
            # fractions on both axes: an earlier version padded 25% vertically
            # against 10% horizontally, which buried a 31px-tall plate in car
            # bodywork.
            px, py = max(2, (x2 - x1) // 12), max(2, (y2 - y1) // 12)
            crop = frame_bgr[max(0, y1 - py):min(h, y2 + py),
                             max(0, x1 - px):min(w, x2 + px)]
            if crop.size:
                path = os.path.join(state["capture_dir"], f"{base}_plate.jpg")
                cv2.imwrite(path, crop)
                vehicle.crop_path = path

        x1, y1, x2, y2 = vehicle.box
        veh = frame_bgr[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
        if veh.size:
            path = os.path.join(state["capture_dir"], f"{base}_vehicle.jpg")
            cv2.imwrite(path, veh)
            vehicle.vehicle_path = path

    def _plate_event_row(self, v: "_Vehicle") -> Optional[dict]:
        """
        Build the DB row for one vehicle, or None if there is nothing to
        write.

        ONE ROW PER VEHICLE, plate or not. Every vehicle that was tracked gets
        its identity, type, colour, speed and location recorded; the plate is
        added to that row when one was read. Restricting rows to vehicles with
        plates would leave the log silent about most of the traffic actually
        seen, since most vehicles never turn a readable plate toward the
        camera.

        Written once per vehicle — `logged` is set here, on the only path that
        ever builds a row. Shared between the per-frame retire loop (a vehicle
        that has left frame) and unregister_client (a vehicle still on screen
        when the session simply stops), because a plate read seconds before
        the operator hits stop must not be lost merely because it never got
        the chance to age out of the registry first.
        """
        if v.logged:
            return None
        v.logged = True
        return {
            "table": "plate_event",
            "track_id": v.track_id,
            "vehicle_id": v.vehicle_id,
            # "" rather than None: the column is NOT NULL, and an empty string
            # reads correctly as "no plate was ever read for this vehicle".
            "plate_text": v.plate or "",
            "ocr_confidence": v.plate_conf,
            "vehicle_type": v.type or "unknown",
            "vehicle_color": v.color or "",
            "vehicle_color_conf": v.color_conf,
            "vehicle_box": v.box,
            "plate_box": v.plate_box,
            "plate_px_w": v.plate_px_w,
            # Both were already tracked here and simply never written. The
            # export's plate_grade column reads all three, so leaving these out
            # would grade every vehicle-plate-tracking row "weak" regardless of
            # how good the reading actually was.
            "plate_votes": v.plate_votes,
            "plate_grammar_ok": v.plate_grammar_ok,
            "image_path": v.crop_path,
            "vehicle_image_path": v.vehicle_path,
            "speed_est_kmh": v.speed_kmh if v.speed_reliable else None,
            "first_seen": datetime.fromtimestamp(v.first_seen, tz=timezone.utc),
            "last_seen": datetime.fromtimestamp(v.last_seen, tz=timezone.utc),
        }

    # ── Analysis ──────────────────────────────────────────────────────────

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        results = self.vehicle_model.track(
            frame_proc, classes=_VEHICLE_CLASS_IDS, imgsz=self.imgsz_for(frame_proc),
            device=self.device, half=self.half, verbose=False, conf=0.4,
            persist=True, tracker=_VEHICLE_TRACKER_CFG,
        )

        client_id = next(iter(self._client_state), None)
        state = self._client_state.get(client_id) if client_id else None
        if state is None:
            return frame_bgr, {}

        registry: Dict[int, _Vehicle] = state["vehicles"]
        now = time.time()
        in_frame: List[_Vehicle] = []

        if results and results[0].boxes is not None and len(results[0].boxes):
            boxes = results[0].boxes
            ids = (boxes.id.int().cpu().numpy()
                   if boxes.id is not None else [None] * len(boxes))
            for box, tid in zip(boxes, ids):
                if tid is None:
                    continue
                name = self.vehicle_model.names[int(box.cls[0])]
                if name not in _VEHICLE_CLASSES:
                    continue
                tid = int(tid)
                bx = box.xyxy[0].cpu().numpy()
                full = [int(bx[0] * sx), int(bx[1] * sy),
                        int(bx[2] * sx), int(bx[3] * sy)]

                v = registry.get(tid)
                if v is None:
                    v = _Vehicle(tid, self._new_vehicle_id(state), full, name)
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
        # Needs the frame's CAPTURE time and the telemetry snapshot taken
        # alongside it, not the current clock and current altitude: frames
        # get dropped, so the interval a module actually sees is not 1/fps.
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
            state["speed_note"] = None
        else:
            # Speed is GEOMETRY, and the geometry needs a height. Without
            # telemetry there is no metres-per-pixel, so a number here would be
            # invented rather than measured. Say which of the two is missing
            # instead of leaving the field blank — a silent absence is
            # indistinguishable from a broken estimator, which is exactly how
            # this read from the outside.
            state["speed_note"] = (
                "no telemetry — speed needs altitude to turn pixels into metres"
                if ctx is not None else "no frame context yet"
            )

        # ── Plate OCR: whole frame + one crop per vehicle ─────────────────
        self._read_plates(frame_bgr, in_frame, state)
        # Plate-only tracks (no vehicle box) are drawn and counted alongside
        # the real ones, so a plate YOLO could not attribute still appears.
        in_frame += [v for v in state["plate_only"].values()
                     if now - v.last_seen < 0.5 and v not in in_frame]

        # ── Follow ────────────────────────────────────────────────────────
        drone_command = self._follow(state, in_frame, client_id, W, H, ctx, pose)

        # ── Persist + retire ──────────────────────────────────────────────
        pending_db: List[dict] = []
        for tid, v in list(registry.items()):
            if now - v.last_seen < _VEHICLE_RETIRE_AFTER_S:
                continue
            row = self._plate_event_row(v)
            if row:
                pending_db.append(row)
            registry.pop(tid, None)
            state["plate_only"].pop(tid, None)

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
                    "vehicle_id": v.vehicle_id,
                    "box": v.box,
                    "type": v.type,
                    "color": v.color or "unknown",
                    "color_conf": round(v.color_conf, 2),
                    # The reading is always reported. Its strength travels
                    # alongside it — votes, confidence, pixel width, and
                    # whether it matches a known plate grammar — so the UI can
                    # tone a weak read without the module having to suppress
                    # it. Suppressing weak reads is what made this mode look
                    # broken; see the note above _OCR_MIN_CONF.
                    "plate": v.plate or None,
                    "plate_conf": round(v.plate_conf, 2),
                    "plate_votes": v.plate_votes,
                    "plate_px_w": v.plate_px_w,
                    "plate_grammar_ok": v.plate_grammar_ok,
                    "plate_strong": v.plate_strong,
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
            "plate_count": sum(1 for v in in_frame if v.plate),
            "plates_read": len(state["plate_registry"]),
            # ── Follow state ────────────────────────────────────────────
            "locked_track_id": locked_id,
            "locked_vehicle_id": state.get("locked_vehicle_id"),
            "locked_plate": state.get("locked_plate") or None,
            "tracking": state.get("tracking", False),
            "lock_state": lock.value,
            "lock_message": lock_msg,
            "seconds_lost": round(lost_s, 1),
            "elevate": state.get("elevate"),
            "drone_command": drone_command,
            # What the follow distance controller is actually chasing, made
            # visible rather than left implicit — "the drone only moves
            # backward" is indistinguishable from "target unreachable at this
            # range" unless both numbers are on screen at once.
            "target_distance_ratio": round(
                state.get("target_distance_ratio", _DEFAULT_SIZE_RATIO), 3
            ),
            "altitude_mode": state.get("altitude_mode", "fixed"),
            "vehicle_fill_pct": (
                round(state["height_ema"] * 100, 1)
                if state.get("height_ema") is not None else None
            ),
            # Honest about what speed is, everywhere it travels.
            "speed_is_estimate": True,
            "has_telemetry": pose is not None,
            # Why speed is absent, when it is. Blank fields are
            # indistinguishable from a broken estimator.
            "speed_note": state.get("speed_note"),
            "speed_available": sum(1 for v in in_frame if v.speed_kmh is not None),
            "alpr_available": self.alpr is not None,
        }
        if pending_db:
            meta["_pending_db"] = pending_db
        return frame_bgr, meta

    # ── Follow control ────────────────────────────────────────────────────

    def _follow(self, state, in_frame, client_id, W, H, ctx, pose):
        """
        Keep a locked vehicle framed and, once armed, fly at it.

        Same three-axis PD shape as human_tracker/traffic_manager (yaw
        primary, distance via apparent size, altitude secondary) plus the
        auto-elevate fallback when the vehicle outruns the airframe — climb
        to widen the ground footprint rather than lose it, since a fixed
        camera mount cannot simply look further ahead the way a gimbal would.
        A plate is not needed once the whole vehicle is locked, so trading
        plate legibility for altitude here costs this module nothing it
        still needs.
        """
        # An operator request takes effect as soon as that vehicle is in
        # frame — locking a track that is not visible would commit the
        # aircraft to nothing.
        wanted = state.get("follow_request_track_id")
        if wanted is not None:
            if any(v.track_id == wanted for v in in_frame):
                state["locked_track_id"] = wanted
                state["follow_request_track_id"] = None
                state["kalman"].reset()
                state["height_ema"] = None
                v = next(v for v in in_frame if v.track_id == wanted)
                state["locked_vehicle_id"] = v.vehicle_id
                state["locked_plate"] = v.plate or ""
                logger.info(
                    f"Session {client_id[:8]}: locked vehicle {v.vehicle_id}"
                    + (f" ({v.plate})" if v.plate else "")
                )

        locked_id = state.get("locked_track_id")
        if locked_id is None:
            state["elevate"] = None
            return None

        target = next((v for v in in_frame if v.track_id == locked_id), None)
        if target is None:
            state["frames_lost"] = state.get("frames_lost", 0) + 1
            # The plate/vehicle_id is the identity that survives a track id
            # change, so it is kept rather than cleared — a re-read of the
            # same characters is the same vehicle, not a guess.
            if not state.get("tracking"):
                return None
            # NEVER None here while armed — see the Offboard-keepalive note above.
            return self._search_command(state)

        state["frames_lost"] = 0
        state["last_seen_t"] = time.monotonic()
        if target.plate and not state.get("locked_plate"):
            state["locked_plate"] = target.plate

        if not state.get("tracking"):
            state["elevate"] = None
            return None

        x1, y1, x2, y2 = target.box
        cx_n, cy_n = (x1 + x2) / (2 * W), (y1 + y2) / (2 * H)
        fx_n, fy_n = state["kalman"].update(cx_n, cy_n)

        h_raw = (y2 - y1) / H
        prev = state["height_ema"]
        h_ema = h_raw if prev is None else (
            _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev
        )
        state["height_ema"] = h_ema

        err_yaw = fx_n - 0.5
        target_ratio = state.get("target_distance_ratio", _DEFAULT_SIZE_RATIO)

        # Undo viewing-angle foreshortening before reading range from size.
        # A vehicle's HEIGHT is a vertical extent, so its projection shrinks by
        # cos(depression); apparent size then goes as sin(2*phi) and peaks at
        # 45deg, which means past that point a target moving closer looks
        # SMALLER and the controller drives forward toward it. See
        # geometry.deforeshorten_size.
        # Vehicle height in metres — the ruler the position estimate needs.
        _widths = get_settings().vehicle_widths_m or {}
        _vh = 1.5 if target.type not in ("truck", "bus") else 3.2
        # Where the vehicle meets the road. Drives the Fixed-mode distance
        # axis, and is the pixel the ground projection inside
        # _range_observable has to use.
        foot_n = foot_row(fy_n, h_ema)
        h_eff, _phi = self._range_observable(
            h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, _vh
        )
        # Fraction-of-range — see controllers.range_error_ratio.
        err_dist = range_error_ratio(target_ratio, h_eff)

        yaw_deg_s = state["yaw_pd"].compute(err_yaw)

        # ── Altitude ─────────────────────────────────────────────────────
        # FIXED  — hold the altitude Offboard started at (telemetry.py runs
        #          its own P-hold whenever this axis is commanded 0), moving
        #          only on an operator nudge. Vertical framing is left alone.
        # AUTO   — drive altitude to keep the vehicle vertically centred.
        #
        # FIXED is the default here, deliberately, and it is the opposite of
        # the assumption an earlier version made. Because the camera is
        # rigidly mounted and tilted down, a subject's VERTICAL position in
        # frame is mostly a RANGE signal, not an altitude one — the distance
        # controller above already reads range, more directly, from apparent
        # size. So chasing vertical framing with altitude is a second
        # controller acting on the same underlying quantity, and it showed:
        # a perfectly centred, non-outpacing vehicle produced a steady
        # -0.2m/s climb with the elevate decision reporting elevating=False
        # the whole time.
        #
        # AUTO is still offered because it is genuinely wanted when the
        # ground is not flat, or when the operator prefers the target pinned
        # to frame centre over holding a set height.
        if state.get("altitude_mode") == "auto":
            err_alt = fy_n - 0.5
            down_m_s = state["alt_pd"].compute(err_alt)
        else:
            down_m_s = state.get("altitude_nudge_v", 0.0)

        # Which way we were last turning, for the search sweep if the vehicle
        # is lost right after this.
        if yaw_deg_s > 0.5:
            state["last_yaw_dir"] = 1.0
        elif yaw_deg_s < -0.5:
            state["last_yaw_dir"] = -1.0

        # FORWARD KEEPS A FLOOR RATHER THAN BEING GATED TO ZERO.
        #
        # A previous version zeroed forward entirely once the vehicle was
        # ~20deg off boresight (err_yaw >= _YAW_PRIORITY_THRESHOLD) — measured,
        # a vehicle only a third of the way toward the frame edge produced
        # forward_m_s == 0.0 outright, with only yaw commanded. That is a
        # normal moment mid-chase (the vehicle turned, or yaw simply has not
        # caught up yet), not an edge case, so the drone spent most of a
        # chase yawing in place while the vehicle it was meant to be closing
        # on kept its lead. _YAW_PRIORITY_FLOOR keeps SOME forward authority
        # at any angle, so the two axes correct together — yaw recentres while
        # distance is still being closed — rather than forward waiting its
        # turn.
        yaw_factor = max(
            _YAW_PRIORITY_FLOOR, 1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD
        )
        # ── THE DISTANCE AXIS, PER ALTITUDE MODE ──────────────────────────
        # Fixed reads the frame row (height is held, so the row IS range: high
        # in frame far, low in frame near); Auto reads apparent size,
        # unchanged. See pursuit.distance_axis.
        alt_mode = state.get("altitude_mode", "fixed")
        forward_raw, range_err = distance_axis(
            state=state, altitude_mode=alt_mode,
            foot_row_n=foot_n, size_range_error=err_dist,
        )
        # A retreat is never throttled — see pursuit.scale_forward.
        forward_m_s = scale_forward(forward_raw, yaw_factor, alt_mode)

        # Auto-elevate: only when the vehicle is genuinely pulling away, and
        # only inside both ceilings. Overrides the altitude axis because
        # holding the target in frame at all outranks holding it vertically
        # centred.
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
                    target_growing_distance=range_err > 0.01,
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
        # anything added later — rather than each of them separately. Without
        # it a sustained descent flew a SITL aircraft into the ground; see
        # pursuit.limit_descent.
        # The ceiling belongs at the same point, and it matters most for the
        # operator's nudge, which reached down_m_s having passed no altitude
        # check at all. See pursuit.limit_climb.
        _agl = pose.agl_m if pose else None
        _limits = PursuitLimits.from_settings()
        down_m_s, floor_reason = limit_descent(down_m_s, _agl, _limits)
        down_m_s, ceiling_reason = limit_climb(down_m_s, _agl, _limits)
        state["altitude_floor_reason"] = floor_reason or ceiling_reason

        # Row ranging assumes a held altitude; if the aircraft is moving
        # vertically the reference must be re-taken or the drone reads its own
        # climb as the subject approaching.
        if row_reference_is_stale(alt_mode, down_m_s):
            state["target_row"] = clamp_row_target(foot_n)
            state["row_pd"].reset()

        cmd = state["smoother"].smooth({
            "type": "velocity",
            "forward_m_s": forward_m_s,
            "right_m_s": 0.0,
            "down_m_s": down_m_s,
            "yaw_deg_s": yaw_deg_s,
        })
        drone_command = {
            "type": "velocity",
            "forward_m_s": round(cmd["forward_m_s"], 3),
            "right_m_s": 0.0,
            "down_m_s": round(cmd["down_m_s"], 3),
            "yaw_deg_s": round(cmd["yaw_deg_s"], 2),
        }
        # What _search_command holds and repeats if the vehicle drops out of
        # frame on the very next inference.
        state["last_drone_command"] = drone_command
        return drone_command

    def _range_observable(self, h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, subject_h_m):
        """
        Distance observable in size-ratio units, blending the two estimates a
        single camera can give.

        SIZE (de-foreshortened) is the primary and the only one that works
        without telemetry. POSITION (where the subject's feet meet the ground
        plane) is fused in as the view steepens, because that is exactly where
        the size estimate degrades and the position one sharpens — see
        geometry.blend_weight_for_position for the measured crossover.

        Returns h_ema unchanged when there is no pose, so every no-telemetry
        path behaves exactly as it did before this existed.
        """
        from app.vision import calibration as _cal
        from app.vision.geometry import (
            blend_weight_for_position, camera_from_settings, size_ratio_from_ground_range,
        )
        if pose is None or ctx is None:
            return h_ema, None

        cam = camera_from_settings(ctx.width or W, ctx.height or H)
        # TWO DIFFERENT PIXELS ON PURPOSE. The de-foreshortening angle belongs
        # at the subject's mid-height, because that is the vertical extent being
        # foreshortened. The ground projection below belongs at the feet. Using
        # one pixel for both is what put a forward bias in the range estimate.
        px, py = fx_n * W, fy_n * H
        phi = pose.depression_deg(cam, px, py)
        if phi is None:
            return h_ema, None

        ref = _cal.effective()["camera_mount_tilt_deg"]
        from_size = deforeshorten_size(h_ema, phi, ref)

        # FEET, NOT CENTRE. The comment here said exactly this while the code
        # passed the box centre, and the centre floats half a subject's height
        # off the ground — so its ray cleared the subject and struck the ground
        # BEYOND them. The over-estimate is AGL/(AGL - h/2), independent of
        # viewing angle: +17% at 6 m AGL, +27% at 4 m, +40% at 3 m. Range too
        # long reads as "further than wanted", which commands FORWARD, and the
        # position estimate is weighted in hardest at steep depression — i.e.
        # exactly when the subject is low in the frame and the drone should have
        # been backing off. Reported from flight as "person on the lower side of
        # frame and it moves forward instead of back".
        projected = pose.project_to_ground(cam, px, foot_n * H)
        if projected is None:
            return from_size, phi
        from_pos = size_ratio_from_ground_range(
            projected[2], subject_h_m, cam, H, ref
        )
        if from_pos is None:
            return from_size, phi

        w = blend_weight_for_position(phi)
        return (1.0 - w) * from_size + w * from_pos, phi

    def _search_command(self, state) -> dict:
        """
        The Offboard-keepalive fallback for a frame where the locked vehicle
        is not visible. See the Offboard-keepalive note at the top of this file
        for why this must never be None while tracking is armed.

        Same ladder as every other follow module, and for the same reason it is
        shared: hold the last command briefly (most losses are one bad frame and
        resolve on their own without the drone reacting to noise), fade the
        translation out, sweep for the vehicle, then hover.
        """
        return blind_command(
            last_cmd=state.get("last_drone_command"),
            frames_lost=state.get("frames_lost", 0),
            seconds_lost=seconds_lost_for(state),
            last_yaw_dir=state.get("last_yaw_dir", 1.0),
        )

    # ── Overlay ───────────────────────────────────────────────────────────

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]
        # Counts, telemetry/ALPR availability etc. live in the side panel —
        # putting them on the video too is redundant clutter over the one
        # thing the feed actually needs to show: the vehicles and their
        # plates.
        for v in meta.get("vehicles", []):
            x1, y1, x2, y2 = v["box"]
            locked = v.get("locked")
            color = (200, 220, 50) if locked else (170, 170, 170)
            draw_ring(frame_bgr, x1, y1, x2, y2, color, 3 if locked else 2)

            # ONE thing on screen per vehicle: the plate. vehicle_id, colour,
            # type and speed all used to be crammed into a single dense
            # caption, which is what read as dated — not the chip style. Every
            # one of those is already in the side panel, laid out properly,
            # and none of it needs reading off a moving picture.
            #
            # A trailing "?" marks a reading only one frame produced. Still
            # shown and still logged: at drone standoff a single-frame read is
            # often the only read a passing vehicle will ever give.
            plate = v.get("plate")
            strong = bool(v.get("plate_strong"))
            pcol = (153, 211, 52) if strong else (36, 191, 251)
            if plate:
                draw_badge(frame_bgr, f"{plate}{'' if strong else '?'}",
                           x1, max(16, y1 - 4), fg=color if locked else pcol)
            elif locked:
                draw_badge(frame_bgr, v.get("vehicle_id") or "FOLLOWING",
                           x1, max(16, y1 - 4), fg=color)

            if v.get("plate_box"):
                px1, py1, px2, py2 = v["plate_box"]
                draw_ring(frame_bgr, px1, py1, px2, py2, pcol, 2, radius=5)

            # Recentering guide for the locked, actively-followed vehicle —
            # same shape as human_tracker's: a line from frame centre to the
            # target, so which way (and how far) the target sits off-centre
            # is visible at a glance, not something to infer from the PD
            # command alone.
            if locked and meta.get("tracking"):
                tx, ty = (x1 + x2) // 2, (y1 + y2) // 2
                cx, cy = W // 2, H // 2
                cv2.line(frame_bgr, (cx, cy), (tx, ty), (200, 200, 200), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (tx, ty), 8, (255, 255, 255), 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 12, ty), (tx + 12, ty), (255, 255, 255), 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 12), (tx, ty + 12), (255, 255, 255), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (cx, cy), 3, (180, 180, 180), -1, cv2.LINE_AA)

        return frame_bgr

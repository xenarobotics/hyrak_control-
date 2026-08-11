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
import math
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
from app.vision.drawing import draw_badge, draw_ring
from app.vision.geometry import camera_from_settings, pose_from_telemetry
from app.vision.modules.plate_tracker import _INDIA_PLATE_RE, _validate_and_correct
from app.vision.pursuit import (
    PursuitLimits, ROW_NUDGE_STEP, blind_command, clamp_row_target,
    decide_elevation, distance_axis, foot_row, is_outpaced, limit_climb,
    limit_descent, lock_state_for, new_row_pd, row_reference_is_stale,
    scale_forward, seconds_lost_for,
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
#
# 110 -> 70 -> 40. The last step is the same operator call as _MIN_PLATE_AREA:
# spending one budgeted call on a marginal vehicle costs a fraction of a frame,
# while skipping it guarantees no plate at all. A 40px-wide vehicle upscales to
# 384 with nothing gained, but the detector is free to disagree and the photo
# makes any result checkable.
_OCR_MIN_VEHICLE_PX = 40
# A read this confident AND this large is treated as final — the vehicle stops
# consuming budget because there is essentially nothing left to win.
_OCR_GOOD_ENOUGH = 0.80
# ...and the plate has to be genuinely big, not merely confidently guessed.
# Both conditions together, because confidence alone tops out at 1.00 on
# fabricated reads.
_PLATE_GOOD_PX = 110
_OCR_MIN_CONF = 0.35
# Stop retrying a vehicle that has repeatedly failed — usually its plate simply
# is not facing us. Generous now that re-reading is the normal case rather than
# the exception: the priority ordering, not this cap, is what stops one vehicle
# starving the others.
_OCR_MAX_ATTEMPTS = 60
# A vehicle is worth re-reading once it has grown this much since the frame its
# current best came from. Below that the extra pixels will not change the
# reading and the call is better spent on a vehicle that has no plate at all.
_REREAD_GROWTH = 1.30
# How many retired vehicles' best readings to remember for re-identification.
# One small dict entry each; 500 covers any realistic session over a junction
# while keeping the memory bounded on a multi-hour flight.
_READ_ARCHIVE_MAX = 500

# ── Guards against fabricated plates ────────────────────────────────────────
#
# THE HISTORY. Left ungated, this module logged WA01WMWH, WA02MM901, WA12MMSH
# and WAL7MM991 — all for the SAME vehicle, on consecutive frames — plus
# SUBSCRIBE and SUBSCR18 read off a video overlay. Every one of those crops was
# 40-50px wide. OCR does not fail loudly at that size; it invents a plausible
# string, and a plausible string is worse than no reading because it looks like
# data.
#
# WHY THE GATES ARE NOW LOOSER THAN THAT HISTORY SUGGESTS. The original fix put
# a hard 70px floor on the measured plate width. Checked against 25 real
# captures off this rig, plates arrive 31-79px wide — so that floor rejected
# nearly every genuine plate the aircraft will ever see. vehicle-plate-tracking
# hit exactly this and went from 0 plates read to 19 of 25 by relaxing it.
#
# What makes relaxing SAFE here is that the fabrication cause is now blocked
# UPSTREAM and geometrically: vision/profiles.py refuses to spend an OCR call
# at all unless the lens and range put ~70px on the plate. The 40-50px crops
# that produced SUBSCRIBE are never reached. That is a better guard than a
# confidence threshold, because it reasons about whether the information is
# present rather than about how sure a model claims to be.
#
# So the gates below change role: they no longer decide WHETHER a reading
# exists, they measure HOW GOOD it is. Every reading is reported and logged
# with its width, votes and grammar recorded alongside; the UI tones it
# accordingly. A single-frame read is often the only read a passing vehicle
# will ever give, and discarding it silently is what lost this project a
# session's worth of data.
#
# AREA, NOT WIDTH. A 40x14 plate carries the same information as a 56x10 one
# and the first fails a width floor the second passes.
#
# Lowered from 500 to 150 by operator decision, and the reasoning holds: a
# pixel count is a threshold on a continuum, not a cliff, and reads a little
# under it do sometimes come back correct. What makes accepting them safe is
# that EVERY accepted read is saved as a photograph beside its text, so a wrong
# one is visible and correctable rather than an unfalsifiable database row —
# whereas a refused read is a permanently lost record.
#
# It is not zero: below roughly 150px^2 the crop is a smear the detector should
# not have proposed at all, and passing it on produces strings with no
# relationship to any plate.
_MIN_PLATE_AREA = 150
# Kept as a QUALITY MARKER, not a filter — reads below it are still reported,
# toned as weak. Nothing rejects on this.
_PLATE_MIN_WIDTH_PX = 70
# Plate aspect. Indian single-row plates are ~4:1, two-row ~2:1, so anything
# outside this band is not a plate shape. This one stays a hard reject: it
# rejects on SHAPE, which no amount of range fixes, and it costs no real
# plates. Note it alone would NOT have stopped "SUBSCRIBE" (3.74).
_PLATE_ASPECT_MIN = 1.6
_PLATE_ASPECT_MAX = 6.0
# CROSS-FRAME AGREEMENT. One vehicle yielding five different strings is the
# signature of guessing, so agreement is still counted and still drives how a
# reading is presented — but it no longer suppresses one. Two independent
# frames agreeing marks a plate STRONG; a single frame is shown and logged with
# a marker. Same principle as plate_tracker's _PLATE_AGREEMENT_STRONG.
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

# ── Wrong-way detection ──────────────────────────────────────────────────────
#
# WHAT THIS CAN AND CANNOT KNOW. There is no map here, no lane geometry and no
# operator-declared direction, so "wrong way" in the absolute sense is not
# available. What IS available is the other traffic: a vehicle driving against
# the vehicles around it is the observable that matters, and it needs no prior
# knowledge of the road at all.
#
# THE FAILURE THIS IS SHAPED TO AVOID is a false alert. A wrong-way flag that
# fires on a U-turn, a car pulling out of a driveway, or the far carriageway of
# a divided road is worse than no flag, because an operator stops believing it.
# Hence four independent conditions, all of which must hold:
#
#   1. The vehicle is actually MOVING. Below _FLOW_MIN_KMH a heading is atan2
#      of box jitter — a uniformly random compass bearing.
#   2. It is judged against NEARBY traffic only. A radius keeps the two
#      carriageways of a divided road from being averaged into one meaningless
#      mean heading, which is the single most likely source of a false alert.
#   3. The neighbours AGREE with each other. Coherence is measured before the
#      comparison is made: a junction where everyone is turning has no flow to
#      be against, and produces no flags rather than flagging everyone.
#   4. It PERSISTS. A vehicle must hold the opposed heading for about a
#      second of frames, so a momentary tracker wobble or a car swinging
#      through a turn cannot trip it.
_FLOW_MIN_KMH = 8.0
#: Neighbourhood radius as a fraction of the frame diagonal.
_FLOW_NEIGHBOUR_FRAC = 0.30
_FLOW_MIN_NEIGHBOURS = 3
#: Resultant length of the neighbours' unit heading vectors, 0..1. 1.0 means
#: they all point exactly the same way; below this there is no flow to oppose.
_FLOW_COHERENCE = 0.75
#: How far from the local flow counts as against it. Deliberately near
#: opposite — 90 degrees is a turn, not a wrong way.
_FLOW_OPPOSED_DEG = 120.0
#: Frames of opposition before the flag is raised, and the ceiling on the
#: counter so a long-flagged vehicle still clears within a second of rejoining
#: the flow rather than coasting on accumulated credit.
_FLOW_STRIKES_TO_FLAG = 20
_FLOW_STRIKE_MAX = 30


def _angle_gap(a: float, b: float) -> float:
    """Smallest absolute angle between two compass bearings, 0..180."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _local_flow(headings: List[float]) -> Tuple[Optional[float], float]:
    """
    (mean bearing, coherence 0..1) for a set of compass bearings.

    A circular mean, not an arithmetic one: bearings 350 and 10 average to 0,
    not to 180. Coherence is the resultant length, which is what tells a lane
    of traffic all going one way from a junction where everyone is turning.
    """
    if not headings:
        return (None, 0.0)
    rad = np.radians(np.asarray(headings, dtype=np.float64))
    x, y = float(np.cos(rad).mean()), float(np.sin(rad).mean())
    r = float(np.hypot(x, y))
    if r < 1e-6:
        return (None, 0.0)
    return (math.degrees(math.atan2(y, x)) % 360.0, r)


def _read_quality(px_w: int, conf: float) -> float:
    """How good a plate reading is, as one number.

    Pixels dominate and confidence modulates, because that is the direction the
    evidence actually runs: a model can be certain about characters that are
    not in the crop, but it cannot invent detail that is. Used to decide which
    of a vehicle's readings to keep as it drives past.
    """
    return float(max(0, px_w)) * max(0.0, min(1.0, conf))


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
        "plate", "plate_conf", "plate_box", "plate_box_rel",
        "crop_path", "vehicle_path", "read_area", "plate_quality",
        "plate_votes", "plate_confirmed", "plate_grammar_ok", "plate_px_w",
        "speed_kmh", "speed_reliable", "ocr_attempts",
        "heading_deg", "closing_m_s", "direction", "screen_dir",
        "flow_strikes", "against_flow",
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
        # How many pixels across the plate actually was. The honest quality
        # indicator now that width no longer rejects: a 40px read and a 300px
        # read are both reported, and are not equally trustworthy.
        self.plate_px_w = 0
        # Vehicle box area at the moment the CURRENT best read was taken, so
        # "has this vehicle grown enough to be worth re-reading?" is a
        # measurement rather than a guess.
        self.read_area = 0
        # Score of the best reading so far — see _read_quality.
        self.plate_quality = 0.0
        self.plate_box: Optional[list] = None
        # The same box as FRACTIONS OF THE VEHICLE BOX it was measured in.
        #
        # plate_box is absolute pixels frozen at the moment of the read, and
        # OCR only runs on a couple of vehicles per frame — so a moving
        # vehicle's bracket was drawn wherever its plate had been up to
        # several seconds earlier, and kept being drawn there while the
        # vehicle's own box was smoothed away across the frame. Storing it
        # relative lets the overlay place it against the CURRENT box, so it
        # travels with the vehicle and disappears with it.
        self.plate_box_rel: Optional[list] = None
        self.crop_path: Optional[str] = None
        self.vehicle_path: Optional[str] = None
        # How many frames independently produced the CURRENT string. One
        # vehicle yielding five different plates is what this counts against.
        self.plate_votes = 0
        self.plate_confirmed = False
        self.plate_grammar_ok = False
        self.speed_kmh: Optional[float] = None
        self.speed_reliable = False
        # Direction of travel — the velocity VECTOR the speed fit always
        # computed and never published. None until the vehicle is moving fast
        # enough for a heading to mean anything.
        self.heading_deg: Optional[float] = None
        self.closing_m_s: Optional[float] = None
        self.direction: Optional[str] = None
        # Unit vector of travel in FRAME pixels — what an arrow drawn over the
        # video can point along. A compass bearing cannot be drawn on a moving
        # picture without a compass rose to read it against.
        self.screen_dir: Optional[list] = None
        # Consecutive frames spent opposed to the local flow, and the flag that
        # raises once there have been enough of them. A counter rather than a
        # boolean because a single frame of opposition is a tracker wobble.
        self.flow_strikes = 0
        self.against_flow = False
        self.ocr_attempts = 0
        self.first_seen = time.time()
        self.last_seen = time.time()
        self.logged = False

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.box
        return max(0, x2 - x1) * max(0, y2 - y1)

    @property
    def read_settled(self) -> bool:
        """A reading good enough that nothing further is worth spending.

        BOTH conditions: a big plate AND high confidence, agreed by two frames.
        Confidence alone tops out at 1.00 on invented strings, and a large crop
        alone can still be motion-blurred."""
        return (
            self.plate_px_w >= _PLATE_GOOD_PX
            and self.plate_conf >= _OCR_GOOD_ENOUGH
            and self.plate_votes >= _PLATE_MIN_AGREEING_READS
        )

    @property
    def needs_ocr(self) -> bool:
        """Whether this vehicle is still worth an OCR call.

        WHY THIS IS NO LONGER "STOP AT THE FIRST CONFIRMED READ".
        A vehicle is usually first seen far away and small. The reading taken
        there is the WORST one it will ever offer, and stopping at it threw
        away every better look the vehicle gave while it drove closer — a
        50px plate confirmed at the far edge of frame, kept in preference to
        the 200px plate available two seconds later.

        So a vehicle keeps its place in the queue for as long as it can still
        beat its own best: until the reading is genuinely settled (big AND
        confident AND agreed), or it has simply had too many tries.
        """
        return not self.read_settled and self.ocr_attempts < _OCR_MAX_ATTEMPTS

    @property
    def reread_gain(self) -> float:
        """How much bigger this vehicle is now than when its best read was
        taken. The honest estimate of what another call would buy: >1 means
        more pixels on the plate than last time, and 1.0 means none."""
        if not self.plate or self.read_area <= 0:
            return float("inf")      # never read — nothing to compare, read it
        return self.area / float(self.read_area)

    @property
    def plate_strong(self) -> bool:
        """Two or more independent FRAMES agreed on these characters.

        Drives how a reading is TONED, never whether it is shown."""
        return bool(self.plate) and self.plate_votes >= _PLATE_MIN_AGREEING_READS

    @property
    def reportable_plate(self) -> Optional[str]:
        """The plate, or None if nothing was read at all.

        Was `plate_confirmed and plate_grammar_ok`, which discarded almost
        every real reading this rig produces. Two separate reasons:

          * TWO AGREEING FRAMES. A vehicle crossing frame at speed often gives
            exactly one readable look at its plate. Requiring a second meant
            the single read — the only one that would ever exist — was thrown
            away, and the operator saw an empty log.
          * GRAMMAR. _INDIA_PLATE_RE does not match perfectly valid non-Indian
            plates; the real captured plate "719257C" fails it. Grammar is a
            useful signal about a reading, not a licence for it to exist.

        Both are still recorded — as plate_votes, plate_strong, plate_px_w and
        plate_grammar_ok — so the UI can tone a weak read and a report can be
        filtered on strength. What changed is that the reading is no longer
        silently destroyed. Fabrication is prevented upstream now, by
        profiles.py declining to spend the call at all when the geometry says
        the pixels are not there.
        """
        return self.plate or None


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
        # vehicle_id -> the best reading that identity ever produced, kept
        # after its track has retired. Re-identification already restored the
        # vehicle_id when a returning vehicle's plate matched; what it did not
        # restore was the READING, so a car that gave a 210px plate before an
        # occlusion came back holding whatever 60px guess the far side of the
        # frame offered. Bounded — see _archive_read.
        "read_archive": {},
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
        # Read by blind_command while the locked subject is out of frame.
        "last_drone_command": None,
        "last_yaw_dir": 1.0,
        "height_ema": None,
        "elevate": None,
        "yaw_pd": PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        "alt_pd": PDController(kp=1.5, kd=0.3, max_output=1.0, deadband=0.10),
        "dist_pd": PDController(kp=3.0, kd=0.8, max_output=2.5, deadband=0.04),
        # The Fixed-altitude distance axis — see pursuit.new_row_pd.
        "row_pd": new_row_pd(),
        # Frame row Fixed mode holds the subject's ground contact on; None =
        # take it from the subject on the next frame.
        "target_row": None,
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
        state = self._client_state.pop(client_id, None)
        if state is None:
            return
        # A vehicle still in frame when the operator stops never gets the
        # chance to age out of the registry, so without this flush its row —
        # plate included — is silently dropped. From the outside that is
        # exactly "ran a session, saw plates, nothing in the history
        # afterward". vehicle-plate-tracking already did this; this module did
        # not, so the two modes lost different amounts of data from the same
        # flight.
        rows = [r for v in state["vehicles"].values()
                if (r := self._plate_event_row(v)) is not None]
        if not rows:
            return
        # Location has to be attached here too. The live path picks it up in
        # stream_track.recv(), which is not involved once the session is
        # tearing down — so these rows would otherwise be the only ones
        # missing lat/lng, which reads as the GPS dropping out at the end of
        # every flight rather than as a gap in the code.
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
            logger.debug(f"No position for session-end traffic flush: {e}")

        from app.vision.persistence import persist_events
        await persist_events(client_id, rows)
        logger.info(
            f"Session {client_id[:8]}: flushed {len(rows)} vehicle record(s) "
            f"still in frame at shutdown"
        )

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
        # size_ratio always carries both kinds, so the default is unreachable —
        # it is only here so a missing key cannot raise mid-flight.
        previous = state["size_ratio"].get(kind, _DEFAULT_SIZE_RATIO)
        ratio = float(np.clip(target_distance_ratio, 0.05, 0.80))
        state["size_ratio"][kind] = ratio
        state["dist_pd"].reset()

        # In Fixed altitude the forward axis reads the frame row, not apparent
        # fill, so a ratio alone would not reach it — this control would go dead
        # in that mode. The DIRECTION of change is applied to the target row too.
        if state.get("altitude_mode") != "auto" and state.get("target_row") is not None:
            # Closer means the ground contact sits lower in frame: a larger row.
            if ratio > previous:
                state["target_row"] = clamp_row_target(state["target_row"] + ROW_NUDGE_STEP)
            elif ratio < previous:
                state["target_row"] = clamp_row_target(state["target_row"] - ROW_NUDGE_STEP)
            state["row_pd"].reset()
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
        # Each mode hands the forward axis to a different sensor, so the PD the
        # other was using holds a derivative in units that no longer apply.
        if mode == "fixed":
            # A stale derivative would lurch the moment auto resumes.
            state["alt_pd"].reset()
            state["row_pd"].reset()
            # Re-take the row reference at the height we have actually reached.
            state["target_row"] = None
        else:
            # Leaving fixed: drop any held nudge so it cannot fight the PD.
            state["altitude_nudge_v"] = 0.0
            state["dist_pd"].reset()
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
            for k in ("yaw_pd", "alt_pd", "dist_pd", "row_pd"):
                state[k].reset()
            state["smoother"].reset()
            state["height_ema"] = None
            state["elevate"] = None
            # A held nudge would otherwise still be commanding vertical motion
            # the next time Follow arms.
            state["altitude_nudge_v"] = 0.0
            state["altitude_floor_reason"] = None
        # Taken fresh at every lock: the framing on screen when the operator
        # arms Follow is the framing they asked for.
        state["target_row"] = None
        logger.info(
            f"Session {client_id[:8]}: vehicle tracking "
            f"{'STARTED' if active else 'STOPPED'}"
        )

    def _plate_event_row(self, v: "_Vehicle") -> Optional[dict]:
        """
        Build the DB row for one vehicle, or None if it is already written.

        ONE ROW PER VEHICLE, PLATE OR NOT — the same policy as
        vehicle-plate-tracking, which this module previously diverged from.
        Rows used to be restricted to confirmed, grammar-valid plates, which
        left the log silent about most of the traffic actually seen: most
        vehicles never turn a readable plate toward an aircraft, and the ones
        that do often give a single frame to do it in. A vehicle's identity,
        type, colour, speed and location are worth recording whether or not its
        plate was legible.

        Quality travels WITH the row (plate_px_w, ocr_confidence) rather than
        deciding whether the row exists, so a weak reading can be judged or
        filtered afterwards. A row that was never written cannot be.
        """
        if v.logged:
            return None
        v.logged = True
        return {
            "table": "plate_event",
            "track_id": v.track_id,
            "vehicle_id": v.vehicle_id or None,
            # "" rather than None: the column is NOT NULL, and an empty string
            # reads correctly as "no plate was ever read for this vehicle".
            "plate_text": v.reportable_plate or "",
            "ocr_confidence": v.plate_conf,
            # The quality indicator that lets a weak row be judged after the
            # fact. The column already existed for vehicle-plate-tracking;
            # this module simply never wrote it.
            "plate_px_w": v.plate_px_w,
            # The other two halves of "how much should this reading be
            # trusted". Width was already recorded; agreement and grammar were
            # computed, shown live, and then dropped on the floor at the point
            # the record became permanent — so a report could not be filtered
            # on the very thing that separates a settled plate from a guess.
            "plate_votes": v.plate_votes,
            "plate_grammar_ok": v.plate_grammar_ok,
            "vehicle_type": v.type or "unknown",
            "vehicle_color": v.color or "",
            "vehicle_color_conf": v.color_conf,
            "vehicle_box": v.box,
            "plate_box": v.plate_box,
            # The plate crop; the vehicle shot sits beside it on disk so a
            # record can be checked by a human.
            "image_path": v.crop_path,
            "vehicle_image_path": v.vehicle_path,
            # Only a reliable estimate is written to a permanent row.
            "speed_est_kmh": v.speed_kmh if v.speed_reliable else None,
            # Direction of travel, and whether it opposed the traffic around
            # it. A wrong-way sighting that is not recorded cannot be reviewed,
            # which is most of what makes it worth detecting.
            "heading_deg": v.heading_deg,
            "against_flow": v.against_flow,
            # This module never wrote these, so every row's timestamps
            # defaulted to the moment it was inserted — which is when the
            # vehicle LEFT, identical for the whole batch, and useless for
            # working out how long anything was in view.
            "first_seen": datetime.fromtimestamp(v.first_seen, tz=timezone.utc),
            "last_seen": datetime.fromtimestamp(v.last_seen, tz=timezone.utc),
        }

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
            self._restore_read(state, vehicle)
        else:
            registry[vehicle.plate] = vehicle.vehicle_id

    def _archive_read(self, state: Dict[str, Any], vehicle: "_Vehicle") -> None:
        """Keep a retiring vehicle's best reading against its durable identity.

        Only the reading, not the vehicle: box, speed and track id all belong
        to a sighting, whereas the plate belongs to the car.
        """
        if not vehicle.plate or not vehicle.vehicle_id:
            return
        archive = state["read_archive"]
        prior = archive.get(vehicle.vehicle_id)
        if prior is not None and prior["quality"] >= vehicle.plate_quality:
            return
        archive[vehicle.vehicle_id] = {
            "plate": vehicle.plate,
            "quality": vehicle.plate_quality,
            "conf": vehicle.plate_conf,
            "px_w": vehicle.plate_px_w,
            "votes": vehicle.plate_votes,
            "grammar_ok": vehicle.plate_grammar_ok,
            "crop_path": vehicle.crop_path,
            "vehicle_path": vehicle.vehicle_path,
            "first_seen": vehicle.first_seen,
        }
        # Bounded: a long session over a busy road would otherwise hold one
        # entry per plate ever seen, and the oldest are the least likely to
        # come back. dicts preserve insertion order, so the first key is the
        # oldest.
        while len(archive) > _READ_ARCHIVE_MAX:
            archive.pop(next(iter(archive)))

    def _restore_read(self, state: Dict[str, Any], vehicle: "_Vehicle") -> None:
        """
        Carry an earlier sighting's reading onto this one, if it was better.

        WHY THIS EXISTS. Re-identification already reattached the vehicle_id,
        so a returning car was correctly recognised as the same car — and then
        kept whatever reading THIS sighting happened to produce. Entering frame
        means entering it small and far away, so that reading is systematically
        the worst of the two, and the good one taken before the occlusion was
        discarded at exactly the moment it was proved to belong to the same
        vehicle.

        The photograph moves with the numbers, because the two must describe
        one observation; and votes are carried so a plate agreed on twice
        before does not have to earn agreement again from scratch.

        Only ever an UPGRADE: a worse archived read is left alone, so a car
        that returns closer than it left keeps its new, better look.
        """
        prior = state["read_archive"].get(vehicle.vehicle_id)
        if prior is None or prior["plate"] != vehicle.plate:
            return
        if prior["quality"] <= vehicle.plate_quality:
            return
        vehicle.plate_quality = prior["quality"]
        vehicle.plate_conf = prior["conf"]
        vehicle.plate_px_w = prior["px_w"]
        vehicle.plate_grammar_ok = prior["grammar_ok"]
        vehicle.plate_votes = max(vehicle.plate_votes, prior["votes"])
        vehicle.crop_path = prior["crop_path"]
        vehicle.vehicle_path = prior["vehicle_path"]
        vehicle.first_seen = min(vehicle.first_seen, prior["first_seen"])
        # The plate box belonged to a different frame of a different sighting;
        # drawing it against this vehicle's current box would put the bracket
        # somewhere arbitrary. The reading survives, its geometry does not.
        vehicle.plate_box = None
        vehicle.plate_box_rel = None
        # read_area is what decides whether another call is worth spending, and
        # it must describe the read now held. Set to this vehicle's CURRENT
        # size so re-reading resumes only once it has genuinely grown past the
        # point the archived look was taken from.
        vehicle.read_area = vehicle.area
        logger.info(
            f"vehicle #{vehicle.track_id}: restored {prior['plate']} from "
            f"{vehicle.vehicle_id}'s earlier sighting "
            f"({prior['px_w']}px conf={prior['conf']:.2f}) — better than this "
            f"sighting's own read"
        )

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
            # A vehicle that already has a reading only earns another call once
            # it has grown enough for the extra pixels to change the answer.
            # Without this the queue re-reads the same near vehicle every frame
            # at the same size, learning nothing.
            and (not v.plate or v.reread_gain >= _REREAD_GROWTH)
        ]
        if not need:
            return []
        # ORDERED BY WHAT ANOTHER CALL WOULD ACTUALLY BUY, not by raw size.
        #
        # Now that vehicles are re-read while they can still improve, "largest
        # first" would park the budget on whichever big vehicle is nearest and
        # re-read a plate that is already as good as it will get, while a
        # vehicle with no reading at all waits behind it.
        #
        #   1. never read      — infinite gain, nothing to compare against
        #   2. has grown most since its best read — more pixels than last time
        #   3. size, to break ties
        #
        # reread_gain returns +inf for an unread vehicle, so those two rules
        # are the same expression.
        need.sort(key=lambda v: (min(v.reread_gain, 1e6), v.area), reverse=True)

        locked_id = state.get("locked_track_id")
        front = [v for v in need if v.track_id == locked_id]
        rest = [v for v in need if v.track_id != locked_id]
        if rest:
            cur = state["ocr_cursor"] % len(rest)
            rest = rest[cur:] + rest[:cur]
            state["ocr_cursor"] = (cur + 1) % max(1, len(rest))
        return (front + rest)[:budget]

    @staticmethod
    def _store_best_read(vehicle, text, conf, grammar_ok, pw, quality,
                         box, cx1: int, cy1: int) -> None:
        """Record ONE observation as this vehicle's best reading.

        Written as a unit deliberately. The fields used to be updated with an
        independent max() each, which could report one frame's pixel width
        beside another frame's confidence and a third frame's box — a record
        no single observation ever supported, and unfalsifiable against the
        photograph saved with it.
        """
        vehicle.plate_quality = quality
        vehicle.plate_conf = conf
        vehicle.plate_grammar_ok = grammar_ok
        vehicle.plate_px_w = pw
        # The vehicle's size AT THIS READ, so "has it grown enough to be worth
        # another look?" is a measurement rather than a guess.
        vehicle.read_area = vehicle.area
        # Back to full-frame coordinates — the crop's origin has to be added
        # back or the overlay bracket lands in the wrong place.
        vx1, vy1, vx2, vy2 = vehicle.box
        vw, vh = max(1, vx2 - vx1), max(1, vy2 - vy1)
        vehicle.plate_box = [
            int(box.x1) + cx1, int(box.y1) + cy1,
            int(box.x2) + cx1, int(box.y2) + cy1,
        ]
        vehicle.plate_box_rel = [
            (vehicle.plate_box[0] - vx1) / vw,
            (vehicle.plate_box[1] - vy1) / vh,
            (vehicle.plate_box[2] - vx1) / vw,
            (vehicle.plate_box[3] - vy1) / vh,
        ]

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
            # AREA, not width. Real plates off this rig arrive 31-79px wide; a
            # 70px width floor rejected almost all of them. A 40x14 crop holds
            # the same information as a 56x10 one and only the second clears a
            # width test. See the note above _MIN_PLATE_AREA for why relaxing
            # is safe now that profiles.py refuses the call geometrically.
            if pw * ph < _MIN_PLATE_AREA:
                logger.debug(
                    f"vehicle #{vehicle.track_id}: plate candidate {pw}x{ph}px "
                    f"({pw * ph}px^2) below the {_MIN_PLATE_AREA}px^2 floor — ignored"
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

            # ── Gate 3: is this the best look this vehicle has given? ─────
            #
            # RANKED BY QUALITY, NOT BY CONFIDENCE ALONE. Confidence was the
            # sole tie-breaker and it is the weaker signal: a 60px crop read at
            # 0.9 is worse evidence than a 200px crop read at 0.6, because the
            # second one has the characters actually present in it. Ranking on
            # pixels x confidence keeps the reading the vehicle's best LOOK
            # produced rather than the one the model felt best about.
            quality = _read_quality(pw, conf)
            improved = quality > vehicle.plate_quality * 1.15

            if text == vehicle.plate:
                vehicle.plate_votes += 1
                # A repeat from a WORSE look still counts as agreement — it is
                # independent evidence for the same characters. It just must
                # not overwrite the better look's numbers. Confirmation is
                # therefore evaluated below for both branches; an earlier
                # version returned here and votes piled up on a plate that
                # could never confirm.
                better = quality > vehicle.plate_quality
            elif quality > vehicle.plate_quality:
                # A different string from a better look. Start it at one vote
                # rather than inheriting the old one's — that inheritance is
                # what let five different readings look like a settled answer.
                vehicle.plate = text
                vehicle.plate_votes = 1
                vehicle.plate_confirmed = False
                better = True
            else:
                continue

            if better:
                self._store_best_read(vehicle, text, conf, grammar_ok, pw,
                                      quality, box, cx1, cy1)


            # Confirmation is AGREEMENT ONLY. Requiring grammar here as well
            # made the relaxation half-done and left a real defect: the valid
            # plate "719257C" fails _INDIA_PLATE_RE, so however many frames
            # agreed on it, it never confirmed — which meant it never stopped
            # consuming OCR budget (starving other vehicles for 12 attempts)
            # and never re-attached its durable identity across an occlusion,
            # so one car became several vehicle_ids. Grammar is recorded and
            # shown; it does not decide what counts as read.
            just_confirmed = (
                not vehicle.plate_confirmed
                and vehicle.plate_votes >= _PLATE_MIN_AGREEING_READS
            )
            if just_confirmed:
                vehicle.plate_confirmed = True
                # Re-identification stays gated on AGREEMENT even though
                # reporting no longer is. Merging two track ids is a claim
                # about two sightings being one vehicle, and a single wrong
                # read would silently fuse two different cars' histories —
                # a far worse outcome than a duplicate row.
                self._register_plate(state, vehicle)
                logger.info(
                    f"vehicle #{vehicle.track_id}: plate {text} confirmed "
                    f"({vehicle.plate_votes} agreeing reads, conf={conf:.2f}, "
                    f"{pw}x{ph}px)"
                )

            # Evidence is saved for the FIRST accepted read, not only on
            # confirmation. A vehicle crossing frame at speed frequently gives
            # exactly one readable look, and the previous rule logged that
            # plate with no image to check it against — which is precisely the
            # "plates recorded but no captures" complaint. Re-saved on
            # confirmation because a confirming frame is usually the better
            # picture, and the second write overwrites the first.
            # The photo must be of the READING IT SITS BESIDE. Since the best
            # read can now be superseded mid-pass, the evidence is rewritten
            # whenever a materially better look lands — otherwise the file on
            # disk shows a 50px plate while the record claims the 200px one.
            if just_confirmed or vehicle.crop_path is None or improved:
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
                    v.heading_deg = (round(r.heading_deg, 1)
                                     if r.heading_deg is not None else None)
                    v.closing_m_s = (round(r.closing_m_s, 2)
                                     if r.closing_m_s is not None else None)
                    v.direction = r.direction
                    v.screen_dir = (list(r.screen_dir)
                                    if r.screen_dir is not None else None)
            self._update_flow(in_frame, W, H)

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
            row = self._plate_event_row(v)
            if row:
                pending_db.append(row)
            # Before the object goes: keep its best reading against its durable
            # identity, so if this vehicle comes back the good look survives.
            self._archive_read(state, v)
            registry.pop(tid, None)

        locked_id = state.get("locked_track_id")
        seen_t = state.get("last_seen_t", 0.0)
        lost_s = (time.monotonic() - seen_t) if seen_t else 0.0
        # Visibility has to consider BOTH lists now that a person can be the
        # locked subject. Checking only vehicles reported a person standing in
        # plain sight as lost, so the panel showed COASTING then SEARCHING
        # while the drone was in fact tracking them perfectly.
        locked_visible = (
            locked_id is not None
            and (any(v.track_id == locked_id for v in in_frame)
                 or any(p["track_id"] == locked_id for p in people))
        )
        lock, lock_msg = lock_state_for(
            visible=locked_visible,
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
                    # Nothing is "provisional" any more: every read is
                    # reported, and its strength is carried in the fields
                    # beside it rather than by withholding the text. Kept as an
                    # explicit null so the shared VehicleResult type still
                    # matches what vehicle-plate-tracking sends.
                    "plate_provisional": None,
                    "plate_conf": round(v.plate_conf, 2),
                    "plate_votes": v.plate_votes,
                    "plate_px_w": v.plate_px_w,
                    "plate_grammar_ok": v.plate_grammar_ok,
                    "plate_strong": v.plate_strong,
                    "plate_box": v.plate_box,
                    # Preferred by the overlay — see plate_box_rel above.
                    "plate_box_rel": v.plate_box_rel,
                    "speed_kmh": v.speed_kmh,
                    "speed_reliable": v.speed_reliable,
                    # Direction: the velocity vector's other half. heading is
                    # a compass bearing, direction is relative to the drone.
                    "heading_deg": v.heading_deg,
                    "closing_m_s": v.closing_m_s,
                    "direction": v.direction,
                    "screen_dir": v.screen_dir,
                    "against_flow": v.against_flow,
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
            # Headline for the panel: an operator watching the video will not
            # necessarily notice one car among twenty pointing the other way.
            "against_flow_count": sum(1 for v in in_frame if v.against_flow),
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

    @staticmethod
    def _update_flow(in_frame: List[_Vehicle], W: int, H: int) -> None:
        """
        Flag vehicles driving against the traffic immediately around them.

        See the notes above _FLOW_MIN_KMH for why all four conditions are
        required. The one worth restating here is that a vehicle is NEVER part
        of the flow it is judged against — including it would drag the mean
        toward its own heading, so the more decisively wrong-way a vehicle is,
        the less wrong-way it would appear.

        Runs in O(n^2) over the vehicles in frame, which is a handful; the
        alternative is a spatial index for a list that rarely exceeds twenty.
        """
        radius = math.hypot(W, H) * _FLOW_NEIGHBOUR_FRAC
        movers = [
            v for v in in_frame
            if v.heading_deg is not None and (v.speed_kmh or 0.0) >= _FLOW_MIN_KMH
        ]
        moving_ids = {v.track_id for v in movers}
        for v in in_frame:
            if v.track_id not in moving_ids:
                # No usable heading this frame — decay rather than reset, so a
                # vehicle briefly occluded or slowed does not lose a flag it
                # has genuinely earned.
                v.flow_strikes = max(0, v.flow_strikes - 1)
                v.against_flow = v.flow_strikes >= _FLOW_STRIKES_TO_FLAG
                continue

            cx = (v.box[0] + v.box[2]) / 2.0
            cy = (v.box[1] + v.box[3]) / 2.0
            near = [
                o.heading_deg for o in movers
                if o.track_id != v.track_id
                and math.hypot((o.box[0] + o.box[2]) / 2.0 - cx,
                               (o.box[1] + o.box[3]) / 2.0 - cy) <= radius
            ]
            flow, coherence = _local_flow(near)
            opposed = (
                len(near) >= _FLOW_MIN_NEIGHBOURS
                and coherence >= _FLOW_COHERENCE
                and flow is not None
                and _angle_gap(v.heading_deg, flow) >= _FLOW_OPPOSED_DEG
            )
            if opposed:
                v.flow_strikes = min(_FLOW_STRIKE_MAX, v.flow_strikes + 1)
            else:
                # Cleared twice as fast as it is earned: rejoining the flow is
                # unambiguous evidence, whereas one opposed frame is not.
                v.flow_strikes = max(0, v.flow_strikes - 2)
            was = v.against_flow
            v.against_flow = v.flow_strikes >= _FLOW_STRIKES_TO_FLAG
            if v.against_flow and not was:
                logger.warning(
                    f"vehicle #{v.track_id} ({v.vehicle_id}): heading "
                    f"{v.heading_deg:.0f}deg against local flow {flow:.0f}deg "
                    f"over {len(near)} nearby vehicles — AGAINST TRAFFIC"
                )

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
            if not state.get("tracking"):
                return None
            # Armed, but the subject is not in this frame. Returning None here —
            # which is what this did — GAPPED the Offboard setpoint stream, and
            # PX4 then flies on at the last velocity it was given until its
            # offboard-loss failsafe fires. That is the same "kept moving"
            # symptom the other four modules produced by replaying the last
            # command, arrived at from the opposite direction.
            return blind_command(
                last_cmd=state.get("last_drone_command"),
                frames_lost=state["frames_lost"],
                seconds_lost=seconds_lost_for(state),
                last_yaw_dir=state.get("last_yaw_dir", 1.0),
            )

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
        # Where the subject meets the road — the Fixed-mode distance axis.
        foot_n = foot_row(fy_n, h_ema)

        yaw_deg_s = state["yaw_pd"].compute(err_yaw)
        # Fixed holds the altitude Offboard started at, so the only vertical
        # motion is whatever the operator is nudging. Auto lets the PD centre
        # the subject. Auto-elevate below overrides either.
        if state.get("altitude_mode") == "fixed":
            state["alt_pd"].reset()
            down_m_s = float(state.get("altitude_nudge_v") or 0.0)
        else:
            down_m_s = state["alt_pd"].compute(err_alt)

        # ── THE DISTANCE AXIS, PER ALTITUDE MODE ──────────────────────────
        # Fixed reads the frame row (height is held, so the row IS range: high
        # in frame far, low in frame near); Auto reads apparent fill, unchanged.
        # See pursuit.distance_axis.
        alt_mode = state.get("altitude_mode", "auto")
        forward_raw, range_err = distance_axis(
            state=state, altitude_mode=alt_mode,
            foot_row_n=foot_n, size_range_error=err_dist,
        )

        yaw_factor = max(0.0, 1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
        if yaw_factor > 0.0:
            # A retreat is never throttled — see pursuit.scale_forward.
            forward_m_s = scale_forward(forward_raw, yaw_factor, alt_mode)
        elif forward_raw < 0.0:
            # This module gates forward to a HARD ZERO off boresight, unlike the
            # other four. A retreat must survive that gate: a subject too close
            # AND off-axis is the case where holding station is least safe.
            forward_m_s = forward_raw
        else:
            state["dist_pd"].reset()
            state["row_pd"].reset()
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
        # anything added later — rather than each of them separately.
        #
        # This module was the ONLY follow-capable one without it: the other
        # five gained the guard after an unguarded descent flew a SITL aircraft
        # into the ground (+0.5 m/s held for 12s, 6.6m to 0m, ending in
        # "invalid setpoints / blind land"). The same code path existed here
        # untouched. See pursuit.limit_descent.
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
        # Both of these are read by blind_command on a frame where the subject
        # is missing. This module kept neither, which is why its only answer to
        # a missing subject could be None.
        state["last_drone_command"] = drone_command
        if abs(yaw_deg_s) > 1e-6:
            state["last_yaw_dir"] = 1.0 if yaw_deg_s > 0 else -1.0
        return drone_command

    # ── Overlay ───────────────────────────────────────────────────────────

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]

        # NO DENSITY GRID AND NO CORNER READOUT IN THIS MODE.
        #
        # Both were inherited from crowd-management, where a grid answers
        # "which zone is busiest" over a venue the aircraft is holding station
        # above. Traffic is watched moving, and there the tinted cells and
        # their per-cell numbers sit on top of the vehicles and people the
        # operator is trying to see, while the same counts are already on the
        # panel — laid out properly and readable without squinting through
        # them.
        #
        # What earns space on the picture is only what is POSITIONAL: a box
        # belongs there because it points at something in the frame. A count
        # does not.
        #
        # Removed from the client canvas at the same time. Keeping the two
        # renderers in step matters more than usual here — the server path had
        # silently drifted anyway, grading cells with the module's default 8/20
        # while the client used the operator's calibrated thresholds, so the
        # same crowd could read green in one and orange in the other.

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
            # Against-flow outranks the lock colour. A wrong-way vehicle is the
            # one thing on this picture the operator must not miss, and grey
            # among twenty other greys is exactly how it would be missed.
            if v.get("against_flow"):
                color = (60, 60, 240)
            elif locked:
                color = (200, 220, 50)
            else:
                color = (170, 170, 170)
            draw_ring(frame_bgr, x1, y1, x2, y2, color,
                      3 if (locked or v.get("against_flow")) else 2)

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
            # Relative to the drone, not a compass bearing: a compass bearing
            # in a corner of a moving picture is a number to be decoded, while
            # "coming at us" is something an operator can act on. The exact
            # heading is on the panel for anyone who wants it.
            arrow = {"approaching": " v", "departing": " ^", "crossing": " >"}
            label += arrow.get(v.get("direction") or "", "")
            if v.get("against_flow"):
                label = "!! WRONG WAY  " + label
            draw_badge(frame_bgr, label, x1, max(16, y1 - 4), fg=color)

            if v.get("plate_box"):
                px1, py1, px2, py2 = v["plate_box"]
                draw_ring(frame_bgr, px1, py1, px2, py2, (0, 200, 0), 2, radius=5)

        return frame_bgr

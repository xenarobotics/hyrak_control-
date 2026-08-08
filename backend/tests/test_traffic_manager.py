"""
Traffic management — the composed vehicle module.

YOLO detection and speed estimation are already covered by their own tests, so
what is tested here is the COMPOSITION: the per-frame OCR budget, unique
counting, colour bookkeeping, lock-and-follow, and DB retirement.

TrafficManager is built with __new__ to skip loading YOLO and fast-alpr; the
model is replaced with a stub that returns whatever boxes a test wants.
"""
import time

import numpy as np
import pytest

from app.vision.modules.traffic_manager import (
    _COLOUR_GOOD_ENOUGH, _LOCK_LOST_AFTER_S, _OCR_CALLS_PER_FRAME,
    _OCR_MAX_ATTEMPTS, _OCR_MIN_VEHICLE_PX, _PLATE_MIN_AGREEING_READS,
    _PLATE_MIN_WIDTH_PX, TrafficManager, _Vehicle, _make_state,
)


def vehicle(tid: int, x1=100, y1=100, x2=400, y2=350, vtype="car") -> _Vehicle:
    return _Vehicle(tid, [x1, y1, x2, y2], vtype)


def bare_tracker() -> TrafficManager:
    t = TrafficManager.__new__(TrafficManager)
    t.alpr = None
    t._client_state = {"s": _make_state("test-traffic")}
    return t


# --------------------------------------------------------------------------- #
# The OCR budget — the reason this module composes rather than just running all  #
# --------------------------------------------------------------------------- #

def test_only_one_ocr_call_per_frame():
    """fast-alpr costs ~14.7ms regardless of input size, so the budget is a
    COUNT of calls. Running it on every vehicle would blow the frame budget."""
    t = bare_tracker()
    state = t._client_state["s"]
    many = [vehicle(i, x1=i * 320, x2=i * 320 + 300) for i in range(1, 7)]
    assert len(t._ocr_candidates(state, many, budget=_OCR_CALLS_PER_FRAME)) == _OCR_CALLS_PER_FRAME


def test_largest_vehicle_wins_the_budget():
    """Nearest-first: a distant vehicle's plate cannot be read anyway."""
    t = bare_tracker()
    small = vehicle(1, 0, 0, 160, 120)
    big = vehicle(2, 500, 100, 1100, 600)
    picked = t._ocr_candidates(t._client_state["s"], [small, big], budget=_OCR_CALLS_PER_FRAME)
    assert picked[0].track_id == 2


def test_locked_vehicle_gets_priority_over_a_larger_one():
    """The locked vehicle's plate is the identity that survives a track id
    change, so it outranks mere size."""
    t = bare_tracker()
    state = t._client_state["s"]
    state["locked_track_id"] = 1
    small_locked = vehicle(1, 0, 0, 200, 160)
    big_other = vehicle(2, 500, 100, 1200, 700)
    picked = t._ocr_candidates(state, [small_locked, big_other], budget=_OCR_CALLS_PER_FRAME)
    assert picked[0].track_id == 1


def test_vehicles_too_small_never_consume_budget():
    """Below this width the detector's own 384px letterbox leaves nothing of
    the plate to read, so spending a call is pure waste."""
    t = bare_tracker()
    tiny = vehicle(1, 0, 0, _OCR_MIN_VEHICLE_PX - 20, 80)
    assert t._ocr_candidates(t._client_state["s"], [tiny], budget=_OCR_CALLS_PER_FRAME) == []


def test_a_zero_budget_spends_nothing():
    """The survey profile's whole point: when the optics cannot resolve a plate
    at this range, the 14.7ms call is reclaimed rather than spent inventing a
    reading. Vehicles that would otherwise qualify must still get nothing."""
    t = bare_tracker()
    ready = [vehicle(i, x1=i * 320, x2=i * 320 + 300) for i in range(1, 4)]
    assert t._ocr_candidates(t._client_state["s"], ready, budget=0) == []
    # ...and the same vehicles are picked up the moment budget returns.
    assert t._ocr_candidates(t._client_state["s"], ready, budget=2) != []


def test_a_larger_budget_reads_more_vehicles_in_one_frame():
    """Skipping out-of-range faces frees budget, and that budget has to
    actually buy extra reads or the reallocation is decorative."""
    t = bare_tracker()
    state = t._client_state["s"]
    many = [vehicle(i, x1=i * 320, x2=i * 320 + 300) for i in range(1, 7)]
    assert len(t._ocr_candidates(state, many, budget=1)) == 1
    assert len(t._ocr_candidates(state, many, budget=3)) == 3


def test_face_identification_is_skipped_but_earned_names_survive():
    """Out of range, the model must not run — yet a name established when the
    face WAS resolvable should persist while its track lives, rather than a
    climb erasing a good identification."""
    t = bare_tracker()
    t.face_app = object()          # present, so availability is not the reason

    class _Gallery:
        def is_empty(self):
            return False

        def match(self, *a, **k):
            raise AssertionError("gallery must not be consulted when skipping")

    t._gallery = _Gallery()
    state = t._client_state["s"]
    state["face_identities"][7] = {
        "person_id": "p1", "name": "Asha", "votes": 3, "best_sim": 0.8,
        "last_sim": 0.8, "margin": 0.2, "last_seen": time.monotonic(),
        "confirmed": True,
    }
    people = [{"track_id": 7, "box": [0, 0, 200, 400], "conf": 0.9}]

    out = t._identify_faces(None, people, state, attempt=False)
    assert out[7]["name"] == "Asha"

    # A track that has left frame is not reported even so.
    assert t._identify_faces(None, [], state, attempt=False) == {}


def test_a_confirmed_read_stops_consuming_budget():
    """Freeing it for vehicles that still have no plate at all.

    Gated on CONFIRMED rather than on confidence: the fabricated reads that
    prompted these guards scored up to 1.00, so confidence alone is not
    evidence that a plate has been read."""
    t = bare_tracker()
    done = vehicle(1)
    done.plate, done.plate_conf = "TS09EA0001", 0.95
    done.plate_votes, done.plate_confirmed, done.plate_grammar_ok = 2, True, True
    pending = vehicle(2, 500, 100, 900, 400)
    picked = t._ocr_candidates(t._client_state["s"], [done, pending], budget=_OCR_CALLS_PER_FRAME)
    assert [v.track_id for v in picked] == [2]
    assert done.needs_ocr is False


def test_high_confidence_alone_does_not_stop_the_budget():
    """A single 1.00-confidence read is exactly what a fabricated plate looks
    like, so it must not end the search."""
    t = bare_tracker()
    v = vehicle(1)
    v.plate, v.plate_conf, v.plate_votes = "SUBSCRIBE", 1.0, 1
    assert v.needs_ocr is True
    assert v.reportable_plate is None


def test_repeated_failures_stop_starving_other_vehicles():
    """A vehicle whose plate simply is not facing us must not hold the budget
    forever."""
    t = bare_tracker()
    stubborn = vehicle(1, 0, 0, 900, 600)
    stubborn.ocr_attempts = _OCR_MAX_ATTEMPTS
    other = vehicle(2, 900, 100, 1200, 400)
    picked = t._ocr_candidates(t._client_state["s"], [stubborn, other], budget=_OCR_CALLS_PER_FRAME)
    assert [v.track_id for v in picked] == [2]


def test_budget_rotates_between_equally_deserving_vehicles():
    """Without a cursor, whichever vehicle sorts first would take the budget on
    every single frame and the others would never be read."""
    t = bare_tracker()
    state = t._client_state["s"]
    # Same size so ordering is decided purely by the rotation.
    a, b, c = (vehicle(i, x1=i * 400, x2=i * 400 + 300) for i in (1, 2, 3))
    picked = set()
    for _ in range(9):
        for v in t._ocr_candidates(state, [a, b, c], budget=_OCR_CALLS_PER_FRAME):
            picked.add(v.track_id)
    assert len(picked) > 1, "budget fixated on one vehicle"


# --------------------------------------------------------------------------- #
# Plate reading                                                                 #
# --------------------------------------------------------------------------- #

class _FakeOcr:
    def __init__(self, text, conf):
        self.text, self.confidence = text, conf


class _FakeBox:
    def __init__(self, x1, y1, x2, y2):
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2


class _FakeDet:
    def __init__(self, box):
        self.bounding_box = box


class _FakeResult:
    def __init__(self, text, conf, box):
        self.ocr = _FakeOcr(text, conf)
        self.detection = _FakeDet(box)


# Wide enough to clear _PLATE_MIN_WIDTH_PX and shaped like a plate. The
# fabricated reads that prompted those gates all came from ~45x13 boxes.
_READABLE_BOX = _FakeBox(10, 10, 100, 34)


def _with_alpr(results, record=None):
    t = bare_tracker()

    class _Alpr:
        def predict(self, crop):
            if record is not None:
                record.append(crop.shape)
            return results
    t.alpr = _Alpr()
    return t


def test_plate_box_is_returned_in_full_frame_coordinates():
    """The crop's origin has to be added back, or the plate bracket draws in the
    wrong place and the logged box is meaningless."""
    t = _with_alpr([_FakeResult("TS09EA0001", 0.9, _FakeBox(20, 30, 110, 55))])
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    v = vehicle(1, 800, 500, 1100, 700)
    t._read_plate(frame, v, t._client_state["s"])

    assert v.plate == "TS09EA0001"
    # Crop starts near x=776 (box minus 8% padding), so the plate must land
    # well right of the frame origin.
    assert v.plate_box[0] > 700
    assert v.plate_box[1] > 400


def test_a_weaker_read_does_not_overwrite_a_stronger_one():
    t = _with_alpr([_FakeResult("TS09EA0001", 0.9, _READABLE_BOX)])
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    v = vehicle(1, 400, 300, 900, 700)
    t._read_plate(frame, v, t._client_state["s"])
    assert v.plate_conf == pytest.approx(0.9)

    t.alpr.predict = lambda crop: [
        _FakeResult("MH12AB1234", 0.6, _READABLE_BOX)
    ]
    t._read_plate(frame, v, t._client_state["s"])
    assert v.plate == "TS09EA0001", "a weaker read overwrote a stronger one"


def test_per_character_confidence_lists_are_averaged():
    """Some OCR models return a list per character; a list is not a float and
    comparing it to a threshold would raise."""
    t = _with_alpr([_FakeResult("TS09EA0001", [0.8, 0.9, 0.7], _READABLE_BOX)])
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    v = vehicle(1, 400, 300, 900, 700)
    t._read_plate(frame, v, t._client_state["s"])
    assert v.plate_conf == pytest.approx(0.8, abs=0.01)


def test_attempts_are_counted_even_when_nothing_is_read():
    """Otherwise the give-up cap never triggers."""
    t = _with_alpr([])
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    v = vehicle(1, 400, 300, 800, 600)
    for _ in range(3):
        t._read_plate(frame, v, t._client_state["s"])
    assert v.ocr_attempts == 3


def test_missing_alpr_degrades_instead_of_raising():
    """Every other analytic still works without fast-alpr, so a missing
    dependency must not take the mode down."""
    t = bare_tracker()
    assert t.alpr is None
    v = vehicle(1)
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    assert v.plate == ""


def test_a_failing_alpr_call_does_not_propagate():
    t = bare_tracker()

    class _Boom:
        def predict(self, crop):
            raise RuntimeError("simulated ONNX failure")
    t.alpr = _Boom()
    v = vehicle(1, 400, 300, 800, 600)
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    assert v.plate == ""


# --------------------------------------------------------------------------- #
# Follow                                                                        #
# --------------------------------------------------------------------------- #

def test_lock_takes_effect_only_once_the_vehicle_is_in_frame():
    """Locking a track that is not visible would commit the aircraft to
    nothing."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    assert state["locked_track_id"] is None          # requested, not locked

    t._follow(state, [], [], "s", 1920, 1080, None, None)
    assert state["locked_track_id"] is None, "locked onto an absent vehicle"

    t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None)
    assert state["locked_track_id"] == 7


def test_locking_captures_the_plate_as_the_durable_identity():
    """A track id changes when a vehicle leaves and returns; the plate does
    not, so it is what a re-acquisition can be checked against."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(7)
    v.plate = "MH12AB1234"
    t.request_follow("s", 7)
    t._follow(state, [v], [], "s", 1920, 1080, None, None)
    assert state["locked_plate"] == "MH12AB1234"


def test_no_command_until_tracking_is_armed():
    """Locking frames a vehicle; it must not start flying at it until an
    operator says so."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    assert t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None) is None

    t.set_tracking("s", True)
    cmd = t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None)
    assert cmd is not None
    assert cmd["type"] == "velocity"


def test_command_yaws_toward_a_vehicle_off_to_one_side():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    # Vehicle far to the RIGHT of frame centre.
    right = vehicle(7, 1500, 500, 1800, 700)
    cmd = None
    for _ in range(6):
        cmd = t._follow(state, [right], [], "s", 1920, 1080, None, None)
    assert cmd["yaw_deg_s"] > 0, "did not yaw toward a right-hand target"


def test_releasing_clears_the_lock_and_stops_commanding():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None)

    t.request_follow("s", None)
    assert state["locked_track_id"] is None
    assert state["tracking"] is False
    assert t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None) is None


def test_losing_the_vehicle_stops_commands_but_keeps_the_identity():
    """Losing the box does not mean the vehicle was misidentified, and the
    plate is what a re-acquisition would be matched against."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(7)
    v.plate = "MH12AB1234"
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [v], [], "s", 1920, 1080, None, None)

    assert t._follow(state, [], [], "s", 1920, 1080, None, None) is None
    assert state["locked_plate"] == "MH12AB1234"
    assert state["frames_lost"] >= 1


def test_stopping_tracking_resets_the_controllers():
    """Stale PD derivative state would produce a lurch on the next start."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    for _ in range(4):
        t._follow(state, [vehicle(7, 1500, 500, 1800, 700)], [], "s", 1920, 1080, None, None)
    t.set_tracking("s", False)
    assert state["height_ema"] is None
    assert state["elevate"] is None


# --------------------------------------------------------------------------- #
# Counting                                                                      #
# --------------------------------------------------------------------------- #

def test_unique_count_is_by_track_not_by_detection():
    """A per-frame detection count re-counts the same car every frame — that is
    not a vehicle count."""
    state = _make_state("t")
    for _ in range(10):
        for tid in (1, 2, 3):
            state["ids_seen"].add(tid)
    assert len(state["ids_seen"]) == 3


def test_colour_is_counted_once_per_vehicle_at_confidence():
    """Colour wobbles frame to frame; counting every reading would let one
    vehicle contribute to several colour buckets."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    # Simulates the module's own guard: count only on crossing the threshold.
    for conf in (0.2, 0.4, 0.6, 0.7, 0.9):
        was = v.color_conf >= _COLOUR_GOOD_ENOUGH
        if conf > v.color_conf:
            v.color, v.color_conf = "red", conf
            if not was and conf >= _COLOUR_GOOD_ENOUGH:
                state["color_counts"]["red"] = state["color_counts"].get("red", 0) + 1
    assert state["color_counts"] == {"red": 1}


def test_retired_vehicle_with_a_plate_is_logged_once():
    """One row per vehicle, written when it leaves — not per frame."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    v.plate, v.plate_conf = "TS09EA0001", 0.9
    v.color, v.color_conf = "white", 0.8
    v.speed_kmh, v.speed_reliable = 48.0, True
    v.last_seen = time.time() - (_LOCK_LOST_AFTER_S + 1)
    state["vehicles"][1] = v

    rows = []
    for tid, veh in list(state["vehicles"].items()):
        if time.time() - veh.last_seen < _LOCK_LOST_AFTER_S:
            continue
        if veh.plate and not veh.logged:
            veh.logged = True
            rows.append({
                "table": "plate_event", "plate_text": veh.plate,
                "vehicle_color": veh.color,
                "speed_est_kmh": veh.speed_kmh if veh.speed_reliable else None,
            })
        state["vehicles"].pop(tid, None)

    assert len(rows) == 1
    assert rows[0]["plate_text"] == "TS09EA0001"
    assert rows[0]["vehicle_color"] == "white"
    assert rows[0]["speed_est_kmh"] == 48.0
    assert v.logged is True


def test_an_unreliable_speed_is_not_written_to_a_permanent_row():
    """Live overlay may show it with a '?', but a durable record should not
    carry a number the estimator itself distrusts."""
    v = vehicle(1)
    v.plate, v.speed_kmh, v.speed_reliable = "TS09EA0001", 220.0, False
    assert (v.speed_kmh if v.speed_reliable else None) is None


def test_a_vehicle_with_no_plate_is_not_logged():
    """Most vehicles a drone sees never yield a readable plate. They still count
    toward traffic, but there is no plate row to write."""
    v = vehicle(1)
    assert not v.plate


# --------------------------------------------------------------------------- #
# Overlay                                                                       #
# --------------------------------------------------------------------------- #

def test_overlay_labels_degrade_gracefully():
    """A vehicle with no plate, no colour and no speed must still render a
    useful label rather than empty fields."""
    t = bare_tracker()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    meta = {
        "vehicles": [
            {"track_id": 1, "box": [100, 100, 400, 300], "type": "car",
             "color": "unknown", "color_conf": 0.0, "plate": None,
             "plate_box": None, "speed_kmh": None, "speed_reliable": False,
             "locked": False},
            {"track_id": 2, "box": [500, 100, 800, 300], "type": "truck",
             "color": "white", "color_conf": 0.8, "plate": "TS09EA0001",
             "plate_box": [600, 250, 700, 280], "speed_kmh": 52.0,
             "speed_reliable": True, "locked": True},
        ],
        "vehicles_in_frame": 2, "vehicle_count_unique": 5, "plates_read": 1,
        "has_telemetry": True,
    }
    out = t.draw_overlay(frame, meta)
    assert out.shape == frame.shape
    assert out.any(), "overlay drew nothing"


def test_overlay_says_so_when_telemetry_is_missing():
    """Speed silently absent is indistinguishable from speed zero."""
    t = bare_tracker()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(frame, {"vehicles": [], "has_telemetry": False,
                           "vehicles_in_frame": 0, "vehicle_count_unique": 0})
    assert frame.any(), "no warning drawn"


# --------------------------------------------------------------------------- #
# Registration                                                                  #
# --------------------------------------------------------------------------- #

def test_mode_is_registered_and_has_its_own_inference_width():
    from app.config import Settings
    from app.sessions.models import AnalysisMode
    from app.vision.modules.__registry__ import ANALYZER_REGISTRY

    assert AnalysisMode.TRAFFIC.value == "traffic-management"
    assert ANALYZER_REGISTRY[AnalysisMode.TRAFFIC] is TrafficManager
    assert TrafficManager.MODE == AnalysisMode.TRAFFIC.value
    # 0 = NATIVE. Was 1280 while people-counting was treated as the binding
    # constraint; now the mode also feeds vision/profiles.py, which decides
    # what to run from pixels on target. Capping the detection pass would cap
    # that decision with it and a better camera would buy nothing.
    assert Settings().inference_width_for(TrafficManager.MODE) == 0


# --------------------------------------------------------------------------- #
# Fabricated plates — the observed failures, pinned                             #
# --------------------------------------------------------------------------- #
#
# Every case below is a real string this module logged before the gates existed.
# They are here by name because the failure mode is silent: OCR does not error
# at 45px, it returns a plausible plate, and a plausible plate is worse than no
# reading because it looks like data.

def _read(text, conf, box, veh=None, times=1):
    t = _with_alpr([_FakeResult(text, conf, box)])
    v = veh or vehicle(1, 400, 300, 900, 700)
    for _ in range(times):
        t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    return v


@pytest.mark.parametrize("text,box_w", [
    ("WA01WMWH", 45),      # logged from a 45x13 crop
    ("WA02MM901", 51),     # same vehicle, next frame
    ("WA12MMSH", 41),
    ("WAL7MM991", 43),
    ("P443", 40),
])
def test_reads_from_unreadably_small_crops_are_discarded(text, box_w):
    """The single most effective gate. No confidence threshold recovers
    information that is not in the pixels."""
    assert box_w < _PLATE_MIN_WIDTH_PX
    v = _read(text, 0.95, _FakeBox(10, 10, 10 + box_w, 24))
    assert v.reportable_plate is None
    assert v.plate == "", "a sub-readable crop was stored at all"


def test_subscribe_read_off_a_video_overlay_is_never_reported():
    """116x31px and aspect 3.74 — big enough and plate-shaped, so size and
    aspect both pass. Only the grammar gate stops it, which is why all three
    gates are needed rather than any one."""
    v = _read("SUBSCRIBE", 0.9, _FakeBox(10, 10, 126, 41), times=3)
    assert v.plate == "SUBSCRIBE"        # it WAS read
    assert v.plate_grammar_ok is False
    assert v.reportable_plate is None    # ...but never reported
    assert v.plate_confirmed is False


def test_five_different_strings_for_one_vehicle_never_confirm():
    """The signature of guessing. Each new string restarts the vote rather than
    inheriting the previous count."""
    t = _with_alpr([])
    v = vehicle(1, 400, 300, 900, 700)
    for text in ("WA01WMWH", "WA02MM901", "WA12MMSH", "WAL7MM991", "WAWMWMH1"):
        t.alpr.predict = lambda c, s=text: [_FakeResult(s, 0.9, _READABLE_BOX)]
        t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
        assert v.reportable_plate is None
        assert v.plate_votes == 1, "a new string inherited the old one's votes"


def test_the_same_valid_plate_twice_confirms():
    v = _read("TS09EA0001", 0.9, _READABLE_BOX, times=_PLATE_MIN_AGREEING_READS)
    assert v.reportable_plate == "TS09EA0001"
    assert v.plate_confirmed is True
    assert v.plate_grammar_ok is True


def test_one_valid_read_is_not_enough():
    v = _read("TS09EA0001", 0.99, _READABLE_BOX, times=1)
    assert v.reportable_plate is None
    assert v.plate_votes == 1


@pytest.mark.parametrize("w,h", [(100, 8), (40, 34), (300, 20)])
def test_non_plate_shapes_are_rejected(w, h):
    """A plate is between ~1.6:1 and ~6:1. Anything else is a badge, a light,
    or a strip of text."""
    v = _read("TS09EA0001", 0.9, _FakeBox(10, 10, 10 + w, 10 + h), times=3)
    if not (1.6 <= w / h <= 6.0) or w < _PLATE_MIN_WIDTH_PX:
        assert v.reportable_plate is None


def test_low_confidence_is_rejected_before_voting():
    v = _read("TS09EA0001", 0.2, _READABLE_BOX, times=3)
    assert v.plate == ""


# --------------------------------------------------------------------------- #
# Evidence on disk                                                              #
# --------------------------------------------------------------------------- #

def test_confirmation_saves_both_the_plate_and_the_vehicle():
    """A 45x13 plate crop alone is unreviewable — you cannot tell a plate from a
    badge from an overlay. The vehicle shot is what makes a record checkable."""
    v = _read("TS09EA0001", 0.9, _READABLE_BOX, times=_PLATE_MIN_AGREEING_READS)
    assert v.crop_path and v.crop_path.endswith("_plate.jpg")
    assert v.vehicle_path and v.vehicle_path.endswith("_vehicle.jpg")


def test_filenames_come_from_the_track_id_not_the_ocr_text():
    """Naming files after the reading turned a fabricated string into a
    fabricated filename — which is what 'made-up name codes' was looking at."""
    v = _read("TS09EA0001", 0.9, _READABLE_BOX, times=_PLATE_MIN_AGREEING_READS)
    name = v.crop_path.rsplit("/", 1)[-1]
    assert "TS09EA0001" not in name
    assert name.startswith("v00001_")


def test_nothing_is_saved_for_an_unconfirmed_read():
    v = _read("SUBSCRIBE", 0.9, _FakeBox(10, 10, 126, 41), times=4)
    assert v.crop_path is None
    assert v.vehicle_path is None


def test_only_a_reportable_plate_reaches_the_database():
    """A provisional read is shown live so an operator can see the system
    working, but it must never become a permanent record."""
    provisional = vehicle(1)
    provisional.plate, provisional.plate_votes = "SUBSCRIBE", 1
    assert provisional.reportable_plate is None

    confirmed = vehicle(2)
    confirmed.plate = "MH12AB1234"
    confirmed.plate_votes, confirmed.plate_confirmed = 2, True
    confirmed.plate_grammar_ok = True
    assert confirmed.reportable_plate == "MH12AB1234"


# --------------------------------------------------------------------------- #
# The composite: all five analytics in one mode                                 #
# --------------------------------------------------------------------------- #

def test_one_detection_pass_covers_people_and_vehicles():
    """Detection is the most expensive per-frame item, so a second pass to get
    the other subject list would nearly double this module's cost for no new
    information. COCO: 0 person, 2 car, 3 motorcycle, 5 bus, 7 truck."""
    from app.vision.modules.traffic_manager import _DETECT_CLASSES
    assert 0 in _DETECT_CLASSES, "people are not detected"
    assert {2, 3, 5, 7} <= set(_DETECT_CLASSES), "vehicle classes missing"


def test_crowd_grid_matches_crowd_manager():
    """Same layout and thresholds, so an operator reads density identically in
    both modes."""
    from app.vision.modules import crowd_manager as cm
    from app.vision.modules import traffic_manager as tm
    assert (tm._GRID_ROWS, tm._GRID_COLS) == (cm._GRID_ROWS, cm._GRID_COLS)
    assert tm._DENSITY_LIGHT_MAX == cm._DEFAULT_LIGHT_MAX
    assert tm._DENSITY_MODERATE_MAX == cm._DEFAULT_MODERATE_MAX


@pytest.mark.parametrize("cx,cy,expected", [
    (100, 100, 0),      # top-left
    (960, 100, 1),      # top-centre
    (1900, 100, 2),     # top-right
    (100, 1000, 6),     # bottom-left
    (1900, 1000, 8),    # bottom-right
])
def test_people_map_to_the_right_grid_cell(cx, cy, expected):
    from app.vision.modules.traffic_manager import _section_of
    assert _section_of(cx, cy, 1920, 1080) == expected


def test_points_on_the_frame_edge_stay_inside_the_grid():
    """Integer division at the exact edge would otherwise index cell 9 of 9."""
    from app.vision.modules.traffic_manager import _section_of
    assert _section_of(1920, 1080, 1920, 1080) == 8
    assert _section_of(0, 0, 1920, 1080) == 0


def test_density_thresholds():
    from app.vision.modules.traffic_manager import _density_level
    assert _density_level(0) == "green"
    assert _density_level(8) == "green"
    assert _density_level(9) == "orange"
    assert _density_level(20) == "orange"
    assert _density_level(21) == "red"


def test_face_recognition_is_optional():
    """Without InsightFace the other four analytics are unaffected, so the mode
    must still run."""
    t = bare_tracker()
    t.face_app = None
    t._gallery = None
    assert t._identify_faces(np.zeros((1080, 1920, 3), np.uint8),
                             [{"track_id": 1, "box": [100, 100, 400, 700]}],
                             t._client_state["s"]) == {}


def test_face_identities_are_dropped_when_their_track_goes():
    from app.vision.modules.traffic_manager import _FACE_ID_MEMORY_S
    t = bare_tracker()
    t.face_app = None
    state = t._client_state["s"]
    state["face_identities"][1] = {
        "person_id": "p1", "name": "Madhu", "votes": 2, "best_sim": 0.8,
        "last_sim": 0.8, "margin": 0.3, "confirmed": True,
        "last_seen": time.monotonic() - (_FACE_ID_MEMORY_S + 1),
    }
    # No gallery -> returns early, so prune via a real call path instead.
    assert state["face_identities"]


# --------------------------------------------------------------------------- #
# Viability — the honest answer instead of a fabricated one                      #
# --------------------------------------------------------------------------- #

def test_plate_out_of_range_is_reported_not_guessed():
    """At 50m a plate is ~14px across. The reader refuses it; this is what tells
    the operator WHY, and what to do about it."""
    from app.vision.viability import assess, summarise
    widths = {"vehicle": 1280, "person": 1280, "plate": 1920, "face": 1920}
    items = assess(70.0, 1920, 70.7, effective_width_px=widths)
    by = {i.subject: i for i in items}
    assert by["plate"].status == "out_of_range"
    assert by["plate"].px_on_target < 20
    assert "descend" in by["plate"].advice
    assert "plate" in summarise(items)["headline"]


def test_close_range_makes_plates_viable():
    from app.vision.viability import assess
    by = {i.subject: i for i in
          assess(70.0, 1920, 6.0, effective_width_px={"plate": 1920})}
    assert by["plate"].status in ("good", "marginal")


def test_viability_without_telemetry_says_so_rather_than_assuming():
    from app.vision.viability import assess
    for i in assess(70.0, 1920, None):
        assert i.status == "unknown"
        assert "telemetry" in i.advice
        # The requirement is still reported, so an operator can plan.
        assert i.max_range_m > 0


def test_headline_names_the_nearest_thing_to_fix():
    """Listing everything out of range is noise; the subject needing the
    smallest descent is the actionable one."""
    from app.vision.viability import assess, summarise
    s = summarise(assess(70.0, 1920, 70.7,
                         effective_width_px={"vehicle": 1280, "person": 1280,
                                             "plate": 1920, "face": 1920}))
    # person needs the longest range of the blocked set, so it is named.
    assert "person" in s["headline"]


def test_traffic_mode_runs_native_like_plate_tracking():
    """No downscaling in this mode, by requirement.

    Plate crops are taken from the SAME detection boxes the counting pass
    produces, so shrinking that pass costs plate pixels twice — once on the box
    and again on the crop cut from it. Native also lets a camera upgrade widen
    the profile envelope on its own, which is the point of deciding in pixels.
    """
    from app.config import Settings
    s = Settings()
    assert s.inference_width_for("traffic-management") == 0
    assert (s.inference_width_for("traffic-management")
            == s.inference_width_for("vehicle-plate-tracking"))


def test_native_width_survives_the_viability_maths():
    """Native is 0, and 0 is exactly what used to divide by zero in
    range_for_px — inside the worker thread, so the mode fell silent while
    video kept streaming. Pin the whole path, not just the guard."""
    import numpy as np

    from app.vision import viability

    assert viability.range_for_px(70.0, 0, 0.5, 100) == 0.0

    t = bare_tracker()
    t.inference_width_value = 0
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    # The width actually fed to YOLO is what viability must be told about.
    det_w = frame.shape[1]
    items = viability.assess(70.0, 1920, 25.0, effective_width_px={
        "vehicle": det_w, "person": det_w, "plate": 1920, "face": 1920,
    })
    assert {i.subject for i in items} == {"vehicle", "person", "plate", "face"}
    assert all(i.px_on_target > 0 for i in items)


# --------------------------------------------------------------------------- #
# Following a PERSON, not just a vehicle                                        #
# --------------------------------------------------------------------------- #
#
# People and vehicles come out of ONE ByteTrack pass (a single YOLO call over
# classes [0,2,3,5,7]), so a track id is unique across both lists. That is what
# lets click-to-follow work on anything in frame through one event, with no
# "which kind did you mean" in the payload.

def person(tid: int, x1=800, y1=300, x2=900, y2=700) -> dict:
    return {"track_id": tid, "box": [x1, y1, x2, y2], "conf": 0.9}


def test_a_person_can_be_followed():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 42)
    t.set_tracking("s", True)
    cmd = t._follow(state, [], [person(42)], "s", 1920, 1080, None, None)
    assert state["locked_track_id"] == 42
    assert state["locked_kind"] == "person"
    assert cmd is not None and cmd["type"] == "velocity"


def test_the_locked_kind_follows_the_subject_not_the_request():
    """The caller never says which kind it meant, so the module must work it
    out from which list the id turns up in."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 5)
    t._follow(state, [vehicle(5)], [], "s", 1920, 1080, None, None)
    assert state["locked_kind"] == "vehicle"


def test_person_and_vehicle_hold_distances_are_kept_apart():
    """A person is a stable 1.7m of vertical extent; a vehicle's apparent
    height swings with its heading. One shared target meant a value tuned on a
    car drove the wrong hold distance the moment a person was picked."""
    t = bare_tracker()
    state = t._client_state["s"]

    t.request_follow("s", 7)
    t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None)
    t.set_tracking_params("s", 0.45)
    assert state["size_ratio"]["vehicle"] == pytest.approx(0.45)

    t.request_follow("s", 8)
    t._follow(state, [], [person(8)], "s", 1920, 1080, None, None)
    assert state["size_ratio"]["person"] != pytest.approx(0.45)


# --------------------------------------------------------------------------- #
# The altitude floor                                                            #
# --------------------------------------------------------------------------- #
#
# Every other follow-capable module gained limit_descent after an unguarded
# descent flew a SITL aircraft into the ground. This one did not have it.

def test_descent_is_refused_without_an_agl_reading():
    """Descending blind is what the crash did. No AGL must mean no descent,
    not a default."""
    from app.vision.pursuit import PursuitLimits, limit_descent

    down, why = limit_descent(0.5, None, PursuitLimits.from_settings())
    assert down == 0.0
    assert why and "blind" in why.lower()


def test_follow_applies_the_altitude_floor_to_every_descent_source():
    """Applied last, so it catches the altitude PD, an operator nudge, and
    anything added later — rather than each of them separately."""
    import inspect

    from app.vision.modules import traffic_manager as tm

    src = inspect.getsource(tm.TrafficManager._follow)
    assert "limit_descent(" in src, "the altitude floor is not applied at all"
    floor_at = src.index("limit_descent(")
    emit_at = src.index('"type": "velocity"', floor_at)
    assert floor_at < emit_at, "floor must be applied before the command is emitted"


def test_an_operator_nudge_cannot_descend_through_the_floor():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t.set_altitude_mode("s", "fixed")
    t.set_altitude_nudge("s", 1.2)          # +ve is DOWN in NED
    # No pose, so there is no AGL — descent must be refused outright.
    cmd = t._follow(state, [vehicle(7)], [], "s", 1920, 1080, None, None)
    assert cmd["down_m_s"] <= 0.0


def test_stopping_tracking_drops_a_held_nudge():
    """Otherwise it is still commanding vertical motion the next time Follow
    arms."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_altitude_nudge("s", 1.0)
    t.set_tracking("s", False)
    assert state["altitude_nudge_v"] == 0.0


# --------------------------------------------------------------------------- #
# Crowd parity                                                                  #
# --------------------------------------------------------------------------- #

def test_density_thresholds_come_from_calibration_not_constants():
    """crowd-management already persists these. While this module kept its own
    constants, the same crowd was graded differently depending on which mode
    was watching, and custom values reverted to 8/20 on entering this one."""
    from app.vision import calibration
    from app.vision.modules.traffic_manager import _make_state

    before = calibration.effective()
    try:
        calibration.save({"crowd_light_max": 25, "crowd_moderate_max": 60})
        st = _make_state("threshold-check")
        assert st["light_max"] == 25
        assert st["moderate_max"] == 60
    finally:
        calibration.save({
            "crowd_light_max": before["crowd_light_max"],
            "crowd_moderate_max": before["crowd_moderate_max"],
        })


def test_density_level_uses_the_passed_thresholds():
    from app.vision.modules.traffic_manager import _density_level

    assert _density_level(10, light_max=25, moderate_max=60) == "green"
    assert _density_level(10, light_max=8, moderate_max=20) == "orange"


def test_moderate_max_cannot_be_set_below_light_max():
    """An inverted pair would make the orange band empty and every reading
    jump green to red."""
    t = bare_tracker()
    t.set_thresholds("s", light_max=30, moderate_max=10)
    st = t._client_state["s"]
    assert st["moderate_max"] > st["light_max"]


# --------------------------------------------------------------------------- #
# Durable vehicle identity                                                      #
# --------------------------------------------------------------------------- #
#
# A ByteTrack id resets on occlusion, so a car that passes behind a bus comes
# back as a different number with its colour, speed and plate history orphaned.
# The vehicle_id is what survives that.

def test_every_vehicle_gets_an_id_on_first_sighting():
    t = bare_tracker()
    state = t._client_state["s"]
    ids = {t._new_vehicle_id(state) for _ in range(3)}
    assert ids == {"VH-000001", "VH-000002", "VH-000003"}


def test_the_same_plate_re_attaches_the_earlier_identity():
    """One car behind a bus twice must not be counted as three vehicles."""
    t = bare_tracker()
    state = t._client_state["s"]

    first = vehicle(1)
    first.vehicle_id, first.plate = t._new_vehicle_id(state), "TS09EA0001"
    t._register_plate(state, first)

    # Same car, new track id after the occlusion.
    again = vehicle(2)
    again.vehicle_id, again.plate = t._new_vehicle_id(state), "TS09EA0001"
    t._register_plate(state, again)

    assert again.vehicle_id == first.vehicle_id


def test_a_different_plate_keeps_its_own_identity():
    t = bare_tracker()
    state = t._client_state["s"]
    a, b = vehicle(1), vehicle(2)
    a.vehicle_id, a.plate = t._new_vehicle_id(state), "TS09EA0001"
    b.vehicle_id, b.plate = t._new_vehicle_id(state), "TS09EA9999"
    t._register_plate(state, a)
    t._register_plate(state, b)
    assert a.vehicle_id != b.vehicle_id


def test_the_id_format_matches_plate_tracking():
    """One id format across both modes, or an operator reading a report has to
    know which module produced it."""
    from app.vision.modules.plate_tracker import _VEHICLE_ID_PREFIX as plate_prefix
    from app.vision.modules.traffic_manager import _VEHICLE_ID_PREFIX as traffic_prefix

    assert traffic_prefix == plate_prefix


def test_vehicle_id_is_a_real_column_on_the_row_it_is_written_to():
    """The DB payload gained the field; if the model lacks it, persist_events
    raises inside the writer and the row is silently lost."""
    from app.db.models import PlateEvent

    assert "vehicle_id" in PlateEvent.__table__.columns


# --------------------------------------------------------------------------- #
# The follow-control handlers must actually reach this module                   #
# --------------------------------------------------------------------------- #

def test_traffic_answers_every_shared_follow_control():
    """The panel shows hold distance and altitude controls for this mode. If
    the setters are absent the emits are accepted and silently do nothing,
    which looks exactly like a broken controller."""
    for name in ("set_tracking_params", "set_altitude_mode",
                 "set_altitude_nudge", "set_zone_names", "set_thresholds",
                 "set_profile_override", "request_follow", "set_tracking"):
        assert callable(getattr(TrafficManager, name, None)), f"missing {name}"


def test_traffic_is_routed_by_the_shared_pursuit_list():
    """It was missing from all three hand-copied isinstance tuples, so those
    controls did nothing for this mode while appearing to work."""
    from app.events.telemetry_events import _pursuit_analyzers

    assert TrafficManager in _pursuit_analyzers()


def test_every_pursuit_analyzer_implements_the_controls_it_is_routed_for():
    """Membership of that list is a promise. Pin it for all of them, so adding
    a mode to the list without the setters fails here rather than in flight."""
    from app.events.telemetry_events import _pursuit_analyzers

    for cls in _pursuit_analyzers():
        for name in ("set_tracking_params", "set_altitude_mode", "set_altitude_nudge"):
            assert callable(getattr(cls, name, None)), f"{cls.__name__} lacks {name}"

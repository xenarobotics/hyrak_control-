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
    _PLATE_MIN_WIDTH_PX, _FLOW_STRIKES_TO_FLAG, _READ_ARCHIVE_MAX,
    TrafficManager, _Vehicle, _make_state,
)


def vehicle(tid: int, x1=100, y1=100, x2=400, y2=350, vtype="car") -> _Vehicle:
    return _Vehicle(tid, [x1, y1, x2, y2], vtype)


def bare_tracker() -> TrafficManager:
    t = TrafficManager.__new__(TrafficManager)
    t.alpr = None
    t._client_state = {"s": _make_state("test-traffic")}
    # BaseAnalyzer.unregister_client (reached via super()) reads these, and
    # __new__ skips __init__. Only the session-end flush tests need them, but
    # setting them here keeps bare_tracker() a complete-enough stand-in —
    # same shape as test_plate_tracker's fixture.
    t._clients = {}
    t._inflight = set()
    t._contexts = {}
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


def test_a_settled_read_stops_consuming_budget():
    """SETTLED, not merely confirmed — big AND confident AND agreed.

    Confidence alone cannot be the bar (invented reads scored 1.00) and
    agreement alone cannot either: a vehicle first seen far away confirms a
    50px plate and would then never be re-read, throwing away the 200px look
    it gives two seconds later. Only a reading with nothing left to win frees
    the budget."""
    t = bare_tracker()
    done = vehicle(1)
    done.plate, done.plate_conf, done.plate_px_w = "TS09EA0001", 0.95, 160
    done.plate_votes, done.plate_confirmed, done.plate_grammar_ok = 2, True, True
    pending = vehicle(2, 500, 100, 900, 400)
    picked = t._ocr_candidates(t._client_state["s"], [done, pending], budget=_OCR_CALLS_PER_FRAME)
    assert [v.track_id for v in picked] == [2]
    assert done.read_settled is True
    assert done.needs_ocr is False


def test_a_small_confirmed_read_keeps_its_place_in_the_queue():
    """The whole point of re-reading: a vehicle first seen at distance must
    not be finished with just because two frames agreed on a tiny plate."""
    far = vehicle(1)
    far.plate, far.plate_conf, far.plate_px_w = "TS09EA0001", 0.95, 55
    far.plate_votes, far.plate_confirmed = 2, True
    assert far.read_settled is False
    assert far.needs_ocr is True


def test_high_confidence_alone_does_not_stop_the_budget():
    """A single 1.00-confidence read is exactly what a fabricated plate looks
    like, so it must not end the search."""
    v = vehicle(1)
    v.plate, v.plate_conf, v.plate_votes = "SUBSCRIBE", 1.0, 1
    assert v.needs_ocr is True
    assert v.plate_strong is False


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


class _StubAlpr:
    """A fixed ALPR result set, swapped in between reads so one test can walk
    a vehicle through a sequence of looks at its plate."""

    def __init__(self, results):
        self._results = results

    def predict(self, crop):
        return self._results


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


def test_the_overlay_draws_nothing_positional_free():
    """Only POSITIONAL marks belong on the picture — a box is there because it
    points at something in the frame. Counts, the density grid and the
    telemetry/ALPR warnings moved to the panel, where they are readable
    without squinting through the video they were covering.

    With no subjects in frame the overlay must therefore leave it untouched."""
    t = bare_tracker()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(frame, {"vehicles": [], "people": [], "has_telemetry": False,
                           "vehicles_in_frame": 0, "vehicle_count_unique": 0,
                           "person_count": 0, "viability_headline": "plate out of range"})
    assert not frame.any(), "something non-positional was burned into the video"


def test_the_density_grid_is_not_drawn_even_with_people_in_frame():
    """Inherited from crowd-management, where a grid answers "which zone is
    busiest" over a venue held station above. Traffic is watched moving, and
    the tinted cells sat on top of the subjects being followed."""
    t = bare_tracker()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(frame, {
        "vehicles": [], "people": [], "person_count": 7,
        "section_counts": {0: 4, 4: 3}, "section_grid": [3, 3],
    })
    assert not frame.any(), "the density grid is still being drawn"


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
    # 1280. Native was tried and measured 40ms/frame on this GPU against a
    # 17ms 1280 pass — 19.8 fps analysed under 30 fps video, which showed up as
    # annotations jumping every other frame. Plate quality is unaffected: OCR
    # crops come from the full-resolution frame, not the resized copy.
    assert Settings().inference_width_for(TrafficManager.MODE) == 1280


# --------------------------------------------------------------------------- #
# Fabricated plates — where the protection actually lives now                   #
# --------------------------------------------------------------------------- #
#
# Every string named below is a real one this module logged: WA01WMWH,
# WA02MM901, WA12MMSH, WAL7MM991 for the same vehicle on consecutive frames,
# plus SUBSCRIBE read off a video overlay. The failure is silent — OCR does not
# error at 45px, it returns something plausible.
#
# The first fix was a hard 70px floor on measured plate width. That worked and
# was wrong: on real footage from this rig plates arrive 31-79px wide, so the
# floor rejected nearly every genuine plate. The fabricated crops were 40-50px.
# The two populations OVERLAP, which is why no width or area threshold can
# separate them — a fact worth stating plainly, because it is the reason the
# gate had to move rather than be retuned.
#
# So protection moved UPSTREAM and became geometric: vision/profiles.py will
# not spend an OCR call at all unless the lens and slant range put ~70px on a
# plate. The 40-50px regime is never reached, rather than being reached and
# then argued with. The tests below pin BOTH halves — that the reader now keeps
# a weak reading, and that the profile is what stops it being asked for one.

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
def test_small_crops_are_kept_but_marked_weak(text, box_w):
    """These widths overlap the 31-79px band real plates arrive in, so
    discarding them threw away genuine reads in order to catch fabricated ones.

    They are kept now with their width recorded, so a weak reading can be
    judged rather than silently destroyed. What stops the reader being ASKED
    to look at a 45px plate is the profile gate, tested next."""
    v = _read(text, 0.95, _FakeBox(10, 10, 10 + box_w, 24))
    assert v.plate == text
    assert v.plate_px_w == box_w
    assert v.plate_strong is False, "a single read must not look confirmed"


def test_plate_reads_are_attempted_at_any_range_and_marked_weak():
    """THE GEOMETRIC GUARD IS GONE, BY OPERATOR DECISION. Recorded plainly
    because it is a real loosening, not a refactor.

    profiles.py used to refuse the OCR call when the range put fewer than
    ~70px on a plate, which is the regime that produced WA01WMWH. It no longer
    does: a pixel count is a threshold on a continuum, reads a little under it
    do sometimes come back correct, and refusing guarantees nothing.

    What replaces it is reviewability rather than prevention — every accepted
    read is saved as a photograph beside its text, and its pixel width, vote
    count and grammar travel with it, so a wrong reading is visible and
    correctable instead of being an unfalsifiable row. The trade is deliberate:
    more weak readings, none of them silently lost, all of them checkable."""
    from app.vision import viability
    from app.vision.profiles import ProfileSelector

    W, HFOV = 1920, 70.0
    far = viability.range_for_px(HFOV, W, 0.50, 45)
    items = [i.to_dict() for i in viability.assess(
        HFOV, W, far,
        effective_width_px={k: W for k in ("vehicle", "person", "plate", "face")},
    )]
    profile = ProfileSelector().select(items)
    assert profile.attempting("plate")
    assert profile.ocr_calls >= 1
    d = profile.subjects["plate"]
    assert d.px_on_target < d.px_needed
    assert "weak" in d.reason, "a sub-guide read must still be presented as weak"


def test_specks_are_still_rejected_outright():
    """Relaxing is not removing. The area floor came down 500 -> 150, but not
    to zero: below that the crop is a smear the detector should not have
    proposed, and passing it on yields strings unrelated to any plate."""
    v = _read("TS09EA0001", 0.95, _FakeBox(10, 10, 30, 16))   # 20x6 = 120px^2
    assert v.plate == ""


def test_a_crop_that_used_to_be_rejected_now_reads():
    """The point of the change, in the band that actually matters: 40x12 is
    480px^2 — under the old 500 floor, over the new 150 one."""
    v = _read("TS09EA0001", 0.5, _FakeBox(10, 10, 50, 22))
    assert v.plate == "TS09EA0001"
    assert v.plate_px_w == 40
    assert v.plate_strong is False, "one read must still not look confirmed"


def test_subscribe_read_off_a_video_overlay_is_reported_but_flagged():
    """116x31px and aspect 3.74 — plate-shaped and large, so no size gate ever
    caught this one; only grammar did.

    Grammar is a FLAG now rather than a filter, because it has to be: the real
    captured plate "719257C" is not Indian-format either, and suppressing on
    grammar discarded that too. So SUBSCRIBE is reported with
    plate_grammar_ok False for the UI to tone — the price of not throwing away
    valid foreign plates."""
    v = _read("SUBSCRIBE", 0.9, _FakeBox(10, 10, 126, 41), times=3)
    assert v.plate == "SUBSCRIBE"
    assert v.plate_grammar_ok is False
    assert v.reportable_plate == "SUBSCRIBE"


def test_a_valid_non_indian_plate_is_not_suppressed():
    """The read that motivated dropping grammar-as-a-filter: a real plate off
    this rig that fails _INDIA_PLATE_RE."""
    v = _read("719257C", 0.9, _READABLE_BOX, times=2)
    assert v.reportable_plate == "719257C"
    assert v.plate_grammar_ok is False
    assert v.plate_strong is True
    # It CONFIRMS too. This line previously asserted the opposite, which was
    # pinning a defect rather than a decision — see
    # test_a_valid_foreign_plate_confirms_and_stops_burning_budget.
    assert v.plate_confirmed is True


def test_five_different_strings_for_one_vehicle_never_confirm():
    """The signature of guessing. Each new string restarts the vote rather than
    inheriting the previous count."""
    t = _with_alpr([])
    v = vehicle(1, 400, 300, 900, 700)
    for text in ("WA01WMWH", "WA02MM901", "WA12MMSH", "WAL7MM991", "WAWMWMH1"):
        t.alpr.predict = lambda c, s=text: [_FakeResult(s, 0.9, _READABLE_BOX)]
        t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
        assert v.plate_strong is False, "guessing must never look confirmed"
        assert v.plate_votes == 1, "a new string inherited the old one's votes"


def test_the_same_valid_plate_twice_confirms():
    v = _read("TS09EA0001", 0.9, _READABLE_BOX, times=_PLATE_MIN_AGREEING_READS)
    assert v.reportable_plate == "TS09EA0001"
    assert v.plate_confirmed is True
    assert v.plate_grammar_ok is True


def test_one_valid_read_is_reported_but_not_strong():
    """A vehicle crossing frame at speed often gives exactly one readable look
    at its plate. Requiring a second discarded the only read that would ever
    exist, and the operator saw an empty log."""
    v = _read("TS09EA0001", 0.99, _READABLE_BOX, times=1)
    assert v.reportable_plate == "TS09EA0001"
    assert v.plate_votes == 1
    assert v.plate_strong is False


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


def test_evidence_is_saved_for_a_single_frame_read():
    """A plate logged with no image cannot be checked by a human — the
    "plates recorded but no captures" complaint. The first accepted read now
    writes both images, not only a confirmed one."""
    v = _read("TS09EA0001", 0.9, _READABLE_BOX, times=1)
    assert v.crop_path and v.crop_path.endswith("_plate.jpg")
    assert v.vehicle_path and v.vehicle_path.endswith("_vehicle.jpg")


def test_every_vehicle_gets_a_row_plate_or_not():
    """One row per vehicle, matching vehicle-plate-tracking. Restricting rows
    to confirmed plates left the log silent about most of the traffic actually
    seen, since most vehicles never turn a readable plate toward an aircraft."""
    t = bare_tracker()

    plated = vehicle(1)
    plated.plate, plated.plate_votes, plated.plate_px_w = "MH12AB1234", 2, 88
    row = t._plate_event_row(plated)
    assert row["plate_text"] == "MH12AB1234"
    assert row["plate_px_w"] == 88

    bare = vehicle(2)
    row = t._plate_event_row(bare)
    assert row is not None, "a vehicle with no plate still deserves a record"
    assert row["plate_text"] == "", "NOT NULL column — empty string, not None"


def test_a_vehicle_is_only_written_once():
    t = bare_tracker()
    v = vehicle(1)
    assert t._plate_event_row(v) is not None
    assert t._plate_event_row(v) is None, "duplicate row for one vehicle"


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


def test_traffic_detection_width_leaves_headroom_for_30fps():
    """Measured on this GPU: 1280 costs 17ms/frame, native 1920 costs 40ms.
    At native the mode analysed 19.8 fps under 30 fps video and the overlay
    visibly stepped. The width has to leave room for the rest of the frame
    budget — colour, speed, OCR and faces all come out of the same 33ms."""
    from app.config import Settings
    s = Settings()
    w = s.inference_width_for("traffic-management")
    assert 0 < w <= 1280, "native here costs more than the frame budget allows"


def test_plate_quality_does_not_depend_on_the_detection_width():
    """The reason narrowing the pass is safe: OCR crops are cut from the
    full-resolution frame, never from the resized copy. If that ever changes,
    the width above starts costing plate pixels and must be revisited."""
    import inspect

    from app.vision.modules import traffic_manager as tm

    src = inspect.getsource(tm.TrafficManager._analyze_frame_blocking)
    assert "self._read_plate(frame_bgr," in src, \
        "OCR is no longer reading the full-resolution frame"


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


def test_a_valid_foreign_plate_confirms_and_stops_burning_budget():
    """Grammar must not gate confirmation, only describe it.

    While it did, "719257C" — a real plate off this rig — never confirmed
    however many frames agreed. Two consequences, both silent: the vehicle
    kept consuming OCR calls for the full 12 attempts, starving others; and it
    never re-attached its identity across an occlusion, so one car turned into
    several vehicle_ids."""
    v = _read("719257C", 0.9, _READABLE_BOX, times=_PLATE_MIN_AGREEING_READS)
    assert v.plate_grammar_ok is False, "premise: this plate fails the regex"
    assert v.plate_confirmed is True
    assert v.plate_strong is True
    # Confirmed but NOT settled: the crop was only 90px, so the vehicle stays
    # in the queue in case it offers a better look on the way past.
    assert v.needs_ocr is True


def test_a_foreign_plate_re_identifies_across_an_occlusion():
    """The second consequence: identity is attached on confirmation, so a
    plate that never confirms never merges its fragmented tracks."""
    t = bare_tracker()
    state = t._client_state["s"]

    first = vehicle(1)
    first.vehicle_id, first.plate = t._new_vehicle_id(state), "719257C"
    first.plate_votes = _PLATE_MIN_AGREEING_READS
    t._register_plate(state, first)

    again = vehicle(2)
    again.vehicle_id, again.plate = t._new_vehicle_id(state), "719257C"
    t._register_plate(state, again)

    assert again.vehicle_id == first.vehicle_id


def test_a_locked_person_in_frame_is_not_reported_as_lost():
    """Visibility used to be computed against the vehicle list alone, so a
    person standing in plain sight read as invisible and the lock decayed
    COASTING -> SEARCHING while the drone was tracking them perfectly."""
    import inspect

    from app.vision.modules import traffic_manager as tm

    src = inspect.getsource(tm.TrafficManager._analyze_frame_blocking)
    marker = src[src.index("lock_state_for("):]
    head = src[:src.index("lock_state_for(")]
    # The visibility expression must consult people, wherever it is built.
    assert 'p["track_id"] == locked_id' in head or 'p["track_id"] == locked_id' in marker, \
        "locked-subject visibility ignores the people list"


def test_lock_state_helper_agrees_that_visible_means_locked():
    """Guards the semantics the fix relies on: visible=True must not decay."""
    from app.vision.pursuit import lock_state_for

    state, _ = lock_state_for(visible=True, seconds_lost=0.0, tracking=True)
    assert state.value == "locked"


# --------------------------------------------------------------------------- #
# Session-end flush                                                             #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_vehicles_still_in_frame_are_written_when_the_session_stops():
    """A vehicle on screen when the operator hits stop never ages out of the
    registry, so without a flush its row is silently dropped — which from the
    outside is "ran a session, saw plates, nothing in the history afterward".
    vehicle-plate-tracking already flushed; this module did not, so the two
    lost different amounts of data from the same flight."""
    written: list = []

    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    v.plate, v.plate_votes, v.plate_px_w = "TS09EA0001", 2, 84
    state["vehicles"][1] = v

    import app.vision.persistence as persistence

    async def _capture(session_id, events):
        written.extend(events)

    original = persistence.persist_events
    persistence.persist_events = _capture
    try:
        await t.unregister_client("s")
    finally:
        persistence.persist_events = original

    assert len(written) == 1
    assert written[0]["plate_text"] == "TS09EA0001"
    assert written[0]["plate_px_w"] == 84


@pytest.mark.asyncio
async def test_the_flush_does_not_double_write_an_already_logged_vehicle():
    """`logged` is set inside _plate_event_row, the only path that builds one,
    so the retire loop and the flush cannot both emit the same vehicle."""
    written: list = []

    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    v.plate = "TS09EA0001"
    state["vehicles"][1] = v
    assert t._plate_event_row(v) is not None      # retired during the session

    import app.vision.persistence as persistence

    async def _capture(session_id, events):
        written.extend(events)

    original = persistence.persist_events
    persistence.persist_events = _capture
    try:
        await t.unregister_client("s")
    finally:
        persistence.persist_events = original

    assert written == []


def test_traffic_is_routed_by_the_shared_crowd_list():
    """This module borrows crowd-management's grid wholesale, but was routed
    to neither the zone-naming nor the threshold handler — so naming a zone or
    setting a custom density band did nothing here while the panel offered
    both."""
    from app.events.telemetry_events import _crowd_analyzers

    assert TrafficManager in _crowd_analyzers()


def test_every_crowd_analyzer_implements_the_grid_controls():
    from app.events.telemetry_events import _crowd_analyzers

    for cls in _crowd_analyzers():
        for name in ("set_zone_names", "set_thresholds"):
            assert callable(getattr(cls, name, None)), f"{cls.__name__} lacks {name}"


def test_arming_a_person_follow_reaches_the_analyzer():
    """FollowControls picks its arm event by subject KIND: a vehicle arms
    through set_vehicle_tracking, a person through set_tracking. In traffic
    mode a locked person therefore arms through set_tracking — which routed to
    three modules and not this one.

    The effect was the reported symptom: Offboard started on the aircraft,
    the analyzer never learned it was tracking, no commands were emitted, and
    clicking a person looked like a dead control."""
    import inspect

    from app.events import telemetry_events

    src = inspect.getsource(telemetry_events.register_telemetry_events)
    handler = src[src.index('@sio.on("set_tracking")'):]
    handler = handler[:handler.index("# Start/stop Offboard")]
    assert "_pursuit_analyzers()" in handler, \
        "set_tracking uses a hand-written tuple again — traffic will be dropped"
    assert TrafficManager in telemetry_events._pursuit_analyzers()


def test_every_pursuit_mode_reports_tracking_in_its_payload():
    """FollowControls reads `tracking` from the analyzer's payload rather than
    from a socket ack, because the two arm events reply with DIFFERENT status
    events (vehicle_tracking_status vs tracking_status) and each panel
    subscribed to whichever it remembered. Traffic listened for the vehicle one
    while arming a person through the other, so its button stayed on "Follow"
    while the aircraft was already chasing; crowd listened for neither.

    That fix only holds if every mode actually reports the field."""
    import inspect
    import re

    from app.events.telemetry_events import _pursuit_analyzers

    for cls in _pursuit_analyzers():
        src = inspect.getsource(inspect.getmodule(cls))
        assert re.search(r'"tracking":\s*', src), \
            f"{cls.__name__} never puts `tracking` in its payload"


def test_the_plate_bracket_is_stored_relative_to_its_vehicle():
    """Absolute plate coordinates are frozen at the moment of the read, and
    OCR runs on only a couple of vehicles per frame — so a moving vehicle's
    green bracket was drawn wherever its plate had been seconds earlier, and
    kept being drawn there while the vehicle's own box moved on and faded.

    Stored as fractions of the vehicle box, the overlay can re-derive it
    against the CURRENT box so it travels with the vehicle and leaves with it.
    """
    t = _with_alpr([_FakeResult("TS09EA0001", 0.9, _FakeBox(120, 190, 220, 215))])
    v = vehicle(7, 400, 300, 700, 540)
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])

    assert v.plate_box_rel is not None
    assert all(0.0 <= f <= 1.0 for f in v.plate_box_rel), \
        "the plate must sit inside the vehicle box it was read from"

    # Re-derived against a box further down the road, the bracket stays on the
    # vehicle instead of being left behind.
    for x1, y1, x2, y2 in ([900, 320, 1200, 560], [1500, 340, 1800, 580]):
        bw, bh = x2 - x1, y2 - y1
        f = v.plate_box_rel
        dx1, dy1 = x1 + f[0] * bw, y1 + f[1] * bh
        dx2, dy2 = x1 + f[2] * bw, y1 + f[3] * bh
        assert x1 <= dx1 <= dx2 <= x2
        assert y1 <= dy1 <= dy2 <= y2


# --------------------------------------------------------------------------- #
# Re-reading: keep the best look, not the first                                 #
# --------------------------------------------------------------------------- #

def test_a_vehicle_driving_closer_upgrades_its_own_reading():
    """A vehicle is first seen far away and small, so its FIRST reading is the
    worst one it will ever offer. Stopping there kept a 60px misread in
    preference to the 210px correct read the same car gave three seconds
    later.

    Re-reading while the vehicle can still beat itself is the fix; ranking by
    pixels x confidence is what decides which look wins."""
    t = bare_tracker()
    t._save_evidence = lambda *a, **k: None
    v = vehicle(1, 900, 400, 960, 448)

    approach = [
        (60, "T509EAO0O1", 0.42),     # far, misread
        (90, "TS09EA0O01", 0.55),
        (140, "TS09EA0001", 0.71),
        (210, "TS09EA0001", 0.88),    # closest, correct
    ]
    for pw, text, conf in approach:
        vw = pw * 6
        v.box = [900, 400, 900 + vw, 400 + int(vw * 0.8)]
        t.alpr = _StubAlpr([_FakeResult(text, conf, _FakeBox(10, 10, 10 + pw,
                                                             10 + int(pw / 3.6)))])
        t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])

    assert v.plate == "TS09EA0001"
    assert v.plate_px_w == 210
    assert v.plate_conf == pytest.approx(0.88)
    assert v.read_settled is True


def test_a_worse_later_look_never_regresses_the_record():
    """The car drives past and shrinks again. Its record must not follow it
    down — and the photo on disk must keep matching the numbers beside it."""
    t = bare_tracker()
    t._save_evidence = lambda *a, **k: None
    v = vehicle(1, 900, 400, 2160, 1408)

    t.alpr = _StubAlpr([_FakeResult("TS09EA0001", 0.88, _FakeBox(10, 10, 220, 68))])
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    best_px, best_conf = v.plate_px_w, v.plate_conf

    v.box = [900, 400, 1800, 1120]
    t.alpr = _StubAlpr([_FakeResult("TS09EA0001", 0.66, _FakeBox(10, 10, 160, 52))])
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])

    assert v.plate_px_w == best_px
    assert v.plate_conf == pytest.approx(best_conf)
    assert v.plate_votes >= 2, "a worse look is still independent agreement"


def test_a_bigger_read_beats_a_more_confident_small_one():
    """Confidence was the sole tie-breaker and it is the weaker signal: a model
    can be certain about characters that are not in the crop, but it cannot
    invent detail that is."""
    t = bare_tracker()
    t._save_evidence = lambda *a, **k: None
    v = vehicle(1, 900, 400, 2160, 1408)

    t.alpr = _StubAlpr([_FakeResult("AAA1111", 0.95, _FakeBox(10, 10, 70, 28))])
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    assert v.plate == "AAA1111"

    t.alpr = _StubAlpr([_FakeResult("TS09EA0001", 0.60, _FakeBox(10, 10, 230, 72))])
    t._read_plate(np.zeros((1080, 1920, 3), np.uint8), v, t._client_state["s"])
    assert v.plate == "TS09EA0001", "the bigger crop holds the real characters"


def test_the_queue_prefers_a_vehicle_that_has_grown():
    """Largest-first would re-read whichever big vehicle is nearest forever
    while a vehicle with no reading at all waits behind it."""
    t = bare_tracker()
    grown = vehicle(1, 0, 0, 600, 400)
    grown.plate, grown.plate_px_w, grown.plate_conf = "TS09EA0001", 60, 0.5
    grown.plate_quality, grown.read_area = 30.0, 60 * 40      # tiny when read
    unread = vehicle(2, 700, 0, 1000, 240)

    picked = t._ocr_candidates(t._client_state["s"], [grown, unread], budget=2)
    assert picked[0].track_id == 2, "an unread vehicle outranks a re-read"
    assert len(picked) == 2


def test_a_vehicle_that_has_not_grown_does_not_burn_a_call():
    """Re-reading the same near vehicle at the same size every frame learns
    nothing and starves the rest."""
    t = bare_tracker()
    same = vehicle(1, 0, 0, 600, 400)
    same.plate, same.plate_px_w, same.plate_conf = "TS09EA0001", 60, 0.5
    same.plate_quality, same.read_area = 30.0, same.area      # unchanged size
    assert t._ocr_candidates(t._client_state["s"], [same], budget=2) == []


# --------------------------------------------------------------------------- #
# Direction of travel, and driving against the local flow                       #
# --------------------------------------------------------------------------- #
#
# The velocity VECTOR was always computed by the speed fit; only its magnitude
# was ever published. What is tested here is the layer built on top of it: a
# vehicle is flagged only when it opposes traffic that genuinely agrees with
# itself, and only after holding that for long enough to rule out a wobble.

def _moving(tid, heading, kmh=40.0, x=500, y=500, w=200, h=140) -> _Vehicle:
    v = _Vehicle(tid, [x, y, x + w, y + h], "car")
    v.heading_deg, v.speed_kmh, v.speed_reliable = heading, kmh, True
    return v


def _run_flow(vehicles, frames=_FLOW_STRIKES_TO_FLAG, W=1920, H=1080):
    for _ in range(frames):
        TrafficManager._update_flow(vehicles, W, H)
    return vehicles


def test_a_vehicle_opposing_a_coherent_flow_is_flagged():
    """Four cars heading north and one heading south among them."""
    north = [_moving(i, 0.0, x=400 + i * 60) for i in range(4)]
    wrong = _moving(9, 180.0, x=700)
    _run_flow(north + [wrong])
    assert wrong.against_flow is True
    assert all(not v.against_flow for v in north)


def test_one_opposed_frame_is_not_enough():
    """A single frame of opposition is a tracker wobble, not a wrong way."""
    north = [_moving(i, 0.0, x=400 + i * 60) for i in range(4)]
    wrong = _moving(9, 180.0, x=700)
    _run_flow(north + [wrong], frames=1)
    assert wrong.against_flow is False, "a flag must be earned over time"


def test_no_flow_no_flag_at_a_junction():
    """Everyone turning is not a flow to be against. Four vehicles pointing
    four different ways have no coherent direction, so nothing is flagged —
    which is the difference between a useful alert and a nuisance one."""
    scattered = [_moving(i, d, x=400 + i * 60)
                 for i, d in enumerate((0.0, 90.0, 180.0, 270.0))]
    _run_flow(scattered)
    assert all(not v.against_flow for v in scattered)


def test_too_few_neighbours_never_flags():
    """Two cars passing each other on a quiet road is not evidence about
    either of them."""
    a, b = _moving(1, 0.0, x=400), _moving(2, 180.0, x=520)
    _run_flow([a, b])
    assert not a.against_flow and not b.against_flow


def test_a_divided_road_flags_nobody():
    """Both carriageways in frame at once, which is the ordinary case and the
    most likely source of a false alert. Nothing is flagged.

    Note what actually does the work at these numbers: with the two directions
    evenly matched there is no coherent flow to be against, so the coherence
    gate refuses to judge anyone. Locality is the guard for the UNEVEN case,
    which the next test pins separately."""
    up = [_moving(i, 0.0, x=100 + i * 50, y=800) for i in range(4)]
    down = [_moving(10 + i, 180.0, x=100 + i * 50, y=120) for i in range(4)]
    _run_flow(up + down)
    assert all(not v.against_flow for v in up + down)


def test_the_flow_a_vehicle_is_judged_against_is_a_LOCAL_one():
    """The same vehicle, the same headings, two positions — and only the one
    actually among that traffic is judged by it.

    Without a radius, a lone car anywhere in frame would be measured against a
    lane it is nowhere near, which on a divided road or across a junction is
    how a perfectly ordinary vehicle gets flagged."""
    lane = [_moving(i, 0.0, x=100 + i * 50, y=100) for i in range(4)]

    among = _moving(9, 180.0, x=180, y=100)
    _run_flow(lane + [among])
    assert among.against_flow is True

    far = _moving(9, 180.0, x=1700, y=900)
    _run_flow(lane + [far])
    assert far.against_flow is False, "not near that traffic, not judged by it"


def test_a_stationary_vehicle_contributes_no_heading():
    """Below the speed floor a heading is atan2 of box jitter — a uniformly
    random bearing that would poison the consensus if it were counted."""
    north = [_moving(i, 0.0, x=400 + i * 60) for i in range(4)]
    parked = _moving(9, 137.0, kmh=1.0, x=700)
    _run_flow(north + [parked])
    assert parked.against_flow is False


def test_rejoining_the_flow_clears_the_flag():
    north = [_moving(i, 0.0, x=400 + i * 60) for i in range(4)]
    wrong = _moving(9, 180.0, x=700)
    _run_flow(north + [wrong])
    assert wrong.against_flow is True
    wrong.heading_deg = 0.0
    _run_flow(north + [wrong], frames=_FLOW_STRIKES_TO_FLAG)
    assert wrong.against_flow is False


def test_direction_reaches_the_wire_and_the_row():
    """A wrong-way sighting that is not recorded cannot be reviewed, which is
    most of what makes it worth detecting."""
    t = bare_tracker()
    v = vehicle(1)
    v.heading_deg, v.against_flow = 271.5, True
    row = t._plate_event_row(v)
    assert row["heading_deg"] == 271.5
    assert row["against_flow"] is True


# --------------------------------------------------------------------------- #
# The reading survives an occlusion                                             #
# --------------------------------------------------------------------------- #

def test_a_returning_vehicle_gets_its_better_read_back():
    """Re-identification already restored the vehicle_id; what it did not
    restore was the READING. Entering frame means entering it small and far
    away, so this sighting's read is systematically the worse of the two —
    and the good one was discarded at exactly the moment it was proved to
    belong to the same vehicle."""
    t = bare_tracker()
    state = t._client_state["s"]

    first = vehicle(1, 900, 400, 2160, 1408)
    first.vehicle_id = "VH-000001"
    first.plate, first.plate_conf, first.plate_px_w = "TS09EA0001", 0.88, 210
    first.plate_quality = 210 * 0.88
    first.plate_votes, first.crop_path = 3, "/tmp/first_plate.jpg"
    state["plate_registry"]["TS09EA0001"] = "VH-000001"
    t._archive_read(state, first)

    # Comes back after an occlusion, small and far, as a new track id.
    again = vehicle(2, 100, 100, 220, 190)
    again.vehicle_id = "VH-000002"
    again.plate, again.plate_conf, again.plate_px_w = "TS09EA0001", 0.44, 55
    again.plate_quality = 55 * 0.44
    t._register_plate(state, again)

    assert again.vehicle_id == "VH-000001", "the identity is re-attached"
    assert again.plate_px_w == 210, "and so is the reading it was proved by"
    assert again.plate_conf == pytest.approx(0.88)
    assert again.crop_path == "/tmp/first_plate.jpg", "photo follows the numbers"
    assert again.plate_box_rel is None, "old geometry does not follow it"


def test_a_better_read_on_return_is_not_replaced_by_the_archive():
    """Only ever an upgrade: a car that returns CLOSER than it left keeps the
    new, better look."""
    t = bare_tracker()
    state = t._client_state["s"]

    far = vehicle(1, 100, 100, 220, 190)
    far.vehicle_id, far.plate = "VH-000001", "TS09EA0001"
    far.plate_conf, far.plate_px_w, far.plate_quality = 0.44, 55, 55 * 0.44
    state["plate_registry"]["TS09EA0001"] = "VH-000001"
    t._archive_read(state, far)

    near = vehicle(2, 900, 400, 2160, 1408)
    near.vehicle_id, near.plate = "VH-000002", "TS09EA0001"
    near.plate_conf, near.plate_px_w, near.plate_quality = 0.90, 240, 240 * 0.90
    t._register_plate(state, near)

    assert near.plate_px_w == 240
    assert near.plate_conf == pytest.approx(0.90)


def test_a_restored_settled_read_stops_spending_budget():
    """The point of carrying the reading back: a vehicle that already gave a
    settled plate before the occlusion does not have to earn it again."""
    t = bare_tracker()
    state = t._client_state["s"]

    first = vehicle(1, 900, 400, 2160, 1408)
    first.vehicle_id, first.plate = "VH-000001", "TS09EA0001"
    first.plate_conf, first.plate_px_w, first.plate_quality = 0.92, 210, 210 * 0.92
    first.plate_votes = 3
    state["plate_registry"]["TS09EA0001"] = "VH-000001"
    t._archive_read(state, first)

    again = vehicle(2, 100, 100, 260, 220)
    again.vehicle_id, again.plate = "VH-000002", "TS09EA0001"
    again.plate_conf, again.plate_px_w, again.plate_quality = 0.44, 55, 55 * 0.44
    again.plate_votes = 1
    assert again.needs_ocr is True
    t._register_plate(state, again)
    assert again.read_settled is True
    assert again.needs_ocr is False, "no budget spent re-proving a settled plate"


def test_the_archive_only_keeps_the_best_and_stays_bounded():
    t = bare_tracker()
    state = t._client_state["s"]

    good = vehicle(1)
    good.vehicle_id, good.plate = "VH-000001", "TS09EA0001"
    good.plate_px_w, good.plate_conf, good.plate_quality = 200, 0.9, 180.0
    t._archive_read(state, good)

    worse = vehicle(2)
    worse.vehicle_id, worse.plate = "VH-000001", "TS09EA0001"
    worse.plate_px_w, worse.plate_conf, worse.plate_quality = 50, 0.5, 25.0
    t._archive_read(state, worse)
    assert state["read_archive"]["VH-000001"]["px_w"] == 200

    for i in range(_READ_ARCHIVE_MAX + 25):
        v = vehicle(1000 + i)
        v.vehicle_id, v.plate = f"VH-{i:06d}", f"PLATE{i}"
        v.plate_px_w, v.plate_conf, v.plate_quality = 100, 0.8, 80.0
        t._archive_read(state, v)
    assert len(state["read_archive"]) <= _READ_ARCHIVE_MAX


def test_a_vehicle_with_no_plate_is_never_archived():
    """The archive is keyed on identity earned by a reading. Storing an empty
    one would let the next vehicle to reuse that id inherit nothing at best
    and a blank at worst."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    v.vehicle_id = "VH-000001"
    t._archive_read(state, v)
    assert state["read_archive"] == {}

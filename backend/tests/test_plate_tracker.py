"""
Vehicle / number-plate tracking — identify, tag, and follow ONE vehicle.

Detection and speed estimation are covered by their own tests; what is tested
here is the composition specific to this module: the persistent vehicle_id
(and re-identification via a re-read plate), the whole-frame + per-vehicle-crop
OCR sweep, colour bookkeeping, lock-and-follow, and DB retirement.

The section at the bottom, "Real captures from this rig", is the important one.
It pins the actual plate sizes and formats this hardware produces against the
gates that once rejected them — the regression that made the whole mode look
broken while every other test in this file still passed.

PlateTracker is built with __new__ to skip loading YOLO and fast-alpr; the
model is replaced with a stub that returns whatever boxes a test wants.
"""
import time

import numpy as np
import pytest

from app.vision.modules.plate_tracker import (
    _COLOUR_GOOD_ENOUGH, _MIN_PLATE_AREA, _OCR_MIN_CONF,
    _PLATE_AGREEMENT_STRONG, _VEHICLE_RETIRE_AFTER_S,
    PlateTracker, _Vehicle, _make_state,
)


def vehicle(tid: int, x1=100, y1=100, x2=400, y2=350, vtype="car",
            vehicle_id="VH-000001") -> _Vehicle:
    return _Vehicle(tid, vehicle_id, [x1, y1, x2, y2], vtype)


def plated_vehicle(tid: int = 1, vehicle_id="VH-000001") -> _Vehicle:
    """A vehicle anchored at the frame origin.

    The stubs below return the same plate box for every call, so anchoring the
    vehicle at 0,0 makes its crop origin 0,0 too — which makes whole-frame and
    crop coordinates coincide, so the stubbed plate lands inside this vehicle
    on both passes. With a vehicle box further into the frame the whole-frame
    pass produces a detection outside it, which is correctly treated as a
    plate belonging to no vehicle (_unmatched_vehicle) and would make these
    tests measure the orphan path rather than the one they name.
    """
    return _Vehicle(tid, vehicle_id, [0, 0, 400, 300], "car")


def bare_tracker() -> PlateTracker:
    t = PlateTracker.__new__(PlateTracker)
    t.alpr = None
    t._client_state = {"s": _make_state("test-plate")}
    # BaseAnalyzer.unregister_client (called via super()) reads these —
    # __new__ skips __init__, so only the tests that exercise
    # unregister_client actually need them, but setting them up here is
    # cheap and keeps bare_tracker() a complete-enough stand-in.
    t._clients = {}
    t._inflight = set()
    t._contexts = {}
    return t


# --------------------------------------------------------------------------- #
# fast-alpr stubs                                                               #
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


# A plate the size this rig actually produces: 64x31px. Well under the 70px
# floor a previous version enforced, and comfortably above _MIN_PLATE_AREA.
_REAL_BOX = _FakeBox(10, 10, 74, 41)


def _with_alpr(results, record=None):
    t = bare_tracker()

    class _Alpr:
        def predict(self, crop):
            if record is not None:
                record.append(crop.shape)
            return results
    t.alpr = _Alpr()
    return t


def _frame_only_alpr(results, full=(1080, 1920)):
    """Returns a hit ONLY on the whole-frame pass.

    Needed whenever a test cares which vehicle a detection is attributed to:
    the plain stub answers every crop with the same box, so each vehicle
    "finds" a plate inside its own crop and attribution cannot be observed.
    """
    t = bare_tracker()

    class _Alpr:
        def predict(self, img):
            return results if img.shape[:2] == full else []
    t.alpr = _Alpr()
    return t


def _crop_only_alpr(results, full=(1080, 1920)):
    """The mirror of _frame_only_alpr: a hit only on a per-vehicle crop, so a
    reported box must have had the crop's origin added back to be correct."""
    t = bare_tracker()

    class _Alpr:
        def predict(self, img):
            return [] if img.shape[:2] == full else results
    t.alpr = _Alpr()
    return t


def frame(h=1080, w=1920):
    return np.zeros((h, w, 3), dtype=np.uint8)


# --------------------------------------------------------------------------- #
# Persistent vehicle identity                                                   #
# --------------------------------------------------------------------------- #

def test_first_sighting_gets_its_own_id():
    t = bare_tracker()
    state = t._client_state["s"]
    a = t._new_vehicle_id(state)
    b = t._new_vehicle_id(state)
    assert a != b
    assert a.startswith("VH-")


def test_a_rereleased_plate_reattaches_the_earlier_identity():
    """A track that fragments (occlusion, a missed detection frame) and comes
    back gets a NEW track_id but the SAME plate. That must be recognised as
    the same vehicle rather than issued a brand new identity."""
    t = bare_tracker()
    state = t._client_state["s"]

    first = vehicle(1, vehicle_id=t._new_vehicle_id(state))
    first.plate = "719257C"
    t._register_plate(state, first)
    assert state["plate_registry"]["719257C"] == first.vehicle_id

    second = vehicle(2, vehicle_id=t._new_vehicle_id(state))
    second.plate = "719257C"
    t._register_plate(state, second)
    assert second.vehicle_id == first.vehicle_id, \
        "a re-read plate did not re-attach the earlier identity"


# --------------------------------------------------------------------------- #
# The OCR sweep: whole frame + one crop per vehicle                             #
# --------------------------------------------------------------------------- #

def test_every_vehicle_gets_its_own_call_plus_one_whole_frame_call():
    """No per-frame budget. The whole-frame call catches plates whose vehicle
    YOLO missed; the crops give a plate ~5x the pixels it would have after a
    1920-wide frame is letterboxed to 384. Both earn their keep."""
    calls = []
    t = _with_alpr([], record=calls)
    vs = [vehicle(i, x1=i * 400, x2=i * 400 + 300) for i in (1, 2, 3)]
    t._read_plates(frame(), vs, t._client_state["s"])
    assert len(calls) == 4, f"expected 1 whole-frame + 3 crops, got {len(calls)}"
    assert (1080, 1920, 3) in calls, "no whole-frame pass"


def test_a_small_vehicle_is_never_skipped():
    """fast-alpr letterboxes to 384 and so costs the same whatever it is
    given. A size pre-filter buys nothing and, set anywhere near the sizes
    this rig produces, silently means no OCR ever runs."""
    calls = []
    t = _with_alpr([], record=calls)
    t._read_plates(frame(), [vehicle(1, 0, 0, 60, 40)], t._client_state["s"])
    assert len(calls) == 2, "a small vehicle was skipped"


def test_reads_are_attached_to_the_vehicle_containing_them():
    # Whole-frame hit only, so attribution is observable: the box's centre
    # (52, 35) falls inside `left` and nowhere near `right`.
    t = _frame_only_alpr([_FakeResult("719257C", 0.9, _FakeBox(20, 20, 84, 51))])
    left = vehicle(1, 0, 0, 300, 300)
    right = vehicle(2, 1000, 500, 1400, 800)
    t._read_plates(frame(), [left, right], t._client_state["s"])
    assert left.plate == "719257C"
    assert right.plate == ""


def test_plate_box_is_returned_in_full_frame_coordinates():
    """The crop's origin has to be added back, or the overlay bracket draws in
    the wrong place and the logged box is meaningless."""
    # Only the crop pass returns a hit, so the box it reports MUST have had the
    # crop origin added back — that is exactly what is being checked.
    t = _crop_only_alpr([_FakeResult("719257C", 0.9, _FakeBox(20, 30, 84, 61))])
    v = vehicle(1, 800, 500, 1100, 700)
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == "719257C"
    # The crop starts near x=770 (box minus 10% padding), so the plate must
    # land well right of the frame origin.
    assert v.plate_box[0] > 700
    assert v.plate_box[1] > 400


def test_a_plate_with_no_vehicle_around_it_is_still_kept():
    """At range YOLO loses the car well before fast-alpr loses the plate.
    Dropping those readings was a large part of what went missing."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    state = t._client_state["s"]
    t._read_plates(frame(), [], state)          # no vehicles at all
    assert len(state["plate_only"]) == 1
    orphan = next(iter(state["plate_only"].values()))
    assert orphan.plate == "719257C"
    assert orphan.vehicle_id.startswith("VH-")
    assert orphan.type == "unknown", "type was guessed rather than left unknown"
    assert orphan.track_id < 0, "plate-only ids must not collide with ByteTrack"


def test_an_orphan_plate_across_frames_stays_one_identity():
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    state = t._client_state["s"]
    for _ in range(4):
        t._read_plates(frame(), [], state)
    assert len(state["plate_only"]) == 1, "one plate fragmented into several"


# --------------------------------------------------------------------------- #
# Reading quality: measured, not enforced                                       #
# --------------------------------------------------------------------------- #

def test_specks_are_rejected_but_small_plates_are_not():
    tiny = _with_alpr([_FakeResult("719257C", 0.9, _FakeBox(0, 0, 10, 10))])
    v = plated_vehicle()
    tiny._read_plates(frame(), [v], tiny._client_state["s"])
    assert 10 * 10 < _MIN_PLATE_AREA
    assert v.plate == "", "a 10x10 speck was accepted as a plate"


def test_low_confidence_is_rejected():
    t = _with_alpr([_FakeResult("719257C", _OCR_MIN_CONF - 0.1, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == ""


def test_per_character_confidence_lists_are_averaged():
    """Some OCR models return a list per character; a list is not a float and
    comparing it to a threshold would raise."""
    t = _with_alpr([_FakeResult("719257C", [0.8, 0.9, 0.7], _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate_conf == pytest.approx(0.8, abs=0.01)


def test_a_weaker_read_does_not_overwrite_a_stronger_one():
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate_conf == pytest.approx(0.9)

    t.alpr.predict = lambda crop: [_FakeResult("KI9257C", 0.6, _REAL_BOX)]
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == "719257C", "a weaker read overwrote a stronger one"


def test_a_new_string_restarts_the_vote_rather_than_inheriting():
    """One vehicle yielding five different strings is the signature of
    guessing. Inheriting the count is what once made that look settled."""
    t = _with_alpr([])
    v = plated_vehicle()
    for text in ("719257C", "KI9257C", "FA19257C", "TTP2504"):
        t.alpr.predict = lambda c, s=text: [_FakeResult(s, 0.95, _REAL_BOX)]
        t._read_plates(frame(), [v], t._client_state["s"])
        assert v.plate_votes == 1, "a new string inherited the old one's votes"


def test_one_frame_counts_as_one_vote_not_one_per_pass():
    """The whole-frame and crop passes usually both see the same plate, but
    they are the same photons — not independent corroboration. Counting both
    let a SINGLE frame mark its own reading corroborated, defeating the point
    of the vote entirely."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate_votes == 1, "one frame scored more than one vote"
    assert v.plate_strong is False


def test_the_best_pass_of_a_frame_is_the_one_kept():
    """Both passes see the plate; the crop pass usually reads it better. The
    stronger of the two is what should survive."""
    t = bare_tracker()
    full = (1080, 1920)

    class _Alpr:
        def predict(self, img):
            if img.shape[:2] == full:
                return [_FakeResult("KI9257C", 0.55, _REAL_BOX)]   # weaker
            return [_FakeResult("719257C", 0.92, _REAL_BOX)]       # stronger
    t.alpr = _Alpr()
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == "719257C"
    assert v.plate_conf == pytest.approx(0.92)
    assert v.plate_votes == 1


def test_agreement_is_counted_and_marks_the_read_strong():
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == "719257C"
    assert v.plate_strong is False, "one frame should not read as corroborated"
    # A second, better look at the same characters.
    t.alpr.predict = lambda crop: [_FakeResult("719257C", 0.95, _REAL_BOX)]
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate_votes >= _PLATE_AGREEMENT_STRONG
    assert v.plate_strong is True


def test_pixel_width_is_recorded_with_the_reading():
    """The honest quality indicator, and the reason a width gate is not needed:
    the number travels to the CSV so a human can judge the read."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _FakeBox(10, 10, 74, 41))])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate_px_w == 64


def test_missing_alpr_degrades_instead_of_raising():
    t = bare_tracker()
    assert t.alpr is None
    v = vehicle(1)
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == ""


def test_a_failing_alpr_call_does_not_propagate():
    t = bare_tracker()

    class _Boom:
        def predict(self, crop):
            raise RuntimeError("simulated ONNX failure")
    t.alpr = _Boom()
    v = vehicle(1)
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == ""


# --------------------------------------------------------------------------- #
# Evidence on disk                                                              #
# --------------------------------------------------------------------------- #

def test_a_reading_saves_both_the_plate_and_the_vehicle():
    """A ~64x31px plate crop alone is unreviewable — you cannot tell a plate
    from a badge from a video overlay. The car photo is what makes a row
    checkable. Saved on the FIRST read, not on some later 'confirmed' event:
    waiting for confirmation is why no image ever appeared."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.crop_path and v.crop_path.endswith("_plate.jpg")
    assert v.vehicle_path and v.vehicle_path.endswith("_vehicle.jpg")


def test_filenames_come_from_the_vehicle_id_not_the_ocr_text():
    """Naming files after the reading turned a shaky string into a shaky
    filename. The vehicle_id is stable and non-fabricated."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle(vehicle_id="VH-000007")
    t._read_plates(frame(), [v], t._client_state["s"])
    name = v.crop_path.rsplit("/", 1)[-1]
    assert "719257C" not in name
    assert name.startswith("VH-000007_")


# --------------------------------------------------------------------------- #
# Rows: one per vehicle, plate or not                                           #
# --------------------------------------------------------------------------- #

def test_every_vehicle_gets_a_row_even_without_a_plate():
    """Most vehicles a drone sees never turn a readable plate toward the
    camera. Restricting rows to plated vehicles leaves the log silent about
    most of the traffic actually seen."""
    t = bare_tracker()
    v = vehicle(1, vehicle_id="VH-000004")
    row = t._plate_event_row(v)
    assert row is not None
    assert row["vehicle_id"] == "VH-000004"
    assert row["plate_text"] == "", "plateless row must carry '' not None"
    assert row["vehicle_type"] == "car"


def test_a_row_is_only_built_once_per_vehicle():
    t = bare_tracker()
    v = vehicle(1)
    assert t._plate_event_row(v) is not None
    assert t._plate_event_row(v) is None, "a second row was built for one vehicle"


def test_the_row_carries_plate_quality_and_both_images():
    t = bare_tracker()
    v = vehicle(1, vehicle_id="VH-000005")
    v.plate, v.plate_conf, v.plate_px_w = "719257C", 0.91, 64
    v.color, v.color_conf = "white", 0.8
    v.speed_kmh, v.speed_reliable = 48.0, True
    v.crop_path, v.vehicle_path = "/tmp/p.jpg", "/tmp/v.jpg"
    row = t._plate_event_row(v)
    assert row["plate_text"] == "719257C"
    assert row["plate_px_w"] == 64
    assert row["ocr_confidence"] == pytest.approx(0.91)
    assert row["vehicle_color"] == "white"
    assert row["speed_est_kmh"] == 48.0
    assert row["image_path"] == "/tmp/p.jpg"
    assert row["vehicle_image_path"] == "/tmp/v.jpg"


def test_an_unreliable_speed_is_not_written_to_a_permanent_row():
    """The live overlay may show it with a '?', but a durable record should not
    carry a number the estimator itself distrusts."""
    t = bare_tracker()
    v = vehicle(1)
    v.speed_kmh, v.speed_reliable = 220.0, False
    assert t._plate_event_row(v)["speed_est_kmh"] is None


def test_retired_vehicles_are_logged_and_dropped():
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    v.plate = "719257C"
    v.last_seen = time.time() - (_VEHICLE_RETIRE_AFTER_S + 1)
    state["vehicles"][1] = v
    rows = []
    for tid, veh in list(state["vehicles"].items()):
        if time.time() - veh.last_seen < _VEHICLE_RETIRE_AFTER_S:
            continue
        if (row := t._plate_event_row(veh)) is not None:
            rows.append(row)
        state["vehicles"].pop(tid, None)
    assert len(rows) == 1
    assert not state["vehicles"]


async def test_vehicles_still_on_screen_are_flushed_on_session_end(monkeypatch):
    """A vehicle in frame when the operator stops never gets the chance to age
    out, so without this flush its row is silently discarded — which is what
    'ran a session, saw plates, nothing in the history' looks like."""
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1, vehicle_id="VH-000003")
    v.plate, v.plate_conf = "719257C", 0.9
    v.last_seen = time.time()          # still in frame — would not retire
    state["vehicles"][1] = v

    captured = {}

    async def fake_persist(session_id, rows):
        captured["session_id"] = session_id
        captured["rows"] = rows

    monkeypatch.setattr("app.vision.persistence.persist_events", fake_persist)
    await t.unregister_client("s")

    assert captured.get("session_id") == "s"
    assert captured["rows"][0]["plate_text"] == "719257C"
    assert captured["rows"][0]["vehicle_id"] == "VH-000003"
    assert v.logged is True


async def test_unregister_with_nothing_to_flush_does_not_touch_persistence(monkeypatch):
    t = bare_tracker()
    called = {"n": 0}

    async def fake_persist(session_id, rows):
        called["n"] += 1

    monkeypatch.setattr("app.vision.persistence.persist_events", fake_persist)
    await t.unregister_client("s")
    assert called["n"] == 0


# --------------------------------------------------------------------------- #
# Counting                                                                      #
# --------------------------------------------------------------------------- #

def test_unique_count_is_by_track_not_by_detection():
    state = _make_state("t")
    for _ in range(10):
        for tid in (1, 2, 3):
            state["ids_seen"].add(tid)
    assert len(state["ids_seen"]) == 3


def test_colour_is_counted_once_per_vehicle_at_confidence():
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(1)
    for conf in (0.2, 0.4, 0.6, 0.7, 0.9):
        was = v.color_conf >= _COLOUR_GOOD_ENOUGH
        if conf > v.color_conf:
            v.color, v.color_conf = "red", conf
            if not was and conf >= _COLOUR_GOOD_ENOUGH:
                state["color_counts"]["red"] = state["color_counts"].get("red", 0) + 1
    assert state["color_counts"] == {"red": 1}


# --------------------------------------------------------------------------- #
# Follow                                                                        #
# --------------------------------------------------------------------------- #

def test_lock_takes_effect_only_once_the_vehicle_is_in_frame():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    assert state["locked_track_id"] is None

    t._follow(state, [], "s", 1920, 1080, None, None)
    assert state["locked_track_id"] is None, "locked onto an absent vehicle"

    t._follow(state, [vehicle(7)], "s", 1920, 1080, None, None)
    assert state["locked_track_id"] == 7


def test_locking_captures_the_plate_and_vehicle_id_as_the_durable_identity():
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(7, vehicle_id="VH-000042")
    v.plate = "719257C"
    t.request_follow("s", 7)
    t._follow(state, [v], "s", 1920, 1080, None, None)
    assert state["locked_plate"] == "719257C"
    assert state["locked_vehicle_id"] == "VH-000042"


def test_no_command_until_tracking_is_armed():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    assert t._follow(state, [vehicle(7)], "s", 1920, 1080, None, None) is None

    t.set_tracking("s", True)
    cmd = t._follow(state, [vehicle(7)], "s", 1920, 1080, None, None)
    assert cmd is not None
    assert cmd["type"] == "velocity"


def test_command_yaws_toward_a_vehicle_off_to_one_side():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    right = vehicle(7, 1500, 500, 1800, 700)
    cmd = None
    for _ in range(6):
        cmd = t._follow(state, [right], "s", 1920, 1080, None, None)
    assert cmd["yaw_deg_s"] > 0, "did not yaw toward a right-hand target"


def test_forward_never_drops_to_zero_purely_from_yaw_offset():
    """
    THE 'DRONE ONLY YAWS, NEVER MOVES FORWARD' BUG, PINNED.

    Measured: a vehicle only ~20deg off boresight (a normal moment mid-chase,
    not an edge case) drove forward_m_s to EXACTLY 0.0 under the old
    yaw-priority gate, so the drone spent a real chase yawing in place while
    the vehicle it was meant to be closing on kept its lead. Forward now keeps
    a floor (_YAW_PRIORITY_FLOOR) at any angle, so the two axes correct
    together instead of forward waiting its turn.
    """
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    # Far off to one side and far away (small), so both axes want to act.
    far_and_off_axis = vehicle(7, 1650, 470, 1750, 530)
    cmd = None
    for _ in range(8):
        cmd = t._follow(state, [far_and_off_axis], "s", 1920, 1080, None, None)
    assert cmd["yaw_deg_s"] > 0, "should still be turning toward the target"
    assert cmd["forward_m_s"] > 0, \
        "forward collapsed to zero purely from being off-axis"


def test_altitude_is_held_not_continuously_driven_by_vertical_framing():
    """
    THE 'DRONE KEEPS CLIMBING FOR NO REASON' BUG, PINNED.

    Measured: a vehicle sitting slightly high in frame, with elevate reporting
    elevating=False the whole time, still produced a steady ~-0.2m/s climb
    from a previous version's standing altitude PD — climbing had nothing to
    do with needing to chase harder. down_m_s must now stay at 0 (telemetry's
    own offboard hold-altitude keeps this steady) unless auto-elevate itself
    decides to climb.
    """
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    # Centred horizontally (no elevate pressure) but sitting high vertically —
    # exactly the case that used to drive a standing altitude correction.
    high_in_frame = vehicle(7, 900, 300, 1020, 390)
    cmd = None
    for _ in range(8):
        cmd = t._follow(state, [high_in_frame], "s", 1920, 1080, None, None)
    assert not state["elevate"]["elevating"], "test setup should not be outpacing"
    assert cmd["down_m_s"] == 0.0, \
        "altitude moved even though auto-elevate was not elevating"


def test_a_fixed_distance_target_can_be_unreachable_and_only_ever_back_away():
    """
    THE 'DRONE ONLY EVER MOVES BACKWARD' REPORT, EXPLAINED AND PINNED.

    Unlike a person's height (~1.7m regardless of heading), a vehicle's
    apparent height in frame depends on its heading as much as its range — a
    car driving broadside shows its long axis, the same car nose-on shows only
    its narrow front. So a FIXED target fill percentage can simply be smaller
    than however large the vehicle already appears the moment Follow arms —
    at which point err_dist = target - h_ema is negative from frame one and
    stays negative regardless of what the vehicle does next, because the
    target was never reachable at that range and heading. That reads
    identically to "forward is broken" from outside the module.
    """
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    # Vehicle already filling FAR more of the frame than the default 0.22
    # target — a normal thing to see right after a close-range lock.
    big_and_close = vehicle(7, 900, 200, 1400, 900)   # ~65% of frame height
    for _ in range(8):
        cmd = t._follow(state, [big_and_close], "s", 1920, 1080, None, None)
    backing_off = cmd["forward_m_s"]
    assert backing_off < -0.3, \
        "expected a sustained backward command while the vehicle exceeds the target"

    # The fix: the target is adjustable, and raising it to match reality
    # settles the command for the SAME vehicle at the SAME range. Enough
    # frames for the output smoother to drain — it carries the earlier
    # backward command for ~15 frames, so a shorter run measures the decay
    # rather than the steady state.
    t.set_tracking_params("s", target_distance_ratio=0.70)
    for _ in range(40):
        cmd = t._follow(state, [big_and_close], "s", 1920, 1080, None, None)
    assert abs(cmd["forward_m_s"]) < 0.05, (
        f"should have settled once the target matched reality, "
        f"got {cmd['forward_m_s']} (was {backing_off})"
    )


def test_set_tracking_params_resets_height_ema_so_the_new_target_applies_now():
    """Without clearing height_ema, a changed target would not take effect
    until the smoothing filter caught up several frames later."""
    t = bare_tracker()
    state = t._client_state["s"]
    state["height_ema"] = 0.5
    t.set_tracking_params("s", target_distance_ratio=0.3)
    assert state["height_ema"] is None
    assert state["target_distance_ratio"] == pytest.approx(0.3)


def test_set_tracking_params_is_clamped_to_a_sane_range():
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_tracking_params("s", target_distance_ratio=5.0)
    assert state["target_distance_ratio"] <= 0.70
    t.set_tracking_params("s", target_distance_ratio=-1.0)
    assert state["target_distance_ratio"] >= 0.08


def test_vehicle_fill_pct_and_target_are_reported_for_diagnosis():
    """Whatever the drone is actually chasing has to be visible on screen —
    'why is it backing up' is unanswerable without both of these together."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [vehicle(7, 900, 200, 1400, 900)], "s", 1920, 1080, None, None)
    assert state["height_ema"] is not None
    assert state.get("target_distance_ratio") is not None


def test_releasing_clears_the_lock_and_stops_commanding():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [vehicle(7)], "s", 1920, 1080, None, None)

    t.request_follow("s", None)
    assert state["locked_track_id"] is None
    assert state["locked_vehicle_id"] is None
    assert state["tracking"] is False
    assert t._follow(state, [vehicle(7)], "s", 1920, 1080, None, None) is None


def test_losing_the_vehicle_keeps_commanding_and_keeps_the_identity():
    """
    THE LANDING BUG, PINNED.

    PX4's Offboard mode needs a continuous setpoint stream — nothing repeats a
    MAVSDK send_velocity_body call automatically — and a gap past PX4's
    offboard-loss timeout hands control to PX4's own failsafe, whose default
    action on many airframes is LAND. Losing the locked vehicle for a frame or
    two (a missed detection, a brief occlusion) is routine for vehicle
    detection in a way it is not for a continuous body track, so returning
    None here — as an earlier version did — meant "drone lands the moment you
    press Follow" on any flight where the vehicle wasn't perfectly tracked
    every single frame.
    """
    t = bare_tracker()
    state = t._client_state["s"]
    v = vehicle(7)
    v.plate = "719257C"
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [v], "s", 1920, 1080, None, None)

    cmd = t._follow(state, [], "s", 1920, 1080, None, None)
    assert cmd is not None, "Offboard setpoint stream gapped — this is what triggers PX4 LAND"
    assert cmd["type"] == "velocity"
    assert state["locked_plate"] == "719257C"
    assert state["frames_lost"] >= 1


def test_a_missed_frame_holds_the_last_command_rather_than_reacting():
    """Most losses are one bad frame and resolve on their own. Reacting
    instantly — jumping straight to a search sweep — would fight noise
    instead of riding it out."""
    t = bare_tracker()
    state = t._client_state["s"]
    right = vehicle(7, 1500, 500, 1800, 700)
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    for _ in range(6):
        last = t._follow(state, [right], "s", 1920, 1080, None, None)

    missed = t._follow(state, [], "s", 1920, 1080, None, None)
    assert missed == last, "a single missed frame did not hold the last command"


def test_search_sweeps_then_settles_to_a_hover_never_returning_to_none():
    """Past the hold window the drone sweeps to look for the vehicle; past
    the sweep window it settles to a hover. At no point does the setpoint
    stream stop."""
    from app.vision.modules.plate_tracker import _PHASE_HOLD, _PHASE_SWEEP

    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [vehicle(7, 1500, 500, 1800, 700)], "s", 1920, 1080, None, None)

    cmd = None
    for _ in range(_PHASE_SWEEP + 20):
        cmd = t._follow(state, [], "s", 1920, 1080, None, None)
        assert cmd is not None, "the Offboard stream gapped during search"
    # Well past both phases now: settled to a hover, not still sweeping.
    assert state["frames_lost"] > _PHASE_SWEEP
    assert cmd["yaw_deg_s"] == 0.0
    assert cmd["forward_m_s"] == 0.0


def test_stopping_tracking_resets_the_controllers():
    t = bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    for _ in range(4):
        t._follow(state, [vehicle(7, 1500, 500, 1800, 700)], "s", 1920, 1080, None, None)
    t.set_tracking("s", False)
    assert state["height_ema"] is None
    assert state["elevate"] is None


# --------------------------------------------------------------------------- #
# Overlay                                                                       #
# --------------------------------------------------------------------------- #

def _meta(**over):
    m = {
        "vehicles": [
            {"track_id": 1, "vehicle_id": "VH-000001", "box": [900, 200, 1100, 400],
             "type": "car", "color": "unknown", "color_conf": 0.0, "plate": None,
             "plate_box": None, "plate_strong": False, "speed_kmh": None,
             "speed_reliable": False, "locked": False},
        ],
        "tracking": False, "vehicles_in_frame": 1, "vehicle_count_unique": 1,
    }
    m.update(over)
    return m


def test_overlay_labels_degrade_gracefully():
    t = bare_tracker()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    meta = _meta(vehicles=[
        {"track_id": 1, "vehicle_id": "VH-000001", "box": [100, 100, 400, 300],
         "type": "car", "color": "unknown", "color_conf": 0.0, "plate": None,
         "plate_box": None, "plate_strong": False, "speed_kmh": None,
         "speed_reliable": False, "locked": False},
        {"track_id": 2, "vehicle_id": "VH-000002", "box": [500, 100, 800, 300],
         "type": "truck", "color": "white", "color_conf": 0.8, "plate": "719257C",
         "plate_box": [600, 250, 664, 281], "plate_strong": True,
         "speed_kmh": 52.0, "speed_reliable": True, "locked": True},
    ])
    out = t.draw_overlay(f, meta)
    assert out.shape == f.shape
    assert out.any(), "overlay drew nothing"


def test_overlay_has_no_clutter_text_only_boxes():
    """Counts, telemetry and ALPR availability live in the side panel — the
    video shows only vehicles, plates and the follow guide."""
    t = bare_tracker()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(f, {"vehicles": [], "has_telemetry": False,
                       "alpr_available": False,
                       "vehicles_in_frame": 0, "vehicle_count_unique": 3})
    assert not f.any(), "status text drawn on the video despite no vehicles"


def test_recenter_line_is_drawn_for_a_locked_tracked_vehicle():
    """The follow guide human-tracking has — a line from frame centre to the
    target — so how far off-centre it sits is visible at a glance."""
    t = bare_tracker()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    v = dict(_meta()["vehicles"][0], locked=True)
    out = t.draw_overlay(f, _meta(vehicles=[v], tracking=True))
    # Centre (640, 360) toward the target (1000, 300): pixels along that path
    # must be lit where an unlocked overlay leaves them dark.
    assert out[300:360, 700:1000].any(), "no recenter guide drawn toward the target"


def test_recenter_line_is_absent_when_not_actively_tracking():
    """Locking frames a vehicle; only an armed Follow draws the flight guide."""
    t = bare_tracker()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    v = dict(_meta()["vehicles"][0], locked=True)
    out = t.draw_overlay(f, _meta(vehicles=[v], tracking=False))
    assert not out[340:360, 650:850].any(), \
        "recenter guide drawn without an armed follow"


# --------------------------------------------------------------------------- #
# Registration                                                                  #
# --------------------------------------------------------------------------- #

def test_mode_is_registered_and_runs_at_native_resolution():
    from app.config import Settings
    from app.sessions.models import AnalysisMode
    from app.vision.modules.__registry__ import ANALYZER_REGISTRY

    assert AnalysisMode.VEHICLE_PLATE.value == "vehicle-plate-tracking"
    assert ANALYZER_REGISTRY[AnalysisMode.VEHICLE_PLATE] is PlateTracker
    assert PlateTracker.MODE == AnalysisMode.VEHICLE_PLATE.value
    # 0 = no downscale. Plate reading is the one job where every pixel is
    # load-bearing, and downscaling the detection pass shrinks the vehicle
    # boxes the OCR crops come from as well.
    assert Settings().inference_width_for(PlateTracker.MODE) == 0


def test_native_width_passes_the_frame_through_untouched():
    t = bare_tracker()
    t.MODE = PlateTracker.MODE
    f = frame()
    out, sx, sy = t.resize_for_inference(f)
    assert out.shape == f.shape, "frame was downscaled"
    assert (sx, sy) == (1.0, 1.0)


# --------------------------------------------------------------------------- #
# Real captures from this rig — the regression, pinned                          #
# --------------------------------------------------------------------------- #
#
# Every size and string below was measured from plate crops this hardware
# actually produced in one session. A previous version of this module gated
# reads on a 70px minimum width, a 1.6-6.0 aspect band, two-frame exact
# agreement, AND a match against the Indian plate grammar — and those gates
# together rejected effectively all of it, so no image was saved and no row
# reached the database for the whole flight.
#
# These tests exist because that failure was SILENT: every other test in this
# file passed throughout, because they were all written against synthetic
# plates that happened to satisfy the gates.

# (width, height) of real captures, and the text OCR returned for them.
_REAL_CAPTURES = [
    (39, 18, "17777"),
    (76, 39, "179Z"),
    (65, 32, "19257C"),
    (63, 32, "19Z777"),
    (79, 43, "719257C"),
    (64, 30, "719551"),
    (50, 27, "A17711"),
    (37, 17, "CJ1171"),
    (31, 17, "LJ111"),
    (64, 31, "Y19237"),
]


@pytest.mark.parametrize("w,h,text", _REAL_CAPTURES)
def test_real_captures_from_this_rig_are_read_and_kept(w, h, text):
    """The whole point. None of these is 70px wide, none matches the Indian
    grammar, and all of them are genuine plate captures."""
    t = _with_alpr([_FakeResult(text, 0.9, _FakeBox(10, 10, 10 + w, 10 + h))])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == text, f"a real {w}x{h}px capture was discarded"
    assert v.crop_path, "no image saved for a real capture"


@pytest.mark.parametrize("w,h,text", _REAL_CAPTURES)
def test_real_captures_reach_a_database_row(w, h, text):
    t = _with_alpr([_FakeResult(text, 0.9, _FakeBox(10, 10, 10 + w, 10 + h))])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    row = t._plate_event_row(v)
    assert row is not None and row["plate_text"] == text
    assert row["plate_px_w"] == w, "pixel width not carried to the row"


def test_non_indian_plates_are_kept_and_flagged_rather_than_dropped():
    """719257C is a real, correctly-read plate. The Indian grammar regex
    rejects it — so grammar is recorded as a flag, never used to discard."""
    t = _with_alpr([_FakeResult("719257C", 0.9, _REAL_BOX)])
    v = plated_vehicle()
    t._read_plates(frame(), [v], t._client_state["s"])
    assert v.plate == "719257C"
    assert v.plate_grammar_ok is False, "expected a non-Indian-format flag"


def test_the_indian_confusion_correction_never_mangles_a_foreign_plate():
    """O->0, I->1, S->5, B->8 is applied ONLY when it produces a grammar
    match, so a US-style plate passes through as read rather than being
    'corrected' into something nobody saw."""
    from app.vision.modules.plate_tracker import _validate_and_correct
    assert _validate_and_correct("KI9257C") == "KI9257C"
    assert _validate_and_correct("SUBSCRIBE") == "SUBSCRIBE"
    # ...but a genuine Indian plate misread with a confusable glyph is fixed.
    assert _validate_and_correct("MHI2AC1234") == "MH12AC1234"
    # Note the correction is all-or-nothing and applies to the whole string, so
    # it cannot fix a plate whose SERIES letters are themselves confusable:
    # "MHI2AB1234" would become "MH12A81234" (the B maps to 8 as well), which
    # does not match the grammar, so the original is returned untouched. That
    # is the safe direction to fail — a plate is left as read rather than
    # rewritten into something nobody saw.
    assert _validate_and_correct("MHI2AB1234") == "MHI2AB1234"


# --------------------------------------------------------------------------- #
# Altitude modes                                                                #
# --------------------------------------------------------------------------- #

def _pose(agl=40.0):
    """A pose with plenty of height — the altitude floor refuses to descend
    without an AGL reading, so any test expecting descent must supply one."""
    from app.vision.geometry import CameraPose, MountOffset
    return CameraPose(agl_m=agl, mount=MountOffset(tilt_deg=45.0))


class _Ctx:
    width, height = 1920, 1080


def _armed(t, state, veh, pose=None):
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    ctx = _Ctx() if pose is not None else None
    for _ in range(6):
        cmd = t._follow(state, [veh], "s", 1920, 1080, ctx, pose)
    return cmd


def test_fixed_is_the_default_and_ignores_vertical_framing():
    """Because the camera is rigidly tilted, vertical position in frame is
    mostly a RANGE signal — which the distance controller already reads, more
    directly, from apparent size. Chasing it with altitude too is a second
    controller on the same quantity."""
    t = bare_tracker()
    state = t._client_state["s"]
    assert state["altitude_mode"] == "fixed"
    # Sitting well above frame centre: auto would climb, fixed must not.
    cmd = _armed(t, state, vehicle(7, 900, 150, 1020, 260))
    assert cmd["down_m_s"] == 0.0


def test_auto_drives_altitude_to_centre_the_vehicle_vertically():
    # Sized AT the distance target (238px tall ~= the 0.22 default) so the
    # distance controller is satisfied and auto-elevate — which overrides this
    # axis entirely when the target is outpacing us — stays out of the way.
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_altitude_mode("s", "auto")
    # High in frame -> climb (NED negative), because climbing pushes a
    # subject DOWN in frame under a fixed downward-tilted camera.
    high = _armed(t, state, vehicle(7, 900, 151, 1420, 389), pose=_pose(40.0))
    assert high["down_m_s"] < 0, "should climb for a vehicle high in frame"

    t2 = bare_tracker()
    st2 = t2._client_state["s"]
    t2.set_altitude_mode("s", "auto")
    # Needs a real AGL: descent without one is refused by the altitude floor.
    low = _armed(t2, st2, vehicle(7, 900, 691, 1420, 929), pose=_pose(40.0))
    assert low["down_m_s"] > 0, "should descend for a vehicle low in frame"


def test_nudge_moves_altitude_in_fixed_mode_only():
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_altitude_nudge("s", -0.8)              # ascend
    cmd = _armed(t, state, vehicle(7, 900, 480, 1020, 590))
    assert cmd["down_m_s"] < 0, "nudge ignored in fixed mode"

    # Auto owns the axis: switching to auto must drop the held nudge rather
    # than letting it fight the PD.
    t.set_altitude_mode("s", "auto")
    assert state["altitude_nudge_v"] == 0.0


def test_disarming_clears_a_held_nudge():
    """Otherwise re-arming would immediately command a climb nobody asked for."""
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_tracking("s", True)
    t.set_altitude_nudge("s", -1.0)
    t.set_tracking("s", False)
    assert state["altitude_nudge_v"] == 0.0


def test_altitude_mode_rejects_unknown_values():
    t = bare_tracker()
    state = t._client_state["s"]
    t.set_altitude_mode("s", "sideways")
    assert state["altitude_mode"] == "fixed"


def test_mode_is_reported_so_the_ui_can_reflect_the_real_state():
    t = bare_tracker()
    t.set_altitude_mode("s", "auto")
    assert t._client_state["s"]["altitude_mode"] == "auto"


# --------------------------------------------------------------------------- #
# Distance error in fraction-of-range units                                     #
# --------------------------------------------------------------------------- #

def test_distance_response_is_range_independent():
    """
    THE 'IT WON'T BACK OFF WHEN SOMEONE WALKS AT IT' BUG, PINNED.

    The old error was a raw fill difference, so a fixed deadband meant a dead
    zone that grew as range SQUARED — measured at 1.4m of subject movement at
    8.6m slant, and 46m at 50m slant. Expressed as a fraction of range the
    same proportional error produces the same command at any distance.
    """
    from app.vision.controllers import range_error_ratio

    # Same 20%-too-close error at three very different ranges.
    for fill in (0.40, 0.20, 0.05):
        target = fill / 1.2
        assert range_error_ratio(target, fill) == pytest.approx(-1 / 6, rel=1e-6)


def test_a_metre_of_approach_at_close_range_now_produces_a_command():
    """The exact reported case: person/vehicle walks ~1m toward a drone
    holding ~25% fill. The old deadband swallowed it entirely."""
    from app.vision.controllers import PDController, range_error_ratio
    pd = PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08)
    # 25% fill at 8.6m slant -> 28.4% after closing 1m (measured geometry).
    out = pd.compute(range_error_ratio(0.25, 0.284))
    assert out < -0.3, f"1m of approach still produced only {out:.3f} m/s"


# --------------------------------------------------------------------------- #
# Vehicle classes                                                               #
# --------------------------------------------------------------------------- #

def test_class_ids_and_names_cannot_drift_apart():
    """Two lists describing the same thing: the ids filter the detector call,
    the names filter its output. If they disagree, a class is either detected
    and then silently discarded, or expected and never detected."""
    from ultralytics import YOLO
    from app.config import get_settings
    from app.vision.modules.plate_tracker import (
        _VEHICLE_CLASSES, _VEHICLE_CLASS_IDS,
    )
    names = YOLO(get_settings().default_yolo_model).names
    assert {names[i] for i in _VEHICLE_CLASS_IDS} == _VEHICLE_CLASSES


def test_two_wheelers_are_tracked():
    """A cyclist did not exist to this module before — no id, no row, nothing
    to lock onto."""
    from app.vision.modules.plate_tracker import _VEHICLE_CLASSES
    assert {"bicycle", "motorcycle"} <= _VEHICLE_CLASSES


# --------------------------------------------------------------------------- #
# Foreshortening                                                                #
# --------------------------------------------------------------------------- #

def test_apparent_size_alone_is_not_monotonic_in_range():
    """The defect being corrected, stated as a fact about the optics: a
    subject 3m away projects SMALLER than one 6m away when the drone is at
    6m, because the camera is looking down on it more steeply."""
    import math
    from app.vision.geometry import CameraModel
    cam = CameraModel(1920, 1080, hfov_deg=70.0)

    def raw_fill(h, d):
        R = math.hypot(h, d)
        return 1.7 * cam.fy * math.cos(math.atan2(h, d)) / R / 1080

    assert raw_fill(6.0, 3.0) < raw_fill(6.0, 6.0), "expected the inversion"
    assert raw_fill(6.0, 1.0) < raw_fill(6.0, 12.0), (
        "a subject at 1m should look SMALLER than one at 12m — that is the bug"
    )


def test_correction_restores_monotonicity_over_the_useful_envelope():
    import math
    from app.vision.geometry import CameraModel, deforeshorten_size
    cam = CameraModel(1920, 1080, hfov_deg=70.0)
    h, tilt = 6.0, 45.0

    def corrected(d):
        R = math.hypot(h, d)
        phi = math.degrees(math.atan2(h, d))
        raw = 1.7 * cam.fy * math.cos(math.radians(phi)) / R / 1080
        return deforeshorten_size(raw, phi, tilt)

    # Closer must always read LARGER, so the controller backs off instead of
    # driving in. 1.5m is where the divergence cap takes over — see below.
    seq = [corrected(d) for d in (12, 10, 8, 6, 5, 4, 3, 2, 1.5)]
    assert all(b > a for a, b in zip(seq, seq[1:])), f"not monotonic: {seq}"


def test_the_correction_is_capped_rather_than_diverging():
    """cos(phi) -> 0 near nadir, so an uncapped correction would fabricate an
    enormous range error from a subject almost underneath the drone. The cap
    means the very steepest angles stop being corrected fully — a bounded,
    deliberate limit rather than an unbounded command."""
    from app.vision.geometry import _MAX_FORESHORTEN_GAIN, deforeshorten_size
    assert deforeshorten_size(0.1, 89.9, 45.0) == pytest.approx(
        0.1 * _MAX_FORESHORTEN_GAIN
    )


def test_no_correction_at_the_reference_angle():
    """At frame centre the measurement already IS the reference, so the
    operator's target ratio keeps meaning what they set it to."""
    from app.vision.geometry import deforeshorten_size
    assert deforeshorten_size(0.25, 45.0, 45.0) == pytest.approx(0.25)

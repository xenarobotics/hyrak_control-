"""Crowd management: follow-one-out-of-the-crowd, and the overlay change."""
import numpy as np
import pytest

from app.vision.modules.crowd_manager import CrowdManager, _make_state


def bare():
    t = CrowdManager.__new__(CrowdManager)
    t._client_state = {"s": _make_state()}
    return t


def person(pid, x1=800, y1=400, x2=1000, y2=700):
    return {"id": pid, "box": [x1, y1, x2, y2]}


def test_selection_uses_the_same_ids_the_count_is_built_from():
    """No new perception: crowd counting already assigns stable ByteTrack ids,
    so following is wiring, not a second detector."""
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7)
    assert st["selected_id"] == 7


def test_no_command_until_follow_is_armed():
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7)
    assert t._follow(st, [person(7)], "s", 1920, 1080, None, None) is None
    t.set_tracking("s", True)
    cmd = t._follow(st, [person(7)], "s", 1920, 1080, None, None)
    assert cmd is not None and cmd["type"] == "velocity"


def test_losing_the_person_keeps_the_setpoint_stream_alive():
    """A gap in Offboard setpoints hands control to PX4's failsafe — the bug
    that landed a drone earlier in this project."""
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7); t.set_tracking("s", True)
    t._follow(st, [person(7)], "s", 1920, 1080, None, None)
    for _ in range(300):
        assert t._follow(st, [], "s", 1920, 1080, None, None) is not None


def test_releasing_disarms_as_well_as_deselecting():
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7); t.set_tracking("s", True)
    t.set_selected_person("s", None)
    assert st["selected_id"] is None and st["tracking"] is False


def test_yaws_toward_someone_off_to_one_side():
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7); t.set_tracking("s", True)
    cmd = None
    for _ in range(6):
        cmd = t._follow(st, [person(7, 1500, 500, 1700, 800)], "s", 1920, 1080, None, None)
    assert cmd["yaw_deg_s"] > 0


def test_descent_still_respects_the_altitude_floor():
    """The floor is enforced in every follow path, not only the ones that had
    it first."""
    t = bare(); st = t._client_state["s"]
    t.set_selected_person("s", 7); t.set_tracking("s", True)
    t.set_altitude_mode("s", "auto")
    low = person(7, 900, 900, 1100, 1070)   # low in frame -> wants to descend
    cmd = None
    for _ in range(6):
        cmd = t._follow(st, [low], "s", 1920, 1080, None, None)
    # No pose supplied -> no AGL -> descent refused rather than guessed.
    assert cmd["down_m_s"] <= 0.0


def test_empty_cells_draw_nothing_at_all():
    """The separator lattice is gone: an empty frame must stay clean, not turn
    into a wire mesh laid over the scene."""
    t = bare()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(f, {"people": [], "section_counts": {}, "section_grid": [3, 3],
                       "current_count": 0, "density_level": "green"})
    assert not f.any(), "something was drawn for a completely empty frame"


def test_occupied_cells_are_still_tinted():
    t = bare()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    t.draw_overlay(f, {"people": [], "section_counts": {4: 6}, "section_grid": [3, 3],
                       "current_count": 6, "density_level": "green",
                       "light_max": 4, "moderate_max": 9})
    assert f.any(), "an occupied cell drew nothing"


def test_the_followed_person_is_drawn_over_the_crowd():
    t = bare()
    f = np.zeros((720, 1280, 3), dtype=np.uint8)
    out = t.draw_overlay(f, {
        "people": [person(1, 100, 100, 200, 300), person(7, 500, 200, 620, 500)],
        "selected_id": 7, "tracking": True,
        "section_counts": {}, "section_grid": [3, 3],
        "current_count": 2, "density_level": "green",
    })
    assert out.any()


# --------------------------------------------------------------------------- #
# Trend + zone names                                                            #
# --------------------------------------------------------------------------- #

def test_zone_names_reach_the_alert_text():
    """The entire point of naming a zone: an alert that says 'North Gate' can
    be acted on over a radio; 'section 4' has to be decoded first."""
    t = bare(); st = t._client_state["s"]
    t.set_zone_names("s", {"4": "North Gate"})
    assert st["zone_names"]["4"] == "North Gate"
    where = st["zone_names"].get("4") or "section 4"
    assert "North Gate" in f"Crowd {where} DENSE for 9s (30 people)"


def test_blank_zone_names_are_dropped_rather_than_stored():
    t = bare(); st = t._client_state["s"]
    t.set_zone_names("s", {"0": "  ", "1": "Stage"})
    assert "0" not in st["zone_names"] and st["zone_names"]["1"] == "Stage"


def test_zone_names_are_length_capped():
    t = bare(); st = t._client_state["s"]
    t.set_zone_names("s", {"0": "x" * 200})
    assert len(st["zone_names"]["0"]) <= 24


def test_history_is_bounded_so_a_long_session_cannot_grow_without_limit():
    from app.vision.modules.crowd_manager import _HISTORY_POINTS
    st = _make_state()
    for i in range(_HISTORY_POINTS * 3):
        st["count_history"].append({"t": float(i), "n": i})
    assert len(st["count_history"]) == _HISTORY_POINTS

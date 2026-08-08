"""
Capability profiles.

The property that matters most here is the one that is easy to lose in a later
edit: the decision is made in PIXELS, so a sensor or lens change moves the
usable ranges on its own. The moment someone "simplifies" this into a table of
altitudes, a 4K upgrade starts refusing plate reads at ranges where plates are
perfectly legible — silently, and in the direction that looks like a broken
plate reader rather than a configuration mistake.

The hysteresis is tested against simulated hover noise rather than asserted
structurally, because the failure it prevents is statistical: a bare threshold
does not look wrong when you read it, it just flaps.
"""
import random

import pytest

from app.vision import viability
from app.vision.profiles import ProfileSelector

HFOV = 70.0
W_1080P = 1920
W_4K = 3840

# Both physical constants come from viability._REQUIREMENTS.
PLATE_M, PLATE_MARGINAL_PX = 0.50, 70
FACE_M = 0.23


def _items(width: int, slant: float, hfov: float = HFOV):
    """Viability entries as the analyzer produces them, at native width — the
    per-subject crops plate and face OCR run on are full resolution."""
    return [
        i.to_dict()
        for i in viability.assess(
            hfov, width, slant,
            effective_width_px={k: width
                                for k in ("vehicle", "person", "plate", "face")},
        )
    ]


def _profile_at(width: int, slant: float, hfov: float = HFOV):
    return ProfileSelector().select(_items(width, slant, hfov))


# --------------------------------------------------------------------------- #
# The point of the whole module: pixels, not altitudes                          #
# --------------------------------------------------------------------------- #

def test_a_4k_sensor_extends_plate_range_with_no_code_change():
    """The stated requirement: upgrade the camera and longer ranges work by
    themselves. 18m is out of range at 1080p and in range at 4K.

    Deliberately NOT tested at 20m, which is within a pixel of 4K's cold-start
    boundary of 19.6m at this lens — a test sitting on a latch edge measures
    the hysteresis, not the scaling it means to check."""
    assert not _profile_at(W_1080P, 18.0).attempting("plate")
    assert _profile_at(W_4K, 18.0).attempting("plate")


def test_plate_range_scales_linearly_with_sensor_width():
    """Doubling the width doubles the range. If this ever fails, someone has
    introduced a constant that does not scale."""
    r_1080 = viability.range_for_px(HFOV, W_1080P, PLATE_M, PLATE_MARGINAL_PX)
    r_4k = viability.range_for_px(HFOV, W_4K, PLATE_M, PLATE_MARGINAL_PX)
    assert r_4k == pytest.approx(2.0 * r_1080, rel=1e-6)


def test_a_narrower_lens_extends_range_too():
    """Range depends on the lens as much as the sensor — the reason neither
    can be baked into a constant."""
    assert not _profile_at(W_4K, 25.0, hfov=70.0).attempting("plate")
    assert _profile_at(W_4K, 25.0, hfov=50.0).attempting("plate")


def test_the_documented_boundaries_are_what_the_selector_actually_uses():
    """Pins the numbers quoted to the operator. If the requirement or the
    latch changes, this fails rather than the docs quietly going stale."""
    boundary = {
        (W_1080P, 70.0): 9.8,
        (W_4K, 70.0): 19.6,
        (W_4K, 50.0): 29.4,
    }
    for (width, hfov), expected in boundary.items():
        assert viability.range_for_px(
            hfov, width, PLATE_M, PLATE_MARGINAL_PX
        ) == pytest.approx(expected, abs=0.1)
        # Just inside attempts, just outside does not.
        assert _profile_at(width, expected * 0.97, hfov).attempting("plate")
        assert not _profile_at(width, expected * 1.03, hfov).attempting("plate")


# --------------------------------------------------------------------------- #
# Budget                                                                        #
# --------------------------------------------------------------------------- #

def test_out_of_range_analytics_cost_nothing():
    """At survey altitude neither optional model runs — that reclaimed budget
    is the whole reason for gating rather than always attempting."""
    p = _profile_at(W_1080P, 40.0)
    assert p.name == "survey"
    assert p.ocr_calls == 0
    assert p.faces is False


def test_skipping_faces_buys_more_plate_reads():
    """Faces need a far closer subject than plates, so there is a band where
    faces are refused and their budget goes to OCR."""
    near = _profile_at(W_1080P, 5.0)      # both in range
    plates_only = _profile_at(W_1080P, 8.0)
    assert near.faces is True
    assert plates_only.faces is False
    assert plates_only.ocr_calls > near.ocr_calls


def test_budget_is_configurable_and_actually_binds():
    sel = ProfileSelector()
    lean = sel.select(_items(W_1080P, 8.0), budget_ms=15.0).ocr_calls
    rich = sel.select(_items(W_1080P, 8.0), budget_ms=45.0).ocr_calls
    assert lean == 1
    assert rich > lean


# --------------------------------------------------------------------------- #
# Hysteresis                                                                    #
# --------------------------------------------------------------------------- #

def _switches_hovering_at_the_boundary(off_fraction: float, seed: int = 7) -> int:
    """Count OCR on/off transitions while holding station on the latch edge."""
    import app.vision.profiles as profiles_mod

    edge = viability.range_for_px(HFOV, W_1080P, PLATE_M, PLATE_MARGINAL_PX)
    original = profiles_mod._OFF_FRACTION
    profiles_mod._OFF_FRACTION = off_fraction
    try:
        random.seed(seed)
        sel = ProfileSelector()
        switches, prev = 0, None
        for _ in range(400):
            # A hovering drone breathes a metre or so, and baro AGL adds noise.
            on = sel.select(
                _items(W_1080P, edge + random.uniform(-0.6, 0.6))
            ).attempting("plate")
            if prev is not None and on != prev:
                switches += 1
            prev = on
        return switches
    finally:
        profiles_mod._OFF_FRACTION = original


def test_hysteresis_stops_the_profile_flapping_on_a_hover():
    """A bare threshold toggles OCR on nearly half of all frames here. The
    latch is what makes the readout stable enough to trust."""
    assert _switches_hovering_at_the_boundary(off_fraction=1.0) > 50
    assert _switches_hovering_at_the_boundary(off_fraction=0.85) == 0


def test_the_latch_still_releases_on_a_real_climb():
    """Hysteresis must be a deadband, not a one-way door."""
    sel = ProfileSelector()
    for slant in (6.0, 8.0, 10.0):
        assert sel.select(_items(W_1080P, slant)).attempting("plate")
    for slant in (14.0, 20.0):
        assert not sel.select(_items(W_1080P, slant)).attempting("plate")
    # ...and re-arms coming back down.
    assert sel.select(_items(W_1080P, 6.0)).attempting("plate")


def test_the_deadband_is_asymmetric():
    """Turning off must need a bigger move than turning on, or it is not a
    deadband at all."""
    climbing = ProfileSelector()
    for slant in (6.0, 10.5):
        climbing.select(_items(W_1080P, slant))
    still_on = climbing.select(_items(W_1080P, 10.5)).attempting("plate")

    from_cold = ProfileSelector().select(_items(W_1080P, 10.5)).attempting("plate")

    assert still_on is True and from_cold is False


# --------------------------------------------------------------------------- #
# Failing open                                                                  #
# --------------------------------------------------------------------------- #

def test_no_telemetry_attempts_everything():
    """No altitude is not the same as out of range. Refusing to read plates on
    a bench with no GPS lock is indistinguishable from a broken plate reader,
    and that has already cost this project a debugging session."""
    p = ProfileSelector().select(_items(W_1080P, None))
    assert p.attempting("plate")
    assert p.ocr_calls >= 1


def test_a_missing_model_is_reported_not_silently_skipped():
    p = ProfileSelector().select(
        _items(W_1080P, 5.0), alpr_available=False, faces_available=True
    )
    assert not p.attempting("plate")
    assert p.ocr_calls == 0
    assert p.subjects["plate"].status == "unavailable"
    assert "not loaded" in p.subjects["plate"].reason


# --------------------------------------------------------------------------- #
# Operator override                                                             #
# --------------------------------------------------------------------------- #

def test_operator_can_force_an_out_of_range_analytic_on():
    p = ProfileSelector().select(_items(W_1080P, 40.0), overrides={"plate": "on"})
    assert p.attempting("plate")
    assert p.subjects["plate"].forced is True


def test_operator_can_force_an_in_range_analytic_off():
    p = ProfileSelector().select(_items(W_1080P, 5.0), overrides={"plate": "off"})
    assert not p.attempting("plate")
    assert p.ocr_calls == 0
    assert p.subjects["plate"].forced is True


def test_an_override_cannot_conjure_a_model_that_failed_to_load():
    """Forcing on must not pretend fast-alpr is present."""
    p = ProfileSelector().select(
        _items(W_1080P, 5.0), overrides={"plate": "on"}, alpr_available=False
    )
    assert not p.attempting("plate")


# --------------------------------------------------------------------------- #
# Headline                                                                      #
# --------------------------------------------------------------------------- #

def test_headline_names_the_subject_that_is_nearest_to_achievable():
    """Ranked by fraction of requirement met, not by pixel gap. At 50m a plate
    is ~56px short and a face ~54px short, so a raw gap would nominate the
    face — yet the plate needs less than half the descent."""
    p = _profile_at(W_1080P, 50.0)
    assert "plate" in p.headline
    assert p.headline.index("needs") > 0

    plate_px = p.subjects["plate"].px_on_target
    face_px = p.subjects["face"].px_on_target
    # The premise of the test: face really is the smaller raw gap here.
    assert (70 - plate_px) > (60 - face_px)

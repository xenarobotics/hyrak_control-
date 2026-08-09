"""
How fast the radio profile may go, as arithmetic rather than opinion.

WHY THIS EXISTS. The radio rates were raised once on the reasoning that
QGroundControl sustains more over the same 3DR, and the link stopped holding.
Both the raise and the walk-back were judgement calls; neither was a number.
Nobody had added up what the streams actually cost.

They add up to very little. A MAVLink v2 ATTITUDE frame is 40 bytes, so the
whole radio profile at 4 Hz attitude is ~440 B/s. A stock 3DR carries
something like 1600 B/s downlink after ECC, the half-duplex split and framing
overhead. That is 28% — nowhere near a ceiling, which is why 4 Hz was too
timid and 6 Hz is a step worth taking.

The same arithmetic explains the failure that caused the retreat: 10/8 Hz is
~920 B/s, 57% of that ceiling, and over 100% of it if the radio's AIR_SPEED
is 32k instead of 64k. Nothing in this codebase can read AIR_SPEED — it lives
on the radio — so the estimate is deliberately pessimistic and the profile
moves one step at a time against measured_rates.
"""
import pytest

from app.config import get_settings
from app.telemetry.manager import TelemetryManager


def _rates(**hz):
    """The (name, setter, hz) shape _set_rates builds and _downlink_bytes_s eats."""
    return [(name, None, v) for name, v in hz.items()]


# --------------------------------------------------------------------------- #
# The arithmetic                                                                #
# --------------------------------------------------------------------------- #

def test_raising_a_rate_raises_the_estimate_by_the_frame_size():
    """The whole point of the estimate: one more attitude message per second
    costs exactly one attitude frame per second, and it is visible."""
    one = TelemetryManager._downlink_bytes_s(_rates(attitude=4.0))
    two = TelemetryManager._downlink_bytes_s(_rates(attitude=5.0))
    assert two - one == pytest.approx(TelemetryManager._FRAME_BYTES["attitude"])


def test_what_px4_sends_unasked_is_counted():
    """HEARTBEAT and SYS_STATUS arrive whatever is requested — PX4 calls
    HEARTBEAT a constant-rate stream whose rate is never adjusted. Leaving
    them out would understate every profile by the same ~64 B/s and make the
    headroom look better than it is."""
    assert TelemetryManager._downlink_bytes_s([]) == pytest.approx(
        TelemetryManager._UNREQUESTED_BYTES_S
    )
    assert TelemetryManager._UNREQUESTED_BYTES_S > 0


def test_the_shipped_radio_profile_sits_well_inside_the_budget():
    """The claim this change rests on. If a later edit pushes the default
    profile past half the ceiling, that is the moment to find out — here, not
    on a flight line."""
    cfg = get_settings()
    profile = _rates(
        position=cfg.telemetry_rate_position_radio,
        attitude=cfg.telemetry_rate_attitude_radio,
        battery=1.0, gps_info=1.0, home=0.5, in_air=1.0,
    )
    used = TelemetryManager._downlink_bytes_s(profile)
    fraction = used / TelemetryManager._RADIO_CEILING_BYTES_S
    assert fraction < TelemetryManager._RADIO_BUDGET_WARN, (
        f"radio profile is {fraction:.0%} of the conservative ceiling"
    )


def test_the_profile_that_broke_the_link_would_now_be_flagged():
    """A regression test for a decision, not for code. 10 Hz attitude and
    8 Hz position is what stopped commands arriving; the estimate has to put
    it past the warning line, or it would have let that through silently."""
    broke = _rates(position=8.0, attitude=10.0, battery=2.0, gps_info=2.0,
                   home=1.0, in_air=2.0)
    used = TelemetryManager._downlink_bytes_s(broke)
    assert used > TelemetryManager._RADIO_CEILING_BYTES_S * TelemetryManager._RADIO_BUDGET_WARN


def test_the_ceiling_is_pessimistic_not_optimistic():
    """Being wrong low costs a spurious warning. Being wrong high costs a
    flight, so the constant must stay under the naive 57600/8 = 7200 B/s that
    the serial baud alone would suggest — the air rate, ECC and the
    half-duplex split all sit between the two."""
    assert TelemetryManager._RADIO_CEILING_BYTES_S < 7200 / 2


# --------------------------------------------------------------------------- #
# The step being taken                                                          #
# --------------------------------------------------------------------------- #

def test_attitude_on_the_radio_is_the_step_that_was_asked_for():
    assert get_settings().telemetry_rate_attitude_radio == 6.0


def test_only_attitude_moved():
    """One variable at a time is the entire method here. Moving position in
    the same breath would make a bad result impossible to attribute."""
    cfg = get_settings()
    assert cfg.telemetry_rate_position_radio == 2.0
    assert cfg.telemetry_rate_position_udp == 4.0
    assert cfg.telemetry_rate_attitude_udp == 10.0


def test_tracking_streams_still_outrank_dashboard_streams():
    """The ordering invariant that survives any retune: attitude and position
    feed the follow geometry, battery and home are numbers that change over
    minutes and cost the same per message."""
    cfg = get_settings()
    assert cfg.telemetry_rate_attitude_radio > cfg.telemetry_rate_position_radio
    assert cfg.telemetry_rate_position_radio >= 1.0

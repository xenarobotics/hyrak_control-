"""
The sensors page's "calibrated / needs calibration" verdicts must come from
the autopilot, not be inferred from the data.

THE REPORT BEHIND THIS: the UI declared the compass broken whenever the
aircraft happened to face magnetic north, because heading !== 0 was the
"check". PX4 already computes the real answer per sensor and QGC displays
exactly those flags — this subscription puts them on the snapshot so the UI
can too.
"""
import asyncio

import pytest

from app.telemetry.manager import TelemetryManager
from app.telemetry.schemas import TelemetrySnapshot


class _Recorder:
    def __init__(self):
        self.pushes = []

    def __call__(self, snapshot):
        self.pushes.append(snapshot)


def _manager():
    t = TelemetryManager.__new__(TelemetryManager)
    t._snapshot = TelemetrySnapshot()
    t._fleet_mode = False
    t._last_emit = 0.0
    t._on_update = _Recorder()
    t._on_pilot_override = None
    t._offboard_active = False
    t._pilot_override_mode = None
    t._offboard_release_until = 0.0
    return t


class _Health:
    def __init__(self, mag_ok=True):
        self.is_gyrometer_calibration_ok = True
        self.is_accelerometer_calibration_ok = True
        self.is_magnetometer_calibration_ok = mag_ok
        self.is_local_position_ok = False
        self.is_global_position_ok = False
        self.is_home_position_ok = False
        self.is_armable = False


def test_a_fresh_snapshot_claims_no_verdict():
    """received=False until the first health message — the difference between
    "PX4 says not calibrated" and "nobody has said anything yet", which must
    not paint the same colour on screen."""
    snap = TelemetrySnapshot()
    assert snap.health.received is False
    assert snap.to_dict()["health"]["received"] is False


@pytest.mark.asyncio
async def test_the_autopilot_flags_land_on_the_snapshot():
    t = _manager()

    class _Tel:
        async def health(self):
            yield _Health(mag_ok=False)

    t._drone = type("D", (), {"telemetry": _Tel()})()
    t._running = True
    await t._subscribe_health()

    h = t._snapshot.health
    assert h.received is True
    assert h.gyro_cal_ok and h.accel_cal_ok
    assert h.mag_cal_ok is False
    assert t._snapshot.to_dict()["health"]["mag_cal_ok"] is False


@pytest.mark.asyncio
async def test_a_flag_flip_is_pushed_immediately_and_repeats_are_not():
    """A calibration flag flipping is exactly the moment the sensors page
    must repaint — but health repeats at 1 Hz forever, and forcing every
    repeat would defeat the emit throttle through the back door."""
    t = _manager()

    class _Tel:
        async def health(self):
            for h in (_Health(mag_ok=False), _Health(mag_ok=False), _Health(mag_ok=True)):
                yield h

    t._drone = type("D", (), {"telemetry": _Tel()})()
    t._running = True
    t._last_emit = asyncio.get_event_loop().time()
    await t._subscribe_health()
    # first message (nothing → flags), then the mag flip. The repeat falls
    # to the throttle.
    assert len(t._on_update.pushes) == 2
    assert t._snapshot.health.mag_cal_ok is True


@pytest.mark.asyncio
async def test_get_param_reads_one_value_not_the_whole_download():
    """The mount-orientation selects ask for two ints; the only prior read
    path was fetch_params, a 5-30 s download of every parameter."""
    t = _manager()
    t._connected = True

    class _Param:
        async def get_param_int(self, name):
            assert name == "SENS_BOARD_ROT"
            return 4

    t._drone = type("D", (), {"param": _Param()})()
    assert await t.get_param("SENS_BOARD_ROT", "int") == 4


@pytest.mark.asyncio
async def test_get_param_answers_none_rather_than_raising():
    """A param the FC does not have must come back as "unreadable", not as a
    crashed socket handler."""
    t = _manager()
    t._connected = True

    class _Param:
        async def get_param_int(self, name):
            raise RuntimeError("PARAM_ERROR")

    t._drone = type("D", (), {"param": _Param()})()
    assert await t.get_param("NOPE", "int") is None

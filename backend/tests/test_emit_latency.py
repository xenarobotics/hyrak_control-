"""
A state change must not wait for the throttle.

THE REPORT: "after pressing arm there is no effect in UI, and after around 1
second the drone armed, and after another 1 second the UI is updated."

That second second had two causes stacked on each other. The larger one is on
the client (it waited for HEARTBEAT to repeat a fact the command ACK had
already delivered). The smaller one is here: _emit() throttles every snapshot
push to 10 Hz, and it did so for state transitions as well as for streams.

For a continuous value the throttle is free — a dropped attitude frame costs
nothing because the next one carries an almost identical number. A transition
is the opposite: there is exactly one moment when armed goes false→true, and
throttling that adds pure latency to the single update anyone is watching for.
"""
import asyncio

import pytest

from app.telemetry.manager import TelemetryManager


class _Recorder:
    def __init__(self):
        self.pushes = []

    def __call__(self, snapshot):
        self.pushes.append(snapshot)


def _manager():
    from app.telemetry.schemas import TelemetrySnapshot

    t = TelemetryManager.__new__(TelemetryManager)
    t._snapshot = TelemetrySnapshot()
    t._fleet_mode = False
    t._last_emit = 0.0
    t._on_update = _Recorder()
    return t


@pytest.mark.asyncio
async def test_a_continuous_stream_is_still_throttled():
    """The throttle has to keep doing its job — a 10 Hz attitude stream must
    not become an unthrottled firehose to the browser."""
    t = _manager()
    t._last_emit = asyncio.get_event_loop().time()
    for _ in range(50):
        t._emit()
    assert len(t._on_update.pushes) == 0


@pytest.mark.asyncio
async def test_a_state_change_goes_out_immediately():
    t = _manager()
    t._last_emit = asyncio.get_event_loop().time()
    t._emit(force=True)
    assert len(t._on_update.pushes) == 1


@pytest.mark.asyncio
async def test_arming_pushes_the_moment_it_changes_and_not_on_every_repeat():
    """armed() re-yields the same value while nothing changes. Forcing on
    every yield would defeat the throttle through the back door; forcing on
    none of them is the original lag. Only the transition counts."""
    t = _manager()

    class _Tel:
        async def armed(self):
            for v in (False, False, True, True, True, False):
                yield v

    t._drone = type("D", (), {"telemetry": _Tel()})()
    t._running = True
    t._last_emit = asyncio.get_event_loop().time()
    await t._subscribe_armed()
    # false→true and true→false. The repeats fall to the throttle.
    assert len(t._on_update.pushes) == 2


@pytest.mark.asyncio
async def test_the_flight_mode_name_is_compared_not_the_enum_object():
    """flight_mode() yields an enum whose repr is stringified before storage.
    Comparing the raw objects would mark every yield as a change."""
    t = _manager()

    class _Mode:
        def __init__(self, n):
            self._n = n

        def __str__(self):
            return f"FlightMode.{self._n}"

    class _Tel:
        async def flight_mode(self):
            for n in ("HOLD", "HOLD", "MISSION"):
                yield _Mode(n)

    t._drone = type("D", (), {"telemetry": _Tel()})()
    t._running = True
    t._last_emit = asyncio.get_event_loop().time()
    await t._subscribe_flight_mode()
    assert t._snapshot.flight_mode.mode == "MISSION"
    assert len(t._on_update.pushes) == 2, "two distinct modes, one repeat"

"""Link watchdog: a silent link is reported LOST within ~2 s with its identity,
and RESTORED when messages return - without MAVSDK's anonymous 3 s timeout."""
import asyncio
import time

import pytest

from app.telemetry.manager import TelemetryManager


@pytest.mark.asyncio
async def test_link_watch_reports_lost_then_restored(caplog):
    pushes = []
    m = TelemetryManager(on_update=pushes.append, fleet_mode=True)
    m._address = "udpin://0.0.0.0:14541"
    m._running = m._connected = True
    m._last_rx_t = time.monotonic() - 2.5          # silent for 2.5 s already
    task = asyncio.create_task(m._link_watch())
    try:
        await asyncio.sleep(0.4)
        assert m._snapshot.link_ok is False
        assert pushes and pushes[-1]["link_ok"] is False
        assert any("LINK LOST: fleet link udpin://0.0.0.0:14541" in r.message for r in caplog.records)
        m._count("attitude")                        # a real message arrives
        await asyncio.sleep(0.4)
        assert m._snapshot.link_ok is True and m._snapshot.link_lost_s == 0.0
        assert any("LINK RESTORED: fleet link" in r.message for r in caplog.records)
    finally:
        task.cancel()


@pytest.mark.asyncio
async def test_own_updates_do_not_count_as_link_life():
    m = TelemetryManager(on_update=lambda d: None)
    m._running = m._connected = True
    m._last_rx_t = time.monotonic() - 3.0
    m._emit(force=True)                             # an app-side push, not a message
    assert time.monotonic() - m._last_rx_t > 2.5

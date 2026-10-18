"""Fleet watchdog backoff (terminal error cleanup, 2026-10-18).

The watchdog used to probe every empty SITL port (udp 14541-14548) every
couple of minutes forever: one mavsdk_server and one ERROR line per port per
try, plus "bind error: Address in use" for a port held by an unrelated
process. Now each instance backs off exponentially, is parked after a cap,
is logged once per run of misses, long-dead adopted drones are forgotten,
and a port another process holds is never handed to a mavsdk_server.

No sockets, no processes: the connect, the port check and the clock are
all faked.
"""
import asyncio
import logging
import types

import pytest

from app.config import get_settings
from app.fleet import service as fleet_service


@pytest.fixture
def fleet(monkeypatch):
    saved = {k: dict(getattr(fleet_service, k)) for k in
             ("_managers", "_state", "_db_ids", "_names", "_last_update", "_retry")}
    saved_adopted = set(fleet_service._adopted)
    for k in saved:
        getattr(fleet_service, k).clear()
    fleet_service._adopted.clear()
    fleet_service._connect_locks.clear()
    s = get_settings()
    monkeypatch.setattr(s, "fleet_watchdog_backoff_max_s", 400.0)
    monkeypatch.setattr(s, "fleet_watchdog_max_retries", 5)
    monkeypatch.setattr(s, "fleet_watchdog_forget_s", 3600.0)
    monkeypatch.setattr(fleet_service, "MAX_SCAN", 2)
    clock = types.SimpleNamespace(now=1000.0)
    monkeypatch.setattr(fleet_service, "_now", lambda: clock.now)
    calls: list[int] = []
    answers: dict[int, str] = {}

    async def fake_connect(i, *, quiet=False):
        assert quiet, "watchdog probes must be quiet"
        calls.append(i)
        return answers.get(i, f"no drone on udpin://0.0.0.0:{fleet_service._port_for(i)}")

    monkeypatch.setattr(fleet_service, "_connect_one_locked", fake_connect)
    monkeypatch.setattr(fleet_service, "_port_busy", lambda port: False)
    monkeypatch.setattr(fleet_service, "_own_server_on", lambda port: False)
    yield types.SimpleNamespace(clock=clock, calls=calls, answers=answers)
    for k, v in saved.items():
        d = getattr(fleet_service, k)
        d.clear()
        d.update(v)
    fleet_service._adopted.clear()
    fleet_service._adopted.update(saved_adopted)
    fleet_service._connect_locks.clear()


def test_backoff_doubles_from_one_interval_and_is_capped(fleet):
    base = fleet_service.WATCHDOG_INTERVAL_S
    assert fleet_service._backoff_s(1) == base
    assert fleet_service._backoff_s(2) == 2 * base
    assert fleet_service._backoff_s(3) == 4 * base
    assert fleet_service._backoff_s(10) == 400.0      # the configured cap


async def test_an_empty_port_is_retried_only_when_its_backoff_runs_out(fleet):
    await fleet_service._watchdog_cycle()
    assert sorted(fleet.calls) == [1, 2]
    fleet.calls.clear()

    # Next cycle, one interval later: due again (first backoff = 1 interval).
    fleet.clock.now += fleet_service.WATCHDOG_INTERVAL_S
    await fleet_service._watchdog_cycle()
    assert sorted(fleet.calls) == [1, 2]
    fleet.calls.clear()

    # Second backoff is two intervals: one interval later, nothing is tried.
    fleet.clock.now += fleet_service.WATCHDOG_INTERVAL_S
    await fleet_service._watchdog_cycle()
    assert fleet.calls == []
    fleet.clock.now += fleet_service.WATCHDOG_INTERVAL_S
    await fleet_service._watchdog_cycle()
    assert sorted(fleet.calls) == [1, 2]


async def test_retries_are_capped_and_a_manual_connect_unparks(fleet, monkeypatch):
    for _ in range(20):
        await fleet_service._watchdog_cycle()
        fleet.clock.now += 10_000.0           # always past any backoff
    assert fleet.calls.count(1) == 5          # fleet_watchdog_max_retries
    assert fleet_service._retry[1].parked

    # An operator's CONNECT lifts the park for that instance.
    async def real_locked(i, *, quiet=False):
        return "connected"
    monkeypatch.setattr(fleet_service, "_connect_one_locked", real_locked)
    assert await fleet_service.connect_one(1, manual=True) == "connected"
    assert 1 not in fleet_service._retry


async def test_each_run_of_misses_is_logged_once_not_per_try(fleet, caplog):
    caplog.set_level(logging.DEBUG, logger="verocore.fleet")
    for _ in range(4):
        await fleet_service._watchdog_cycle()
        fleet.clock.now += 10_000.0
    fleet_lines = [r for r in caplog.records if r.name == "verocore.fleet"]
    assert not [r for r in fleet_lines if r.levelno >= logging.ERROR]
    per_port = [r for r in fleet_lines if "udp 14541" in r.getMessage()]
    assert len(per_port) == 1 and per_port[0].levelno == logging.INFO

    # The give-up is the one other line.
    for _ in range(4):
        await fleet_service._watchdog_cycle()
        fleet.clock.now += 10_000.0
    per_port = [r for r in caplog.records
                if r.name == "verocore.fleet" and "udp 14541" in r.getMessage()]
    assert len(per_port) == 2 and "gave up" in per_port[1].getMessage()


async def test_a_drone_that_was_adopted_is_announced_as_a_warning(fleet, caplog):
    caplog.set_level(logging.INFO, logger="verocore.fleet")
    fleet_service._adopted.add(2)
    fleet_service._last_update[2] = fleet.clock.now
    await fleet_service._watchdog_cycle()
    warn = [r for r in caplog.records if "udp 14542" in r.getMessage()]
    assert len(warn) == 1 and warn[0].levelno == logging.WARNING


async def test_success_resets_the_backoff(fleet):
    await fleet_service._watchdog_cycle()
    assert fleet_service._retry[1].failures == 1
    fleet.answers[1] = "connected"
    fleet.clock.now += 10_000.0
    await fleet_service._watchdog_cycle()
    assert 1 not in fleet_service._retry


async def test_a_long_dead_adopted_drone_is_forgotten(fleet):
    fleet_service._adopted.update({2, 12})
    fleet_service._last_update[2] = fleet.clock.now
    fleet_service._last_update[12] = fleet.clock.now
    # A live, connected drone is never forgotten however old its stamp.
    fleet_service._adopted.add(13)
    fleet_service._managers[13] = types.SimpleNamespace(is_connected=True)
    fleet_service._last_update[13] = fleet.clock.now

    fleet.clock.now += 3000.0
    assert fleet_service._forget_stale(fleet.clock.now) == []
    fleet.clock.now += 1000.0                 # past fleet_watchdog_forget_s
    assert fleet_service._forget_stale(fleet.clock.now) == [2, 12]
    assert fleet_service._adopted == {13}


async def test_forgotten_high_instance_is_no_longer_scanned(fleet, monkeypatch):
    fleet_service._adopted.add(12)
    fleet_service._last_update[12] = fleet.clock.now - 10_000.0
    await fleet_service._watchdog_cycle()
    assert 12 not in fleet.calls


async def test_a_port_held_by_another_process_spawns_no_mavsdk_server(fleet, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="verocore.fleet")
    monkeypatch.setattr(fleet_service, "_port_busy", lambda port: port == 14541)
    await fleet_service._watchdog_cycle()
    assert fleet.calls == [2]                  # instance 1 never reached connect
    assert fleet_service._retry[1].failures == 1
    msgs = [r.getMessage() for r in caplog.records if "udp 14541" in r.getMessage()]
    assert len(msgs) == 1 and "in use by another process" in msgs[0]


async def test_our_own_leftover_server_on_the_port_is_still_reclaimed(fleet, monkeypatch):
    monkeypatch.setattr(fleet_service, "_port_busy", lambda port: True)
    monkeypatch.setattr(fleet_service, "_own_server_on", lambda port: port == 14542)
    await fleet_service._watchdog_cycle()
    assert fleet.calls == [2]


async def test_a_stale_live_link_is_rebuilt_at_once_whatever_its_backoff(fleet):
    stopped = []

    class M:
        is_connected = True

        async def stop(self, kill_stale=True):
            stopped.append(True)

    fleet_service._managers[1] = M()
    fleet_service._last_update[1] = fleet.clock.now - 60.0     # past STALE_AFTER_S
    fleet_service._retry[1] = fleet_service._Retry(failures=3, next_at=fleet.clock.now + 999)
    await fleet_service._watchdog_cycle()
    assert stopped and 1 in fleet.calls

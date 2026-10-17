"""Browser sessions vs the SERVER delivery fleet (audit B7, B26).

- a session's fleet lookup prefers its OWN connected manager and only falls
  through to the server fleet's for commanding; the stop paths never see
  the server fleet's manager;
- scan requests are clamped so a bad payload cannot spawn hundreds of
  mavsdk_servers.
"""
import types

import pytest

from app.events import swarm_events
from app.fleet import service as fleet_service
from app.sessions.manager import SessionManager


def _mgr(connected=True):
    return types.SimpleNamespace(is_connected=connected, address="udpin://0.0.0.0:14541")


@pytest.fixture
def server_owns_1(monkeypatch):
    server = _mgr()
    monkeypatch.setattr(fleet_service, "live_manager",
                        lambda i: server if i == 1 else None)
    return server


def test_own_connected_manager_wins_over_the_server_fleet(server_owns_1):
    sm = SessionManager()
    s = sm.create("sid")
    own = _mgr()
    sm.attach_fleet_drone(s.session_id, 1, own)
    assert sm.get_fleet_drone(s.session_id, 1) is own


def test_commanding_falls_through_to_the_server_fleet_without_an_own_link(server_owns_1):
    sm = SessionManager()
    s = sm.create("sid")
    assert sm.get_fleet_drone(s.session_id, 1) is server_owns_1
    dead = _mgr(connected=False)
    sm.attach_fleet_drone(s.session_id, 1, dead)
    assert sm.get_fleet_drone(s.session_id, 1) is server_owns_1


def test_stop_paths_never_see_the_server_fleets_manager(server_owns_1):
    """The manual-connect handler stops what it finds for drone N. It must
    only ever find THIS session's manager."""
    sm = SessionManager()
    s = sm.create("sid")
    assert sm.own_fleet_drone(s.session_id, 1) is None
    assert sm.pop_fleet_drone(s.session_id, 1) is None
    own = _mgr()
    sm.attach_fleet_drone(s.session_id, 1, own)
    assert sm.own_fleet_drone(s.session_id, 1) is own
    assert sm.pop_fleet_drone(s.session_id, 1) is own
    assert sm.pop_fleet_drone(s.session_id, 1) is None


def test_server_fleet_ownership_probe(server_owns_1):
    assert swarm_events._server_fleet_owns(1)
    assert not swarm_events._server_fleet_owns(2)


def test_ownership_probe_survives_a_broken_fleet_service(monkeypatch):
    def boom(i):
        raise RuntimeError("no fleet")
    monkeypatch.setattr(fleet_service, "live_manager", boom)
    assert not swarm_events._server_fleet_owns(1)


# --------------------------------------------------------------------------- #
# B26: scan bounds                                                             #
# --------------------------------------------------------------------------- #

def test_scan_count_is_clamped():
    assert len(swarm_events.scan_ports_from({"count": 500})) == swarm_events.SCAN_MAX_DRONES
    assert swarm_events.scan_ports_from({"count": 2}) == [14541, 14542]
    assert swarm_events.scan_ports_from({"count": -3}) == [14541]


def test_scan_legacy_range_is_clamped():
    assert swarm_events.scan_ports_from({}) == [14541, 14542, 14543]
    wide = swarm_events.scan_ports_from({"port_start": 14541, "port_end": 60000})
    assert len(wide) == swarm_events.SCAN_MAX_DRONES and wide[0] == 14541
    assert swarm_events.scan_ports_from({"port_start": 14545, "port_end": 14541}) == [14545]


def test_scan_rejects_privileged_or_garbage_ports():
    with pytest.raises(ValueError):
        swarm_events.scan_ports_from({"port_start": 80, "port_end": 90})
    with pytest.raises(ValueError):
        swarm_events.scan_ports_from({"count": "lots"})

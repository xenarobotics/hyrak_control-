"""The avoidance loop reads a SESSION-linked drone (no fleet link) through
TelemetryManager.snapshot - a property. Calling it crashed every loop tick
('TelemetrySnapshot' object is not callable), so avoidance was dead whenever
a drone was linked only through the browser session (2026-09-28 log)."""
from app.avoidance.core import loop as av_loop
from app.telemetry.manager import TelemetryManager


class _Sess:
    def __init__(self, sid, drone_id):
        self.session_id, self.drone = sid, {"id": drone_id}


class _SM:
    def __init__(self, mgr):
        self.mgr = mgr

    def all_sessions(self):
        return [_Sess("s1", "d-sess")]

    def get_telemetry(self, sid):
        return self.mgr


def test_session_linked_drone_resolves(monkeypatch):
    m = TelemetryManager(on_update=lambda d: None)
    m._connected = True
    m._snapshot.position.latitude_deg = 17.5
    m._snapshot.position.longitude_deg = 78.1
    m._snapshot.position.relative_altitude_m = 12.0
    m._snapshot.mission_current_index = 4
    monkeypatch.setattr(TelemetryManager, "is_connected", property(lambda self: True), raising=False)
    monkeypatch.setattr(av_loop, "_session_manager", _SM(m))
    mgr, pose, in_air, mode = av_loop._resolve_link("d-sess")
    assert mgr is m and pose is not None and in_air
    assert abs(pose.alt_m - 12.0) < 1e-6
    assert av_loop._current_index("d-sess") == 4

"""Executor: what each decision sends to the aircraft (current and legacy)."""
import pytest
from app.avoidance.core import controller as avoidance
from app.avoidance.core.controller import AvoidanceController, AvoidanceState


class _FakeManager:
    def __init__(self, connected=True, upload_ok=True):
        self.is_connected = connected
        self._upload_ok = upload_ok
        self.calls = []

    async def set_flight_mode(self, mode):
        self.calls.append(("mode", mode)); return True

    async def upload_mission(self, waypoints, terrain_follow=False):
        self.calls.append(("upload", len(waypoints)))
        return self._upload_ok, "" if self._upload_ok else "boom"

    async def start_mission(self):
        self.calls.append(("start", None)); return True


@pytest.mark.asyncio
async def test_local_executor_enters_offboard_once_streams_then_holds_and_resumes():
    from types import SimpleNamespace as NS
    from app.avoidance.core import executor
    from app.avoidance.core.controller import Decision

    class Link:
        def __init__(self):
            self.calls, self.is_connected, self._offboard_active = [], True, False
            self._snapshot = NS(flight_mode=NS(mode="MISSION"))
        async def start_offboard(self):
            self.calls.append("offboard"); self._offboard_active = True; return True
        async def send_velocity_ned(self, *a):
            self.calls.append("ned")
        async def set_flight_mode(self, m):
            self.calls.append(m); self._snapshot.flight_mode.mode = m; return True
        def release_offboard_state(self):
            self._offboard_active = False
        async def resume_mission_from_offboard(self, i):
            self.calls.append(f"resume@{i}"); return True

    link, c = Link(), AvoidanceController("ex"); c.set_enabled(True)
    for _ in range(3):
        d = Decision("avoid", AvoidanceState.AVOIDING, "")
        d.setpoint = NS(vn=2.0, ve=0.5, vd=0.0, yaw_deg=14.0)
        assert (await executor.apply_local(link, c, d, 4))[0]
    assert (await executor.apply_local(link, c, Decision("hold", AvoidanceState.HOLDING, ""), 4))[0]
    assert not (await executor.apply_local(link, c, Decision("hold", AvoidanceState.HOLDING, ""), 4))[0]
    assert (await executor.apply_local(link, c, Decision("resume", AvoidanceState.NOMINAL, ""), 4))[0]
    assert link.calls == ["offboard", "ned", "ned", "ned", "HOLD", "resume@4"]
    assert not c.intervened

@pytest.mark.asyncio
async def test_executor_hold_and_return_use_flight_modes():
    from app.avoidance.core import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "hold", None, intervened=False)
    assert did and ("mode", "HOLD") in m.calls
    await executor.apply(m, "return", None, intervened=True)
    assert ("mode", "RETURN") in m.calls

@pytest.mark.asyncio
async def test_executor_reroute_uploads_then_starts():
    from app.avoidance.core import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "reroute", [{"lat": 1, "lng": 2}], False)
    assert did
    assert ("upload", 1) in m.calls and ("start", None) in m.calls

@pytest.mark.asyncio
async def test_executor_clear_resumes_only_if_intervened():
    from app.avoidance.core import executor
    m = _FakeManager()
    did, _ = await executor.apply(m, "clear", None, intervened=False)
    assert did is False and m.calls == []          # never touched an untouched drone
    did, _ = await executor.apply(m, "clear", None, intervened=True)
    assert did is False and m.calls == []          # detour still flying to goal: leave it
    import types
    m._snapshot = types.SimpleNamespace(flight_mode=types.SimpleNamespace(mode="HOLD"))
    did, _ = await executor.apply(m, "clear", None, intervened=True)
    assert did and ("start", None) in m.calls      # WE parked it in HOLD: hand control back

@pytest.mark.asyncio
async def test_executor_no_link_commands_nothing():
    from app.avoidance.core import executor
    did, note = await executor.apply(_FakeManager(connected=False), "hold",
                                     None, False)
    assert did is False and note == "no link"

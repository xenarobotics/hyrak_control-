"""Hand-back to the mission keeps the Offboard stream alive until MISSION has
taken over (SITL 2026-09-26 18:21: the watchdog braked to zero during the
set-current round trip and PX4 inherited the brake as a flight BACK at the
pillar)."""
import asyncio

from app.telemetry.manager import TelemetryManager


class _Mission:
    def __init__(self, log):
        self.log = log

    async def set_current_mission_item(self, i):
        self.log.append(("set_current", i))
        await asyncio.sleep(0.35)            # a slow MAVLink round trip

    async def start_mission(self):
        self.log.append(("start",))


class _Offboard:
    def __init__(self, log):
        self.log = log

    async def set_velocity_ned(self, v):
        self.log.append(("vel", v.north_m_s))


class _Drone:
    def __init__(self, log):
        self.mission, self.offboard = _Mission(log), _Offboard(log)


def _mgr(log):
    m = TelemetryManager(on_update=lambda d: None)
    m._drone = _Drone(log)
    m._connected = True
    m._offboard_active = True

    async def _mode(timeout=2.0):
        return True
    m._wait_for_mission_mode = _mode
    return m


def test_resume_streams_last_setpoint_until_mission_starts():
    log = []
    m = _mgr(log)

    async def run():
        await m.send_velocity_ned(-3.8, 0.0, 0.0, 170.0)
        m._snapshot.mission_current_index = 15
        return await m.resume_mission_from_offboard(16)
    assert asyncio.run(run())
    start = log.index(("start",))
    during = [e for e in log[log.index(("set_current", 16)):start] if e[0] == "vel"]
    assert len(during) >= 2 and all(v == -3.8 for _, v in during)   # never a zero brake
    assert not any(e[0] == "vel" for e in log[start:])


def test_resume_skips_set_current_when_already_on_that_item():
    log = []
    m = _mgr(log)

    async def run():
        await m.send_velocity_ned(-3.8, 0.0, 0.0, 170.0)
        m._snapshot.mission_current_index = 16
        return await m.resume_mission_from_offboard(16)
    assert asyncio.run(run())
    assert not any(e[0] == "set_current" for e in log)

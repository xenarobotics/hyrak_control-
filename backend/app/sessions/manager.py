import asyncio
import logging
from typing import Optional
from app.sessions.models import DroneSession, AnalysisMode
from app.telemetry.manager import TelemetryManager

logger = logging.getLogger("verocore.sessions")


class SessionManager:
    """
    Tracks every active browser session.
    Owns the TelemetryManager for each session.
    Thread-safe for reads - writes happen only on connect/disconnect.
    """

    def __init__(self):
        # session_id → DroneSession
        self._sessions: dict[str, DroneSession] = {}
        # session_id → TelemetryManager
        self._telemetry: dict[str, TelemetryManager] = {}
        # session_id → {drone_id: TelemetryManager} - one fleet PER SESSION.
        # Each client's swarm is entirely their own: drone ids only need to
        # be unique WITHIN a session, so two different sessions can each run
        # their own "Drone 1..N" on the same default port numbers (each on
        # their own machine) without colliding, sharing telemetry, or being
        # able to see or command each other's fleet. (This used to be one
        # dict shared by every session - the "kill each other's
        # mavsdk_servers" problem that caused was real, but the fix was
        # scoping-by-session, not sharing everything; each session's stop()
        # already only touches ITS OWN managers' mavsdk_servers.)
        self._fleets: dict[str, dict[int, TelemetryManager]] = {}
        self._fleet_users: set[str] = set()

    # ------------------------------------------------------------------ #
    # Session lifecycle                                                    #
    # ------------------------------------------------------------------ #

    def create(self, socket_id: str) -> DroneSession:
        session = DroneSession(socket_id=socket_id)
        self._sessions[session.session_id] = session
        logger.info(f"Session created: {session.session_id[:8]} (sid={socket_id[:8]})")
        return session

    async def destroy(self, session_id: str):
        session = self._sessions.pop(session_id, None)
        if not session:
            return

        tel = self._telemetry.pop(session_id, None)
        if tel:
            if tel.is_connected and tel._offboard_active:
                try:
                    await asyncio.wait_for(tel.stop_offboard(), timeout=2.0)
                except Exception:
                    pass
            await tel.stop()

        # Leave the shared fleet; managers stop only if this was the last
        # swarm session (stop() kills each manager's OWN mavsdk_server by its
        # unique gRPC port, so a new session connecting concurrently is safe).
        stopped = await self.release_fleet_user(session_id)
        if stopped:
            logger.info(f"Last swarm session left - stopped {stopped} fleet drone(s)")

        logger.info(f"Session destroyed: {session_id[:8]}")

    def get_by_socket(self, socket_id: str) -> Optional[DroneSession]:
        for s in self._sessions.values():
            if s.socket_id == socket_id:
                return s
        return None

    def get(self, session_id: str) -> Optional[DroneSession]:
        return self._sessions.get(session_id)

    def all_sessions(self) -> list[DroneSession]:
        return list(self._sessions.values())

    # ------------------------------------------------------------------ #
    # Telemetry                                                            #
    # ------------------------------------------------------------------ #

    def attach_telemetry(
        self, session_id: str, manager: TelemetryManager
    ) -> bool:
        if session_id not in self._sessions:
            return False
        self._telemetry[session_id] = manager
        self._sessions[session_id].telemetry_connected = True
        return True

    def get_telemetry(self, session_id: str) -> Optional[TelemetryManager]:
        return self._telemetry.get(session_id)

    def detach_telemetry(self, session_id: str):
        self._telemetry.pop(session_id, None)
        session = self._sessions.get(session_id)
        if session:
            session.telemetry_connected = False

    def find_other_telemetry_session(
        self, exclude_session_id: str, address: str
    ) -> Optional[tuple[str, TelemetryManager]]:
        """
        Only evict a session that's holding the SAME MAVLink endpoint - a
        literal port/address conflict (e.g. two direct connects to the same
        hardcoded UDP port, or the same physical serial device). Used to
        gracefully hand that one off instead of blindly killing every
        mavsdk_server process on the machine.

        Each cloud client bridges their OWN hardware/SITL through their own
        browser (see serial_bridge.SerialBridge - one per session, on a
        unique OS-assigned loopback port), so independent clients never share
        an address and never evict each other here, even if they're all
        running SITL on the same default port on their own machines. This
        used to match ANY other live session regardless of address, which
        meant a second client connecting anywhere would silently kick off
        every other session on the server - not what "independent sessions"
        is supposed to mean.
        """
        for session_id, tel in self._telemetry.items():
            if session_id != exclude_session_id and tel.address == address:
                return session_id, tel
        return None

    # ------------------------------------------------------------------ #
    # Fleet (swarm) - one independent drone registry PER SESSION          #
    # ------------------------------------------------------------------ #

    def attach_fleet_drone(self, session_id: str, drone_id: int, manager: TelemetryManager) -> bool:
        if session_id not in self._sessions:
            return False
        self._fleets.setdefault(session_id, {})[drone_id] = manager
        self._fleet_users.add(session_id)
        return True

    def get_fleet_drone(self, session_id: str, drone_id: int) -> Optional[TelemetryManager]:
        return self._fleets.get(session_id, {}).get(drone_id)

    def pop_fleet_drone(self, session_id: str, drone_id: int) -> Optional[TelemetryManager]:
        """Remove a drone from THIS session's fleet WITHOUT stopping it - the
        caller stops it synchronously (fire-and-forget stops race scans)."""
        fleet = self._fleets.get(session_id)
        if not fleet:
            return None
        return fleet.pop(drone_id, None)

    def detach_fleet_drone(self, session_id: str, drone_id: int):
        manager = self.pop_fleet_drone(session_id, drone_id)
        if manager:
            import asyncio
            # stop() kills only this manager's own mavsdk_server (gRPC-port
            # scoped), so other drones - including same-numbered drones in
            # another session's fleet - are never touched.
            asyncio.create_task(manager.stop(kill_stale=True))

    def get_fleet(self, session_id: str) -> dict:
        return dict(self._fleets.get(session_id, {}))

    def mark_fleet_user(self, session_id: str):
        self._fleet_users.add(session_id)

    def fleet_user_sessions(self) -> list[str]:
        return list(self._fleet_users)

    def is_fleet_user(self, session_id: str) -> bool:
        return session_id in self._fleet_users

    async def release_fleet_user(self, session_id: str) -> int:
        """Deregister a swarm session and stop every drone in ITS OWN fleet.
        Fleets are per-session now, so there's no other session's usage to
        weigh - leaving just means stopping what THIS session connected.
        Returns how many managers were stopped."""
        self._fleet_users.discard(session_id)
        fleet = self._fleets.pop(session_id, None)
        if not fleet:
            return 0
        await asyncio.gather(
            *[m.stop(kill_stale=True) for m in fleet.values()],
            return_exceptions=True,
        )
        return len(fleet)

    # ------------------------------------------------------------------ #
    # Mode                                                                 #
    # ------------------------------------------------------------------ #

    def set_mode(self, session_id: str, mode: AnalysisMode):
        session = self._sessions.get(session_id)
        if session:
            session.mode = mode
            logger.info(f"Session {session_id[:8]} mode → {mode.value}")

    # ------------------------------------------------------------------ #
    # Stats                                                                #
    # ------------------------------------------------------------------ #

    @property
    def active_count(self) -> int:
        return len(self._sessions)

    @property
    def session_ids(self) -> list[str]:
        return list(self._sessions.keys())
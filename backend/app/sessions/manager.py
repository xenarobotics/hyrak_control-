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
    Thread-safe for reads — writes happen only on connect/disconnect.
    """

    def __init__(self):
        # session_id → DroneSession
        self._sessions: dict[str, DroneSession] = {}
        # session_id → TelemetryManager
        self._telemetry: dict[str, TelemetryManager] = {}
        # Shared fleet: swarm drones are physical resources — ONE manager per
        # drone no matter how many browser sessions are open. Per-session
        # fleets made concurrent sessions kill each other's mavsdk_servers
        # (every scan endpoint-killed the other session's fresh links).
        # Sessions using swarm mode register here; managers stop only when
        # the last user leaves.
        self._global_fleet: dict[int, TelemetryManager] = {}
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
            logger.info(f"Last swarm session left — stopped {stopped} fleet drone(s)")

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

    def find_other_telemetry_session(self, exclude_session_id: str) -> Optional[tuple[str, TelemetryManager]]:
        """
        Only one mavsdk_server can hold the drone link (one serial port / one
        gRPC port) at a time, so only one session should have live telemetry.
        Used to gracefully hand off instead of blindly killing every
        mavsdk_server process on the machine, which would also sever any
        other session that's legitimately still using it.
        """
        for session_id, tel in self._telemetry.items():
            if session_id != exclude_session_id:
                return session_id, tel
        return None

    # ------------------------------------------------------------------ #
    # Fleet (swarm) — GLOBAL drone registry shared by all sessions        #
    # (session_id params kept for call-site compatibility; they now only  #
    # mark the session as a fleet user)                                   #
    # ------------------------------------------------------------------ #

    def attach_fleet_drone(self, session_id: str, drone_id: int, manager: TelemetryManager) -> bool:
        self._global_fleet[drone_id] = manager
        self._fleet_users.add(session_id)
        return True

    def get_fleet_drone(self, session_id: str, drone_id: int) -> Optional[TelemetryManager]:
        return self._global_fleet.get(drone_id)

    def pop_fleet_drone(self, drone_id: int) -> Optional[TelemetryManager]:
        """Remove a drone from the shared fleet WITHOUT stopping it — the
        caller stops it synchronously (fire-and-forget stops race scans)."""
        return self._global_fleet.pop(drone_id, None)

    def detach_fleet_drone(self, session_id: str, drone_id: int):
        manager = self._global_fleet.pop(drone_id, None)
        if manager:
            import asyncio
            # stop() kills only this manager's own mavsdk_server (gRPC-port
            # scoped), so other drones and concurrent sessions are safe
            asyncio.create_task(manager.stop(kill_stale=True))

    def get_fleet(self, session_id: str) -> dict:
        return dict(self._global_fleet)

    def mark_fleet_user(self, session_id: str):
        self._fleet_users.add(session_id)

    def is_fleet_user(self, session_id: str) -> bool:
        return session_id in self._fleet_users

    async def release_fleet_user(self, session_id: str) -> int:
        """Deregister a swarm session. Stops the shared fleet only when the
        last user leaves. Returns how many managers were stopped."""
        self._fleet_users.discard(session_id)
        if self._fleet_users or not self._global_fleet:
            return 0
        fleet = dict(self._global_fleet)
        self._global_fleet.clear()
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
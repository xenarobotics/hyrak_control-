import asyncio
import logging
import subprocess
import time

from app.sessions.manager import SessionManager
from app.events.telemetry_events import execute_drone_action
from app.flights import recorder
from app.registry import drones as drone_registry
from app.telemetry import swarm_relay_bridge
from app.utils.geo import haversine_m

logger = logging.getLogger("verocore.events.swarm")

# Must match frontend FLEET_COLORS in lib/fleet.ts - indexed by (drone_id - 1)
DRONE_COLORS = [
    '#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#ef4444',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#6366f1',
    '#14b8a6', '#eab308', '#f43f5e', '#0ea5e9', '#22c55e',
    '#d946ef', '#fb923c', '#8b5cf6', '#2dd4bf', '#dc2626',
]


def color_for_drone(drone_id: int) -> str:
    return DRONE_COLORS[(drone_id - 1) % len(DRONE_COLORS)]


# PX4 SITL instance i sends its offboard MAVLink to UDP 14540+i, EXCEPT that
# 14550 is the QGC broadcast port, so instances >= 10 are shifted up by one
# (see the px4-rc.mavlink patch in ~/PX4-Autopilot). Drone id == instance id.
def port_for_drone(drone_id: int) -> int:
    return 14541 + drone_id if drone_id > 9 else 14540 + drone_id


def drone_for_port(port: int) -> int:
    return port - 14541 if port > 14550 else port - 14540


# How long to wait for a MAVLink heartbeat per port during scanning.
# Active SITL instances connect in <2 s; dead ports are abandoned after this.
_SCAN_CONNECT_TIMEOUT = 3.0

# How many ports to probe simultaneously. Each probe spawns a mavsdk_server;
# the bound keeps a 30-port scan quick (~4 rounds) without a fork storm.
_SCAN_CONCURRENCY = 8

# Scanning is CPU/process-cheap but a mavsdk_server spawn storm across many
# concurrent scans is not, so scans still queue globally rather than running
# in parallel - this only throttles scan throughput, it doesn't share any
# drone STATE between sessions (each scan only ever touches its own
# session's fleet; see session_manager.get_fleet_drone).
_scan_lock = asyncio.Lock()

# Batched fleet telemetry: managers write their latest snapshot keyed by
# (session_id, drone_id) - each session's fleet is independent, so two
# sessions can each have their own "drone 1" without either seeing the
# other's data. A per-session emitter ships ONE fleet_telemetry event for
# that session's drones at ~3 Hz on that session's own socket.
_FLEET_EMIT_INTERVAL = 0.33
_fleet_state: dict[tuple[str, int], dict] = {}      # (session_id, drone_id) → snapshot
_fleet_seen: dict[tuple[str, int], float] = {}      # (session_id, drone_id) → last snapshot time
_fleet_emitters: dict[str, asyncio.Task] = {}       # session_id → emitter task

# Fleet drone DB identities. PX4 SITL instances share one firmware UID, so
# identity is the (session, instance id) pair, not just the instance id -
# otherwise "Drone 1" from two different clients' independent swarms would
# collide onto the SAME registry record and flight history. Real hardware
# connects through the primary (browser-radio) path, which reads the true
# hardware UID and isn't affected by this.
_fleet_db_ids: dict[tuple[str, int], str] = {}      # (session_id, drone_id) → drones.id (uuid)

# ── Fleet supervisor ─────────────────────────────────────────────────────────
# One 1 Hz watchdog task shared by the whole process, but it walks every
# session's fleet SEPARATELY: low battery (warn, then auto-RTL), stale
# telemetry, live inter-drone separation, and fleet-mission completion are
# all computed within one session's own drones only, and `fleet_alert`
# events go only to that session's own socket - never broadcast to every
# swarm user on the server.
_SUP_INTERVAL = 1.0
_BATT_WARN_PCT = 25.0
_BATT_RTL_PCT = 15.0
_LINK_STALE_S = 5.0
# 2.5 m keeps the 3 m SITL spawn grid quiet while catching true convergence
_SEP_HORIZ_M = 2.5
_SEP_VERT_M = 3.0
_sup_task: dict[str, asyncio.Task | None] = {"task": None}
_sup_drone: dict[tuple[str, int], dict] = {}        # (session_id, drone_id) → watchdog state
_sup_pair_alert: dict[tuple, float] = {}            # (session_id, id, id) → last separation alert
_sup_complete: dict[str, bool] = {}                 # session_id → announced


async def _register_fleet_drone(session_id: str, drone_id: int) -> None:
    """Give a fleet drone its persistent registry identity (idempotent).
    UID is scoped to the session so two clients' independent "Drone 1"s
    never merge into one registry record / flight history."""
    key = (session_id, drone_id)
    if key in _fleet_db_ids:
        return
    rec = await drone_registry.upsert_seen(f"sitl-{session_id[:8]}-instance-{drone_id}", is_simulated=True)
    if rec:
        _fleet_db_ids[key] = rec["id"]


def _end_fleet_flight(session_id: str, drone_id: int) -> None:
    """Finalise a fleet drone's open flight record, if any (fire-and-forget)."""
    try:
        asyncio.get_running_loop().create_task(
            recorder.end_flight(f"fleet-{session_id[:8]}-{drone_id}")
        )
    except RuntimeError:
        pass


def cleanup_session_fleet_state(session_id: str) -> None:
    """Drop every swarm bookkeeping entry for a session that's gone.

    The TelemetryManagers themselves are already stopped by
    SessionManager.release_fleet_user() (called from session_manager.destroy
    on disconnect, or directly by the set_swarm_mode-disable handler below).
    This just clears the per-session entries kept in THIS module's dicts -
    without it, a tab closed without an explicit swarm disable would leave
    its drone ids sitting in these dicts forever.
    """
    for d in (_fleet_state, _fleet_seen, _sup_drone, _fleet_db_ids):
        for key in [k for k in d if k[0] == session_id]:
            d.pop(key, None)
    for key in [k for k in _sup_pair_alert if k[0] == session_id]:
        _sup_pair_alert.pop(key, None)
    _sup_complete.pop(session_id, None)
    task = _fleet_emitters.pop(session_id, None)
    if task and not task.done():
        task.cancel()


async def _server_alive_for_port(port: int) -> bool:
    """True if a mavsdk_server process bound to this MAVLink port is running.
    Matches the bare ':{port}' rather than a specific host so this works
    whether the server bound 0.0.0.0 (direct same-machine SITL scan) or
    127.0.0.1 (a client's swarm bridged through swarm_relay_bridge)."""
    def _check() -> bool:
        try:
            # Match the MAVLink endpoint, not the gRPC '-p' flag
            r = subprocess.run(
                ["pgrep", "-f", f"mavsdk_server.*:{port}"],
                capture_output=True, text=True,
            )
            return bool(r.stdout.strip())
        except Exception:
            return False
    return await asyncio.get_event_loop().run_in_executor(None, _check)


def register_swarm_events(sio, session_manager: SessionManager):

    def _fleet_snapshot_cb(session_id: str, drone_id: int):
        """Telemetry callback for a fleet drone - stores the snapshot keyed
        by (session_id, drone_id) for the batched per-session emitters.
        Also feeds the flight recorder (armed→disarmed = one flight, same as
        primary drones) once the drone has a registry identity."""
        key = (session_id, drone_id)
        def cb(snapshot_dict: dict):
            _fleet_state[key] = snapshot_dict
            _fleet_seen[key] = time.time()
            db_id = _fleet_db_ids.get(key)
            if db_id:
                try:
                    asyncio.get_running_loop().create_task(
                        recorder.on_snapshot(f"fleet-{session_id[:8]}-{drone_id}", db_id, snapshot_dict)
                    )
                except RuntimeError:
                    pass
        return cb

    def _ensure_supervisor():
        task = _sup_task["task"]
        if task and not task.done():
            return
        _sup_task["task"] = asyncio.create_task(_supervisor_loop())

    async def _supervisor_loop():
        try:
            while True:
                await asyncio.sleep(_SUP_INTERVAL)
                session_ids = session_manager.fleet_user_sessions()
                if not session_ids:
                    break
                for session_id in session_ids:
                    await _supervise_one_fleet(session_id)
        except asyncio.CancelledError:
            pass
        finally:
            _sup_task["task"] = None

    async def _supervise_one_fleet(session_id: str):
        """One session's watchdog pass - battery/link/separation/mission
        checks only ever compare drones WITHIN this session's own fleet, and
        alerts go only to this session's own socket."""
        fleet = session_manager.get_fleet(session_id)
        if not fleet:
            return
        session = session_manager.get(session_id)
        if not session or not session.socket_id:
            return
        sock = session.socket_id

        async def alert(did: int, kind: str, severity: str, msg: str):
            logger.info(f"Fleet alert [{severity}] {kind} (session {session_id[:8]}): {msg}")
            await sio.emit("fleet_alert", {
                "drone_id": did, "kind": kind,
                "severity": severity, "msg": msg,
                "at": time.time(),
            }, to=sock)

        now = time.time()
        armed_air: list[tuple[int, float, float, float]] = []
        any_in_mission = False

        for did, mgr in list(fleet.items()):
            key = (session_id, did)
            snap = _fleet_state.get(key) or {}
            st = _sup_drone.setdefault(key, {})
            fm = snap.get("flight_mode", {})
            armed = bool(fm.get("is_armed"))
            pos = snap.get("position", {})
            in_air = bool(fm.get("is_in_air")) or pos.get("relative_altitude_m", 0.0) > 1.0
            batt = snap.get("battery", {}).get("remaining_percent")

            # Link staleness - snapshots normally arrive every ~1 s
            seen = _fleet_seen.get(key)
            if seen and now - seen > _LINK_STALE_S:
                if not st.get("link_lost"):
                    st["link_lost"] = True
                    await alert(did, "link_lost", "critical",
                                f"Drone {did}: telemetry lost (stale >{_LINK_STALE_S:.0f}s)")
                continue
            if st.get("link_lost"):
                st["link_lost"] = False
                await alert(did, "link_restored", "info", f"Drone {did}: telemetry restored")

            # Battery: warn at 25%, auto-RTL (PX4 RETURN - flies home
            # and lands) at 15% while airborne
            if batt is not None and armed:
                if batt < _BATT_RTL_PCT and in_air and not st.get("rtl_done"):
                    st["rtl_done"] = True
                    ok = False
                    try:
                        ok = await mgr.set_flight_mode("RETURN")
                    except Exception:
                        pass
                    await alert(did, "auto_rtl", "critical",
                                f"Drone {did}: battery {batt:.0f}% - auto-RTL "
                                f"{'engaged' if ok else 'FAILED - take manual control'}")
                elif batt < _BATT_WARN_PCT and now - st.get("batt_warned_at", 0) > 60:
                    st["batt_warned_at"] = now
                    await alert(did, "low_battery", "warn",
                                f"Drone {did}: battery {batt:.0f}%")
            if not armed:
                st["rtl_done"] = False

            # Fleet-mission completion tracking: a drone that flew a
            # mission and is now disarmed counts as done; announce once
            # when no tracked drone is still flying one.
            mci = snap.get("mission_current_index", -1)
            if armed and in_air and mci >= 0:
                if not st.get("in_mission"):
                    st["in_mission"] = True
                    st["mission_done"] = False
                    _sup_complete[session_id] = False
            elif st.get("in_mission") and not armed:
                st["in_mission"] = False
                st["mission_done"] = True
            if st.get("in_mission"):
                any_in_mission = True

            if armed and in_air and (pos.get("latitude_deg") or pos.get("longitude_deg")):
                armed_air.append((
                    did, pos.get("latitude_deg", 0.0),
                    pos.get("longitude_deg", 0.0),
                    pos.get("relative_altitude_m", 0.0),
                ))

        # Live separation between airborne drones - within this session's
        # fleet only, never across two different clients' independent sims.
        for i in range(len(armed_air)):
            for j in range(i + 1, len(armed_air)):
                d1, la1, lo1, al1 = armed_air[i]
                d2, la2, lo2, al2 = armed_air[j]
                if abs(al1 - al2) > _SEP_VERT_M:
                    continue
                horiz = haversine_m(la1, lo1, la2, lo2)
                if horiz < _SEP_HORIZ_M:
                    pair_key = (session_id, d1, d2)
                    if now - _sup_pair_alert.get(pair_key, 0) > 10:
                        _sup_pair_alert[pair_key] = now
                        await alert(d1, "separation", "critical",
                                    f"Drones {d1} & {d2} within {horiz:.1f} m "
                                    f"at similar altitude")

        dones = [d for (sid_, d), s in _sup_drone.items()
                 if sid_ == session_id and s.get("mission_done")]
        if dones and not any_in_mission and not _sup_complete.get(session_id, False):
            _sup_complete[session_id] = True
            for (sid_, _d), s in _sup_drone.items():
                if sid_ == session_id:
                    s["mission_done"] = False
            await alert(0, "fleet_complete", "info",
                        f"Fleet mission complete - {len(dones)} drone(s) finished")

    def _ensure_fleet_emitter(session_id: str):
        task = _fleet_emitters.get(session_id)
        if task and not task.done():
            return
        _fleet_emitters[session_id] = asyncio.create_task(_fleet_emit_loop(session_id))

    async def _fleet_emit_loop(session_id: str):
        try:
            while True:
                await asyncio.sleep(_FLEET_EMIT_INTERVAL)
                session = session_manager.get(session_id)
                if session is None or not session_manager.is_fleet_user(session_id):
                    break
                fleet = session_manager.get_fleet(session_id)
                # Only ship drones still attached to THIS session's fleet
                drones = {
                    did: _fleet_state[(session_id, did)]
                    for did in fleet if (session_id, did) in _fleet_state
                }
                if not drones:
                    continue
                await sio.emit("fleet_telemetry", {"drones": drones}, to=session.socket_id)
        except asyncio.CancelledError:
            pass
        finally:
            _fleet_emitters.pop(session_id, None)

    @sio.on("connect_swarm_relay")
    async def on_connect_swarm_relay(sid, data=None):
        """Browser announces its local swarm_relay.py agent is up - see
        swarm_relay_bridge.py. Registering the bridge BEFORE scanning is
        what makes scan_swarm_drones route through it instead of trying to
        connect to literal server-local ports."""
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit("error", {"msg": "No session found"}, to=sid)
            return
        bridge = swarm_relay_bridge.SwarmRelayBridge(sio, sid)
        swarm_relay_bridge.register_bridge(session.session_id, bridge)
        logger.info(f"Session {session.session_id[:8]}: swarm relay bridge registered")
        await sio.emit("swarm_relay_status", {"connected": True}, to=sid)

    @sio.on("swarm_relay_uplink")
    async def on_swarm_relay_uplink(sid, data):
        """One drone_id-tagged MAVLink frame from the browser's local relay
        agent - [drone_id: 1 byte][raw MAVLink bytes]. De-tag and hand to
        that drone's loopback endpoint."""
        if not isinstance(data, (bytes, bytearray)) or len(data) < 1:
            return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        bridge = swarm_relay_bridge.get_bridge(session.session_id)
        if not bridge:
            return
        drone_id = data[0]
        bridge.uplink(drone_id, bytes(data[1:]))

    @sio.on("scan_swarm_drones")
    async def on_scan_swarm_drones(sid, data):
        """
        Scan for PX4 SITL drones by attempting a real MAVSDK connection to each
        candidate port with a timeout. kill_stale is endpoint-scoped in
        TelemetryManager, so each connect/stop only touches the mavsdk_server
        bound to ITS OWN port - the primary drone and other fleet drones are
        never affected.

        Payload: { count } (drones 1..count) or legacy { port_start, port_end }
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return

        if _scan_lock.locked():
            logger.info("Scan queued behind an in-flight scan")
        async with _scan_lock:
            # Session may have died while we waited
            if session_manager.get(session.session_id) is None:
                return
            await _run_scan(sid, session, data)

    async def _run_scan(sid, session, data):
        count = data.get("count")
        if count:
            ports = [port_for_drone(i) for i in range(1, int(count) + 1)]
        else:
            port_start = int(data.get("port_start", 14541))
            port_end   = int(data.get("port_end",   14543))
            ports      = list(range(port_start, port_end + 1))

        await sio.emit("swarm_scan_started", {"ports": ports}, to=sid)
        logger.info(f"Scanning {len(ports)} ports for SITL drones: {ports[0]}-{ports[-1]}")

        # This session is now a fleet user. Mark it and start its emitter up
        # front so telemetry is flowing as soon as the first drone attaches.
        session_manager.mark_fleet_user(session.session_id)
        _ensure_fleet_emitter(session.session_id)

        from app.telemetry.manager import TelemetryManager

        sem = asyncio.Semaphore(_SCAN_CONCURRENCY)

        # A client bridging their OWN remote swarm through their browser
        # (see swarm_relay_bridge.py + sitl_relay/swarm_relay.py) registers
        # a bridge for this session before scanning. When present, each
        # drone gets its own per-session loopback port instead of a literal
        # server-local port - so two sessions can scan the identical
        # drone_id range (matching the identical port numbers on each
        # client's OWN machine) without ever touching the same OS port.
        # Falls back to the direct same-machine connect when no bridge is
        # registered (today's single-shared-swarm testing, unchanged).
        relay = swarm_relay_bridge.get_bridge(session.session_id)

        async def scan_port(port: int):
            drone_id = drone_for_port(port)
            name     = f"Drone {drone_id}"
            color    = color_for_drone(drone_id)
            entry    = {"port": port, "drone_id": drone_id, "name": name, "color": color}

            async with sem:
                existing = session_manager.get_fleet_drone(session.session_id, drone_id)
                if existing:
                    # Check the manager's ACTUAL bound port, not the scan's
                    # candidate port - those differ once bridged (the real
                    # mavsdk_server sits on a dynamic per-drone loopback
                    # port, not the client's literal SITL port number).
                    existing_port = int(existing.address.rsplit(":", 1)[-1])
                    if await _server_alive_for_port(existing_port):
                        # Healthy - re-announce so a freshly reloaded page sees it
                        asyncio.create_task(_register_fleet_drone(session.session_id, drone_id))
                        await sio.emit("swarm_drone_status", {
                            "drone_id": drone_id, "connected": True, "name": name, "color": color,
                        }, to=sid)
                        logger.info(f"Fleet drone {drone_id} already attached and healthy")
                        return entry
                    # Attached but its mavsdk_server is dead - stop it fully BEFORE
                    # reconnecting (a fire-and-forget stop could kill the new server).
                    logger.warning(f"Fleet drone {drone_id} attached but server dead, reconnecting")
                    session_manager.pop_fleet_drone(session.session_id, drone_id)
                    _fleet_state.pop((session.session_id, drone_id), None)
                    _end_fleet_flight(session.session_id, drone_id)
                    try:
                        await existing.stop(kill_stale=True)
                    except Exception:
                        pass

                manager = TelemetryManager(
                    on_update=_fleet_snapshot_cb(session.session_id, drone_id),
                    fleet_mode=True,
                )
                if relay:
                    bridge_port = await relay.get_or_create_port(drone_id)
                    address = f"udpin://127.0.0.1:{bridge_port}"
                else:
                    address = f"udpin://0.0.0.0:{port}"

                try:
                    # kill_stale=True is safe here - it's scoped to this port only,
                    # and clears any stale server left over from a previous session
                    # (the cause of "drones won't reconnect after page reload").
                    ok = await asyncio.wait_for(
                        manager.connect(address, kill_stale=True),
                        timeout=_SCAN_CONNECT_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    ok = False

                if ok:
                    await manager.start()
                    session_manager.attach_fleet_drone(session.session_id, drone_id, manager)
                    _ensure_fleet_emitter(session.session_id)
                    _ensure_supervisor()
                    asyncio.create_task(_register_fleet_drone(session.session_id, drone_id))
                    await sio.emit("swarm_drone_status", {
                        "drone_id": drone_id, "connected": True, "name": name, "color": color,
                    }, to=sid)
                    logger.info(f"Fleet drone {drone_id} ({name}) connected on {address}")
                    return entry

                # Scoped stop kills only the mavsdk_server spawned for this port.
                try:
                    await manager.stop(kill_stale=True)
                except Exception:
                    pass
                logger.debug(f"No response on port {port}, skipping")
                return None

        results = await asyncio.gather(*(scan_port(p) for p in ports))
        found_drones = sorted((e for e in results if e), key=lambda e: e["drone_id"])

        await sio.emit("swarm_scan_result", {
            "drones": found_drones,
            "found":  len(found_drones),
        }, to=sid)
        logger.info(f"Scan done: {len(found_drones)} drone(s) connected")

    @sio.on("set_swarm_mode")
    async def on_set_swarm_mode(sid, data):
        """
        Frontend toggled swarm mode. Each session owns its own fleet now, so
        disabling always tears down THIS session's drones (and only this
        session's) - no other client's fleet is affected either way.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if bool(data.get("enabled", True)):
            return  # enable needs no backend prep - the scan does the work
        stopped = await session_manager.release_fleet_user(session.session_id)
        for did in [d for (sid_, d) in list(_fleet_seen) if sid_ == session.session_id]:
            _end_fleet_flight(session.session_id, did)
        cleanup_session_fleet_state(session.session_id)
        if stopped:
            logger.info(f"Swarm disabled - stopped {stopped} fleet drone(s) for session {session.session_id[:8]}")
        else:
            logger.info(f"Swarm disabled for session {session.session_id[:8]} - no drones were connected")

    @sio.on("connect_swarm_drone")
    async def on_connect_swarm_drone(sid, data):
        """Connect a fleet drone manually. Payload: {drone_id, port, name, color}"""
        session = session_manager.get_by_socket(sid)
        if not session:
            return

        drone_id = int(data.get("drone_id", 1))
        port     = int(data.get("port", 14541))
        name     = str(data.get("name",  f"Drone {drone_id}"))
        color    = str(data.get("color", color_for_drone(drone_id)))

        # Same relay check as the scan path - if this session bridged its
        # own remote swarm, route through it instead of a literal server
        # port (which the "port" field means on the CLIENT's machine here).
        relay = swarm_relay_bridge.get_bridge(session.session_id)
        if relay:
            bridge_port = await relay.get_or_create_port(drone_id)
            address = f"udpin://127.0.0.1:{bridge_port}"
        else:
            address = f"udpin://0.0.0.0:{port}"

        # Stop any previous manager for this id (kill is scoped to its own port)
        existing = session_manager.get_fleet_drone(session.session_id, drone_id)
        if existing:
            await existing.stop(kill_stale=True)

        from app.telemetry.manager import TelemetryManager

        manager = TelemetryManager(
            on_update=_fleet_snapshot_cb(session.session_id, drone_id),
            fleet_mode=True,
        )
        # kill_stale is scoped to this port - cannot affect the primary drone
        connected = await manager.connect(address, kill_stale=True)

        if not connected:
            await sio.emit("swarm_drone_status", {
                "drone_id": drone_id, "connected": False,
                "name": name, "error": f"Could not connect to {address}",
            }, to=sid)
            return

        await manager.start()
        session_manager.attach_fleet_drone(session.session_id, drone_id, manager)
        _ensure_fleet_emitter(session.session_id)
        _ensure_supervisor()
        asyncio.create_task(_register_fleet_drone(session.session_id, drone_id))

        await sio.emit("swarm_drone_status", {
            "drone_id": drone_id, "connected": True, "name": name, "color": color,
        }, to=sid)
        logger.info(f"Fleet drone {drone_id} ({name}) connected - session {session.session_id[:8]}")

    @sio.on("disconnect_swarm_drone")
    async def on_disconnect_swarm_drone(sid, data):
        """Disconnect and remove a fleet drone. Payload: {drone_id}"""
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_id = int(data.get("drone_id", 1))
        session_manager.detach_fleet_drone(session.session_id, drone_id)
        relay = swarm_relay_bridge.get_bridge(session.session_id)
        if relay:
            relay.close_drone(drone_id)
        key = (session.session_id, drone_id)
        _fleet_state.pop(key, None)
        _fleet_seen.pop(key, None)
        _sup_drone.pop(key, None)
        _end_fleet_flight(session.session_id, drone_id)
        await sio.emit("swarm_drone_status", {"drone_id": drone_id, "connected": False}, to=sid)
        logger.info(f"Fleet drone {drone_id} disconnected - session {session.session_id[:8]}")

    @sio.on("swarm_action")
    async def on_swarm_action(sid, data):
        """Run an action on a specific fleet drone. Payload: {drone_id, action, ...params}"""
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_id = int(data.get("drone_id", 0))
        tel = session_manager.get_fleet_drone(session.session_id, drone_id)
        if not tel or not tel.is_connected:
            await sio.emit("swarm_action_result", {
                "drone_id": drone_id, "action": data.get("action"), "ok": False,
                "msg": "Drone not connected",
            }, to=sid)
            return
        action = data.get("action", "")
        logger.info(f"Swarm action: {action} → drone {drone_id}")
        try:
            result = await execute_drone_action(tel, action, data)
        except Exception as e:
            # Typically a dead mavsdk_server (gRPC UNAVAILABLE). Report failure
            # and flag the drone disconnected so the UI stops offering controls;
            # the next scan will detect the dead server and reconnect it.
            logger.error(f"Swarm action {action} on drone {drone_id} failed: {e}")
            await sio.emit("swarm_action_result", {
                "drone_id": drone_id, "action": action, "ok": False,
                "msg": "Drone link lost - rescan the fleet",
            }, to=sid)
            await sio.emit("swarm_drone_status", {
                "drone_id": drone_id, "connected": False,
            }, to=sid)
            return
        await sio.emit("swarm_action_result", {"drone_id": drone_id, **result}, to=sid)

    @sio.on("swarm_group_action")
    async def on_swarm_group_action(sid, data):
        """
        Run one action on many fleet drones concurrently.
        Payload: {drone_ids: [..], action, ...params, altitude_stagger?, stagger_s?}

        For takeoff, altitude_stagger > 0 layers the drones vertically:
        drone k (in ascending id order) gets altitude + k*stagger, so a
        group takeoff never stacks two drones at the same height.

        stagger_s > 0 delays drone k's action by k*stagger_s seconds - used
        for fleet mission starts so drones lift off one after another instead
        of climbing into each other's prop wash. stagger_order (list of drone
        ids) overrides the id-ascending delay order, so the client can launch
        e.g. the drone with the farthest first waypoint first.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        ids     = sorted({int(i) for i in data.get("drone_ids", [])})
        action  = str(data.get("action", ""))
        stagger = float(data.get("altitude_stagger", 0) or 0)
        stagger_s = min(float(data.get("stagger_s", 0) or 0), 15.0)
        order   = [int(i) for i in (data.get("stagger_order") or [])]
        base_alt = data.get("altitude")

        async def run_one(idx: int, did: int) -> dict:
            tel = session_manager.get_fleet_drone(session.session_id, did)
            if not tel or not tel.is_connected:
                return {"drone_id": did, "ok": False, "msg": "Not connected"}
            payload = dict(data)
            if action == "takeoff" and base_alt is not None and stagger > 0:
                payload["altitude"] = float(base_alt) + idx * stagger
            k = order.index(did) if did in order else idx
            if stagger_s > 0 and k > 0:
                await asyncio.sleep(k * stagger_s)
            try:
                # Per-drone timeout: one hung drone (dead gRPC that stalls
                # instead of erroring) must not freeze the whole group result.
                result = await asyncio.wait_for(
                    execute_drone_action(tel, action, payload), timeout=20.0,
                )
                return {"drone_id": did, "ok": bool(result.get("ok")),
                        "msg": result.get("msg", "")}
            except asyncio.TimeoutError:
                logger.error(f"Group action {action} on drone {did} timed out")
                return {"drone_id": did, "ok": False, "msg": "Timed out"}
            except Exception as e:
                logger.error(f"Group action {action} on drone {did} failed: {e}")
                await sio.emit("swarm_drone_status", {
                    "drone_id": did, "connected": False,
                }, to=sid)
                return {"drone_id": did, "ok": False, "msg": "Drone link lost"}

        logger.info(f"Group action: {action} → drones {ids}")
        results = await asyncio.gather(*(run_one(i, d) for i, d in enumerate(ids)))
        await sio.emit("swarm_group_result", {
            "action":   action,
            "results":  list(results),
            "ok_count": sum(1 for r in results if r["ok"]),
            "total":    len(results),
        }, to=sid)

    @sio.on("swarm_upload_mission")
    async def on_swarm_upload_mission(sid, data):
        """Upload a mission to a specific fleet drone. Payload: {drone_id, waypoints, terrain_follow}"""
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_id       = int(data.get("drone_id", 0))
        waypoints      = data.get("waypoints", [])
        terrain_follow = bool(data.get("terrain_follow", False))
        tel = session_manager.get_fleet_drone(session.session_id, drone_id)
        if not tel or not tel.is_connected:
            await sio.emit("swarm_mission_upload_result", {
                "drone_id": drone_id, "ok": False, "msg": "Drone not connected",
            }, to=sid)
            return
        if not waypoints:
            await sio.emit("swarm_mission_upload_result", {
                "drone_id": drone_id, "ok": False, "msg": "No waypoints provided",
            }, to=sid)
            return

        # Same airspace rules as single-drone uploads: red blocks unless this
        # drone holds an approved permit for this exact profile; orange needs
        # an explicit pilot acknowledgment (ack_orange).
        from app.zones import engine as zone_engine
        path_check = zone_engine.check_path(
            [(float(w["lat"]), float(w["lng"])) for w in waypoints]
        )
        zone_warn = ""
        permit = None
        if path_check["zone_class"] == "red":
            names = ", ".join(z["name"] for z in path_check["zones"])
            db_id = _fleet_db_ids.get((session.session_id, drone_id))
            if db_id:
                from app.permits import service as permit_service
                permit = await permit_service.find_approved(db_id, waypoints)
            if permit is None:
                await sio.emit("swarm_mission_upload_result", {
                    "drone_id": drone_id, "ok": False, "blocked": "red",
                    "can_request": bool(db_id), "zones": path_check["zones"],
                    "msg": f"Blocked - crosses NO-FLY (red) zone: {names} - permission required",
                }, to=sid)
                logger.warning(f"Fleet mission blocked for drone {drone_id} (red zones: {names})")
                return
            logger.info(f"Fleet red-zone mission allowed under permit {permit['id'][:8]} "
                        f"for drone {drone_id}")
        if path_check["zone_class"] == "orange" and permit is None:
            names = ", ".join(z["name"] for z in path_check["zones"])
            if not data.get("ack_orange"):
                await sio.emit("swarm_mission_upload_result", {
                    "drone_id": drone_id, "ok": False, "needs_ack": True,
                    "zones": path_check["zones"],
                    "msg": f"Mission passes through restricted (orange) zone: {names}",
                }, to=sid)
                return
            zone_warn = f" - passes orange zone: {names}"

        try:
            ok, err = await tel.upload_mission(waypoints, terrain_follow=terrain_follow)
        except Exception as e:
            logger.error(f"Swarm mission upload to drone {drone_id} failed: {e}")
            ok, err = False, "Drone link lost - rescan the fleet"
        await sio.emit("swarm_mission_upload_result", {
            "drone_id": drone_id, "ok": ok,
            "count": len(waypoints) if ok else 0,
            "msg": f"Uploaded {len(waypoints)} waypoints{zone_warn}" if ok
                   else f"Upload failed: {err}",
        }, to=sid)

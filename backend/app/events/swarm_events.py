import asyncio
import logging
import subprocess

from app.sessions.manager import SessionManager
from app.events.telemetry_events import execute_drone_action

logger = logging.getLogger("verocore.events.swarm")

# Must match frontend FLEET_COLORS in lib/fleet.ts — indexed by (drone_id - 1)
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

# ONE scan at a time GLOBALLY — queued, not dropped. The fleet is a shared
# resource (one manager per drone across all sessions), so concurrent scans
# from different tabs would kill each other's freshly spawned mavsdk_servers.
# Dropping duplicates is worse: the duplicate's requester never gets a
# swarm_scan_result, leaving its UI stuck on "Scanning…". Queued scans are
# cheap — already-healthy drones short-circuit.
_scan_lock = asyncio.Lock()

# Batched fleet telemetry: managers write their latest snapshot into this
# GLOBAL map (one fleet, shared by all sessions) and a per-session emitter
# ships ONE fleet_telemetry event for all drones at ~3 Hz per socket.
_FLEET_EMIT_INTERVAL = 0.33
_fleet_state: dict[int, dict] = {}                 # drone_id → snapshot
_fleet_emitters: dict[str, asyncio.Task] = {}      # session_id → emitter task


async def _server_alive_for_port(port: int) -> bool:
    """True if a mavsdk_server process bound to this MAVLink port is running."""
    def _check() -> bool:
        try:
            # Match the MAVLink endpoint, not the gRPC '-p' flag
            r = subprocess.run(
                ["pgrep", "-f", f"mavsdk_server.*0.0.0.0:{port}"],
                capture_output=True, text=True,
            )
            return bool(r.stdout.strip())
        except Exception:
            return False
    return await asyncio.get_event_loop().run_in_executor(None, _check)


def register_swarm_events(sio, session_manager: SessionManager):

    def _fleet_snapshot_cb(drone_id: int):
        """Telemetry callback for a fleet drone — stores the snapshot in the
        global map for the batched emitters instead of emitting per drone."""
        def cb(snapshot_dict: dict):
            _fleet_state[drone_id] = snapshot_dict
        return cb

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
                # Only ship drones that are still attached to the shared fleet
                drones = {did: snap for did, snap in _fleet_state.items() if did in fleet}
                if not drones:
                    continue
                await sio.emit("fleet_telemetry", {"drones": drones}, to=session.socket_id)
        except asyncio.CancelledError:
            pass
        finally:
            _fleet_emitters.pop(session_id, None)

    @sio.on("scan_swarm_drones")
    async def on_scan_swarm_drones(sid, data):
        """
        Scan for PX4 SITL drones by attempting a real MAVSDK connection to each
        candidate port with a timeout. kill_stale is endpoint-scoped in
        TelemetryManager, so each connect/stop only touches the mavsdk_server
        bound to ITS OWN port — the primary drone and other fleet drones are
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
        logger.info(f"Scanning {len(ports)} ports for SITL drones: {ports[0]}–{ports[-1]}")

        # This session is now a fleet user. Mark it and start its emitter up
        # front — a second tab scanning an already-connected shared fleet may
        # attach no new managers below, but still needs telemetry.
        session_manager.mark_fleet_user(session.session_id)
        _ensure_fleet_emitter(session.session_id)

        from app.telemetry.manager import TelemetryManager

        sem = asyncio.Semaphore(_SCAN_CONCURRENCY)

        async def scan_port(port: int):
            drone_id = drone_for_port(port)
            name     = f"Drone {drone_id}"
            color    = color_for_drone(drone_id)
            entry    = {"port": port, "drone_id": drone_id, "name": name, "color": color}

            async with sem:
                existing = session_manager.get_fleet_drone(session.session_id, drone_id)
                if existing:
                    if await _server_alive_for_port(port):
                        # Healthy — re-announce so a freshly reloaded page sees it
                        await sio.emit("swarm_drone_status", {
                            "drone_id": drone_id, "connected": True, "name": name, "color": color,
                        }, to=sid)
                        logger.info(f"Fleet drone {drone_id} already attached and healthy")
                        return entry
                    # Attached but its mavsdk_server is dead — stop it fully BEFORE
                    # reconnecting (a fire-and-forget stop could kill the new server).
                    logger.warning(f"Fleet drone {drone_id} attached but server dead, reconnecting")
                    session_manager.pop_fleet_drone(drone_id)
                    _fleet_state.pop(drone_id, None)
                    try:
                        await existing.stop(kill_stale=True)
                    except Exception:
                        pass

                manager = TelemetryManager(
                    on_update=_fleet_snapshot_cb(drone_id),
                    fleet_mode=True,
                )
                address = f"udpin://0.0.0.0:{port}"

                try:
                    # kill_stale=True is safe here — it's scoped to this port only,
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
        Frontend toggled swarm mode. The fleet is a shared resource, so
        disabling only deregisters THIS session; the managers are torn down
        (with their mavsdk_servers) only when the last swarm session leaves,
        so a later re-enable starts from a clean slate without murdering a
        fleet another tab is still flying.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if bool(data.get("enabled", True)):
            return  # enable needs no backend prep — the scan does the work
        stopped = await session_manager.release_fleet_user(session.session_id)
        if stopped:
            _fleet_state.clear()
            logger.info(f"Swarm disabled — last session left, stopped {stopped} fleet drone(s)")
        else:
            logger.info("Swarm disabled for session — shared fleet kept for other sessions")

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
        address  = f"udpin://0.0.0.0:{port}"

        # Stop any previous manager for this id (kill is scoped to its own port)
        existing = session_manager.get_fleet_drone(session.session_id, drone_id)
        if existing:
            await existing.stop(kill_stale=True)

        from app.telemetry.manager import TelemetryManager

        manager = TelemetryManager(
            on_update=_fleet_snapshot_cb(drone_id),
            fleet_mode=True,
        )
        # kill_stale is scoped to this port — cannot affect the primary drone
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

        await sio.emit("swarm_drone_status", {
            "drone_id": drone_id, "connected": True, "name": name, "color": color,
        }, to=sid)
        logger.info(f"Fleet drone {drone_id} ({name}) connected — session {session.session_id[:8]}")

    @sio.on("disconnect_swarm_drone")
    async def on_disconnect_swarm_drone(sid, data):
        """Disconnect and remove a fleet drone. Payload: {drone_id}"""
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        drone_id = int(data.get("drone_id", 1))
        session_manager.detach_fleet_drone(session.session_id, drone_id)
        _fleet_state.pop(drone_id, None)
        await sio.emit("swarm_drone_status", {"drone_id": drone_id, "connected": False}, to=sid)
        logger.info(f"Fleet drone {drone_id} disconnected — session {session.session_id[:8]}")

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
                "msg": "Drone link lost — rescan the fleet",
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

        stagger_s > 0 delays drone k's action by k*stagger_s seconds — used
        for fleet mission starts so drones lift off one after another instead
        of climbing into each other's prop wash.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        ids     = sorted({int(i) for i in data.get("drone_ids", [])})
        action  = str(data.get("action", ""))
        stagger = float(data.get("altitude_stagger", 0) or 0)
        stagger_s = min(float(data.get("stagger_s", 0) or 0), 15.0)
        base_alt = data.get("altitude")

        async def run_one(idx: int, did: int) -> dict:
            tel = session_manager.get_fleet_drone(session.session_id, did)
            if not tel or not tel.is_connected:
                return {"drone_id": did, "ok": False, "msg": "Not connected"}
            payload = dict(data)
            if action == "takeoff" and base_alt is not None and stagger > 0:
                payload["altitude"] = float(base_alt) + idx * stagger
            if stagger_s > 0 and idx > 0:
                await asyncio.sleep(idx * stagger_s)
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

        # Same airspace rules as single-drone uploads: red blocks the upload,
        # orange is allowed with a warning (fleet drones have no ack dialog).
        from app.zones import engine as zone_engine
        path_check = zone_engine.check_path(
            [(float(w["lat"]), float(w["lng"])) for w in waypoints]
        )
        zone_warn = ""
        if path_check["zone_class"] == "red":
            names = ", ".join(z["name"] for z in path_check["zones"])
            await sio.emit("swarm_mission_upload_result", {
                "drone_id": drone_id, "ok": False,
                "msg": f"Blocked — crosses NO-FLY (red) zone: {names}",
            }, to=sid)
            logger.warning(f"Fleet mission blocked for drone {drone_id} (red zones: {names})")
            return
        if path_check["zone_class"] == "orange":
            names = ", ".join(z["name"] for z in path_check["zones"])
            zone_warn = f" — WARNING: passes orange zone: {names}"

        try:
            ok, err = await tel.upload_mission(waypoints, terrain_follow=terrain_follow)
        except Exception as e:
            logger.error(f"Swarm mission upload to drone {drone_id} failed: {e}")
            ok, err = False, "Drone link lost — rescan the fleet"
        await sio.emit("swarm_mission_upload_result", {
            "drone_id": drone_id, "ok": ok,
            "count": len(waypoints) if ok else 0,
            "msg": f"Uploaded {len(waypoints)} waypoints{zone_warn}" if ok
                   else f"Upload failed: {err}",
        }, to=sid)

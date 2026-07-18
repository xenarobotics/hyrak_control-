import asyncio
import logging
import math
import subprocess
import time

from app.sessions.manager import SessionManager
from app.events.telemetry_events import execute_drone_action
from app.flights import recorder
from app.registry import drones as drone_registry

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
_fleet_seen: dict[int, float] = {}                 # drone_id → last snapshot time
_fleet_emitters: dict[str, asyncio.Task] = {}      # session_id → emitter task

# Fleet drone DB identities. Fleet connections are always local SITL (udpin
# scan), and PX4 SITL instances share one firmware UID — so identity is the
# stable instance id, giving each simulated drone its own registry record and
# flight history. Real hardware connects through the primary (browser-radio)
# path, which reads the true hardware UID.
_fleet_db_ids: dict[int, str] = {}                 # drone_id → drones.id (uuid)

# ── Fleet supervisor ─────────────────────────────────────────────────────────
# One global 1 Hz watchdog over the shared fleet: low battery (warn, then
# auto-RTL), stale telemetry, live inter-drone separation, and fleet-mission
# completion. Alerts go to every fleet session as `fleet_alert` events —
# surfaced in the fleet panels, never as map popups.
_SUP_INTERVAL = 1.0
_BATT_WARN_PCT = 25.0
_BATT_RTL_PCT = 15.0
_LINK_STALE_S = 5.0
# 2.5 m keeps the 3 m SITL spawn grid quiet while catching true convergence
_SEP_HORIZ_M = 2.5
_SEP_VERT_M = 3.0
_sup_task: dict[str, asyncio.Task | None] = {"task": None}
_sup_drone: dict[int, dict] = {}                   # drone_id → watchdog state
_sup_pair_alert: dict[tuple, float] = {}           # (id,id) → last separation alert
_sup_complete = {"announced": False}


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def _register_fleet_drone(drone_id: int) -> None:
    """Give a fleet drone its persistent registry identity (idempotent)."""
    if drone_id in _fleet_db_ids:
        return
    rec = await drone_registry.upsert_seen(f"sitl-instance-{drone_id}", is_simulated=True)
    if rec:
        _fleet_db_ids[drone_id] = rec["id"]


def _end_fleet_flight(drone_id: int) -> None:
    """Finalise a fleet drone's open flight record, if any (fire-and-forget)."""
    try:
        asyncio.get_running_loop().create_task(recorder.end_flight(f"fleet-{drone_id}"))
    except RuntimeError:
        pass


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
        global map for the batched emitters instead of emitting per drone.
        Also feeds the flight recorder (armed→disarmed = one flight, same as
        primary drones) once the drone has a registry identity."""
        def cb(snapshot_dict: dict):
            _fleet_state[drone_id] = snapshot_dict
            _fleet_seen[drone_id] = time.time()
            db_id = _fleet_db_ids.get(drone_id)
            if db_id:
                try:
                    asyncio.get_running_loop().create_task(
                        recorder.on_snapshot(f"fleet-{drone_id}", db_id, snapshot_dict)
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
                fleet = session_manager.get_fleet("")
                if not fleet:
                    break

                socks = []
                for sid_ in session_manager.fleet_user_sessions():
                    s = session_manager.get(sid_)
                    if s and s.socket_id:
                        socks.append(s.socket_id)

                async def alert(did: int, kind: str, severity: str, msg: str):
                    logger.info(f"Fleet alert [{severity}] {kind}: {msg}")
                    for sk in socks:
                        await sio.emit("fleet_alert", {
                            "drone_id": did, "kind": kind,
                            "severity": severity, "msg": msg,
                            "at": time.time(),
                        }, to=sk)

                now = time.time()
                armed_air: list[tuple[int, float, float, float]] = []
                any_in_mission = False

                for did, mgr in list(fleet.items()):
                    snap = _fleet_state.get(did) or {}
                    st = _sup_drone.setdefault(did, {})
                    fm = snap.get("flight_mode", {})
                    armed = bool(fm.get("is_armed"))
                    pos = snap.get("position", {})
                    in_air = bool(fm.get("is_in_air")) or pos.get("relative_altitude_m", 0.0) > 1.0
                    batt = snap.get("battery", {}).get("remaining_percent")

                    # Link staleness — snapshots normally arrive every ~1 s
                    seen = _fleet_seen.get(did)
                    if seen and now - seen > _LINK_STALE_S:
                        if not st.get("link_lost"):
                            st["link_lost"] = True
                            await alert(did, "link_lost", "critical",
                                        f"Drone {did}: telemetry lost (stale >{_LINK_STALE_S:.0f}s)")
                        continue
                    if st.get("link_lost"):
                        st["link_lost"] = False
                        await alert(did, "link_restored", "info", f"Drone {did}: telemetry restored")

                    # Battery: warn at 25%, auto-RTL (PX4 RETURN — flies home
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
                                        f"Drone {did}: battery {batt:.0f}% — auto-RTL "
                                        f"{'engaged' if ok else 'FAILED — take manual control'}")
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
                            _sup_complete["announced"] = False
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

                # Live separation between airborne drones
                for i in range(len(armed_air)):
                    for j in range(i + 1, len(armed_air)):
                        d1, la1, lo1, al1 = armed_air[i]
                        d2, la2, lo2, al2 = armed_air[j]
                        if abs(al1 - al2) > _SEP_VERT_M:
                            continue
                        horiz = _haversine_m(la1, lo1, la2, lo2)
                        if horiz < _SEP_HORIZ_M:
                            key = (d1, d2)
                            if now - _sup_pair_alert.get(key, 0) > 10:
                                _sup_pair_alert[key] = now
                                await alert(d1, "separation", "critical",
                                            f"Drones {d1} & {d2} within {horiz:.1f} m "
                                            f"at similar altitude")

                dones = [d for d, s in _sup_drone.items() if s.get("mission_done")]
                if dones and not any_in_mission and not _sup_complete["announced"]:
                    _sup_complete["announced"] = True
                    for s in _sup_drone.values():
                        s["mission_done"] = False
                    await alert(0, "fleet_complete", "info",
                                f"Fleet mission complete — {len(dones)} drone(s) finished")
        except asyncio.CancelledError:
            pass
        finally:
            _sup_task["task"] = None

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
                        asyncio.create_task(_register_fleet_drone(drone_id))
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
                    _end_fleet_flight(drone_id)
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
                    _ensure_supervisor()
                    asyncio.create_task(_register_fleet_drone(drone_id))
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
            for did in list(_fleet_seen):
                _end_fleet_flight(did)
            _fleet_state.clear()
            _fleet_seen.clear()
            _sup_drone.clear()
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
        _ensure_supervisor()
        asyncio.create_task(_register_fleet_drone(drone_id))

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
        _fleet_seen.pop(drone_id, None)
        _sup_drone.pop(drone_id, None)
        _end_fleet_flight(drone_id)
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
            db_id = _fleet_db_ids.get(drone_id)
            if db_id:
                from app.permits import service as permit_service
                permit = await permit_service.find_approved(db_id, waypoints)
            if permit is None:
                await sio.emit("swarm_mission_upload_result", {
                    "drone_id": drone_id, "ok": False, "blocked": "red",
                    "can_request": bool(db_id), "zones": path_check["zones"],
                    "msg": f"Blocked — crosses NO-FLY (red) zone: {names} — permission required",
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
            zone_warn = f" — passes orange zone: {names}"

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

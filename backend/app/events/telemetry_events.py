import asyncio
import logging
from app.sessions import observer
from app.sessions.manager import SessionManager
from app.telemetry import serial_bridge
from app.telemetry.schemas import DroneCommand
from app.sessions.models import AnalysisMode

logger = logging.getLogger("verocore.events.telemetry")


def _pursuit_analyzers():
    """
    Every analyzer that can chase a subject, and therefore answers the shared
    follow controls — hold distance, fixed/auto altitude, altitude nudge.

    One list instead of the seven hand-copied import blocks and isinstance
    tuples this file used to carry. Those had already drifted: traffic
    management implements all three setters and was missing from every one of
    them, so its distance and altitude controls silently did nothing while the
    panel showed them as working. A single list is one place to update when a
    mode is added, rather than seven places to forget.

    Imported lazily inside the function because these modules pull in torch and
    ultralytics, which must not load at import time.
    """
    from app.vision.modules.crowd_manager import CrowdManager
    from app.vision.modules.human_tracker import HumanTracker
    from app.vision.modules.person_tracker import PersonTracker
    from app.vision.modules.plate_tracker import PlateTracker
    from app.vision.modules.traffic_manager import TrafficManager
    return (HumanTracker, PersonTracker, PlateTracker, CrowdManager, TrafficManager)


async def execute_drone_action(tel, action: str, data: dict) -> dict:
    """Execute a named action on a TelemetryManager. Returns the result dict."""
    if action == "arm":
        return {"action": action, "ok": await tel.arm()}
    if action == "disarm":
        return {"action": action, "ok": await tel.disarm()}
    if action == "emergency_stop":
        return {"action": action, "ok": await tel.emergency_stop()}
    if action == "reboot":
        return {"action": action, "ok": await tel.reboot()}
    if action == "set_mode":
        mode = data.get("mode", "HOLD")
        return {"action": action, "mode": mode, "ok": await tel.set_flight_mode(mode)}
    if action == "takeoff":
        alt = data.get("altitude")
        return {"action": action, "ok": await tel.takeoff(float(alt) if alt is not None else None)}
    if action == "land":
        return {"action": action, "ok": await tel.set_flight_mode("LAND")}
    if action == "hold":
        return {"action": action, "ok": await tel.set_flight_mode("HOLD")}
    if action == "return":
        return {"action": action, "ok": await tel.set_flight_mode("RETURN")}
    if action == "start_mission":
        return {"action": action, "ok": await tel.start_mission()}
    if action == "arm_and_start_mission":
        ok, msg = await tel.arm_and_start_mission()
        return {"action": action, "ok": ok, "msg": msg}
    if action == "restart_mission":
        return {"action": action, "ok": await tel.restart_mission()}
    if action == "arm_and_restart_mission":
        ok, msg = await tel.arm_and_restart_mission()
        return {"action": action, "ok": ok, "msg": msg}
    if action == "pause_mission":
        return {"action": action, "ok": await tel.pause_mission()}
    if action == "set_altitude":
        alt = float(data.get("altitude", 10.0))
        return {"action": action, "ok": await tel.goto_altitude(alt)}
    if action == "rtl_home":
        # Per-drone RTL: each vehicle flies to ITS OWN home. Safe as a group
        # action, unlike goto_custom_rtl which broadcasts one shared point.
        alt = data.get("altitude")
        return {"action": action,
                "ok": await tel.goto_home(float(alt) if alt is not None else None)}
    if action == "goto_custom_rtl":
        ok = await tel.goto_custom_rtl(
            float(data.get("lat", 0.0)),
            float(data.get("lng", 0.0)),
            float(data.get("altitude", 10.0)),
        )
        return {"action": action, "ok": ok}
    logger.warning(f"Unknown action: {action}")
    return {"action": action, "ok": False, "msg": "Unknown action"}


def register_telemetry_events(sio, session_manager: SessionManager, vision_pool=None):
    """
    Registers all Socket.IO events for telemetry, drone commands, and mode switching.
    vision_pool is passed in so set_analysis_mode can re-register sessions.
    """

    @sio.on("connect_telemetry")
    async def on_connect_telemetry(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit("error", {"msg": "No session found"}, to=sid)
            return

        address = data.get("address", "udp://:14540")
        logger.info(f"Session {session.session_id[:8]} connecting telemetry → {address}")

        # Switching from a browser radio to another source? Drop the old bridge.
        own_bridge = serial_bridge.get_bridge(session.session_id)
        if own_bridge and own_bridge.address != address:
            serial_bridge.close_bridge(session.session_id)

        # Only one mavsdk_server can hold the drone link at a time. Hand off
        # gracefully instead of letting the new connect's stale-process kill
        # blow away another session's still-active telemetry out from under it
        # (that previously surfaced as random "Socket closed" gRPC errors).
        other = session_manager.find_other_telemetry_session(session.session_id, address)
        if other:
            other_session_id, other_tel = other
            other_session = session_manager.get(other_session_id)
            logger.info(f"Session {session.session_id[:8]}: taking over telemetry from {other_session_id[:8]}")
            await other_tel.stop()
            session_manager.detach_telemetry(other_session_id)
            serial_bridge.close_bridge(other_session_id)
            from app.flights import recorder
            await recorder.end_flight(other_session_id)
            if other_session:
                other_session.hardware_uid = None
                other_session.drone = None
                await sio.emit(
                    "telemetry_status",
                    {"status": "disconnected", "message": "Disconnected — another client connected to this drone"},
                    to=other_session.socket_id,
                )

        from app.telemetry.manager import TelemetryManager

        def on_telemetry_update(snapshot_dict: dict):
            try:
                asyncio.create_task(
                    sio.emit("telemetry_update", snapshot_dict, to=sid)
                )
                # Flight recorder — no-op unless armed and identified
                from app.flights import recorder
                asyncio.create_task(
                    recorder.on_snapshot(
                        session.session_id,
                        session.drone["id"] if session.drone else None,
                        snapshot_dict,
                    )
                )
                # Zone enforcement monitor
                from app.zones import monitor as zone_monitor
                asyncio.create_task(
                    zone_monitor.on_snapshot(
                        sio, session_manager, session, manager, snapshot_dict
                    )
                )
                # Mirror to any /admin observers watching this session
                if observer.has_watchers(session.session_id):
                    asyncio.create_task(
                        sio.emit(
                            "admin_telemetry",
                            {"session_id": session.session_id, "data": snapshot_dict},
                            room=observer.watch_room(session.session_id),
                        )
                    )
            except RuntimeError:
                pass

        manager = TelemetryManager(on_update=on_telemetry_update)
        connected = await manager.connect(address)

        if not connected:
            await sio.emit(
                "telemetry_status",
                {"status": "error", "message": f"Could not connect to {address}"},
                to=sid,
            )
            return

        await manager.start()
        session_manager.attach_telemetry(session.session_id, manager)
        session.drone_address = address

        await sio.emit(
            "telemetry_status",
            {"status": "connected", "address": address},
            to=sid,
        )
        logger.info(f"✅ Telemetry live for session {session.session_id[:8]}")

        async def _resolve_identity():
            """Read the FC's hardware UID and map it to a persistent drone
            record, in the background so connect isn't delayed. A browser
            radio arrives over a loopback-UDP bridge, so 'udp address' alone
            doesn't mean simulated — the presence of a serial bridge does."""
            from app.registry import drones as drone_registry

            uid = await manager.get_hardware_uid()
            session.hardware_uid = uid
            if uid:
                is_sim = (
                    address.startswith("udp")
                    and serial_bridge.get_bridge(session.session_id) is None
                )
                session.drone = await drone_registry.upsert_seen(uid, is_simulated=is_sim)
            await sio.emit(
                "drone_identity",
                {"hardware_uid": uid, "drone": session.drone},
                to=sid,
            )
            # FC-level backstop: push red zones to PX4 as exclusion fences
            from app.zones import fence
            asyncio.create_task(fence.upload_red_fence(manager))

        asyncio.create_task(_resolve_identity())

        # Download existing mission from drone and send to frontend
        existing = await manager.download_mission()
        if existing:
            await sio.emit("drone_mission_loaded", {"waypoints": existing}, to=sid)
            logger.info(f"Sent {len(existing)} existing mission waypoints to {sid[:8]}")

    @sio.on("connect_rf_bridge")
    async def on_connect_rf_bridge(sid, data=None):
        """RF link where telemetry already arrives over UDP (e.g. wfb-ng)
        but on fixed split ports the normal udpin:// 'reply to sender'
        trick can't reach — see app/telemetry/rf_bridge.py for why."""
        from app.telemetry import rf_bridge
        data = data or {}
        bridge = await rf_bridge.ensure_started(
            downlink_port=int(data.get("downlinkPort") or 14550),
            uplink_port=int(data.get("uplinkPort") or 14551),
        )
        await on_connect_telemetry(sid, {"address": bridge.address})

    @sio.on("connect_browser_serial")
    async def on_connect_browser_serial(sid, data=None):
        """Cloud flow: the user's telemetry radio is plugged into THEIR device.
        The browser reads it via the Web Serial API and relays raw MAVLink
        bytes here; a loopback SerialBridge feeds them to this session's
        mavsdk_server exactly as if the radio were local."""
        # The client sets its UI to "connecting" the moment it asks, and ONLY a
        # telemetry_status event can move it off that. Any path out of here
        # that doesn't emit one leaves the operator staring at "connecting"
        # forever — so every failure below reports as telemetry_status,
        # including an unexpected exception (which socket.io would otherwise
        # swallow silently).
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit(
                "telemetry_status",
                {"status": "error", "message": "No session found — reload the page and try again"},
                to=sid,
            )
            return

        try:
            bridge = await serial_bridge.SerialBridge.create(sio, sid)
        except Exception as e:
            logger.error(f"Session {session.session_id[:8]} serial bridge setup failed: {e}")
            await sio.emit(
                "telemetry_status",
                {"status": "error", "message": f"Could not set up the telemetry bridge: {e}"},
                to=sid,
            )
            return

        serial_bridge.register_bridge(session.session_id, bridge)
        logger.info(f"Session {session.session_id[:8]} browser radio → {bridge.address}")

        # Reuse the normal connect flow; the heartbeat mavsdk waits for arrives
        # through serial_uplink events the browser is already pumping.
        try:
            await on_connect_telemetry(sid, {"address": bridge.address})
        except Exception as e:
            logger.error(f"Session {session.session_id[:8]} telemetry connect raised: {e}")
            serial_bridge.close_bridge(session.session_id)
            await sio.emit(
                "telemetry_status",
                {"status": "error", "message": f"Telemetry connect failed: {e}"},
                to=sid,
            )
            return
        if getattr(session, "drone_address", None) != bridge.address:
            serial_bridge.close_bridge(session.session_id)  # connect failed

    @sio.on("serial_uplink")
    async def on_serial_uplink(sid, data):
        """Raw MAVLink bytes read from the user's radio in the browser."""
        if not isinstance(data, (bytes, bytearray)):
            return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        bridge = serial_bridge.get_bridge(session.session_id)
        if bridge:
            bridge.uplink(bytes(data))

    @sio.on("disconnect_telemetry")
    async def on_disconnect_telemetry(sid):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if tel:
            await tel.stop()
        serial_bridge.close_bridge(session.session_id)
        from app.flights import recorder
        await recorder.end_flight(session.session_id)
        from app.zones import monitor as zone_monitor
        zone_monitor.drop(session.session_id)
        session.zone_lock = False
        session.telemetry_connected = False
        session.hardware_uid = None
        session.drone = None
        await sio.emit("telemetry_status", {"status": "disconnected"}, to=sid)

    @sio.on("drone_command")
    async def on_drone_command(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if session.mode != AnalysisMode.MANUAL_CONTROL:
            return
        # Red-zone pushback owns the drone — pilot input is dropped until
        # the monitor releases the lock.
        if getattr(session, "zone_lock", False):
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel:
            return
        cmd = DroneCommand(
            roll=float(data.get("roll", 0.0)),
            pitch=float(data.get("pitch", 0.0)),
            yaw=float(data.get("yaw", 0.0)),
            throttle=float(data.get("throttle", 0.5)),
        )
        await tel.send_command(cmd)

    @sio.on("drone_action")
    async def on_drone_action(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel:
            await sio.emit("error", {"msg": "No telemetry connected"}, to=sid)
            return
        action = data.get("action", "")

        # No arming/takeoff inside a red zone (without a permit — future phase)
        if action in ("arm", "takeoff"):
            from app.zones import engine as zone_engine
            snap = tel.snapshot
            check = zone_engine.check_point(
                snap.position.latitude_deg, snap.position.longitude_deg
            )
            if check["zone_class"] == "red":
                names = ", ".join(z["name"] for z in check["zones"])
                await sio.emit("action_result", {
                    "action": action, "ok": False,
                    "error": f"Blocked — inside NO-FLY (red) zone: {names}",
                }, to=sid)
                logger.warning(f"{action} blocked in red zone for {session.session_id[:8]}")
                return

        logger.info(f"Action: {action} | session {session.session_id[:8]}")
        result = await execute_drone_action(tel, action, data)
        await sio.emit("action_result", result, to=sid)

    @sio.on("set_analysis_mode")
    async def on_set_analysis_mode(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return

        try:
            mode = AnalysisMode(data.get("mode", "manual-control"))
        except ValueError:
            await sio.emit("error", {"msg": f"Invalid mode: {data.get('mode')}"}, to=sid)
            return

        old_mode = session.mode
        session_manager.set_mode(session.session_id, mode)

        # Re-register with vision pool so new analyzer gets frames
        if vision_pool and old_mode != mode:
            await sio.emit("model_status", {"status": "loading", "mode": mode.value}, to=sid)

            async def _do_switch():
                # If we're leaving human-tracking, stop offboard cleanly BEFORE
                # the analyzer is swapped — this gives the drone a proper HOLD
                # command instead of letting PX4 hit its setpoint-loss failsafe.
                if old_mode == AnalysisMode.HUMAN_TRACKING:
                    tel = session_manager.get_telemetry(session.session_id)
                    if tel and tel.is_connected and tel._offboard_active:
                        # Freeze the tracker so no new velocity commands are queued
                        analyzer = vision_pool.get_for_session(session.session_id)
                        from app.vision.modules.human_tracker import HumanTracker
                        if isinstance(analyzer, HumanTracker):
                            analyzer.set_tracking(session.session_id, False)
                        await tel.stop_offboard()
                        logger.info(
                            f"Session {session.session_id[:8]}: offboard stopped "
                            f"on mode switch → {mode.value}"
                        )

                await vision_pool.switch_mode(session.session_id, old_mode, mode)
                await sio.emit("model_status", {"status": "ready", "mode": mode.value}, to=sid)

            asyncio.create_task(_do_switch())
            logger.info(f"Session {session.session_id[:8]}: switching {old_mode.value} → {mode.value}")

        await sio.emit("mode_changed", {"mode": mode.value}, to=sid)

    @sio.on("select_person")
    async def on_select_person(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        # None is NOT "ignore" — it is Release, which is how every panel
        # clears a selection. Returning early here meant Release silently did
        # nothing, and the target stayed locked with no way to let it go.
        person_id = data.get("person_id")
        if vision_pool:
            analyzer = vision_pool.get_for_session(session.session_id)
            logger.info(
                f"select_person: session={session.session_id[:8]} "
                f"person_id={person_id} analyzer={type(analyzer).__name__}"
            )
            from app.vision.modules.crowd_manager import CrowdManager
            from app.vision.modules.human_tracker import HumanTracker
            from app.vision.modules.person_tracker import PersonTracker
            # Crowd management follows one person out of the crowd using the
            # same tracker ids it already counts with, so it takes the same
            # selection event rather than needing a parallel one.
            if isinstance(analyzer, (HumanTracker, CrowdManager)):
                analyzer.set_selected_person(session.session_id, person_id)
            # person-tracking normally locks an ENROLLED identity, but an
            # operator pointing at somebody who is not in the database still
            # means "follow that person". Falling back to the track keeps the
            # gesture consistent across every mode instead of silently doing
            # nothing, which is how it behaved before.
            elif isinstance(analyzer, PersonTracker):
                analyzer.follow_track(session.session_id, person_id)
            else:
                logger.warning(
                    f"select_person ignored — {type(analyzer).__name__} does "
                    f"not support person selection"
                )
                return
        await sio.emit("person_selected", {"person_id": person_id}, to=sid)
        await sio.emit("person_selected", {"person_id": person_id}, to=sid)

    @sio.on("set_pd_params")
    async def on_set_pd_params(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.human_tracker import HumanTracker
        from app.vision.modules.person_tracker import PersonTracker
        if isinstance(analyzer, (HumanTracker, PersonTracker)):
            analyzer.set_pd_params(
                session.session_id,
                kp=float(data.get("kp", 0.8)),
                kd=float(data.get("kd", 0.4)),
                max_output=float(data.get("max_output", 300)),
                deadband=float(data.get("deadband", 0.05)),
            )

    @sio.on("set_altitude_mode")
    async def on_set_altitude_mode(sid, data):
        """Payload: { mode: 'fixed' | 'auto' }
        fixed = hold current altitude; auto = altitude PD follows person vertically."""
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        if isinstance(analyzer, _pursuit_analyzers()):
            analyzer.set_altitude_mode(
                session.session_id,
                mode=str(data.get("mode", "fixed")),
            )

    @sio.on("set_altitude_nudge")
    async def on_set_altitude_nudge(sid, data):
        """Payload: { velocity: float }  (−=ascend, +=descend, 0=stop).
        Active only in Fixed altitude mode while tracking. Hold button → send velocity; release → send 0."""
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        if isinstance(analyzer, _pursuit_analyzers()):
            analyzer.set_altitude_nudge(
                session.session_id,
                velocity=float(data.get("velocity", 0.0)),
            )

    @sio.on("set_tracking_params")
    async def on_set_tracking_params(sid, data):
        """Set distance hold target. Payload: { target_distance_ratio: float }

        For human/person tracking, 0.15 -> far (~10m), 0.30 -> default (~5m),
        0.50 -> close (~2m), against a subject whose real height is a stable
        ~1.7m regardless of heading.

        vehicle-plate-tracking shares the same event and payload shape, but
        there is no fixed "this ratio means this many metres" table for a
        vehicle: its apparent height depends on its heading as much as its
        range, so the right target is something an operator finds by
        watching vehicle_fill_pct in the panel and nudging this, not a
        number this handler can assume.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        if isinstance(analyzer, _pursuit_analyzers()):
            analyzer.set_tracking_params(
                session.session_id,
                target_distance_ratio=float(data.get("target_distance_ratio", 0.30)),
            )

    @sio.on("set_profile_override")
    async def on_set_profile_override(sid, data):
        """Force a traffic-management analytic on/off. Payload:
        { subject: "plate" | "face", mode: "auto" | "on" | "off" }

        An override rather than a mode switch, so the automatic decision stays
        visible beside it: an operator forcing plate OCR on at 40m should still
        be able to read that the plate is 34px short of readable. The analyzer
        validates subject and mode — this handler deliberately does not
        second-guess it, so there is one place the rules live.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.traffic_manager import TrafficManager
        if isinstance(analyzer, TrafficManager):
            analyzer.set_profile_override(
                session.session_id,
                str(data.get("subject", "")),
                str(data.get("mode", "auto")),
            )

    @sio.on("set_zone_names")
    async def on_set_zone_names(sid, data):
        """Payload: { names: { "0": "North Gate", ... } } keyed by cell index.

        Names, not coordinates: the grid is fixed at 3x3 in frame, so a label
        is only meaningful while the drone holds a position. That is exactly
        how this gets used — park over a venue, name the cells once, and every
        alert afterwards says "North Gate" instead of "cell 1".
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.crowd_manager import CrowdManager
        if isinstance(analyzer, CrowdManager):
            analyzer.set_zone_names(session.session_id, data.get("names") or {})

    @sio.on("set_crowd_thresholds")
    async def on_set_crowd_thresholds(sid, data):
        """Payload: { light_max: int, moderate_max: int }. Whole-frame
        density is FOV-dependent — operator-calibrated from the Settings
        page, no universal default is correct."""
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.crowd_manager import CrowdManager
        if isinstance(analyzer, CrowdManager):
            analyzer.set_thresholds(
                session.session_id,
                light_max=int(data.get("light_max", 8)),
                moderate_max=int(data.get("moderate_max", 20)),
            )

    @sio.on("set_enhance_params")
    async def on_set_enhance_params(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.enhancer import Enhancer
        if isinstance(analyzer, Enhancer):
            analyzer.set_params(session.session_id, **data)

    @sio.on("upload_mission")
    async def on_upload_mission(sid, data):
        """
        Upload a mission plan to the connected drone.

        Expected payload:
          {
            "terrain_follow": bool,
            "waypoints": [
              { "lat": float, "lng": float, "altitude": float,
                "speed": float, "hold_time": float, "type": str, "yaw": float|null }
            ]
          }

        Terrain following:
        - terrain_follow=False → mission.MissionItem with frame=3 (relative to home)
        - terrain_follow=True  → mission_raw.MissionItem with frame=10
          (MAV_FRAME_GLOBAL_TERRAIN_ALT) — requires TERRAIN_ENABLE=1 on the drone.
        """
        try:
            session = session_manager.get_by_socket(sid)
            if not session:
                await sio.emit("mission_upload_result", {
                    "ok": False, "msg": "No active session — reconnect to the backend"
                }, to=sid)
                return

            tel = session_manager.get_telemetry(session.session_id)
            if not tel or not tel.is_connected:
                await sio.emit("mission_upload_result", {
                    "ok": False, "msg": "Drone not connected — connect via Telemetry tab first"
                }, to=sid)
                return

            waypoints = data.get("waypoints", [])
            terrain_follow = bool(data.get("terrain_follow", False))

            if not waypoints:
                await sio.emit("mission_upload_result", {
                    "ok": False, "msg": "No waypoints provided"
                }, to=sid)
                return

            # ── Zone validation before anything reaches the drone ────────
            from app.zones import engine as zone_engine
            path_check = zone_engine.check_path(
                [(float(w["lat"]), float(w["lng"])) for w in waypoints]
            )
            permit = None
            if path_check["zone_class"] == "red":
                names = ", ".join(z["name"] for z in path_check["zones"])
                if session.drone:
                    from app.permits import service as permit_service
                    permit = await permit_service.find_approved(
                        session.drone["id"], waypoints
                    )
                if permit is None:
                    await sio.emit("mission_upload_result", {
                        "ok": False, "blocked": "red", "zones": path_check["zones"],
                        "can_request": bool(session.drone),
                        "msg": f"Mission crosses NO-FLY (red) zone: {names} — permission required",
                    }, to=sid)
                    logger.warning(
                        f"Mission blocked (red zones: {names}) for {session.session_id[:8]}"
                    )
                    return
                logger.info(
                    f"Red-zone mission allowed under permit {permit['id'][:8]} "
                    f"for {session.session_id[:8]}"
                )
            # An approved permit covers the whole profile — no extra orange ack
            if (path_check["zone_class"] == "orange"
                    and not data.get("ack_orange") and permit is None):
                names = ", ".join(z["name"] for z in path_check["zones"])
                await sio.emit("mission_upload_result", {
                    "ok": False, "needs_ack": True, "zones": path_check["zones"],
                    "msg": f"Mission passes through restricted (orange) zone: {names}",
                }, to=sid)
                return

            logger.info(
                f"Uploading {len(waypoints)} waypoints "
                f"(terrain_follow={terrain_follow}) for session {session.session_id[:8]}"
            )

            ok, err_msg = await tel.upload_mission(waypoints, terrain_follow=terrain_follow)
            await sio.emit("mission_upload_result", {
                "ok": ok,
                "count": len(waypoints) if ok else 0,
                "terrain_follow": terrain_follow,
                "msg": f"Mission uploaded: {len(waypoints)} waypoints" if ok
                       else f"Upload failed: {err_msg}",
            }, to=sid)

        except Exception as e:
            logger.error(f"on_upload_mission unhandled error: {e}", exc_info=True)
            try:
                await sio.emit("mission_upload_result", {
                    "ok": False, "msg": f"Server error: {e}"
                }, to=sid)
            except Exception:
                pass

    @sio.on("set_gallery_mode")
    async def on_set_gallery_mode(sid, data):
        """Payload: { enabled: bool }

        Turns database face matching on for this session, so the tracker can
        name and lock onto anyone enrolled without a target being selected
        first. An uploaded reference photo still takes precedence, so this
        cannot disturb a target the operator chose deliberately.

        Reloads the gallery on enable rather than reusing the snapshot taken
        at session start — otherwise someone enrolled mid-session would be
        invisible until the mode was switched away and back.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.person_tracker import PersonTracker
        if not isinstance(analyzer, PersonTracker):
            return

        enabled = bool(data.get("enabled", False))
        if enabled:
            try:
                from app.vision.persistence import load_face_gallery
                analyzer.set_gallery(await load_face_gallery())
            except Exception as e:
                logger.warning(f"Gallery reload failed: {e}")
        analyzer.set_gallery_mode(session.session_id, enabled)
        gallery = getattr(analyzer, "_gallery", None)
        await sio.emit("gallery_mode_set", {
            "enabled": enabled,
            "enrolled": gallery.person_count if gallery else 0,
            "faces": gallery.size if gallery else 0,
        }, to=sid)

    @sio.on("set_follow_vehicle")
    async def on_set_follow_vehicle(sid, data):
        """Payload: { track_id: int | null }

        Lock onto a vehicle in traffic-management OR vehicle-plate-tracking
        mode, or null to release. Both modules expose the same
        request_follow(client_id, track_id) shape, so one handler routes to
        whichever is actually running this session. Takes effect as soon as
        that vehicle is in frame — locking a track that is not visible would
        commit the aircraft to nothing.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.plate_tracker import PlateTracker
        from app.vision.modules.traffic_manager import TrafficManager
        if not isinstance(analyzer, (TrafficManager, PlateTracker)):
            logger.warning(
                f"set_follow_vehicle ignored — analyzer is "
                f"{type(analyzer).__name__}, not a vehicle module"
            )
            return
        tid = data.get("track_id")
        logger.info(
            f"set_follow_vehicle: session={session.session_id[:8]} track_id={tid} "
            f"analyzer={type(analyzer).__name__}"
        )
        analyzer.request_follow(session.session_id, None if tid is None else int(tid))
        await sio.emit("follow_vehicle_set", {"track_id": tid}, to=sid)

    @sio.on("set_vehicle_tracking")
    async def on_set_vehicle_tracking(sid, data):
        """Payload: { active: bool } — start/stop flying after the locked
        vehicle, in either traffic-management or vehicle-plate-tracking.

        ARMING OFFBOARD IS HALF THE JOB, AND IT WAS MISSING.
        Setting the analyzer's flag only makes it COMPUTE velocity setpoints.
        PX4 discards every one of them unless Offboard mode is running, so the
        drone sat still while the module happily produced commands — no error
        anywhere, because nothing had failed. `set_tracking` (human/person
        tracking) has always done both halves; this handler did only the first,
        which is why vehicle follow looked implemented and did nothing.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.plate_tracker import PlateTracker
        from app.vision.modules.traffic_manager import TrafficManager
        if not isinstance(analyzer, (TrafficManager, PlateTracker)):
            return

        active = bool(data.get("active"))
        tel = session_manager.get_telemetry(session.session_id)
        if tel and tel.is_connected:
            if active:
                if not await tel.start_offboard():
                    # Do NOT arm the analyzer: it would report "following"
                    # while the aircraft ignores every setpoint.
                    await sio.emit("error", {
                        "msg": "Failed to start Offboard mode — is the drone "
                               "armed and airborne?",
                    }, to=sid)
                    await sio.emit("vehicle_tracking_status",
                                   {"active": False}, to=sid)
                    return
            else:
                await tel.stop_offboard()

        analyzer.set_tracking(session.session_id, active)
        await sio.emit("vehicle_tracking_status", {"active": active}, to=sid)

    @sio.on("enrol_person_live")
    async def on_enrol_person_live(sid, data):
        """Payload: { track_id: int, name: str } — or { cancel: true }.

        Enrols somebody the drone is looking at RIGHT NOW. The gallery then
        holds this camera, this lens, this angle and this lighting, which is
        what the recogniser is actually asked to match later — an uploaded
        photo is a different imaging problem and matches less well.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.person_tracker import PersonTracker
        if not isinstance(analyzer, PersonTracker):
            await sio.emit("enrolment_started", {
                "ok": False,
                "msg": "Live enrolment only runs in person-tracking mode",
            }, to=sid)
            return
        if data.get("cancel"):
            analyzer.cancel_capture(session.session_id)
            await sio.emit("enrolment_started", {"ok": False, "msg": "cancelled"}, to=sid)
            return
        name = str(data.get("name") or "").strip()
        tid = data.get("track_id")
        if not name or tid is None:
            await sio.emit("enrolment_started", {
                "ok": False, "msg": "A name and a selected person are both required",
            }, to=sid)
            return
        started = analyzer.begin_capture(session.session_id, int(tid), name)
        await sio.emit("enrolment_started", {
            "ok": started, "name": name, "track_id": int(tid),
            "msg": (f"Capturing shots of {name} — keep them in frame"
                    if started else "Could not start capture"),
        }, to=sid)

    @sio.on("set_follow_person")
    async def on_set_follow_person(sid, data):
        """Payload: { person_id: str | null }

        Follow a specific enrolled person, or null to release and let the
        tracker choose automatically again.

        Applied on the next face check, not immediately: the person has to be
        identified in frame before there is a body track to follow.
        """
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.person_tracker import PersonTracker
        if not isinstance(analyzer, PersonTracker):
            return
        person_id = data.get("person_id") or None
        analyzer.request_follow(session.session_id, person_id)
        await sio.emit("follow_person_set", {"person_id": person_id}, to=sid)

    @sio.on("clear_reference")
    async def on_clear_reference(sid):
        """Clear the stored face embedding and reset tracking for person-tracking mode."""
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.person_tracker import PersonTracker
        if isinstance(analyzer, PersonTracker):
            analyzer.clear_reference(session.session_id)
        await sio.emit("reference_cleared", {}, to=sid)

    @sio.on("fetch_params")
    async def on_fetch_params(sid):
        """Download all parameters from the connected flight controller.
        Emits params_result with {ok: None, loading: True} immediately,
        then {ok: True, params: {...}, count: N} when done,
        or {ok: False, error: str} on failure.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected:
            await sio.emit(
                "params_result",
                {"ok": False, "error": "Drone not connected — connect via the Connection section first"},
                to=sid,
            )
            return

        logger.info(f"Session {session.session_id[:8]}: downloading all parameters…")
        await sio.emit("params_result", {"ok": None, "loading": True}, to=sid)

        params = await tel.get_all_params()
        if params:
            await sio.emit(
                "params_result",
                {"ok": True, "params": params, "count": len(params)},
                to=sid,
            )
            logger.info(f"Session {session.session_id[:8]}: sent {len(params)} parameters")
        else:
            await sio.emit(
                "params_result",
                {"ok": False, "error": "Parameter download failed — check drone connection and try again"},
                to=sid,
            )

    @sio.on("set_param")
    async def on_set_param(sid, data):
        """Write a single parameter to the flight controller.
        Payload: {key: str, value: number, param_type: 'int'|'float'}
        Emits param_set_ack: {key, ok, value, error?}
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        key = data.get("key", "")
        value = data.get("value", 0)
        param_type = data.get("param_type", "float")

        if not tel or not tel.is_connected:
            await sio.emit(
                "param_set_ack",
                {"key": key, "ok": False, "error": "Drone not connected"},
                to=sid,
            )
            return

        ok = await tel.set_param(key, float(value), param_type)
        await sio.emit(
            "param_set_ack",
            {
                "key": key,
                "ok": ok,
                "value": value,
                "error": None if ok else f"Failed to set {key} — check connection and try again",
            },
            to=sid,
        )

    @sio.on("set_tracking")
    async def on_set_tracking(sid, data):
        logger.info(f"🎯 SET_TRACKING received: active={data.get('active')} sid={sid[:8]}")
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        active = data.get("active", False)

        tel = session_manager.get_telemetry(session.session_id)

        if vision_pool:
            analyzer = vision_pool.get_for_session(session.session_id)
            from app.vision.modules.crowd_manager import CrowdManager
            from app.vision.modules.human_tracker import HumanTracker
            from app.vision.modules.person_tracker import PersonTracker
            if isinstance(analyzer, (HumanTracker, PersonTracker, CrowdManager)):
                analyzer.set_tracking(session.session_id, active)

        # Start/stop Offboard mode on the drone
        if tel and tel.is_connected:
            if active:
                ok = await tel.start_offboard()
                if not ok:
                    await sio.emit(
                        "error",
                        {"msg": "Failed to start Offboard mode — is drone armed and airborne?"},
                        to=sid
                    )
                    return
            else:
                await tel.stop_offboard()

        await sio.emit("tracking_status", {"active": active}, to=sid)
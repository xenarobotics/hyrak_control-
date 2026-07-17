import asyncio
import logging
from app.sessions import observer
from app.sessions.manager import SessionManager
from app.telemetry import serial_bridge
from app.telemetry.schemas import DroneCommand
from app.sessions.models import AnalysisMode

logger = logging.getLogger("verocore.events.telemetry")


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
        other = session_manager.find_other_telemetry_session(session.session_id)
        if other:
            other_session_id, other_tel = other
            other_session = session_manager.get(other_session_id)
            logger.info(f"Session {session.session_id[:8]}: taking over telemetry from {other_session_id[:8]}")
            await other_tel.stop()
            session_manager.detach_telemetry(other_session_id)
            serial_bridge.close_bridge(other_session_id)
            if other_session:
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

        # Download existing mission from drone and send to frontend
        existing = await manager.download_mission()
        if existing:
            await sio.emit("drone_mission_loaded", {"waypoints": existing}, to=sid)
            logger.info(f"Sent {len(existing)} existing mission waypoints to {sid[:8]}")

    @sio.on("connect_browser_serial")
    async def on_connect_browser_serial(sid, data=None):
        """Cloud flow: the user's telemetry radio is plugged into THEIR device.
        The browser reads it via the Web Serial API and relays raw MAVLink
        bytes here; a loopback SerialBridge feeds them to this session's
        mavsdk_server exactly as if the radio were local."""
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit("error", {"msg": "No session found"}, to=sid)
            return

        bridge = await serial_bridge.SerialBridge.create(sio, sid)
        serial_bridge.register_bridge(session.session_id, bridge)
        logger.info(f"Session {session.session_id[:8]} browser radio → {bridge.address}")

        # Reuse the normal connect flow; the heartbeat mavsdk waits for arrives
        # through serial_uplink events the browser is already pumping.
        await on_connect_telemetry(sid, {"address": bridge.address})
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
        session.telemetry_connected = False
        await sio.emit("telemetry_status", {"status": "disconnected"}, to=sid)

    @sio.on("drone_command")
    async def on_drone_command(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if session.mode != AnalysisMode.MANUAL_CONTROL:
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
        person_id = data.get("person_id")
        if person_id is None:
            return
        if vision_pool:
            from app.sessions.models import AnalysisMode
            analyzer = vision_pool.get_for_session(session.session_id)
            from app.vision.modules.human_tracker import HumanTracker
            if isinstance(analyzer, HumanTracker):
                analyzer.set_selected_person(session.session_id, person_id)
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
        from app.vision.modules.human_tracker import HumanTracker
        from app.vision.modules.person_tracker import PersonTracker
        if isinstance(analyzer, (HumanTracker, PersonTracker)):
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
        from app.vision.modules.human_tracker import HumanTracker
        from app.vision.modules.person_tracker import PersonTracker
        if isinstance(analyzer, (HumanTracker, PersonTracker)):
            analyzer.set_altitude_nudge(
                session.session_id,
                velocity=float(data.get("velocity", 0.0)),
            )

    @sio.on("set_tracking_params")
    async def on_set_tracking_params(sid, data):
        """Set distance hold target. Payload: { target_distance_ratio: float }
        0.15 → far (~10 m), 0.30 → default (~5 m), 0.50 → close (~2 m)."""
        session = session_manager.get_by_socket(sid)
        if not session or not vision_pool:
            return
        analyzer = vision_pool.get_for_session(session.session_id)
        from app.vision.modules.human_tracker import HumanTracker
        from app.vision.modules.person_tracker import PersonTracker
        if isinstance(analyzer, (HumanTracker, PersonTracker)):
            analyzer.set_tracking_params(
                session.session_id,
                target_distance_ratio=float(data.get("target_distance_ratio", 0.30)),
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
            from app.vision.modules.human_tracker import HumanTracker
            from app.vision.modules.person_tracker import PersonTracker
            if isinstance(analyzer, (HumanTracker, PersonTracker)):
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
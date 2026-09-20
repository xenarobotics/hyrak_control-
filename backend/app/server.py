import asyncio
import logging
import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.releases import register_releases_routes
from app.config import get_settings
from app.utils.logging import setup_logging  # must run before any verocore logger is used
setup_logging()

from app.sessions.manager import SessionManager
from app.webrtc.peer_registry import PeerRegistry
from app.vision.worker_pool import VisionWorkerPool
from app.events.telemetry_events import register_telemetry_events
from app.events.swarm_events import register_swarm_events, cleanup_session_fleet_state
from app.telemetry.swarm_relay_bridge import close_bridge as close_swarm_relay_bridge
from app.events.admin_events import register_admin_events, set_sio
from app.events.permit_events import register_permit_events
from app.webrtc.signaling import register_webrtc_events
from app.events.gs_relay_events import register_gs_relay_events
from app.api.routes import router

logger = logging.getLogger("verocore.server")


def create_app() -> socketio.ASGIApp:
    settings = get_settings()
    cors_origins = settings.allowed_origins + settings.lan_origins

    # ------------------------------------------------------------------ #
    # FastAPI                                                              #
    # ------------------------------------------------------------------ #
    fastapi_app = FastAPI(title="Verocore Platform", version="0.1.0")
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    fastapi_app.include_router(router)
    from app.api.public import router as public_router
    fastapi_app.include_router(public_router)
    from app.reconstruction.routes import router as recon_router
    fastapi_app.include_router(recon_router)
    from app.avoidance.routes import router as avoidance_router
    fastapi_app.include_router(avoidance_router)
    from app.webrtc.mesh_units import router as mesh_units_router
    fastapi_app.include_router(mesh_units_router)

    # Desktop app installers + electron-updater manifests - plain static
    # files, no auth (same tier as a public download page). Directory is
    # created empty if missing so a fresh checkout doesn't fail to boot;
    # CI populates it with real builds (see desktop/README.md).
    # NOT StaticFiles: the pinned Starlette (0.38.6) ignores Range entirely,
    # which deadlocks electron-updater on every client <=0.1.5 - see
    # app/api/releases.py for the full explanation.
    settings.releases_dir.mkdir(parents=True, exist_ok=True)
    register_releases_routes(fastapi_app, settings.releases_dir)

    # ------------------------------------------------------------------ #
    # Socket.IO                                                            #
    # ------------------------------------------------------------------ #
    from app.utils import safe_json
    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins=cors_origins,
        ping_timeout=20,
        ping_interval=10,
        # NaN/inf anywhere in a payload is invalid JSON; a browser client
        # that receives it closes the connection (see utils/safe_json.py).
        json=safe_json,
    )
    set_sio(sio)

    # ------------------------------------------------------------------ #
    # Shared state - created once, passed everywhere                      #
    # ------------------------------------------------------------------ #
    session_manager = SessionManager()
    peer_registry   = PeerRegistry()

    def on_cv_result(meta: dict):
        """Called by vision modules when a frame is processed."""
        pass  # Socket.IO emit handled inside stream_track via session

    vision_pool = VisionWorkerPool(results_callback=on_cv_result)

    # Store on app for access from routes
    fastapi_app.state.session_manager = session_manager
    fastapi_app.state.peer_registry   = peer_registry
    fastapi_app.state.vision_pool     = vision_pool

    # ------------------------------------------------------------------ #
    # Load vision modules at startup                                       #
    # ------------------------------------------------------------------ #
    @fastapi_app.on_event("startup")
    async def on_startup():
        from app.db import init_db
        await init_db()  # non-fatal - flying never depends on the DB
        from app.zones import engine as zone_engine
        await zone_engine.reload()
        from app.planner import features as feature_engine
        from app.planner import profiles as route_profiles
        await feature_engine.reload()
        await route_profiles.ensure_builtins()
        logger.info("Loading vision modules...")
        await asyncio.to_thread(vision_pool.load)
        logger.info("✅ Vision modules ready")
        from app.tasks import dispatcher
        dispatcher.start(session_manager)
        from app.fleet import service as fleet_service
        fleet_service.start_background()
        from app.avoidance import loop as avoidance_loop
        avoidance_loop.start(session_manager)
        from app import loop_stall
        loop_stall.start()

    @fastapi_app.on_event("shutdown")
    async def on_shutdown():
        from app.tasks import dispatcher
        dispatcher.stop()
        from app.avoidance import loop as avoidance_loop
        avoidance_loop.stop()
        from app.fleet import service as fleet_service
        fleet_service.stop_background()
        await fleet_service.disconnect_all()
        import asyncio as _aio
        from app.reconstruction import service as recon_service
        await _aio.to_thread(recon_service.shutdown_engine)
        from app.db import close_db
        await close_db()
        await vision_pool.stop_all()
        for pid in list(peer_registry._peers.keys()):
            await peer_registry.remove(pid)

    # ------------------------------------------------------------------ #
    # Socket.IO lifecycle                                                  #
    # ------------------------------------------------------------------ #
    @sio.event
    async def connect(sid, environ, auth):
        token = (auth or {}).get("token")
        if token != settings.secret_token:
            logger.warning(f"Rejected {sid[:8]} - bad token")
            return False

        session = session_manager.create(socket_id=sid)
        logger.info(f"Connected {sid[:8]} → session {session.session_id[:8]}")

        # Approximate client location for the admin map. Through the tunnel
        # the socket peer is localhost - the real IP is in CF-Connecting-IP.
        ip = (
            environ.get("HTTP_CF_CONNECTING_IP")
            or (environ.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip()
            or environ.get("REMOTE_ADDR")
        )
        session.client_ip = ip

        async def _resolve_location():
            from app.utils.geoip import locate
            session.approx_location = await locate(ip)

        asyncio.create_task(_resolve_location())

        async def _send_ready():
            await asyncio.sleep(0.05)
            await sio.emit(
                "session_ready",
                {
                    "session_id": session.session_id,
                    "device":     settings.device,
                    "gpu_count":  settings.gpu_count,
                    "max_sessions": settings.max_concurrent_sessions,
                },
                to=sid,
            )
        asyncio.create_task(_send_ready())
        return True

    @sio.event
    async def disconnect(sid):
        entry = peer_registry.get_by_socket(sid)
        if entry:
            await peer_registry.remove(entry.pc_id)

        from app.sessions import observer
        observer.drop_sid(sid)

        session = session_manager.get_by_socket(sid)
        if session:
            from app.telemetry.serial_bridge import close_bridge
            close_bridge(session.session_id)
            close_swarm_relay_bridge(session.session_id)
            from app.flights import recorder
            await recorder.end_flight(session.session_id)
            from app.zones import monitor as zone_monitor
            zone_monitor.drop(session.session_id)
            # A relay listener holds a port AND its own ffmpeg, neither tied
            # to the peer connection - a client that vanishes without the pc
            # ever changing state would leak both.
            from app.webrtc import relay_video_source
            relay_video_source.release(session.session_id)
            # Same reasoning for the DataChannel ingest: it holds a socket and a
            # loopback port owned by the DESKTOP's PeerConnection, not the
            # browser's. Session teardown is the only unambiguous place to free
            # it - releasing it when the browser's pc changes state would kill a
            # feed the desktop is still pushing.
            from app.webrtc import datachannel_video_source
            datachannel_video_source.release(session.session_id)
            observer.drop_session(session.session_id)
            await vision_pool.unregister_session(session.session_id)
            await session_manager.destroy(session.session_id)
            cleanup_session_fleet_state(session.session_id)

        logger.info(f"Disconnected {sid[:8]}")

    # ------------------------------------------------------------------ #
    # Register event handlers                                              #
    # ------------------------------------------------------------------ #
    register_telemetry_events(sio, session_manager, vision_pool)
    register_swarm_events(sio, session_manager)
    register_admin_events(sio, session_manager)
    register_permit_events(sio, session_manager)
    register_webrtc_events(sio, peer_registry, vision_pool, session_manager)
    register_gs_relay_events(sio)

    # ------------------------------------------------------------------ #
    # Mount                                                                #
    # ------------------------------------------------------------------ #
    asgi_app = socketio.ASGIApp(
        socketio_server=sio,
        other_asgi_app=fastapi_app,
        socketio_path="/socket.io",
    )

    logger.info(
        f"Server ready - device={settings.device} "
        f"gpus={settings.gpu_count} "
        f"origins={cors_origins}"
    )
    return asgi_app
import asyncio
import logging
import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.utils.logging import setup_logging  # must run before any verocore logger is used
setup_logging()

from app.sessions.manager import SessionManager
from app.webrtc.peer_registry import PeerRegistry
from app.vision.worker_pool import VisionWorkerPool
from app.events.telemetry_events import register_telemetry_events
from app.events.swarm_events import register_swarm_events
from app.events.admin_events import register_admin_events
from app.events.permit_events import register_permit_events
from app.webrtc.signaling import register_webrtc_events
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

    # ------------------------------------------------------------------ #
    # Socket.IO                                                            #
    # ------------------------------------------------------------------ #
    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins=cors_origins,
        ping_timeout=20,
        ping_interval=10,
    )

    # ------------------------------------------------------------------ #
    # Shared state — created once, passed everywhere                      #
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
        await init_db()  # non-fatal — flying never depends on the DB
        from app.zones import engine as zone_engine
        await zone_engine.reload()
        logger.info("Loading vision modules...")
        await asyncio.to_thread(vision_pool.load)
        logger.info("✅ Vision modules ready")

    @fastapi_app.on_event("shutdown")
    async def on_shutdown():
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
            logger.warning(f"Rejected {sid[:8]} — bad token")
            return False

        session = session_manager.create(socket_id=sid)
        logger.info(f"Connected {sid[:8]} → session {session.session_id[:8]}")

        # Approximate client location for the admin map. Through the tunnel
        # the socket peer is localhost — the real IP is in CF-Connecting-IP.
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
            from app.flights import recorder
            await recorder.end_flight(session.session_id)
            from app.zones import monitor as zone_monitor
            zone_monitor.drop(session.session_id)
            observer.drop_session(session.session_id)
            await vision_pool.unregister_session(session.session_id)
            await session_manager.destroy(session.session_id)

        logger.info(f"Disconnected {sid[:8]}")

    # ------------------------------------------------------------------ #
    # Register event handlers                                              #
    # ------------------------------------------------------------------ #
    register_telemetry_events(sio, session_manager, vision_pool)
    register_swarm_events(sio, session_manager)
    register_admin_events(sio, session_manager)
    register_permit_events(sio, session_manager)
    register_webrtc_events(sio, peer_registry, vision_pool, session_manager)

    # ------------------------------------------------------------------ #
    # Mount                                                                #
    # ------------------------------------------------------------------ #
    asgi_app = socketio.ASGIApp(
        socketio_server=sio,
        other_asgi_app=fastapi_app,
        socketio_path="/socket.io",
    )

    logger.info(
        f"Server ready — device={settings.device} "
        f"gpus={settings.gpu_count} "
        f"origins={cors_origins}"
    )
    return asgi_app
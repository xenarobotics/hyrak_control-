import asyncio
import secrets
import time
import logging
import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

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
from app.auth import service as auth_service
from app.auth import live_scope, socket_guard
from app.auth.clientip import client_ip_from
from app.auth.routes import router as auth_router

logger = logging.getLogger("verocore.server")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Browser hardening on every HTTP response. The API serves JSON and a
    few file downloads - nothing here is meant to be framed or sniffed."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("Permissions-Policy",
                     "camera=(self), microphone=(self), geolocation=(self), "
                     "serial=(self), usb=(self), payment=()")
        return response


def create_app() -> socketio.ASGIApp:
    settings = get_settings()
    cors_origins = settings.allowed_origins + settings.lan_origins

    # ------------------------------------------------------------------ #
    # FastAPI                                                              #
    # ------------------------------------------------------------------ #
    fastapi_app = FastAPI(title="Verocore Platform", version="0.1.0")
    # Explicit allow-list only - never "*" (allow_credentials would be
    # refused by browsers, and a wildcard would let any site call the API
    # with a stolen token). Middleware order: CORS must be the OUTERMOST so
    # its headers land on every response, including the security ones.
    fastapi_app.add_middleware(SecurityHeadersMiddleware)
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # Downloads are fetched into a blob (they need the bearer), so the
        # page reads the server's file name from this header.
        expose_headers=["Content-Disposition"],
    )
    fastapi_app.include_router(auth_router)
    fastapi_app.include_router(router)
    from app.workspaces.routes import router as workspaces_router
    fastapi_app.include_router(workspaces_router)
    from app.api.public import router as public_router
    fastapi_app.include_router(public_router)
    from app.reconstruction.routes import router as recon_router
    fastapi_app.include_router(recon_router)
    from app.avoidance.routes import router as avoidance_router
    fastapi_app.include_router(avoidance_router)
    from app.webrtc.mesh_units import router as mesh_units_router
    fastapi_app.include_router(mesh_units_router)
    from app.latency_probe import router as latency_probe_router
    fastapi_app.include_router(latency_probe_router)

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
        # A dead path is noticed in ping_interval + ping_timeout (5 s), not 30 s.
        # Cheap: a few bytes per ping. A client that drops is not torn down
        # any more (see SESSION_GRACE_S), so a short timeout costs nothing.
        ping_timeout=3,
        ping_interval=2,
        # NaN/inf anywhere in a payload is invalid JSON; a browser client
        # that receives it closes the connection (see utils/safe_json.py).
        json=safe_json,
    )
    set_sio(sio)
    SESSION_GRACE_S = 90.0
    _expiry_tasks: dict = {}

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
    # Vision history rows are stamped with their session's workspace
    # (docs/ACCESS_MODEL.md 8b); the analyzers only know the session id.
    from app.vision import persistence as vision_persistence
    vision_persistence.set_workspace_resolver(session_manager.workspace_of)

    # ------------------------------------------------------------------ #
    # Load vision modules at startup                                       #
    # ------------------------------------------------------------------ #
    @fastapi_app.on_event("startup")
    async def on_startup():
        from app.db import init_db
        await init_db()  # non-fatal - flying never depends on the DB
        await auth_service.bootstrap()
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
        from app.avoidance.core import loop as avoidance_loop
        avoidance_loop.start(session_manager)
        from app import loop_stall
        loop_stall.start()

    @fastapi_app.on_event("shutdown")
    async def on_shutdown():
        from app.tasks import dispatcher
        dispatcher.stop()
        from app.avoidance.core import loop as avoidance_loop
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
    def _takeover_field(session_id: str):
        """Whether HYRAK operations hold this session's drone (8b): the
        customer's banner survives a page reload or a resume."""
        from app.sessions import takeover as _takeover
        held = _takeover.holder(session_id)
        return held.public() if held is not None else None

    def _scope_fields(scope) -> dict:
        """What session_ready says about the session's workspace: the client
        shows only what `perms` allow, and `staff` tells it to keep the
        staff-only surfaces (fleet, mesh units, relays, wall)."""
        return {"workspace_id": scope.workspace_id, "perms": sorted(scope.perms),
                "staff": scope.is_staff}

    # Socket ids whose session was handed to a newer socket (resume before
    # the old one's ping timeout, audit B8). Their eventual disconnect must
    # not park or tear down the session the new socket now owns.
    _superseded_sids: set = set()

    @sio.event
    async def connect(sid, environ, auth):
        auth = auth or {}
        token = auth.get("token")
        user = await auth_service.authenticate(token)
        if user is None:
            logger.warning(f"Rejected {sid[:8]} - not signed in")
            raise socketio.exceptions.ConnectionRefusedError("unauthorized")
        # Legacy shared-token sockets have no per-user token to re-check.
        token_hash = auth_service.hash_token(token) if user.id != auth_service.LEGACY_USER_ID else None
        requested_ws = auth.get("workspace_id") or None

        # A socket that dropped and came back reclaims its session - drone
        # link, radio relay, flight record, avoidance - instead of starting
        # over. Bound to the SAME USER and to the per-session resume_secret
        # handed out in session_ready: a session id alone (visible in logs,
        # the admin page, the URL bar) must not be enough to take over a
        # drone. Allowed whether or not the old socket has been noticed as
        # gone yet - a client that reconnects inside the ping timeout used to
        # get a fresh session while the old one tore its drone link down
        # 90 s later (audit B8).
        #
        # Also bound to the SAME WORKSPACE: a session belongs to one
        # workspace for its whole life (docs/ACCESS_MODEL.md 8a), so a resume
        # that names a different workspace_id starts a fresh session instead
        # (the old one is parked and expires as usual). Omitting workspace_id
        # on resume keeps the session's own. The user's access to it is
        # re-checked here like on any connect: a customer who lost `view`
        # cannot reclaim it.
        prior = session_manager.resumable(
            auth.get("resume_session"), user.id, auth.get("resume_secret"))
        if prior is not None and requested_ws and prior.workspace_id and requested_ws != prior.workspace_id:
            logger.info(f"Resume of {prior.session_id[:8]} declined: it belongs to workspace "
                        f"{prior.workspace_id[:8]}, the client asked for {str(requested_ws)[:8]}")
            prior = None
        scope = await live_scope.resolve(
            user, prior.workspace_id if (prior is not None and prior.workspace_id) else requested_ws)
        if scope is None:
            # Not "unauthorized", so the client keeps its (valid) token and
            # can offer the user another workspace.
            logger.warning(f"Rejected {sid[:8]} - {user.username} has no access to workspace "
                           f"{requested_ws or '(default)'}")
            raise socketio.exceptions.ConnectionRefusedError(live_scope.NO_WORKSPACE_ACCESS)
        if prior is not None:
            gone = (time.monotonic() - prior.detached_at) if prior.detached_at is not None else 0.0
            if prior.detached_at is None and prior.socket_id and prior.socket_id != sid:
                _superseded_sids.add(prior.socket_id)
                prior.superseded_sids.append(prior.socket_id)
                logger.info(f"Session {prior.session_id[:8]}: socket {prior.socket_id[:8]} "
                            f"superseded by {sid[:8]} before its timeout")
            prior.detached_at = None
            prior.socket_id = sid
            # The user re-authenticated just now: their CURRENT role and
            # token are what the session carries from here, not the ones
            # from the original connect.
            prior.username = user.username
            prior.role = user.role
            prior.token_hash = token_hash
            prior.auth_checked_at = time.monotonic()
            live_scope.stamp(prior, user, scope)
            await live_scope.refresh_drone_access(prior)
            for alias in list(prior.sid_aliases):
                await sio.enter_room(sid, alias)
            prior.sid_aliases.append(sid)
            task = _expiry_tasks.pop(prior.session_id, None)
            if task is not None:
                task.cancel()
            # A console that took over a session keeps it across its own
            # reconnect (docs/ACCESS_MODEL.md 8b "Takeover").
            from app.sessions import takeover as _takeover
            if _takeover.cancel_pending(prior.session_id):
                logger.info(f"Session {prior.session_id[:8]}: back in time, its takeover stands")
            logger.info(f"Resumed session {prior.session_id[:8]} on {sid[:8]} for "
                        f"{user.username} after {gone:.1f}s away")

            async def _send_resumed():
                await asyncio.sleep(0.05)
                await sio.emit("session_ready", {
                    "session_id": prior.session_id, "device": settings.device,
                    "gpu_count": settings.gpu_count,
                    "max_sessions": settings.max_concurrent_sessions,
                    "resumed": True, "away_s": round(gone, 1),
                    "telemetry_connected": bool(prior.telemetry_connected),
                    "resume_secret": prior.resume_secret,
                    "user": user.public(),
                    **_scope_fields(scope),
                    "takeover": _takeover_field(prior.session_id),
                }, to=sid)
            asyncio.create_task(_send_resumed())
            return True

        session = session_manager.create(socket_id=sid)
        session.sid_aliases.append(sid)
        session.user_id = user.id
        session.username = user.username
        session.role = user.role
        session.token_hash = token_hash
        session.auth_checked_at = time.monotonic()
        session.resume_secret = secrets.token_urlsafe(32)
        live_scope.stamp(session, user, scope)
        session_manager.note_owner(session.session_id, user.id, scope.workspace_id)
        if not scope.is_staff:
            # The enrolled-face gallery is HYRAK's global data: a customer's
            # person-tracking matches nobody rather than everyone HYRAK knows.
            vision_pool.deny_gallery(session.session_id)
        logger.info(f"Connected {sid[:8]} ({user.username}/{user.role}) → session {session.session_id[:8]} "
                    f"in workspace {scope.workspace_id[:8]}{'' if scope.is_staff else ' (customer)'}")

        # Approximate client location for the admin map. Through the tunnel
        # the socket peer is localhost - the real IP is in CF-Connecting-IP,
        # believed only when the peer is a trusted proxy (app/auth/clientip).
        ip = client_ip_from(environ.get("REMOTE_ADDR"),
                            environ.get("HTTP_CF_CONNECTING_IP"),
                            environ.get("HTTP_X_FORWARDED_FOR"))
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
                    "resume_secret": session.resume_secret,
                    "user": user.public(),
                    **_scope_fields(scope),
                },
                to=sid,
            )
        asyncio.create_task(_send_ready())
        return True

    @sio.event
    async def disconnect(sid):
        if sid in _superseded_sids:
            # The session already moved to a newer socket; this is the old
            # one's late goodbye. Its peer entry and observer rooms are
            # still its own to drop, but the session is not parked.
            _superseded_sids.discard(sid)
            entry = peer_registry.get_by_socket(sid)
            if entry:
                await peer_registry.remove(entry.pc_id)
            from app.sessions import observer as _obs
            _obs.drop_sid(sid)
            logger.info(f"Disconnected superseded socket {sid[:8]} (session kept)")
            return
        entry = peer_registry.get_by_socket(sid)
        if entry:
            await peer_registry.remove(entry.pc_id)

        from app.sessions import observer
        observer.drop_sid(sid)
        from app.webrtc import wall as _wall
        await _wall.close_for_sid(sid)
        # The single view's shared feed port is owned by its PeerEntry and
        # released by peer_registry.remove above.

        session = session_manager.get_by_socket(sid)
        if session:
            # Park the session instead of destroying it: its drone link keeps
            # running (the cloud is the companion computer - it does not stop
            # flying because the operator's browser blinked) and the client
            # reclaims it on reconnect. Torn down only if nobody comes back.
            session.detached_at = time.monotonic()
            logger.info(f"Session {session.session_id[:8]} lost its socket {sid[:8]} - "
                        f"held for {SESSION_GRACE_S:.0f}s for the client to return")
            # A console holding a takeover releases it after a short grace
            # unless it comes back (the customer is not locked out for 90 s).
            from app.events.admin_events import on_staff_socket_gone
            await on_staff_socket_gone(session)
            _expiry_tasks[session.session_id] = asyncio.create_task(
                _expire_session(session.session_id))
        logger.info(f"Disconnected {sid[:8]}")

    async def _expire_session(session_id: str):
        await asyncio.sleep(SESSION_GRACE_S)
        _expiry_tasks.pop(session_id, None)
        session = session_manager.get(session_id)
        if session is None or session.detached_at is None:
            return
        logger.info(f"Session {session_id[:8]}: client did not return within {SESSION_GRACE_S:.0f}s - tearing down")
        await _teardown_session(session)

    async def _teardown_session(session):
        """Everything a session owns beyond its socket. Runs once, when the
        client has not come back within SESSION_GRACE_S."""
        from app.sessions import observer
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
        # Off the loop: close() waits up to 3 s for ffmpeg to exit.
        await relay_video_source.release_async(session.session_id)
        # Same reasoning for the DataChannel ingest: it holds a socket and a
        # loopback port owned by the DESKTOP's PeerConnection, not the
        # browser's. Session teardown is the only unambiguous place to free
        # it - releasing it when the browser's pc changes state would kill a
        # feed the desktop is still pushing.
        from app.webrtc import datachannel_video_source
        datachannel_video_source.release(session.session_id)
        observer.drop_session(session.session_id)
        from app.events.admin_events import on_session_ended
        await on_session_ended(session.session_id)
        await vision_pool.unregister_session(session.session_id)
        vision_pool.drop_gallery_rule(session.session_id)
        await session_manager.destroy(session.session_id)
        cleanup_session_fleet_state(session.session_id)

    # ------------------------------------------------------------------ #
    # Register event handlers                                              #
    # ------------------------------------------------------------------ #
    socket_guard.configure(sio, session_manager)

    async def _disconnect_user_sockets(user_id: str):
        """A revoked, disabled, deleted or re-roled user loses every live
        socket now. The session is parked like any other drop (the drone
        link keeps running for the grace period); a still-valid token
        resumes it with the fresh role, a revoked one cannot."""
        for s in list(session_manager.all_sessions()):
            if s.user_id == user_id and s.socket_id and s.detached_at is None:
                logger.info(f"Session {s.session_id[:8]} ({s.username}): access changed - "
                            f"disconnecting {s.socket_id[:8]}")
                try:
                    await sio.disconnect(s.socket_id)
                except Exception:
                    pass
    auth_service.on_user_revoked(_disconnect_user_sockets)
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
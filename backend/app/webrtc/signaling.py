"""
WebRTC signaling via Socket.IO.
Handles offer/answer/ICE exchange.
"""
import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaRelay
from aiortc.sdp import candidate_from_sdp

from app.sessions import observer
from app.webrtc.peer_registry import PeerRegistry, PeerEntry
from app.webrtc.stream_track import MultiModeVideoStreamTrack

if TYPE_CHECKING:
    from app.vision.worker_pool import VisionWorkerPool
    from app.sessions.manager import SessionManager

logger = logging.getLogger("verocore.webrtc.signaling")

# One relay shared across all peers — efficient media routing
relay = MediaRelay()


async def _add_ice_candidate(pc, cand_sdp, sdp_mid, sdp_mline_index):
    try:
        parsed = candidate_from_sdp(cand_sdp)
        candidate = RTCIceCandidate(
            foundation=getattr(parsed, "foundation", None),
            component=getattr(parsed, "component", None),
            protocol=getattr(parsed, "protocol", None),
            priority=getattr(parsed, "priority", None),
            ip=getattr(parsed, "ip", None),
            port=getattr(parsed, "port", None),
            type=getattr(parsed, "type", None),
            sdpMid=sdp_mid,
            sdpMLineIndex=sdp_mline_index,
            relatedAddress=getattr(parsed, "relatedAddress", None),
            relatedPort=getattr(parsed, "relatedPort", None),
            tcpType=getattr(parsed, "tcpType", None),
        )
        await pc.addIceCandidate(candidate)
    except Exception as e:
        logger.warning(f"ICE candidate error: {e}")


def _sort_relay_urls(urls) -> list[str]:
    """TURN urls ordered most-reachable first for aiortc: turns (TLS/TCP,
    :443 before :5349) > turn?transport=tcp > turn UDP. STUN order kept."""
    if isinstance(urls, str):
        urls = [urls]

    def rank(u: str):
        if u.startswith("turns:"):
            return (0, 0 if ":443" in u else 1)
        if u.startswith("turn:") and "transport=tcp" in u:
            return (1, 0)
        if u.startswith("turn:"):
            return (2, 0)
        return (3, 0)  # stun — irrelevant to turn selection

    return sorted(urls, key=rank)


def register_webrtc_events(
    sio,
    peer_registry: PeerRegistry,
    vision_pool: "VisionWorkerPool",
    session_manager: "SessionManager",
):
    @sio.on("offer")
    async def on_offer(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit("error", {"msg": "No session"}, to=sid)
            return

        # Build RTCPeerConnection
        ice_servers = data.get("iceServers", [])
        # Only pass the fields aiortc knows — browser dicts can carry extras
        # (credentialType etc.) that would TypeError in the dataclass.
        # aiortc uses only the FIRST turn/turns url it encounters, so sort
        # TLS/TCP relays first: turn-over-UDP (the provider default first
        # entry) is dead on UDP-blocking networks like campus WiFi, while
        # turns:443 traverses essentially any firewall.
        ice_objs = [
            RTCIceServer(
                urls=_sort_relay_urls(s["urls"]),
                username=s.get("username"),
                credential=s.get("credential"),
            )
            for s in ice_servers
            if s.get("urls")
        ]
        config = RTCConfiguration(iceServers=ice_objs) if ice_objs else None
        pc = RTCPeerConnection(configuration=config)
        pc_id = f"pc_{uuid.uuid4()}"

        # Client-overlay stream: the browser displays its own camera and
        # draws cv_results on a canvas — no downlink video at all. The
        # uplink still feeds inference, drone commands and the observer.
        client_overlay = bool(data.get("clientOverlay"))

        entry = PeerEntry(
            pc_id=pc_id,
            session_id=session.session_id,
            socket_id=sid,
            pc=pc,
        )
        peer_registry.add(entry)
        session.pc_id = pc_id
        session.is_streaming = True

        # Register session with vision pool for current mode
        vision_pool.register_session(session.session_id, session.mode)

        @pc.on("connectionstatechange")
        async def on_state_change():
            logger.info(f"PC {pc_id[:8]} state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed", "disconnected"):
                session.is_streaming = False
                await vision_pool.unregister_session(session.session_id)
                await peer_registry.remove(pc_id)

        @pc.on("track")
        def on_track(track):
            if track.kind != "video":
                return

            async def emit_cv_results(payload: dict):
                await sio.emit("cv_results", payload, to=sid)

            async def emit_admin_frame(session_id: str, jpeg: bytes):
                await sio.emit(
                    "admin_frame",
                    {"session_id": session_id, "jpeg": jpeg},
                    room=observer.watch_room(session_id),
                )

            # buffered=False: always hand recv() the NEWEST frame and drop
            # stale ones. The buffered default queues every frame unboundedly,
            # so whenever processing ran slower than the camera the backlog
            # grew and glass-to-glass latency crept 300ms -> 1s+.
            video_track = MultiModeVideoStreamTrack(
                source_track=relay.subscribe(track, buffered=False),
                session_id=session.session_id,
                vision_pool=vision_pool,
                session_manager=session_manager,
                emit_callback=emit_cv_results,
                snapshot_callback=emit_admin_frame,
                return_video=not client_overlay,
            )
            entry.tracks.append(video_track)
            if client_overlay:
                # No consumer pulls recv() without an outgoing track, so
                # drive it ourselves; exits when the source track ends.
                async def _drive():
                    try:
                        while True:
                            await video_track.recv()
                    except Exception:
                        pass
                entry.drive_task = asyncio.create_task(_drive())
                logger.info(f"Client-overlay pipeline for session {session.session_id[:8]}")
            else:
                pc.addTrack(video_track)
                logger.info(f"Video track attached for session {session.session_id[:8]}")

        try:
            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=data["sdp"], type=data["type"])
            )

            # Apply any queued ICE candidates
            for cand_sdp, mid, mline in list(entry.pending_ice):
                await _add_ice_candidate(pc, cand_sdp, mid, mline)
            entry.pending_ice.clear()

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await sio.emit(
                "answer",
                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                to=sid,
            )
            logger.info(f"Answer sent for {pc_id[:8]}")

        except Exception as e:
            logger.exception(f"Offer handling error: {e}")
            await peer_registry.remove(pc_id)

    @sio.on("ice_candidate")
    async def on_ice_candidate(sid, data):
        entry = peer_registry.get_by_socket(sid)
        if not entry:
            return

        if not data:
            return

        cand_sdp = data.get("candidate")
        sdp_mid = data.get("sdpMid")
        sdp_mline_index = data.get("sdpMLineIndex")

        if not cand_sdp:
            return

        if entry.pc.remoteDescription is None:
            entry.pending_ice.append((cand_sdp, sdp_mid, sdp_mline_index))
            return

        await _add_ice_candidate(entry.pc, cand_sdp, sdp_mid, sdp_mline_index)

    @sio.on("stop_stream")
    async def on_stop_stream(sid):
        entry = peer_registry.get_by_socket(sid)
        if not entry:
            return
        session = session_manager.get(entry.session_id)
        if session:
            session.is_streaming = False
        await vision_pool.unregister_session(entry.session_id)
        await peer_registry.remove(entry.pc_id)
        await sio.emit("stream_stopped", {}, to=sid)
        logger.info(f"Stream stopped for {sid[:8]}")
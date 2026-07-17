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
        ice_objs = [RTCIceServer(**s) for s in ice_servers] if ice_servers else []
        config = RTCConfiguration(iceServers=ice_objs) if ice_objs else None
        pc = RTCPeerConnection(configuration=config)
        pc_id = f"pc_{uuid.uuid4()}"

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

            video_track = MultiModeVideoStreamTrack(
                source_track=relay.subscribe(track),
                session_id=session.session_id,
                vision_pool=vision_pool,
                session_manager=session_manager,
                emit_callback=emit_cv_results,
                snapshot_callback=emit_admin_frame,
            )
            entry.tracks.append(video_track)
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
"""Camera wall: one extra PeerConnection per socket carrying one video track
per mesh unit, all from the shared feeds (feeds.py). The browser offers N
recvonly transceivers; we attach N relay tracks in the same order and answer
with a {mid: port} map so the client can label each incoming track.
"""
from __future__ import annotations

import logging

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

from app.webrtc import feeds

logger = logging.getLogger("verocore.webrtc.wall")

_walls: dict[str, tuple[RTCPeerConnection, list[int]]] = {}   # sid -> (pc, ports)


async def close_for_sid(sid: str) -> None:
    ent = _walls.pop(sid, None)
    if not ent:
        return
    pc, ports = ent
    try:
        await pc.close()
    except Exception:
        pass
    for p in ports:
        await feeds.release(p)
    logger.info(f"Wall closed for {sid[:8]} ({len(ports)} feeds released)")


def register(sio) -> None:
    from app.webrtc.signaling import _sort_relay_urls, _add_ice_candidate

    @sio.on("wall_offer")
    async def on_wall_offer(sid, data):
        data = data or {}
        ports = [int(p) for p in (data.get("ports") or [])][:12]
        await close_for_sid(sid)
        ice_objs = [
            RTCIceServer(urls=_sort_relay_urls(s["urls"]), username=s.get("username"),
                         credential=s.get("credential"))
            for s in data.get("iceServers", []) if s.get("urls")
        ]
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_objs) if ice_objs else None)
        held: list[int] = []
        track_port: dict[int, int] = {}
        for port in ports:
            try:
                t = await feeds.acquire(port, timeout=3.0)
            except Exception as e:
                logger.warning(f"Wall: udp:{port} not available: {e}")
                continue
            held.append(port)
            pc.addTrack(t)
            track_port[id(t)] = port
        _walls[sid] = (pc, held)

        @pc.on("connectionstatechange")
        async def _st():
            if pc.connectionState in ("failed", "closed", "disconnected"):
                if _walls.get(sid, (None,))[0] is pc:
                    await close_for_sid(sid)

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type=data["type"]))
            await pc.setLocalDescription(await pc.createAnswer())
        except Exception as e:
            logger.error(f"Wall negotiation failed: {e}")
            await close_for_sid(sid)
            await sio.emit("wall_error", {"error": str(e)}, to=sid)
            return
        mids = {}
        for tr in pc.getTransceivers():
            t = tr.sender.track if tr.sender else None
            if t is not None and id(t) in track_port:
                mids[tr.mid] = track_port[id(t)]
        await sio.emit("wall_answer", {
            "sdp": pc.localDescription.sdp, "type": pc.localDescription.type,
            "mids": mids, "ports": held,
        }, to=sid)
        logger.info(f"Wall for {sid[:8]}: {len(held)} feed(s) {held}")

    @sio.on("wall_ice_candidate")
    async def on_wall_ice(sid, data):
        ent = _walls.get(sid)
        if not ent or not data or not data.get("candidate"):
            return
        pc = ent[0]
        if pc.remoteDescription is None:
            return
        await _add_ice_candidate(pc, data.get("candidate"), data.get("sdpMid"), data.get("sdpMLineIndex"))

    @sio.on("wall_close")
    async def on_wall_close(sid, data=None):
        await close_for_sid(sid)

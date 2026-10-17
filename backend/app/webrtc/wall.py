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

MAX_WALL_FEEDS = 12

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
    # Snapshot: an acquire still in flight for this wall appends to `ports`
    # after we are gone, and releases its own port when it finds the wall
    # replaced (see on_wall_offer).
    for p in list(ports):
        await feeds.release(p)
    ports.clear()
    logger.info(f"Wall closed for {sid[:8]} ({len(ports)} feeds released)")


def _parse_ports(raw) -> list[int]:
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        raise ValueError("ports must be a list of UDP port numbers")
    out: list[int] = []
    for p in raw:
        if isinstance(p, bool):
            raise ValueError(f"invalid port {p!r}")
        try:
            n = int(p)
        except (TypeError, ValueError):
            raise ValueError(f"invalid port {p!r}") from None
        if not 1 <= n <= 65535:
            raise ValueError(f"port {n} out of range")
        out.append(n)
    return out[:MAX_WALL_FEEDS]


def _parse_ice(raw) -> list[RTCIceServer]:
    if not raw:
        return []
    if not isinstance(raw, list):
        raise ValueError("iceServers must be a list")
    out = []
    for s in raw:
        if not isinstance(s, dict):
            raise ValueError("each iceServers entry must be an object with urls")
        urls = s.get("urls")
        if not urls:
            continue
        out.append(RTCIceServer(urls=urls, username=s.get("username"),
                                credential=s.get("credential")))
    return out


def register(sio) -> None:
    from app.webrtc.signaling import _sort_relay_urls, _add_ice_candidate

    @sio.on("wall_offer")
    async def on_wall_offer(sid, data):
        # Everything that can reject the request happens inside this try, so
        # bad input reaches the client as wall_error rather than a traceback
        # in the log and a wall stuck on "connecting" (audit B28).
        pc: RTCPeerConnection | None = None
        try:
            if not isinstance(data, dict):
                raise ValueError("wall_offer must be an object")
            if not isinstance(data.get("sdp"), str) or data.get("type") != "offer":
                raise ValueError("wall_offer needs sdp and type 'offer'")
            ports = _parse_ports(data.get("ports"))
            ice_objs = _parse_ice(data.get("iceServers"))
            for ice in ice_objs:
                ice.urls = _sort_relay_urls(ice.urls)
            await close_for_sid(sid)
            pc = RTCPeerConnection(
                configuration=RTCConfiguration(iceServers=ice_objs) if ice_objs else None)
            held: list[int] = []
            track_port: dict[int, int] = {}
            # Registered BEFORE acquiring: an overlapping wall_offer (or a
            # disconnect) for this sid can then close THIS wall and release
            # whatever it has acquired so far, instead of finding nothing
            # and leaking every port the loop below went on to take.
            _walls[sid] = (pc, held)

            @pc.on("connectionstatechange")
            async def _st():
                if pc.connectionState in ("failed", "closed", "disconnected"):
                    if _walls.get(sid, (None,))[0] is pc:
                        await close_for_sid(sid)

            for port in ports:
                try:
                    t = await feeds.acquire(port, timeout=3.0)
                except Exception as e:
                    logger.warning(f"Wall: udp:{port} not available: {e}")
                    continue
                if _walls.get(sid, (None,))[0] is not pc:
                    # Superseded while waiting on this feed: it is ours to
                    # give back, nobody else knows we hold it.
                    await feeds.release(port)
                    logger.info(f"Wall for {sid[:8]} replaced mid-setup, dropping udp:{port}")
                    return
                held.append(port)
                pc.addTrack(t)
                track_port[id(t)] = port

            await pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type=data["type"]))
            await pc.setLocalDescription(await pc.createAnswer())
        except Exception as e:
            logger.error(f"Wall negotiation failed for {sid[:8]}: {e}")
            if pc is not None and _walls.get(sid, (None,))[0] is pc:
                await close_for_sid(sid)
            await sio.emit("wall_error", {"error": str(e)}, to=sid)
            return
        if _walls.get(sid, (None,))[0] is not pc:
            return   # replaced during negotiation; the newer offer answers
        mids = {}
        for tr in pc.getTransceivers():
            t = tr.sender.track if tr.sender else None
            if t is not None and id(t) in track_port:
                mids[tr.mid] = track_port[id(t)]
        await sio.emit("wall_answer", {
            "sdp": pc.localDescription.sdp, "type": pc.localDescription.type,
            "mids": mids, "ports": list(held),
        }, to=sid)
        logger.info(f"Wall for {sid[:8]}: {len(held)} feed(s) {held}")

    @sio.on("wall_ice_candidate")
    async def on_wall_ice(sid, data):
        ent = _walls.get(sid)
        if not ent or not isinstance(data, dict) or not data.get("candidate"):
            return
        pc = ent[0]
        if pc.remoteDescription is None:
            return
        await _add_ice_candidate(pc, data.get("candidate"), data.get("sdpMid"), data.get("sdpMLineIndex"))

    @sio.on("wall_close")
    async def on_wall_close(sid, data=None):
        await close_for_sid(sid)

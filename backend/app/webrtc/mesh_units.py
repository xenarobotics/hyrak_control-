"""/api/video/mesh-units - which mesh air units are delivering video right now.

The WiFi relay tree sends every unit's RTP/H.265 to the ground station on
udp 5600 + node id, whatever its position in the tree (only the source IP
changes). So "which units are up" is answerable from the sockets alone: bind
each candidate port for a moment and count datagrams. A port that refuses
to bind is already owned - by this backend's air-unit reader for the unit
being watched, so it is reported live too. Read-only, no side effects, and
the probe runs off the event loop.
"""
from __future__ import annotations

import asyncio
import select
import socket
import time

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/video", tags=["video"])

BASE_PORT = 5600
PROBE_S = 0.35


def _probe(max_units: int) -> list[dict]:
    # Ports this backend's own feed readers hold are never probed: binding
    # would fail anyway, and a probe socket left open by any error here would
    # hold the port against the reader itself. Every socket is closed in a
    # finally, whatever happens in between.
    from app.webrtc import feeds
    ours = set(feeds.open_ports())
    out: list[dict] = []
    socks: dict[int, socket.socket] = {}
    stats: dict[int, dict] = {}
    try:
        for uid in range(1, max_units + 1):
            port = BASE_PORT + uid
            if port in ours:
                out.append({"id": uid, "port": port, "live": True, "in_use": True,
                            "kbps": None, "source": None})
                continue
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setblocking(False)
            try:
                s.bind(("0.0.0.0", port))
                socks[port] = s
                stats[port] = {"packets": 0, "bytes": 0, "source": None}
            except OSError:
                s.close()
                # Owned by another process (a gst viewer, another tool).
                out.append({"id": uid, "port": port, "live": True, "in_use": True,
                            "kbps": None, "source": None})
        t0 = time.monotonic()
        while time.monotonic() - t0 < PROBE_S and socks:
            ready, _, _ = select.select(list(socks.values()), [], [], 0.05)
            for s in ready:
                try:
                    d, a = s.recvfrom(4096)
                except OSError:
                    continue
                st = stats[s.getsockname()[1]]
                st["packets"] += 1
                st["bytes"] += len(d)
                st["source"] = a[0]
    finally:
        for s in socks.values():
            try:
                s.close()
            except OSError:
                pass
    for port in socks:
        st = stats[port]
        out.append({"id": port - BASE_PORT, "port": port, "live": st["packets"] > 0, "in_use": False,
                    "kbps": round(st["bytes"] * 8 / PROBE_S / 1000) if st["packets"] else 0,
                    "source": st["source"]})
    out.sort(key=lambda u: u["id"])
    return out


@router.get("/mesh-units")
async def mesh_units(max_units: int = Query(8, ge=1, le=64)):
    units = await asyncio.get_event_loop().run_in_executor(None, _probe, max_units)
    return {"base_port": BASE_PORT, "units": units}


@router.get("/feeds/{port}/hevc")
async def feed_hevc(port: int):
    """The unit's OWN H.265, bit-exact, as framed Annex-B access units:
    [uint32 len][uint8 key][uint32 seq][AU] - the format the app's
    WebCodecsVideo already parses. Starts at a keyframe (VPS/SPS/PPS in-band)
    so the decoder can configure from the stream itself."""
    from app.webrtc import feeds
    q = await feeds.subscribe_raw(port)

    async def gen():
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    continue          # quiet source: keep the connection, wait
                yield chunk
        finally:
            await feeds.unsubscribe_raw(port, q)

    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/feeds")
async def feeds_status():
    from app.webrtc import feeds
    return {"feeds": [feeds.status(p) for p in feeds.open_ports()]}

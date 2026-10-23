"""Live setpoint vs response feed for Config > Tuning, per socket.

One socket event, `tuning_stream` {on: bool, loop: "rate" | "attitude" |
"velocity" | "position"}: SESSION_VIEW. While on, the session's own MAVSDK
link is read for the selected loop's measured and setpoint messages (see
app/telemetry/tuning_stream.py) and rows go back as `tuning_data` to the
asking socket only, about ten rows per packet:

    {"loop": "rate", "hz": 50, "link": "local", "bytes_s": 4450,
     "att": [[t, roll, pitch, yaw, p, q, r], ...], "att_sp": [...]}

The first packet after a (re)start carries no rows, only the status, so the
page can say what it asked for before data arrives.

Read-only for the vehicle's flight: the only thing sent is
MAV_CMD_SET_MESSAGE_INTERVAL, to raise those messages' rates while the chart
is open (10 Hz on a radio, 50 Hz on USB / UDP), restored when it closes.

Stops when the page says off, when nobody renewed the lease for LEASE_S
(a closed tab), when the socket disconnects (drop_sid, from server.py) or
when the link drops.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.auth.socket_guard import require_session_view
from app.telemetry import tuning_stream as ts

logger = logging.getLogger("verocore.tuning_events")

LEASE_S = 20.0

# sid -> {"task": Task, "until": monotonic deadline, "tel": tel, "loop": str}
_feeds: dict[str, dict] = {}


async def drop_sid(sid: str) -> None:
    """The socket is gone: stop its feed now rather than at lease expiry."""
    feed = _feeds.pop(sid, None)
    if feed is not None and feed.get("task") is not None:
        feed["until"] = 0.0
        feed["task"].cancel()


async def run_feed(sid: str, tel, loop: str, emit, feeds: dict | None = None,
                   rates: "ts.MessageRates | None" = None) -> None:
    """Read the loop's two messages off `tel` and emit batched rows until the
    feed entry for `sid` goes away, its lease runs out or the link drops.
    `emit(payload)` sends one packet to the socket."""
    feeds = _feeds if feeds is None else feeds
    names = ts.LOOPS[loop]
    hz = ts.stream_hz(tel)
    rates = rates or ts.MessageRates.for_tel(tel)
    batch = ts.Batcher()
    stop = asyncio.Event()
    status = {"loop": loop, "hz": hz, "link": "radio" if hz == ts.RADIO_HZ else "local",
              "bytes_s": ts.extra_bytes_s(loop, hz)}

    async def _listen(name: str):
        key = ts.KEY[name]
        try:
            async for msg in tel._drone.mavlink_direct.message(name):
                if stop.is_set():
                    return
                # The autopilot only, not a gimbal or companion's own ATTITUDE.
                if int(getattr(msg, "component_id", 1) or 1) != 1:
                    continue
                row = ts.parse_row(name, msg.fields_json)
                if row is not None:
                    batch.add(key, row)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"tuning {name} stream ended: {e}")

    readers = [asyncio.create_task(_listen(n), name=f"tuning_{n}") for n in names]
    acq: asyncio.Future | None = None
    try:
        await emit(dict(status))
        # Shielded both ways: a feed cancelled half-way through raising the
        # rates lets the raise finish, then puts them back.
        acq = asyncio.ensure_future(rates.acquire(tel, names, hz))
        await asyncio.shield(acq)
        while True:
            feed = feeds.get(sid)
            if feed is None or feed.get("tel") is not tel or feed.get("loop") != loop \
                    or time.monotonic() > feed["until"] or not tel.is_connected:
                return
            while batch.due():
                await emit({**status, **batch.take()})
            await asyncio.sleep(0.02 if hz > ts.RADIO_HZ else 0.05)
    except asyncio.CancelledError:
        pass
    finally:
        stop.set()
        for r in readers:
            r.cancel()
        if acq is not None:
            try:
                await asyncio.shield(acq)
                await asyncio.shield(rates.release(tel, names))
            except (asyncio.CancelledError, Exception) as e:
                logger.debug(f"tuning stream: rate restore interrupted ({e})")
        cur = feeds.get(sid)
        if cur is not None and cur.get("task") is asyncio.current_task():
            feeds.pop(sid, None)


def register_tuning_events(sio, session_manager) -> None:

    async def _emit_to(sid, payload):
        await sio.emit("tuning_data", payload, to=sid)

    @sio.on("tuning_stream")
    async def on_tuning_stream(sid, data=None):
        if not await require_session_view(sid, "tuning_stream"): return
        d = data if isinstance(data, dict) else {}
        on = bool(d.get("on", True))
        cur = _feeds.get(sid)
        if not on:
            await drop_sid(sid)
            return
        loop = ts.normalise_loop(d.get("loop"))
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("tuning_data", {"error": "No drone connected"}, to=sid)
            return
        if cur is not None and cur.get("task") is not None and not cur["task"].done() \
                and cur.get("tel") is tel and cur.get("loop") == loop:
            cur["until"] = time.monotonic() + LEASE_S
            return
        if cur is not None and cur.get("task") is not None:
            cur["task"].cancel()
        feed = {"until": time.monotonic() + LEASE_S, "tel": tel, "loop": loop, "task": None}
        _feeds[sid] = feed
        feed["task"] = asyncio.create_task(
            run_feed(sid, tel, loop, lambda p: _emit_to(sid, p)), name=f"tuning_{sid[:6]}")

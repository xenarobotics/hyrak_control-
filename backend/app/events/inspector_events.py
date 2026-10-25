"""MAVLink Inspector feed for Config > Analyze, per socket.

One socket event, `inspector_stream`: SESSION_VIEW.

    {on: bool,
     open: ["ATTITUDE:1:1", ...],                 # messages whose fields to send
     plot: [{key: "ATTITUDE:1:1", field: "roll"}, ...],   # up to 6
     fast: bool}                                  # speed up the plotted messages

While on, the session's own MAVSDK link is read for every message
(mavlink_direct with an empty name) and `inspector_data` goes back to the
asking socket only, twice a second (see app/telemetry/inspector.py):

    {"t": 12.5, "msgs": [{key, name, sys, comp, n, hz, age, fields?}, ...],
     "plot": {"ATTITUDE:1:1|roll": [[t, v], ...]},
     "fast": {"allowed": bool, "hz": 50, "raised": [...], "skipped": [...], "bytes_s": 1500}}

Reading is passive. `fast` is the only thing that reaches the vehicle:
MAV_CMD_SET_MESSAGE_INTERVAL for the plotted messages, under exactly the
Config > Tuning rule (app/events/tuning_events.py): only a session that may
fly and is not taken over, re-checked every second, put back when the page
stops plotting them, closes, or loses the right. The rates are shared with
the Tuning chart through tuning_stream.MessageRates, so two pages raising
the same message count once and restore once.

Stops when the page says off, when nobody renewed the lease for LEASE_S,
when the socket disconnects (drop_sid, from server.py) or when the link drops.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.auth.socket_guard import require_session_view
from app.events.tuning_events import may_raise_rates
from app.telemetry import inspector as ins
from app.telemetry import tuning_stream as ts

logger = logging.getLogger("verocore.inspector_events")

LEASE_S = 20.0
EMIT_S = 0.5
RECHECK_S = 1.0

# sid -> {"task", "until", "tel", "open": [..], "plot": [..], "fast": bool}
_feeds: dict[str, dict] = {}


async def drop_sid(sid: str) -> None:
    feed = _feeds.pop(sid, None)
    if feed is not None and feed.get("task") is not None:
        feed["until"] = 0.0
        feed["task"].cancel()


def _register_ids(names) -> None:
    """MessageRates looks message ids up in tuning_stream.MSG_ID; add the
    plotted ones (from pymavlink) so the shared helper can raise them."""
    for n in names:
        info = ins.message_info(n)
        if info is not None:
            ts.MSG_ID.setdefault(n, info[0])


def _clean_request(d: dict) -> dict:
    open_keys = [k for k in (d.get("open") or []) if ins.parse_key(k) is not None][: ins.MAX_OPEN] \
        if isinstance(d.get("open"), list) else []
    plot = d.get("plot") if isinstance(d.get("plot"), list) else []
    return {"open": open_keys, "plot": plot[: ins.MAX_PLOT * 2], "fast": bool(d.get("fast", False))}


async def run_feed(sid: str, tel, emit, feeds: dict | None = None,
                   rates: "ts.MessageRates | None" = None, still_may_raise=None) -> None:
    """Read every message off `tel` and emit a summary every EMIT_S until the
    feed entry for `sid` goes away, its lease runs out or the link drops.
    `still_may_raise()` decides, about once a second, whether this socket
    may speed up its plotted messages; without it nothing is ever raised."""
    feeds = _feeds if feeds is None else feeds
    rates = rates or ts.MessageRates.for_tel(tel)
    hz = ts.stream_hz(tel)
    radio = hz == ts.RADIO_HZ
    insp = ins.Inspector()
    stop = asyncio.Event()
    raised: list[str] = []
    fast_status = {"allowed": False, "hz": 0, "raised": [], "skipped": [], "bytes_s": 0}

    async def _listen():
        try:
            async for msg in tel._drone.mavlink_direct.message(""):
                if stop.is_set():
                    return
                insp.feed(getattr(msg, "message_name", ""), int(getattr(msg, "system_id", 0) or 0),
                          int(getattr(msg, "component_id", 0) or 0), msg.fields_json)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"inspector stream ended: {e}")

    async def _set_raised(want: list[str]) -> None:
        nonlocal raised
        drop = [n for n in raised if n not in want]
        add = [n for n in want if n not in raised]
        # Book-keep first: if the feed is cancelled while a shielded raise
        # is still running, `finally` releases it once the raise is done
        # (MessageRates' lock runs them in order).
        raised = [n for n in raised if n in want] + add
        if drop:
            await asyncio.shield(rates.release(tel, drop))
        if add:
            _register_ids(add)
            await asyncio.shield(rates.acquire(tel, add, hz))

    reader = asyncio.create_task(_listen(), name="inspector_all")
    try:
        next_emit = 0.0
        next_check = 0.0
        allowed = False
        while True:
            feed = feeds.get(sid)
            if feed is None or feed.get("tel") is not tel or time.monotonic() > feed["until"] \
                    or not tel.is_connected:
                return
            accepted = insp.set_plot(feed.get("plot") or [])
            now = time.monotonic()
            if now >= next_emit:
                next_emit = now + EMIT_S
                await emit({**insp.summary(feed.get("open") or []), "fast": fast_status,
                            "link": "radio" if radio else "local"})
            if now >= next_check:
                next_check = now + RECHECK_S
                allowed = bool(still_may_raise and still_may_raise())
                want: list[str] = []
                skipped: list[str] = []
                bytes_s = 0
                if allowed and feed.get("fast"):
                    names = [ins.parse_key(k)[0] for k, _f in accepted]
                    want, skipped, bytes_s = ins.raise_plan(names, hz, radio)
                if want != raised:
                    await _set_raised(want)
                fast_status = {"allowed": allowed, "hz": hz if raised else 0, "raised": list(raised),
                               "skipped": skipped, "bytes_s": bytes_s if raised else 0}
            await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        pass
    finally:
        stop.set()
        reader.cancel()
        if raised:
            try:
                await asyncio.shield(rates.release(tel, raised))
            except (asyncio.CancelledError, Exception) as e:
                logger.debug(f"inspector: rate restore interrupted ({e})")
            raised = []
        cur = feeds.get(sid)
        if cur is not None and cur.get("task") is asyncio.current_task():
            feeds.pop(sid, None)


def register_inspector_events(sio, session_manager) -> None:

    async def _emit_to(sid, payload):
        await sio.emit("inspector_data", payload, to=sid)

    @sio.on("inspector_stream")
    async def on_inspector_stream(sid, data=None):
        if not await require_session_view(sid, "inspector_stream"): return
        d = data if isinstance(data, dict) else {}
        if not bool(d.get("on", True)):
            await drop_sid(sid)
            return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("inspector_data", {"error": "No drone connected"}, to=sid)
            return
        req = _clean_request(d)
        cur = _feeds.get(sid)
        if cur is not None and cur.get("task") is not None and not cur["task"].done() and cur.get("tel") is tel:
            cur.update(req, until=time.monotonic() + LEASE_S)
            return
        if cur is not None and cur.get("task") is not None:
            cur["task"].cancel()
        feed = {**req, "until": time.monotonic() + LEASE_S, "tel": tel, "task": None}
        _feeds[sid] = feed
        feed["task"] = asyncio.create_task(
            run_feed(sid, tel, lambda p: _emit_to(sid, p),
                     still_may_raise=lambda: may_raise_rates(session_manager.get_by_socket(sid))),
            name=f"inspector_{sid[:6]}")

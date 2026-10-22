"""Live readings for Config > Sensors and Config > Radio & RC, per session.

One socket event, `config_live` {on: bool}: SESSION_VIEW. While on, the
session's own MAVSDK link is read for a handful of raw MAVLink messages that
MAVSDK's telemetry plugin parses and drops (RC_CHANNELS, SCALED_PRESSURE,
ESTIMATOR_STATUS, VIBRATION, SYS_STATUS, and HIGHRES_IMU / SCALED_IMU when
the aircraft streams them), and the latest of each is pushed back as
`config_live_data` to the asking socket only, at most 4 times a second.

Passive: nothing is sent to the aircraft. It reads the session's own link,
so it is safe for customers, unlike the server-wide RC monitor on udp/14550
(start_rc_monitor, staff only), which sees whichever aircraft streams to a
shared server port.

The page renews the request every few seconds; a feed nobody renewed for
LEASE_S stops by itself, so a closed tab cannot leave streams open.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from app.auth.socket_guard import require_session_view

logger = logging.getLogger("verocore.config_live")

LEASE_S = 20.0
EMIT_INTERVAL_S = 0.25

# Message -> the fields the page uses. Anything else in the message is dropped.
MESSAGES: dict[str, tuple[str, ...]] = {
    "RC_CHANNELS": ("chancount", "rssi", *(f"chan{i}_raw" for i in range(1, 19))),
    "SCALED_PRESSURE": ("press_abs", "temperature"),
    "ESTIMATOR_STATUS": ("flags", "vel_ratio", "pos_horiz_ratio", "pos_vert_ratio", "mag_ratio",
                         "hagl_ratio", "tas_ratio", "pos_horiz_accuracy", "pos_vert_accuracy"),
    "VIBRATION": ("vibration_x", "vibration_y", "vibration_z", "clipping_0", "clipping_1", "clipping_2"),
    "SYS_STATUS": ("onboard_control_sensors_present", "onboard_control_sensors_enabled",
                   "onboard_control_sensors_health", "load"),
    "HIGHRES_IMU": ("xacc", "yacc", "zacc", "xgyro", "ygyro", "zgyro", "xmag", "ymag", "zmag",
                    "abs_pressure", "temperature"),
    "SCALED_IMU": ("xacc", "yacc", "zacc", "xgyro", "ygyro", "zgyro", "xmag", "ymag", "zmag"),
}


def pick_fields(name: str, fields_json: str) -> dict | None:
    """The fields of one message the page needs, or None if unreadable."""
    keep = MESSAGES.get(name)
    if keep is None:
        return None
    try:
        raw = json.loads(fields_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    out = {}
    for k in keep:
        v = raw.get(k)
        if isinstance(v, (int, float)) and v == v and v not in (float("inf"), float("-inf")):
            out[k] = v
    return out


def register_config_live_events(sio, session_manager) -> None:
    # sid -> {"task": Task, "until": monotonic deadline}
    feeds: dict[str, dict] = {}

    async def _listen(tel, name: str, latest: dict, stop: asyncio.Event):
        try:
            async for msg in tel._drone.mavlink_direct.message(name):
                if stop.is_set():
                    return
                # The autopilot only: a gimbal or companion with its own
                # SYS_STATUS must not overwrite the flight controller's.
                if int(getattr(msg, "component_id", 1) or 1) != 1:
                    continue
                fields = pick_fields(name, msg.fields_json)
                if fields is not None:
                    latest[name] = {**fields, "_t": time.time()}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"config_live {name} stream ended: {e}")

    async def _run(sid: str, tel):
        latest: dict = {}
        stop = asyncio.Event()
        readers = [asyncio.create_task(_listen(tel, n, latest, stop), name=f"cfglive_{n}") for n in MESSAGES]
        try:
            while True:
                feed = feeds.get(sid)
                if feed is None or time.monotonic() > feed["until"] or not tel.is_connected:
                    return
                if latest:
                    now = time.time()
                    payload = {k: {**v, "age": round(now - v["_t"], 2)} for k, v in latest.items()}
                    for v in payload.values():
                        v.pop("_t", None)
                    await sio.emit("config_live_data", payload, to=sid)
                await asyncio.sleep(EMIT_INTERVAL_S)
        except asyncio.CancelledError:
            pass
        finally:
            stop.set()
            for r in readers:
                r.cancel()
            cur = feeds.get(sid)
            if cur is not None and cur.get("task") is asyncio.current_task():
                feeds.pop(sid, None)

    @sio.on("config_live")
    async def on_config_live(sid, data=None):
        if not await require_session_view(sid, "config_live"): return
        on = bool((data or {}).get("on", True)) if isinstance(data, dict) else True
        cur = feeds.get(sid)
        if not on:
            if cur is not None:
                cur["until"] = 0.0
                cur["task"].cancel()
                feeds.pop(sid, None)
            return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("config_live_data", {"error": "No drone connected"}, to=sid)
            return
        if cur is not None and not cur["task"].done() and cur.get("tel") is tel:
            cur["until"] = time.monotonic() + LEASE_S
            return
        if cur is not None:
            cur["task"].cancel()
        feeds[sid] = {"until": time.monotonic() + LEASE_S, "tel": tel, "task": None}
        feeds[sid]["task"] = asyncio.create_task(_run(sid, tel), name=f"cfglive_{sid[:6]}")

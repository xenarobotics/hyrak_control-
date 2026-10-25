"""Config > GPS & RTK and Config > Traffic & ID: NTRIP corrections and the
live GNSS / ADS-B / Remote ID readings.

NTRIP (app/telemetry/ntrip.py):
  `ntrip_start` {host, port, mountpoint, username, password, tls, send_gga}
      SESSION_COMMAND with drone `fly`: corrections go down to the aircraft,
      which is a command. One client per session, replacing any previous.
      The caster credentials are held in memory by that client only, for
      this session, and never logged or echoed back.
  `ntrip_stop`  SESSION_VIEW: stopping your own session's corrections.
  `ntrip_status` SESSION_VIEW: the current state, as `ntrip_state`.
  Pushed `ntrip_state` {state, error, host, port, mountpoint, bytes_in,
      frames, messages_sent, dropped, types, ...} to the session's socket.
  The client stops by itself when the session ends, its telemetry link drops
  or is replaced, or the session loses the right to fly.

  OUTBOUND CONNECTIONS. The server connects to a host the user typed, so a
  customer's caster must resolve to a public address: loopback, private,
  link-local and reserved ranges are refused (checked again at every
  connect, so a DNS answer that changes cannot reach the server's own
  network). Staff may use a base station on a private network.

`setup_live` {on}: SESSION_VIEW, a lease like config_live: passive reads of
GPS_RAW_INT, GPS2_RAW, GPS_RTK, GPS2_RTK, ADSB_VEHICLE (a list, by ICAO
address, dropped after 60 s unheard) and OPEN_DRONE_ID_ARM_STATUS from the
session's own link, pushed as `setup_live_data` at most 2 times a second.
Nothing is sent to the aircraft.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
import time

from app.auth.socket_guard import (
    _is_staff_session, require_session_fly, require_session_view, session_may_fly,
)
from app.telemetry import ntrip

logger = logging.getLogger("verocore.gps_events")

LEASE_S = 20.0
EMIT_INTERVAL_S = 0.5
ADSB_FORGET_S = 60.0
ADSB_MAX = 50
WATCH_S = 1.0

LIVE_MESSAGES: dict[str, tuple[str, ...]] = {
    "GPS_RAW_INT": ("fix_type", "lat", "lon", "alt", "eph", "epv", "vel", "cog", "satellites_visible",
                    "h_acc", "v_acc", "vel_acc", "hdg_acc", "yaw"),
    "GPS2_RAW": ("fix_type", "lat", "lon", "alt", "eph", "epv", "vel", "cog", "satellites_visible",
                 "dgps_numch", "dgps_age", "yaw", "h_acc", "v_acc"),
    "GPS_RTK": ("rtk_receiver_id", "wn", "rtk_health", "rtk_rate", "nsats", "baseline_coords_type",
                "baseline_a_mm", "baseline_b_mm", "baseline_c_mm", "accuracy", "iar_num_hypotheses"),
    "GPS2_RTK": ("rtk_receiver_id", "wn", "rtk_health", "rtk_rate", "nsats", "baseline_coords_type",
                 "baseline_a_mm", "baseline_b_mm", "baseline_c_mm", "accuracy", "iar_num_hypotheses"),
    "OPEN_DRONE_ID_ARM_STATUS": ("status", "error"),
}
ADSB_FIELDS = ("ICAO_address", "lat", "lon", "altitude_type", "altitude", "heading", "hor_velocity",
               "ver_velocity", "callsign", "emitter_type", "tslc", "flags", "squawk")


def _clean(fields: dict, keep: tuple[str, ...]) -> dict:
    out = {}
    for k in keep:
        v = fields.get(k)
        if isinstance(v, bool):
            v = int(v)
        if isinstance(v, (int, float)):
            if v == v and v not in (float("inf"), float("-inf")):
                out[k] = v
        elif isinstance(v, str):
            out[k] = v.replace("\x00", "").strip()[:64]
        elif isinstance(v, list) and all(isinstance(x, int) for x in v):
            # char[] arrays may arrive as lists of codes
            out[k] = "".join(chr(x) for x in v if 32 <= x < 127).strip()[:64]
    return out


def pick(name: str, fields_json: str) -> dict | None:
    try:
        raw = json.loads(fields_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    if name == "ADSB_VEHICLE":
        return _clean(raw, ADSB_FIELDS)
    keep = LIVE_MESSAGES.get(name)
    return None if keep is None else _clean(raw, keep)


def _public(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # Unwrap the forms that smuggle an internal IPv4 address inside IPv6
    # (::ffff:10.0.0.1, 64:ff9b::a00:1, 6to4) and judge that. Local-use
    # NAT64, Teredo and the deprecated IPv4-compatible ::/96 are refused
    # outright: no public caster lives there.
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped is not None:
            a = a.ipv4_mapped
        elif a in ipaddress.ip_network("64:ff9b::/96"):
            a = ipaddress.IPv4Address(int(a) & 0xFFFFFFFF)
        elif a in ipaddress.ip_network("64:ff9b:1::/48") or a in ipaddress.ip_network("::/96") \
                or a.teredo is not None:
            return False
        elif a.sixtofour is not None:
            a = a.sixtofour
    return a.is_global and not (a.is_multicast or a.is_reserved or a.is_link_local or a.is_loopback
                                or a.is_private or a.is_unspecified or getattr(a, "is_site_local", False))


async def resolve_checked(host: str, port: int, allow_private: bool) -> str:
    """One address for `host`, refused unless public (or allow_private)."""
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), timeout=8.0)
    except (OSError, asyncio.TimeoutError):
        raise ntrip.NtripError("Caster host name not found") from None
    addrs = [i[4][0] for i in infos]
    if not addrs:
        raise ntrip.NtripError("Caster host name not found")
    if not allow_private:
        bad = [a for a in addrs if not _public(a)]
        if bad:
            raise ntrip.NtripError("That caster address is on a private network, which HYRAK's cloud cannot reach. "
                                   "Use the caster's public host name")
    return addrs[0]


def checked_connector(allow_private: bool):
    async def _connect(host: str, port: int, **kw):
        ip = await resolve_checked(host, port, allow_private)
        if kw.get("ssl") is not None:
            kw["server_hostname"] = host
        return await asyncio.open_connection(ip, port, **kw)
    return _connect


def register_gps_events(sio, session_manager) -> None:
    # session_id -> {"client": NtripClient, "tel": tel, "watch": Task}
    clients: dict[str, dict] = {}
    # sid -> {"task": Task, "until": float, "tel": tel}
    feeds: dict[str, dict] = {}

    def _emit_state(session_id: str, state: dict) -> None:
        s = session_manager.get(session_id)
        if s is None or not getattr(s, "socket_id", None):
            return
        asyncio.ensure_future(sio.emit("ntrip_state", state, to=s.socket_id))

    async def _stop(session_id: str, reason: str) -> None:
        entry = clients.pop(session_id, None)
        if entry is None:
            return
        w = entry.get("watch")
        if w is not None and w is not asyncio.current_task():
            w.cancel()
        await entry["client"].stop(reason)
        logger.info(f"NTRIP stopped for {session_id[:8]}: {reason or 'by the user'}")

    async def _watch(session_id: str, tel, client) -> None:
        """Stop corrections the moment the session, its link or its right to
        fly goes away."""
        try:
            while True:
                await asyncio.sleep(WATCH_S)
                entry = clients.get(session_id)
                if entry is None or entry["client"] is not client:
                    return
                s = session_manager.get(session_id)
                reason = None
                if s is None:
                    reason = "The session ended"
                elif session_manager.get_telemetry(session_id) is not tel or not getattr(tel, "is_connected", False):
                    reason = "The drone's link dropped"
                elif not session_may_fly(s) or getattr(s, "drone_fly", None) is False:
                    reason = "This session can no longer command the drone"
                elif not client.running and client.state == "error":
                    return              # stays visible with its error until stopped or restarted
                if reason:
                    await _stop(session_id, reason)
                    return
        except asyncio.CancelledError:
            pass

    @sio.on("ntrip_start")
    async def on_ntrip_start(sid, data=None):
        if not await require_session_fly(sid, "ntrip_start", {"action": "ntrip_start"}): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("ntrip_state", {"state": "error", "error": "No drone connected"}, to=sid)
            return
        try:
            cfg = ntrip.validate_config(data or {})
        except ValueError as e:
            await sio.emit("ntrip_state", {"state": "error", "error": str(e)}, to=sid)
            return
        await _stop(session.session_id, "Replaced by new caster settings")
        sid_session = session.session_id

        async def _send(fields: dict) -> None:
            await ntrip.send_rtcm(tel, fields)

        client = ntrip.NtripClient(
            cfg, _send,
            position=lambda: ntrip.vehicle_position(tel),
            on_state=lambda st: _emit_state(sid_session, st),
            connect=checked_connector(_is_staff_session(session)),
        )
        clients[sid_session] = {"client": client, "tel": tel, "watch": None}
        client.start()
        clients[sid_session]["watch"] = asyncio.create_task(_watch(sid_session, tel, client), name="ntrip_watch")
        logger.info(f"NTRIP start for {sid_session[:8]}: {cfg.host}:{cfg.port}/{cfg.mountpoint}"
                    f"{' (tls)' if cfg.tls else ''}")

    @sio.on("ntrip_stop")
    async def on_ntrip_stop(sid, data=None):
        if not await require_session_view(sid, "ntrip_stop"): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        if session.session_id in clients:
            await _stop(session.session_id, "")
        else:
            await sio.emit("ntrip_state", {"state": "idle"}, to=sid)

    @sio.on("ntrip_status")
    async def on_ntrip_status(sid, data=None):
        if not await require_session_view(sid, "ntrip_status"): return
        session = session_manager.get_by_socket(sid)
        entry = clients.get(session.session_id) if session else None
        await sio.emit("ntrip_state", entry["client"].status() if entry else {"state": "idle"}, to=sid)

    # ── live readings ───────────────────────────────────────────────────

    async def _listen(tel, name: str, latest: dict, adsb: dict, stop: asyncio.Event):
        try:
            async for msg in tel._drone.mavlink_direct.message(name):
                if stop.is_set():
                    return
                fields = pick(name, getattr(msg, "fields_json", ""))
                if not fields:
                    continue
                now = time.time()
                if name == "ADSB_VEHICLE":
                    icao = fields.get("ICAO_address")
                    if icao is None:
                        continue
                    adsb[int(icao)] = {**fields, "_t": now}
                    if len(adsb) > ADSB_MAX:
                        oldest = min(adsb, key=lambda k: adsb[k]["_t"])
                        adsb.pop(oldest, None)
                else:
                    if name.startswith("GPS") and int(getattr(msg, "component_id", 1) or 1) != 1:
                        continue
                    latest[name] = {**fields, "_t": now,
                                    "_comp": int(getattr(msg, "component_id", 0) or 0)}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"setup_live {name} stream ended: {e}")

    async def _run(sid: str, tel):
        latest: dict = {}
        adsb: dict = {}
        stop = asyncio.Event()
        names = [*LIVE_MESSAGES, "ADSB_VEHICLE"]
        readers = [asyncio.create_task(_listen(tel, n, latest, adsb, stop), name=f"setuplive_{n}") for n in names]
        try:
            while True:
                feed = feeds.get(sid)
                if feed is None or time.monotonic() > feed["until"] or not tel.is_connected:
                    return
                now = time.time()
                for k in [k for k, v in adsb.items() if now - v["_t"] > ADSB_FORGET_S]:
                    adsb.pop(k, None)
                payload: dict = {}
                for k, v in latest.items():
                    payload[k] = {kk: vv for kk, vv in v.items() if not kk.startswith("_")}
                    payload[k]["age"] = round(now - v["_t"], 1)
                    if k == "OPEN_DRONE_ID_ARM_STATUS":
                        payload[k]["component"] = v.get("_comp")
                payload["ADSB_VEHICLE"] = [
                    {**{kk: vv for kk, vv in v.items() if not kk.startswith("_")}, "age": round(now - v["_t"], 1)}
                    for v in sorted(adsb.values(), key=lambda x: -x["_t"])
                ]
                await sio.emit("setup_live_data", payload, to=sid)
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

    @sio.on("setup_live")
    async def on_setup_live(sid, data=None):
        if not await require_session_view(sid, "setup_live"): return
        on = bool((data or {}).get("on", True)) if isinstance(data, dict) else True
        cur = feeds.get(sid)
        if not on:
            if cur is not None:
                cur["until"] = 0.0
                if cur.get("task") is not None:
                    cur["task"].cancel()
                feeds.pop(sid, None)
            return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("setup_live_data", {"error": "No drone connected"}, to=sid)
            return
        if cur is not None and cur.get("task") is not None and not cur["task"].done() and cur.get("tel") is tel:
            cur["until"] = time.monotonic() + LEASE_S
            return
        if cur is not None and cur.get("task") is not None:
            cur["task"].cancel()
        feeds[sid] = {"until": time.monotonic() + LEASE_S, "tel": tel, "task": None}
        feeds[sid]["task"] = asyncio.create_task(_run(sid, tel), name=f"setuplive_{sid[:6]}")

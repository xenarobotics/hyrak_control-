"""Setpoint vs response samples for Config > Tuning's live chart.

QGroundControl's PID Tuning page plots each controller's setpoint against
what the aircraft actually did, so the pilot can see overshoot and
oscillation while changing gains. This module is the data side of that:

- which MAVLink messages each loop needs (rate and attitude loops:
  ATTITUDE + ATTITUDE_TARGET; velocity and position loops:
  LOCAL_POSITION_NED + POSITION_TARGET_LOCAL_NED),
- parsing them into compact rows on the flight controller's own clock
  (time_boot_ms), so setpoint and response line up exactly,
- batching rows into packets of about ten per socket emit,
- raising those messages' stream rates only while someone is watching and
  putting the previous rates back afterwards (MessageRates).

All four messages are read through mavlink_direct rather than MAVSDK's
telemetry plugin: MAVSDK has no plugin for ATTITUDE_TARGET or
POSITION_TARGET_LOCAL_NED, and reading measured and setpoint the same way
keeps both on the autopilot's timestamp instead of arrival time.

Nothing here commands the vehicle. MAV_CMD_SET_MESSAGE_INTERVAL and
MAV_CMD_GET_MESSAGE_INTERVAL only configure what the autopilot streams.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import weakref

logger = logging.getLogger("verocore.tuning_stream")

MSG_ID = {
    "ATTITUDE": 30,
    "LOCAL_POSITION_NED": 32,
    "ATTITUDE_TARGET": 83,
    "POSITION_TARGET_LOCAL_NED": 85,
}

# Loop -> (measured message, setpoint message).
LOOPS: dict[str, tuple[str, str]] = {
    "rate": ("ATTITUDE", "ATTITUDE_TARGET"),
    "attitude": ("ATTITUDE", "ATTITUDE_TARGET"),
    "velocity": ("LOCAL_POSITION_NED", "POSITION_TARGET_LOCAL_NED"),
    "position": ("LOCAL_POSITION_NED", "POSITION_TARGET_LOCAL_NED"),
}

# Short keys the page reads. Row layouts:
#   att / att_sp: [t_s, roll_deg, pitch_deg, yaw_deg, rollrate_dps, pitchrate_dps, yawrate_dps]
#   pos / pos_sp: [t_s, x_m, y_m, z_m, vx_ms, vy_ms, vz_ms]          (NED)
KEY = {
    "ATTITUDE": "att",
    "ATTITUDE_TARGET": "att_sp",
    "LOCAL_POSITION_NED": "pos",
    "POSITION_TARGET_LOCAL_NED": "pos_sp",
}

#: A telemetry radio is half-duplex and shares its slots with the uplink;
#: USB / UDP links have room to spare.
RADIO_HZ = 10.0
LOCAL_HZ = 50.0

BATCH_ROWS = 10        # rows per emit
BATCH_MAX_WAIT_S = 0.25  # flush a short batch after this long anyway

# Wire size (payload + 12 B MAVLink v2 framing) for the link budget note.
FRAME_BYTES = {"ATTITUDE": 40, "ATTITUDE_TARGET": 49, "LOCAL_POSITION_NED": 40,
               "POSITION_TARGET_LOCAL_NED": 63}

MAV_CMD_SET_MESSAGE_INTERVAL = 511
MAV_CMD_GET_MESSAGE_INTERVAL = 510


def normalise_loop(loop) -> str:
    return loop if isinstance(loop, str) and loop in LOOPS else "rate"


def stream_hz(tel) -> float:
    """The rate to ask for on this link."""
    radio = getattr(tel, "link_is_radio", None)
    if radio is None:
        radio = (getattr(tel, "_link_kind", "") == "radio"
                 or str(getattr(tel, "_address", "")).startswith("serial://"))
    return RADIO_HZ if radio else LOCAL_HZ


def extra_bytes_s(loop: str, hz: float) -> int:
    return int(round(sum(FRAME_BYTES[m] for m in LOOPS[normalise_loop(loop)]) * hz))


# ── parsing ───────────────────────────────────────────────────────────────

def _num(v, scale: float = 1.0, nd: int = 4):
    """A finite float, rounded, or None. NaN / inf never reach the socket."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if not math.isfinite(f):
        return None
    return round(f * scale, nd)


def _t(raw: dict):
    ms = raw.get("time_boot_ms")
    if isinstance(ms, bool) or not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return None
    return round(float(ms) / 1000.0, 3)


def quat_to_euler(q) -> tuple[float, float, float] | None:
    """(roll, pitch, yaw) in radians from a w, x, y, z quaternion."""
    try:
        w, x, y, z = (float(a) for a in q)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(a) for a in (w, x, y, z)):
        return None
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-6:
        return None
    w, x, y, z = w / n, x / n, y / n, z / n
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return roll, pitch, yaw


_DEG = 180.0 / math.pi


def parse_row(name: str, fields_json: str) -> list | None:
    """One message as a chart row (see KEY for layouts), or None."""
    try:
        raw = json.loads(fields_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    t = _t(raw)
    if t is None:
        return None
    if name == "ATTITUDE":
        return [t, *(_num(raw.get(k), _DEG, 3) for k in
                     ("roll", "pitch", "yaw", "rollspeed", "pitchspeed", "yawspeed"))]
    if name == "ATTITUDE_TARGET":
        e = quat_to_euler(raw.get("q") or ())
        ang = [round(a * _DEG, 3) for a in e] if e else [None, None, None]
        # type_mask bit 7 = attitude ignored; bits 0-2 = body rates ignored.
        mask = raw.get("type_mask") or 0
        mask = int(mask) if isinstance(mask, (int, float)) and not isinstance(mask, bool) else 0
        if mask & 0x80:
            ang = [None, None, None]
        rates = [None if mask & (1 << i) else _num(raw.get(k), _DEG, 3)
                 for i, k in enumerate(("body_roll_rate", "body_pitch_rate", "body_yaw_rate"))]
        return [t, *ang, *rates]
    if name in ("LOCAL_POSITION_NED", "POSITION_TARGET_LOCAL_NED"):
        return [t, *(_num(raw.get(k)) for k in ("x", "y", "z", "vx", "vy", "vz"))]
    return None


# ── batching ──────────────────────────────────────────────────────────────

class Batcher:
    """Collects rows and says when a packet is due: BATCH_ROWS rows, or
    BATCH_MAX_WAIT_S since the oldest waiting row. take() hands out at most
    BATCH_ROWS rows, oldest first, so a backlog leaves as several packets."""

    def __init__(self, rows: int = BATCH_ROWS, max_wait_s: float = BATCH_MAX_WAIT_S):
        self.rows = rows
        self.max_wait_s = max_wait_s
        self._buf: list[tuple[str, list]] = []
        self._first = 0.0

    def add(self, key: str, row: list, now: float | None = None) -> None:
        if not self._buf:
            self._first = time.monotonic() if now is None else now
        self._buf.append((key, row))

    def due(self, now: float | None = None) -> bool:
        if not self._buf:
            return False
        now = time.monotonic() if now is None else now
        return len(self._buf) >= self.rows or now - self._first >= self.max_wait_s

    def take(self) -> dict[str, list]:
        head, self._buf = self._buf[:self.rows], self._buf[self.rows:]
        out: dict[str, list] = {}
        for key, row in head:
            out.setdefault(key, []).append(row)
        return out


# ── stream rates ──────────────────────────────────────────────────────────

def interval_fields(sysid: int, msg_id: int, interval_us: float, get: bool = False) -> dict:
    return {
        "target_system": int(sysid), "target_component": 1,
        "command": MAV_CMD_GET_MESSAGE_INTERVAL if get else MAV_CMD_SET_MESSAGE_INTERVAL,
        "confirmation": 0,
        "param1": float(msg_id), "param2": 0.0 if get else float(interval_us),
        "param3": 0.0, "param4": 0.0, "param5": 0.0, "param6": 0.0, "param7": 0.0,
    }


async def _send_command(tel, fields: dict) -> bool:
    try:
        from mavsdk.mavlink_direct import MavlinkMessage
        sysid = int(getattr(tel, "_target_sysid", 1) or 1)
        await asyncio.wait_for(
            tel._drone.mavlink_direct.send_message(
                MavlinkMessage("COMMAND_LONG", 0, 0, sysid, 1, json.dumps(fields))),
            timeout=2.0)
        return True
    except Exception as e:
        logger.debug(f"tuning stream: message interval command not sent ({e})")
        return False


async def query_interval(tel, msg_id: int, timeout: float = 1.5) -> float | None:
    """The autopilot's current interval for one message in microseconds
    (MESSAGE_INTERVAL reply to MAV_CMD_GET_MESSAGE_INTERVAL), or None if it
    did not answer. 0 = not streamed, -1 = disabled."""
    got: asyncio.Future = asyncio.get_running_loop().create_future()

    async def _listen():
        try:
            async for msg in tel._drone.mavlink_direct.message("MESSAGE_INTERVAL"):
                try:
                    f = json.loads(msg.fields_json)
                except (TypeError, ValueError):
                    continue
                if isinstance(f, dict) and int(f.get("message_id", -1)) == msg_id:
                    if not got.done():
                        got.set_result(float(f.get("interval_us", 0)))
                    return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"tuning stream: MESSAGE_INTERVAL listen ended ({e})")

    listener = asyncio.create_task(_listen())
    try:
        await asyncio.sleep(0)        # subscribe before asking
        sysid = int(getattr(tel, "_target_sysid", 1) or 1)
        if not await _send_command(tel, interval_fields(sysid, msg_id, 0, get=True)):
            return None
        return await asyncio.wait_for(got, timeout)
    except (asyncio.TimeoutError, TimeoutError):
        return None
    finally:
        listener.cancel()


class MessageRates:
    """Raised stream rates for one aircraft, shared by every socket watching it.

    The first watcher of a message asks for its current interval, then raises
    it (never lowers: a stream already faster is left alone). The last one to
    leave puts the interval it found back: the exact value when the autopilot
    answered, "not streamed" (-1) when it was off, and PX4's default (0) when
    it did not answer.
    """

    _per_tel: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()

    def __init__(self):
        self.lock = asyncio.Lock()
        # name -> {"count": int, "prior": float | None, "changed": bool}
        self.msgs: dict[str, dict] = {}

    @classmethod
    def for_tel(cls, tel) -> "MessageRates":
        try:
            r = cls._per_tel.get(tel)
            if r is None:
                r = cls._per_tel[tel] = cls()
            return r
        except TypeError:       # not weak-referenceable (a test stand-in)
            r = getattr(tel, "_tuning_rates", None)
            if r is None:
                r = cls()
                try:
                    tel._tuning_rates = r
                except Exception:
                    pass
            return r

    async def acquire(self, tel, names, hz: float) -> None:
        want_us = 1_000_000.0 / hz
        sysid = int(getattr(tel, "_target_sysid", 1) or 1)
        async with self.lock:
            for name in names:
                entry = self.msgs.get(name)
                if entry is not None and entry["count"] > 0:
                    entry["count"] += 1
                    continue
                prior = await query_interval(tel, MSG_ID[name])
                faster_already = prior is not None and 0 < prior <= want_us
                changed = False
                if not faster_already:
                    changed = await _send_command(tel, interval_fields(sysid, MSG_ID[name], want_us))
                self.msgs[name] = {"count": 1, "prior": prior, "changed": changed}

    async def release(self, tel, names) -> None:
        sysid = int(getattr(tel, "_target_sysid", 1) or 1)
        async with self.lock:
            for name in names:
                entry = self.msgs.get(name)
                if entry is None or entry["count"] <= 0:
                    continue
                entry["count"] -= 1
                if entry["count"] > 0:
                    continue
                self.msgs.pop(name, None)
                if not entry["changed"] or not getattr(tel, "is_connected", False):
                    continue
                prior = entry["prior"]
                if prior is None:
                    back = 0.0            # PX4: back to the mode's default rate
                elif prior <= 0:
                    back = -1.0           # it was not streamed: stop it again
                else:
                    back = float(prior)
                await _send_command(tel, interval_fields(sysid, MSG_ID[name], back))

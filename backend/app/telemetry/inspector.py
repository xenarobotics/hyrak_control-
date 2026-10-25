"""MAVLink Inspector data for Config > Analyze, as in QGroundControl's
Analyze > MAVLink Inspector.

Every message the vehicle link delivers (mavlink_direct subscribed with an
empty name = all messages) is counted per (name, system id, component id):
how many arrived, how fast they arrive now, and the latest values. The page
gets a summary of all of them about twice a second, the field values only
for the few messages it has opened, and every sample of up to MAX_PLOT
(message, field) pairs it plots.

This module is the pure part (stats, field cleaning, plot subscriptions,
message ids); app/events/inspector_events.py runs the per-socket feed.

Nothing here commands the vehicle. NaN and infinity become None, long
strings and arrays are cut, so a payload never breaks socket.io.
"""
from __future__ import annotations

import json
import math
import re
import time
from collections import deque

MAX_KEYS = 256          # distinct (name, sysid, compid) tracked per feed
MAX_OPEN = 12           # messages whose fields are sent at once
MAX_PLOT = 6            # plotted fields across messages
MAX_FIELDS = 96         # fields kept per message
MAX_ARRAY = 64          # array elements kept per field
MAX_STR = 120           # characters kept per string field
MAX_SAMPLES = 400       # plot samples per field per packet (a backlog cap)
RATE_WINDOW_S = 5.0     # arrival rate measured over this long
STALE_S = 5.0           # nothing for this long = rate 0

_FIELD_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]{0,63})(?:\[(\d{1,3})\])?$")
_KEY_RE = re.compile(r"^([A-Z0-9_]{1,64}):(\d{1,3}):(\d{1,3})$")


def msg_key(name: str, sysid: int, compid: int) -> str:
    return f"{name}:{int(sysid)}:{int(compid)}"


def parse_key(key) -> tuple[str, int, int] | None:
    if not isinstance(key, str):
        return None
    m = _KEY_RE.match(key)
    if not m:
        return None
    return m.group(1), int(m.group(2)), int(m.group(3))


def parse_field(field) -> tuple[str, int | None] | None:
    """'roll' -> ('roll', None); 'q[2]' -> ('q', 2); anything else None."""
    if not isinstance(field, str):
        return None
    m = _FIELD_RE.match(field)
    if not m:
        return None
    return m.group(1), (int(m.group(2)) if m.group(2) is not None else None)


# ── values ────────────────────────────────────────────────────────────────

def _finite(v):
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    return None


def clean_value(v):
    """A JSON-safe copy of one field value: finite numbers, short strings,
    short arrays. Anything else is dropped (None)."""
    if isinstance(v, (bool, int, float)):
        return _finite(v)
    if isinstance(v, str):
        return v[:MAX_STR]
    if isinstance(v, (list, tuple)):
        out = []
        for x in v[:MAX_ARRAY]:
            out.append(_finite(x) if isinstance(x, (bool, int, float)) else (x[:MAX_STR] if isinstance(x, str) else None))
        return out
    return None


def clean_fields(raw: dict) -> dict:
    out = {}
    for i, (k, v) in enumerate(raw.items()):
        if i >= MAX_FIELDS:
            break
        if isinstance(k, str):
            out[k[:64]] = clean_value(v)
    return out


def numeric_at(raw: dict, name: str, index: int | None):
    """The plotted number for one field (or array element), or None."""
    v = raw.get(name)
    if index is not None:
        if not isinstance(v, (list, tuple)) or index >= len(v):
            return None
        v = v[index]
    if isinstance(v, (bool, int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    return None


def load_fields(fields_json) -> dict | None:
    try:
        raw = json.loads(fields_json)
    except (TypeError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


# ── per-message statistics ────────────────────────────────────────────────

class MsgStats:
    __slots__ = ("name", "sysid", "compid", "count", "arrivals", "last", "fields")

    def __init__(self, name: str, sysid: int, compid: int):
        self.name, self.sysid, self.compid = name, sysid, compid
        self.count = 0
        self.arrivals: deque = deque(maxlen=128)
        self.last = 0.0
        self.fields: dict = {}

    def seen(self, raw: dict, now: float) -> None:
        self.count += 1
        self.arrivals.append(now)
        self.last = now
        self.fields = raw

    def hz(self, now: float) -> float:
        if now - self.last > STALE_S:
            return 0.0
        recent = [t for t in self.arrivals if now - t <= RATE_WINDOW_S]
        if len(recent) < 2:
            return 0.0
        span = recent[-1] - recent[0]
        if span <= 0:
            return 0.0
        return round((len(recent) - 1) / span, 2)


class Inspector:
    """All messages seen on one feed, and the samples of plotted fields."""

    def __init__(self, t0: float | None = None):
        self.t0 = time.monotonic() if t0 is None else t0
        self.stats: dict[str, MsgStats] = {}
        self.dropped = 0                  # messages past MAX_KEYS
        # (key, field) -> (name, index) for the subscribed plot pairs
        self.plot: dict[tuple[str, str], tuple[str, int | None]] = {}
        self.samples: dict[str, list] = {}

    def set_plot(self, pairs) -> list[tuple[str, str]]:
        """Replace the plotted pairs (list of {key, field}); returns what was
        accepted, at most MAX_PLOT."""
        want: dict[tuple[str, str], tuple[str, int | None]] = {}
        for p in pairs if isinstance(pairs, (list, tuple)) else ():
            if len(want) >= MAX_PLOT or not isinstance(p, dict):
                continue
            key, field = p.get("key"), p.get("field")
            pf = parse_field(field)
            if parse_key(key) is None or pf is None:
                continue
            want[(key, field)] = pf
        for gone in set(self.plot) - set(want):
            self.samples.pop(f"{gone[0]}|{gone[1]}", None)
        self.plot = want
        return list(want)

    def feed(self, name: str, sysid: int, compid: int, fields_json, now: float | None = None) -> None:
        raw = load_fields(fields_json)
        if raw is None or not isinstance(name, str) or not name:
            return
        now = time.monotonic() if now is None else now
        key = msg_key(name, sysid, compid)
        st = self.stats.get(key)
        if st is None:
            if len(self.stats) >= MAX_KEYS:
                self.dropped += 1
                return
            st = self.stats[key] = MsgStats(name, int(sysid), int(compid))
        st.seen(raw, now)
        if self.plot:
            t = round(now - self.t0, 3)
            for (k, field), (fname, idx) in self.plot.items():
                if k != key:
                    continue
                v = numeric_at(raw, fname, idx)
                if v is None:
                    continue
                buf = self.samples.setdefault(f"{k}|{field}", [])
                buf.append([t, round(v, 6)])
                if len(buf) > MAX_SAMPLES:
                    del buf[: len(buf) - MAX_SAMPLES]

    def summary(self, open_keys=(), now: float | None = None) -> dict:
        """One packet: every message's counters, fields of the opened ones,
        and the plot samples gathered since the last packet."""
        now = time.monotonic() if now is None else now
        opened = set(k for k in open_keys if isinstance(k, str)) if open_keys else set()
        msgs = []
        for key, st in sorted(self.stats.items(), key=lambda kv: (kv[1].name, kv[1].sysid, kv[1].compid)):
            row = {"key": key, "name": st.name, "sys": st.sysid, "comp": st.compid,
                   "n": st.count, "hz": st.hz(now), "age": round(now - st.last, 1)}
            if key in opened:
                row["fields"] = clean_fields(st.fields)
            msgs.append(row)
        plot, self.samples = self.samples, {}
        return {"t": round(now - self.t0, 3), "msgs": msgs, "plot": plot, "dropped": self.dropped}


# ── message ids, for raising a plotted message's rate ─────────────────────

_IDS: dict[str, tuple[int, int]] | None = None


def message_info(name: str) -> tuple[int, int] | None:
    """(message id, payload bytes) from pymavlink's development dialect (a
    superset of common, which PX4 speaks), or None for an unknown name."""
    global _IDS
    if _IDS is None:
        try:
            from pymavlink.dialects.v20 import development as dialect
        except Exception:      # pragma: no cover - older pymavlink
            from pymavlink.dialects.v20 import common as dialect
        _IDS = {}
        for mid, cls in dialect.mavlink_map.items():
            try:
                _IDS[cls.msgname] = (int(mid), int(cls.unpacker.size))
            except Exception:
                continue
    return _IDS.get(name) if isinstance(name, str) else None


#: Messages never sped up: link control, not data.
NO_RAISE = frozenset({"HEARTBEAT", "COMMAND_ACK", "COMMAND_LONG", "COMMAND_INT", "MESSAGE_INTERVAL",
                      "PARAM_VALUE", "STATUSTEXT", "SERIAL_CONTROL", "LOG_DATA", "LOG_ENTRY",
                      "MISSION_ITEM_INT", "MISSION_REQUEST_INT", "MISSION_COUNT", "MISSION_ACK",
                      "FILE_TRANSFER_PROTOCOL", "TIMESYNC", "PING", "SYSTEM_TIME"})

#: A half-duplex telemetry radio shares its slots with the uplink: the extra
#: traffic a faster plot may add there (the tuning chart's rate loop is
#: about 900 B/s). USB / UDP links are not limited here.
RADIO_BUDGET_BYTES_S = 1200


def raise_plan(names, hz: float, radio: bool) -> tuple[list[str], list[str], int]:
    """Which plotted messages to speed up to `hz`: (raise, skipped, bytes_s).
    Only the autopilot's data messages pymavlink knows; on a radio, only as
    many as fit RADIO_BUDGET_BYTES_S."""
    chosen, skipped, total = [], [], 0
    for n in sorted(set(n for n in names if isinstance(n, str))):
        info = message_info(n)
        if info is None or n in NO_RAISE:
            skipped.append(n)
            continue
        cost = int(round((info[1] + 12) * hz))
        if radio and total + cost > RADIO_BUDGET_BYTES_S:
            skipped.append(n)
            continue
        chosen.append(n)
        total += cost
    return chosen, skipped, total

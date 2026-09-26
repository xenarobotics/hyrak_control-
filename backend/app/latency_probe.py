"""Capture-to-reaction latency probe (opt-in).

Answers one question with real flight data: from the moment a camera frame
reaches the ground station, how long until the aircraft visibly does what
the app decided from it?

Off by default. Turn it on with LATENCY_PROBE=true in .env, or at runtime:

    curl -X POST localhost:8001/api/latency-probe -H 'content-type: application/json' -d '{"enabled": true}'

Every probed command writes one JSON line to .logs/latency_probe.jsonl and one
log line. GET /api/latency-probe/stats summarises the file (p50/p90/max per
stage, per path).

Stages, all on the ground station's monotonic clock:

    frame      the frame entered the vision pipeline (decoded, on the server)
    decided    the tracker/avoidance decision derived from it existed
    sent       the command left for MAVSDK
    acked      the command's call returned (avoidance: MAVLink COMMAND_ACK /
               mission upload done; trackers: setpoints are fire-and-forget)
    mode       telemetry first reported the commanded flight mode
    motion     telemetry first showed the aircraft moving differently
               (attitude, or velocity vector, departing from its value at send)

What it does NOT cover, so the numbers are read honestly:
  - the camera-to-ground leg (sensor exposure, air-unit encode, radio,
    depacketize, decode). Measure that separately, glass to glass, by filming
    a running clock through the feed.
  - telemetry downlink: "motion" is when the GROUND saw the reaction, so it
    includes the telemetry trip back. Its resolution is the telemetry rate
    (recorded in each line: attitude ~10 Hz and position ~4 Hz on UDP links,
    6/2 Hz on a serial radio).

Only command EDGES are probed (a tracker setpoint that changes by >= 0.5 m/s
or >= 15 deg/s, any avoidance intervention), one open probe per aircraft, so
a 10-30 Hz setpoint stream does not flood the file.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
import weakref
from pathlib import Path

logger = logging.getLogger("verocore.latency_probe")

_LOG_PATH = Path(__file__).resolve().parents[2] / ".logs" / "latency_probe.jsonl"
_WATCH_TIMEOUT_S = 5.0
_MIN_GAP_S = 2.0              # between probes on one aircraft
_ATT_DEG = 3.0                # roll/pitch departure counted as motion
_YAW_DEG = 5.0
_VEL_M_S = 0.4
_SETPOINT_EDGE_M_S = 0.5
_SETPOINT_EDGE_YAW = 15.0

_enabled: bool | None = None
# Keyed by the manager object itself (weakly), never by id(): ids are reused
# once an object is freed, which silently rate-limited a new aircraft.
_open: "weakref.WeakSet" = weakref.WeakSet()          # managers with a probe in flight
_last_probe_t: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_last_setpoint: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def enabled() -> bool:
    global _enabled
    if _enabled is None:
        try:
            from app.config import get_settings
            _enabled = bool(getattr(get_settings(), "latency_probe", False))
        except Exception:
            _enabled = False
    return _enabled


def set_enabled(on: bool) -> None:
    global _enabled
    _enabled = bool(on)
    logger.info(f"Latency probe {'ON' if on else 'OFF'} -> {_LOG_PATH}")


def _baseline(manager) -> dict:
    s = manager._snapshot
    a, v = s.attitude, s.velocity
    return {"roll": a.roll_deg, "pitch": a.pitch_deg, "yaw": a.yaw_deg,
            "vn": v.north_m_s, "ve": v.east_m_s, "vd": v.down_m_s,
            "mode": str(s.flight_mode.mode)}


def _moved(b: dict, now: dict) -> str | None:
    if abs(now["roll"] - b["roll"]) >= _ATT_DEG or abs(now["pitch"] - b["pitch"]) >= _ATT_DEG:
        return "attitude"
    dyaw = (now["yaw"] - b["yaw"] + 180.0) % 360.0 - 180.0
    if abs(dyaw) >= _YAW_DEG:
        return "yaw"
    dv = math.sqrt((now["vn"] - b["vn"]) ** 2 + (now["ve"] - b["ve"]) ** 2 + (now["vd"] - b["vd"]) ** 2)
    if dv >= _VEL_M_S:
        return "velocity"
    return None


def _rates(manager) -> dict:
    try:
        from app.config import get_settings
        cfg = get_settings()
        serial = "serial" in str(getattr(manager, "_address", "") or "")
        return {"attitude_hz": cfg.telemetry_rate_attitude_radio if serial else cfg.telemetry_rate_attitude_udp,
                "position_hz": cfg.telemetry_rate_position_radio if serial else cfg.telemetry_rate_position_udp}
    except Exception:
        return {}


def _ms(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else round((b - a) * 1000.0, 1)


async def _watch(manager, rec: dict, t: dict, want_mode: tuple[str, ...]) -> None:
    try:
        base = _baseline(manager)
        rec["mode_at_send"] = base["mode"]
        # A mode we are already in cannot confirm anything.
        want = tuple(m for m in want_mode if m != base["mode"])
        deadline = t["sent"] + _WATCH_TIMEOUT_S
        while time.monotonic() < deadline and (t.get("mode") is None and want or t.get("motion") is None):
            await asyncio.sleep(0.005)
            now = _baseline(manager)
            if want and t.get("mode") is None and now["mode"] in want:
                t["mode"] = time.monotonic()
            if t.get("motion") is None:
                sig = _moved(base, now)
                if sig:
                    t["motion"] = time.monotonic()
                    rec["motion_signal"] = sig
        f, d, s = t.get("frame"), t.get("decided"), t["sent"]
        rec.update({
            "frame_to_decision_ms": _ms(f, d),
            "decision_to_send_ms": _ms(d, s),
            "send_to_ack_ms": _ms(s, t.get("acked")),
            "send_to_mode_ms": _ms(s, t.get("mode")),
            "send_to_motion_ms": _ms(s, t.get("motion")),
            "frame_to_motion_ms": _ms(f, t.get("motion")),
            "frame_to_mode_ms": _ms(f, t.get("mode")),
            "timed_out": t.get("motion") is None and t.get("mode") is None,
            "telemetry_rates": _rates(manager),
        })
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_LOG_PATH, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        logger.info(
            f"LATENCY {rec['path']} {rec['command']}: frame->decision {rec['frame_to_decision_ms']} ms, "
            f"decision->send {rec['decision_to_send_ms']} ms, send->ack {rec['send_to_ack_ms']} ms, "
            f"send->mode {rec['send_to_mode_ms']} ms, send->motion {rec['send_to_motion_ms']} ms "
            f"({rec.get('motion_signal', '-')}), FRAME->MOTION {rec['frame_to_motion_ms']} ms")
    except Exception as e:
        logger.debug(f"latency probe watch failed: {e}")
    finally:
        _open.discard(manager)


def _may_open(manager) -> bool:
    now = time.monotonic()
    if manager in _open or now - _last_probe_t.get(manager, 0.0) < _MIN_GAP_S:
        return False
    if not getattr(getattr(manager, "_snapshot", None), "flight_mode", None):
        return False
    _open.add(manager)
    _last_probe_t[manager] = now
    return True


def note_setpoint(manager, cmd: dict, frame_t: float | None, decided_t: float | None) -> None:
    """Tracker path: call just before a velocity setpoint is sent."""
    if not enabled() or manager is None:
        return
    key = manager
    v = (float(cmd.get("forward_m_s", 0.0)), float(cmd.get("right_m_s", 0.0)),
         float(cmd.get("down_m_s", 0.0)), float(cmd.get("yaw_deg_s", 0.0)))
    prev = _last_setpoint.get(key, (0.0, 0.0, 0.0, 0.0))
    _last_setpoint[key] = v
    edge = max(abs(v[i] - prev[i]) for i in range(3)) >= _SETPOINT_EDGE_M_S or \
        abs(v[3] - prev[3]) >= _SETPOINT_EDGE_YAW
    if not edge or not bool(getattr(manager._snapshot.flight_mode, "is_in_air", False)):
        return
    if not _may_open(manager):
        return
    t = {"frame": frame_t, "decided": decided_t, "sent": time.monotonic()}
    rec = {"ts": time.time(), "path": "tracker", "command": "velocity",
           "setpoint": {"fwd": v[0], "right": v[1], "down": v[2], "yaw_dps": v[3]},
           "previous": {"fwd": prev[0], "right": prev[1], "down": prev[2], "yaw_dps": prev[3]}}
    asyncio.get_running_loop().create_task(_watch(manager, rec, t, ()))


_MODE_FOR = {"hold": ("HOLD",), "return": ("RETURN_TO_LAUNCH", "RETURN"),
             "reroute": ("MISSION",), "climb": ("MISSION",), "resumed": ("MISSION",),
             "avoid": ("OFFBOARD",), "resume": ("MISSION",)}


class AvoidanceProbe:
    """Avoidance path: open before executor.apply, close after it returns."""

    def __init__(self, manager, action: str, frame_t: float | None, decided_t: float | None):
        self.active = enabled() and manager is not None and action in _MODE_FOR and _may_open(manager)
        self.manager, self.action = manager, action
        self.t = {"frame": frame_t, "decided": decided_t, "sent": time.monotonic()}

    def done(self, did: bool, note: str) -> None:
        if not self.active:
            return
        if not did:
            _open.discard(self.manager)   # nothing was commanded: no probe
            return
        self.t["acked"] = time.monotonic()
        rec = {"ts": time.time(), "path": "avoidance", "command": self.action, "note": note}
        asyncio.get_running_loop().create_task(
            _watch(self.manager, rec, self.t, _MODE_FOR.get(self.action, ())))


def _pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))], 1)


def stats() -> dict:
    rows = []
    if _LOG_PATH.exists():
        for line in _LOG_PATH.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    out: dict = {"enabled": enabled(), "file": str(_LOG_PATH), "records": len(rows), "paths": {}}
    stages = ("frame_to_decision_ms", "decision_to_send_ms", "send_to_ack_ms",
              "send_to_mode_ms", "send_to_motion_ms", "frame_to_motion_ms", "frame_to_mode_ms")
    for path in sorted({r.get("path") for r in rows}):
        sub = [r for r in rows if r.get("path") == path]
        entry = {"n": len(sub), "timed_out": sum(1 for r in sub if r.get("timed_out"))}
        for st in stages:
            xs = [r[st] for r in sub if isinstance(r.get(st), (int, float))]
            if xs:
                entry[st] = {"n": len(xs), "p50": _pct(xs, 0.5), "p90": _pct(xs, 0.9),
                             "min": round(min(xs), 1), "max": round(max(xs), 1)}
        out["paths"][path] = entry
    return out


# ---- API -------------------------------------------------------------------
from fastapi import APIRouter, Header  # noqa: E402
from pydantic import BaseModel  # noqa: E402

router = APIRouter(prefix="/api/latency-probe", tags=["latency-probe"])


class _Toggle(BaseModel):
    enabled: bool


@router.get("")
async def probe_state() -> dict:
    return {"enabled": enabled(), "file": str(_LOG_PATH)}


@router.post("")
async def probe_toggle(body: _Toggle, x_auth_token: str = Header(None, alias="X-Auth-Token")) -> dict:
    from app.avoidance.routes import _auth
    _auth(x_auth_token)
    set_enabled(body.enabled)
    return {"enabled": enabled(), "file": str(_LOG_PATH)}


@router.get("/stats")
async def probe_stats() -> dict:
    return stats()

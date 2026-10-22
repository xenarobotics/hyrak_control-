"""PX4 parameter metadata for Config > Parameters: each parameter's firmware
default, units, range, enum values and bitmask bits.

The aircraft ships this itself (COMP_METADATA -> parameters.json.xz over
MAVLink FTP); MAVSDK's component_metadata plugin fetches and unpacks it.
That is the only source that matches the firmware actually flying, so a
"reset to default" is offered from it. The frontend falls back to a copy
bundled from one PX4 build (public/px4/param-meta.json) and says so.

compact() is also what builds that bundled copy, so both have one shape:

  {"version": str, "params": {NAME: {
      "g": group, "s": short description, "l": long description (trimmed),
      "t": "i" | "f", "d": default, "u": units, "min", "max", "inc", "dec",
      "v": [[value, label], ...], "b": [[bit, label], ...], "r": 1 if a reboot is needed}}}
"""
from __future__ import annotations

import asyncio
import json
import logging
import math

logger = logging.getLogger("verocore.param_meta")

MAX_JSON_CHARS = 16 * 1024 * 1024
LONG_DESC_MAX = 400
FETCH_TIMEOUT_S = 90.0

# Cached on the telemetry manager, tagged with its MAVSDK System object:
# a reconnect (a new System) must not inherit the last aircraft's metadata.
_ATTR = "_hyrak_param_meta"
_TASK_ATTR = "_hyrak_param_meta_task"


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return int(f) if f.is_integer() else f


def compact(raw: dict | str) -> dict:
    """PX4 parameters.json -> the compact shape above. Raises ValueError for
    something that is not PX4 parameter metadata."""
    if isinstance(raw, str):
        if len(raw) > MAX_JSON_CHARS:
            raise ValueError("parameter metadata is too large")
        raw = json.loads(raw)
    if not isinstance(raw, dict) or not isinstance(raw.get("parameters"), list):
        raise ValueError("not PX4 parameter metadata")
    out: dict[str, dict] = {}
    for p in raw["parameters"]:
        if not isinstance(p, dict):
            continue
        name = p.get("name")
        if not isinstance(name, str) or not name or len(name) > 16:
            continue
        m: dict = {
            "g": str(p.get("group", "") or "Other")[:48],
            "s": str(p.get("shortDesc", "") or "")[:200],
            "t": "f" if str(p.get("type", "")).lower().startswith("float") else "i",
        }
        long_desc = str(p.get("longDesc", "") or "").strip()
        if long_desc:
            m["l"] = long_desc[:LONG_DESC_MAX]
        for src, dst in (("default", "d"), ("min", "min"), ("max", "max"), ("increment", "inc")):
            v = _num(p.get(src))
            if v is not None:
                m[dst] = v
        dec = _num(p.get("decimalPlaces"))
        if isinstance(dec, int) and 0 <= dec <= 10:
            m["dec"] = dec
        units = p.get("units")
        if isinstance(units, str) and units:
            m["u"] = units[:16]
        values = p.get("values")
        if isinstance(values, list):
            vs = [[_num(v.get("value")), str(v.get("description", ""))[:80]]
                  for v in values if isinstance(v, dict) and _num(v.get("value")) is not None]
            if vs:
                m["v"] = vs
        bits = p.get("bitmask")
        if isinstance(bits, list):
            bs = [[int(b["index"]), str(b.get("description", ""))[:80]]
                  for b in bits if isinstance(b, dict) and isinstance(b.get("index"), int) and 0 <= b["index"] < 32]
            if bs:
                m["b"] = bs
        if p.get("rebootRequired"):
            m["r"] = 1
        out[name] = m
    if not out:
        raise ValueError("no parameters in the metadata")
    return {"version": str(raw.get("version", "")), "params": out}


async def _fetch(tel) -> dict:
    from mavsdk.component_metadata import MetadataType
    cm = tel._drone.component_metadata
    await asyncio.wait_for(cm.request_autopilot_component(), timeout=10.0)
    deadline = asyncio.get_running_loop().time() + FETCH_TIMEOUT_S
    last_err: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            data = await asyncio.wait_for(cm.get_metadata(1, MetadataType.PARAMETER), timeout=10.0)
            return compact(data.json_metadata)
        except ValueError:
            raise
        except Exception as e:      # NOT_AVAILABLE while the FTP transfer runs
            last_err = e
            await asyncio.sleep(1.0)
    raise TimeoutError(f"the drone did not send its parameter metadata ({last_err})")


async def for_link(tel) -> dict:
    """{"ok": True, "meta": {...}} or {"ok": False, "error": str}, cached per
    telemetry link; concurrent callers share one fetch."""
    hit = getattr(tel, _ATTR, None)
    if hit is not None and hit[0] is tel._drone:
        return hit[1]
    task = getattr(tel, _TASK_ATTR, None)
    if task is None or task.done():
        task = asyncio.create_task(_fetch(tel), name="param_metadata")
        setattr(tel, _TASK_ATTR, task)
    try:
        meta = await asyncio.shield(task)
        result = {"ok": True, "meta": meta}
        setattr(tel, _ATTR, (tel._drone, result))
        return result
    except Exception as e:
        logger.info(f"parameter metadata unavailable: {e}")
        return {"ok": False, "error": str(e) or e.__class__.__name__}
    finally:
        if task.done() and getattr(tel, _TASK_ATTR, None) is task:
            setattr(tel, _TASK_ATTR, None)


# ── Reset every parameter to the firmware default ──────────────────────────

MAV_CMD_PREFLIGHT_STORAGE = 245
RESET_CONFIRM = "RESET"


def reset_all_fields(target_sysid: int) -> dict:
    """PREFLIGHT_STORAGE param1 = 2: PX4 resets every parameter to its
    firmware default (calibration and SYS_AUTOSTART included; only the
    flight-time counters and the flight UUID survive), the same command
    QGroundControl's "Reset all to firmware's defaults" sends. PX4 refuses
    it while armed. A reboot is needed for most of it to take effect."""
    return {
        "target_system": int(target_sysid), "target_component": 1,
        "command": MAV_CMD_PREFLIGHT_STORAGE, "confirmation": 0,
        "param1": 2.0, "param2": 0.0, "param3": 0.0, "param4": 0.0,
        "param5": 0.0, "param6": 0.0, "param7": 0.0,
    }


async def handle_reset_all(tel, data: dict) -> dict:
    """drone_action `reset_params_default`: needs {"confirm": "RESET"} and a
    disarmed aircraft on the ground."""
    from app.telemetry import actuator_test
    action = "reset_params_default"
    if (data or {}).get("confirm") != RESET_CONFIRM:
        return {"action": action, "ok": False, "error": "Type RESET to confirm"}
    why = actuator_test.refusal(tel)
    if why:
        if why.startswith("Disarm first"):
            why = "Disarm first. Parameters are reset on the ground only"
        return {"action": action, "ok": False, "error": why}
    try:
        await actuator_test._send(tel, reset_all_fields(int(getattr(tel, "_target_sysid", 1) or 1)))
    except Exception as e:
        return {"action": action, "ok": False, "error": f"Could not send to the drone ({e})"}
    try:
        from app.telemetry import failsafe_check
        failsafe_check.forget(tel)
    except Exception:
        pass
    return {"action": action, "ok": True}

"""
What the flight controller says about itself, for Config > Vehicle.

AUTOPILOT_VERSION (through the MAVSDK Info plugin) carries the firmware
version and git hash, the board's vendor and product ids and the hardware
UID; the autopilot's HEARTBEAT says which flight stack it is. QGroundControl
shows the same facts on its Summary page.

Each part is read on its own: a board that answers the version request but
reports no product (most SITL builds) still gets its version shown, and a
part that times out is left out rather than failing the whole answer.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

# MAV_AUTOPILOT, the ones a ground station meets in practice.
AUTOPILOT_NAMES = {
    0: "Generic",
    3: "ArduPilot",
    4: "OpenPilot",
    8: "No autopilot",
    12: "PX4",
}

# MAV_TYPE, the vehicle classes PX4 and ArduPilot report.
VEHICLE_TYPE_NAMES = {
    1: "Fixed wing",
    2: "Quadrotor",
    3: "Coaxial",
    4: "Helicopter",
    10: "Ground rover",
    11: "Surface boat",
    12: "Submarine",
    13: "Hexarotor",
    14: "Octorotor",
    15: "Tricopter",
    19: "VTOL tailsitter (duo)",
    20: "VTOL tailsitter (quad)",
    21: "VTOL tiltrotor",
    22: "VTOL fixed rotor",
    23: "VTOL tailsitter",
    24: "VTOL tiltwing",
    29: "Dodecarotor",
}

# FIRMWARE_VERSION_TYPE as MAVSDK names it -> plain words.
_RELEASE_WORD = {
    "DEV": "development",
    "ALPHA": "alpha",
    "BETA": "beta",
    "RC": "release candidate",
    "RELEASE": "release",
}

_TIMEOUT_S = 3.0


def _clean(s: Any) -> str:
    """Printable characters only: PX4 pads strings and hashes with NULs."""
    return "".join(c for c in str(s or "") if c.isprintable()).strip()


def _git_hash(h: Any) -> str:
    """MAVSDK gives the 8-byte hash as hex text; all zeros means none."""
    h = _clean(h)
    return "" if not h.strip("0") else h[:16]


def version_dict(v: Any) -> dict:
    """MAVSDK Info.Version -> the fields the Vehicle page shows."""
    rtype = getattr(v, "flight_sw_version_type", None)
    rname = getattr(rtype, "name", str(rtype or "")).upper()
    for prefix in ("FLIGHT_SW_VERSION_TYPE_", "FLIGHTSWVERSIONTYPE_"):
        if rname.startswith(prefix):
            rname = rname[len(prefix):]
    major, minor, patch = (int(getattr(v, f"flight_sw_{p}", 0) or 0) for p in ("major", "minor", "patch"))
    os_v = tuple(int(getattr(v, f"os_sw_{p}", 0) or 0) for p in ("major", "minor", "patch"))
    return {
        "firmware": f"{major}.{minor}.{patch}" if (major or minor or patch) else "",
        "release": _RELEASE_WORD.get(rname, ""),
        "git_hash": _git_hash(getattr(v, "flight_sw_git_hash", "")),
        "os_version": ".".join(map(str, os_v)) if any(os_v) else "",
        "os_git_hash": _git_hash(getattr(v, "os_sw_git_hash", "")),
    }


def product_dict(p: Any) -> dict:
    vid = int(getattr(p, "vendor_id", 0) or 0)
    pid = int(getattr(p, "product_id", 0) or 0)
    return {
        "vendor_id": vid or None,
        "vendor_name": _clean(getattr(p, "vendor_name", "")),
        "product_id": pid or None,
        "product_name": _clean(getattr(p, "product_name", "")),
    }


def identification_dict(i: Any) -> dict:
    uid = _clean(getattr(i, "hardware_uid", ""))
    legacy = int(getattr(i, "legacy_uid", 0) or 0)
    return {"hardware_uid": uid if uid.strip("0") else (f"legacy-{legacy:x}" if legacy else "")}


async def _one(coro_fn, shape) -> Optional[dict]:
    try:
        return shape(await asyncio.wait_for(coro_fn(), timeout=_TIMEOUT_S))
    except Exception:
        return None


async def read_info(info_plugin: Any) -> dict:
    """Version, product and identity from the Info plugin, each part optional.
    `ok` is false only when the autopilot answered none of them."""
    version, product, ident = await asyncio.gather(
        _one(info_plugin.get_version, version_dict),
        _one(info_plugin.get_product, product_dict),
        _one(info_plugin.get_identification, identification_dict),
    )
    out: dict = {"ok": any(x is not None for x in (version, product, ident))}
    for part in (version, product, ident):
        if part:
            out.update(part)
    return out


def heartbeat_meta(fields: dict) -> dict:
    """The autopilot HEARTBEAT's `autopilot` and `type` fields, named."""
    ap = fields.get("autopilot")
    vt = fields.get("type")
    try:
        ap = int(ap)
    except (TypeError, ValueError):
        ap = None
    try:
        vt = int(vt)
    except (TypeError, ValueError):
        vt = None
    return {
        "autopilot": AUTOPILOT_NAMES.get(ap, f"Autopilot {ap}") if ap is not None else "",
        "vehicle_type": VEHICLE_TYPE_NAMES.get(vt, f"Type {vt}") if vt is not None else "",
        "mav_type": vt,
    }

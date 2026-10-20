"""
What can be fitted to a drone, and the check every attachment record
passes before it is stored (docs/ATTACHMENTS.md).

Pure: no database, no drone. The REST service turns AttachmentError into
a 400 bad_request with the plain reason; the rules validator and the
mission check use the same tables.

A record:

    {id, kind, name, icon, wiring, actions: [{id, label, value?, hazard}],
     limits: {min_alt_m, max_alt_m, people_check}, enabled}

Built-in kinds have fixed action ids and hazard flags (the table below);
labels and, for actuator wiring, values may be changed. A custom kind
names 2 to 4 states of its own, each with a value and a "can hurt
someone" flag (default yes).
"""
from __future__ import annotations

import math
import re
import secrets
from typing import Any, Dict, List, Optional

MAX_PER_DRONE = 8
MAX_NAME = 40
MAX_LABEL = 24
MAX_ALT_M = 500.0
ACTUATOR_OUTPUTS = (1, 2, 3, 4, 5, 6)
MAX_INSTANCE = 15
DEFAULT_LEVEL = 50.0           # sprayer "Spray" with no level given, percent

ACTUATOR, GRIPPER, WINCH = "actuator", "gripper", "winch"
WIRINGS = (ACTUATOR, GRIPPER, WINCH)

_ID = re.compile(r"^[a-z0-9]{8,16}$")
_ACTION_ID = re.compile(r"^[a-z0-9_]{1,24}$")

# Lucide icon names the frontend ships. Anything else is refused.
ICONS = (
    "package", "package-open", "hand", "grab", "anchor", "arrow-down-to-line",
    "lightbulb", "flashlight", "siren", "volume-2", "megaphone", "spray-can",
    "droplets", "plug", "zap", "box", "cog", "camera", "radio",
)


def _a(id_: str, label: str, value: float, hazard: bool, optional: bool = False) -> dict:
    return {"id": id_, "label": label, "value": value, "hazard": hazard, "optional": optional}


# kind -> name, icon, wiring options (first is the default), actions, the
# default minimum height. people_check defaults on when any action is a hazard.
KINDS: Dict[str, Dict[str, Any]] = {
    "release": {"name": "Drop hook", "icon": "package-open", "wirings": (ACTUATOR, GRIPPER),
                "actions": [_a("drop", "Drop", 1.0, True)], "min_alt_m": 2.0},
    "gripper": {"name": "Gripper", "icon": "hand", "wirings": (GRIPPER, ACTUATOR),
                "actions": [_a("open", "Open", 1.0, True), _a("close", "Close", -1.0, False)],
                "min_alt_m": 0.0},
    "winch": {"name": "Winch", "icon": "anchor", "wirings": (WINCH, ACTUATOR),
              "actions": [_a("lower", "Lower", 1.0, True), _a("raise", "Raise", -1.0, False),
                          _a("stop", "Stop", 0.0, False)], "min_alt_m": 0.0},
    "light": {"name": "Light", "icon": "lightbulb", "wirings": (ACTUATOR,),
              "actions": [_a("on", "On", 1.0, False), _a("off", "Off", -1.0, False),
                          _a("strobe", "Strobe", 0.0, False, optional=True)], "min_alt_m": 0.0},
    "speaker": {"name": "Speaker", "icon": "megaphone", "wirings": (ACTUATOR,),
                "actions": [_a("on", "On", 1.0, False), _a("off", "Off", -1.0, False)],
                "min_alt_m": 0.0},
    "sprayer": {"name": "Sprayer", "icon": "spray-can", "wirings": (ACTUATOR,),
                "actions": [_a("level", "Spray", 1.0, True), _a("off", "Off", -1.0, False)],
                "min_alt_m": 2.0},
    "custom": {"name": "Custom", "icon": "plug", "wirings": (ACTUATOR,), "actions": [],
               "min_alt_m": 0.0},
}
KIND_NAMES = tuple(KINDS)
CUSTOM_MIN_STATES, CUSTOM_MAX_STATES = 2, 4

# What each action does on gripper or winch wiring (MAVSDK plugin calls).
GRIPPER_OPS = {("release", "drop"): "release", ("gripper", "open"): "release",
               ("gripper", "close"): "grab"}
WINCH_OPS = {("winch", "lower"): "deliver", ("winch", "raise"): "retract",
             ("winch", "stop"): "hold"}


class AttachmentError(ValueError):
    """A record that cannot be saved; str(e) is the plain reason."""


def new_id() -> str:
    return secrets.token_hex(6)                  # 12 lowercase hex characters


def catalogue() -> dict:
    """GET /api/attachments/kinds: what the Add flow, the mission picker and
    the rules picker offer."""
    kinds = []
    for kind, k in KINDS.items():
        acts = [dict(a) for a in k["actions"]]
        kinds.append({
            "kind": kind, "name": k["name"], "icon": k["icon"], "wirings": list(k["wirings"]),
            "actions": acts, "min_alt_m": k["min_alt_m"],
            "people_check": any(a["hazard"] for a in acts) or kind == "custom",
        })
    return {"kinds": kinds, "icons": list(ICONS), "max_per_drone": MAX_PER_DRONE,
            "actuator_outputs": list(ACTUATOR_OUTPUTS),
            "custom_states": [CUSTOM_MIN_STATES, CUSTOM_MAX_STATES]}


def kind_action_ids(kind: str) -> Optional[set]:
    """The action ids a built-in kind has; None for custom (its own)."""
    k = KINDS.get(kind)
    if k is None or kind == "custom":
        return None
    return {a["id"] for a in k["actions"]}


def default_hazard(kind: str, action_id: str) -> bool:
    """Whether a kind's action can hurt someone, before a record exists
    (rules validation). Unknown and custom: yes."""
    k = KINDS.get(kind)
    for a in (k or {}).get("actions", []):
        if a["id"] == action_id:
            return bool(a["hazard"])
    return True


# ── validation ────────────────────────────────────────────────────────────

def _num(v, what: str, lo: float, hi: float) -> float:
    if isinstance(v, bool) or v is None:
        raise AttachmentError(f"{what} is a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise AttachmentError(f"{what} is a number")
    if not math.isfinite(f) or not lo <= f <= hi:
        raise AttachmentError(f"{what} is between {lo:g} and {hi:g}")
    return f


def _bool(v, what: str) -> bool:
    if not isinstance(v, bool):
        raise AttachmentError(f"{what} is true or false")
    return v


def _label(v, what: str = "an action's label") -> str:
    s = str(v if v is not None else "").strip()
    if not s or len(s) > MAX_LABEL:
        raise AttachmentError(f"{what} is 1 to {MAX_LABEL} characters")
    return s


def _wiring(w, kind: str) -> dict:
    allowed = KINDS[kind]["wirings"]
    if w is None:
        w = {"type": allowed[0]}
        if allowed[0] == ACTUATOR:
            raise AttachmentError("pick which actuator output (1 to 6) it is wired to")
    if not isinstance(w, dict):
        raise AttachmentError("wiring is an object")
    t = w.get("type")
    if t not in WIRINGS:
        raise AttachmentError("wiring is actuator, gripper or winch")
    if t not in allowed:
        names = " or ".join(allowed)
        raise AttachmentError(f"a {kind} is wired as {names}")
    if t == ACTUATOR:
        idx = w.get("index")
        if isinstance(idx, bool) or not isinstance(idx, int) or idx not in ACTUATOR_OUTPUTS:
            raise AttachmentError("the actuator output is 1 to 6")
        return {"type": ACTUATOR, "index": idx}
    inst = w.get("instance", 0)
    if isinstance(inst, bool) or not isinstance(inst, int) or not 0 <= inst <= MAX_INSTANCE:
        raise AttachmentError(f"the {t} instance is 0 to {MAX_INSTANCE}")
    return {"type": t, "instance": inst}


def _builtin_actions(kind: str, given, actuator: bool) -> List[dict]:
    defaults = {a["id"]: a for a in KINDS[kind]["actions"]}
    by_id: Dict[str, dict] = {}
    if given is not None:
        if not isinstance(given, list):
            raise AttachmentError("actions is a list")
        for a in given:
            if not isinstance(a, dict) or a.get("id") not in defaults:
                names = ", ".join(defaults)
                raise AttachmentError(f"a {kind}'s actions are {names}")
            if a["id"] in by_id:
                raise AttachmentError("two actions have the same id")
            by_id[a["id"]] = a
    out = []
    for aid, d in defaults.items():
        a = by_id.get(aid)
        if a is None and d["optional"]:
            continue
        a = a or {}
        row = {"id": aid, "label": _label(a.get("label", d["label"])), "hazard": d["hazard"]}
        if actuator:
            v = a.get("value")
            row["value"] = _num(d["value"] if v is None else v, f"the {aid} value", -1.0, 1.0)
        out.append(row)
    return out


def _custom_actions(given, actuator: bool) -> List[dict]:
    if not isinstance(given, list) or not CUSTOM_MIN_STATES <= len(given) <= CUSTOM_MAX_STATES:
        raise AttachmentError(
            f"a custom attachment has {CUSTOM_MIN_STATES} to {CUSTOM_MAX_STATES} states")
    out, seen = [], set()
    for a in given:
        if not isinstance(a, dict):
            raise AttachmentError("each state is an object")
        aid = a.get("id")
        if not isinstance(aid, str) or not _ACTION_ID.match(aid):
            raise AttachmentError("a state id is 1 to 24 lowercase letters, digits or _")
        if aid in seen:
            raise AttachmentError("two states have the same id")
        seen.add(aid)
        row = {"id": aid, "label": _label(a.get("label"), "a state's name"),
               "hazard": _bool(a.get("hazard", True), "can hurt someone")}
        if actuator:
            row["value"] = _num(a.get("value"), "a state's value", -1.0, 1.0)
        out.append(row)
    return out


def clean(body, *, existing: Optional[dict] = None) -> dict:
    """A full, defaulted record from a create body, or from a patch body
    laid over `existing`. Raises AttachmentError."""
    if not isinstance(body, dict):
        raise AttachmentError("an attachment is an object")
    base = dict(existing or {})
    kind = body.get("kind", base.get("kind"))
    if kind not in KINDS:
        raise AttachmentError("kind is release, gripper, winch, light, speaker, sprayer or custom")
    if existing is not None and kind != existing.get("kind"):
        raise AttachmentError("the kind of an attachment cannot change; add a new one")
    k = KINDS[kind]
    aid = base.get("id") or body.get("id") or new_id()
    if not isinstance(aid, str) or not _ID.match(aid):
        raise AttachmentError("an attachment id is 8 to 16 lowercase letters or digits")

    name = body.get("name", base.get("name")) or k["name"]
    name = str(name).strip()
    if not name or len(name) > MAX_NAME:
        raise AttachmentError(f"the name is 1 to {MAX_NAME} characters")

    icon = body.get("icon", base.get("icon")) or k["icon"]
    if icon not in ICONS:
        raise AttachmentError("that icon is not one of the offered icons")

    wiring = _wiring(body["wiring"] if "wiring" in body else base.get("wiring"), kind)
    actuator = wiring["type"] == ACTUATOR
    given = body["actions"] if "actions" in body else base.get("actions")
    if kind == "custom":
        actions = _custom_actions(given, actuator)
    else:
        actions = _builtin_actions(kind, given, actuator)
    hazardous = any(a["hazard"] for a in actions)

    lim_in = body.get("limits") if "limits" in body else None
    if lim_in is not None and not isinstance(lim_in, dict):
        raise AttachmentError("limits is an object")
    old = base.get("limits") or {}
    lim_src = {**old, **(lim_in or {})}
    min_src = lim_src.get("min_alt_m")
    min_alt = _num(k["min_alt_m"] if min_src is None else min_src,
                   "the minimum height", 0.0, MAX_ALT_M)
    max_alt = lim_src.get("max_alt_m")
    if max_alt is not None:
        max_alt = _num(max_alt, "the maximum height", 0.0, MAX_ALT_M)
        if max_alt <= min_alt:
            raise AttachmentError("the maximum height is above the minimum height")
    people = lim_src.get("people_check", hazardous)
    people = _bool(people, "people_check")

    enabled = _bool(body.get("enabled", base.get("enabled", True)), "enabled")
    return {"id": aid, "kind": kind, "name": name, "icon": icon, "wiring": wiring,
            "actions": actions,
            "limits": {"min_alt_m": min_alt, "max_alt_m": max_alt, "people_check": people},
            "enabled": enabled}


# ── what an action sends ──────────────────────────────────────────────────

def find_action(att: dict, action_id) -> Optional[dict]:
    for a in att.get("actions") or []:
        if a.get("id") == action_id:
            return a
    return None


def level_pct(value) -> float:
    """A sprayer level from a payload: 0..100, DEFAULT_LEVEL when absent.
    Raises AttachmentError."""
    if value is None:
        return DEFAULT_LEVEL
    return _num(value, "the spray level", 0.0, 100.0)


def actuator_value(att: dict, action: dict, level: Optional[float] = None) -> float:
    """The -1..1 value an actuator-wired action sends. A sprayer's level
    runs from its Off value (0 %) to its Spray value (100 %), which with
    the defaults is -1..1."""
    v = float(action.get("value", 0.0))
    if att.get("kind") == "sprayer" and action.get("id") == "level":
        off = find_action(att, "off")
        lo = float(off.get("value", -1.0)) if off else -1.0
        pct = DEFAULT_LEVEL if level is None else float(level)
        v = lo + (v - lo) * pct / 100.0
    return max(-1.0, min(1.0, v))


def command_for(att: dict, action: dict, level: Optional[float] = None) -> dict:
    """{type: actuator, index, value} | {type: gripper, instance, op} |
    {type: winch, instance, op}: what the flight controller is sent."""
    w = att.get("wiring") or {}
    t = w.get("type")
    key = (att.get("kind"), action.get("id"))
    if t == ACTUATOR:
        return {"type": ACTUATOR, "index": int(w["index"]),
                "value": round(actuator_value(att, action, level), 4)}
    if t == GRIPPER:
        return {"type": GRIPPER, "instance": int(w.get("instance", 0)), "op": GRIPPER_OPS[key]}
    return {"type": WINCH, "instance": int(w.get("instance", 0)), "op": WINCH_OPS[key]}


def public(att: dict) -> dict:
    return {k: att.get(k) for k in ("id", "kind", "name", "icon", "wiring", "actions",
                                    "limits", "enabled")}

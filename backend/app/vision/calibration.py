"""
Runtime-editable camera calibration and vision tuning.
======================================================

config.py holds the DEFAULTS for these values. This module holds the operator's
overrides, and it exists because those two things have different lifetimes:

  * A default belongs in .env, next to secrets, changed by whoever deploys.
  * A calibration belongs to the AIRFRAME. It is measured once on a bench,
    it must survive a restart, and it must be editable by the person flying —
    who should not have to edit a file that also contains the TURN credentials.

So overrides live in a JSON file under .data/, layered on top of Settings.
Postgres would work too, but this is a handful of scalars read at session start
and the DB is already optional everywhere else in the vision path — a
calibration that vanished when the database was down would be worse.

WHY THE FIELD TABLE IS SERVED TO THE UI
    Ranges, units and help text are defined ONCE, here, and handed to the
    frontend by the API. The alternative is declaring "hfov is 1-179 degrees"
    in Python and again in TypeScript, where the two drift apart silently and
    the UI cheerfully accepts a value the backend then rejects.

WHY THE SPLIT INTO TWO GROUPS
    `camera` is a property of the rig — measured once, changed when the lens or
    mount changes. `limits` are per-mission operator decisions. They are
    separated because they are edited by different people at different times,
    and mixing them invites someone to "fix" a flight ceiling by editing
    hardware calibration.
"""
import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional

from app.config import ROOT_DIR, get_settings

logger = logging.getLogger("verocore.vision.calibration")

CALIBRATION_PATH = os.path.join(str(ROOT_DIR), ".data", "camera_calibration.json")

# Serialised to the UI, which renders inputs from it. Keep `help` short enough
# to sit in a tooltip and specific enough to be actionable — "how to measure
# this" beats "the horizontal field of view".
FIELDS: List[Dict[str, Any]] = [
    # ── Camera rig ────────────────────────────────────────────────────────
    {
        "key": "camera_hfov_deg", "group": "camera", "type": "float",
        "label": "Horizontal FOV", "unit": "deg", "min": 1.0, "max": 179.0, "step": 0.5,
        "help": "Measure it: fill the frame edge-to-edge with a target of known "
                "width W at distance D, then HFOV = 2*atan(W / (2*D)). It cannot "
                "be looked up from the sensor part number — it is a property of "
                "the lens. Every speed and distance reading scales off this.",
    },
    {
        "key": "camera_vfov_deg", "group": "camera", "type": "float",
        "label": "Vertical FOV", "unit": "deg", "min": 0.0, "max": 179.0, "step": 0.5,
        "help": "Leave at 0 to derive it from the frame's aspect ratio, which is "
                "correct for a normal rectilinear lens. Set it only if measured — "
                "a fisheye's vertical FOV does not follow from its horizontal one.",
    },
    {
        "key": "camera_mount_tilt_deg", "group": "camera", "type": "float",
        "label": "Mount tilt (depression)", "unit": "deg", "min": 0.0, "max": 90.0, "step": 0.5,
        "help": "How far below the horizon the lens points at frame centre. 0 is "
                "straight ahead, 90 is straight down. With a 70 deg lens, 40-47 "
                "covers both a shallow view for reading plates and a steep one "
                "for ground projection at the same time.",
    },
    {
        "key": "camera_mount_yaw_deg", "group": "camera", "type": "float",
        "label": "Mount yaw offset", "unit": "deg", "min": -180.0, "max": 180.0, "step": 0.5,
        "help": "Rotation of the camera away from straight ahead. Normally 0.",
    },
    {
        "key": "camera_mount_roll_deg", "group": "camera", "type": "float",
        "label": "Mount roll offset", "unit": "deg", "min": -180.0, "max": 180.0, "step": 0.5,
        "help": "Camera rotation about its own optical axis — a tilted horizon "
                "with the airframe level. Normally 0.",
    },
    {
        "key": "agl_source", "group": "camera", "type": "enum",
        "label": "Height source", "options": ["baro", "gps", "rangefinder"],
        "help": "Which telemetry field to believe for height above the ground. "
                "Barometric is usually best; GPS vertical error (+-3-5m) is too "
                "coarse below about 50m. Relative altitude error passes straight "
                "into speed, so this matters most when flying low.",
    },
    {
        "key": "agl_offset_m", "group": "camera", "type": "float",
        "label": "Ground height offset", "unit": "m", "min": -500.0, "max": 500.0, "step": 0.1,
        "help": "Subtracted from reported altitude. Both baro and GPS are "
                "relative to the LAUNCH point, so if the road you are watching "
                "sits above or below where you took off, that difference lands "
                "in every speed estimate until it is corrected here.",
    },

    # ── Operational limits (per mission, not per rig) ─────────────────────
    {
        "key": "max_altitude_agl_m", "group": "limits", "type": "float",
        "label": "Altitude ceiling", "unit": "m", "min": 5.0, "max": 500.0, "step": 1.0,
        "help": "Hard cap on auto-elevate during a chase. A legal limit — DGCA "
                "is 120m. The drone refuses to climb past it even if that means "
                "losing the target.",
    },
    {
        "key": "min_altitude_agl_m", "group": "limits", "type": "float",
        "label": "Altitude floor", "unit": "m", "min": 0.0, "max": 100.0, "step": 0.5,
        "help": "Hard floor on any automatic descent. The counterpart to the "
                "ceiling above, and the more important of the two: without it a "
                "tracker that wants the subject lower in frame will fly the "
                "aircraft into the ground, which is exactly what happened in "
                "SITL before this existed. Descent eases to a stop approaching "
                "this height; climbing is never restricted.",
    },
    {
        "key": "max_depression_deg", "group": "limits", "type": "float",
        "label": "Max look-down angle", "unit": "deg", "min": 10.0, "max": 90.0, "step": 1.0,
        "help": "A RECOGNITION limit, separate from the altitude cap. Past this "
                "the camera is looking too steeply down for a face to be a face "
                "or a plate to be readable — still flying, but the analytics have "
                "stopped being useful.",
    },
    {
        "key": "crowd_light_max", "group": "limits", "type": "int",
        "label": "Crowd: light up to", "unit": "people", "min": 1, "max": 500, "step": 1,
        "help": "People in frame at or below this read GREEN. Whole-frame "
                "headcount depends entirely on lens, altitude and framing, so "
                "there is no universally correct value — a venue that has "
                "counted its own safe occupancy has better numbers than any "
                "default here.",
    },
    {
        "key": "crowd_moderate_max", "group": "limits", "type": "int",
        "label": "Crowd: moderate up to", "unit": "people", "min": 2, "max": 1000, "step": 1,
        "help": "Above 'light' and at or below this reads ORANGE; anything "
                "higher reads RED. Kept above the light threshold, or the "
                "orange band vanishes and the count jumps green to red.",
    },
    {
        "key": "speed_fit_window_frames", "group": "limits", "type": "int",
        "label": "Speed averaging window", "unit": "frames", "min": 5, "max": 60, "step": 1,
        "help": "Frames in the least-squares velocity fit. Longer is smoother but "
                "lags real acceleration; 15 (~0.5s at 30fps) is where box jitter "
                "stops dominating. Never differentiate two frames.",
    },
    {
        "key": "speed_scale_source", "group": "limits", "type": "enum",
        "label": "Speed scale source", "options": ["auto", "altitude", "object"],
        "help": "How metres-per-pixel is derived. 'altitude' uses AGL + FOV and "
                "improves with height; 'object' uses a vehicle's known width and "
                "is flat ~4% at any altitude. 'auto' uses both and flags a "
                "reading when they disagree — which is the point of having two.",
    },
    {
        "key": "speed_scale_max_disagreement_pct", "group": "limits", "type": "float",
        "label": "Scale disagreement limit", "unit": "%", "min": 1.0, "max": 100.0, "step": 1.0,
        "help": "In 'auto' mode, how far the two scale sources may differ before "
                "a speed is marked unreliable instead of being reported.",
    },
]

_BY_KEY = {f["key"]: f for f in FIELDS}
_lock = threading.Lock()
_cache: Optional[Dict[str, Any]] = None


def _defaults() -> Dict[str, Any]:
    s = get_settings()
    return {k: getattr(s, k) for k in _BY_KEY}


def _read_file() -> Dict[str, Any]:
    try:
        with open(CALIBRATION_PATH) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        # A corrupt file must not take the vision pipeline down with it —
        # fall back to defaults and say so loudly.
        logger.warning(f"Calibration file unreadable ({e}) — using defaults")
        return {}


def coerce(key: str, value: Any) -> Any:
    """
    Validate one field against its own spec. Raises ValueError with a message
    meant for the operator, not a stack trace.
    """
    spec = _BY_KEY.get(key)
    if spec is None:
        raise ValueError(f"unknown setting '{key}'")

    if spec["type"] == "enum":
        v = str(value)
        if v not in spec["options"]:
            raise ValueError(
                f"{spec['label']}: must be one of {', '.join(spec['options'])}"
            )
        return v

    try:
        v = int(value) if spec["type"] == "int" else float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{spec['label']}: '{value}' is not a number")
    if v < spec["min"] or v > spec["max"]:
        raise ValueError(
            f"{spec['label']}: {v} is outside {spec['min']}-{spec['max']}"
            f"{' ' + spec['unit'] if spec.get('unit') else ''}"
        )
    return v


def effective() -> Dict[str, Any]:
    """
    Settings defaults with the operator's saved overrides layered on top.

    Cached, because this is read on every frame that projects a pixel to the
    ground. Invalidated by save().
    """
    global _cache
    with _lock:
        if _cache is None:
            values = _defaults()
            for k, v in _read_file().items():
                if k not in _BY_KEY:
                    continue          # a key from an older build — ignore it
                try:
                    values[k] = coerce(k, v)
                except ValueError as e:
                    logger.warning(f"Ignoring stored calibration: {e}")
            _cache = values
        return dict(_cache)


def save(updates: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate and persist a partial update. Returns the new effective values.

    All-or-nothing: one bad field rejects the whole request rather than saving
    half of it, so a partially-applied calibration can never be flying.
    """
    clean = {k: coerce(k, v) for k, v in updates.items()}

    with _lock:
        stored = _read_file()
        stored.update(clean)
        os.makedirs(os.path.dirname(CALIBRATION_PATH), exist_ok=True)
        tmp = CALIBRATION_PATH + ".tmp"
        # Write-then-rename: a crash mid-write leaves the previous calibration
        # intact rather than a truncated file.
        with open(tmp, "w") as fh:
            json.dump(stored, fh, indent=2, sort_keys=True)
        os.replace(tmp, CALIBRATION_PATH)
        global _cache
        _cache = None

    logger.info(
        "Calibration updated: "
        + ", ".join(f"{k}={v}" for k, v in sorted(clean.items()))
    )
    return effective()


def reset() -> Dict[str, Any]:
    """Drop every override and go back to the .env defaults."""
    global _cache
    with _lock:
        try:
            os.remove(CALIBRATION_PATH)
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning(f"Could not remove calibration file: {e}")
        _cache = None
    logger.info("Calibration reset to defaults")
    return effective()


def schema() -> Dict[str, Any]:
    """Field table plus current values — everything the UI needs to render."""
    values = effective()
    saved = set(_read_file())
    return {
        "fields": [
            {**f, "value": values[f["key"]], "overridden": f["key"] in saved}
            for f in FIELDS
        ],
        "calibrated": bool(saved),
    }

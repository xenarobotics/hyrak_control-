"""
Every mode's result, read as a flat list of detections for the map.

The vision modules grew their own result shapes (detections, persons,
people, vehicles, a classifier's top class). This reads all of them into
one shape so the tracker does not care which mode produced a box:

    Detection(label, score, box, task, track_id)

Modes whose output is not "things on the ground" (depth, enhance, 3D scan,
manual control) give nothing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

SKIP_MODES = frozenset({"manual-control", "depth-mapping", "enhance", "3d-reconstruction",
                        "obstacle-avoidance"})

#: Human names for the built-in modes, for the popover's "model" line.
MODE_NAMES = {
    "object-detection": "Object detection",
    "human-tracking": "Human tracking",
    "person-tracking": "Person tracking",
    "crowd-management": "Crowd management",
    "vehicle-plate-tracking": "Vehicle plates",
    "traffic-management": "Traffic",
    "scenario-assessment": "Scenario assessment",
    "target-identification": "Target identification",
}

#: Cap per frame: a dense crowd frame is hundreds of boxes, and the map
#: wants the best few rather than every head.
MAX_PER_FRAME = 60


@dataclass(frozen=True)
class Detection:
    label: str
    score: Optional[float]
    box: Optional[list]
    task: str = "detect"            # detect | classify
    track_id: Optional[int] = None


def _score(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0.0 <= f <= 1.0 else None


def _tid(v) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _box(v) -> Optional[list]:
    if isinstance(v, (list, tuple)) and len(v) >= 4:
        try:
            return [float(x) for x in v[:4]]
        except (TypeError, ValueError):
            return None
    return None


def source_of(mode: str, meta: Dict[str, Any]) -> tuple[str, str]:
    """(source id, human name) of the model behind this result."""
    if mode.startswith("custom:"):
        return mode, str(meta.get("model_name") or "Custom model")
    return mode, MODE_NAMES.get(mode, mode.replace("-", " ").capitalize())


def detections_from(mode: str, meta: Dict[str, Any]) -> List[Detection]:
    if not mode or mode in SKIP_MODES or not isinstance(meta, dict) or meta.get("error"):
        return []
    out: List[Detection] = []

    if meta.get("task") == "classify" or (meta.get("top_class") and not meta.get("detections")):
        name = meta.get("top_class")
        if name:
            out.append(Detection(str(name), _score(meta.get("top_score")), None, "classify"))
        return out

    for d in meta.get("detections") or []:
        if isinstance(d, dict) and d.get("name") and _box(d.get("box")):
            out.append(Detection(str(d["name"]), _score(d.get("score")), _box(d["box"]),
                                 track_id=_tid(d.get("track_id"))))
    for p in meta.get("persons") or []:
        if isinstance(p, dict) and _box(p.get("box")):
            out.append(Detection("person", _score(p.get("conf")), _box(p["box"]),
                                 track_id=_tid(p.get("id"))))
    for p in meta.get("people") or []:
        if isinstance(p, dict) and _box(p.get("box")):
            out.append(Detection("person", _score(p.get("conf")), _box(p["box"]),
                                 track_id=_tid(p.get("id", p.get("track_id")))))
    for v in meta.get("vehicles") or []:
        if isinstance(v, dict) and _box(v.get("box")):
            label = str(v.get("type") or "vehicle")
            out.append(Detection(label, _score(v.get("conf")), _box(v["box"]),
                                 track_id=_tid(v.get("track_id"))))

    if len(out) > MAX_PER_FRAME:
        # Keep the highest-scoring, then the biggest boxes (nearest).
        def rank(d: Detection):
            b = d.box or [0, 0, 0, 0]
            return (d.score or 0.0, (b[2] - b[0]) * (b[3] - b[1]))
        out = sorted(out, key=rank, reverse=True)[:MAX_PER_FRAME]
    return out

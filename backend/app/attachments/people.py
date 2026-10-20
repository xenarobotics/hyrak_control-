"""
"Is anyone below?" for the attachment people check: the latest analysed
frame of each session, whatever AI mode produced it.

stream_track calls note() once per analysed result (on the event loop,
before the result goes to the client); control.py asks check(). A frame
older than FRESH_S counts as no AI running, which the people check
reports instead of refusing.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional, Tuple

FRESH_S = 2.0
MIN_SCORE = 0.4
PERSON_CLASSES = frozenset({"person", "pedestrian", "people"})

# session id -> (monotonic time of the frame, best person score or None)
_latest: Dict[str, Tuple[float, Optional[float]]] = {}


def best_person(mode: str, meta: Dict[str, Any]) -> Optional[float]:
    """The highest person-like score in one result, or None. A person with
    no score counts as certain."""
    from app.mapdetect.extract import detections_from
    best = None
    try:
        dets = detections_from(mode, meta)
    except Exception:
        dets = []
    for d in dets:
        if str(d.label).lower() in PERSON_CLASSES:
            s = 1.0 if d.score is None else float(d.score)
            best = s if best is None else max(best, s)
    if best is None:
        # Modes that only count (no boxes reach the client) still say so.
        try:
            if int(meta.get("person_count") or 0) > 0:
                best = 1.0
        except (TypeError, ValueError):
            pass
    return best


def note(session_id: str, mode: str, meta: Dict[str, Any], now: Optional[float] = None) -> None:
    from app.mapdetect.extract import SKIP_MODES
    if not session_id or mode in SKIP_MODES or not isinstance(meta, dict) or meta.get("error"):
        return
    _latest[session_id] = (time.monotonic() if now is None else now, best_person(mode, meta))


def check(session_id: str, now: Optional[float] = None) -> str:
    """"people" (a person-like class at MIN_SCORE or above in a fresh
    frame), "clear" (a fresh frame without one) or "no_ai"."""
    rec = _latest.get(session_id)
    now = time.monotonic() if now is None else now
    if rec is None or now - rec[0] > FRESH_S:
        return "no_ai"
    score = rec[1]
    return "people" if score is not None and score >= MIN_SCORE else "clear"


def drop(session_id: str) -> None:
    _latest.pop(session_id, None)


def reset_for_tests() -> None:
    _latest.clear()

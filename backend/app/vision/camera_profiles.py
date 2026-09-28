"""Which camera a session's frames come from, and that camera's lens.

The WebRTC offer names the video source; signaling records it here. Anything
that needs the frame's field of view (metric depth, avoidance geometry) asks
hfov_for(session_id) instead of reading the drone camera's setting, because
a webcam on the operator's machine is a different lens (see config
webcam_hfov_deg).
"""
from __future__ import annotations

from app.config import get_settings

# Sources that are a camera on the OPERATOR's machine, not the aircraft's.
LOCAL_CAMERA_SOURCES = {"camera"}

_sources: dict[str, str] = {}


def set_source(session_id: str, source: str | None) -> None:
    if source:
        _sources[session_id] = source
    else:
        _sources.pop(session_id, None)


def source_of(session_id: str | None) -> str | None:
    return _sources.get(session_id or "")


def hfov_for(session_id: str | None) -> float:
    s = get_settings()
    if source_of(session_id) in LOCAL_CAMERA_SOURCES:
        return float(s.webcam_hfov_deg)
    return float(s.camera_hfov_deg)

"""Admin observer registry — which /admin sockets are watching which session.

The server already terminates every client's video (vision pool) and MAVLink
(mavsdk_server via SerialBridge), but all of it is routed back only to its
owner. This registry lets the /admin page tap in: telemetry snapshots and a
low-rate JPEG mirror of the video are additionally emitted to the socket.io
room ``watch-<session_id>`` whenever someone is watching.

Kept dependency-free so stream_track can import it without cycles.
"""

# session_id → set of admin socket ids watching it
_watching: dict[str, set[str]] = {}


def watch_room(session_id: str) -> str:
    return f"watch-{session_id}"


def watch(session_id: str, sid: str):
    _watching.setdefault(session_id, set()).add(sid)


def unwatch(session_id: str, sid: str):
    sids = _watching.get(session_id)
    if sids:
        sids.discard(sid)
        if not sids:
            _watching.pop(session_id, None)


def drop_sid(sid: str):
    """An admin socket disconnected — forget everything it was watching."""
    for session_id in list(_watching):
        unwatch(session_id, sid)


def drop_session(session_id: str):
    """A watched client session ended."""
    _watching.pop(session_id, None)


def has_watchers(session_id: str) -> bool:
    return bool(_watching.get(session_id))

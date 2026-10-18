"""
Socket events for detections on the map (classified in
app/auth/socket_classes.py):

  set_map_camera {hfov_deg, pitch_deg, stabilised, set}   SESSION_VIEW
      The camera this session's video comes from, for the ground
      projection. Kept on the device (Settings > Video) and sent when the
      session starts or the setting changes. Only this session's own
      projections change, so a viewer may send it.
  set_map_recording {on}                                  SESSION_COMMAND
      "Record to map": keep this session's sightings in map_sightings.
      Writing history needs `fly` (staff: operator), like the other
      history-writing controls.

Both answer with a full-state `map_sightings` push to the caller.
"""
from __future__ import annotations

from app.auth.socket_guard import require_session_fly, require_session_view
from app.mapdetect import live


def register_map_events(sio, session_manager) -> None:
    live.configure(sio, session_manager)

    @sio.on("set_map_camera")
    async def on_set_map_camera(sid, data):
        if not await require_session_view(sid, "set_map_camera", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        await live.set_camera(session.session_id, data if isinstance(data, dict) else {})

    @sio.on("set_map_recording")
    async def on_set_map_recording(sid, data):
        if not await require_session_fly(sid, "set_map_recording", data): return
        session = session_manager.get_by_socket(sid)
        if session is None:
            return
        on = bool((data or {}).get("on")) if isinstance(data, dict) else False
        await live.set_recording(session.session_id, on)

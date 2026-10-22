"""Socket events for Config > Logs and Config > Parameters metadata.

  log_list      -> log_list_result {ok, logs: [{id, date, size_bytes}] | error}
  log_download  {id} -> log_download_ack {ok, id, size_bytes | error}, then
                log_progress {id, progress, bytes}, and log_ready {id, bytes, path}
                or log_failed {id, error}
  log_cancel    -> log_failed {id, cancelled: True} from the running download
  log_erase     {confirm: "ERASE"} -> log_erase_result {ok | error}
  param_metadata -> param_metadata_result {ok, meta | error}

The log events are SESSION_COMMAND and DRONE_EVENTS, the same checks as
set_param: `fly` on the session's workspace and on the drone's. They act on
the caller's own session's drone only (never `target_session`). Download
and erase also need a disarmed aircraft on the ground. Parameter metadata
is read-only: SESSION_VIEW, like fetch_params.
"""
from __future__ import annotations

import logging

from app.auth.socket_guard import require_session_fly, require_session_view
from app.telemetry import log_download as logs
from app.telemetry import param_meta

logger = logging.getLogger("verocore.config_events")

ERASE_CONFIRM = "ERASE"


def register_config_events(sio, session_manager) -> None:

    def _link(sid):
        session = session_manager.get_by_socket(sid)
        if not session:
            return None, None
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            return session, None
        return session, tel

    def _emitter(session_id: str):
        """Send to whichever socket the session has now (a resumed session
        gets a new socket id mid-download)."""
        async def emit(event: str, payload: dict) -> None:
            s = session_manager.get(session_id)
            if s is not None and s.socket_id:
                await sio.emit(event, payload, to=s.socket_id)
        return emit

    @sio.on("log_list")
    async def on_log_list(sid, data=None):
        if not await require_session_fly(sid, "log_list", data): return
        session, tel = _link(sid)
        if session is None:
            return
        if tel is None:
            await sio.emit("log_list_result", {"ok": False, "error": "No drone connected"}, to=sid)
            return
        try:
            items = await logs.list_logs(tel)
        except Exception as e:
            await sio.emit("log_list_result", {"ok": False, "error": f"The drone did not list its logs ({e or 'timed out'})"}, to=sid)
            return
        await sio.emit("log_list_result", {"ok": True, "logs": items}, to=sid)

    @sio.on("log_download")
    async def on_log_download(sid, data=None):
        if not await require_session_fly(sid, "log_download", data): return
        session, tel = _link(sid)
        if session is None:
            return
        raw = (data or {}).get("id") if isinstance(data, dict) else None

        async def refuse(msg: str) -> None:
            await sio.emit("log_download_ack", {"ok": False, "id": raw, "error": msg}, to=sid)

        if tel is None:
            return await refuse("No drone connected")
        if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0 or raw > 0xFFFF:
            return await refuse("Pick a log from the list")
        if not session.user_id:
            return await refuse("Sign in again to download logs")
        why = logs.busy_refusal(tel)
        if why:
            return await refuse(why)
        try:
            entries = await logs.entries(tel)
        except Exception as e:
            return await refuse(f"The drone did not list its logs ({e or 'timed out'})")
        entry = next((e for e in entries if int(e.id) == raw), None)
        if entry is None:
            return await refuse("That log is no longer on the drone. Refresh the list")
        key = id(tel)
        why = logs.downloads.preflight(tel, key, raw, entry.size_bytes)
        if why:
            return await refuse(why)
        logs.downloads.start(tel, key, entry, session.session_id, session.user_id,
                             _emitter(session.session_id))
        await sio.emit("log_download_ack", {"ok": True, "id": raw, "size_bytes": int(entry.size_bytes)}, to=sid)

    @sio.on("log_cancel")
    async def on_log_cancel(sid, data=None):
        if not await require_session_fly(sid, "log_cancel", data): return
        session, tel = _link(sid)
        if session is None:
            return
        tel = tel or session_manager.get_telemetry(session.session_id)
        if tel is not None:
            logs.downloads.cancel(id(tel))

    @sio.on("log_erase")
    async def on_log_erase(sid, data=None):
        if not await require_session_fly(sid, "log_erase", data): return
        session, tel = _link(sid)
        if session is None:
            return

        async def done(ok: bool, error: str | None = None) -> None:
            await sio.emit("log_erase_result", {"ok": ok, "error": error}, to=sid)

        if tel is None:
            return await done(False, "No drone connected")
        if not isinstance(data, dict) or data.get("confirm") != ERASE_CONFIRM:
            return await done(False, "Type ERASE to confirm")
        why = logs.busy_refusal(tel)
        if why:
            return await done(False, why)
        job = logs.downloads.jobs.get(id(tel))
        if job is not None and job.task is not None and not job.task.done():
            return await done(False, "A log is downloading. Wait for it or cancel it first")
        try:
            await logs.erase_all(tel)
        except Exception as e:
            return await done(False, f"The drone did not erase its logs ({e or 'timed out'})")
        logger.info(f"Session {session.session_id[:8]}: erased all logs on the drone")
        await done(True)

    @sio.on("param_metadata")
    async def on_param_metadata(sid, data=None):
        if not await require_session_view(sid, "param_metadata", data): return
        session, tel = _link(sid)
        if session is None:
            return
        if tel is None:
            await sio.emit("param_metadata_result", {"ok": False, "error": "No drone connected"}, to=sid)
            return
        await sio.emit("param_metadata_result", await param_meta.for_link(tel), to=sid)

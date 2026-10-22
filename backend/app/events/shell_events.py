"""MAVLink console for Config > Console: PX4's NuttShell over SERIAL_CONTROL,
the same console QGroundControl's Analyze tools open.

One socket event, `mavlink_shell` {cmd}: SESSION_COMMAND with drone `fly`
(a shell can do anything a parameter write or an arm button can), sent to
the caller's own session's aircraft. Output comes back as `shell_output`
{text} to the socket that last typed. The MAVSDK shell stream is opened on
first use per telemetry link and lives as long as that link.
"""
from __future__ import annotations

import asyncio
import logging

from app.auth.socket_guard import require_session_fly

logger = logging.getLogger("verocore.shell")

MAX_CMD = 512


def clean_command(raw) -> str | None:
    """One line of input, or None if there is nothing sendable."""
    if not isinstance(raw, str):
        return None
    cmd = raw.replace("\r", "").split("\n")[0]
    cmd = "".join(ch for ch in cmd if ch == "\t" or 32 <= ord(ch) < 127)
    if len(cmd) > MAX_CMD:
        return None
    return cmd


def register_shell_events(sio, session_manager) -> None:
    # telemetry manager -> {"task": Task, "sid": str}
    readers: dict[int, dict] = {}

    async def _pump(tel, key: int):
        try:
            async for text in tel._drone.shell.receive():
                sid = readers.get(key, {}).get("sid")
                if sid and text:
                    await sio.emit("shell_output", {"text": text}, to=sid)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.info(f"shell stream ended: {e}")
        finally:
            readers.pop(key, None)

    @sio.on("mavlink_shell")
    async def on_mavlink_shell(sid, data):
        if not await require_session_fly(sid, "mavlink_shell", data): return
        session = session_manager.get_by_socket(sid)
        if not session:
            return
        tel = session_manager.get_telemetry(session.session_id)
        if not tel or not tel.is_connected or getattr(tel, "_drone", None) is None:
            await sio.emit("shell_output", {"text": "\n[HYRAK] No drone connected.\n", "error": True}, to=sid)
            return
        cmd = clean_command((data or {}).get("cmd"))
        if cmd is None:
            await sio.emit("shell_output", {"text": "\n[HYRAK] Command too long or not text.\n", "error": True}, to=sid)
            return
        key = id(tel)
        r = readers.get(key)
        if r is None or r["task"].done():
            readers[key] = {"sid": sid, "task": asyncio.create_task(_pump(tel, key), name="mavlink_shell")}
            # Let the stream subscribe before the first command goes out.
            await asyncio.sleep(0.2)
        else:
            r["sid"] = sid
        try:
            await asyncio.wait_for(tel._drone.shell.send(cmd + "\n"), timeout=5.0)
        except Exception as e:
            await sio.emit("shell_output", {"text": f"\n[HYRAK] The console did not answer ({e}).\n", "error": True}, to=sid)

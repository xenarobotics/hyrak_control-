"""MAVLink console for Config > Console: PX4's NuttShell over SERIAL_CONTROL,
the same console QGroundControl's Analyze tools open.

One socket event, `mavlink_shell` {cmd}: SESSION_COMMAND with drone `fly`,
sent to the caller's own session's aircraft. Read-only commands run for any
pilot; anything that changes the aircraft needs staff and a disarmed drone
on the ground; arm/takeoff/mode/motor-test commands are refused outright
(see classify), because the shell would skip HYRAK's own gates. Output comes back as `shell_output`
{text} to the socket that last typed. The MAVSDK shell stream is opened on
first use per telemetry link and lives as long as that link.
"""
from __future__ import annotations

import asyncio
import logging

from app.auth.socket_guard import _is_staff_session, require_session_fly
from app.telemetry import actuator_test

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


# Commands that only read state: any pilot with fly on the drone may run them.
READ_ONLY = frozenset({
    "ver", "top", "listener", "uorb", "dmesg", "free", "help", "ls", "cat",
    "perf", "work_queue",
})
# Modules (sensors, ekf2, mavlink, logger...) are read-only only with a
# status-like subcommand: "ekf2 stop" or "mavlink stop" changes the aircraft.
READ_ONLY_SUBCOMMANDS = frozenset({"status", "info", "show", "list", "check", "dump"})
# Never through the console, for anyone: these skip HYRAK's own gates
# (red zone, takeover, pre-arm failsafe check, the propellers-off confirm).
# Arm, take off, modes and motor tests have their own guarded buttons.
NEVER = frozenset({"commander", "motor_test", "actuator_test", "navigator"})


def classify(cmd: str) -> str:
    """'read' (any pilot), 'never' (nobody), or 'write' (staff, on the ground)."""
    words = cmd.split()
    if not words:
        return "read"
    first, rest = words[0], words[1:]
    sub = rest[0] if rest else ""
    if first == "commander" and sub in {"status", "check"}:
        return "read"
    if first in NEVER:
        return "never"
    if first == "param":
        return "read" if sub in {"show", "status", "compare", "greater"} else "write"
    if first in READ_ONLY or sub in READ_ONLY_SUBCOMMANDS:
        return "read"
    return "write"


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
        kind = classify(cmd)
        if kind == "never":
            await sio.emit("shell_output", {"text": f"\n[HYRAK] '{cmd.split()[0]}' is not available here. "
                            "Use the Arm, Take off, Mode and Test motors controls, which run HYRAK's safety checks.\n",
                            "error": True}, to=sid)
            return
        if kind == "write":
            why = None if _is_staff_session(session) else "Only staff can run commands that change the aircraft"
            why = why or actuator_test.refusal(tel)
            if why:
                await sio.emit("shell_output", {"text": f"\n[HYRAK] {why}. Read-only commands (ver, top, listener, "
                                "param show, ... status) still work.\n", "error": True}, to=sid)
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

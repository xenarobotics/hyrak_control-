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
import re

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


# Fail closed: a line is sent only if it matches an allowlist below. The
# shell (NuttShell) chains and redirects, so any line with an operator or
# quoting character is refused before the words are looked at, and argv[0]
# must be a bare command name (a path would run that file).
UNSAFE = re.compile(r"[;&|<>`$()'\"\\#{}\[\]*?~!]")
PLAIN_ARG = re.compile(r"^[A-Za-z0-9_./:=,+-]+$")
# Any pilot with fly on the drone: commands that only read state.
READ_ANY_ARGS = frozenset({"ver", "top", "free", "dmesg", "help", "perf", "work_queue", "listener"})
READ_SUB = {
    "param": {"show", "status", "compare", "greater", "show-for-airframe"},
    "uorb": {"top", "status"},
    "ls": None, "cat": None,   # None: any plain path arguments
    "commander": {"status", "check"},
}
STATUS_MODULES = frozenset({
    "sensors", "ekf2", "mavlink", "logger", "gps", "battery_status", "dshot", "pwm_out",
    "uavcan", "navigator", "rc_update", "manual_control", "land_detector", "control_allocator",
    "mc_pos_control", "mc_att_control", "mc_rate_control", "flight_mode_manager", "dataman",
})
# Staff, on a disarmed drone on the ground: the few changes QGC users run here.
# Arming, take off, modes and motors stay on HYRAK's guarded controls.
WRITE_SUB = {
    "param": {"set", "set-default", "reset", "save", "load", "import", "export"},
    "logger": {"on", "off"},
    "reboot": None,
}


def classify(cmd: str) -> str:
    """'read' (any pilot), 'write' (staff, on the ground) or 'never'."""
    if UNSAFE.search(cmd):
        return "never"
    words = cmd.split()
    if not words:
        return "read"
    if not all(PLAIN_ARG.match(w) for w in words):
        return "never"
    first = words[0]
    if not re.fullmatch(r"[a-z0-9_]+", first):
        return "never"   # a path runs that file, whatever its name
    sub = words[1] if len(words) > 1 else ""
    if first in READ_ANY_ARGS:
        return "read"
    if first in READ_SUB:
        allowed = READ_SUB[first]
        if allowed is None or sub in allowed:
            return "read"
    if first in STATUS_MODULES and sub in {"status", "info"} and len(words) == 2:
        return "read"
    if first in WRITE_SUB:
        allowed = WRITE_SUB[first]
        if allowed is None or sub in allowed:
            return "write"
    return "never"


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
            await sio.emit("shell_output", {"text": "\n[HYRAK] That command is not available in this console. "
                            "Arm, take off, modes and motor tests are on HYRAK's guarded controls; "
                            "here: ver, top, listener, param show/set, <module> status, reboot.\n",
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

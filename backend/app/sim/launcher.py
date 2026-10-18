"""
Starting and stopping one cloud SITL instance: simulation/cloud_sim.sh,
headless Gazebo + PX4, in a process group of its own.

What this file may kill, and nothing else:
  * the process group it created (os.killpg on the pgid of the script it
    spawned; the script is never reaped before the group is gone, so its
    pid, and with it the pgid, cannot be reused meanwhile), and
  * processes that carry this instance's marker, HYRAK_CLOUD_SIM_ID=<id>,
    in their own environment (/proc/<pid>/environ, a POSITIVE match, and
    only processes of this user). Every process the script starts inherits
    the marker; nothing else on the machine has it.

It never pattern-matches command lines, never runs pkill / pgrep / killall,
and never touches gz or px4 processes it did not start: the owner runs his
own sims on the same machine.
"""
from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.sim.ports import SlotPorts

logger = logging.getLogger("verocore.sim.launcher")

MARKER = "HYRAK_CLOUD_SIM_ID"
# Ready = PX4 has booted through its startup script (sensors, gz bridge)
# and opened the backend link. NOT "Ready for takeoff": PX4 withholds that
# until a ground station is connected ("Preflight Fail: No connection to
# the GCS"), and the backend link IS the ground station. Pre-flight state
# after that (EKF, GPS fix) reaches the pilot as telemetry, like a real
# drone's.
READY_RE = re.compile(rb"\[mavlink\] mode: Normal.*on udp port|Ready for takeoff")


@dataclass
class LaunchSpec:
    sim_id: str
    instance: int
    partition: str
    ports: SlotPorts
    model: str               # PX4_SIM_MODEL, e.g. gz_x500
    autostart: int           # PX4_SYS_AUTOSTART, e.g. 4001
    world: str
    home_lat: float
    home_lon: float
    workdir: Path

    @property
    def log_path(self) -> Path:
        return self.workdir / "sim.log"


@dataclass
class LaunchHandle:
    sim_id: str
    pid: int                 # the script = process group leader
    pgid: int
    log_path: Path
    proc: Optional[subprocess.Popen] = field(default=None, repr=False)

    def exited(self) -> Optional[int]:
        """The script's exit code, or None while it runs."""
        if self.proc is None:
            return None
        return self.proc.poll()


def marker_pids(sim_id: str, proc_root: str = "/proc") -> list[int]:
    """Pids of this user's processes whose environment carries
    HYRAK_CLOUD_SIM_ID=<sim_id>. Never includes this process."""
    needle = f"{MARKER}={sim_id}".encode()
    me, uid = os.getpid(), os.getuid()
    out = []
    try:
        names = os.listdir(proc_root)
    except OSError:
        return out
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == me:
            continue
        try:
            if os.stat(f"{proc_root}/{name}").st_uid != uid:
                continue
            with open(f"{proc_root}/{name}/environ", "rb") as f:
                env = f.read()
        except OSError:
            continue
        if needle in env.split(b"\0"):
            out.append(pid)
    return out


def tail(path: Path, lines: int = 12) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def log_says_ready(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return READY_RE.search(f.read()) is not None
    except OSError:
        return False


class ProcessLauncher:
    """The real launcher. Tests use a fake with the same five methods."""

    def __init__(self, script: Path, px4_dir: Path):
        self.script = Path(script)
        self.px4_dir = Path(px4_dir)

    def unavailable(self) -> Optional[str]:
        """None when a sim can be launched here, else why not (for staff)."""
        if not self.script.is_file():
            return f"launcher script missing: {self.script}"
        build = self.px4_dir / "build" / "px4_sitl_default"
        if not (build / "bin" / "px4").is_file():
            return f"PX4 SITL build missing under {self.px4_dir} (make px4_sitl_default)"
        from shutil import which
        if which("gz") is None:
            return "Gazebo (gz) is not installed"
        return None

    def start(self, spec: LaunchSpec) -> LaunchHandle:
        spec.workdir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        # The marker every child inherits, and the only thing sweep() trusts.
        env[MARKER] = spec.sim_id
        env["PX4_DIR"] = str(self.px4_dir)
        # Never on the owner's desktop: headless server, no GUI, no display.
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
        args = [
            "bash", str(self.script),
            "--instance", str(spec.instance),
            "--partition", spec.partition,
            "--mav-port", str(spec.ports.backend),
            "--px4-port", str(spec.ports.px4),
            "--dds-port", str(spec.ports.dds),
            "--model", spec.model,
            "--autostart", str(spec.autostart),
            "--world", spec.world,
            "--home", f"{spec.home_lat:.7f},{spec.home_lon:.7f}",
            "--workdir", str(spec.workdir),
        ]
        log = open(spec.log_path, "ab")
        try:
            proc = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True,
                                    cwd=str(spec.workdir))
        finally:
            log.close()
        logger.info(f"cloud sim {spec.sim_id[:8]}: started pid {proc.pid} "
                    f"(instance {spec.instance}, partition {spec.partition}, "
                    f"mavlink udp:{spec.ports.backend})")
        return LaunchHandle(sim_id=spec.sim_id, pid=proc.pid, pgid=proc.pid,
                            log_path=spec.log_path, proc=proc)

    def stop(self, handle: LaunchHandle, grace_s: float = 8.0) -> None:
        """Blocking: run it in a thread. SIGINT to the group (gz sim ignores
        SIGTERM), SIGKILL after grace_s, then a marker sweep for anything
        that left the group."""
        self._signal_group(handle, signal.SIGINT)
        deadline = time.monotonic() + grace_s
        while time.monotonic() < deadline:
            if handle.exited() is not None and not marker_pids(handle.sim_id):
                break
            time.sleep(0.25)
        else:
            self._signal_group(handle, signal.SIGKILL)
        if handle.proc is not None:
            try:
                handle.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self.sweep(handle.sim_id)

    def _signal_group(self, handle: LaunchHandle, sig: int) -> None:
        # Only while our script is unreaped: its pid (= the pgid) is still
        # ours then. After a backend restart there is no Popen and the
        # marker sweep is the only tool.
        if handle.proc is None or handle.proc.returncode is not None:
            return
        try:
            os.killpg(handle.pgid, sig)
        except ProcessLookupError:
            pass
        except PermissionError as e:
            logger.warning(f"cloud sim {handle.sim_id[:8]}: cannot signal group {handle.pgid}: {e}")

    def sweep(self, sim_id: str) -> int:
        """SIGKILL every process carrying this instance's marker. Returns the
        number killed."""
        n = 0
        for pid in marker_pids(sim_id):
            try:
                os.kill(pid, signal.SIGKILL)
                n += 1
            except ProcessLookupError:
                pass
            except PermissionError:
                pass
        if n:
            logger.info(f"cloud sim {sim_id[:8]}: swept {n} leftover process(es)")
        return n

    def ready(self, handle: LaunchHandle) -> bool:
        return log_says_ready(handle.log_path)

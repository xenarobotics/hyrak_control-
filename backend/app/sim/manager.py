"""
Cloud SITL manager (docs/ACCESS_MODEL.md 8b): a premium, per-session PX4 +
Gazebo instance on this server that the session flies like a real drone.

One instance per session, at most cloud_sim_max_per_workspace per
workspace and cloud_sim_max_global on the server. An instance is stopped
when its session ends (the socket did not come back within the 90 s
resume window), after cloud_sim_idle_minutes on the ground, when the
session asks, and on backend shutdown. A backend that died without
stopping them cleans up on its next start (cleanup_orphans) from the
record it keeps in cloud_sim_state_dir, killing only processes that carry
the instance's marker (app/sim/launcher.py).

The socket layer (app/events/cloud_sim_events.py) supplies four hooks:
notify (push a status to the session), link / unlink (open or release the
session's telemetry link to the sim) and is_active (the session holds the
link and the vehicle is armed).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import secrets
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Optional

from app.sim import ports as port_plan
from app.sim.launcher import LaunchHandle, LaunchSpec, ProcessLauncher, tail

logger = logging.getLogger("verocore.sim")

# Refusal / failure codes (cloud_sim_status `code`, error events).
NOT_ENTITLED = "cloud_sim_not_entitled"
QUOTA_WORKSPACE = "cloud_sim_quota_workspace"
QUOTA_GLOBAL = "cloud_sim_quota_global"
UNAVAILABLE = "cloud_sim_unavailable"
BAD_REQUEST = "cloud_sim_bad_request"
FAILED = "cloud_sim_failed"

STARTING, READY, STOPPING = "starting", "ready", "stopping"
LIVE_STATES = (STARTING, READY, STOPPING)

# Kept to one vehicle on purpose (premium extra, not an airframe zoo). Any
# entry needs a gz model without a camera: there is no per-session camera
# feed yet, and a camera renders for nothing.
AIRFRAMES: dict[str, dict] = {
    "x500": {"label": "Quadcopter (x500)", "model": "gz_x500", "autostart": 4001},
}
DEFAULT_AIRFRAME = "x500"

# Registry identity of a cloud sim: synthetic, so it never collides with a
# SITL UID seen on another link (PX4 SITL reports the same UID everywhere).
# A real flight controller's UID is hex, so it can never take this form.
UID_PREFIX = "cloudsim-"

PREMIUM_MSG = ("Cloud simulator is a premium feature that is not enabled for this workspace. "
               "Ask HYRAK to enable it, or fly your own PX4 / Gazebo simulator through the "
               "desktop app's SITL link.")


class SimRefused(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code
        self.msg = msg


@dataclass
class SimInstance:
    sim_id: str
    session_id: str
    workspace_id: str
    username: str
    slot: int
    instance: int
    partition: str
    ports: port_plan.SlotPorts
    airframe: str
    home_lat: float
    home_lon: float
    home_source: str            # custom | workspace | default
    uid_index: int
    workdir: Path
    state: str = STARTING
    started_at: float = field(default_factory=time.time)
    started_mono: float = 0.0
    ready_mono: Optional[float] = None
    last_active: float = 0.0
    handle: Optional[LaunchHandle] = None
    boot_task: Optional[asyncio.Task] = field(default=None, repr=False)

    @property
    def address(self) -> str:
        # Loopback only: nothing off this machine can reach the backend side.
        return f"udpin://127.0.0.1:{self.ports.backend}"

    @property
    def hardware_uid(self) -> str:
        return f"{UID_PREFIX}{self.workspace_id}-{self.uid_index}"


Hook = Callable[[SimInstance], Awaitable[None]]


class CloudSimManager:
    def __init__(self, settings=None, launcher=None, *, slot_check=None,
                 clock: Callable[[], float] = time.monotonic, poll_s: float = 0.5):
        if settings is None:
            from app.config import get_settings
            settings = get_settings()
        self.settings = settings
        if launcher is None:
            px4 = Path(settings.cloud_sim_px4_dir).expanduser() if settings.cloud_sim_px4_dir \
                else Path.home() / "PX4-Autopilot"
            from app.config import ROOT_DIR
            launcher = ProcessLauncher(ROOT_DIR / "simulation" / "cloud_sim.sh", px4)
        self.launcher = launcher
        self.slot_check = slot_check or port_plan.slot_usable
        self.clock = clock
        self.poll_s = poll_s
        self.instances: dict[str, SimInstance] = {}
        # The last way a session's sim ended (error, idle, ...), for status.
        self.last_end: dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self.notify: Optional[Callable[[str], Awaitable[None]]] = None
        self.link: Optional[Hook] = None
        self.unlink: Optional[Hook] = None
        self.is_active: Callable[[SimInstance], bool] = lambda inst: False

    # ── bookkeeping ───────────────────────────────────────────────────────
    @property
    def state_dir(self) -> Path:
        return Path(self.settings.cloud_sim_state_dir)

    def live(self) -> list[SimInstance]:
        return [i for i in self.instances.values() if i.state in LIVE_STATES]

    def for_session(self, session_id: str) -> Optional[SimInstance]:
        for inst in self.live():
            if inst.session_id == session_id:
                return inst
        return None

    def counts(self, workspace_id: str) -> tuple[int, int]:
        live = self.live()
        return sum(1 for i in live if i.workspace_id == workspace_id), len(live)

    def unavailable(self) -> Optional[str]:
        s = self.settings
        if not s.cloud_sim_enabled:
            return "the cloud simulator is switched off on this server"
        why = port_plan.validate_plan(s.cloud_sim_port_base, port_plan.POOL_SLOTS,
                                      s.cloud_sim_instance_base)
        if why:
            return f"bad port plan: {why}"
        return self.launcher.unavailable()

    def _persist(self) -> None:
        """What cleanup_orphans needs if this process dies without stop()."""
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            rows = [{"sim_id": i.sim_id, "session_id": i.session_id, "slot": i.slot,
                     "instance": i.instance, "partition": i.partition,
                     "workdir": str(i.workdir), "pid": i.handle.pid if i.handle else None,
                     "started_at": i.started_at} for i in self.live()]
            tmp = self.state_dir / "instances.json.tmp"
            tmp.write_text(json.dumps(rows, indent=1))
            tmp.replace(self.state_dir / "instances.json")
        except OSError as e:
            logger.warning(f"cloud sim: could not write the instance record: {e}")

    def _remove_workdir(self, workdir: Path) -> None:
        # Only ever a folder this manager made under its own state dir.
        try:
            workdir = Path(workdir).resolve()
            if workdir.parent == self.state_dir.resolve() and workdir.name:
                shutil.rmtree(workdir, ignore_errors=True)
        except OSError:
            pass

    # ── start ─────────────────────────────────────────────────────────────
    async def start(self, session, *, entitled: bool, airframe: Optional[str] = None,
                    home: Optional[dict] = None) -> SimInstance:
        """Start (or return) the session's sim. Raises SimRefused."""
        existing = self.for_session(session.session_id)
        if existing is not None:
            return existing
        if not entitled:
            raise SimRefused(NOT_ENTITLED, PREMIUM_MSG)
        why = self.unavailable()
        if why:
            logger.warning(f"cloud sim unavailable: {why}")
            raise SimRefused(UNAVAILABLE, "The cloud simulator is not available on this server "
                                          "right now." + (f" ({why})" if session.is_staff else ""))
        airframe = airframe or DEFAULT_AIRFRAME
        if airframe not in AIRFRAMES:
            raise SimRefused(BAD_REQUEST, f"Unknown airframe {str(airframe)[:40]!r}. "
                                          f"Choose one of: {', '.join(AIRFRAMES)}.")
        custom = parse_home(home)
        s = self.settings
        async with self._lock:
            existing = self.for_session(session.session_id)
            if existing is not None:
                return existing
            ws_used, global_used = self.counts(session.workspace_id)
            if ws_used >= s.cloud_sim_max_per_workspace:
                raise SimRefused(QUOTA_WORKSPACE,
                                 f"This workspace already runs {ws_used} cloud simulator"
                                 f"{'s' if ws_used != 1 else ''}, its limit. Stop one "
                                 "(or wait for it to stop when idle) and try again.")
            if global_used >= s.cloud_sim_max_global:
                raise SimRefused(QUOTA_GLOBAL,
                                 "Every cloud simulator on this server is in use. Try again in "
                                 "a few minutes.")
            slot = self._free_slot()
            if slot is None:
                raise SimRefused(UNAVAILABLE, "No simulator slot is free on this server right now.")
            if custom is not None:
                lat, lon, source = custom[0], custom[1], "custom"
            else:
                lat, lon, source = await self.default_home(session.workspace_id)
            used_idx = {i.uid_index for i in self.live() if i.workspace_id == session.workspace_id}
            uid_index = next(n for n in range(len(used_idx) + 1) if n not in used_idx)
            sim_id = uuid.uuid4().hex
            now = self.clock()
            inst = SimInstance(
                sim_id=sim_id, session_id=session.session_id,
                workspace_id=session.workspace_id, username=session.username or "",
                slot=slot, instance=s.cloud_sim_instance_base + slot,
                partition=f"hyrak_cloud_{slot}_{secrets.token_hex(4)}",
                ports=port_plan.slot_ports(s.cloud_sim_port_base, slot),
                airframe=airframe, home_lat=lat, home_lon=lon, home_source=source,
                uid_index=uid_index, workdir=self.state_dir / sim_id,
                started_mono=now, last_active=now)
            spec = LaunchSpec(sim_id=sim_id, instance=inst.instance, partition=inst.partition,
                              ports=inst.ports, model=AIRFRAMES[airframe]["model"],
                              autostart=AIRFRAMES[airframe]["autostart"],
                              world=s.cloud_sim_world, home_lat=lat, home_lon=lon,
                              workdir=inst.workdir)
            try:
                inst.handle = await asyncio.to_thread(self.launcher.start, spec)
            except Exception as e:
                logger.exception(f"cloud sim launch failed: {e}")
                self._remove_workdir(inst.workdir)
                raise SimRefused(FAILED, "The simulator could not be started."
                                 + (f" ({e})" if session.is_staff else ""))
            self.instances[sim_id] = inst
            self.last_end.pop(session.session_id, None)
            self._persist()
        logger.info(f"cloud sim {sim_id[:8]} for {inst.username} (session {session.session_id[:8]}, "
                    f"workspace {inst.workspace_id[:8]}): slot {slot}, instance {inst.instance}, "
                    f"udp:{inst.ports.backend}, home {lat:.5f},{lon:.5f} ({source})")
        inst.boot_task = asyncio.create_task(self._boot(inst))
        return inst

    def _free_slot(self) -> Optional[int]:
        taken = {i.slot for i in self.instances.values()}
        s = self.settings
        for slot in range(port_plan.POOL_SLOTS):
            if slot in taken:
                continue
            if self.slot_check(s.cloud_sim_port_base, slot, s.cloud_sim_instance_base):
                return slot
        return None

    async def default_home(self, workspace_id: str) -> tuple[float, float, str]:
        """The workspace's operating area (a point inside it), else the
        server default."""
        s = self.settings
        try:
            from app.auth import service as auth
            ws = await auth.read_store().get_workspace(workspace_id)
            area = ws.operating_area if ws else None
            if area:
                from shapely.geometry import shape
                p = shape(area).representative_point()
                return float(p.y), float(p.x), "workspace"
        except Exception as e:
            logger.debug(f"cloud sim: no operating-area home for {workspace_id[:8]}: {e}")
        return s.cloud_sim_default_lat, s.cloud_sim_default_lon, "default"

    async def _boot(self, inst: SimInstance) -> None:
        deadline = inst.started_mono + self.settings.cloud_sim_boot_timeout_s
        await self._notify(inst)
        try:
            while inst.state == STARTING:
                if self.launcher.ready(inst.handle):
                    inst.state = READY
                    inst.ready_mono = inst.last_active = self.clock()
                    logger.info(f"cloud sim {inst.sim_id[:8]} ready after "
                                f"{inst.ready_mono - inst.started_mono:.0f} s")
                    await self._notify(inst)
                    if self.link is not None:
                        await self.link(inst)
                    return
                if inst.handle.exited() is not None:
                    await self._fail(inst, "The simulator exited while starting.")
                    return
                if self.clock() > deadline:
                    await self._fail(inst, "The simulator did not become ready in time.")
                    return
                await asyncio.sleep(self.poll_s)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception(f"cloud sim {inst.sim_id[:8]} boot watcher failed: {e}")
            await self._fail(inst, "The simulator failed while starting.")

    async def _fail(self, inst: SimInstance, msg: str) -> None:
        detail = tail(inst.handle.log_path) if inst.handle else ""
        logger.warning(f"cloud sim {inst.sim_id[:8]}: {msg}\n{detail}")
        await self.stop(inst, "error", error=msg, detail=detail)

    # ── stop ──────────────────────────────────────────────────────────────
    async def stop(self, inst: SimInstance, reason: str, *, error: Optional[str] = None,
                   detail: str = "") -> None:
        if inst.state not in (STARTING, READY):
            return
        inst.state = STOPPING
        if inst.boot_task is not None and inst.boot_task is not asyncio.current_task():
            inst.boot_task.cancel()
        await self._notify(inst)
        if self.unlink is not None:
            try:
                await self.unlink(inst)
            except Exception as e:
                logger.warning(f"cloud sim {inst.sim_id[:8]}: unlink failed: {e}")
        if inst.handle is not None:
            try:
                await asyncio.to_thread(self.launcher.stop, inst.handle)
            except Exception as e:
                logger.error(f"cloud sim {inst.sim_id[:8]}: stop failed: {e}")
                await asyncio.to_thread(self.launcher.sweep, inst.sim_id)
        self._remove_workdir(inst.workdir)
        inst.state = "stopped"
        self.instances.pop(inst.sim_id, None)
        self._persist()
        self.last_end[inst.session_id] = {
            "reason": reason, "error": error,
            "code": FAILED if error else None,
            # The log tail is for staff only; status() decides.
            "detail": detail,
        }
        # Bounded: only what live sessions could still ask about matters.
        while len(self.last_end) > 500:
            self.last_end.pop(next(iter(self.last_end)))
        logger.info(f"cloud sim {inst.sim_id[:8]} stopped ({reason})")
        await self._notify(inst)

    async def stop_for_session(self, session_id: str, reason: str) -> bool:
        inst = self.for_session(session_id)
        if inst is None:
            return False
        await self.stop(inst, reason)
        return True

    async def shutdown(self) -> None:
        self.stop_background()
        await asyncio.gather(*(self.stop(i, "server_shutdown") for i in self.live()),
                             return_exceptions=True)

    async def _notify(self, inst: SimInstance) -> None:
        if self.notify is None:
            return
        try:
            await self.notify(inst.session_id)
        except Exception as e:
            logger.debug(f"cloud sim status push failed: {e}")

    # ── idle and crash watch ──────────────────────────────────────────────
    async def tick(self) -> None:
        now = self.clock()
        idle_s = self.settings.cloud_sim_idle_minutes * 60.0
        for inst in list(self.live()):
            if inst.state != READY:
                continue
            if inst.handle is not None and inst.handle.exited() is not None:
                await self._fail(inst, "The simulator stopped unexpectedly.")
                continue
            try:
                active = bool(self.is_active(inst))
            except Exception:
                active = False
            if active:
                inst.last_active = now
            elif now - inst.last_active > idle_s:
                await self.stop(inst, "idle")

    def start_background(self, interval_s: float = 10.0) -> None:
        if self._task is not None:
            return

        async def _loop():
            while True:
                await asyncio.sleep(interval_s)
                try:
                    await self.tick()
                except Exception as e:
                    logger.error(f"cloud sim watchdog: {e}")
        self._task = asyncio.create_task(_loop())

    def stop_background(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def cleanup_orphans(self) -> int:
        """At startup: end every instance a previous run of this backend
        recorded and did not stop. Only processes with the instance's marker
        are touched (launcher.sweep)."""
        path = self.state_dir / "instances.json"
        try:
            rows = json.loads(path.read_text())
        except (OSError, ValueError):
            return 0
        n = 0
        for row in rows if isinstance(rows, list) else []:
            sim_id = str(row.get("sim_id") or "")
            if not sim_id.isalnum():
                continue
            n += await asyncio.to_thread(self.launcher.sweep, sim_id)
            self._remove_workdir(self.state_dir / sim_id)
        try:
            path.unlink()
        except OSError:
            pass
        if rows:
            logger.info(f"cloud sim: cleaned up {len(rows)} recorded instance(s), "
                        f"{n} leftover process(es)")
        return n

    # ── status ────────────────────────────────────────────────────────────
    def status(self, session, *, entitled: bool, linked: bool = False) -> dict:
        s = self.settings
        ws_used, global_used = self.counts(session.workspace_id)
        out = {
            "enabled": bool(s.cloud_sim_enabled),
            "entitled": bool(entitled),
            "airframes": [{"id": k, "label": v["label"]} for k, v in AIRFRAMES.items()],
            "quota": {"workspace_used": ws_used, "workspace_max": s.cloud_sim_max_per_workspace,
                      "global_used": global_used, "global_max": s.cloud_sim_max_global},
            "idle_minutes": s.cloud_sim_idle_minutes,
        }
        if not entitled:
            out["message"] = PREMIUM_MSG
        inst = self.for_session(session.session_id)
        if inst is None:
            end = self.last_end.get(session.session_id)
            out["state"] = "error" if end and end.get("error") else "none"
            if end:
                out["ended"] = end["reason"]
                if end.get("error"):
                    out["error"] = end["error"]
                    out["code"] = end["code"]
                if session.is_staff and end.get("detail"):
                    out["detail"] = end["detail"]
            return out
        now = self.clock()
        out.update({
            "state": inst.state,
            "airframe": inst.airframe,
            "home": {"lat": inst.home_lat, "lon": inst.home_lon, "source": inst.home_source},
            "started_at": inst.started_at,
            "boot_s": round(((inst.ready_mono or now) - inst.started_mono), 1),
            "linked": bool(linked),
        })
        if inst.state == READY:
            left = s.cloud_sim_idle_minutes * 60.0 - (now - inst.last_active)
            out["idle_stop_in_s"] = max(0, round(left))
        if session.is_staff:
            out["staff"] = {"address": inst.address, "slot": inst.slot, "instance": inst.instance,
                            "partition": inst.partition, "pid": inst.handle.pid if inst.handle else None,
                            "sim_id": inst.sim_id}
        return out


def parse_home(home) -> Optional[tuple[float, float]]:
    """A customer's home choice, {lat, lon}, or None for the default.
    Raises SimRefused on anything that is not a sane coordinate."""
    if home in (None, {}, ""):
        return None
    if not isinstance(home, dict):
        raise SimRefused(BAD_REQUEST, "home must be {lat, lon}")
    try:
        lat, lon = float(home.get("lat")), float(home.get("lon"))
    except (TypeError, ValueError):
        raise SimRefused(BAD_REQUEST, "home must be {lat, lon} in degrees")
    if not (math.isfinite(lat) and math.isfinite(lon) and -85.0 <= lat <= 85.0
            and -180.0 <= lon <= 180.0):
        raise SimRefused(BAD_REQUEST, "home is outside latitude -85..85 / longitude -180..180")
    return lat, lon


_manager: Optional[CloudSimManager] = None


def get_manager() -> CloudSimManager:
    global _manager
    if _manager is None:
        _manager = CloudSimManager()
    return _manager


def set_manager(m: Optional[CloudSimManager]) -> None:
    """Tests swap in a manager with a fake launcher."""
    global _manager
    _manager = m

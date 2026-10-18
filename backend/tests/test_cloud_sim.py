"""
Cloud SITL (docs/ACCESS_MODEL.md 8b): the port plan, the pool and quotas,
teardown on session end / idle / crash, kill-only-own-processes, the
premium entitlement and the guards, and the simulator-type link.

No PX4 or Gazebo here: the manager runs with a fake launcher, and the
real ProcessLauncher's process control is exercised on `sleep` processes
this test starts itself.
"""
import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.auth import live_scope
from app.auth.store import PLATFORM_WORKSPACE_ID
from app.sim import manager as sim_manager
from app.sim import ports
from app.sim.launcher import LaunchHandle, ProcessLauncher, marker_pids, MARKER
from test_live_scope import live  # noqa: F401  (the fixture)


# ── port plan ────────────────────────────────────────────────────────────

def test_default_plan_is_clear_of_every_reserved_port():
    from app.config import Settings
    s = Settings()
    assert ports.validate_plan(s.cloud_sim_port_base, ports.POOL_SLOTS, s.cloud_sim_instance_base) is None
    owner = {14540, 14541, 14547, 14549, 14550, 14600, 14601, 5600, 5601, 5602, 5603,
             5800, 5850, 5900, 8001, 3000}
    seen = set()
    for slot in range(ports.POOL_SLOTS):
        p = ports.slot_ports(s.cloud_sim_port_base, slot)
        assert len(set(p.all())) == 3
        assert not (set(p.all()) & owner)
        assert not (set(p.all()) & seen)            # slots never share a port
        assert all(ports.reserved_by(x) is None for x in p.all())
        seen |= set(p.all())


@pytest.mark.parametrize("base,why", [
    (14500, "overlap"), (14590, "overlap"), (14595, "overlap"), (5700, "5800"), (40000, "ephemeral"),
    (500, "outside"), (8000, "8001"),
])
def test_plan_refuses_a_base_that_overlaps_the_owner(base, why):
    out = ports.validate_plan(base)
    assert out is not None and why in out


def test_plan_keeps_px4_instances_off_the_owners_and_gcs_ids():
    assert ports.validate_plan(15000, 64, 0) is not None      # 0-99: the owner's sims
    assert ports.validate_plan(15000, 64, 150) is not None    # would reach 213
    assert ports.validate_plan(15000, 64, 100) is None


def test_a_bound_port_makes_its_slot_unusable():
    base = 15700                                       # outside the default pool
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(("127.0.0.1", ports.slot_ports(base, 0).px4))
    except OSError:
        pytest.skip("test port busy on this machine")
    try:
        assert not ports.udp_port_free(ports.slot_ports(base, 0).px4)
        assert not ports.slot_usable(base, 0, 100)
    finally:
        s.close()


# ── manager with a fake launcher ─────────────────────────────────────────

class FakeLauncher:
    def __init__(self):
        self.started, self.stopped, self.swept = [], [], []
        self.ready_ids, self.exit_codes = set(), {}
        self.problem = None

    def unavailable(self):
        return self.problem

    def start(self, spec):
        self.started.append(spec)
        h = LaunchHandle(sim_id=spec.sim_id, pid=100000 + len(self.started),
                         pgid=100000 + len(self.started), log_path=spec.log_path)
        h.exited = lambda sid=spec.sim_id: self.exit_codes.get(sid)
        return h

    def ready(self, handle):
        return handle.sim_id in self.ready_ids

    def stop(self, handle, grace_s=8.0):
        self.stopped.append(handle.sim_id)

    def sweep(self, sim_id):
        self.swept.append(sim_id)
        return 0


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def settings(tmp_path, **kw):
    from app.config import Settings
    base = dict(cloud_sim_enabled=True, cloud_sim_max_global=2, cloud_sim_max_per_workspace=1,
                cloud_sim_idle_minutes=1.0, cloud_sim_boot_timeout_s=30.0,
                cloud_sim_state_dir=tmp_path / "state")
    base.update(kw)
    return Settings(**base)


def sess(sid="s1", ws="ws-a", staff=False, user="pat"):
    return SimpleNamespace(session_id=sid, workspace_id=ws, is_staff=staff, username=user)


@pytest.fixture
def mgr(tmp_path):
    fake, clock = FakeLauncher(), Clock()
    m = sim_manager.CloudSimManager(settings(tmp_path), fake, slot_check=lambda b, s, i: True,
                                    clock=clock, poll_s=0.01)
    m.events, m.notified = [], []

    async def notify(session_id):
        m.notified.append(session_id)

    async def link(inst):
        m.events.append(("link", inst.sim_id))

    async def unlink(inst):
        m.events.append(("unlink", inst.sim_id))
    m.notify, m.link, m.unlink = notify, link, unlink

    async def home(ws):
        return 17.5, 78.1, "default"
    m.default_home = home
    return SimpleNamespace(m=m, fake=fake, clock=clock)


async def started(env, s, **kw):
    inst = await env.m.start(s, entitled=True, **kw)
    env.fake.ready_ids.add(inst.sim_id)
    await asyncio.wait_for(inst.boot_task, 2)
    return inst


async def test_one_sim_per_session_and_it_gets_linked(mgr):
    a = await started(mgr, sess("s1"))
    assert a.state == sim_manager.READY and ("link", a.sim_id) in mgr.m.events
    again = await mgr.m.start(sess("s1"), entitled=True)
    assert again is a and len(mgr.fake.started) == 1
    spec = mgr.fake.started[0]
    assert spec.model == "gz_x500" and spec.autostart == 4001
    assert a.address == f"udpin://127.0.0.1:{spec.ports.backend}"
    assert a.hardware_uid.startswith(live_scope.CLOUD_SIM_UID_PREFIX)
    assert 100 <= a.instance <= 199 and a.partition.startswith("hyrak_cloud_")


async def test_quotas_workspace_then_global(mgr):
    await started(mgr, sess("s1", "ws-a"))
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess("s2", "ws-a"), entitled=True)
    assert e.value.code == sim_manager.QUOTA_WORKSPACE
    await started(mgr, sess("s3", "ws-b"))
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess("s4", "ws-c"), entitled=True)
    assert e.value.code == sim_manager.QUOTA_GLOBAL
    # Freeing one frees its slot and its quota.
    await mgr.m.stop_for_session("s1", "stopped")
    c = await started(mgr, sess("s4", "ws-c"))
    assert c.slot == 0


async def test_entitlement_airframe_home_and_availability(mgr):
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess(), entitled=False)
    assert e.value.code == sim_manager.NOT_ENTITLED and "premium" in e.value.msg
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess(), entitled=True, airframe="cessna")
    assert e.value.code == sim_manager.BAD_REQUEST
    for bad in ({"lat": 91, "lon": 0}, {"lat": "x"}, {"lat": float("nan"), "lon": 1}, "17,78"):
        with pytest.raises(sim_manager.SimRefused):
            await mgr.m.start(sess(), entitled=True, home=bad)
    mgr.fake.problem = "PX4 SITL build missing"
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess(), entitled=True)
    assert e.value.code == sim_manager.UNAVAILABLE and "PX4" not in e.value.msg   # customer
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess(staff=True), entitled=True)
    assert "PX4" in e.value.msg                                                    # staff
    mgr.fake.problem = None
    inst = await started(mgr, sess(), home={"lat": 12.5, "lon": 77.25})
    assert (inst.home_lat, inst.home_lon, inst.home_source) == (12.5, 77.25, "custom")
    assert mgr.fake.started[-1].home_lat == 12.5


async def test_no_free_slot_is_unavailable(mgr):
    mgr.m.slot_check = lambda b, s, i: False
    with pytest.raises(sim_manager.SimRefused) as e:
        await mgr.m.start(sess(), entitled=True)
    assert e.value.code == sim_manager.UNAVAILABLE
    assert not mgr.fake.started


async def test_busy_slot_is_skipped(mgr):
    mgr.m.slot_check = lambda b, s, i: s != 0
    inst = await started(mgr, sess())
    assert inst.slot == 1 and inst.instance == 101


async def test_idle_stops_armed_does_not(mgr):
    inst = await started(mgr, sess())
    active = {"v": True}
    mgr.m.is_active = lambda i: active["v"]
    mgr.clock.t += 600
    await mgr.m.tick()
    assert inst.state == sim_manager.READY               # armed: never idle
    active["v"] = False
    mgr.clock.t += 59
    await mgr.m.tick()
    assert inst.state == sim_manager.READY
    mgr.clock.t += 2
    await mgr.m.tick()
    assert inst.sim_id in mgr.fake.stopped and mgr.m.for_session("s1") is None
    assert ("unlink", inst.sim_id) in mgr.m.events
    st = mgr.m.status(sess(), entitled=True)
    assert st["state"] == "none" and st["ended"] == "idle"


async def test_crash_and_boot_failures_are_reported(mgr):
    inst = await started(mgr, sess("s1"))
    mgr.fake.exit_codes[inst.sim_id] = 1
    await mgr.m.tick()
    st = mgr.m.status(sess("s1"), entitled=True)
    assert st["state"] == "error" and st["code"] == sim_manager.FAILED
    # Exits while booting.
    b = await mgr.m.start(sess("s2", "ws-b"), entitled=True)
    mgr.fake.exit_codes[b.sim_id] = 2
    await asyncio.wait_for(b.boot_task, 2)
    assert mgr.m.status(sess("s2", "ws-b"), entitled=True)["state"] == "error"
    # Never ready.
    c = await mgr.m.start(sess("s3", "ws-c"), entitled=True)
    mgr.clock.t += 31
    await asyncio.wait_for(c.boot_task, 2)
    st = mgr.m.status(sess("s3", "ws-c"), entitled=True)
    assert st["state"] == "error" and "in time" in st["error"]
    assert "detail" not in st                                  # log tail is staff-only
    assert set(mgr.fake.stopped) == {inst.sim_id, b.sim_id, c.sim_id}


async def test_state_file_and_orphan_cleanup(mgr, tmp_path):
    inst = await started(mgr, sess())
    rec = (tmp_path / "state" / "instances.json").read_text()
    assert inst.sim_id in rec
    # A new backend process finds the record and sweeps by marker only.
    fresh = sim_manager.CloudSimManager(mgr.m.settings, mgr.fake, slot_check=lambda *a: True)
    await fresh.cleanup_orphans()
    assert mgr.fake.swept == [inst.sim_id]
    assert not (tmp_path / "state" / "instances.json").exists()


async def test_shutdown_stops_everything(mgr):
    a = await started(mgr, sess("s1", "ws-a"))
    b = await started(mgr, sess("s2", "ws-b"))
    await mgr.m.shutdown()
    assert set(mgr.fake.stopped) == {a.sim_id, b.sim_id} and not mgr.m.live()


def test_exposure_warning_until_acknowledged(tmp_path):
    m = sim_manager.CloudSimManager(settings(tmp_path), FakeLauncher())
    assert m.warn_if_exposed() is True
    m = sim_manager.CloudSimManager(settings(tmp_path, cloud_sim_require_firewall_ack=True), FakeLauncher())
    assert m.warn_if_exposed() is False


def test_px4_link_is_one_loopback_link_without_ftp_or_forwarding():
    from app.config import ROOT_DIR
    rc = (ROOT_DIR / "simulation" / "cloud_sim_rc" / "px4-rc.mavlink").read_text()
    starts = [ln.strip() for ln in rc.splitlines() if ln.strip().startswith("mavlink start")]
    assert len(starts) == 1
    flags = starts[0].split()
    assert "-x" not in flags and "-f" not in flags
    assert flags[flags.index("-t") + 1] == "127.0.0.1"
    code = "\n".join(ln for ln in rc.splitlines() if not ln.lstrip().startswith("#"))
    assert "14550" not in code and "14540" not in code


async def test_status_shapes(mgr):
    st = mgr.m.status(sess(), entitled=False)
    assert st["state"] == "none" and st["entitled"] is False and "premium" in st["message"]
    inst = await started(mgr, sess())
    st = mgr.m.status(sess(), entitled=True, linked=True)
    assert st["state"] == "ready" and st["linked"] and "staff" not in st
    assert "address" not in st                     # the customer never sees or sends one
    staff = mgr.m.status(sess("other", staff=True), entitled=True)
    assert staff["state"] == "none"                # another session's sim is not theirs
    inst.session_id = "staff-s"
    st = mgr.m.status(sess("staff-s", staff=True), entitled=True)
    assert st["staff"]["address"] == inst.address


# ── the real launcher touches only its own processes ─────────────────────

def _spawn_sleep(marker=None):
    env = dict(os.environ)
    env.pop(MARKER, None)
    if marker:
        env[MARKER] = marker
    return subprocess.Popen(["sleep", "60"], env=env, start_new_session=True)


def test_marker_sweep_kills_only_marked_processes(tmp_path):
    launcher = ProcessLauncher(tmp_path / "none.sh", tmp_path)
    mine = _spawn_sleep("sim0123abcd")
    other = _spawn_sleep("sim9999ffff")
    plain = _spawn_sleep(None)
    try:
        time.sleep(0.2)
        assert marker_pids("sim0123abcd") == [mine.pid]
        assert os.getpid() not in marker_pids("sim0123abcd")
        assert launcher.sweep("sim0123abcd") == 1
        assert mine.wait(timeout=5) == -signal.SIGKILL
        assert other.poll() is None and plain.poll() is None
    finally:
        for p in (mine, other, plain):
            if p.poll() is None:
                p.kill()
                p.wait()


def test_ready_means_px4_opened_the_backend_link(tmp_path):
    from app.sim.launcher import log_says_ready
    log = tmp_path / "sim.log"
    log.write_text("INFO  [init] Gazebo world is ready\n"
                   "WARN  [health_and_arming_checks] Preflight Fail: No connection to the GCS\n")
    assert not log_says_ready(log)
    with open(log, "a") as f:
        f.write("INFO  [mavlink] mode: Normal, data rate: 4000000 B/s on udp port 15001 remote port 15000\n")
    assert log_says_ready(log)
    assert not log_says_ready(tmp_path / "missing.log")


def test_marker_scan_needs_an_exact_match(tmp_path):
    root = tmp_path / "proc"
    for pid, env in ((11, b"A=1\0HYRAK_CLOUD_SIM_ID=abc\0"), (12, b"HYRAK_CLOUD_SIM_ID=abcd\0"),
                     (13, b"X=HYRAK_CLOUD_SIM_ID=abc\0"), (14, b"")):
        (root / str(pid)).mkdir(parents=True)
        (root / str(pid) / "environ").write_bytes(env)
    (root / "self").mkdir()
    assert marker_pids("abc", proc_root=str(root)) == [11]


def test_launcher_stop_ends_its_group_and_spares_others(tmp_path):
    script = tmp_path / "fake_sim.sh"
    # Stands in for cloud_sim.sh: a child that ignores SIGINT (as gz does
    # SIGTERM) plus a foreground wait.
    script.write_text("#!/usr/bin/env bash\n"
                      "trap '' INT\n"
                      "sleep 60 &\n"
                      "echo 'Ready for takeoff'\n"
                      "wait\n")
    launcher = ProcessLauncher(script, tmp_path)
    bystander = _spawn_sleep(None)
    from app.sim.launcher import LaunchSpec
    spec = LaunchSpec(sim_id="feedface01", instance=100, partition="hyrak_test", ports=ports.slot_ports(15000, 0),
                      model="gz_x500", autostart=4001, world="default", home_lat=1.0, home_lon=2.0,
                      workdir=tmp_path / "w")
    # Run the fake script directly (ProcessLauncher.start passes cloud_sim
    # flags it does not need; bash ignores extra args).
    h = launcher.start(spec)
    try:
        deadline = time.time() + 5
        while not launcher.ready(h) and time.time() < deadline:
            time.sleep(0.05)
        assert launcher.ready(h)
        assert len(marker_pids("feedface01")) >= 2
        launcher.stop(h, grace_s=1.0)
        assert marker_pids("feedface01") == []
        assert h.exited() is not None
        assert bystander.poll() is None
    finally:
        if bystander.poll() is None:
            bystander.kill()
            bystander.wait()
        launcher.sweep("feedface01")


# ── through the socket layer ─────────────────────────────────────────────

@pytest.fixture
def live_sim(live, tmp_path, monkeypatch):
    """The live-scope fixture with a fake-launcher manager wired into the
    real socket handlers."""
    from app.events import admin_events
    from app.server import create_app
    fake = FakeLauncher()
    m = sim_manager.CloudSimManager(settings(tmp_path), fake, slot_check=lambda *a: True, poll_s=0.01)

    async def home(ws):
        return 17.5, 78.1, "default"
    m.default_home = home
    sim_manager.set_manager(m)
    asgi = create_app()
    sio = admin_events._sio
    rec = live.rec
    monkeypatch.setattr(sio, "emit", rec.emit)
    monkeypatch.setattr(sio, "disconnect", rec.disconnect)
    monkeypatch.setattr(sio, "enter_room", rec.enter_room)
    from fastapi.testclient import TestClient
    api = asgi.other_asgi_app
    yield SimpleNamespace(sio=sio, rec=rec, cl=TestClient(api), sm=api.state.session_manager,
                          pool=api.state.vision_pool, m=m, fake=fake)
    sim_manager.set_manager(None)


async def test_socket_guards_entitlement_and_staff(live_sim):
    from test_live_scope import world, connect, errors, ok, hdr
    lv = live_sim
    w = await world(lv)
    h = lv.sio.handlers["/"]
    await connect(lv, "v", w.vic[1])
    await connect(lv, "p", w.pat[1])
    await connect(lv, "op", w.hp[1])
    # Viewer: no fly, refused by the guard.
    await h["start_cloud_sim"]("v", {})
    assert errors(lv, "v")[-1]["code"] == "forbidden" and not lv.fake.started
    # Customer pilot, workspace without the premium feature.
    out = await h["start_cloud_sim"]("p", {})
    assert out["code"] == sim_manager.NOT_ENTITLED and not lv.fake.started
    assert lv.rec.of("cloud_sim_status", "p")[-1]["entitled"] is False
    # Only a founder switches it on; the workspace owner cannot.
    r = lv.cl.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.olga[1]),
                    json={"features": {"cloud_sim": True}})
    assert r.status_code == 403
    r = lv.cl.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.founder[1]),
                    json={"features": {"cloud_sim": "yes"}})
    assert r.status_code == 400
    ws = ok(lv.cl.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.founder[1]),
                        json={"features": {"cloud_sim": True}}))["workspace"]
    assert ws["features"] == {"cloud_sim": True}
    out = await h["start_cloud_sim"]("p", {"address": "udp://:14600"})   # an address is ignored
    assert out["state"] == "starting" and out["entitled"] is True
    assert lv.fake.started[-1].ports.backend >= 15000
    # Staff: always entitled (HYRAK workspace, no feature flag).
    out = await h["start_cloud_sim"]("op", {})
    assert out["state"] == "starting" and "staff" in out
    # The viewer may ask for status and stop (their own: none).
    assert (await h["cloud_sim_status"]("v"))["state"] == "none"
    # Stop is a session-view event and ends the pilot's sim.
    out = await h["stop_cloud_sim"]("p")
    assert out["state"] == "none" and len(lv.fake.stopped) == 1
    await lv.m.shutdown()


async def test_session_teardown_stops_the_sim(live_sim, monkeypatch):
    from app import server
    from test_live_scope import world, connect, session
    lv = live_sim
    w = await world(lv)
    await connect(lv, "op", w.hp[1])
    inst = await lv.m.start(session(lv, "op"), entitled=True)
    monkeypatch.setattr(server, "SESSION_GRACE_S", 0.05)
    await lv.sio.handlers["/"]["disconnect"]("op")
    assert lv.m.for_session(inst.session_id) is inst         # held during the grace window
    for _ in range(100):
        if inst.sim_id in lv.fake.stopped:
            break
        await asyncio.sleep(0.02)
    assert inst.sim_id in lv.fake.stopped and lv.m.for_session(inst.session_id) is None


async def test_ready_sim_links_the_session_as_a_simulated_drone(live_sim, monkeypatch):
    """When the sim is ready the server links the session to the address
    it chose, origin start_cloud_sim, with the synthetic identity."""
    from app.registry import drones as registry
    from app.telemetry import manager as tel_manager
    from test_live_scope import world, connect, session, ok, hdr
    lv = live_sim
    w = await world(lv)
    ok(lv.cl.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.founder[1]),
                   json={"features": {"cloud_sim": True}}))
    await connect(lv, "p", w.pat[1])
    s = session(lv, "p")
    dialled, seen = [], []

    class FakeTel:
        def __init__(self, **kw):
            self.address, self.is_connected = None, False
            self.snapshot = SimpleNamespace(flight_mode=SimpleNamespace(is_armed=False))

        def set_calibration_listener(self, fn): pass
        def set_link_kind(self, k): dialled.append(("kind", k))

        async def connect(self, address):
            dialled.append(address)
            self.address, self.is_connected = address, True
            return True

        async def start(self): pass
        async def stop(self): self.is_connected = False
        async def download_mission(self): return []
        async def get_hardware_uid(self): return "0011AABB"   # the FC's: must not be used

    async def upsert(uid, is_simulated=False, claim_workspace_id=None):
        seen.append((uid, is_simulated, claim_workspace_id))
        return {"id": "d-sim", "name": "sim", "is_simulated": is_simulated,
                "workspace_id": claim_workspace_id or PLATFORM_WORKSPACE_ID}
    monkeypatch.setattr(tel_manager, "TelemetryManager", FakeTel)
    monkeypatch.setattr(registry, "upsert_seen", upsert)
    from app.zones import fence

    async def no_fence(m): return None
    monkeypatch.setattr(fence, "upload_red_fence", no_fence)

    out = await lv.sio.handlers["/"]["start_cloud_sim"]("p", {})
    assert out["state"] == "starting"
    inst = lv.m.for_session(s.session_id)
    lv.fake.ready_ids.add(inst.sim_id)
    await asyncio.wait_for(inst.boot_task, 3)
    for _ in range(100):
        if seen:
            break
        await asyncio.sleep(0.02)
    assert dialled[-1] == inst.address == f"udpin://127.0.0.1:{inst.ports.backend}"
    assert seen == [(inst.hardware_uid, True, None)]         # simulated, never claimed
    assert s.link_simulated is True and s.drone_fly is True
    st = lv.rec.of("cloud_sim_status", "p")[-1]
    assert st["state"] == "ready" and st["linked"] is True
    # Stopping the sim releases the link.
    await lv.sio.handlers["/"]["stop_cloud_sim"]("p")
    assert lv.rec.of("telemetry_status", "p")[-1]["status"] == "disconnected"
    assert s.link_simulated is False


# ── link kind and identity rules ─────────────────────────────────────────

def test_cloud_sim_link_kind_comes_from_its_handler():
    lk = live_scope.link_kind_for
    assert lk("start_cloud_sim", "udpin://127.0.0.1:15000", has_bridge=False) == live_scope.CLOUD_SIM_LINK
    # The same loopback address from any other handler is not a cloud sim.
    assert lk("connect_browser_serial", "udpin://127.0.0.1:15000", has_bridge=True) == live_scope.RELAY_LINK
    assert lk("connect_telemetry", "udpin://127.0.0.1:15000", has_bridge=False) == live_scope.SIM_LINK


async def test_customer_cloud_sim_identity_is_simulated_only_with_its_uid(monkeypatch):
    from app.registry import drones as registry
    seen = []

    async def upsert(uid, is_simulated=False, claim_workspace_id=None):
        seen.append((uid, is_simulated, claim_workspace_id))
        return {"id": "d", "is_simulated": is_simulated,
                "workspace_id": claim_workspace_id or PLATFORM_WORKSPACE_ID}
    monkeypatch.setattr(registry, "upsert_seen", upsert)
    s = SimpleNamespace(is_staff=False, workspace_id="ws-a", session_id="s", user_id="u",
                        username="pat", client_ip="", memberships=())
    await live_scope.identify_drone(s, "cloudsim-ws-a-0", link_kind=live_scope.CLOUD_SIM_LINK)
    assert seen[-1] == ("cloudsim-ws-a-0", True, None)
    assert s.link_simulated is True and s.drone_fly is True
    # A UID that is not the server's synthetic one gets the normal rules,
    # whatever the link kind says.
    await live_scope.identify_drone(s, "0011AABB", link_kind=live_scope.CLOUD_SIM_LINK)
    assert seen[-1] == ("0011AABB", False, "ws-a") and s.link_simulated is False
    # And the synthetic UID on a customer relay is not simulator-type.
    await live_scope.identify_drone(s, "cloudsim-ws-a-0", link_kind=live_scope.RELAY_LINK)
    assert s.link_simulated is False

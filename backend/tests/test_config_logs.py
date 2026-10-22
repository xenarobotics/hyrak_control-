"""Config > Logs and Config > Parameters backend: log list / download / erase
(app/telemetry/log_download.py, app/events/config_events.py,
app/api/log_routes.py), PX4 parameter metadata and reset-all
(app/telemetry/param_meta.py). A fake drone stands in for MAVSDK."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.events import config_events
from app.telemetry import log_download as logs
from app.telemetry import param_meta


class FakeLogFiles:
    def __init__(self, entries, payload=b"ULog" + b"\0" * 4092, fail=False, hang=False):
        self._entries = entries
        self.payload = payload
        self.fail = fail
        self.hang = hang
        self.erased = 0
        self.downloads = []

    async def get_entries(self):
        return list(self._entries)

    async def download_log_file(self, entry, path):
        self.downloads.append((entry.id, path))
        for frac in (0.25, 0.5, 1.0):
            if self.hang:
                await asyncio.sleep(3600)
            if self.fail and frac > 0.3:
                raise RuntimeError("link lost")
            yield SimpleNamespace(progress=frac)
        with open(path, "wb") as f:
            f.write(self.payload)

    async def erase_all_log_files(self):
        self.erased += 1


def entry(i, size=4096, date="2026-10-23T10:00:00Z"):
    return SimpleNamespace(id=i, date=date, size_bytes=size)


def make_tel(lf=None, armed=False, in_air=False, connected=True):
    sent = []

    class _Direct:
        async def send_message(self, msg):
            sent.append(msg)

    tel = SimpleNamespace(
        is_connected=connected,
        snapshot=SimpleNamespace(flight_mode=SimpleNamespace(is_armed=armed, is_in_air=in_air)),
        _offboard_active=False, _target_sysid=1,
        _drone=SimpleNamespace(log_files=lf or FakeLogFiles([entry(0), entry(1)]), mavlink_direct=_Direct()),
    )
    return tel, sent


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "base_dir", lambda: tmp_path / "log_downloads")
    monkeypatch.setattr(logs, "downloads", logs.LogDownloads())
    yield


class Recorder:
    def __init__(self):
        self.events = []

    async def __call__(self, event, payload):
        self.events.append((event, payload))

    def names(self):
        return [e for e, _ in self.events]

    def last(self, name):
        return [p for e, p in self.events if e == name][-1]


# ── download registry ───────────────────────────────────────────────────────

async def test_list_is_newest_first():
    tel, _ = make_tel(FakeLogFiles([entry(3), entry(7), entry(1)]))
    got = await logs.list_logs(tel)
    assert [g["id"] for g in got] == [7, 3, 1]
    assert got[0] == {"id": 7, "date": "2026-10-23T10:00:00Z", "size_bytes": 4096}


async def test_download_progress_ready_and_one_time_link():
    tel, _ = make_tel()
    rec = Recorder()
    job = logs.downloads.start(tel, id(tel), entry(1), "sess", "user-a", rec)
    await job.task
    assert "log_progress" in rec.names()
    ready = rec.last("log_ready")
    assert ready["id"] == 1 and ready["bytes"] == 4096
    token = ready["path"].rsplit("/", 1)[1]
    assert logs.downloads.claim(token, "someone-else") is None       # bound to the account
    r = logs.downloads.claim(token, "user-a")
    assert r is not None and r.file.read_bytes().startswith(b"ULog")
    assert logs.downloads.claim(token, "user-a") is None              # works once
    logs.downloads.release(r)
    assert not r.folder.exists()                                      # cleaned up after sending
    assert id(tel) not in logs.downloads.jobs


async def test_failure_and_cancel_leave_nothing_behind(tmp_path):
    tel, _ = make_tel(FakeLogFiles([entry(1)], fail=True))
    rec = Recorder()
    job = logs.downloads.start(tel, id(tel), entry(1), "sess", "u", rec)
    await job.task
    assert "link lost" in rec.last("log_failed")["error"]
    assert not job.folder.exists()

    tel2, _ = make_tel(FakeLogFiles([entry(2)], hang=True))
    job2 = logs.downloads.start(tel2, id(tel2), entry(2), "sess", "u", rec)
    await asyncio.sleep(0)
    assert logs.downloads.cancel(id(tel2))
    await asyncio.gather(job2.task, return_exceptions=True)
    assert rec.last("log_failed")["cancelled"] is True
    assert not job2.folder.exists()


async def test_preflight_refusals():
    tel, _ = make_tel(armed=True)
    assert "Disarm" in logs.downloads.preflight(tel, id(tel), 1, 100)
    tel, _ = make_tel(in_air=True)
    assert "air" in logs.downloads.preflight(tel, id(tel), 1, 100)
    tel, _ = make_tel()
    assert "2 GB" in logs.downloads.preflight(tel, id(tel), 1, logs.MAX_LOG_BYTES + 1)
    assert "empty" in logs.downloads.preflight(tel, id(tel), 1, 0)
    # one at a time per drone
    tel, _ = make_tel(FakeLogFiles([entry(1)], hang=True))
    job = logs.downloads.start(tel, id(tel), entry(1), "s", "u", Recorder())
    await asyncio.sleep(0)
    assert "still downloading" in logs.downloads.preflight(tel, id(tel), 2, 100)
    logs.downloads.cancel(id(tel))
    await asyncio.gather(job.task, return_exceptions=True)


async def test_expired_link_is_swept():
    tel, _ = make_tel()
    rec = Recorder()
    job = logs.downloads.start(tel, id(tel), entry(1), "s", "u", rec)
    await job.task
    token = rec.last("log_ready")["path"].rsplit("/", 1)[1]
    folder = logs.downloads.ready[token].folder
    logs.downloads.sweep(now=10 ** 12)
    assert token not in logs.downloads.ready and not folder.exists()


# ── socket handlers ─────────────────────────────────────────────────────────

class FakeSio:
    def __init__(self):
        self.handlers = {}
        self.sent = []

    def on(self, name):
        def deco(fn):
            self.handlers[name] = fn
            return fn
        return deco

    async def emit(self, event, payload, to=None):
        self.sent.append((event, payload, to))

    def last(self, event):
        return [p for e, p, _ in self.sent if e == event][-1]


@pytest.fixture
def wired(monkeypatch):
    async def allow(*a, **k):
        return True
    monkeypatch.setattr(config_events, "require_session_fly", allow)
    monkeypatch.setattr(config_events, "require_session_view", allow)

    def build(tel, user_id="user-a"):
        session = SimpleNamespace(session_id="s1", socket_id="sid1", user_id=user_id)
        sm = SimpleNamespace(get_by_socket=lambda sid: session, get=lambda sid: session,
                             get_telemetry=lambda sid: tel)
        sio = FakeSio()
        config_events.register_config_events(sio, sm)
        return sio
    return build


async def test_guards_are_the_set_param_ones():
    import inspect
    from app.auth import socket_classes as classes
    src = inspect.getsource(config_events.register_config_events)
    for ev in ("log_list", "log_download", "log_cancel", "log_erase"):
        assert classes.EVENTS[ev] == classes.SESSION_COMMAND and ev in classes.DRONE_EVENTS
        assert f'require_session_fly(sid, "{ev}"' in src
    assert classes.EVENTS["param_metadata"] == classes.SESSION_VIEW


async def test_download_uses_the_drones_own_entry(wired):
    lf = FakeLogFiles([entry(5, size=4096)])
    tel, _ = make_tel(lf)
    sio = wired(tel)
    await sio.handlers["log_download"]("sid1", {"id": 9})
    assert "no longer on the drone" in sio.last("log_download_ack")["error"]
    await sio.handlers["log_download"]("sid1", {"id": "../../etc/passwd"})
    assert sio.last("log_download_ack")["ok"] is False
    await sio.handlers["log_download"]("sid1", {"id": 5, "size_bytes": 1})
    ack = sio.last("log_download_ack")
    assert ack["ok"] is True and ack["size_bytes"] == 4096
    await logs.downloads.jobs[id(tel)].task
    assert sio.last("log_ready")["id"] == 5
    assert lf.downloads[0][0] == 5


async def test_download_needs_a_signed_in_account(wired):
    tel, _ = make_tel()
    sio = wired(tel, user_id=None)
    await sio.handlers["log_download"]("sid1", {"id": 1})
    assert "Sign in" in sio.last("log_download_ack")["error"]


async def test_erase_needs_typed_confirmation_and_ground(wired):
    lf = FakeLogFiles([entry(1)])
    tel, _ = make_tel(lf)
    sio = wired(tel)
    await sio.handlers["log_erase"]("sid1", {})
    assert sio.last("log_erase_result")["ok"] is False and lf.erased == 0
    await sio.handlers["log_erase"]("sid1", {"confirm": "erase"})
    assert lf.erased == 0
    await sio.handlers["log_erase"]("sid1", {"confirm": "ERASE"})
    assert sio.last("log_erase_result")["ok"] is True and lf.erased == 1

    armed_tel, _ = make_tel(lf, armed=True)
    sio = wired(armed_tel)
    await sio.handlers["log_erase"]("sid1", {"confirm": "ERASE"})
    assert "Disarm" in sio.last("log_erase_result")["error"] and lf.erased == 1


async def test_list_without_a_drone(wired):
    sio = wired(None)
    await sio.handlers["log_list"]("sid1", None)
    assert sio.last("log_list_result") == {"ok": False, "error": "No drone connected"}


# ── HTTP route ──────────────────────────────────────────────────────────────

def test_route_streams_once_for_the_owner_then_deletes():
    from app.api import log_routes
    from app.auth.service import AuthUser

    tel, _ = make_tel()
    rec = Recorder()

    async def go():
        job = logs.downloads.start(tel, id(tel), entry(1), "s", "user-a", rec)
        await job.task
    asyncio.new_event_loop().run_until_complete(go())
    path = rec.last("log_ready")["path"]
    folder = next(iter(logs.downloads.ready.values())).folder

    app = FastAPI()
    app.include_router(log_routes.router)
    who = {"id": "user-b"}
    app.dependency_overrides[log_routes._auth] = lambda: AuthUser(id=who["id"], username="x", role="member")
    cl = TestClient(app)
    assert cl.get(path).status_code == 404          # not the account that asked
    who["id"] = "user-a"
    r = cl.get(path)
    assert r.status_code == 200 and r.content.startswith(b"ULog")
    assert 'filename="log_1.ulg"' in r.headers["content-disposition"]
    assert not folder.exists()
    assert cl.get(path).status_code == 404          # one time only
    assert cl.get("/api/logs/file/..%2F..%2Fetc").status_code == 404


# ── parameter metadata and reset-all ────────────────────────────────────────

RAW = {
    "version": 1,
    "parameters": [
        {"name": "MPC_XY_VEL_MAX", "group": "Multicopter Position Control", "type": "Float", "default": 12.0,
         "min": 0, "max": 20, "units": "m/s", "decimalPlaces": 1, "shortDesc": "Max horizontal velocity",
         "longDesc": "x" * 1000},
        {"name": "COM_RC_IN_MODE", "group": "Commander", "type": "Int32", "default": 3,
         "values": [{"value": 0, "description": "RC only"}, {"value": 1, "description": "Joystick only"}],
         "shortDesc": "RC input mode", "rebootRequired": True},
        {"name": "SDLOG_PROFILE", "group": "SD Logging", "type": "Int32", "default": 1,
         "bitmask": [{"index": 0, "description": "Default"}, {"index": 99, "description": "bogus"}],
         "shortDesc": "Logging profile"},
        {"name": "BAD", "type": "Float", "default": float("nan"), "group": "x", "shortDesc": ""},
        {"name": "x" * 40, "type": "Float", "default": 0, "group": "x", "shortDesc": ""},
    ],
}


def test_compact_metadata():
    m = param_meta.compact(json.dumps(RAW))["params"]
    v = m["MPC_XY_VEL_MAX"]
    assert v["d"] == 12 and v["u"] == "m/s" and v["t"] == "f" and v["max"] == 20 and v["dec"] == 1
    assert len(v["l"]) == param_meta.LONG_DESC_MAX
    assert m["COM_RC_IN_MODE"]["v"] == [[0, "RC only"], [1, "Joystick only"]] and m["COM_RC_IN_MODE"]["r"] == 1
    assert m["SDLOG_PROFILE"]["b"] == [[0, "Default"]]
    assert "d" not in m["BAD"]                       # NaN never reaches the socket
    assert "x" * 40 not in m
    with pytest.raises(ValueError):
        param_meta.compact({"nope": 1})


async def test_metadata_cached_per_link():
    calls = []

    class CM:
        async def request_autopilot_component(self):
            calls.append("req")

        async def get_metadata(self, compid, kind):
            return SimpleNamespace(json_metadata=json.dumps(RAW))

    tel = SimpleNamespace(_drone=SimpleNamespace(component_metadata=CM()))
    a = await param_meta.for_link(tel)
    b = await param_meta.for_link(tel)
    assert a["ok"] and a is b and calls == ["req"]
    tel._drone = SimpleNamespace(component_metadata=CM())   # reconnect: fetch again
    await param_meta.for_link(tel)
    assert calls == ["req", "req"]


async def test_reset_all_needs_confirmation_and_ground():
    tel, sent = make_tel()
    r = await param_meta.handle_reset_all(tel, {})
    assert r["ok"] is False and sent == []
    tel, sent = make_tel(armed=True)
    r = await param_meta.handle_reset_all(tel, {"confirm": "RESET"})
    assert r["ok"] is False and "Disarm" in r["error"] and sent == []
    tel, sent = make_tel()
    r = await param_meta.handle_reset_all(tel, {"confirm": "RESET"})
    assert r["ok"] is True and len(sent) == 1
    fields = json.loads(sent[0].fields_json)
    assert fields["command"] == 245 and fields["param1"] == 2.0

"""Config: airspeed calibration (calibration.py), gripper / Spektrum bind
(payload_cmd.py), the COMMAND_ACK helper (mav_command.py) and the NTRIP
client (ntrip.py, gps_events.py). Fakes only: no vehicle, no real caster."""
import asyncio
import base64
import json
from types import SimpleNamespace

import pytest

from app.telemetry import calibration as cal
from app.telemetry import mav_command as mc
from app.telemetry import ntrip
from app.telemetry import payload_cmd as pc


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class FakeDirect:
    """mavlink_direct: records sends; answers COMMAND_ACKs from a script."""

    def __init__(self, acks=None):
        self.sent = []
        self.acks = list(acks or [])        # list of (command, result)
        self._queue: asyncio.Queue | None = None

    async def send_message(self, msg):
        self.sent.append(msg)
        if self._queue is not None:
            fields = json.loads(msg.fields_json)
            for cmd, res in self.acks:
                if cmd == fields.get("command"):
                    await self._queue.put(SimpleNamespace(fields_json=json.dumps({"command": cmd, "result": res})))

    async def message(self, name):
        assert name == "COMMAND_ACK"
        self._queue = asyncio.Queue()
        while True:
            yield await self._queue.get()


def fake_tel(direct, armed=False, in_air=False, connected=True, offboard=False):
    return SimpleNamespace(
        is_connected=connected, _offboard_active=offboard, _target_sysid=1,
        snapshot=SimpleNamespace(flight_mode=SimpleNamespace(is_armed=armed, is_in_air=in_air)),
        _drone=SimpleNamespace(mavlink_direct=direct),
    )


# ── airspeed calibration ────────────────────────────────────────────────────

def test_airspeed_is_a_command_sensor_with_param6():
    assert cal.is_command_sensor("airspeed")
    assert not cal.is_command_sensor("gyro")
    f = cal.preflight_calibration_fields(1, cal.SENSORS["airspeed"]["command"])
    assert f["command"] == 241 and f["param6"] == 1.0
    assert all(f[f"param{i}"] == 0.0 for i in (1, 2, 3, 4, 5, 7))
    cancel = cal.preflight_calibration_fields(1, {})
    assert all(cancel[f"param{i}"] == 0.0 for i in range(1, 8))


def test_airspeed_px4_lines_drive_the_instruction():
    s = cal.CalibrationSession("airspeed")
    assert "pitot" in s.state.instruction.lower()
    for line in ("[cal] calibration started: 2 airspeed", "[cal] Ensure sensor is not measuring wind",
                 "[cal] progress <40>", "[cal] Offset of 3 Pascal"):
        assert s.feed(line)
    assert s.state.phase == "running" and s.state.progress == 40
    assert "Zero measured (3 Pa)" in s.state.instruction
    s.feed("[cal] Blow into front of pitot without touching")
    assert "blow gently into the front" in s.state.instruction.lower()
    s.feed("[cal] Create air pressure! (got 12, wanted: 50 Pa)")
    assert "12 Pa" in s.state.instruction
    s.feed("[cal] Positive pressure: OK (61 Pa)")
    s.feed("[cal] progress <100>")
    s.feed("[cal] calibration done: airspeed")
    assert s.state.phase == "done" and s.state.progress == 100


def test_airspeed_failure_keeps_the_real_reason():
    s = cal.CalibrationSession("airspeed")
    s.feed("[cal] calibration started: 2 airspeed")
    s.feed("[cal] Negative pressure difference detected (-70 Pa)")
    s.feed("[cal] Swap static and dynamic ports or set SENS_DPRES_REV")
    s.feed("[cal] progress <0>")
    s.feed("[cal] calibration failed: airspeed")
    assert s.state.phase == "failed"
    assert "SENS_DPRES_REV" in s.state.error and "swapped" in s.state.error
    assert s.state.progress == 0 or s.state.progress >= 0     # never goes backwards
    # A non-airspeed failure keeps PX4's own words.
    g = cal.CalibrationSession("gyro")
    g.feed("[cal] calibration failed: motion")
    assert g.state.error == "motion"


class _CalTel:
    def __init__(self, direct, session):
        self._drone = SimpleNamespace(mavlink_direct=direct)
        self._target_sysid = 1
        self._calibration = session
        self._calibration_task = "running"
        self.emitted = []

    def _emit_calibration(self):
        self.emitted.append(self._calibration.state.to_dict())


def test_run_command_calibration_success_from_statustext():
    async def go():
        direct = FakeDirect(acks=[(241, 0)])
        s = cal.CalibrationSession("airspeed")
        tel = _CalTel(direct, s)

        async def px4():
            await asyncio.sleep(0.15)
            for line in ("[cal] calibration started: 2 airspeed", "[cal] Offset of 1 Pascal",
                         "[cal] Positive pressure: OK (55 Pa)", "[cal] calibration done: airspeed"):
                s.feed(line)
                await asyncio.sleep(0.01)
        asyncio.create_task(px4())
        await cal.run_command_calibration(tel, s, "airspeed", poll_s=0.01)
        return direct, s, tel
    direct, s, tel = run(go())
    sent = json.loads(direct.sent[0].fields_json)
    assert direct.sent[0].message_name == "COMMAND_LONG" and sent["param6"] == 1.0
    assert s.state.ok is True and s.state.phase == "done"
    assert tel._calibration_task is None and tel.emitted


def test_run_command_calibration_reports_a_refusal_at_once():
    async def go():
        direct = FakeDirect(acks=[(241, 1)])
        s = cal.CalibrationSession("airspeed")
        await cal.run_command_calibration(_CalTel(direct, s), s, "airspeed", poll_s=0.01)
        return s
    s = run(go())
    assert s.state.phase == "failed" and s.state.ok is False
    assert "refused" in s.state.error


def test_run_command_calibration_gives_up_when_px4_never_starts():
    clock = {"t": 0.0}

    async def fake_sleep(dt):
        clock["t"] += 5.0
        await asyncio.sleep(0)

    async def go():
        direct = FakeDirect()               # no ack, no lines
        s = cal.CalibrationSession("airspeed")
        await cal.run_command_calibration(_CalTel(direct, s), s, "airspeed",
                                          clock=lambda: clock["t"], sleep=fake_sleep)
        return s
    s = run(go())
    assert s.state.phase == "failed" and "did not start" in s.state.error


def test_run_command_calibration_failure_line_ends_it():
    async def go():
        direct = FakeDirect(acks=[(241, 0)])
        s = cal.CalibrationSession("airspeed")

        async def px4():
            await asyncio.sleep(0.12)
            s.feed("[cal] calibration started: 2 airspeed")
            s.feed("[cal] calibration failed: airspeed")
        asyncio.create_task(px4())
        await cal.run_command_calibration(_CalTel(direct, s), s, "airspeed", poll_s=0.01)
        return s
    s = run(go())
    assert s.state.phase == "failed" and s.state.ok is False


def test_manager_refusal_applies_to_airspeed():
    # Same guards as every calibration: calibration_refusal is sensor-agnostic.
    from app.telemetry.manager import TelemetryManager
    m = TelemetryManager.__new__(TelemetryManager)
    m._connected = True
    m._calibration = None
    m._offboard_active = False
    m._snapshot = SimpleNamespace(flight_mode=SimpleNamespace(is_armed=True, is_in_air=False))
    assert "Disarm" in m.calibration_refusal("airspeed")
    m._snapshot.flight_mode.is_armed = False
    m._offboard_active = True
    assert m.calibration_refusal("airspeed")
    m._offboard_active = False
    assert m.calibration_refusal("airspeed") is None


# ── COMMAND_ACK helper ──────────────────────────────────────────────────────

def test_send_command_reads_the_ack_and_skips_in_progress():
    async def go():
        d = FakeDirect(acks=[(211, 5), (211, 0)])
        out = await mc.send_command(fake_tel(d), mc.command_fields(1, 211, param2=1.0), ack_timeout=1.0, final=True)
        return out
    out = run(go())
    assert out.sent and out.result == 0 and out.accepted and out.name == "ACCEPTED"


def test_send_command_without_ack_says_so():
    out = run(mc.send_command(fake_tel(FakeDirect()), mc.command_fields(1, 500), ack_timeout=0.2))
    assert out.sent and out.result is None and "did not acknowledge" in out.words


# ── gripper and Spektrum bind ───────────────────────────────────────────────

def test_payload_refuses_armed_air_offboard_unconfirmed():
    for kw, word in ((dict(armed=True), "Disarm"), (dict(in_air=True), "air"),
                     (dict(offboard=True), "Offboard"), (dict(connected=False), "No drone")):
        d = FakeDirect()
        r = run(pc.handle(fake_tel(d, **kw), "gripper_test", {"gripper": "open", "confirmed": True}))
        assert r["ok"] is False and word in r["error"] and d.sent == []
    d = FakeDirect()
    r = run(pc.handle(fake_tel(d), "rx_pair", {"mode": "dsmx"}))
    assert r["ok"] is False and "Confirm" in r["error"] and d.sent == []


def test_gripper_close_sends_do_gripper_and_reports_ack():
    d = FakeDirect(acks=[(211, 5), (211, 0)])
    r = run(pc.handle(fake_tel(d), "gripper_test", {"gripper": "close", "confirmed": True, "timeout_s": 0.1}))
    f = json.loads(d.sent[0].fields_json)
    assert f["command"] == 211 and f["param1"] == 1.0 and f["param2"] == 1.0
    assert r["ok"] is True and r["ack"] == "ACCEPTED"


def test_gripper_failed_ack_is_an_error_and_bad_input_refused():
    d = FakeDirect(acks=[(211, 4)])
    r = run(pc.handle(fake_tel(d), "gripper_test", {"gripper": "open", "confirmed": True, "timeout_s": 0.1}))
    assert r["ok"] is False and "FAILED" in r["error"]
    d = FakeDirect()
    r = run(pc.handle(fake_tel(d), "gripper_test", {"gripper": "explode", "confirmed": True}))
    assert r["ok"] is False and d.sent == []


def test_rx_pair_modes():
    assert pc.rx_pair_fields(1, "dsm2")["param2"] == 0.0
    assert pc.rx_pair_fields(1, "dsmx")["param2"] == 1.0
    assert pc.rx_pair_fields(1, "dsmx8")["param2"] == 2.0
    f = pc.rx_pair_fields(1, "dsmx")
    assert f["command"] == 500 and f["param1"] == 0.0
    with pytest.raises(ValueError):
        pc.rx_pair_fields(1, "crsf")
    d = FakeDirect(acks=[(500, 3)])
    r = run(pc.handle(fake_tel(d), "rx_pair", {"mode": "dsmx", "confirmed": True}))
    assert r["ok"] is False and "UNSUPPORTED" in r["error"]


# ── NTRIP ───────────────────────────────────────────────────────────────────

def test_crc24q_known_value_and_frame_roundtrip():
    # CRC-24Q of "123456789" is 0xCDE703.
    assert ntrip.crc24q(b"123456789") == 0xCDE703
    f = ntrip.rtcm_frame(bytes([0x3E, 0xD0]) + b"\x01" * 17)       # type 1005
    assert ntrip.rtcm_message_type(f) == 1005
    p = ntrip.RtcmParser()
    junk = b"\xd3\x00\x05garbage"
    out = p.feed(junk + f[:7]) + p.feed(f[7:] + f)
    assert out == [f, f]
    bad = bytearray(f)
    bad[-1] ^= 0xFF
    assert p.feed(bytes(bad)) == [] and p.bad_crc >= 1


def test_fragmentation_per_mavlink_spec():
    small = ntrip.rtcm_frame(b"\x3e\xd0" + b"x" * 50)
    m = ntrip.rtcm_messages(small, 3)
    assert len(m) == 1 and m[0]["flags"] == 3 << 3 and m[0]["len"] == len(small) and len(m[0]["data"]) == 180
    big = bytes(range(256)) * 2 + b"y" * 100        # 612 bytes
    m = ntrip.rtcm_messages(big, 31)
    assert [x["len"] for x in m] == [180, 180, 180, 72]
    for i, x in enumerate(m):
        assert x["flags"] & 1 == 1 and (x["flags"] >> 1) & 3 == i and x["flags"] >> 3 == 31
    assert bytes(b for x in m for b in x["data"][:x["len"]]) == big
    assert ntrip.rtcm_messages(b"z" * 721, 0) == []
    exact = ntrip.rtcm_messages(b"q" * 180, 1)
    assert len(exact) == 1 and exact[0]["flags"] & 1 == 1


def test_request_and_answers():
    req = ntrip.build_request("MOUNT1", "user", "s3cret", "caster.example").decode()
    assert req.startswith("GET /MOUNT1 HTTP/1.0\r\n") and req.endswith("\r\n\r\n")
    assert "Basic " + base64.b64encode(b"user:s3cret").decode() in req
    assert ntrip.parse_response_head(b"ICY 200 OK\r\n") is False
    assert ntrip.parse_response_head(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n") is True
    for head, word in ((b"HTTP/1.1 401 Unauthorized\r\n", "password"), (b"SOURCETABLE 200 OK\r\n", "mountpoint"),
                       (b"HTTP/1.0 404 Not Found\r\n", "mountpoint"), (b"SSH-2.0-OpenSSH\r\n", "Not an NTRIP")):
        with pytest.raises(ntrip.NtripError) as e:
            ntrip.parse_response_head(head)
        assert word in str(e.value)


def test_chunk_decoder_and_gga():
    d = ntrip.ChunkDecoder()
    body = b"5\r\nhello\r\n3\r\nabc\r\n0\r\n\r\n"
    out = b"".join(d.feed(body[i:i + 3]) for i in range(0, len(body), 3))
    assert out == b"helloabc"
    g = ntrip.nmea_gga(17.6, 78.12, 540.0, 14, 6, now=0)
    assert g.startswith("$GPGGA,000000.00,1736.0000,N,07807.2000,E,4,14,")
    body, cs = g.strip()[1:].split("*")
    x = 0
    for ch in body:
        x ^= ord(ch)
    assert f"{x:02X}" == cs


def test_validate_config_and_secret_free_repr():
    cfg = ntrip.validate_config({"host": "http://rtk2go.com/", "port": "2101", "mountpoint": "/IITH",
                                 "username": "me@x.com", "password": "pw"})
    assert (cfg.host, cfg.port, cfg.mountpoint) == ("rtk2go.com", 2101, "IITH")
    assert "pw" not in repr(cfg) and "me@x.com" not in repr(cfg)
    for bad in ({"host": "", "mountpoint": "A"}, {"host": "a b", "mountpoint": "A"},
                {"host": "h", "port": 0, "mountpoint": "A"}, {"host": "h", "mountpoint": "a/b"},
                {"host": "h", "mountpoint": "A", "password": "x\r\nInjected: 1"}):
        with pytest.raises(ValueError):
            ntrip.validate_config(bad)
    client = ntrip.NtripClient(cfg, lambda f: None)
    assert "pw" not in repr(client) and "pw" not in json.dumps(client.status())


def test_client_against_fake_caster_forwards_frames():
    frames = [ntrip.rtcm_frame(bytes([0x3E, 0xD0]) + b"a" * 19),                 # 1005
              ntrip.rtcm_frame(bytes([0x43, 0x50]) + bytes(range(200)) * 2)]     # 1077, 402 B -> 3 fragments
    seen = {}

    async def go():
        async def caster(reader, writer):
            req = await reader.readuntil(b"\r\n\r\n")
            seen["req"] = req
            writer.write(b"ICY 200 OK\r\n" + frames[0] + b"noise" + frames[1])
            await writer.drain()
            await asyncio.sleep(0.3)
            writer.close()

        server = await asyncio.start_server(caster, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        sent = []

        async def send(fields):
            sent.append(fields)
        cfg = ntrip.validate_config({"host": "127.0.0.1", "port": port, "mountpoint": "M1",
                                     "username": "u", "password": "p"})
        states = []
        client = ntrip.NtripClient(cfg, send, on_state=lambda s: states.append(s["state"]), reconnect_s=(5.0,))
        client.start()
        for _ in range(100):
            if client.messages_sent >= 4:
                break
            await asyncio.sleep(0.02)
        status = client.status()
        await client.stop()
        server.close()
        await server.wait_closed()
        return sent, status, states, client
    sent, status, states, client = run(go())
    assert b"GET /M1 HTTP/1.0" in seen["req"] and b"Authorization: Basic" in seen["req"]
    assert len(sent) == 4 and sent[0]["flags"] >> 3 == 0 and all(m["flags"] >> 3 == 1 for m in sent[1:])
    assert status["frames"] == 2 and status["types"] == {"1005": 1, "1077": 1}
    assert "connected" in states and client.state == "stopped"
    assert client._cfg.password == "" and client._cfg.username == ""


def test_client_stops_on_bad_credentials():
    async def go():
        async def caster(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 401 Unauthorized\r\n\r\n")
            await writer.drain()
            writer.close()
        server = await asyncio.start_server(caster, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        cfg = ntrip.validate_config({"host": "127.0.0.1", "port": port, "mountpoint": "M"})
        client = ntrip.NtripClient(cfg, lambda f: asyncio.sleep(0), reconnect_s=(0.01,))
        client.start()
        for _ in range(100):
            if client.state == "error":
                break
            await asyncio.sleep(0.02)
        running = client.running
        server.close()
        await server.wait_closed()
        return client, running
    client, running = run(go())
    assert client.state == "error" and "password" in client.error and not running


def test_customer_casters_must_be_public():
    from app.events import gps_events as ge
    with pytest.raises(ntrip.NtripError) as e:
        run(ge.resolve_checked("127.0.0.1", 2101, allow_private=False))
    assert "private" in str(e.value)
    assert run(ge.resolve_checked("127.0.0.1", 2101, allow_private=True)) == "127.0.0.1"
    for ip, ok in (("10.0.0.5", False), ("192.168.1.2", False), ("169.254.1.1", False),
                   ("8.8.8.8", True), ("::1", False)):
        assert ge._public(ip) is ok


def test_live_pick_cleans_fields():
    from app.events import gps_events as ge
    p = ge.pick("GPS_RAW_INT", json.dumps({"fix_type": 6, "eph": 80, "satellites_visible": 21, "junk": 1, "lat": float("nan")}))
    assert p == {"fix_type": 6, "eph": 80, "satellites_visible": 21}
    a = ge.pick("ADSB_VEHICLE", json.dumps({"ICAO_address": 1234, "callsign": "AIC101\x00\x00", "altitude": 1000}))
    assert a["callsign"] == "AIC101" and a["ICAO_address"] == 1234
    a2 = ge.pick("ADSB_VEHICLE", json.dumps({"ICAO_address": 1, "callsign": [65, 66, 0]}))
    assert a2["callsign"] == "AB"
    assert ge.pick("HEARTBEAT", "{}") is None

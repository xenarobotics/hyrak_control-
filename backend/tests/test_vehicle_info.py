"""Config > Vehicle: what the flight controller says about itself."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from app.telemetry import vehicle_info as vi
from app.telemetry.manager import TelemetryManager


def _version(**kw):
    base = dict(flight_sw_major=1, flight_sw_minor=15, flight_sw_patch=2,
                flight_sw_git_hash="a1b2c3d4e5f60708", os_sw_major=11, os_sw_minor=0, os_sw_patch=0,
                os_sw_git_hash="0000000000000000",
                flight_sw_version_type=SimpleNamespace(name="RELEASE"))
    base.update(kw)
    return SimpleNamespace(**base)


class FakeInfo:
    def __init__(self, version=None, product=None, ident=None, fail=()):
        self.v, self.p, self.i, self.fail = version, product, ident, set(fail)

    async def _ret(self, name, val):
        if name in self.fail:
            raise RuntimeError("timeout")
        return val

    def get_version(self): return self._ret("version", self.v)
    def get_product(self): return self._ret("product", self.p)
    def get_identification(self): return self._ret("ident", self.i)


def test_version_dict_names_release_and_drops_zero_hashes():
    d = vi.version_dict(_version())
    assert d["firmware"] == "1.15.2"
    assert d["release"] == "release"
    assert d["git_hash"] == "a1b2c3d4e5f60708"
    assert d["os_version"] == "11.0.0"
    assert d["os_git_hash"] == ""


def test_identification_strips_nul_and_falls_back_to_legacy():
    assert vi.identification_dict(SimpleNamespace(hardware_uid="00ab12\x00", legacy_uid=0))["hardware_uid"] == "00ab12"
    assert vi.identification_dict(SimpleNamespace(hardware_uid="0000", legacy_uid=255))["hardware_uid"] == "legacy-ff"
    assert vi.identification_dict(SimpleNamespace(hardware_uid="", legacy_uid=0))["hardware_uid"] == ""


def test_read_info_keeps_the_parts_that_answered():
    info = FakeInfo(version=_version(), ident=SimpleNamespace(hardware_uid="abc", legacy_uid=0), fail={"product"})
    out = asyncio.run(vi.read_info(info))
    assert out["ok"] is True
    assert out["firmware"] == "1.15.2" and out["hardware_uid"] == "abc"
    assert "vendor_name" not in out


def test_read_info_not_ok_when_nothing_answers():
    out = asyncio.run(vi.read_info(FakeInfo(fail={"version", "product", "ident"})))
    assert out == {"ok": False}


def test_heartbeat_meta_names_px4_quad_and_unknowns():
    assert vi.heartbeat_meta({"autopilot": 12, "type": 2}) == {"autopilot": "PX4", "vehicle_type": "Quadrotor", "mav_type": 2}
    m = vi.heartbeat_meta({"autopilot": 99, "type": "x"})
    assert m["autopilot"] == "Autopilot 99" and m["vehicle_type"] == "" and m["mav_type"] is None


def _manager(info):
    m = TelemetryManager.__new__(TelemetryManager)
    m._drone = SimpleNamespace(info=info)
    m._connected = True
    m._sysid = 201
    m._target_sysid = 3
    m._target_sysid_learned = True
    m._address = "udpin://0.0.0.0:14540"
    m._link_kind = "local"
    m._last_rx_t = 0.0
    m._measured_rates = {"position": 8.0}
    m._heartbeat_meta = vi.heartbeat_meta(json.loads('{"autopilot": 12, "type": 13}'))
    m._vehicle_info_cache = None
    return m


def test_manager_vehicle_info_merges_link_facts_and_caches():
    info = FakeInfo(version=_version(), product=SimpleNamespace(vendor_id=0x26ac, vendor_name="Holybro", product_id=0x11, product_name="Pixhawk 6C"),
                    ident=SimpleNamespace(hardware_uid="uid1", legacy_uid=0))
    m = _manager(info)
    out = asyncio.run(m.get_vehicle_info())
    assert out["ok"] and out["info_ok"]
    assert out["autopilot"] == "PX4" and out["vehicle_type"] == "Hexarotor"
    assert out["vehicle_sysid"] == 3 and out["gcs_sysid"] == 201
    assert out["product_name"] == "Pixhawk 6C" and out["vendor_id"] == 0x26ac
    assert out["last_rx_age_s"] is None
    # Cached: a second read does not ask the autopilot again.
    info.fail = {"version", "product", "ident"}
    assert asyncio.run(m.get_vehicle_info())["firmware"] == "1.15.2"


def test_manager_vehicle_info_without_a_link():
    m = _manager(FakeInfo())
    m._connected = False
    assert asyncio.run(m.get_vehicle_info()) == {"ok": False, "error": "No drone connected"}

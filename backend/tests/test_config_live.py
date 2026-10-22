import json

from app.events.config_live_events import pick_fields


def test_pick_fields_keeps_only_known_numeric_fields():
    out = pick_fields("RC_CHANNELS", json.dumps({"chancount": 8, "chan1_raw": 1500, "rssi": 255, "time_boot_ms": 9}))
    assert out == {"chancount": 8, "chan1_raw": 1500, "rssi": 255}


def test_pick_fields_drops_nan_and_unknown_messages():
    assert pick_fields("HEARTBEAT", "{}") is None
    assert pick_fields("SCALED_PRESSURE", "not json") is None
    out = pick_fields("SCALED_PRESSURE", '{"press_abs": NaN, "temperature": 2150}')
    assert out == {"temperature": 2150}

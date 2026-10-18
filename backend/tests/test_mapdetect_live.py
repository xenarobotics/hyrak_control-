"""
Detections on the map, end to end: every mode's results read as detections,
a synthetic frame with a fake telemetry snapshot lands a sighting at the
expected lat/lon, recording, export, and the per-workspace scoping of the
REST routes and socket events (docs/ACCESS_MODEL.md 8b).
"""
import asyncio
import csv
import io
import json
import math
import time
from types import SimpleNamespace

import numpy as np
import pytest

from app.mapdetect import export, extract, geo, live, store
from app.vision.base import BaseAnalyzer
from test_live_scope import account, connect, hdr, ok, session, world  # noqa: F401
from test_live_scope import live as live_app  # noqa: F401  (fixture)

LAT, LON = 17.6, 78.1
W, H = 1280, 720


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    live._sessions.clear()
    monkeypatch.setattr(live, "_terrain_enabled", False)
    yield
    live._sessions.clear()


def tel(alt=100.0, heading=0.0):
    return {"position": {"latitude_deg": LAT, "longitude_deg": LON, "relative_altitude_m": alt},
            "attitude": {"roll_deg": 0.0, "pitch_deg": 0.0, "yaw_deg": heading},
            "heading_deg": heading, "gps": {"seen": True, "fix_type": 3, "hdop": 0.8},
            "home_lat": 0.0, "home_lng": 0.0}


def north_east(lat, lon):
    k = math.radians(1) * geo.EARTH_RADIUS_M
    return (lat - LAT) * k, (lon - LON) * k * math.cos(math.radians(LAT))


# ── every mode's result shape ────────────────────────────────────────────

def test_detections_from_every_result_shape():
    d = extract.detections_from("object-detection", {"detections": [{"name": "car", "box": [0, 0, 10, 10]}]})
    assert [(x.label, x.task) for x in d] == [("car", "detect")]
    d = extract.detections_from("custom:m1", {"task": "detect", "model_name": "Boats",
                                              "detections": [{"name": "boat", "score": 0.9, "box": [1, 2, 3, 4]}]})
    assert d[0].score == 0.9
    d = extract.detections_from("custom:m2", {"task": "classify", "top_class": "flood", "top_score": 0.8,
                                              "detections": []})
    assert d[0].task == "classify" and d[0].box is None and d[0].label == "flood"
    d = extract.detections_from("human-tracking", {"persons": [{"id": 3, "box": [0, 0, 5, 5], "conf": 0.7}]})
    assert d[0].label == "person" and d[0].track_id == 3
    d = extract.detections_from("crowd-management", {"people": [{"id": 1, "box": [0, 0, 5, 5]}]})
    assert d[0].label == "person"
    d = extract.detections_from("traffic-management", {"vehicles": [{"track_id": 4, "type": "truck", "box": [0, 0, 9, 9]}],
                                                        "people": []})
    assert d[0].label == "truck" and d[0].track_id == 4
    assert extract.detections_from("depth-mapping", {"detections": [{"name": "x", "box": [0, 0, 1, 1]}]}) == []
    assert extract.detections_from("custom:m1", {"error": "restarting", "detections": []}) == []
    many = {"people": [{"id": i, "box": [0, 0, 5, 5]} for i in range(200)]}
    assert len(extract.detections_from("crowd-management", many)) == extract.MAX_PER_FRAME
    assert extract.source_of("custom:m1", {"model_name": "Boats"}) == ("custom:m1", "Boats")
    assert extract.source_of("object-detection", {})[1] == "Object detection"


# ── synthetic end to end ─────────────────────────────────────────────────

class _FakeModel(BaseAnalyzer):
    """A model that 'sees' one car whose box bottom-centre is the right edge
    of the frame, vertically centred."""
    MODE = "object-detection"

    def _analyze_frame_blocking(self, frame_bgr):
        h, w = frame_bgr.shape[:2]
        return frame_bgr, {"detections": [{"name": "car", "score": 0.9,
                                           "box": [w - 40, h / 2 - 60, w, h / 2]}]}


async def _result(an, cid):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        r = an.get_latest_result(cid)
        if r:
            return r
        await asyncio.sleep(0.01)
    raise AssertionError("no result")


async def test_fake_telemetry_and_detection_give_a_sighting_at_the_expected_place():
    an = _FakeModel()
    an.register_client("s1")
    frame = np.zeros((H, W, 3), np.uint8)
    an.submit_frame("s1", frame, telemetry=tel(alt=100.0, heading=90.0))
    annotated, meta = await _result(an, "s1")
    capture = meta.pop("_capture")
    assert capture["width"] == W and capture["telemetry"]["heading_deg"] == 90.0
    # Same path as stream_track: the camera setting, then ingest.
    await live.set_camera("s1", {"hfov_deg": 80, "pitch_deg": -90, "set": True})
    m = live.ingest("s1", "object-detection", meta, capture, annotated)
    [s] = m.tracker.all()
    n, e = north_east(s.lat, s.lon)
    # Facing east, the right edge of a nadir frame is due SOUTH by
    # 100 * tan(40 deg) = 83.9 m (the box bottom is the frame's vertical centre).
    expected = (W / 2 - (W - 20)) / an_fx(W) * 100.0
    assert n == pytest.approx(expected, abs=0.05) and e == pytest.approx(0, abs=0.05)
    assert s.label == "car" and s.model_name == "Object detection" and s.best_score == 0.9
    assert s.angle_source == "setting" and s.accuracy_m > 5
    assert m.reason is None
    await an.stop()


def an_fx(width):
    return (width / 2.0) / math.tan(math.radians(40.0))


def test_no_gps_says_why_and_places_nothing():
    t = tel()
    t["gps"]["fix_type"] = 1
    m = live.ingest("s2", "object-detection",
                    {"detections": [{"name": "car", "box": [0, 0, 10, 10]}]},
                    {"telemetry": t, "width": W, "height": H}, None, now=1000.0)
    assert len(m.tracker) == 0 and m.reason == "no_gps"
    assert m.state()["status"]["reason"] == "no_gps"


def test_frames_over_time_dedup_and_rate_limit():
    meta = {"detections": [{"name": "person", "score": 0.5, "box": [600, 300, 680, 400]}]}
    cap = {"telemetry": tel(), "width": W, "height": H}
    for i in range(10):
        live.ingest("s3", "object-detection", meta, {**cap, "wall_time": 1000.0 + i * 0.5},
                    None, now=1000.0 + i * 0.5)
    m = live.get("s3")
    [s] = m.tracker.all()
    assert s.count == 10 and s.first_seen == 1000.0 and s.last_seen == 1004.5
    # Faster than 5 Hz: the extra frames are skipped.
    live.ingest("s3", "object-detection", meta, cap, None, now=1004.55)
    assert s.count == 10


def test_classify_uses_the_frame_centre_and_thumbs_are_crops():
    m = live.ingest("s4", "custom:m9", {"task": "classify", "top_class": "flooded", "top_score": 0.8,
                                         "model_name": "Flood", "detections": []},
                    {"telemetry": tel(), "width": W, "height": H}, None, now=1.0)
    [s] = m.tracker.all()
    assert abs(s.lat - LAT) < 1e-9 and s.task == "classify" and s.thumb is None
    frame = np.full((H, W, 3), 128, np.uint8)
    m = live.ingest("s5", "object-detection", {"detections": [{"name": "car", "score": 0.6,
                                                                "box": [100, 100, 300, 200]}]},
                    {"telemetry": tel(), "width": W, "height": H}, frame, now=1.0)
    [s] = m.tracker.all()
    assert s.thumb.startswith("data:image/jpeg;base64,")
    assert s.id in m.thumb_dirty
    delta = m.state()
    assert delta["upserts"][0]["thumb"] and delta["counts"] == {"car": 1}


async def test_recording_writes_rows_with_workspace_and_flight(monkeypatch):
    written = []

    async def upsert(rows):
        written.extend(rows)
        return len(rows)
    monkeypatch.setattr(store, "upsert", upsert)
    sm = SimpleNamespace(get=lambda sid: SimpleNamespace(socket_id="", workspace_id="ws-1",
                                                         drone={"id": "d-1"}))
    monkeypatch.setattr(live, "_session_manager", sm)
    from app.flights import recorder
    monkeypatch.setitem(recorder._active, "s6", {"flight_id": "f-1"})
    meta = {"detections": [{"name": "car", "box": [600, 300, 680, 400]}]}
    live.ingest("s6", "object-detection", meta, {"telemetry": tel(), "width": W, "height": H},
                None, now=1.0)
    assert written == []                       # off by default
    await live.set_recording("s6", True)       # saves what is already on the map
    assert len(written) == 1
    r = written[0]
    assert (r["workspace_id"], r["drone_id"], r["flight_id"], r["session_id"]) == ("ws-1", "d-1", "f-1", "s6")
    await live.clear("s6")
    assert len(live.get("s6").tracker) == 0    # live map empty, rows untouched
    await live.end_session("s6")
    assert live.get("s6") is None


# ── export ───────────────────────────────────────────────────────────────

def test_export_geojson_and_csv():
    rows = [{"id": "a", "label": "car", "lat": 17.6000001, "lon": 78.1000002, "best_score": 0.91,
             "first_seen": 0.0, "last_seen": 60.0, "count": 3, "accuracy_m": 8.0,
             "model_name": "Object detection", "source": "object-detection", "thumb": "data:x"}]
    gj = export.to_geojson(rows, flight_id="f1", session_id=None)
    f = gj["features"][0]
    assert gj["type"] == "FeatureCollection"
    assert f["geometry"] == {"type": "Point", "coordinates": [78.1000002, 17.6000001]}
    assert f["properties"]["class"] == "car" and f["properties"]["accuracy_m"] == 8.0
    assert f["properties"]["first_seen_utc"] == "1970-01-01T00:00:00+00:00"
    assert "thumb" not in f["properties"] and gj["properties"]["flight_id"] == "f1"
    json.dumps(gj)
    out = list(csv.DictReader(io.StringIO(export.to_csv(rows))))
    assert out[0]["lat"] == "17.6000001" and out[0]["class"] == "car" and out[0]["model"] == "Object detection"
    assert list(out[0]) == export.CSV_FIELDS


# ── scoping: REST and sockets ────────────────────────────────────────────

def _place(session_id):
    live.ingest(session_id, "object-detection",
                {"detections": [{"name": "car", "score": 0.7, "box": [600, 300, 680, 400]}]},
                {"telemetry": tel(), "width": W, "height": H}, None, now=5.0)


async def test_live_session_sightings_follow_the_session_workspace(live_app):
    w = await world(live_app)
    ready = await connect(live_app, "sid-pat", w.pat[1])          # IITH pilot
    sid = ready["session_id"]
    _place(sid)
    cl = live_app.cl
    url = f"/api/map-sightings?session_id={sid}"
    for token, want in ((w.vic[1], 200), (w.pat[1], 200), (w.founder[1], 200), (w.hp[1], 404)):
        assert cl.get(url, headers=hdr(token)).status_code == want, token
    body = ok(cl.get(url, headers=hdr(w.vic[1])))
    assert body["live"] and len(body["sightings"]) == 1 and body["can_clear"] is False
    assert ok(cl.get(url, headers=hdr(w.pat[1])))["can_clear"] is True
    # Export: viewers may download.
    r = cl.get(f"/api/map-sightings/export?format=csv&session_id={sid}", headers=hdr(w.vic[1]))
    assert r.status_code == 200 and "detections_" in r.headers["content-disposition"]
    r = cl.get(f"/api/map-sightings/export?format=geojson&session_id={sid}", headers=hdr(w.vic[1]))
    assert r.json()["features"][0]["properties"]["class"] == "car"
    assert cl.get(f"/api/map-sightings/export?format=kml&session_id={sid}",
                  headers=hdr(w.vic[1])).status_code == 400
    # Viewers see but cannot clear; outsiders cannot even tell it exists.
    assert cl.delete(url, headers=hdr(w.vic[1])).status_code == 403
    assert cl.delete(url, headers=hdr(w.hp[1])).status_code == 404
    assert len(live.get(sid).tracker) == 1
    ok(cl.delete(url, headers=hdr(w.pat[1])))
    assert len(live.get(sid).tracker) == 0
    assert live_app.rec.of("map_sightings", "sid-pat")[-1]["cleared"] is True
    # Unknown session, and neither or both ids.
    assert cl.get("/api/map-sightings?session_id=nope", headers=hdr(w.founder[1])).status_code == 404
    assert cl.get("/api/map-sightings", headers=hdr(w.founder[1])).status_code == 400


async def test_flight_sightings_follow_the_flights_workspace(live_app, monkeypatch):
    w = await world(live_app)
    from app.api import routes as api_routes
    from fastapi import HTTPException
    flight = SimpleNamespace(id="f1", workspace_id=w.civil["id"], started_at=None)
    scope_calls = []

    async def in_scope(fid, user):
        from app.auth import data_scope
        scope = await data_scope.scope_for(user)
        if fid != "f1" or not scope.can(flight.workspace_id):
            raise HTTPException(status_code=404, detail="Flight not found")
        return flight

    async def rows(**kw):
        scope_calls.append(("list", kw))
        return [{"id": "a", "label": "car", "lat": LAT, "lon": LON, "accuracy_m": 8.0}]

    async def delete(**kw):
        scope_calls.append(("delete", kw))
        return 1
    monkeypatch.setattr(api_routes, "_flight_in_scope", in_scope)
    monkeypatch.setattr(store, "list_rows", rows)
    monkeypatch.setattr(store, "delete_rows", delete)
    cl = live_app.cl
    url = "/api/map-sightings?flight_id=f1"
    assert ok(cl.get(url, headers=hdr(w.vic[1])))["sightings"][0]["label"] == "car"
    assert scope_calls[-1] == ("list", {"session_id": None, "flight_id": "f1",
                                        "workspace_ids": [w.civil["id"]]})
    assert cl.get(url, headers=hdr(w.hp[1])).status_code == 404
    assert cl.delete(url, headers=hdr(w.vic[1])).status_code == 403
    assert ok(cl.delete(url, headers=hdr(w.olga[1])))["deleted"] == 1
    assert scope_calls[-1] == ("delete", {"flight_id": "f1", "workspace_ids": [w.civil["id"]]})


async def test_socket_recording_needs_fly_and_camera_needs_view(live_app):
    w = await world(live_app)
    await connect(live_app, "sid-vic", w.vic[1])
    await connect(live_app, "sid-pat", w.pat[1])
    handlers = live_app.sio.handlers["/"]
    await handlers["set_map_recording"]("sid-vic", {"on": True})
    vic = session(live_app, "sid-vic")
    assert live.get(vic.session_id) is None or not live.get(vic.session_id).recording
    assert live_app.rec.of("error", "sid-vic")
    await handlers["set_map_camera"]("sid-vic", {"pitch_deg": -45, "hfov_deg": 70, "set": True})
    push = live_app.rec.of("map_sightings", "sid-vic")[-1]
    assert push["camera"]["pitch_deg"] == -45 and push["camera"]["source"] == "setting"
    await handlers["set_map_recording"]("sid-pat", {"on": True})
    pat = session(live_app, "sid-pat")
    assert live.get(pat.session_id).recording
    assert live_app.rec.of("map_sightings", "sid-pat")[-1]["recording"] is True

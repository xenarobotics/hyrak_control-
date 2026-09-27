"""Depth models and the person ruler (lens-aware metric depth, no-equipment
calibration) - and the safety rule they must not break: in flight a frame
with no ground fit yields no obstacles, whatever scale is stored."""
import math

import numpy as np
import pytest

from app.avoidance.sensing import camera, person_ruler
from app.vision import depth_models


def test_focal_from_hfov():
    assert abs(depth_models.focal_px(640, 90.0) - 320.0) < 1e-6


def test_da3_metric_formula_uses_the_lens(monkeypatch):
    class _Pred:
        depth = [np.full((280, 504), 30.0, np.float32)]
    d = depth_models.DA3Depth.__new__(depth_models.DA3Depth)
    d.process_res = 504
    d._model = type("M", (), {"inference": lambda self, imgs, process_res: _Pred()})()
    frame = np.zeros((360, 640, 3), np.uint8)
    wide, narrow = d.predict(frame, 90.0), d.predict(frame, 45.0)
    assert narrow.mean() > wide.mean() * 2          # same picture, narrower lens -> farther
    fx = 252.0                                      # 504 px wide at 90 deg
    assert abs(wide.mean() - 30.0 * fx / 300.0) / wide.mean() < 0.15


def test_depth_mapper_falls_back_when_da3_is_missing(monkeypatch):
    from app.vision.modules import depth_mapper
    calls = []

    def fake_load(name, device, fov_correct=False):
        calls.append(name)
        if "DA3" in name:
            raise ImportError("no checkout")
        return type("B", (), {"predict": lambda self, f, h: np.ones((10, 10))})()
    monkeypatch.setattr(depth_models, "load", fake_load)
    monkeypatch.setattr(depth_mapper.BaseAnalyzer, "__init__", lambda self, **k: None)
    s = depth_mapper.get_settings()
    monkeypatch.setattr(s, "depth_model", "depth-anything/DA3METRIC-LARGE")
    m = depth_mapper.DepthMapper()
    assert "V2" in m.model_name and len(calls) == 2
    assert m.predict_metric(np.zeros((4, 4, 3), np.uint8)).shape == (10, 10)


# -- person ruler ------------------------------------------------------------

def _depth_with_person(model_m=2.5):
    d = np.full((360, 640), 9.0, np.float32)
    d[100:300, 280:360] = model_m
    return d


def test_ruler_scale_from_one_standing_person():
    w, h, hfov, H = 640, 360, 90.0, 1.70
    f = 320.0
    box_h = f * H / 5.0                              # person 5 m away
    y0 = 180 - box_h / 2
    scale, why = person_ruler.scale_from_box([[285, y0, 355, y0 + box_h]],
                                             _depth_with_person(2.5), w, h, hfov, H)
    assert scale is not None and abs(scale - 2.0) < 0.05, why


@pytest.mark.parametrize("boxes,expect", [
    ([], "no person"),
    ([[1, 50, 10, 200], [20, 50, 30, 200]], "exactly one"),
    ([[285, 0, 355, 200]], "whole body"),
    ([[300, 170, 310, 190]], "stand 3-8 m"),
])
def test_ruler_refuses_bad_frames(boxes, expect):
    scale, why = person_ruler.scale_from_box(boxes, _depth_with_person(), 640, 360, 90.0, 1.7)
    assert scale is None and expect in why


def test_run_needs_agreeing_samples_then_stores(tmp_path, monkeypatch):
    monkeypatch.setattr(person_ruler, "STORE", tmp_path / "s.json")
    person_ruler.start("d1", 1.8)
    for v in [2.0, 2.1, 1.9, 2.0, 2.05, 1.95, 2.0, 2.02, 1.98, 2.0]:
        person_ruler.add_sample("d1", v, "ok", "640x360|90.0|M")
    st = person_ruler.status("d1")
    assert st["state"] == "done" and abs(st["scale"] - 2.0) < 0.03
    assert abs(person_ruler.stored_scale(640, 360, 90.0, "x/M") - 2.0) < 0.03
    person_ruler.start("d2", 1.7)
    for v in [1, 3, 1, 3, 1, 3, 1, 3, 1, 3]:
        person_ruler.add_sample("d2", v, "ok", "k")
    assert person_ruler.status("d2")["state"] == "collecting"      # disagreed: starts over


def test_height_is_checked():
    with pytest.raises(ValueError):
        person_ruler.start("d3", 3.5)


# -- how the scale is used ----------------------------------------------------

def _ctx(**kw):
    base = {"alt_m": 10.0, "roll_deg": 0.0, "pitch_deg": 0.0, "cam_pitch_deg": 0.0, "scale": None}
    return {**base, **kw}


def _box(dist):
    z = np.full((120, 160), 30.0, np.float32)
    z[20:100, 60:100] = dist
    return z


def test_bench_multiplies_by_the_stored_scale():
    near = camera.analyze_depth(_box(1.0), 160, 120, _ctx(bench=True, bench_h=1.0), 70.0, 20.0)
    far = camera.analyze_depth(_box(1.0), 160, 120, _ctx(bench=True, bench_h=1.0, stored_scale=2.0), 70.0, 20.0)
    hit = lambda r: min(b.hit_m for b in r["scan"] if b.hit_m is not None)
    assert abs(hit(far) / hit(near) - 2.0) < 0.2


def test_flight_seed_never_makes_obstacles_without_a_ground_fit():
    res = camera.analyze_depth(_box(4.0), 160, 120, _ctx(scale_seed=2.0), 70.0, 20.0)
    assert res["scan"] is None

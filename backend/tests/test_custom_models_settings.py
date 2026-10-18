"""
Per-model settings and small-object tiling (docs/custom_models/DESIGN.md
section 0, "As built", Settings):

  * the runner's tiling: the tile grid, boxes mapped back to frame pixels,
    class-wise merging of the same object found twice, a small object only
    found with tiling, batched and looped runs, the class filter;
  * the settings on the model: PATCH validation, the card fields, a renamed
    class staying shown, the catalogue snapshot;
  * a running session picking a change up on its next frame, with no
    restart, plus the per-class tally over the run.
"""
import asyncio
import json
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from custom_model_fixtures import make_model, make_spot_model, spot_frame, ultra_meta, yolov8_output
from test_custom_models import env, onnx_files, ready_model, sess  # noqa: F401  (fixtures)
from test_live_scope import hdr, live, ok, world  # noqa: F401  (live is a fixture)
from app.models_custom import checks, runtime, service


def _runner():
    sys.path.insert(0, str(checks.RUNNER.parent))
    try:
        import runner as r
    finally:
        sys.path.pop(0)
    return r


def _model(path):
    out = subprocess.run(checks.runner_command("inspect"), input=json.dumps(
        {"model": str(path), "use_gpu": False}), capture_output=True, text=True, timeout=60)
    info = json.loads(out.stdout.strip().splitlines()[-1])["info"]
    return _runner().Model(str(path), info, use_gpu=False), info


# ── the tile grid and the merge ──────────────────────────────────────────

def test_tile_grid_covers_the_frame_with_overlap():
    r = _runner()
    tiles = r.tile_grid(1920, 1080, 2)
    assert len(tiles) == 4
    xs = sorted({(t[0], t[2]) for t in tiles})
    assert xs[0][0] == 0 and xs[-1][1] == 1920               # flush with both edges
    overlap = xs[0][1] - xs[1][0]
    assert overlap == pytest.approx(0.2 * (xs[0][1] - xs[0][0]), abs=2)
    t3 = r.tile_grid(640, 480, 3)
    assert len(t3) == 9 and max(t[3] for t in t3) == 480 and max(t[2] for t in t3) == 640
    assert r.tile_grid(640, 480, 1) == [(0, 0, 640, 480)]
    assert [r.tiles_for(x, 1920) for x in ("off", "2x2", "3x3", "auto", None, "bogus")] == [1, 2, 3, 2, 1, 1]
    assert r.tiles_for("auto", 1280) == 1                    # auto: only above 1280 px


def test_merge_is_classwise_at_iou_half():
    r = _runner()
    a = {"class_id": 0, "score": 0.9, "box": [100, 100, 140, 140]}
    same = {"class_id": 0, "score": 0.7, "box": [102, 101, 141, 142]}       # the other tile's copy
    other_class = {"class_id": 1, "score": 0.6, "box": [100, 100, 140, 140]}
    apart = {"class_id": 0, "score": 0.5, "box": [130, 130, 170, 170]}      # IoU < 0.5: another one
    assert r.merge_detections([same, apart, a, other_class]) == [a, other_class, apart]


# ── tiling on a real (tiny) model ────────────────────────────────────────

@pytest.mark.parametrize("batch", ["batch", 1])
def test_a_small_object_is_only_found_with_tiling(tmp_path, batch):
    m, info = _model(make_spot_model(tmp_path / "spot.onnx", batch=batch))
    assert info["head"]["layout"] == "yolov8" and info["labels"] == ["spot", "other"]
    frame = spot_frame()
    assert m.run(frame, 0.5)["detections"] == []                            # whole frame: too small
    res = m.run(frame, 0.5, {"tiling": "2x2"})
    assert res["tiling"] == "2x2" and res["tiles"] == 5                     # full frame + 4 tiles
    [d] = res["detections"]
    assert d["class_id"] == 0 and d["score"] > 0.5
    # The tile's centre box, mapped back to frame pixels: around the square.
    assert all(abs(v - e) <= 2 for v, e in zip(d["box"], [63, 63, 79, 79])), d["box"]
    assert m.batch_ok is (batch == "batch")                                 # batched when it may
    # A square at the bottom-right is found by that tile, at its own place.
    [d2] = m.run(spot_frame(at=(184, 184)), 0.5, {"tiling": "2x2"})["detections"]
    assert all(abs(v - e) <= 2 for v, e in zip(d2["box"], [176, 176, 192, 192])), d2["box"]
    # 3x3 finds it too; the class filter hides it.
    assert m.run(frame, 0.5, {"tiling": "3x3"})["tiling"] == "3x3"
    assert m.run(frame, 0.5, {"tiling": "2x2", "classes": [1]})["detections"] == []


def test_the_same_object_in_overlapping_tiles_is_one_box(tmp_path):
    """A constant model finds the same centre box in every tile: the boxes
    land in different places, and a frame-sized object found by the full
    pass is not duplicated by the tiles that see it the same way."""
    m, _ = _model(make_model(tmp_path / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta()))
    res = m.run(np.zeros((640, 640, 3), np.uint8), 0.25, {"tiling": "2x2"})
    boxes = [d["box"] for d in res["detections"]]
    assert len(boxes) == 5 and len({tuple(b) for b in boxes}) == 5        # five places, five boxes
    r = _runner()
    assert len(r.merge_detections(res["detections"] + res["detections"])) == 5


def test_class_filter_in_the_runner(tmp_path):
    m, _ = _model(make_model(tmp_path / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta()))
    frame = np.zeros((128, 128, 3), np.uint8)
    assert m.run(frame, 0.25, {"classes": [0, 2]})["detections"] == []
    assert len(m.run(frame, 0.25, {"classes": [1]})["detections"]) == 1
    assert len(m.run(frame, 0.25, {"classes": None})["detections"]) == 1


# ── settings on the model ────────────────────────────────────────────────

async def test_patch_settings_validation_and_card(env, onnx_files):  # noqa: F811
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    assert m["classes_shown"] is None and m["tiling"] == "off" and m["threshold"] == 0.25
    url = f"/api/models/{m['id']}"
    m2 = ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
        "classes_shown": ["crack", "car", "crack"], "tiling": "3x3", "threshold": 0.5}))["model"]
    assert m2["classes_shown"] == ["crack", "car"] and m2["tiling"] == "3x3"
    for bad in ({"tiling": "4x4"}, {"classes_shown": []}, {"classes_shown": ["x" * 65]}):
        r = await env.api.patch(url, headers=hdr(w.olga[1]), json=bad)
        assert r.status_code in (400, 422), bad
    # A renamed class stays shown.
    m3 = ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
        "labels": ["person", "fissure", "car"]}))["model"]
    assert m3["classes_shown"] == ["fissure", "car"]
    # null shows every class again.
    m4 = ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"classes_shown": None}))["model"]
    assert m4["classes_shown"] is None and m4["tiling"] == "3x3"
    # A viewer cannot change them.
    assert (await env.api.patch(url, headers=hdr(w.pat[1]), json={"tiling": "off"})).status_code == 403
    # The catalogue snapshot carries them, and catalogue runs use them.
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"classes_shown": ["crack"]}))
    await service.publish(SimpleNamespace(id=w.founder[0].id, username="founder"), m["id"], True)
    mode = await service.resolve_run(sess(w.sky["id"]), m["id"])
    assert mode.spec.via_catalogue and mode.spec.tiling == "3x3"
    assert mode.spec.classes_shown == ["crack"]


async def test_a_running_session_follows_changes_on_the_next_frame(env, onnx_files):  # noqa: F811
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    url = f"/api/models/{m['id']}"
    a = await asyncio.to_thread((await service.resolve_run(sess(w.iith["id"]), m["id"])).build_analyzer)
    frame = np.zeros((128, 128, 3), np.uint8)
    try:
        pid = a.runner.pid
        _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
        assert meta["total_count"] == 1 and meta["tiling"] == "off" and meta["threshold"] == 0.25
        assert meta["run_counts"] == {"crack": {"peak": 1, "frames": 1}} and meta["run_frames"] == 1

        # Sensitivity above the box's 90%: gone on the next frame.
        ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"threshold": 0.95}))
        _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
        assert meta["detections"] == [] and meta["threshold"] == 0.95

        # Back down, but crack hidden: still gone, and no alert for it.
        ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
            "threshold": 0.25, "classes_shown": ["person"],
            "alert": {"label": "crack", "min_score": 0.5}}))
        _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
        assert meta["detections"] == [] and meta["objects"] == {} and "alert" not in meta
        assert meta["classes_shown"] == ["person"]

        # Shown again, tiled: boxes from the tiles, the alert fires.
        ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
            "classes_shown": None, "tiling": "2x2"}))
        _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
        assert meta["tiling"] == "2x2" and meta["total_count"] == 5 and meta["alert"]["label"] == "crack"
        assert meta["run_counts"]["crack"] == {"peak": 5, "frames": 2} and meta["run_frames"] == 4

        # Renamed while running: the new name, the same runner.
        ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
            "labels": ["person", "fissure", "car"], "tiling": "off"}))
        _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
        assert [d["name"] for d in meta["detections"]] == ["fissure"]
        assert a.runner.pid == pid                                          # never restarted
    finally:
        await a.stop()
        runtime.set_live(m["id"], None)

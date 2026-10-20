"""
Custom models end to end (docs/custom_models/DESIGN.md section 0), on the
real server object against the memory stores, models on the CPU:

  * the library: HYRAK modes plus the catalogue plus the workspace's own,
    the `premium` block, 404 for workspaces the caller cannot see;
  * permissions and the `custom_models` entitlement (founder-only switch,
    staff always), quotas, size limits, the upload refusals;
  * the check pipeline: received -> inspecting -> testing -> ready|failed
    pushed as model_status to the workspace's sockets only; versions (a
    failed new version keeps the old one running); patch, retest, preview,
    publish (founders), delete;
  * Hugging Face with the network replaced: resolve to a sha, pick the
    file, fetch only it and its companions;
  * running: set_analysis_mode "custom:<id>" on the real handler, the
    access rules in resolve_run, the analyzer's cv_results shape and
    alerts, runners shared per workspace, restarted after a crash and
    stopped when idle.
"""
import asyncio
import os
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest

from custom_model_fixtures import (  # noqa: E402
    classify_output, make_model, ultra_meta, yolov8_output,
)
from test_live_scope import (  # noqa: F401  (live is a fixture)
    account, connect, errors, hdr, live, ok, session, world,
)
from app.auth.store import PLATFORM_WORKSPACE_ID
from app.config import get_settings
from app.models_custom import hf, runtime, service, storage
from app.models_custom import store as model_store
from app.models_custom.analyzer import CustomModelAnalyzer, CustomModelMode
from app.models_custom.errors import ModelFailure


@pytest.fixture
def env(live, tmp_path, monkeypatch):  # noqa: F811
    s = get_settings()
    monkeypatch.setattr(s, "hyrak_data_dir", tmp_path / "data")
    monkeypatch.setattr(s, "custom_models_use_gpu", False)
    monkeypatch.setattr(s, "custom_models_runner_idle_s", 0.3)
    model_store.reset_for_tests()
    service._steps.clear()
    api = live.cl.app
    live.api = httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://t")
    live.tmp = tmp_path
    yield live
    runtime.pool().stop_all()
    model_store.reset_for_tests()


@pytest.fixture
def onnx_files(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    return SimpleNamespace(
        detect=make_model(d / "detect.onnx", {"output0": yolov8_output()}, metadata=ultra_meta()),
        classify=make_model(d / "cls.onnx", {"probs": classify_output()},
                            input_shape=(1, 3, 224, 224), metadata=ultra_meta(task="classify")),
        custom=make_model(d / "custom.onnx", {"output0": yolov8_output()}, custom_domain="com.acme"),
    )


async def upload(env, token, ws_id, path, *, name="Crack finder", model_id=None, filename=None):
    data = {"workspace_id": ws_id, "name": name}
    if model_id:
        data["model_id"] = model_id
    files = {"file": (filename or Path(path).name, Path(path).read_bytes(), "application/octet-stream")}
    return await env.api.post("/api/models", headers=hdr(token), data=data, files=files)


async def feature(env, w, ws_id, on=True):
    r = await env.api.patch(f"/api/workspaces/{ws_id}", headers=hdr(w.founder[1]),
                            json={"features": {"custom_models": on}})
    return ok(r)


async def ready_model(env, w, path, **kw):
    await feature(env, w, w.iith["id"])
    m = ok(await upload(env, w.olga[1], w.iith["id"], path, **kw))["model"]
    await service.wait_for_checks()
    return m


def pushes(env, model_id=None):
    return [d for e, d, _ in env.rec.emitted
            if e == "model_status" and "id" in d and (model_id is None or d["id"] == model_id)]


# ── library and entitlement ──────────────────────────────────────────────

async def test_library_shape_and_premium_lock(env):
    w = await world(env)
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))
    assert set(lib) >= {"workspace_id", "hyrak", "workspace", "premium", "can_manage", "can_run",
                        "can_publish", "limits"}
    assert lib["premium"] == {"enabled": False, "reason": service.PREMIUM_REASON}
    ids = [m["id"] for m in lib["hyrak"]]
    assert "object-detection" in ids and "manual-control" not in ids
    assert "3d-reconstruction" not in ids                      # staff-only mode
    obj = next(m for m in lib["hyrak"] if m["id"] == "object-detection")
    assert obj == {"id": "object-detection", "kind": "builtin", "mode": "object-detection",
                   "run_mode": "object-detection",
                   "name": "Objects", "description": obj["description"], "icon": "scan-search",
                   "task": "detect", "status": "ready", "runnable": True, "staff_only": False}
    assert lib["workspace"] == [] and lib["can_manage"] and lib["can_run"] and not lib["can_publish"]
    staff = ok(await env.api.get("/api/models", headers=hdr(w.founder[1])))
    assert staff["workspace_id"] == PLATFORM_WORKSPACE_ID and staff["premium"]["enabled"]
    assert "3d-reconstruction" in [m["id"] for m in staff["hyrak"]]
    # Someone else's workspace does not exist.
    r = await env.api.get(f"/api/models?workspace_id={w.sky['id']}", headers=hdr(w.olga[1]))
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"


async def test_catalogue_entries_match_the_analyzer_registry():
    from app.models_custom import catalogue
    from app.vision.modules.__registry__ import ANALYZER_REGISTRY
    assert set(catalogue.BUILTIN) == {m.value for m in ANALYZER_REGISTRY}
    assert set(catalogue.ORDER) == set(catalogue.BUILTIN)


async def test_only_founders_switch_the_feature(env):
    w = await world(env)
    r = await env.api.patch(f"/api/workspaces/{w.iith['id']}", headers=hdr(w.olga[1]),
                            json={"features": {"custom_models": True}})
    assert r.status_code == 403
    ws = (await feature(env, w, w.iith["id"]))["workspace"]
    assert ws["features"] == {"custom_models": True}
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))
    assert lib["premium"] == {"enabled": True, "reason": ""}
    # Not inherited by a client below.
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.civil['id']}", headers=hdr(w.olga[1])))
    assert lib["premium"]["enabled"] is False


async def test_upload_permissions(env, onnx_files):
    w = await world(env)
    r = await upload(env, w.olga[1], w.iith["id"], onnx_files.detect)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_entitled"
    assert "premium" in r.json()["detail"]["error"]
    await feature(env, w, w.iith["id"])
    r = await upload(env, w.pat[1], w.iith["id"], onnx_files.detect)       # pilot: run, not manage
    assert r.status_code == 403 and r.json()["detail"]["code"] == "forbidden"
    r = await upload(env, w.vic[1], w.iith["id"], onnx_files.detect)
    assert r.status_code == 403
    _, sam = await account("sam")
    r = await upload(env, sam, w.iith["id"], onnx_files.detect)            # no membership at all
    assert r.status_code == 404
    # Staff never need the feature: a founder adds to HYRAK's own library.
    r = await upload(env, w.founder[1], PLATFORM_WORKSPACE_ID, onnx_files.detect)
    assert r.status_code == 200
    await service.wait_for_checks()


async def test_upload_refusals_name_the_fix(env, onnx_files, monkeypatch):
    w = await world(env)
    await feature(env, w, w.iith["id"])
    r = await upload(env, w.olga[1], w.iith["id"], onnx_files.detect, filename="best.pt")
    d = r.json()["detail"]
    assert r.status_code == 400 and d["code"] == "pytorch_file"
    assert "yolo export model=best.pt format=onnx" in d["hint"]
    monkeypatch.setattr(get_settings(), "custom_models_max_mb", 0)
    r = await upload(env, w.olga[1], w.iith["id"], onnx_files.detect)
    assert r.status_code == 413 and r.json()["detail"]["code"] == "too_large"
    assert not list((env.tmp / "data").rglob("*.onnx"))                  # nothing left behind
    monkeypatch.setattr(get_settings(), "custom_models_max_mb", 500)
    monkeypatch.setattr(get_settings(), "custom_models_max_per_workspace", 1)
    ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.detect))
    r = await upload(env, w.olga[1], w.iith["id"], onnx_files.detect)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "quota"
    await service.wait_for_checks()


# ── the check pipeline ───────────────────────────────────────────────────

async def test_upload_checks_and_becomes_ready(env, onnx_files):
    w = await world(env)
    await connect(env, "olga-sock", w.olga[1])
    await connect(env, "sky-sock", w.founder[1], workspace_id=w.sky["id"])
    await feature(env, w, w.iith["id"])
    m = ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.detect))["model"]
    assert m["status"] == "checking" and m["run_mode"] == f"custom:{m['id']}"
    assert m["kind"] == "uploaded" and m["runnable"] is False
    await service.wait_for_checks()
    steps = [p["step"] for p in pushes(env, m["id"])]
    assert steps == ["received", "inspecting", "testing", "done"]
    assert [p["progress"] for p in pushes(env, m["id"])] == [0.1, 0.4, 0.7, 1.0]
    last = pushes(env, m["id"])[-1]
    assert set(last) == {"id", "workspace_id", "version", "status", "step", "progress", "error",
                         "hint", "detail", "current_version"}
    assert last["status"] == "ready" and last["version"] == 1 and last["current_version"] == 1
    # Only the model's workspace hears about it.
    to = {t for e, d, t in env.rec.emitted if e == "model_status" and "id" in d}
    assert to == {"olga-sock"}

    m = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.pat[1])))["model"]
    assert m["status"] == "ready" and m["runnable"] and m["task"] == "detect"
    assert m["labels"] == ["person", "crack", "car"]
    v = m["version"]
    assert v["n"] == 1 and v["status"] == "ready" and len(v["sha256"]) == 64
    assert v["size_bytes"] == onnx_files.detect.stat().st_size and v["provider"] == "cpu"
    assert v["latency_ms"] > 0 and v["fps"] > 0 and v["preview"] is True
    assert m["details"]["head"]["layout"] == "yolov8" and m["details"]["test"]["samples"]
    assert [x["n"] for x in m["versions"]] == [1]
    stored = storage.version_dir(w.iith["id"], m["id"], 1)
    assert (stored / "model.onnx").is_file() and (stored / "preview.jpg").is_file()
    assert not list(stored.glob(".incoming-*"))

    r = await env.api.get(f"/api/models/{m['id']}/preview", headers=hdr(w.vic[1]))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"
    r = await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.founder[1]))
    assert r.status_code == 200                                # founders see everything
    _, sam = await account("sam2")
    assert (await env.api.get(f"/api/models/{m['id']}", headers=hdr(sam))).status_code == 404
    assert (await env.api.get(f"/api/models/{m['id']}/preview", headers=hdr(sam))).status_code == 404


async def test_a_bad_model_says_what_to_do_and_a_bad_version_keeps_the_old(env, onnx_files):
    w = await world(env)
    bad = await ready_model(env, w, onnx_files.custom)
    bad = ok(await env.api.get(f"/api/models/{bad['id']}", headers=hdr(w.olga[1])))["model"]
    assert bad["status"] == "failed" and not bad["runnable"]
    assert "custom operators (com.acme)" in bad["error"] and "standard ONNX" in bad["hint"]
    assert bad["details"]["failure"]["code"] == "custom_ops"

    good = ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.detect))["model"]
    await service.wait_for_checks()
    v2 = ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.custom,
                         model_id=good["id"]))["model"]
    assert v2["status"] == "checking" and v2["current_version"] == 1 and v2["runnable"]
    await service.wait_for_checks()
    m = ok(await env.api.get(f"/api/models/{good['id']}", headers=hdr(w.olga[1])))["model"]
    assert m["status"] == "failed" and m["current_version"] == 1 and m["runnable"]
    assert m["latest_version"] == 2 and [v["status"] for v in m["versions"]] == ["failed", "ready"]
    # A good v3 takes over.
    ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.detect, model_id=good["id"]))
    await service.wait_for_checks()
    m = ok(await env.api.get(f"/api/models/{good['id']}", headers=hdr(w.olga[1])))["model"]
    assert m["status"] == "ready" and m["current_version"] == 3 and m["error"] is None


async def test_patch_retest_publish_delete(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    url = f"/api/models/{m['id']}"
    r = await env.api.patch(url, headers=hdr(w.olga[1]), json={
        "name": "Cracks", "description": "Finds cracks in concrete", "threshold": 0.4,
        "labels": ["person", "crack", "car"], "alert": {"label": "crack", "min_score": 0.6}})
    m2 = ok(r)["model"]
    assert m2["name"] == "Cracks" and m2["threshold"] == 0.4
    assert m2["alert"] == {"label": "crack", "min_score": 0.6, "cooldown_s": 30.0}
    assert m2["details"]["label_source"] == "user"
    for bad in ({"threshold": 2}, {"alert": {"min_score": 0.5}}, {"task": "segment"},
                {"labels": ["x" * 65]}):
        r = await env.api.patch(url, headers=hdr(w.olga[1]), json=bad)
        assert r.status_code in (400, 422), bad
        if r.status_code == 400:
            assert r.json()["detail"]["code"] == "bad_request"
    assert (await env.api.patch(url, headers=hdr(w.pat[1]), json={"name": "x"})).status_code == 403
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"alert": None}))
    assert ok(await env.api.get(url, headers=hdr(w.olga[1])))["model"]["alert"] is None

    # No-code rules: validated, shown on the card, live for running sessions.
    assert ok(await env.api.get(url, headers=hdr(w.olga[1])))["model"]["rules"] == []
    rule = {"id": "abcd1234", "label": "CRACK", "action": "follow", "min_score": 0.6}
    m3 = ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"rules": [rule], "alert": None}))["model"]
    assert m3["rules"] == [{"id": "abcd1234", "enabled": True, "label": "crack", "min_score": 0.6,
                            "for_s": 1.0, "action": "follow", "confirm": True, "cooldown_s": 30.0}]
    assert runtime.live(m["id"])["rules"] == m3["rules"]
    lst = ok(await env.api.get(f"/api/models?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))
    assert any(x.get("rules") == m3["rules"] for x in lst["workspace"])
    for bad in ([{**rule, "label": "pothole"}], [{**rule, "id": "x"}],
                [rule, {**rule, "id": "efgh5678"}], [{**rule, "id": f"rule000{i}"} for i in range(7)]):
        r = await env.api.patch(url, headers=hdr(w.olga[1]), json={"rules": bad})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_request", bad
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"rules": None}))
    assert ok(await env.api.get(url, headers=hdr(w.olga[1])))["model"]["rules"] == []

    r = ok(await env.api.post(f"{url}/retest", headers=hdr(w.olga[1])))["model"]
    assert r["status"] == "checking"
    await service.wait_for_checks()
    assert ok(await env.api.get(url, headers=hdr(w.olga[1])))["model"]["status"] == "ready"

    # Publishing: founders only; then every workspace sees it in `hyrak`.
    r = await env.api.post(f"{url}/publish", headers=hdr(w.olga[1]))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "founders_only"
    ok(await env.api.post(f"{url}/publish", headers=hdr(w.founder[1]), json={"published": True}))
    _, sky_owner = await account("skyo")
    ok(env.cl.post(f"/api/workspaces/{w.sky['id']}/members", headers=hdr(w.founder[1]),
                   json={"login": "skyo", "role": "owner"}))
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.sky['id']}", headers=hdr(sky_owner)))
    cat = [c for c in lib["hyrak"] if c["kind"] == "catalogue"]
    assert [c["id"] for c in cat] == [m["id"]] and lib["workspace"] == []
    assert ok(await env.api.get(url, headers=hdr(sky_owner)))["model"]["kind"] == "catalogue"
    assert lib["workspace"] == []
    assert (await env.api.get(f"{url}/preview", headers=hdr(sky_owner))).status_code == 200
    assert (await env.api.patch(url, headers=hdr(sky_owner), json={"name": "x"})).status_code == 404
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))
    assert [c["kind"] for c in lib["hyrak"]].count("catalogue") == 0     # not twice
    assert lib["workspace"][0]["published"] is True

    # Delete: a published model needs a founder; then rows and files go.
    assert (await env.api.delete(url, headers=hdr(w.pat[1]))).status_code == 403
    r = await env.api.delete(url, headers=hdr(w.olga[1]))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "published_locked"
    ok(await env.api.delete(url, headers=hdr(w.founder[1])))
    assert (await env.api.get(url, headers=hdr(w.olga[1]))).status_code == 404
    assert not storage.model_dir(w.iith["id"], m["id"]).exists()


async def test_task_override_rechecks(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    r = ok(await env.api.patch(f"/api/models/{m['id']}", headers=hdr(w.olga[1]),
                               json={"task": "classify"}))["model"]
    assert r["status"] == "checking"
    await service.wait_for_checks()
    m = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.olga[1])))["model"]
    # A YOLO head read as a classifier does not fit: it says so, v1 stays failed.
    assert m["status"] == "failed" and m["details"]["failure"]["code"] == "unknown_layout"
    assert m["current_version"] is None


# ── Hugging Face (network replaced) ──────────────────────────────────────

SHA = "a" * 40


def fake_hub(monkeypatch, files: dict, *, gated=False, missing=False, calls=None):
    """files: repo path -> local bytes."""
    calls = calls if calls is not None else []

    class RepositoryNotFoundError(Exception):
        pass

    def model_info(repo, timeout):
        if missing:
            raise RepositoryNotFoundError(repo)
        sibs = [SimpleNamespace(rfilename=p, size=len(b)) for p, b in files.items()]
        return SimpleNamespace(sha=SHA, siblings=sibs, private=False, gated=gated,
                               pipeline_tag="object-detection", library_name="onnx",
                               card_data={"license": "apache-2.0"})

    async def stream(url, timeout):
        calls.append(url)
        path = url.split(f"/resolve/{SHA}/", 1)[1]
        data = files[path]
        for i in range(0, len(data), 4096):
            yield data[i:i + 4096]

    monkeypatch.setattr(hf, "_model_info", model_info)
    monkeypatch.setattr(hf, "_stream", stream)
    return calls


async def test_hf_inspect_and_import(env, onnx_files, monkeypatch):
    w = await world(env)
    await connect(env, "olga-sock", w.olga[1])
    await feature(env, w, w.iith["id"])
    detr_cfg = b'{"id2label": {"0": "person", "1": "crack", "2": "car"}}'
    calls = fake_hub(monkeypatch, {
        "onnx/model.onnx": onnx_files.detect.read_bytes(),
        "onnx/model_fp16.onnx": onnx_files.detect.read_bytes(),
        "config.json": detr_cfg, "README.md": b"# hi", "pytorch_model.bin": b"x" * 100,
    })
    r = ok(await env.api.get("/api/models/huggingface/inspect?repo=https://huggingface.co/acme/cracks",
                             headers=hdr(w.olga[1])))
    assert r["repo"] == "acme/cracks" and r["sha"] == SHA and r["ok"]
    assert [f["path"] for f in r["onnx_files"]] == ["onnx/model.onnx", "onnx/model_fp16.onnx"]
    assert r["suggested_file"] == "onnx/model.onnx" and r["labels"] == ["person", "crack", "car"]
    assert r["license"] == "apache-2.0" and r["task"] == "detect"
    # A customer without the feature cannot use it as a fetcher.
    assert (await env.api.get("/api/models/huggingface/inspect?repo=acme/cracks",
                              headers=hdr(w.pat[1]))).status_code == 403

    calls.clear()
    m = ok(await env.api.post("/api/models/huggingface", headers=hdr(w.olga[1]), json={
        "workspace_id": w.iith["id"], "repo": "acme/cracks", "file": "onnx/model_fp16.onnx"}))["model"]
    assert m["kind"] == "huggingface" and m["status"] == "checking" and m["name"] == "cracks"
    assert m["hf"] == {"repo": "acme/cracks", "revision": SHA, "file": "onnx/model_fp16.onnx",
                       "url": "https://huggingface.co/acme/cracks"}
    await service.wait_for_checks()
    m = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.olga[1])))["model"]
    assert m["status"] == "ready", m
    assert [p["step"] for p in pushes(env, m["id"])] == ["downloading", "inspecting", "testing",
                                                         "done"]
    fetched = sorted(u.split(f"/resolve/{SHA}/", 1)[1] for u in calls)
    assert fetched == ["config.json", "onnx/model_fp16.onnx"]        # nothing else
    assert all(SHA in u for u in calls)                              # pinned to the commit


async def test_hf_refusals(env, onnx_files, monkeypatch):
    w = await world(env)
    await feature(env, w, w.iith["id"])

    async def add(**body):
        return await env.api.post("/api/models/huggingface", headers=hdr(w.olga[1]),
                                  json={"workspace_id": w.iith["id"], "repo": "acme/x", **body})
    fake_hub(monkeypatch, {"pytorch_model.bin": b"x"})
    r = await add()
    assert r.status_code == 422 and r.json()["detail"]["code"] == "hf_no_onnx"
    assert "optimum-cli export onnx" in r.json()["detail"]["hint"]
    insp = ok(await env.api.get("/api/models/huggingface/inspect?repo=acme/x", headers=hdr(w.olga[1])))
    assert insp["ok"] is False and insp["code"] == "hf_no_onnx"
    fake_hub(monkeypatch, {"a.onnx": b"1", "b.onnx": b"2"})
    r = await add()
    assert r.status_code == 409 and r.json()["detail"]["code"] == "hf_choose_file"
    r = await add(file="c.onnx")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "hf_file_not_found"
    fake_hub(monkeypatch, {"model.onnx": b"1"}, gated="manual")
    assert (await add()).json()["detail"]["code"] == "hf_gated"
    fake_hub(monkeypatch, {}, missing=True)
    assert (await add()).json()["detail"]["code"] == "hf_not_found"
    monkeypatch.setattr(get_settings(), "custom_models_max_mb", 0)
    fake_hub(monkeypatch, {"model.onnx": onnx_files.detect.read_bytes()})
    r = await add()
    assert r.status_code == 413 and r.json()["detail"]["code"] == "too_large"
    r = await env.api.post("/api/models/huggingface", headers=hdr(w.olga[1]),
                           json={"workspace_id": w.iith["id"], "repo": "https://github.com/a/b"})
    assert r.json()["detail"]["code"] == "hf_bad_repo"


async def test_hf_download_stops_at_the_limit(tmp_path, monkeypatch):
    async def endless(url, timeout):
        while True:
            yield b"x" * 1024

    monkeypatch.setattr(hf, "_stream", endless)
    with pytest.raises(ModelFailure) as e:
        await hf.download("a/b", SHA, "model.onnx", tmp_path / "m.onnx", limit=10_000)
    assert e.value.code == "too_large" and not list(tmp_path.iterdir())


# ── running ──────────────────────────────────────────────────────────────

def sess(ws, *, perms_=("view", "fly", "models.run"), staff=False, user="u1"):
    return SimpleNamespace(workspace_id=ws, perms=frozenset(perms_), is_staff=staff, user_id=user)


async def test_resolve_run_access_rules(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    mode = await service.resolve_run(sess(w.iith["id"]), m["id"])
    assert isinstance(mode, CustomModelMode) and mode.value == f"custom:{m['id']}"
    assert mode.spec.workspace_id == w.iith["id"] and mode.spec.version == 1
    assert mode.spec.labels == ["person", "crack", "car"]

    async def code(s, mid=m["id"]):
        with pytest.raises(ModelFailure) as e:
            await service.resolve_run(s, mid)
        return e.value.code
    assert await code(sess(w.iith["id"], perms_=("view",))) == "forbidden"     # a viewer
    assert await code(sess(w.sky["id"])) == "not_found"                         # not theirs
    assert await code(sess(w.iith["id"]), "nope") == "not_found"
    await feature(env, w, w.iith["id"], on=False)
    assert await code(sess(w.iith["id"])) == "not_entitled"
    await service.resolve_run(sess(w.iith["id"], staff=True), m["id"])         # staff: always
    # Published: any workspace runs it, without the feature.
    await service.publish(SimpleNamespace(id=w.founder[0].id, username="founder"), m["id"], True)
    mode = await service.resolve_run(sess(w.sky["id"]), m["id"])
    assert mode.spec.workspace_id == w.sky["id"]                                # its own runner


async def test_set_analysis_mode_custom_on_the_real_handler(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    await connect(env, "p", w.pat[1])
    await connect(env, "v", w.vic[1])
    h = env.sio.handlers["/"]
    await h["set_analysis_mode"]("v", {"mode": f"custom:{m['id']}"})
    assert errors(env, "v")[-1]["code"] == "forbidden"                          # viewers do not command
    await h["set_analysis_mode"]("p", {"mode": "custom:missing"})
    e = errors(env, "p")[-1]
    assert e["code"] == "not_found" and e["event"] == "set_analysis_mode" and e["hint"]
    assert env.rec.of("model_status", "p")[-1] == {"status": "error", "mode": "custom:missing",
                                                   "error": e["msg"], "code": "not_found"}
    await h["set_analysis_mode"]("p", {"mode": f"custom:{m['id']}"})
    s = session(env, "p")
    assert s.mode.value == f"custom:{m['id']}"
    assert env.rec.of("mode_changed", "p")[-1] == {"mode": f"custom:{m['id']}"}
    for _ in range(100):
        if env.rec.of("model_status", "p")[-1].get("status") == "ready":
            break
        await asyncio.sleep(0.05)
    assert env.rec.of("model_status", "p")[-1] == {"status": "ready", "mode": f"custom:{m['id']}"}
    analyzer = env.pool.get_for_session(s.session_id)
    assert isinstance(analyzer, CustomModelAnalyzer)
    # Deleting the model puts the session back on manual control.
    ok(await env.api.delete(f"/api/models/{m['id']}", headers=hdr(w.olga[1])))
    assert s.mode.value == "manual-control"
    assert env.pool.get_for_session(s.session_id) is None
    assert errors(env, "p")[-1]["code"] == "model_removed"


async def test_analyzer_results_shape_alerts_and_shared_runners(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    ok(await env.api.patch(f"/api/models/{m['id']}", headers=hdr(w.olga[1]), json={
        "alert": {"label": "crack", "min_score": 0.5, "cooldown_s": 60}}))
    mode = await service.resolve_run(sess(w.iith["id"]), m["id"])
    a = await asyncio.to_thread(mode.build_analyzer)
    b = await asyncio.to_thread((await service.resolve_run(sess(w.iith["id"]), m["id"])).build_analyzer)
    assert a.runner is b.runner and a.runner.pid                        # one process per workspace
    frame = np.zeros((128, 128, 3), np.uint8)
    _, meta = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert meta["detections"] == [{"name": "crack", "score": 0.9, "box": [44, 44, 84, 84]}]
    assert meta["objects"] == {"crack": 1} and meta["total_count"] == 1 and meta["person_count"] == 0
    assert meta["model_id"] == m["id"] and meta["task"] == "detect" and meta["model_version"] == 1
    assert meta["alert"]["label"] == "crack" and meta["alert"]["score"] == 0.9
    assert meta["alert_hits"] == [{"label": "crack", "score": 0.9}]
    assert meta["_pending_model_alerts"] and meta["_pending_admin_alerts"][0]["source"] == "custom_model"
    _, meta2 = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert "alert" not in meta2                                          # cooldown
    # No follow, no command; a follow (actions.py starts it) steers toward
    # the locked box with a capped velocity, down always 0.
    assert "drone_command" not in meta and "follow" not in meta
    a.start_follow("crack", [44, 44, 84, 84], 0.9)
    _, mf = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    cmd = mf["drone_command"]
    assert cmd["type"] == "velocity" and cmd["down_m_s"] == 0.0 and abs(cmd["forward_m_s"]) <= 3.0
    assert abs(cmd["yaw_deg_s"]) <= 30.0 and abs(cmd["right_m_s"]) <= 1.5
    assert mf["follow"]["active"] and mf["follow"]["box"] == [44, 44, 84, 84]
    a.stop_follow()
    _, mo = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert "drone_command" not in mo and "follow" not in mo
    # A big frame is scaled for the buffer and the boxes scaled back.
    _, big = await asyncio.to_thread(a._analyze_frame_blocking, np.zeros((2160, 3840, 3), np.uint8))
    assert big["detections"][0]["box"][0] > 1000

    # Another workspace running the published model gets its own runner.
    await service.publish(SimpleNamespace(id=w.founder[0].id, username="founder"), m["id"], True)
    c = await asyncio.to_thread((await service.resolve_run(sess(w.sky["id"]), m["id"])).build_analyzer)
    assert c.runner is not a.runner and c.runner.pid != a.runner.pid

    # Crash: the frame reports it, the next one after the backoff runs again.
    pid = a.runner.pid
    os.kill(pid, 9)
    await asyncio.sleep(0.2)
    _, crashed = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert crashed["detections"] == [] and crashed["runner"] == "crashed" and crashed["error"]
    _, wait = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert wait["runner"] == "restarting" and "restarting" in wait["error"]
    await asyncio.sleep(1.1)
    _, back = await asyncio.to_thread(a._analyze_frame_blocking, frame)
    assert back["total_count"] == 1 and a.runner.pid not in (None, pid)

    # Idle stop once both sessions let go.
    runner = a.runner
    await a.stop()
    assert runner.pid is not None
    await b.stop()
    await asyncio.sleep(0.6)
    assert runner.pid is None and runtime.pool().get(mode.spec.key) is None
    await c.stop()


async def test_classifier_results_and_busy_limit(env, onnx_files, monkeypatch):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.classify)
    a = await asyncio.to_thread((await service.resolve_run(sess(w.iith["id"]), m["id"])).build_analyzer)
    _, meta = await asyncio.to_thread(a._analyze_frame_blocking, np.zeros((240, 320, 3), np.uint8))
    assert meta["task"] == "classify" and meta["top_class"] == "crack"
    assert meta["classes"][0] == {"name": "crack", "score": pytest.approx(0.7)}
    assert meta["predictions"] == meta["classes"]
    assert meta["detections"] == [] and meta["objects"] == {}
    monkeypatch.setattr(get_settings(), "custom_models_max_runners", 1)
    other = await service.resolve_run(sess(w.iith["id"]), m["id"])
    other.spec.workspace_id = "another"
    with pytest.raises(RuntimeError) as e:
        await asyncio.to_thread(other.build_analyzer)
    assert "slots are in use" in str(e.value)
    await a.stop()


async def test_a_model_that_dies_on_load_fails_cleanly(env, onnx_files, tmp_path):
    spec = runtime.RunSpec(workspace_id="w", model_id="m", version=1,
                           model_path=str(tmp_path / "gone.onnx"), spec={})
    with pytest.raises(RuntimeError):
        await asyncio.to_thread(CustomModelMode(spec).build_analyzer)
    t0 = time.monotonic()
    while runtime.pool().get(spec.key) is not None and time.monotonic() - t0 < 2:
        await asyncio.sleep(0.05)
    assert runtime.pool().get(spec.key) is None                     # nothing left holding it


# ── the catalogue: reduced cards, pinned versions ────────────────────────

CATALOGUE_KEYS = {"id", "kind", "run_mode", "name", "description", "icon", "task", "status",
                  "runnable", "published", "labels", "threshold", "classes_shown", "tiling", "rules",
                  "version"}


async def sky_owner(env, w, name="skyowner"):
    _, token = await account(name)
    ok(env.cl.post(f"/api/workspaces/{w.sky['id']}/members", headers=hdr(w.founder[1]),
                   json={"login": name, "role": "owner"}))
    return token


async def test_catalogue_readers_get_a_reduced_card(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    # A failed v2 exists too: it must not show through.
    ok(await upload(env, w.olga[1], w.iith["id"], onnx_files.custom, model_id=m["id"]))
    await service.wait_for_checks()
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(w.founder[1])))
    sky = await sky_owner(env, w)
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.sky['id']}", headers=hdr(sky)))
    card = next(c for c in lib["hyrak"] if c["kind"] == "catalogue")
    got = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(sky)))["model"]
    for c in (card, got):
        assert set(c) == CATALOGUE_KEYS
        assert set(c["version"]) == {"n", "latency_ms", "fps", "gpu_mem_mb", "provider",
                                     "input_shape", "preview"}
        assert c["version"]["n"] == 1 and c["version"]["preview"] is True
        assert c["labels"] == ["person", "crack", "car"] and c["task"] == "detect"
        text = repr(c)
        for leak in (w.iith["id"], w.olga[0].id, "custom_ops", "com.acme", "sha256"):
            assert leak not in text
    assert (await env.api.get(f"/api/models/{m['id']}/preview", headers=hdr(sky))).status_code == 200
    r = await env.api.get(f"/api/models/{m['id']}/preview?version=2", headers=hdr(sky))
    assert r.status_code == 404
    # The owner still sees the whole card, with the pin.
    own = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.olga[1])))["model"]
    assert own["published_version"] == 1 and len(own["versions"]) == 2 and own["details"]


async def test_the_catalogue_is_pinned_to_what_the_founder_published(env, onnx_files, tmp_path):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    url = f"/api/models/{m['id']}"
    r = await env.api.post(f"{url}/publish", headers=hdr(w.founder[1]), json={"version": 7})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_ready"
    ok(await env.api.post(f"{url}/publish", headers=hdr(w.founder[1])))
    sky = await sky_owner(env, w)

    # The workspace changes its own copy: name, labels, threshold, a new
    # version with other class names, a retest.
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={
        "name": "Renamed", "labels": ["x", "y", "z"], "threshold": 0.8}))
    other = make_model(tmp_path / "v2.onnx", {"output0": yolov8_output()},
                       metadata=ultra_meta(names="{0: 'a', 1: 'b', 2: 'c'}"))
    ok(await upload(env, w.olga[1], w.iith["id"], other, model_id=m["id"]))
    await service.wait_for_checks()
    ok(await env.api.post(f"{url}/retest", headers=hdr(w.olga[1])))
    await service.wait_for_checks()
    own = ok(await env.api.get(url, headers=hdr(w.olga[1])))["model"]
    assert own["current_version"] == 2 and own["name"] == "Renamed" and own["published_version"] == 1

    # Catalogue users see and run exactly what was published.
    cat = ok(await env.api.get(url, headers=hdr(sky)))["model"]
    assert cat["name"] == "Crack finder" and cat["labels"] == ["person", "crack", "car"]
    assert cat["threshold"] == 0.25 and cat["version"]["n"] == 1
    mode = await service.resolve_run(sess(w.sky["id"]), m["id"])
    assert mode.spec.version == 1 and mode.spec.labels == ["person", "crack", "car"]
    assert mode.spec.threshold == 0.25 and mode.spec.alert is None and mode.spec.name == "Crack finder"
    mine = await service.resolve_run(sess(w.iith["id"]), m["id"])
    # (the workspace's own label names stick to later versions of its copy)
    assert mine.spec.version == 2 and mine.spec.labels == ["x", "y", "z"]
    # A task override in the workspace re-checks its own copy only.
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"task": "classify"}))
    await service.wait_for_checks()
    mode = await service.resolve_run(sess(w.sky["id"]), m["id"])
    assert mode.spec.spec["task"] == "detect" and mode.spec.version == 1

    # Without the feature the owner runs the catalogue pin, not its copy.
    await feature(env, w, w.iith["id"], on=False)
    pinned = await service.resolve_run(sess(w.iith["id"]), m["id"])
    assert pinned.spec.version == 1 and pinned.spec.labels == ["person", "crack", "car"]
    await feature(env, w, w.iith["id"], on=True)

    # Only a founder moves the pin (v2 failed its task re-check; set back, it passes).
    r = await env.api.post(f"{url}/publish", headers=hdr(w.olga[1]), json={"version": 2})
    assert r.status_code == 403
    ok(await env.api.patch(url, headers=hdr(w.olga[1]), json={"task": "detect"}))
    await service.wait_for_checks()
    ok(await env.api.post(f"{url}/publish", headers=hdr(w.founder[1]), json={"version": 2}))
    cat = ok(await env.api.get(url, headers=hdr(sky)))["model"]
    assert cat["version"]["n"] == 2 and cat["name"] == "Renamed" and cat["labels"] == ["x", "y", "z"]
    # Taking it out of the catalogue hides it again.
    ok(await env.api.post(f"{url}/publish", headers=hdr(w.founder[1]), json={"published": False}))
    assert (await env.api.get(url, headers=hdr(sky))).status_code == 404
    with pytest.raises(ModelFailure):
        await service.resolve_run(sess(w.sky["id"]), m["id"])


# ── the catalogue's own copy, version folders, deletes, stopping ─────────

async def select(env, sid, model_id):
    """set_analysis_mode on the real handler, waiting for the load."""
    await env.sio.handlers["/"]["set_analysis_mode"](sid, {"mode": f"custom:{model_id}"})
    for _ in range(200):
        last = env.rec.of("model_status", sid)
        if last and last[-1].get("mode") == f"custom:{model_id}" and last[-1]["status"] != "loading":
            return last[-1]
        await asyncio.sleep(0.05)
    raise AssertionError("model did not load")


async def test_catalogue_runs_from_its_own_hash_checked_copy(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(w.founder[1])))
    copy_dir = storage.catalogue_dir(m["id"], 1)
    own_file = storage.version_dir(w.iith["id"], m["id"], 1) / "model.onnx"
    assert (copy_dir / "model.onnx").read_bytes() == own_file.read_bytes()
    assert (copy_dir / "preview.jpg").is_file()
    mode = await service.resolve_run(sess(w.sky["id"]), m["id"])
    assert mode.spec.via_catalogue and Path(mode.spec.model_path).parent == copy_dir
    assert set(mode.spec.files) == {"model.onnx"}

    # The owning workspace's file changes: the catalogue does not care, the
    # workspace's own run is refused before a runner starts.
    own_file.write_bytes(own_file.read_bytes() + b"\0")
    a = await asyncio.to_thread(mode.build_analyzer)
    await a.stop()
    mine = await service.resolve_run(sess(w.iith["id"]), m["id"])
    assert not mine.spec.via_catalogue and mine.spec.key != mode.spec.key
    with pytest.raises(RuntimeError) as e:
        await asyncio.to_thread(mine.build_analyzer)
    assert "not the one that was checked" in str(e.value)

    # And the catalogue copy itself is checked too.
    runtime.pool().stop_all()
    (copy_dir / "model.onnx").write_bytes(b"tampered")
    with pytest.raises(RuntimeError) as e:
        await asyncio.to_thread((await service.resolve_run(sess(w.sky["id"]), m["id"])).build_analyzer)
    assert "not the one that was checked" in str(e.value)


async def test_a_version_folder_is_never_written_twice(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    v1 = storage.version_dir(w.iith["id"], m["id"], 1) / "model.onnx"
    before = v1.read_bytes()
    # Something already sits where v2 would go: the upload is refused and
    # leaves no row and no staging behind.
    squatter = storage.version_dir(w.iith["id"], m["id"], 2)
    squatter.mkdir()
    (squatter / "model.onnx").write_bytes(b"not ours")
    r = await upload(env, w.olga[1], w.iith["id"], onnx_files.classify, model_id=m["id"])
    assert r.status_code == 500 and r.json()["detail"]["code"] == "storage_failed"
    assert (squatter / "model.onnx").read_bytes() == b"not ours" and v1.read_bytes() == before
    got = ok(await env.api.get(f"/api/models/{m['id']}", headers=hdr(w.olga[1])))["model"]
    assert [v["n"] for v in got["versions"]] == [1]
    assert not list(storage.model_dir(w.iith["id"], m["id"]).glob(".incoming-*"))
    # Version numbers are reserved in the store: a taken number moves on.
    store = model_store.write_store()
    with pytest.raises(model_store.VersionTaken):
        await store.add_version(model_store.VersionRecord(id="x", model_id=m["id"], n=1))
    await store.add_version(model_store.VersionRecord(id="y", model_id=m["id"], n=2))
    assert await service._reserve_version(store, m["id"]) == 3


async def test_deleting_a_workspace_with_published_models_needs_a_founder(env, onnx_files):
    w = await world(env)
    f = w.founder[1]
    solo = ok(env.cl.post("/api/workspaces", headers=hdr(f),
                          json={"name": "Solo", "kind": "organization"}))["workspace"]
    _, owner = await account("soloowner")
    ok(env.cl.post(f"/api/workspaces/{solo['id']}/members", headers=hdr(f),
                   json={"login": "soloowner", "role": "owner"}))
    await feature(env, w, solo["id"])
    m = ok(await upload(env, owner, solo["id"], onnx_files.detect))["model"]
    await service.wait_for_checks()
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(f)))
    r = await env.api.delete(f"/api/workspaces/{solo['id']}", headers=hdr(owner))
    assert r.status_code == 409 and "HYRAK catalogue" in r.json()["detail"]
    ok(await env.api.delete(f"/api/workspaces/{solo['id']}", headers=hdr(f)))
    assert not storage.catalogue_model_dir(m["id"]).exists()
    assert not storage.workspace_dir(solo["id"]).exists()
    lib = ok(await env.api.get(f"/api/models?workspace_id={w.iith['id']}", headers=hdr(w.olga[1])))
    assert m["id"] not in [c["id"] for c in lib["hyrak"]]
    # Without published models an owner deletes as before.
    plain = ok(env.cl.post("/api/workspaces", headers=hdr(f),
                           json={"name": "Plain", "kind": "organization"}))["workspace"]
    ok(env.cl.post(f"/api/workspaces/{plain['id']}/members", headers=hdr(f),
                   json={"login": "soloowner", "role": "owner"}))
    ok(await env.api.delete(f"/api/workspaces/{plain['id']}", headers=hdr(owner)))


async def test_unpublish_and_repin_stop_every_catalogue_session(env, onnx_files):
    w = await world(env)
    m = await ready_model(env, w, onnx_files.detect)
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(w.founder[1])))
    sky = await sky_owner(env, w)
    await connect(env, "sky", sky, workspace_id=w.sky["id"])
    await connect(env, "pat", w.pat[1])
    # The owning workspace without the feature runs it on the catalogue path.
    await feature(env, w, w.iith["id"], on=False)
    assert (await select(env, "sky", m["id"]))["status"] == "ready"
    assert (await select(env, "pat", m["id"]))["status"] == "ready"
    assert session(env, "pat").mode.spec.via_catalogue
    # Re-pinning (same version, fresh snapshot) puts both back on manual.
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(w.founder[1])))
    assert session(env, "sky").mode.value == "manual-control"
    assert session(env, "pat").mode.value == "manual-control"
    await select(env, "sky", m["id"])
    await select(env, "pat", m["id"])
    ok(await env.api.post(f"/api/models/{m['id']}/publish", headers=hdr(w.founder[1]),
                          json={"published": False}))
    assert session(env, "sky").mode.value == "manual-control"
    assert session(env, "pat").mode.value == "manual-control"
    assert errors(env, "pat")[-1]["code"] == "model_removed"
    assert not storage.catalogue_dir(m["id"], 1).exists()


async def test_switching_the_feature_off_stops_own_models_only(env, onnx_files):
    w = await world(env)
    own = await ready_model(env, w, onnx_files.detect)
    cat = await ready_model(env, w, onnx_files.classify, name="Shared")
    ok(await env.api.post(f"/api/models/{cat['id']}/publish", headers=hdr(w.founder[1])))
    sky = await sky_owner(env, w)
    await connect(env, "pat", w.pat[1])
    await connect(env, "sky", sky, workspace_id=w.sky["id"])
    await connect(env, "hp", w.founder[1], workspace_id=w.iith["id"])     # staff in IITH
    await select(env, "pat", own["id"])
    await select(env, "sky", cat["id"])
    await select(env, "hp", own["id"])
    await feature(env, w, w.iith["id"], on=False)
    assert session(env, "pat").mode.value == "manual-control"           # own model: stopped
    assert errors(env, "pat")[-1]["code"] == "model_removed"
    assert session(env, "sky").mode.value == f"custom:{cat['id']}"       # catalogue: runs on
    assert session(env, "hp").mode.value == f"custom:{own['id']}"        # staff: always entitled
    await select(env, "pat", own["id"])
    assert errors(env, "pat")[-1]["code"] == "not_entitled"

"""
The model browser (docs/custom_models/DESIGN.md section 0, "Browse"): the
curated recommended list and the Hugging Face search, with the network
replaced throughout. Also the Hub's HTTP 429 mapped to `hf_rate_limited`
on every path, and the optional HF_TOKEN.
"""
import datetime as dt
import json
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from test_custom_models import SHA, env, fake_hub, feature, onnx_files  # noqa: F401  (fixtures)
from test_live_scope import hdr, live, ok, world  # noqa: F401  (live is a fixture)
from app.config import get_settings
from app.models_custom import browse, hf, service
from app.models_custom.errors import ModelFailure


@pytest.fixture(autouse=True)
def fresh():
    browse.reset_for_tests()
    yield
    browse.reset_for_tests()


# ── recommended.json ─────────────────────────────────────────────────────

def test_shipped_recommended_list_is_valid():
    raw = json.loads(browse.RECOMMENDED_FILE.read_text())
    entries = browse.validate_recommended(raw)
    assert entries, "recommended.json is empty"
    for e in entries:
        assert set(e) == browse._ENTRY_KEYS, e["repo"]
        assert e["file"].lower().endswith(".onnx"), e["repo"]
        assert e["category"] in browse.CATEGORIES and e["task"] in ("detect", "classify")
        assert "\u2014" not in json.dumps(e, ensure_ascii=False)


def test_recommended_validation_names_the_problem():
    good = json.loads(browse.RECOMMENDED_FILE.read_text())["models"][0]

    def bad(**change):
        with pytest.raises(ValueError):
            browse.validate_recommended({"models": [{**good, **change}]})
    bad(file="model.pt")
    bad(category="Space")
    bad(task="segment")
    bad(repo="not a repo")
    bad(fps=-3)
    bad(verified_at="yesterday")
    bad(classes_preview="person")
    with pytest.raises(ValueError):
        browse.validate_recommended({"models": [good, good]})            # listed twice
    with pytest.raises(ValueError):
        browse.validate_recommended({"models": [{k: v for k, v in good.items() if k != "what"}]})
    # Licence notes are filled for licences with commercial strings.
    agpl, nc = (browse.validate_recommended({"models": [{**good, "license": lic}]})[0]
                for lic in ("agpl-3.0", "cc-by-nc-4.0"))
    assert agpl["license_note"].startswith("Free to try; commercial use needs an Ultralytics")
    assert nc["license_note"] == "Non-commercial use only."


def test_a_broken_recommended_file_serves_an_empty_list(tmp_path):
    p = tmp_path / "r.json"
    p.write_text('{"models": [{"repo": "a/b"}]}')
    try:
        assert browse.load_recommended(p) == []
    finally:
        browse.load_recommended()
    assert browse.recommended()


async def test_recommended_endpoint_marks_what_the_workspace_has(env, onnx_files, monkeypatch):
    w = await world(env)
    # Browsing is open without the premium feature, to every viewer.
    r = ok(await env.api.get(f"/api/models/huggingface/recommended?workspace_id={w.iith['id']}",
                             headers=hdr(w.vic[1])))
    assert r["premium"]["enabled"] is False and r["can_manage"] is False
    names = [c["name"] for c in r["categories"]]
    assert names == [c for c in browse.CATEGORIES if c in names]          # fixed order
    first = r["categories"][0]["models"][0]
    assert first["added"] is None and first["url"] == f"https://huggingface.co/{first['repo']}"
    assert {"repo", "file", "name", "what", "classes_preview", "fps", "license", "license_note",
            "verified_at", "task", "category"} <= set(first)
    # Someone else's workspace does not exist.
    assert (await env.api.get(f"/api/models/huggingface/recommended?workspace_id={w.sky['id']}",
                              headers=hdr(w.vic[1]))).status_code == 404

    await feature(env, w, w.iith["id"])
    fake_hub(monkeypatch, {first["file"]: onnx_files.detect.read_bytes()})
    m = ok(await env.api.post("/api/models/huggingface", headers=hdr(w.olga[1]), json={
        "workspace_id": w.iith["id"], "repo": first["repo"], "file": first["file"]}))["model"]
    await service.wait_for_checks()
    r = ok(await env.api.get(f"/api/models/huggingface/recommended?workspace_id={w.iith['id']}",
                             headers=hdr(w.olga[1])))
    again = next(x for c in r["categories"] for x in c["models"]
                 if (x["repo"], x["file"]) == (first["repo"], first["file"]))
    assert again["added"] == m["id"] and r["premium"]["enabled"]


# ── search ───────────────────────────────────────────────────────────────

def hub_model(repo, files, *, pipeline="object-detection", downloads=10, likes=1, license="mit",
              gated=False, private=False, used=None):
    return SimpleNamespace(
        id=repo, siblings=[SimpleNamespace(rfilename=f) for f in files], pipeline_tag=pipeline,
        downloads=downloads, likes=likes, last_modified=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc),
        card_data={"license": license} if license else None, tags=[], gated=gated, private=private,
        used_storage=used)


def fake_list(monkeypatch, by_pipeline: dict, calls=None):
    calls = calls if calls is not None else []

    def list_models(search, pipeline_tag, limit, timeout):
        calls.append((search, pipeline_tag, limit))
        return list(by_pipeline.get(pipeline_tag, []))[:limit]
    monkeypatch.setattr(browse, "_list_models", list_models)
    return calls


async def test_search_cards_reasons_and_order(env, monkeypatch):
    w = await world(env)
    calls = fake_list(monkeypatch, {
        "object-detection": [
            hub_model("ultra/yolo-pt", ["best.pt", "README.md"], downloads=9000, license="agpl-3.0"),
            hub_model("acme/fire-onnx", ["onnx/model.onnx", "onnx/model_quantized.onnx"], downloads=50),
            hub_model("acme/gated", ["model.onnx"], downloads=8000, gated="manual"),
            hub_model("acme/weights", ["model.safetensors"], downloads=7000, license="cc-by-nc-4.0"),
            hub_model("acme/huge", ["big.onnx"], downloads=40, used=10 * 1024 ** 3),
        ],
        "image-classification": [hub_model("acme/fire-cls", ["fire.onnx"], pipeline="image-classification",
                                           downloads=60)],
        "image-segmentation": [hub_model("acme/seg", ["model.onnx"], pipeline="image-segmentation",
                                         downloads=99999)],
    })

    def model_info(repo, timeout):
        assert repo == "acme/huge"
        return SimpleNamespace(siblings=[SimpleNamespace(rfilename="big.onnx", size=9 * 1024 ** 3)])
    monkeypatch.setattr(hf, "_model_info", model_info)

    # A viewer without the premium feature can search.
    r = ok(await env.api.get(f"/api/models/huggingface/search?q=fire&workspace_id={w.iith['id']}",
                             headers=hdr(w.vic[1])))
    assert r["premium"]["enabled"] is False and r["task"] == "all" and r["cached"] is False
    assert {p for _, p, _ in calls} == {"object-detection", "image-classification", "image-segmentation"}
    assert all(s == "fire" for s, _, _ in calls)
    by = {c["repo"]: c for c in r["results"]}
    assert [c["repo"] for c in r["results"] if c["runnable"]] == ["acme/fire-cls", "acme/fire-onnx"]
    assert all(not c["runnable"] for c in r["results"][2:])                  # runnable first
    assert by["acme/fire-onnx"]["suggested_file"] == "onnx/model.onnx"
    assert by["acme/fire-onnx"]["onnx_files"] == ["onnx/model.onnx", "onnx/model_quantized.onnx"]
    assert by["acme/fire-cls"]["task"] == "classify"
    assert by["ultra/yolo-pt"]["reason"] == browse.REASON_PT
    assert by["ultra/yolo-pt"]["license_note"].startswith("Free to try")
    assert by["acme/gated"]["reason"] == "Gated or private"
    assert by["acme/weights"]["reason"] == browse.REASON_WEIGHTS
    assert by["acme/weights"]["license_note"] == "Non-commercial use only."
    assert by["acme/seg"]["reason"] == "Segmentation - coming soon" and by["acme/seg"]["task"] == "segment"
    assert by["acme/huge"]["reason"] == "Too large"
    c = by["acme/fire-onnx"]
    assert set(c) == {"repo", "name", "url", "task", "downloads", "likes", "updated", "license",
                      "license_note", "onnx_files", "suggested_file", "runnable", "reason", "added"}
    assert c["updated"].startswith("2026-09-01") and c["added"] is None

    # The same query again comes from the cache: no Hub call.
    n = len(calls)
    r2 = ok(await env.api.get(f"/api/models/huggingface/search?q=FIRE&workspace_id={w.iith['id']}",
                              headers=hdr(w.olga[1])))
    assert r2["cached"] is True and len(calls) == n and r2["results"] == r["results"]

    # One task only.
    calls.clear()
    r = ok(await env.api.get(f"/api/models/huggingface/search?q=fire&task=classify&workspace_id={w.iith['id']}",
                             headers=hdr(w.vic[1])))
    assert [p for _, p, _ in calls] == ["image-classification"]
    assert [c["repo"] for c in r["results"]] == ["acme/fire-cls"]
    bad = await env.api.get(f"/api/models/huggingface/search?task=segment&workspace_id={w.iith['id']}",
                            headers=hdr(w.vic[1]))
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_request"


async def test_search_marks_added_and_pages(env, onnx_files, monkeypatch):
    w = await world(env)
    await feature(env, w, w.iith["id"])
    many = [hub_model(f"acme/m{i}", ["model.onnx"], downloads=1000 - i) for i in range(45)]
    calls = fake_list(monkeypatch, {"object-detection": many})
    fake_hub(monkeypatch, {"model.onnx": onnx_files.detect.read_bytes()})
    m = ok(await env.api.post("/api/models/huggingface", headers=hdr(w.olga[1]),
                              json={"workspace_id": w.iith["id"], "repo": "acme/m1"}))["model"]
    await service.wait_for_checks()
    r = ok(await env.api.get(f"/api/models/huggingface/search?task=detect&workspace_id={w.iith['id']}",
                             headers=hdr(w.olga[1])))
    assert len(r["results"]) == browse.PAGE_SIZE and r["has_more"]
    assert r["results"][1]["repo"] == "acme/m1" and r["results"][1]["added"] == m["id"]
    r = ok(await env.api.get(f"/api/models/huggingface/search?task=detect&page=3&workspace_id={w.iith['id']}",
                             headers=hdr(w.olga[1])))
    assert [c["repo"] for c in r["results"]] == [f"acme/m{i}" for i in range(40, 45)]
    assert not r["has_more"] and calls[-1][2] == 3 * browse.PAGE_SIZE + 1


async def test_search_per_user_limit(env, monkeypatch):
    w = await world(env)
    fake_list(monkeypatch, {})
    monkeypatch.setattr(get_settings(), "custom_models_hf_searches_per_minute", 2)
    url = f"/api/models/huggingface/search?task=detect&workspace_id={w.iith['id']}&q="
    for q in ("a", "b"):
        ok(await env.api.get(url + q, headers=hdr(w.vic[1])))
    r = await env.api.get(url + "c", headers=hdr(w.vic[1]))
    assert r.status_code == 429 and r.json()["detail"]["code"] == "search_rate_limited"
    assert r.json()["detail"]["hint"] == "Wait a minute and try again."
    ok(await env.api.get(url + "a", headers=hdr(w.vic[1])))                  # cached: free
    ok(await env.api.get(url + "c", headers=hdr(w.olga[1])))                 # another user


# ── HTTP 429 from the Hub ────────────────────────────────────────────────

class HubError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.response = SimpleNamespace(status_code=status)


async def test_hub_429_is_hf_rate_limited_everywhere(env, tmp_path, monkeypatch):
    w = await world(env)
    await feature(env, w, w.iith["id"])
    calls = []

    def list_429(search, pipeline_tag, limit, timeout):
        calls.append(1)
        raise HubError(429)
    monkeypatch.setattr(browse, "_list_models", list_429)
    r = await env.api.get(f"/api/models/huggingface/search?q=x&workspace_id={w.iith['id']}",
                          headers=hdr(w.olga[1]))
    assert r.status_code == 429
    d = r.json()["detail"]
    assert d["code"] == "hf_rate_limited"
    assert d["error"] == "Hugging Face is busy right now (too many requests)."
    assert d["hint"] == "Wait a minute and try again."
    # The cooldown: nothing else goes out to the Hub for a while.
    info_calls = []
    monkeypatch.setattr(hf, "_model_info", lambda repo, timeout: info_calls.append(repo))
    r = await env.api.get(f"/api/models/huggingface/inspect?repo=acme/x&workspace_id={w.iith['id']}",
                          headers=hdr(w.olga[1]))
    assert r.json()["detail"]["code"] == "hf_rate_limited" and not info_calls
    r = await env.api.get(f"/api/models/huggingface/search?q=y&workspace_id={w.iith['id']}",
                          headers=hdr(w.olga[1]))
    assert r.status_code == 429 and len(calls) == 1

    # Inspect and download map their own 429s too.
    hf.reset_cooldown()

    def info_429(repo, timeout):
        raise HubError(429)
    monkeypatch.setattr(hf, "_model_info", info_429)
    r = await env.api.get(f"/api/models/huggingface/inspect?repo=acme/x&workspace_id={w.iith['id']}",
                          headers=hdr(w.olga[1]))
    assert r.status_code == 429 and r.json()["detail"]["code"] == "hf_rate_limited"

    hf.reset_cooldown()

    async def stream_429(url, timeout):
        raise hf._rate_limited(f"HTTP 429 for {url}")
        yield b""                                                           # pragma: no cover
    monkeypatch.setattr(hf, "_stream", stream_429)
    with pytest.raises(ModelFailure) as e:
        await hf.download("a/b", SHA, "model.onnx", tmp_path / "m.onnx", limit=10_000)
    assert e.value.code == "hf_rate_limited" and not list(tmp_path.iterdir())


async def test_real_stream_maps_429(monkeypatch):
    import httpx
    real_client = httpx.AsyncClient
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(429)

    def client(**kw):
        return real_client(transport=httpx.MockTransport(handler), **kw)
    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setattr(get_settings(), "hf_token", SecretStr("hf_secret_123"))
    with pytest.raises(ModelFailure) as e:
        async for _ in hf._stream("https://huggingface.co/a/b/resolve/x/model.onnx", 5):
            pass
    assert e.value.code == "hf_rate_limited" and e.value.status == 429
    assert seen["auth"] == "Bearer hf_secret_123"
    hf.reset_cooldown()


def test_hf_token_is_optional_and_secret(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hf_token", SecretStr(""))
    assert hf.token() is False
    monkeypatch.setattr(s, "hf_token", SecretStr("hf_secret_123"))
    assert hf.token() == "hf_secret_123"
    assert "hf_secret_123" not in repr(s) and "hf_secret_123" not in str(s.model_dump())

"""
The model browser: HYRAK's recommended list and a search over Hugging Face
vision models (docs/custom_models/DESIGN.md section 0, "Browse").

Search turns the Hub's model list into plain cards. A card is `runnable`
when HYRAK can add it today: a public repo with an .onnx file within the
size limit, for a task HYRAK runs (find objects, classify pictures).
Everything else stays in the results, marked with the plain reason, so
people see what the library will hold after the sandbox update.

The Hub is called as little as possible: one list call per task (with
`expand`, so files, likes, downloads, licence and gating come back in the
same answer), at most a few `model_info` calls to size large repos, answers
cached per query for 10 minutes, and a per-user limit on uncached searches.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from app.config import get_settings
from app.models_custom import hf, storage
from app.models_custom.errors import ModelFailure

logger = logging.getLogger("verocore.models")

# ── licences ──────────────────────────────────────────────────────────────

LICENSE_NOTES = {
    "agpl-3.0": "Free to try; commercial use needs an Ultralytics licence or AGPL compliance.",
    "cc-by-nc": "Non-commercial use only.",
}


def license_note(lic: Optional[str]) -> Optional[str]:
    """The plain note for licences with commercial strings attached."""
    v = (lic or "").strip().lower()
    if not v:
        return None
    if v.startswith("agpl"):
        return LICENSE_NOTES["agpl-3.0"]
    if v.startswith("cc-by-nc"):
        return LICENSE_NOTES["cc-by-nc"]
    return None


# ── recommended ───────────────────────────────────────────────────────────

RECOMMENDED_FILE = Path(__file__).with_name("recommended.json")
CATEGORIES = (
    "Drone and aerial view",
    "Fire and safety",
    "Roads and vehicles",
    "Construction and people",
    "Agriculture and nature",
    "General purpose",
)
TASKS = ("detect", "classify")
_ENTRY_KEYS = {"repo", "file", "name", "category", "task", "what", "license", "license_note",
               "classes_preview", "fps", "verified_at"}
_recommended: Optional[list] = None


def validate_recommended(data) -> list:
    """The entries of recommended.json, checked; ValueError names the
    first problem."""
    if isinstance(data, dict) and set(data) - {"models", "_comment"}:
        raise ValueError(f"unknown top-level keys {sorted(set(data) - {'models', '_comment'})}")
    entries = data.get("models") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError('recommended.json needs {"models": [...]}')
    out, seen = [], set()
    for i, e in enumerate(entries):
        where = f"entry {i} ({e.get('repo') if isinstance(e, dict) else e!r})"
        if not isinstance(e, dict):
            raise ValueError(f"{where}: not an object")
        missing = _ENTRY_KEYS - set(e)
        if missing:
            raise ValueError(f"{where}: missing {sorted(missing)}")
        extra = set(e) - _ENTRY_KEYS
        if extra:
            raise ValueError(f"{where}: unknown keys {sorted(extra)}")
        try:
            parsed = hf.parse_repo(e["repo"]) if isinstance(e["repo"], str) else None
        except ModelFailure:
            parsed = None
        if parsed is None or e["repo"] != parsed:
            raise ValueError(f"{where}: repo must be owner/name")
        if not isinstance(e["file"], str) or not e["file"].lower().endswith(".onnx") \
                or ".." in e["file"] or e["file"].startswith("/"):
            raise ValueError(f"{where}: file must be a path ending in .onnx")
        for k in ("name", "what"):
            if not isinstance(e[k], str) or not e[k].strip():
                raise ValueError(f"{where}: {k} must be text")
            if "\u2014" in e[k]:
                raise ValueError(f"{where}: no em-dashes in {k}")
        if e["category"] not in CATEGORIES:
            raise ValueError(f"{where}: category must be one of {CATEGORIES}")
        if e["task"] not in TASKS:
            raise ValueError(f"{where}: task must be detect or classify")
        if not isinstance(e["license"], str):
            raise ValueError(f"{where}: license must be text")
        if e["license_note"] is not None and not isinstance(e["license_note"], str):
            raise ValueError(f"{where}: license_note must be text or null")
        cp = e["classes_preview"]
        if not isinstance(cp, list) or not all(isinstance(c, str) and c for c in cp):
            raise ValueError(f"{where}: classes_preview must be a list of names")
        if e["fps"] is not None and (isinstance(e["fps"], bool)
                                     or not isinstance(e["fps"], (int, float)) or e["fps"] <= 0):
            raise ValueError(f"{where}: fps must be a positive number or null")
        if e["verified_at"] is not None and not (
                isinstance(e["verified_at"], str) and re.match(r"^\d{4}-\d{2}-\d{2}", e["verified_at"])):
            raise ValueError(f"{where}: verified_at must be a date (YYYY-MM-DD) or null")
        key = (e["repo"], e["file"])
        if key in seen:
            raise ValueError(f"{where}: listed twice")
        seen.add(key)
        out.append({**e, "license_note": e["license_note"] or license_note(e["license"])})
    return out


def load_recommended(path: Optional[Path] = None) -> list:
    """Read and validate the curated list (at startup, and lazily). A broken
    file is logged and serves an empty list rather than stopping the server."""
    global _recommended
    try:
        _recommended = validate_recommended(json.loads((path or RECOMMENDED_FILE).read_text()))
    except Exception as e:
        logger.error(f"custom models: recommended.json refused ({e})")
        _recommended = []
    return _recommended


def recommended() -> list:
    return _recommended if _recommended is not None else load_recommended()


def grouped(entries: list, added: dict) -> list:
    """[{name, models}] in CATEGORIES order, empty categories left out.
    `added`: (repo, file) -> model id already in the workspace."""
    out = []
    for cat in CATEGORIES:
        models = [{**e, "url": f"https://huggingface.co/{e['repo']}",
                   "added": added.get((e["repo"], e["file"]))}
                  for e in entries if e["category"] == cat]
        if models:
            out.append({"name": cat, "models": models})
    return out


# ── search ────────────────────────────────────────────────────────────────

PIPELINES = {
    "detect": ("object-detection",),
    "classify": ("image-classification",),
    "all": ("object-detection", "image-classification", "image-segmentation"),
}
TASK_OF = {"object-detection": "detect", "image-classification": "classify",
           "image-segmentation": "segment"}
PAGE_SIZE = 20
MAX_PAGE = 4
SIZE_LOOKUPS = 3                                    # model_info calls per search, at most
# What the Hub's listing accepts in `expand` (checked live 2026-10-18; it
# refuses usedStorage, so repo sizes are not in the listing).
EXPAND = ["siblings", "likes", "downloads", "lastModified", "cardData", "gated", "private",
          "pipeline_tag", "tags"]

REASON_GATED = "Gated - needs approval on Hugging Face"
REASON_SEGMENT = "Segmentation - coming soon"
REASON_PT = "Only PyTorch .pt files - supported after the HYRAK sandbox update"
REASON_WEIGHTS = "Only PyTorch or safetensors weights - supported after the HYRAK sandbox update"
REASON_NO_FILE = "No ONNX file in this repo"
REASON_LARGE = "Too large"
REASON_TASK = "Not a vision task HYRAK runs yet"

_PREFER = ("model.onnx", "onnx/model.onnx")
_QUANT = re.compile(r"(quant|int8|uint8|q4|bnb4|fp16|_q\d)", re.I)


def suggest_file(paths: list) -> Optional[str]:
    """The .onnx a one-click add uses: model.onnx, else the first file that
    is not a quantized variant, else the first."""
    if not paths:
        return None
    for p in _PREFER:
        if p in paths:
            return p
    return hf.rank_onnx(list(paths))[0]


def _list_models(search: str, pipeline_tag: str, limit: int, timeout: float) -> list:
    """huggingface_hub list_models, most downloaded first. Replaced in tests.

    Always ANONYMOUS (token=False): the listing is exactly what the public
    sees, so the owner's HF_TOKEN can never put the owner's private repos in
    a client's results. The token is only used for calls on one named repo
    (inspect, download, sizes), which refuse private repos anyway."""
    from huggingface_hub import HfApi
    api = HfApi(endpoint=get_settings().custom_models_hf_endpoint, token=False)
    # list_models takes no timeout; huggingface_hub's default request timeout applies.
    return list(api.list_models(search=search or None, pipeline_tag=pipeline_tag, sort="downloads",
                                direction=-1, limit=limit, expand=EXPAND, token=False))


def _license_of(m) -> Optional[str]:
    card = getattr(m, "card_data", None) or getattr(m, "cardData", None)
    lic = None
    try:
        lic = (card or {}).get("license")
    except Exception:
        lic = getattr(card, "license", None)
    if isinstance(lic, list):
        lic = lic[0] if lic else None
    if not lic:
        for t in getattr(m, "tags", None) or []:
            if isinstance(t, str) and t.startswith("license:"):
                lic = t.split(":", 1)[1]
                break
    return str(lic) if lic else None


def _iso(v) -> Optional[str]:
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _card(m, pipeline: str, limit_bytes: int) -> dict:
    repo = getattr(m, "id", None) or getattr(m, "modelId", "")
    files = [s.rfilename for s in (getattr(m, "siblings", None) or [])]
    onnx = [f for f in files if f.lower().endswith(".onnx")]
    lic = _license_of(m)
    pipe = getattr(m, "pipeline_tag", None) or pipeline
    task = TASK_OF.get(pipe)
    card = {
        "repo": repo, "name": repo.split("/", 1)[-1], "url": f"https://huggingface.co/{repo}",
        "task": task, "downloads": int(getattr(m, "downloads", 0) or 0),
        "likes": int(getattr(m, "likes", 0) or 0), "updated": _iso(getattr(m, "last_modified", None)),
        "license": lic, "license_note": license_note(lic),
        "onnx_files": onnx, "suggested_file": suggest_file(onnx),
        "runnable": False, "reason": None, "added": None,
        "_size": getattr(m, "used_storage", None) or getattr(m, "usedStorage", None),
    }
    lower = [f.lower() for f in files]
    if getattr(m, "gated", False):
        card["reason"] = REASON_GATED
    elif task == "segment":
        card["reason"] = REASON_SEGMENT
    elif task not in TASKS:
        card["reason"] = REASON_TASK
    elif not onnx:
        if any(f.endswith((".pt", ".pth")) for f in lower):
            card["reason"] = REASON_PT
        elif any(f.endswith((".safetensors", ".bin")) for f in lower):
            card["reason"] = REASON_WEIGHTS
        else:
            card["reason"] = REASON_NO_FILE
    else:
        card["runnable"] = True
    return card


async def _size_check(cards: list, limit_bytes: int) -> None:
    """Repos whose total storage is known to pass the limit: look up the
    .onnx sizes (bounded) and mark a repo whose every .onnx is too big.
    The Hub listing does not return storage today, so this only runs when
    a row carries it; adding a model always checks the size again
    (`too_large`)."""
    s = get_settings()
    timeout = float(s.custom_models_hf_timeout_s)
    big = [c for c in cards if c["runnable"] and c["_size"] and c["_size"] > limit_bytes]
    for c in big[:SIZE_LOOKUPS]:
        try:
            hf._check_cooldown()
            info = await asyncio.wait_for(asyncio.to_thread(hf._model_info, c["repo"], timeout),
                                          timeout=timeout + 5)
        except ModelFailure:
            return
        except Exception as e:
            if getattr(getattr(e, "response", None), "status_code", None) == 429:
                hf._map_hub_error(e)                # starts the cooldown
                return
            continue                                # unknown size: checked again on add
        sizes = {sib.rfilename: getattr(sib, "size", None)
                 for sib in (getattr(info, "siblings", None) or [])}
        fits = [p for p in c["onnx_files"] if not sizes.get(p) or sizes[p] <= limit_bytes]
        if not fits:
            c["runnable"], c["reason"] = False, REASON_LARGE
        elif c["suggested_file"] not in fits:
            c["suggested_file"] = suggest_file(fits)


# (query, task, page) -> (monotonic time, answer)
_cache: "OrderedDict[tuple, tuple]" = OrderedDict()
CACHE_MAX = 256
# user id -> monotonic times of that user's uncached searches in the last minute
_user_calls: dict[str, list] = {}


def reset_for_tests() -> None:
    _cache.clear()
    _user_calls.clear()
    hf.reset_cooldown()


def _rate_check(user_id: str) -> None:
    now = time.monotonic()
    limit = int(get_settings().custom_models_hf_searches_per_minute)
    calls = [t for t in _user_calls.get(user_id, []) if now - t < 60]
    if len(calls) >= limit:
        _user_calls[user_id] = calls
        raise ModelFailure("search_rate_limited", f"{len(calls)} searches in a minute", status=429)
    calls.append(now)
    _user_calls[user_id] = calls
    if len(_user_calls) > 5000:                     # bounded: drop the idle ones
        for k in [k for k, v in _user_calls.items() if not v or now - v[-1] > 60]:
            _user_calls.pop(k, None)


async def search(user_id: str, q: str, task: str, page: int) -> dict:
    """Cards for one page of results; runnable first, then by downloads."""
    q = " ".join((q or "").split())[:100]
    if task not in PIPELINES:
        raise ModelFailure("bad_request", "task", {"reason": "task must be detect, classify or all"},
                           status=422)
    page = max(1, min(int(page or 1), MAX_PAGE))
    key = (q.lower(), task, page)
    ttl = float(get_settings().custom_models_hf_search_cache_s)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        _cache.move_to_end(key)
        return {**hit[1], "cached": True}
    _rate_check(user_id)
    hf._check_cooldown()
    s = get_settings()
    timeout = float(s.custom_models_hf_timeout_s)
    limit_bytes = storage.limit_bytes()
    pipes = PIPELINES[task]
    # Fetch enough for this page: segmentation gets a smaller share in "all".
    per = {p: (PAGE_SIZE if p != "image-segmentation" else PAGE_SIZE // 4) * page for p in pipes}
    cards, more = [], False
    for p in pipes:
        try:
            rows = await asyncio.wait_for(asyncio.to_thread(_list_models, q, p, per[p] + 1, timeout),
                                          timeout=timeout + 10)
        except ModelFailure:
            raise
        except asyncio.TimeoutError:
            raise ModelFailure("hf_unreachable", f"no answer in {timeout:.0f} s")
        except Exception as e:
            raise hf._map_hub_error(e)
        more = more or len(rows) > per[p]
        start = per[p] - per[p] // page
        for m in rows[start:per[p]]:
            # Second layer behind the anonymous listing: a private repo is
            # never turned into a card (nor cached).
            if getattr(m, "private", False):
                continue
            cards.append(_card(m, p, limit_bytes))
    seen, unique = set(), []
    for c in cards:
        if c["repo"] not in seen:
            seen.add(c["repo"])
            unique.append(c)
    await _size_check(unique, limit_bytes)
    unique.sort(key=lambda c: (not c["runnable"], -c["downloads"]))
    for c in unique:
        c.pop("_size", None)
    answer = {"query": q, "task": task, "page": page, "has_more": more and page < MAX_PAGE,
              "results": unique}
    _cache[key] = (time.monotonic(), answer)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)
    return {**answer, "cached": False}

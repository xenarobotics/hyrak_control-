"""
The model library: who may see, add, change, publish and run which model,
and the automatic check every new version goes through
(docs/custom_models/DESIGN.md section 0).

Access, with the permission engine (app/auth/perms.py) on fresh
memberships, like the workspace routes:

  * listing and reading a workspace's models: `view` on it (else 404);
  * adding, editing, retesting, deleting: `models.manage`, plus the
    workspace's `custom_models` feature for adding (HYRAK staff always);
  * publishing to the HYRAK catalogue: founders. Publishing PINS one
    version: a snapshot of its name, description, task, labels, threshold
    and inspect spec (`catalogue`), and a copy of its preview, taken when
    the founder publishes. Other workspaces see a reduced card built only
    from that snapshot and run exactly that version with that spec. The
    owning workspace keeps editing, re-uploading and retesting its own
    copy (its own view only); nothing it does reaches the catalogue until
    a founder publishes again. Deleting a published model needs a founder;
  * running (resolve_run, from set_analysis_mode): `models.run` on the
    session's workspace, and the model is that workspace's own (feature
    on, or a staff session) or a published catalogue model.

Lifecycle of a version: received (upload) or downloading (Hugging Face)
-> inspecting -> testing -> ready | failed, each step pushed as
`model_status`. A model's `current_version` is its newest ready version
(the one that runs); a failed newer version leaves it running.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from app.auth import audit, perms
from app.auth import service as auth
from app.auth.store import PLATFORM_WORKSPACE_ID
from app.config import get_settings
from app.models_custom import browse, catalogue, checks, hf, notify, runtime, storage
from app.models_custom import store as model_store
from app.models_custom.errors import ModelFailure, check_filename, describe
from app.models_custom.store import ModelRecord, VersionRecord

logger = logging.getLogger("verocore.models")

FEATURE = "custom_models"
TASKS = ("detect", "classify")
DEFAULT_THRESHOLD = 0.25
PREMIUM_REASON = ("Adding your own models is a premium feature. Ask HYRAK to turn on Custom "
                  "models for this workspace.")

# model_id -> the step its newest check is on (for the card between pushes).
_steps: dict[str, str] = {}
# model_id -> running check tasks, so shutdown and tests can wait for them.
_tasks: dict[str, set] = {}


def _refuse(status: int, code: str, detail: str = "", **extra) -> ModelFailure:
    return ModelFailure(code, detail, extra, status=status)


NOT_FOUND = dict(status=404, code="not_found")


# ── Access ────────────────────────────────────────────────────────────────

async def _memberships(actor) -> list:
    if actor.id == auth.LEGACY_USER_ID:
        return []
    return await auth.memberships_of(actor.id)


async def _tree():
    from app.workspaces.service import Tree
    return Tree(await auth.read_store().list_workspaces())


def _is_staff(actor, ms) -> bool:
    return actor.id == auth.LEGACY_USER_ID or perms.is_staff(ms)


def _can(actor, ms, ws, perm: str) -> bool:
    if actor.id == auth.LEGACY_USER_ID:
        return ws.id == PLATFORM_WORKSPACE_ID and perm in (perms.VIEW, perms.MODELS_RUN)
    return perms.can(ms, ws, perm)


async def _workspace(actor, workspace_id: Optional[str]):
    """(memberships, tree, workspace) with `view`, else 404. No id: staff
    land on HYRAK, customers on their first workspace with `view`."""
    ms = await _memberships(actor)
    tree = await _tree()
    if not workspace_id:
        if _is_staff(actor, ms):
            workspace_id = PLATFORM_WORKSPACE_ID
        else:
            workspace_id = next((m.workspace_id for m in ms if tree.get(m.workspace_id)
                                 and perms.can(ms, tree.get(m.workspace_id), perms.VIEW)), None)
    ws = tree.get(workspace_id) if workspace_id else None
    if ws is None or not _can(actor, ms, ws, perms.VIEW):
        raise _refuse(404, "not_found", "workspace")
    return ms, tree, ws


def entitlement(actor, ms, ws) -> dict:
    """The library's `premium` block: may this user add models here?"""
    if _is_staff(actor, ms):
        return {"enabled": True, "reason": ""}
    if ws.disabled:
        return {"enabled": False, "reason": "This workspace is switched off."}
    if ws.has_feature(FEATURE):
        return {"enabled": True, "reason": ""}
    return {"enabled": False, "reason": PREMIUM_REASON}


async def _manageable(actor, model_id: str):
    """(record, memberships, tree, workspace) for a change to a model; 404
    when the caller cannot see it, 403 without models.manage."""
    rec = await model_store.read_store().get_model(model_id)
    ms = await _memberships(actor)
    tree = await _tree()
    ws = tree.get(rec.workspace_id) if rec else None
    if rec is None or ws is None or not _can(actor, ms, ws, perms.VIEW):
        raise _refuse(**NOT_FOUND)
    if not _can(actor, ms, ws, perms.MODELS_MANAGE):
        raise _refuse(403, "forbidden")
    return rec, ms, tree, ws


async def _readable(actor, model_id: str):
    """(record, memberships, workspace-or-None): a model of a workspace the
    caller can view, or a published catalogue model (any signed-in user)."""
    rec = await model_store.read_store().get_model(model_id)
    if rec is None:
        raise _refuse(**NOT_FOUND)
    ms = await _memberships(actor)
    tree = await _tree()
    ws = tree.get(rec.workspace_id)
    if ws is not None and _can(actor, ms, ws, perms.VIEW):
        return rec, ms, ws
    if _in_catalogue(rec):
        return rec, ms, None
    raise _refuse(**NOT_FOUND)


def _in_catalogue(rec: ModelRecord) -> bool:
    return bool(rec.published and rec.published_version and rec.catalogue)


async def _audit(actor, action: str, rec: ModelRecord, ip: str, **detail) -> None:
    try:
        store = auth.write_store()
    except Exception:
        store = auth.read_store()
    await audit.record(store, actor, action, workspace_id=rec.workspace_id,
                       target_type="model", target_id=rec.id,
                       detail={"name": rec.name, **detail}, ip=ip)


# ── Cards ─────────────────────────────────────────────────────────────────

_ICONS = {"detect": "scan-search", "classify": "tags"}


def _version_public(v: VersionRecord) -> dict:
    test = (v.details or {}).get("test") or {}
    return {
        "n": v.n, "status": v.status, "error": v.error or None, "hint": v.error_hint or None,
        "sha256": v.sha256, "size_bytes": v.size_bytes, "file_name": v.file_name,
        "hf_revision": v.hf_revision, "task": v.task or None, "input_shape": v.input_shape,
        "labels_count": len(v.labels or []), "latency_ms": v.latency_ms,
        "fps": round(1000.0 / v.latency_ms, 1) if v.latency_ms else None,
        "gpu_mem_mb": v.gpu_mem_mb, "provider": test.get("provider"),
        "preview": bool(v.preview_path), "created_at": model_store.public_dt(v.created_at),
    }


def _details(v: Optional[VersionRecord]) -> Optional[dict]:
    if v is None or not v.details:
        return None
    d = v.details
    keep = ("task", "head", "input", "outputs", "input_size", "input_size_source", "preprocess",
            "label_source", "architecture", "provider", "warnings", "opset", "ir_version",
            "producer", "metadata", "test", "failure")
    return {k: d[k] for k in keep if k in d}


def card(rec: ModelRecord, versions: list[VersionRecord], *, kind: Optional[str] = None,
         full: bool = False) -> dict:
    by_n = {v.n: v for v in versions}
    latest = versions[-1] if versions else None
    current = by_n.get(rec.current_version) if rec.current_version else None
    shown = current or latest
    st = rec.settings or {}
    out = {
        "id": rec.id,
        "kind": kind or ("huggingface" if rec.source == "huggingface" else "uploaded"),
        "run_mode": f"custom:{rec.id}",
        "name": rec.name, "description": rec.description,
        "icon": _ICONS.get(rec.task, "box"),
        "task": rec.task or None,
        "status": rec.status,
        "step": _steps.get(rec.id) or rec.status,
        "error": rec.error or None, "hint": rec.error_hint or None,
        "runnable": rec.current_version is not None,
        "published": rec.published,
        "published_version": rec.published_version,
        "workspace_id": rec.workspace_id,
        "source": rec.source,
        "hf": ({"repo": rec.hf_repo, "revision": rec.hf_revision, "file": rec.hf_file,
                "url": f"https://huggingface.co/{rec.hf_repo}"} if rec.hf_repo else None),
        # Flat copies (DESIGN.md section 0 field names; the frontend reads these).
        "hf_repo": rec.hf_repo, "hf_file": rec.hf_file, "hf_revision": rec.hf_revision,
        "labels": list((shown.labels if shown else []) or []),
        "version": _version_public(shown) if shown else None,
        "current_version": rec.current_version,
        "latest_version": latest.n if latest else None,
        "threshold": float(st.get("threshold", DEFAULT_THRESHOLD)),
        "alert": st.get("alert"),
        "created_by": rec.created_by,
        "created_at": model_store.public_dt(rec.created_at),
        "updated_at": model_store.public_dt(rec.updated_at),
    }
    if full:
        out["versions"] = [_version_public(v) for v in reversed(versions)]   # newest first
        out["details"] = _details(latest)
    return out


def catalogue_card(rec: ModelRecord) -> dict:
    """What another workspace sees of a published model: only the pinned
    snapshot. No workspace, author, version history, failures or inspect
    details."""
    snap = rec.catalogue or {}
    latency = snap.get("latency_ms")
    return {
        "id": rec.id, "kind": "catalogue", "run_mode": f"custom:{rec.id}",
        "name": snap.get("name") or rec.name, "description": snap.get("description") or "",
        "icon": _ICONS.get(snap.get("task"), "box"), "task": snap.get("task") or None,
        "status": "ready", "runnable": True, "published": True,
        "labels": list(snap.get("labels") or []),
        "threshold": float(snap.get("threshold", DEFAULT_THRESHOLD)),
        "version": {"n": rec.published_version, "latency_ms": latency,
                    "fps": round(1000.0 / latency, 1) if latency else None,
                    "gpu_mem_mb": snap.get("gpu_mem_mb"), "provider": snap.get("provider"),
                    "input_shape": snap.get("input_shape"),
                    "preview": bool(snap.get("preview"))},
    }


async def _card(rec: ModelRecord, **kw) -> dict:
    return card(rec, await model_store.read_store().list_versions(rec.id), **kw)


# ── Library ───────────────────────────────────────────────────────────────

async def library(actor, workspace_id: Optional[str]) -> dict:
    ms, tree, ws = await _workspace(actor, workspace_id)
    store = model_store.read_store()
    staff = _is_staff(actor, ms)
    hyrak = catalogue.builtin_entries(staff=staff)
    for rec in await store.list_published():
        if rec.workspace_id == ws.id or not _in_catalogue(rec):
            continue
        hyrak.append(catalogue_card(rec))
    own = [await _card(rec) for rec in await store.list_models(ws.id)]
    return {"workspace_id": ws.id, "hyrak": hyrak, "workspace": own,
            "premium": entitlement(actor, ms, ws),
            "can_manage": _can(actor, ms, ws, perms.MODELS_MANAGE),
            "can_run": _can(actor, ms, ws, perms.MODELS_RUN),
            "can_publish": perms.is_founder(ms),
            "limits": {"max_mb": int(get_settings().custom_models_max_mb),
                       "max_models": int(get_settings().custom_models_max_per_workspace)}}


async def get_model(actor, model_id: str) -> dict:
    rec, ms, ws = await _readable(actor, model_id)
    if ws is None:
        return catalogue_card(rec)
    return await _card(rec, full=True)


async def preview_file(actor, model_id: str, version: Optional[int] = None) -> Path:
    rec, ms, ws = await _readable(actor, model_id)
    if ws is None:
        # Catalogue readers: the preview copied when the founder published.
        path = storage.catalogue_dir(rec.id, rec.published_version) / storage.PREVIEW_FILE
        if version not in (None, rec.published_version) or not path.is_file():
            raise _refuse(404, "not_found", "no preview")
        return path
    n = version or rec.current_version
    if n is None:
        versions = await model_store.read_store().list_versions(rec.id)
        n = versions[-1].n if versions else None
    v = await model_store.read_store().get_version(rec.id, n) if n else None
    if v is None or not v.preview_path:
        raise _refuse(404, "not_found", "no preview")
    path = storage.version_dir(rec.workspace_id, rec.id, v.n) / storage.PREVIEW_FILE
    if not path.is_file():
        raise _refuse(404, "not_found", "no preview")
    return path


# ── Adding ────────────────────────────────────────────────────────────────

def _clean_name(name: str, fallback: str) -> str:
    n = " ".join(str(name or "").split())[:120]
    return n or fallback[:120]


async def _may_add(actor, workspace_id: Optional[str], model_id: Optional[str]):
    """(memberships, workspace, existing record or None) for a new model or
    a new version of `model_id`."""
    if model_id:
        rec, ms, tree, ws = await _manageable(actor, model_id)
    else:
        ms, tree, ws = await _workspace(actor, workspace_id)
        rec = None
        if not _can(actor, ms, ws, perms.MODELS_MANAGE):
            raise _refuse(403, "forbidden")
    if not entitlement(actor, ms, ws)["enabled"]:
        raise _refuse(403, "not_entitled")
    if rec is None:
        limit = int(get_settings().custom_models_max_per_workspace)
        if await model_store.read_store().count_models(ws.id) >= limit:
            raise _refuse(409, "quota", limit=limit)
    return ms, ws, rec


async def _new_record(actor, ws, *, name: str, source: str, description: str = "",
                      **hf_fields) -> ModelRecord:
    rec = ModelRecord(id=str(uuid.uuid4()), workspace_id=ws.id, name=name, source=source,
                      description=description[:500], created_by=actor.id,
                      settings={"threshold": DEFAULT_THRESHOLD}, **hf_fields)
    return await model_store.write_store().create_model(rec)


async def create_upload(actor, *, workspace_id: Optional[str], filename: str, read_chunk,
                        name: str = "", description: str = "", model_id: Optional[str] = None,
                        ip: str = "") -> dict:
    """`read_chunk` is an async callable returning the next bytes (b"" at the
    end): the multipart file as it arrives."""
    ms, ws, existing = await _may_add(actor, workspace_id, model_id)
    check_filename(filename)
    store = model_store.write_store()
    mid = existing.id if existing else str(uuid.uuid4())
    # 1. Receive into a staging folder of our own.
    stage = storage.staging_dir(ws.id, mid)
    w = storage.AtomicWriter(stage / storage.MODEL_FILE, limit=storage.limit_bytes())
    try:
        while True:
            chunk = await read_chunk()
            if not chunk:
                break
            await asyncio.to_thread(w.write, chunk)
        if w.size == 0:
            raise _refuse(400, "empty_file")
        sha, size = await asyncio.to_thread(w.commit)
    except Exception as e:
        w.abort()
        _discard(stage, ws.id, mid, existing is None)
        if isinstance(e, storage.TooLarge):
            raise _refuse(413, "too_large", f"{filename}",
                          limit_mb=get_settings().custom_models_max_mb)
        if isinstance(e, ModelFailure):
            raise
        logger.error(f"model upload not stored: {e!r}")
        raise _refuse(500, "storage_failed", str(e)[:300])
    # 2. Reserve the version row, 3. move the folder into place: v<n> is
    # never written into twice, whoever else uploads at the same time.
    created = None
    try:
        if existing is None:
            created = await store.create_model(ModelRecord(
                id=mid, workspace_id=ws.id,
                name=_clean_name(name, Path(filename).stem or "My model"),
                source="upload", description=str(description or "")[:500],
                created_by=actor.id, settings={"threshold": DEFAULT_THRESHOLD}))
        n = await _reserve_version(store, mid, sha256=sha, size_bytes=size,
                                   file_name=Path(filename).name[:300])
        try:
            storage.place_dir(stage, storage.version_dir(ws.id, mid, n))
        except Exception:
            await store.delete_version(mid, n)
            raise
    except Exception as e:
        _discard(stage, ws.id, mid, False)
        if created is not None:
            await store.delete_model(mid)
            _discard(None, ws.id, mid, True)
        logger.error(f"model upload not placed: {e!r}")
        raise _refuse(500, "storage_failed", str(e)[:300])
    rec = created or await store.update_model(mid, status="checking", error="", error_hint="")
    await _audit(actor, "model.version" if existing else "model.create", rec, ip,
                 source="upload", version=n, sha256=sha, size_bytes=size)
    _steps[mid] = "received"
    await notify.model_status(rec, step="received", version=n)
    _start_check(mid, n)
    return await _card(rec)


async def _reserve_version(store, model_id: str, **fields) -> int:
    for _ in range(20):
        n = await store.next_version_n(model_id)
        try:
            await store.add_version(VersionRecord(id=str(uuid.uuid4()), model_id=model_id, n=n,
                                                  **fields))
            return n
        except model_store.VersionTaken:
            await asyncio.sleep(0)
    raise _refuse(409, "storage_failed", "could not reserve a version number")


def _discard(stage: Optional[Path], workspace_id: str, model_id: str, whole_model: bool) -> None:
    try:
        if stage is not None:
            storage.remove_tree(stage)
        if whole_model:
            storage.remove_tree(storage.model_dir(workspace_id, model_id))
    except Exception:
        pass


async def hf_inspect(actor, repo_text: str, workspace_id: Optional[str] = None) -> dict:
    """Repo summary for the add-model panel: commit, .onnx files, labels."""
    if workspace_id:
        await _may_add(actor, workspace_id, None)
    else:
        ms = await _memberships(actor)
        tree = await _tree()
        if not _is_staff(actor, ms) and not any(
                perms.can(ms, ws, perms.MODELS_MANAGE) and ws.has_feature(FEATURE) and not ws.disabled
                for ws in tree.all()):
            raise _refuse(403, "not_entitled")
    repo = hf.parse_repo(repo_text)
    info = await hf.resolve(repo)
    files = info.onnx_files()
    limit = storage.limit_bytes()
    try:
        chosen = hf.pick_onnx(info, None).path
    except ModelFailure:
        chosen = None
    labels = await hf.read_labels(info, chosen) if files else []
    return {
        "repo": repo, "sha": info.sha, "url": f"https://huggingface.co/{repo}",
        "pipeline_tag": info.pipeline_tag or None, "library": info.library or None,
        "task": {"object-detection": "detect",
                 "image-classification": "classify"}.get(info.pipeline_tag),
        "license": info.license or None,
        "onnx_files": [{"path": f.path, "size_bytes": f.size,
                        "too_large": bool(f.size and f.size > limit)} for f in files],
        "suggested_file": chosen,
        "labels": labels,
        "ok": bool(files),
        **({} if files else ModelFailure("hf_no_onnx").public()),
    }


async def create_hf(actor, *, workspace_id: Optional[str], repo_text: str,
                    file: Optional[str] = None, name: str = "", model_id: Optional[str] = None,
                    ip: str = "") -> dict:
    ms, ws, existing = await _may_add(actor, workspace_id, model_id)
    repo = hf.parse_repo(repo_text)
    info = await hf.resolve(repo)
    f = hf.pick_onnx(info, file)
    limit = storage.limit_bytes()
    extra = hf.companions(info, f.path)
    total = (f.size or 0) + sum((info.has(p).size or 0) for p, _ in extra)
    if total > limit:
        raise _refuse(413, "too_large", f"{f.path}: {total} bytes",
                      limit_mb=get_settings().custom_models_max_mb)
    store = model_store.write_store()
    hf_fields = dict(hf_repo=repo, hf_revision=info.sha, hf_file=f.path)
    if existing is None:
        default = repo.split("/", 1)[1]
        rec = await _new_record(actor, ws, name=_clean_name(name, default), source="huggingface",
                                **hf_fields)
    else:
        rec = await store.update_model(existing.id, status="checking", error="", error_hint="",
                                       source="huggingface", **hf_fields)
    n = await _reserve_version(store, rec.id, file_name=f.path[:300], hf_revision=info.sha)
    await _audit(actor, "model.version" if existing else "model.create", rec, ip,
                 source="huggingface", repo=repo, revision=info.sha, file=f.path, version=n)
    fetch = {"repo": repo, "sha": info.sha, "file": f.path, "extra": extra}
    _steps[rec.id] = "downloading"         # the check pushes it
    _start_check(rec.id, n, fetch=fetch)
    return await _card(rec)


# ── Browsing (recommended list and Hugging Face search) ─────────────────
# Open to everyone who can view the workspace, premium or not, so people
# see what they would get; adding still goes through _may_add.

async def _browse_context(actor, workspace_id: Optional[str]):
    ms, tree, ws = await _workspace(actor, workspace_id)
    # (repo, file) and (repo, None) -> (model id, status), so a card can
    # offer Run for a model that is ready.
    added: dict = {}
    for rec in await model_store.read_store().list_models(ws.id):
        if rec.source == "huggingface" and rec.hf_repo:
            added.setdefault((rec.hf_repo, rec.hf_file), (rec.id, rec.status))
            added.setdefault((rec.hf_repo, None), (rec.id, rec.status))
    head = {"workspace_id": ws.id, "premium": entitlement(actor, ms, ws),
            "can_manage": _can(actor, ms, ws, perms.MODELS_MANAGE)}
    return head, added


async def hf_recommended(actor, workspace_id: Optional[str]) -> dict:
    head, added = await _browse_context(actor, workspace_id)
    return {**head, "categories": browse.grouped(browse.recommended(), added)}


async def hf_search(actor, workspace_id: Optional[str], q: str, task: str, page: int,
                    ready: bool = False) -> dict:
    head, added = await _browse_context(actor, workspace_id)
    answer = await browse.search(actor.id, q, task, page, ready=ready)
    results = []
    for c in answer["results"]:
        mid, status = added.get((c["repo"], None)) or (None, None)
        results.append({**c, "added": mid, "added_status": status})
    return {**head, **answer, "results": results}


# ── The check ─────────────────────────────────────────────────────────────

def _start_check(model_id: str, n: int, *, fetch: Optional[dict] = None) -> asyncio.Task:
    task = asyncio.create_task(check_version(model_id, n, fetch=fetch))
    _tasks.setdefault(model_id, set()).add(task)

    def done(t, model_id=model_id):
        s = _tasks.get(model_id)
        if s is not None:
            s.discard(t)
            if not s:
                _tasks.pop(model_id, None)
    task.add_done_callback(done)
    return task


async def wait_for_checks(model_id: Optional[str] = None) -> None:
    """Tests and shutdown: wait until the running checks are done."""
    while True:
        pending = [t for mid, ts in list(_tasks.items()) for t in ts
                   if model_id is None or mid == model_id]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


async def _step(model_id: str, n: int, step: str) -> None:
    _steps[model_id] = step
    rec = await model_store.read_store().get_model(model_id)
    if rec is not None:
        await notify.model_status(rec, step=step, version=n)


def _read_labels_file(vdir: Path) -> list:
    for name in hf.LABEL_FILES:
        p = vdir / name
        if p.is_file() and p.stat().st_size <= hf.SMALL_LIMIT:
            try:
                return [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()
                        if ln.strip()][:5000]
            except Exception:
                return []
    return []


async def check_version(model_id: str, n: int, *, fetch: Optional[dict] = None) -> None:
    """Download (Hugging Face), inspect, test; mark the version ready or
    failed. Never raises: every failure ends up on the model's card."""
    store = model_store.write_store()
    rec = await store.get_model(model_id)
    if rec is None:
        return
    vdir = storage.version_dir(rec.workspace_id, model_id, n)
    model_path = vdir / storage.MODEL_FILE
    st = rec.settings or {}
    try:
        if fetch:
            await _step(model_id, n, "downloading")
            limit = storage.limit_bytes()
            stage = storage.staging_dir(rec.workspace_id, model_id)
            try:
                sha, size = await hf.download(fetch["repo"], fetch["sha"], fetch["file"],
                                              stage / storage.MODEL_FILE, limit=limit)
                for repo_path, local in fetch.get("extra") or []:
                    await hf.download(fetch["repo"], fetch["sha"], repo_path,
                                      storage.safe_child(stage, local), limit=limit)
                if vdir.exists():
                    storage.fill_missing(stage, vdir)      # a retest re-fetching lost files
                else:
                    storage.place_dir(stage, vdir)
            finally:
                storage.remove_tree(stage) if stage.exists() else None
            await store.update_version(model_id, n, sha256=sha, size_bytes=size)
        if not model_path.is_file():
            raise ModelFailure("storage_failed", "the model file is missing")
        await _step(model_id, n, "inspecting")
        info = await checks.inspect(model_path, config=vdir / "config.json",
                                    preprocessor=vdir / "preprocessor_config.json",
                                    labels=st.get("labels") or _read_labels_file(vdir),
                                    task=st.get("task") or "")
        await store.update_version(model_id, n, task=info["task"],
                                   input_shape=info["input"]["shape"],
                                   labels=info["labels"], details=info)
        await _step(model_id, n, "testing")
        incoming = vdir / ".preview-incoming.jpg"
        result = await checks.test(model_path, info, preview=incoming,
                                   threshold=float(st.get("threshold", DEFAULT_THRESHOLD)))
        preview = None
        if incoming.is_file():
            os.replace(incoming, vdir / storage.PREVIEW_FILE)
            preview = str(vdir / storage.PREVIEW_FILE)
        files = await asyncio.to_thread(storage.hash_files, vdir)
        v = await store.get_version(model_id, n)
        if v is not None and v.sha256 and files.get(storage.MODEL_FILE) != v.sha256:
            raise ModelFailure("file_changed", "model.onnx differs from the received file")
        await store.update_version(model_id, n, status="ready", error="", error_hint="",
                                   latency_ms=result.get("latency_ms"),
                                   gpu_mem_mb=result.get("gpu_mem_mb"), preview_path=preview,
                                   details={**info, "test": result, "files": files})
        rec = await store.get_model(model_id)
        if rec is None:
            return
        fields = {}
        if rec.current_version is None or n >= rec.current_version:
            fields["current_version"] = n
            fields["task"] = info["task"]
        if n >= await _latest_n(model_id):
            fields.update(status="ready", error="", error_hint="")
        rec = await store.update_model(model_id, **fields) if fields else rec
        _steps.pop(model_id, None)
        await notify.model_status(rec, step="done", version=n)
        logger.info(f"Model {rec.name} ({model_id[:8]}) v{n} ready: {info['task']}, "
                    f"{result.get('latency_ms')} ms on {result.get('provider')}")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        f = e if isinstance(e, ModelFailure) else ModelFailure("load_failed", f"{type(e).__name__}: {e}")
        if not isinstance(e, ModelFailure):
            logger.exception(f"Model {model_id[:8]} v{n}: check failed unexpectedly")
        await _fail(model_id, n, f)


async def _latest_n(model_id: str) -> int:
    versions = await model_store.read_store().list_versions(model_id)
    return versions[-1].n if versions else 0


async def _fail(model_id: str, n: int, f: ModelFailure) -> None:
    store = model_store.write_store()
    msg, hint = describe(f.code, f.extra)
    v = await store.get_version(model_id, n)
    details = dict((v.details if v else None) or {})
    details["failure"] = {"code": f.code, "detail": f.detail[:2000]}
    await store.update_version(model_id, n, status="failed", error=msg[:500],
                               error_hint=hint[:500], details=details)
    rec = await store.get_model(model_id)
    if rec is None:
        return
    fields: dict = {}
    if rec.current_version == n:
        # The version that ran no longer passes (a retest): fall back to
        # the newest older one that is still ready.
        older = [x.n for x in await store.list_versions(model_id)
                 if x.status == "ready" and x.n < n]
        fields["current_version"] = max(older) if older else None
    if n >= await _latest_n(model_id):
        fields.update(status="failed", error=msg[:500], error_hint=hint[:500])
    if fields:
        rec = await store.update_model(model_id, **fields)
    _steps.pop(model_id, None)
    logger.info(f"Model {model_id[:8]} v{n} failed: {f.code} {f.detail[:200]}")
    await notify.model_status(rec, step="done", version=n, error=msg, hint=hint, detail=f.detail)


async def recover() -> int:
    """At startup: checks a restart interrupted are run again (uploads) or
    marked failed (nothing on disk). Returns how many were restarted."""
    store = model_store.read_store()
    n_started = 0
    for rec in await store.list_checking():
        versions = await store.list_versions(rec.id)
        for v in versions:
            if v.status != "checking":
                continue
            path = storage.version_dir(rec.workspace_id, rec.id, v.n) / storage.MODEL_FILE
            if path.is_file() and (v.sha256 or rec.source == "upload"):
                _start_check(rec.id, v.n)
                n_started += 1
            elif rec.source == "huggingface" and rec.hf_repo and rec.hf_revision:
                _start_check(rec.id, v.n, fetch={"repo": rec.hf_repo,
                                                 "sha": v.hf_revision or rec.hf_revision,
                                                 "file": v.file_name, "extra": []})
                n_started += 1
            else:
                await _fail(rec.id, v.n, ModelFailure("storage_failed", "interrupted by a restart"))
    return n_started


# ── Changing ──────────────────────────────────────────────────────────────

def _valid_alert(alert) -> Optional[dict]:
    if alert is None:
        return None
    if not isinstance(alert, dict) or not str(alert.get("label") or "").strip():
        raise _refuse(400, "bad_request", reason="alert needs a label")
    try:
        min_score = float(alert.get("min_score", 0.5))
        cooldown = float(alert.get("cooldown_s", 30.0))
    except (TypeError, ValueError):
        raise _refuse(400, "bad_request", reason="alert min_score and cooldown_s are numbers")
    if not (0.0 < min_score <= 1.0) or not (1.0 <= cooldown <= 3600.0):
        raise _refuse(400, "bad_request",
                      reason="alert min_score is between 0 and 1, cooldown_s 1 to 3600")
    return {"label": str(alert["label"]).strip()[:64], "min_score": min_score,
            "cooldown_s": cooldown}


async def patch_model(actor, model_id: str, body: dict, *, ip: str = "") -> dict:
    rec, ms, tree, ws = await _manageable(actor, model_id)
    store = model_store.write_store()
    fields: dict = {}
    settings = dict(rec.settings or {})
    recheck = False
    if "name" in body and body["name"] is not None:
        fields["name"] = _clean_name(body["name"], rec.name)
    if "description" in body and body["description"] is not None:
        fields["description"] = str(body["description"])[:500]
    if "threshold" in body and body["threshold"] is not None:
        try:
            t = float(body["threshold"])
        except (TypeError, ValueError):
            raise _refuse(400, "bad_request", reason="threshold is a number")
        if not 0.01 <= t <= 0.99:
            raise _refuse(400, "bad_request", reason="threshold is between 0.01 and 0.99")
        settings["threshold"] = t
    if "alert" in body:
        settings["alert"] = _valid_alert(body["alert"])
    if "task" in body and body["task"] is not None:
        if body["task"] not in TASKS:
            raise _refuse(400, "bad_request", reason="task is detect or classify")
        # Compared with what the last check was told (a failed override
        # leaves the model's own task as it was).
        if body["task"] != (settings.get("task") or rec.task):
            settings["task"] = body["task"]
            recheck = True
    if "labels" in body and body["labels"] is not None:
        labels = body["labels"]
        if not isinstance(labels, list) or len(labels) > 5000 or not all(
                isinstance(x, str) and 0 < len(x.strip()) <= 64 for x in labels):
            raise _refuse(400, "bad_request",
                          reason="labels is a list of names, each 1 to 64 characters")
        labels = [x.strip() for x in labels]
        settings["labels"] = labels
        n = rec.current_version or await _latest_n(model_id)
        if n:
            v = await store.get_version(model_id, n)
            if v is not None:
                details = dict(v.details or {})
                if details:
                    details["labels"] = labels
                    details["label_source"] = "user"
                await store.update_version(model_id, n, labels=labels, details=details)
    if settings != (rec.settings or {}):
        fields["settings"] = settings
    if fields:
        rec = await store.update_model(model_id, **fields)
        await _audit(actor, "model.update", rec, ip, fields=sorted(body))
    if recheck:
        n = await _latest_n(model_id)
        if n:
            rec = await store.update_model(model_id, status="checking", error="", error_hint="")
            await store.update_version(model_id, n, status="checking", error="", error_hint="")
            _steps[model_id] = "inspecting"
            await notify.model_status(rec, step="inspecting", version=n)
            _start_check(model_id, n)
    return await _card(rec, full=True)


async def retest(actor, model_id: str, *, ip: str = "") -> dict:
    rec, ms, tree, ws = await _manageable(actor, model_id)
    store = model_store.write_store()
    n = await _latest_n(model_id)
    if not n:
        raise _refuse(**NOT_FOUND)
    if model_id in _tasks:
        return await _card(rec, full=True)        # already being checked
    v = await store.get_version(model_id, n)
    fetch = None
    path = storage.version_dir(rec.workspace_id, model_id, n) / storage.MODEL_FILE
    if not path.is_file() and rec.hf_repo and v is not None:
        fetch = {"repo": rec.hf_repo, "sha": v.hf_revision or rec.hf_revision,
                 "file": v.file_name, "extra": []}
    rec = await store.update_model(model_id, status="checking", error="", error_hint="")
    await store.update_version(model_id, n, status="checking", error="", error_hint="")
    await _audit(actor, "model.retest", rec, ip, version=n)
    _steps[model_id] = "downloading" if fetch else "inspecting"
    await notify.model_status(rec, step=_steps[model_id], version=n)
    _start_check(model_id, n, fetch=fetch)
    return await _card(rec, full=True)


async def publish(actor, model_id: str, published: bool, *, version: Optional[int] = None,
                  ip: str = "") -> dict:
    """Founders: pin `version` (default: the current one) in the catalogue,
    or take the model out. Publishing again moves the pin and refreshes the
    snapshot; catalogue sessions on the old pin are put back on manual."""
    rec, ms, tree, ws = await _manageable(actor, model_id)
    if not perms.is_founder(ms):
        raise _refuse(403, "founders_only")
    store = model_store.write_store()
    old_pin = rec.published_version if rec.published else None
    if not published:
        rec = await store.update_model(model_id, published=False, published_version=None,
                                       catalogue=None)
        await _audit(actor, "model.unpublish", rec, ip, version=old_pin)
    else:
        n = version or rec.current_version
        v = await store.get_version(model_id, n) if n else None
        path = storage.version_dir(rec.workspace_id, model_id, n) / storage.MODEL_FILE if n else None
        if v is None or v.status != "ready" or not v.details or not path.is_file():
            raise _refuse(409, "not_ready")
        test = (v.details or {}).get("test") or {}
        st = rec.settings or {}
        src = storage.version_dir(rec.workspace_id, model_id, n)
        # The catalogue's own copy, checked against the hash taken on receipt.
        files = await asyncio.to_thread(storage.copy_to_catalogue, src, model_id, n)
        if not v.sha256 or files.get(storage.MODEL_FILE) != v.sha256:
            storage.remove_tree(storage.catalogue_dir(model_id, n))
            raise _refuse(409, "file_changed")
        preview = (storage.catalogue_dir(model_id, n) / storage.PREVIEW_FILE).is_file()
        snap = {"files": files, "version": n, "name": rec.name, "description": rec.description,
                "task": v.task or rec.task, "labels": list(v.labels or []),
                "threshold": float(st.get("threshold", DEFAULT_THRESHOLD)),
                "spec": v.details, "sha256": v.sha256, "latency_ms": v.latency_ms,
                "gpu_mem_mb": v.gpu_mem_mb, "provider": test.get("provider"),
                "input_shape": v.input_shape, "preview": preview,
                "published_by": actor.id, "published_at": model_store.public_dt(model_store.utcnow())}
        rec = await store.update_model(model_id, published=True, published_version=n,
                                       catalogue=snap)
        await _audit(actor, "model.publish", rec, ip, version=n, previous=old_pin)
    if old_pin is not None:
        # Every session on the catalogue path (the owning workspace's too)
        # goes back to manual; a re-selection runs the new pin.
        await notify.stop_sessions_running(model_id, describe("model_removed")[0],
                                           via_catalogue=True)
        if not published or old_pin != rec.published_version:
            storage.remove_tree(storage.catalogue_dir(model_id, old_pin))
    return await _card(rec, full=True)


async def delete_model(actor, model_id: str, *, ip: str = "") -> None:
    rec, ms, tree, ws = await _manageable(actor, model_id)
    if rec.published and not perms.is_founder(ms):
        raise _refuse(409, "published_locked")
    for t in list(_tasks.get(model_id, ())):
        t.cancel()
    await notify.stop_sessions_running(model_id, describe("model_removed")[0])
    await asyncio.to_thread(runtime.pool().stop_model, model_id)
    await model_store.write_store().delete_model(model_id)
    _steps.pop(model_id, None)
    try:
        storage.remove_tree(storage.model_dir(rec.workspace_id, model_id))
        storage.remove_tree(storage.catalogue_model_dir(model_id))
    except Exception as e:
        logger.warning(f"model files of {model_id[:8]} not removed: {e}")
    await _audit(actor, "model.delete", rec, ip)


async def published_count(workspace_id: str) -> int:
    """Published models a workspace owns: a blocker for deleting it unless
    a founder does (workspaces.service.delete_workspace)."""
    try:
        return sum(1 for r in await model_store.read_store().list_models(workspace_id)
                   if r.published)
    except Exception:
        return 0


async def feature_revoked(workspace_id: str) -> int:
    """A founder switched custom_models off: the workspace's customer
    sessions running its OWN models go back to manual (catalogue models
    and staff sessions keep running)."""
    return await notify.stop_sessions_running(
        None, describe("not_entitled")[0], via_catalogue=False, workspace_id=workspace_id,
        skip_staff=True)


async def workspace_deleted(workspace_id: str) -> None:
    """The workspace is gone: its rows cascaded, now its runners and files.
    A founder may delete a workspace that owns published models: they
    leave the catalogue with it (their rows cascade), every session running
    them goes back to manual, and the catalogue copies are removed."""
    try:
        store = model_store.read_store()
        recs = await store.list_models(workspace_id)
        for rec in recs:
            await notify.stop_sessions_running(rec.id, describe("model_removed")[0])
            await asyncio.to_thread(runtime.pool().stop_model, rec.id)
            storage.remove_tree(storage.catalogue_model_dir(rec.id))
        await store.delete_workspace(workspace_id)
    except Exception as e:
        logger.warning(f"models of deleted workspace {workspace_id[:8]}: {e}")
    storage.remove_workspace(workspace_id)


# ── Running ───────────────────────────────────────────────────────────────

async def resolve_run(session, model_id: str):
    """The CustomModelMode for `set_analysis_mode {mode: "custom:<id>"}`, or
    a ModelFailure saying why this session may not run it."""
    from app.models_custom.analyzer import CustomModelMode
    legacy = session.user_id == auth.LEGACY_USER_ID
    if not legacy and perms.MODELS_RUN not in (session.perms or frozenset()):
        raise _refuse(403, "forbidden", "models.run")
    try:
        rec = await model_store.read_store().get_model(str(model_id))
    except Exception as e:
        raise _refuse(503, "storage_failed", str(e)[:200])
    ws_id = session.workspace_id or PLATFORM_WORKSPACE_ID
    if rec is None or (rec.workspace_id != ws_id and not _in_catalogue(rec)):
        raise _refuse(**NOT_FOUND)
    own = rec.workspace_id == ws_id
    if own and not session.is_staff and not legacy:
        tree = await _tree()
        ws = tree.get(ws_id)
        if ws is None or ws.disabled or not ws.has_feature(FEATURE):
            if not _in_catalogue(rec):
                raise _refuse(403, "not_entitled")
            own = False                  # without the feature: the catalogue's pin
    if not own:
        return _catalogue_mode(rec, ws_id)
    if rec.current_version is None:
        raise _refuse(409, "not_ready")
    v = await model_store.read_store().get_version(rec.id, rec.current_version)
    path = storage.version_dir(rec.workspace_id, rec.id, rec.current_version) / storage.MODEL_FILE
    if v is None or v.status != "ready" or not v.details or not path.is_file():
        raise _refuse(409, "not_ready")
    st = rec.settings or {}
    files = dict((v.details or {}).get("files") or {})
    if v.sha256:
        files[storage.MODEL_FILE] = v.sha256          # the hash taken on receipt wins
    spec = runtime.RunSpec(workspace_id=ws_id, model_id=rec.id, version=v.n,
                           model_path=str(path), spec=v.details, name=rec.name,
                           threshold=float(st.get("threshold", DEFAULT_THRESHOLD)),
                           alert=st.get("alert"), labels=list(v.labels or []), files=files)
    return CustomModelMode(spec)


def _catalogue_mode(rec: ModelRecord, ws_id: str):
    """The pinned catalogue version, run from the catalogue's own copy of
    its files (hash-checked before every start) with the snapshot's spec,
    labels and threshold, never the owning workspace's later edits or
    files. No alert rule: alerts are the owning workspace's."""
    from app.models_custom.analyzer import CustomModelMode
    snap = rec.catalogue or {}
    n = rec.published_version
    if not n or not snap.get("spec") or not snap.get("files"):
        raise _refuse(409, "not_ready")
    path = storage.catalogue_dir(rec.id, n) / storage.MODEL_FILE
    if not path.is_file():
        raise _refuse(409, "not_ready")
    spec = runtime.RunSpec(workspace_id=ws_id, model_id=rec.id, version=n,
                           model_path=str(path), spec=snap["spec"],
                           name=snap.get("name") or rec.name,
                           threshold=float(snap.get("threshold", DEFAULT_THRESHOLD)),
                           alert=None, labels=list(snap.get("labels") or []),
                           files=dict(snap["files"]), via_catalogue=True)
    return CustomModelMode(spec)


async def shutdown() -> None:
    for ts in list(_tasks.values()):
        for t in list(ts):
            t.cancel()
    await asyncio.to_thread(runtime.pool().stop_all)

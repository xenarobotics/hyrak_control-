"""
Hugging Face: public model repos only, pinned to a commit.

  * `owner/repo` or a huggingface.co link is accepted; datasets and spaces
    are not models.
  * The repo is resolved to its commit sha once; every file is then fetched
    at that sha, so a later push to the repo never changes a stored model.
  * Only what a model needs is fetched: the chosen .onnx, its external
    weights file when the repo has one beside it, and config.json /
    preprocessor_config.json / a labels.txt (small files only).
  * No token is ever sent (a private or gated repo is refused with a
    message), every request has a timeout, and the download stops as soon
    as it passes the size limit.

The two network calls (`_model_info`, `_stream`) are module functions so
tests replace them.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Optional
from urllib.parse import quote

from app.config import get_settings
from app.models_custom import storage
from app.models_custom.errors import ModelFailure

_REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
_HOSTS = ("huggingface.co/", "hf.co/")
CONFIG_FILES = ("config.json", "preprocessor_config.json")
LABEL_FILES = ("labels.txt", "classes.txt")
SMALL_LIMIT = 2 * 1024 * 1024


def parse_repo(text: str) -> str:
    """`owner/repo` from what a person pasted, or hf_bad_repo."""
    s = (text or "").strip()
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
    if s.startswith("www."):
        s = s[4:]
    for host in _HOSTS:
        if s.startswith(host):
            s = s[len(host):]
            break
    else:
        if "/" in s and "." in s.split("/", 1)[0]:
            raise ModelFailure("hf_bad_repo", text)          # some other site
    s = s.split("?", 1)[0].split("#", 1)[0].strip("/")
    parts = s.split("/")
    if parts and parts[0] in ("datasets", "spaces", "collections", "docs", "papers"):
        raise ModelFailure("hf_bad_repo", f"{text} is not a model repo")
    repo = "/".join(parts[:2])
    if not _REPO.match(repo) or ".." in repo:
        raise ModelFailure("hf_bad_repo", text)
    return repo


@dataclass
class RepoFile:
    path: str
    size: Optional[int]


@dataclass
class RepoInfo:
    repo: str
    sha: str
    files: list = field(default_factory=list)       # [RepoFile]
    pipeline_tag: str = ""
    library: str = ""
    license: str = ""

    def onnx_files(self) -> list:
        return [f for f in self.files if f.path.lower().endswith(".onnx")]

    def has(self, path: str) -> Optional[RepoFile]:
        return next((f for f in self.files if f.path == path), None)


def _model_info(repo: str, timeout: float):
    """huggingface_hub.HfApi().model_info, anonymous. Replaced in tests."""
    from huggingface_hub import HfApi
    return HfApi(endpoint=get_settings().custom_models_hf_endpoint, token=False).model_info(
        repo, files_metadata=True, timeout=timeout, token=False)


async def resolve(repo: str) -> RepoInfo:
    """Commit sha and file list of a public model repo."""
    s = get_settings()
    timeout = float(s.custom_models_hf_timeout_s)
    try:
        info = await asyncio.wait_for(asyncio.to_thread(_model_info, repo, timeout),
                                      timeout=timeout + 5)
    except ModelFailure:
        raise
    except asyncio.TimeoutError:
        raise ModelFailure("hf_unreachable", f"no answer in {timeout:.0f} s")
    except Exception as e:
        raise _map_hub_error(e)
    if getattr(info, "private", False):
        raise ModelFailure("hf_not_found", f"{repo} is private")
    if getattr(info, "gated", False):
        raise ModelFailure("hf_gated", f"{repo} is gated ({info.gated})")
    sha = getattr(info, "sha", None) or ""
    if not re.match(r"^[0-9a-f]{40}$", sha):
        raise ModelFailure("hf_unreachable", f"no commit sha for {repo}")
    files = [RepoFile(path=sib.rfilename, size=getattr(sib, "size", None))
             for sib in (getattr(info, "siblings", None) or [])]
    card = getattr(info, "card_data", None)
    lic = ""
    try:
        lic = str((card or {}).get("license") or "")
    except Exception:
        lic = ""
    return RepoInfo(repo=repo, sha=sha, files=files,
                    pipeline_tag=str(getattr(info, "pipeline_tag", "") or ""),
                    library=str(getattr(info, "library_name", "") or ""), license=lic)


def _map_hub_error(e: Exception) -> ModelFailure:
    name = type(e).__name__
    text = f"{name}: {e}"[:500]
    if name in ("RepositoryNotFoundError", "RevisionNotFoundError"):
        return ModelFailure("hf_not_found", text)
    if name == "GatedRepoError":
        return ModelFailure("hf_gated", text)
    status = getattr(getattr(e, "response", None), "status_code", None)
    if status in (401, 403, 404):
        return ModelFailure("hf_not_found", text)
    return ModelFailure("hf_unreachable", text)


def pick_onnx(info: RepoInfo, wanted: Optional[str]) -> RepoFile:
    files = info.onnx_files()
    if not files:
        raise ModelFailure("hf_no_onnx", f"{info.repo}@{info.sha[:8]}", status=422)
    if wanted:
        f = info.has(wanted.strip("/"))
        if f is None or not f.path.lower().endswith(".onnx"):
            raise ModelFailure("hf_file_not_found", wanted, status=422)
        return f
    if len(files) == 1:
        return files[0]
    for preferred in ("model.onnx", "onnx/model.onnx"):
        f = info.has(preferred)
        if f is not None:
            return f
    raise ModelFailure("hf_choose_file", ", ".join(f.path for f in files[:20]),
                       {"files": [f.path for f in files]}, status=409)


def companions(info: RepoInfo, onnx_path: str) -> list[tuple[str, str]]:
    """(repo path, local name) of the extra files to fetch with an .onnx:
    its external weights beside it, and the config / label files next to
    it or at the repo root."""
    out: list[tuple[str, str]] = []
    folder = onnx_path.rsplit("/", 1)[0] + "/" if "/" in onnx_path else ""
    base = onnx_path.rsplit("/", 1)[-1]
    for f in info.files:
        p = f.path
        if not p.startswith(folder) or "/" in p[len(folder):]:
            continue
        name = p[len(folder):]
        if name in (base + "_data", base + ".data") or (
                name.startswith(base.rsplit(".", 1)[0]) and name.endswith((".onnx_data", ".onnx.data"))):
            out.append((p, name))
    for name in CONFIG_FILES + LABEL_FILES:
        for p in (folder + name, name):
            f = info.has(p)
            if f is not None and (f.size is None or f.size <= SMALL_LIMIT):
                out.append((p, name))
                break
    return out


def file_url(repo: str, sha: str, path: str) -> str:
    base = get_settings().custom_models_hf_endpoint.rstrip("/")
    return f"{base}/{repo}/resolve/{sha}/{quote(path)}"


async def _stream(url: str, timeout: float) -> AsyncIterator[bytes]:
    """The file's bytes, anonymously. Replaced in tests."""
    import httpx
    t = httpx.Timeout(timeout, connect=15.0)
    async with httpx.AsyncClient(timeout=t, follow_redirects=True,
                                 headers={"User-Agent": "hyrak-models/1"}) as client:
        async with client.stream("GET", url) as r:
            if r.status_code in (401, 403, 404):
                raise ModelFailure("hf_not_found", f"HTTP {r.status_code} for {url}")
            if r.status_code >= 400:
                raise ModelFailure("hf_download_failed", f"HTTP {r.status_code} for {url}")
            async for chunk in r.aiter_bytes(storage.CHUNK):
                yield chunk


async def download(repo: str, sha: str, path: str, dest: Path, *, limit: int,
                   deadline_s: Optional[float] = None) -> tuple[str, int]:
    """Fetch one file into `dest` atomically; (sha256, size). Stops at `limit`
    bytes (too_large) and after `deadline_s` (hf_download_failed)."""
    s = get_settings()
    deadline_s = float(deadline_s or s.custom_models_hf_download_timeout_s)
    w = storage.AtomicWriter(dest, limit=limit)

    async def pull():
        async for chunk in _stream(file_url(repo, sha, path), float(s.custom_models_hf_timeout_s)):
            w.write(chunk)

    try:
        await asyncio.wait_for(pull(), timeout=deadline_s)
        return w.commit()
    except storage.TooLarge:
        w.abort()
        raise ModelFailure("too_large", path, {"limit_mb": s.custom_models_max_mb}, status=413)
    except asyncio.TimeoutError:
        w.abort()
        raise ModelFailure("hf_download_failed", f"{path}: not finished in {deadline_s:.0f} s")
    except ModelFailure:
        w.abort()
        raise
    except Exception as e:
        w.abort()
        raise ModelFailure("hf_download_failed", f"{path}: {type(e).__name__}: {e}"[:500])


async def read_labels(info: RepoInfo, onnx_path: Optional[str] = None) -> list:
    """Class names for the inspect preview, from a small config.json
    (id2label) when the repo has one. Best effort: [] on any problem."""
    import json
    folder = onnx_path.rsplit("/", 1)[0] + "/" if onnx_path and "/" in onnx_path else ""
    for p in (folder + "config.json", "config.json"):
        f = info.has(p)
        if f is None or (f.size is not None and f.size > SMALL_LIMIT):
            continue
        buf = bytearray()
        try:
            async def pull():
                async for chunk in _stream(file_url(info.repo, info.sha, p),
                                           float(get_settings().custom_models_hf_timeout_s)):
                    buf.extend(chunk)
                    if len(buf) > SMALL_LIMIT:
                        raise ValueError("config too large")
            await asyncio.wait_for(pull(), timeout=float(get_settings().custom_models_hf_timeout_s))
            id2label = json.loads(bytes(buf)).get("id2label") or {}
            return [str(id2label[k]) for k in sorted(id2label, key=lambda k: int(k))]
        except Exception:
            return []
    return []

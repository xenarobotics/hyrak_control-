"""
Where custom model files live on disk.

    <hyrak_data_dir>/workspaces/<workspace_id>/models/<model_id>/v<n>/
        model.onnx            the file as received (sha256 recorded)
        *.onnx_data           external weights, Hugging Face only, when the repo has them
        config.json           Hugging Face config (id2label), when the repo has one
        preprocessor_config.json
        preview.jpg           the test run's picture

    <hyrak_data_dir>/catalogue/<model_id>/v<n>/
        the HYRAK catalogue's own copy of a published version (model file,
        companions, preview), made when a founder publishes. No workspace
        writes here; catalogue sessions run from it.

A version folder is never written into twice: files arrive in a unique
staging folder (`.incoming-<random>` beside the versions) and the whole
folder is renamed into place only when v<n> does not exist yet. Every
copy's sha256 is recorded and checked again before a runner starts. Ids
are checked to be plain ids before they become path parts.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path

from app.config import get_settings

MODEL_FILE = "model.onnx"
PREVIEW_FILE = "preview.jpg"
_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
CHUNK = 1024 * 1024


def root() -> Path:
    return Path(get_settings().hyrak_data_dir)


def limit_bytes() -> int:
    return int(get_settings().custom_models_max_mb) * 1024 * 1024


def _safe(part: str) -> str:
    if not _ID.match(str(part or "")):
        raise ValueError(f"not an id: {part!r}")
    return part


def workspace_dir(workspace_id: str) -> Path:
    return root() / "workspaces" / _safe(workspace_id)


def model_dir(workspace_id: str, model_id: str) -> Path:
    return workspace_dir(workspace_id) / "models" / _safe(model_id)


def version_dir(workspace_id: str, model_id: str, n: int) -> Path:
    return model_dir(workspace_id, model_id) / f"v{int(n)}"


def staging_dir(workspace_id: str, model_id: str) -> Path:
    d = model_dir(workspace_id, model_id) / f".incoming-{os.urandom(8).hex()}"
    d.mkdir(parents=True)
    return d


def catalogue_dir(model_id: str, n: int) -> Path:
    return root() / "catalogue" / _safe(model_id) / f"v{int(n)}"


def catalogue_model_dir(model_id: str) -> Path:
    return root() / "catalogue" / _safe(model_id)


class VersionExists(Exception):
    pass


def place_dir(src: Path, dest: Path) -> None:
    """Rename a finished staging folder to `dest`, which must not exist yet
    (never overwrite a version folder)."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        raise VersionExists(str(dest))
    os.rename(src, dest)          # same filesystem: atomic; fails if dest appeared meanwhile


def fill_missing(src: Path, dest: Path) -> None:
    """Move the files of `src` into an existing `dest`, only where `dest` has
    no file of that name yet (a hard link fails rather than overwrite)."""
    for f in Path(src).iterdir():
        if not f.is_file():
            continue
        try:
            os.link(f, Path(dest) / f.name)
        except FileExistsError:
            pass
    shutil.rmtree(src, ignore_errors=True)


# What travels with a model file: everything but the preview and staging leftovers.
def model_files(d: Path) -> list[Path]:
    return sorted(p for p in Path(d).iterdir()
                  if p.is_file() and not p.name.startswith(".") and p.name != PREVIEW_FILE)


def hash_files(d: Path) -> dict:
    return {p.name: sha256_of(p) for p in model_files(d)}


def verify_files(d: Path, expected: dict) -> list[str]:
    """Names whose content differs from `expected` (or is missing)."""
    bad = []
    for name, sha in (expected or {}).items():
        p = Path(d) / name
        if not p.is_file() or sha256_of(p) != sha:
            bad.append(name)
    return bad


def copy_to_catalogue(src: Path, model_id: str, n: int) -> dict:
    """The catalogue's own copy of a version folder; returns the copied
    files' hashes (the preview is copied, not hashed). Replaces an earlier
    copy of the same version, which only the catalogue writes."""
    base = catalogue_model_dir(model_id)
    base.mkdir(parents=True, exist_ok=True)
    tmp = base / f".incoming-{os.urandom(8).hex()}"
    tmp.mkdir()
    try:
        for p in model_files(src):
            shutil.copy2(p, tmp / p.name)
        if (Path(src) / PREVIEW_FILE).is_file():
            shutil.copy2(Path(src) / PREVIEW_FILE, tmp / PREVIEW_FILE)
        files = hash_files(tmp)
        dest = catalogue_dir(model_id, n)
        if dest.exists():
            old = base / f".old-{os.urandom(8).hex()}"
            os.rename(dest, old)
            shutil.rmtree(old, ignore_errors=True)
        os.rename(tmp, dest)
        return files
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def safe_child(base: Path, rel: str) -> Path:
    """`rel` (a repo path such as onnx/model.onnx_data) under `base`, refusing
    anything that would leave it."""
    target = (base / rel).resolve()
    if not str(target).startswith(str(base.resolve()) + os.sep):
        raise ValueError(f"path leaves the model folder: {rel!r}")
    return target


class TooLarge(Exception):
    pass


class AtomicWriter:
    """Write a file under a temporary name, hashing and counting as it goes;
    commit() renames it into place, abort() removes it. A limit (bytes)
    raises TooLarge as soon as it is passed."""

    def __init__(self, dest: Path, limit: int | None = None):
        self.dest = Path(dest)
        self.dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".incoming-", dir=self.dest.parent)
        self._f = os.fdopen(fd, "wb")
        self.tmp = Path(tmp)
        self.limit = limit
        self.size = 0
        self._h = hashlib.sha256()

    def write(self, chunk: bytes) -> None:
        self.size += len(chunk)
        if self.limit is not None and self.size > self.limit:
            raise TooLarge(self.size)
        self._h.update(chunk)
        self._f.write(chunk)

    @property
    def sha256(self) -> str:
        return self._h.hexdigest()

    def commit(self) -> tuple[str, int]:
        self._f.flush()
        os.fsync(self._f.fileno())
        self._f.close()
        os.replace(self.tmp, self.dest)
        return self.sha256, self.size

    def abort(self) -> None:
        try:
            self._f.close()
        except Exception:
            pass
        try:
            self.tmp.unlink()
        except FileNotFoundError:
            pass


def write_bytes_atomic(dest: Path, data: bytes) -> None:
    w = AtomicWriter(dest)
    try:
        w.write(data)
        w.commit()
    except Exception:
        w.abort()
        raise


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def remove_tree(path: Path) -> None:
    """Remove a model or workspace folder, only ever under the data root."""
    path = Path(path)
    base = root().resolve()
    try:
        resolved = path.resolve()
    except FileNotFoundError:
        return
    if not str(resolved).startswith(str(base) + os.sep):
        raise ValueError(f"refusing to remove {path} outside {base}")
    shutil.rmtree(resolved, ignore_errors=True)


def remove_workspace(workspace_id: str) -> None:
    try:
        remove_tree(workspace_dir(workspace_id))
    except ValueError:
        pass

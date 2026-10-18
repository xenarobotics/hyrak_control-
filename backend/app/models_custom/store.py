"""
The model library's rows: Postgres when it is up, a memory double in tests.

Picked like the auth store (app/auth/service.py): reads go to Postgres when
it is connected, else to memory (which in production is empty); writes need
Postgres unless the tests switched memory writes on, so a model is never
"saved" somewhere that a restart forgets.
"""
from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Optional

from app.auth.service import DbOffline


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime]) -> Optional[str]:
    return t.isoformat() if t else None


@dataclass
class ModelRecord:
    id: str
    workspace_id: str
    name: str
    source: str                         # upload | huggingface
    description: str = ""
    task: str = ""                      # detect | classify ("" until checked)
    hf_repo: Optional[str] = None
    hf_revision: Optional[str] = None
    hf_file: Optional[str] = None
    status: str = "checking"            # checking | ready | failed (the newest version)
    error: str = ""
    error_hint: str = ""
    current_version: Optional[int] = None   # the newest READY version: the one that runs
    published: bool = False
    published_version: Optional[int] = None   # the catalogue's pinned version
    catalogue: Optional[dict] = None          # the snapshot other workspaces see and run
    settings: dict = field(default_factory=dict)
    created_by: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)


@dataclass
class VersionRecord:
    id: str
    model_id: str
    n: int
    sha256: str = ""
    size_bytes: int = 0
    file_name: str = ""
    hf_revision: Optional[str] = None
    status: str = "checking"
    error: str = ""
    error_hint: str = ""
    task: str = ""
    input_shape: Optional[list] = None
    labels: list = field(default_factory=list)
    details: dict = field(default_factory=dict)
    latency_ms: Optional[float] = None
    gpu_mem_mb: Optional[float] = None
    preview_path: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)


class VersionTaken(Exception):
    """Another request reserved this version number first."""


_MODEL_FIELDS = {f.name for f in fields(ModelRecord)}
_VERSION_FIELDS = {f.name for f in fields(VersionRecord)}


class MemoryModelStore:
    def __init__(self):
        self.models: dict[str, ModelRecord] = {}
        self.versions: dict[tuple[str, int], VersionRecord] = {}

    async def list_models(self, workspace_id: str) -> list[ModelRecord]:
        return sorted((copy.deepcopy(m) for m in self.models.values()
                       if m.workspace_id == workspace_id), key=lambda m: m.created_at)

    async def list_published(self) -> list[ModelRecord]:
        return sorted((copy.deepcopy(m) for m in self.models.values() if m.published),
                      key=lambda m: m.created_at)

    async def list_checking(self) -> list[ModelRecord]:
        ids = {mid for (mid, _), v in self.versions.items() if v.status == "checking"}
        return [copy.deepcopy(m) for m in self.models.values() if m.id in ids]

    async def count_models(self, workspace_id: str) -> int:
        return sum(1 for m in self.models.values() if m.workspace_id == workspace_id)

    async def get_model(self, model_id: str) -> Optional[ModelRecord]:
        m = self.models.get(model_id)
        return copy.deepcopy(m) if m else None

    async def create_model(self, rec: ModelRecord) -> ModelRecord:
        self.models[rec.id] = copy.deepcopy(rec)
        return copy.deepcopy(rec)

    async def update_model(self, model_id: str, **fields_) -> Optional[ModelRecord]:
        m = self.models.get(model_id)
        if m is None:
            return None
        for k, v in fields_.items():
            if k not in _MODEL_FIELDS:
                raise KeyError(k)
            setattr(m, k, copy.deepcopy(v))
        m.updated_at = utcnow()
        return copy.deepcopy(m)

    async def delete_model(self, model_id: str) -> bool:
        if self.models.pop(model_id, None) is None:
            return False
        for k in [k for k in self.versions if k[0] == model_id]:
            self.versions.pop(k, None)
        return True

    async def delete_workspace(self, workspace_id: str) -> None:
        for mid in [m.id for m in self.models.values() if m.workspace_id == workspace_id]:
            await self.delete_model(mid)

    async def add_version(self, v: VersionRecord) -> VersionRecord:
        if (v.model_id, v.n) in self.versions:
            raise VersionTaken(f"{v.model_id} v{v.n}")
        self.versions[(v.model_id, v.n)] = copy.deepcopy(v)
        return copy.deepcopy(v)

    async def delete_version(self, model_id: str, n: int) -> None:
        self.versions.pop((model_id, n), None)

    async def next_version_n(self, model_id: str) -> int:
        return max((n for (mid, n) in self.versions if mid == model_id), default=0) + 1

    async def update_version(self, model_id: str, n: int, **fields_) -> Optional[VersionRecord]:
        v = self.versions.get((model_id, n))
        if v is None:
            return None
        for k, val in fields_.items():
            if k not in _VERSION_FIELDS:
                raise KeyError(k)
            setattr(v, k, copy.deepcopy(val))
        return copy.deepcopy(v)

    async def get_version(self, model_id: str, n: int) -> Optional[VersionRecord]:
        v = self.versions.get((model_id, n))
        return copy.deepcopy(v) if v else None

    async def list_versions(self, model_id: str) -> list[VersionRecord]:
        return sorted((copy.deepcopy(v) for (mid, _), v in self.versions.items()
                       if mid == model_id), key=lambda v: v.n)


def _model_rec(row) -> ModelRecord:
    return ModelRecord(**{k: getattr(row, k) for k in _MODEL_FIELDS})


def _version_rec(row) -> VersionRecord:
    return VersionRecord(**{k: getattr(row, k) for k in _VERSION_FIELDS})


class DbModelStore:
    def _session(self):
        from app.db.engine import get_session
        return get_session()

    async def list_models(self, workspace_id: str) -> list[ModelRecord]:
        from sqlalchemy import select
        from app.db.models import CustomModel
        async with self._session() as db:
            rows = (await db.execute(select(CustomModel).where(CustomModel.workspace_id == workspace_id)
                                     .order_by(CustomModel.created_at))).scalars().all()
        return [_model_rec(r) for r in rows]

    async def list_published(self) -> list[ModelRecord]:
        from sqlalchemy import select
        from app.db.models import CustomModel
        async with self._session() as db:
            rows = (await db.execute(select(CustomModel).where(CustomModel.published.is_(True))
                                     .order_by(CustomModel.created_at))).scalars().all()
        return [_model_rec(r) for r in rows]

    async def list_checking(self) -> list[ModelRecord]:
        from sqlalchemy import select
        from app.db.models import CustomModel, CustomModelVersion
        async with self._session() as db:
            rows = (await db.execute(
                select(CustomModel).where(CustomModel.id.in_(
                    select(CustomModelVersion.model_id)
                    .where(CustomModelVersion.status == "checking"))))).scalars().all()
        return [_model_rec(r) for r in rows]

    async def count_models(self, workspace_id: str) -> int:
        from sqlalchemy import func, select
        from app.db.models import CustomModel
        async with self._session() as db:
            return int((await db.execute(select(func.count()).select_from(CustomModel)
                                         .where(CustomModel.workspace_id == workspace_id))).scalar_one())

    async def get_model(self, model_id: str) -> Optional[ModelRecord]:
        from app.db.models import CustomModel
        async with self._session() as db:
            row = await db.get(CustomModel, model_id)
        return _model_rec(row) if row else None

    async def create_model(self, rec: ModelRecord) -> ModelRecord:
        from app.db.models import CustomModel
        async with self._session() as db:
            db.add(CustomModel(**asdict(rec)))
            await db.commit()
        return rec

    async def update_model(self, model_id: str, **fields_) -> Optional[ModelRecord]:
        from app.db.models import CustomModel
        for k in fields_:
            if k not in _MODEL_FIELDS:
                raise KeyError(k)
        async with self._session() as db:
            row = await db.get(CustomModel, model_id)
            if row is None:
                return None
            for k, v in fields_.items():
                setattr(row, k, v)
            row.updated_at = utcnow()
            await db.commit()
            return _model_rec(row)

    async def delete_model(self, model_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import CustomModel
        async with self._session() as db:
            res = await db.execute(sa_delete(CustomModel).where(CustomModel.id == model_id))
            await db.commit()
            return bool(res.rowcount)

    async def delete_workspace(self, workspace_id: str) -> None:
        return None                  # the foreign key cascades

    async def add_version(self, v: VersionRecord) -> VersionRecord:
        from sqlalchemy.exc import IntegrityError
        from app.db.models import CustomModelVersion
        async with self._session() as db:
            db.add(CustomModelVersion(**asdict(v)))
            try:
                await db.commit()
            except IntegrityError as e:          # uq_model_versions_model_n
                raise VersionTaken(f"{v.model_id} v{v.n}") from e
        return v

    async def delete_version(self, model_id: str, n: int) -> None:
        from sqlalchemy import delete as sa_delete
        from app.db.models import CustomModelVersion
        async with self._session() as db:
            await db.execute(sa_delete(CustomModelVersion).where(
                CustomModelVersion.model_id == model_id, CustomModelVersion.n == n))
            await db.commit()

    async def next_version_n(self, model_id: str) -> int:
        from sqlalchemy import func, select
        from app.db.models import CustomModelVersion
        async with self._session() as db:
            n = (await db.execute(select(func.max(CustomModelVersion.n))
                                  .where(CustomModelVersion.model_id == model_id))).scalar_one()
        return int(n or 0) + 1

    async def _version_row(self, db, model_id: str, n: int):
        from sqlalchemy import select
        from app.db.models import CustomModelVersion
        return (await db.execute(select(CustomModelVersion).where(
            CustomModelVersion.model_id == model_id, CustomModelVersion.n == n))).scalar_one_or_none()

    async def update_version(self, model_id: str, n: int, **fields_) -> Optional[VersionRecord]:
        for k in fields_:
            if k not in _VERSION_FIELDS:
                raise KeyError(k)
        async with self._session() as db:
            row = await self._version_row(db, model_id, n)
            if row is None:
                return None
            for k, v in fields_.items():
                setattr(row, k, v)
            await db.commit()
            return _version_rec(row)

    async def get_version(self, model_id: str, n: int) -> Optional[VersionRecord]:
        async with self._session() as db:
            row = await self._version_row(db, model_id, n)
        return _version_rec(row) if row else None

    async def list_versions(self, model_id: str) -> list[VersionRecord]:
        from sqlalchemy import select
        from app.db.models import CustomModelVersion
        async with self._session() as db:
            rows = (await db.execute(select(CustomModelVersion)
                                     .where(CustomModelVersion.model_id == model_id)
                                     .order_by(CustomModelVersion.n))).scalars().all()
        return [_version_rec(r) for r in rows]


_memory = MemoryModelStore()
_db = DbModelStore()


def _db_up() -> bool:
    from app.auth import service
    return service._db_up()


def read_store():
    return _db if _db_up() else _memory


def write_store():
    from app.auth import service
    if _db_up():
        return _db
    if service._memory_writes:
        return _memory
    raise DbOffline("database offline")


def reset_for_tests() -> None:
    global _memory
    _memory = MemoryModelStore()


def public_dt(t: Optional[datetime]) -> Optional[str]:
    return _iso(t)

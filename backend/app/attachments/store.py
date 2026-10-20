"""
Attachment rows: Postgres when it is up, a memory double in tests.

Picked like the model library's store (app/models_custom/store.py): reads
go to Postgres when it is connected, else to memory (empty in production);
writes need Postgres unless the tests switched memory writes on, so an
attachment is never "saved" somewhere a restart forgets.

Records are the dicts app/attachments/kinds.clean returns, listed in the
order they were added.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Optional

from app.auth.service import DbOffline


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MemoryAttachmentStore:
    def __init__(self):
        # drone id -> attachment id -> (position, record)
        self.rows: dict[str, dict[str, tuple[int, dict]]] = {}
        self._pos = 0

    async def list_for_drone(self, drone_id: str) -> list[dict]:
        rows = self.rows.get(drone_id, {})
        return [copy.deepcopy(r) for _, r in sorted(rows.values(), key=lambda pr: pr[0])]

    async def get(self, drone_id: str, attachment_id: str) -> Optional[dict]:
        pr = self.rows.get(drone_id, {}).get(attachment_id)
        return copy.deepcopy(pr[1]) if pr else None

    async def id_taken(self, attachment_id: str) -> bool:
        return any(attachment_id in rows for rows in self.rows.values())

    async def create(self, drone_id: str, rec: dict) -> dict:
        self._pos += 1
        self.rows.setdefault(drone_id, {})[rec["id"]] = (self._pos, copy.deepcopy(rec))
        return copy.deepcopy(rec)

    async def update(self, drone_id: str, rec: dict) -> Optional[dict]:
        rows = self.rows.get(drone_id, {})
        if rec["id"] not in rows:
            return None
        rows[rec["id"]] = (rows[rec["id"]][0], copy.deepcopy(rec))
        return copy.deepcopy(rec)

    async def delete(self, drone_id: str, attachment_id: str) -> bool:
        return self.rows.get(drone_id, {}).pop(attachment_id, None) is not None


class DbAttachmentStore:
    def _session(self):
        from app.db.engine import get_session
        return get_session()

    async def list_for_drone(self, drone_id: str) -> list[dict]:
        from sqlalchemy import select
        from app.db.models import DroneAttachment
        async with self._session() as db:
            rows = (await db.execute(
                select(DroneAttachment).where(DroneAttachment.drone_id == drone_id)
                .order_by(DroneAttachment.position, DroneAttachment.created_at))).scalars().all()
        return [{**(r.data or {}), "id": r.id} for r in rows]

    async def get(self, drone_id: str, attachment_id: str) -> Optional[dict]:
        from app.db.models import DroneAttachment
        async with self._session() as db:
            row = await db.get(DroneAttachment, attachment_id)
        if row is None or row.drone_id != drone_id:
            return None
        return {**(row.data or {}), "id": row.id}

    async def id_taken(self, attachment_id: str) -> bool:
        from app.db.models import DroneAttachment
        async with self._session() as db:
            return await db.get(DroneAttachment, attachment_id) is not None

    async def create(self, drone_id: str, rec: dict) -> dict:
        from sqlalchemy import func, select
        from app.db.models import DroneAttachment
        async with self._session() as db:
            top = (await db.execute(select(func.max(DroneAttachment.position))
                                    .where(DroneAttachment.drone_id == drone_id))).scalar_one()
            db.add(DroneAttachment(drone_id=drone_id, id=rec["id"], position=int(top or 0) + 1,
                                   data={k: v for k, v in rec.items() if k != "id"}))
            await db.commit()
        return rec

    async def update(self, drone_id: str, rec: dict) -> Optional[dict]:
        from app.db.models import DroneAttachment
        async with self._session() as db:
            row = await db.get(DroneAttachment, rec["id"])
            if row is None or row.drone_id != drone_id:
                return None
            row.data = {k: v for k, v in rec.items() if k != "id"}
            row.updated_at = _utcnow()
            await db.commit()
        return rec

    async def delete(self, drone_id: str, attachment_id: str) -> bool:
        from sqlalchemy import delete as sa_delete
        from app.db.models import DroneAttachment
        async with self._session() as db:
            res = await db.execute(sa_delete(DroneAttachment).where(
                DroneAttachment.drone_id == drone_id, DroneAttachment.id == attachment_id))
            await db.commit()
            return bool(res.rowcount)


_memory = MemoryAttachmentStore()
_db = DbAttachmentStore()


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
    _memory = MemoryAttachmentStore()

"""
/api/drones/{drone_id}/attachments and /api/attachments/kinds
(docs/ATTACHMENTS.md).

Thin: parse, call app/attachments/service.py, which decides who may do
what. Failures answer `{"detail": {"code", "error"}}`: 400 bad_request
with a plain reason, 403 forbidden, 404 not_found for anything the caller
cannot see, 503 storage_failed when the database is offline.

  GET    /api/attachments/kinds
  GET    /api/drones/{drone_id}/attachments
  POST   /api/drones/{drone_id}/attachments                     body: a record
  PATCH  /api/drones/{drone_id}/attachments/{attachment_id}     body: changed fields
  DELETE /api/drones/{drone_id}/attachments/{attachment_id}
  POST   /api/drones/{drone_id}/attachments/{attachment_id}/test  body: {action_id, value?}
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app.attachments import service
from app.auth.clientip import client_ip
from app.auth.deps import require_signed_in
from app.auth.service import AuthUser, DbOffline

router = APIRouter(prefix="/api", tags=["attachments"])


async def _run(coro):
    try:
        return await coro
    except HTTPException:
        raise
    except service.AttachmentFailure as e:
        raise HTTPException(status_code=e.status, detail=e.public())
    except DbOffline:
        raise HTTPException(status_code=503, detail={"code": "storage_failed",
                                                     "error": "database offline"})


def _sessions(request: Request):
    return getattr(request.app.state, "session_manager", None)


@router.get("/attachments/kinds")
async def attachment_kinds(user: AuthUser = Depends(require_signed_in)):
    return service.kinds_catalogue()


@router.get("/drones/{drone_id}/attachments")
async def list_attachments(drone_id: str, request: Request,
                           user: AuthUser = Depends(require_signed_in)):
    return await _run(service.list_for_drone(user, drone_id, _sessions(request)))


@router.post("/drones/{drone_id}/attachments")
async def add_attachment(drone_id: str, request: Request, body: dict = Body(...),
                         user: AuthUser = Depends(require_signed_in)):
    rec = await _run(service.create(user, drone_id, body, ip=client_ip(request)))
    return {"attachment": rec}


@router.patch("/drones/{drone_id}/attachments/{attachment_id}")
async def edit_attachment(drone_id: str, attachment_id: str, request: Request,
                          body: dict = Body(...), user: AuthUser = Depends(require_signed_in)):
    rec = await _run(service.update(user, drone_id, attachment_id, body, ip=client_ip(request)))
    return {"attachment": rec}


@router.delete("/drones/{drone_id}/attachments/{attachment_id}")
async def remove_attachment(drone_id: str, attachment_id: str, request: Request,
                            user: AuthUser = Depends(require_signed_in)):
    return await _run(service.delete(user, drone_id, attachment_id, ip=client_ip(request)))


@router.post("/drones/{drone_id}/attachments/{attachment_id}/test")
async def test_attachment(drone_id: str, attachment_id: str, request: Request,
                          body: dict = Body(default_factory=dict),
                          user: AuthUser = Depends(require_signed_in)):
    return await _run(service.test(user, drone_id, attachment_id, body,
                                   session_manager=_sessions(request), ip=client_ip(request)))

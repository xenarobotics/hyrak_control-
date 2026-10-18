"""
/api/models: the model library (docs/custom_models/DESIGN.md section 0).

Thin: parse, call app/models_custom/service.py. Every route needs a
signed-in account; what it may do is decided in the service. Failures
answer `{"detail": {"code", "error", "hint", "detail"}}` with the error
table's plain words (app/models_custom/errors.py), 404 for anything the
caller cannot see.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.auth.clientip import client_ip
from app.auth.deps import require_signed_in
from app.auth.service import AuthUser, DbOffline
from app.auth.url_tickets import require_user_or_ticket
from app.models_custom import service, storage
from app.models_custom.errors import ModelFailure

router = APIRouter(prefix="/api/models", tags=["models"])


def _http(e: Exception) -> HTTPException:
    if isinstance(e, ModelFailure):
        return HTTPException(status_code=e.status, detail=e.public())
    if isinstance(e, DbOffline):
        f = ModelFailure("storage_failed", "database offline")
        return HTTPException(status_code=503, detail=f.public())
    return HTTPException(status_code=500,
                         detail=ModelFailure("storage_failed", f"{type(e).__name__}").public())


async def _run(coro):
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as e:
        raise _http(e)


@router.get("")
async def library(workspace_id: Optional[str] = Query(None),
                  user: AuthUser = Depends(require_signed_in)):
    return await _run(service.library(user, workspace_id))


@router.post("")
async def upload(request: Request, file: UploadFile = File(...),
                 workspace_id: Optional[str] = Form(None), name: str = Form(""),
                 description: str = Form(""), model_id: Optional[str] = Form(None),
                 user: AuthUser = Depends(require_signed_in)):
    """multipart: file (.onnx), workspace_id, name?, description?; model_id
    to add a new version of an existing model."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > storage.limit_bytes() + 1024 * 1024:
        raise _http(ModelFailure("too_large", "content-length",
                                 {"limit_mb": storage.limit_bytes() // (1024 * 1024)}, status=413))

    async def read_chunk():
        return await file.read(storage.CHUNK)

    model = await _run(service.create_upload(
        user, workspace_id=workspace_id, filename=file.filename or "", read_chunk=read_chunk,
        name=name, description=description, model_id=model_id, ip=client_ip(request)))
    return {"model": model}


@router.get("/huggingface/inspect")
async def hf_inspect(repo: str = Query(..., max_length=300),
                     workspace_id: Optional[str] = Query(None),
                     user: AuthUser = Depends(require_signed_in)):
    return await _run(service.hf_inspect(user, repo, workspace_id))


class HfBody(BaseModel):
    workspace_id: Optional[str] = None
    repo: str = Field(min_length=1, max_length=300)
    file: Optional[str] = Field(default=None, max_length=300)
    name: str = Field(default="", max_length=120)
    model_id: Optional[str] = None           # a new version of this model


@router.post("/huggingface")
async def hf_add(body: HfBody, request: Request, user: AuthUser = Depends(require_signed_in)):
    model = await _run(service.create_hf(user, workspace_id=body.workspace_id, repo_text=body.repo,
                                         file=body.file, name=body.name, model_id=body.model_id,
                                         ip=client_ip(request)))
    return {"model": model}


@router.get("/{model_id}")
async def get_model(model_id: str, user: AuthUser = Depends(require_signed_in)):
    return {"model": await _run(service.get_model(user, model_id))}


class PatchBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    labels: Optional[list[str]] = None
    task: Optional[str] = None
    threshold: Optional[float] = None
    alert: Optional[dict] = None             # explicit null removes it


@router.patch("/{model_id}")
async def patch_model(model_id: str, body: PatchBody, request: Request,
                      user: AuthUser = Depends(require_signed_in)):
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    return {"model": await _run(service.patch_model(user, model_id, fields,
                                                    ip=client_ip(request)))}


@router.delete("/{model_id}")
async def delete_model(model_id: str, request: Request,
                       user: AuthUser = Depends(require_signed_in)):
    await _run(service.delete_model(user, model_id, ip=client_ip(request)))
    return {"ok": True}


_preview_auth = require_user_or_ticket("member", "/api/models/{model_id}/preview")


@router.get("/{model_id}/preview")
async def preview(model_id: str, version: Optional[int] = Query(None),
                  user: AuthUser = Depends(_preview_auth)):
    """The test run's picture. Bearer (fetch into a blob) or a URL ticket
    (POST /api/auth/url-ticket {path}) for an <img>."""
    path = await _run(service.preview_file(user, model_id, version))
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=60"})


@router.post("/{model_id}/retest")
async def retest(model_id: str, request: Request, user: AuthUser = Depends(require_signed_in)):
    return {"model": await _run(service.retest(user, model_id, ip=client_ip(request)))}


class PublishBody(BaseModel):
    published: bool = True
    version: Optional[int] = None            # the version to pin; default: the current one


@router.post("/{model_id}/publish")
async def publish(model_id: str, request: Request, body: Optional[PublishBody] = None,
                  user: AuthUser = Depends(require_signed_in)):
    body = body or PublishBody()
    return {"model": await _run(service.publish(user, model_id, body.published,
                                                version=body.version, ip=client_ip(request)))}

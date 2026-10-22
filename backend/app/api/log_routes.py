"""GET /api/logs/file/{token}: hands the browser a flight log the server
pulled from the caller's drone (app/telemetry/log_download.py).

The token comes from `log_ready` on the caller's own socket, names exactly
one file the server made, works once, and only for the account that asked
for the download. The route also takes a URL ticket (app/auth/url_tickets)
so a plain link can save the file straight to disk, never into page memory.
The file is streamed from disk and deleted once sent.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.auth.service import AuthUser
from app.auth.url_tickets import require_user_or_ticket
from app.telemetry import log_download

router = APIRouter(prefix="/api/logs", tags=["logs"])

_auth = require_user_or_ticket("member", "/api/logs/file/{token}")


@router.get("/file/{token}")
async def get_log_file(token: str, user: AuthUser = Depends(_auth)):
    ready = log_download.downloads.claim(token, user.id)
    if ready is None:
        # Unknown, used, expired or someone else's: all look the same.
        raise HTTPException(status_code=404, detail="This download link has expired. Download the log again")
    return FileResponse(
        ready.file,
        media_type="application/octet-stream",
        filename=ready.name,
        background=BackgroundTask(log_download.downloads.release, ready),
    )

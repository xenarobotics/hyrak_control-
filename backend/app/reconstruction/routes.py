"""/api/recon/* - the platform's face for the reconstruction sidecar.

The frontend NEVER talks to the sidecar port: everything (control, status,
MJPEG feeds, downloads) proxies through here, so the deployed app works
wherever the backend is reachable and the sidecar stays loopback-only.
Mutating routes carry the same X-Auth-Token gate as the rest of the API.
"""
import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.reconstruction import service

settings = get_settings()

router = APIRouter(prefix="/api/recon")


def _auth(token: str | None) -> None:
    if token != settings.secret_token:
        raise HTTPException(status_code=403, detail="Invalid token")


@router.get("/engine")
async def engine_state() -> dict:
    import asyncio
    # to_thread: engine_state may probe the port (2 s worst case).
    return await asyncio.to_thread(service.engine_state)


@router.post("/options")
async def set_options(
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Scan options for the NEXT Start Analysis: {preset?, imu_fuse?,
    mavlink_url?}. The scan itself starts through the normal analysis flow
    (Start Analysis with the session's configured video source) - there is
    deliberately no source choice here: the camera is wherever the user is,
    never on this server."""
    _auth(x_auth_token)
    try:
        return service.set_options(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/session/stop")
async def stop_session(
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """End the capture session (auto-exports). The engine process stays up.
    Normally the scan ends by stopping the analysis; this is the manual
    escape hatch."""
    _auth(x_auth_token)
    code, out = await service.forward("POST", "/stop")
    if code >= 400:
        raise HTTPException(status_code=code, detail=out.get("detail", "stop failed"))
    return out


@router.post("/session/export")
async def export_now(
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Export the current map without ending the session."""
    _auth(x_auth_token)
    code, out = await service.forward("POST", "/export", timeout=120.0)
    if code >= 400:
        raise HTTPException(status_code=code, detail=out.get("detail", "export failed"))
    return out


@router.post("/engine/shutdown")
async def engine_shutdown(
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Stop the sidecar process entirely (frees its GPU memory)."""
    import asyncio
    _auth(x_auth_token)
    await asyncio.to_thread(service.shutdown_engine)
    return {"ok": True}


@router.post("/scan_session")
async def scan_session(
    body: dict,
    x_auth_token: str = Header(None, alias="X-Auth-Token"),
):
    """Re-process a stored session offline (photogrammetry, best quality).

    Needs the engine running (no camera). If it is down we boot a minimal
    one; if it is busy finishing a previous scan's export, we say so clearly
    rather than hanging - the ONLY thing that started the mesh export is a
    just-stopped live scan, and it clears in a minute.
    """
    import asyncio
    _auth(x_auth_token)
    if not await asyncio.to_thread(service.healthy):
        ok, msg = await asyncio.to_thread(service.ensure_engine_idle)
        if not ok:
            raise HTTPException(status_code=503, detail=msg)
    # Short timeout: the endpoint only STARTS the job and returns; if it does
    # not answer quickly the engine is mid-export, not broken.
    code, out = await service.forward(
        "POST", "/scan_session", params={"name": body.get("session", "")},
        timeout=8.0)
    if code == 502:
        raise HTTPException(
            status_code=409,
            detail="Engine is busy finishing the previous scan - try Refine "
                   "again in a moment")
    if code >= 400:
        raise HTTPException(status_code=code, detail=out.get("detail", "scan failed"))
    return out


@router.get("/stream/{kind}")
async def stream_proxy(kind: str):
    """MJPEG passthrough - the live camera / depth feed for the panel."""
    if kind not in ("video", "depth"):
        raise HTTPException(status_code=404, detail="unknown stream")

    async def gen():
        # Client and stream context live inside the generator so they last
        # for the whole watch and close when the viewer disconnects. An
        # engine that is down (or dies mid-watch) just ends the stream.
        try:
            async with httpx.AsyncClient(timeout=None) as c:
                async with c.stream("GET", f"{service.BASE}/stream/{kind}") as r:
                    async for chunk in r.aiter_bytes():
                        yield chunk
        except httpx.HTTPError:
            return

    return StreamingResponse(
        gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@router.get("/download")
async def download_proxy(path: str):
    """Serve a finished scan file straight from the shared data root.

    Deliberately does NOT go through the engine: the files are on disk the
    moment a scan exports, and a busy engine (a big mesh export can block its
    control server for a minute) must never make a completed download hang or
    fail. Containment to DATA_ROOT is the same rule the engine enforced, so a
    crafted ?path= cannot escape the scans directory.
    """
    from pathlib import Path
    from fastapi.responses import FileResponse
    f = Path(path).resolve()
    if not f.is_relative_to(service.DATA_ROOT.resolve()) or not f.is_file():
        raise HTTPException(status_code=404, detail="not a downloadable result file")
    # attachment + octet-stream so iPad Safari saves the file instead of
    # trying to navigate to a binary it cannot display.
    return FileResponse(f, filename=f.name, media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{f.name}"'})


# Read-only passthroughs - same no-auth policy as the rest of the API's GETs.
# Registered LAST: FastAPI matches in declaration order, and this catch-all
# would otherwise swallow /download and /engine.
_GETS = {
    "status": "/status", "metrics": "/metrics", "devices": "/devices",
    "results": "/results", "trajectory": "/trajectory",
    "scan_status": "/scan/status", "sessions_scannable": "/sessions_scannable",
    "map_preview": "/map/preview",
}


@router.get("/{name}")
async def read_proxy(name: str, request: Request):
    path = _GETS.get(name)
    if path is None:
        raise HTTPException(status_code=404, detail="unknown recon endpoint")
    # The scans list is read straight from disk, never from the engine: it is
    # the truth for finished scans and must stay responsive while the engine
    # is busy exporting (which blocks its control server) or idle/down.
    if name == "results":
        import asyncio
        return await asyncio.to_thread(service.list_results_from_disk)
    # Live-only reads (status, trajectory, map_preview...) need the engine, but
    # with a SHORT timeout so a busy engine fails fast instead of hanging the
    # client for 15 s.
    code, out = await service.forward("GET", path,
                                      params=dict(request.query_params),
                                      timeout=3.0)
    if code >= 400:
        raise HTTPException(status_code=code, detail=out.get("detail", "engine error"))
    return out

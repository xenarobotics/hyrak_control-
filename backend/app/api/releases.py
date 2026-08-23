"""
Range-capable static serving for /releases.

Starlette's StaticFiles (pinned 0.38.6) ignores the Range header entirely: a
ranged request returns HTTP 200 with the FULL body and no Accept-Ranges.
That breaks electron-updater's differential downloader, which Range-fetches
the block map embedded at the tail of the AppImage before downloading
anything. The updater then sits consuming a 143 MB body it believes is a
~150 KB range, emitting no `download-progress` the entire time - a progress
bar frozen at 0% with no error.

desktop 0.1.6 set `disableDifferentialDownload = true`, which fixes it for
clients running 0.1.6 or newer. It cannot fix the clients that need it most:
anyone still on <=0.1.5 has the differential downloader enabled, so their
update stalls, so they can never reach a build that has the flag. A
bootstrap deadlock that no client-side change can break.

Serving Range properly resolves it for every already-deployed version at
once, and is what an installer endpoint should do anyway - it's also what
makes a interrupted download resumable.
"""
import logging
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

logger = logging.getLogger("verocore.api.releases")

router = APIRouter(prefix="/releases")

# Read size per chunk while streaming a range. 256 KB balances syscall
# overhead against holding a large buffer per concurrent download.
_CHUNK = 256 * 1024

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _resolve(releases_dir: Path, filename: str) -> Path:
    """Resolve `filename` inside releases_dir, refusing anything that escapes
    it. `..` and absolute paths are the obvious attacks; symlinks pointing
    outside are the non-obvious one, which resolve() also covers."""
    base = releases_dir.resolve()
    target = (base / filename).resolve()
    if base != target and base not in target.parents:
        raise HTTPException(status_code=404, detail="Not found")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return target


def _media_type(path: Path) -> str:
    if path.suffix in (".yml", ".yaml"):
        return "application/yaml"
    if path.suffix == ".AppImage":
        return "application/octet-stream"
    if path.suffix in (".exe", ".dmg", ".deb", ".zip", ".blockmap"):
        return "application/octet-stream"
    return "application/octet-stream"


def _stream(path: Path, start: int, length: int):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def register_releases_routes(app, releases_dir: Path):
    # HEAD as well as GET: electron-updater issues HEAD to size the artifact
    # before downloading, and a 405 there aborts the update before a single
    # byte is fetched. FastAPI's @get does NOT imply HEAD.
    @app.api_route("/releases/{filename:path}", methods=["GET", "HEAD"])
    async def serve_release(filename: str, request: Request):
        path = _resolve(releases_dir, filename)
        size = path.stat().st_size
        media_type = _media_type(path)
        # Weak-ish validator built from the same inputs StaticFiles uses, so
        # electron-updater can revalidate a partially downloaded file.
        stat = path.stat()
        etag = f'"{stat.st_mtime_ns:x}-{size:x}"'

        range_header = request.headers.get("range")
        if not range_header:
            return FileResponse(
                path,
                media_type=media_type,
                headers={"Accept-Ranges": "bytes", "ETag": etag},
            )

        match = _RANGE_RE.match(range_header.strip())
        if not match:
            # Multi-range and non-byte units are legal to refuse; no client
            # in this path uses them.
            return FileResponse(
                path,
                media_type=media_type,
                headers={"Accept-Ranges": "bytes", "ETag": etag},
            )

        start_s, end_s = match.groups()
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        elif end_s:
            # "bytes=-N" - the LAST N bytes. This is the exact form
            # electron-updater uses to fetch the embedded block map.
            suffix = int(end_s)
            if suffix == 0:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
                )
            start = max(0, size - suffix)
            end = size - 1
        else:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
            )

        end = min(end, size - 1)
        if start > end or start >= size:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
            )

        length = end - start + 1
        return StreamingResponse(
            _stream(path, start, length),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
                "ETag": etag,
            },
        )

    logger.info(f"Range-capable /releases serving from {releases_dir}")

# backend-webrtc — API

## socket.io events consumed

| Event | Payload (relevant keys) |
|---|---|
| offer (see `signaling.py`) | `sdp`, `videoSource`, `clientOverlay`, `airUnitVideoPort`, `rtspUrl`, ICE server list |

`videoSource` defaults to `"camera"`. Derived flags:

```python
server_sourced = video_source in ("air_unit_udp", "siyi_rtsp")
client_overlay = bool(data.get("clientOverlay")) and not server_sourced
```

## socket.io events emitted

| Event | Meaning |
|---|---|
| answer / ICE candidates | Normal WebRTC signaling |
| `cv_results` | Vision metadata at inference rate, includes `frame_w`/`frame_h` |
| `error` | `{msg}` — used for server-sourced open failures. **Note:** consumers must treat this as terminal where a pending state exists (ADR-007) |
| `telemetry_status` | Emitted by the telemetry module, not here |

## HTTP

`GET /api/webrtc/ice-servers` — returns the Cloudflare TURN list. The frontend
fetches it before each `RTCPeerConnection` **and** passes the same list in the
offer so aiortc uses it too.

## `MultiModeVideoStreamTrack` (`stream_track.py`)

```python
MultiModeVideoStreamTrack(
    source_track:      MediaStreamTrack,
    session_id:        str,
    vision_pool:       VisionWorkerPool,
    session_manager:   SessionManager,
    emit_callback:     Optional[Callable] = None,
    snapshot_callback: Optional[Callable] = None,
    return_video:      bool = True,
)
```

`kind = "video"`. `async def recv() -> VideoFrame` is the hot path.

Internal state worth knowing: `_frame_cache` / `_meta_cache` (per-mode),
`_px_executor` — a **single-worker** `ThreadPoolExecutor` so frame order is
preserved while ~6-10ms/frame of pixel work at 1080p stays off the event loop
(it was delaying drone commands, telemetry, and signaling for every session).

`return_video=False` skips output composition entirely — only `cv_results` go
back.

## Video source factories

```python
# udp_video_source.py
open_air_unit_video(port: int = 5600, timeout: float = 5.0) -> MediaStreamTrack
```
Blocking (ffmpeg probes synchronously) — **must** be called via
`run_in_executor`, never directly from an async handler, or it freezes every
other session for up to `timeout`. Raises if there is no video stream.

```python
# rtsp_video_source.py
open_rtsp_video(rtsp_url: str) -> MediaStreamTrack
```
Same blocking contract.

Both are followed by a mandatory liveness check in `signaling.py`:

```python
try:
    await asyncio.wait_for(source_track.recv(), timeout=5.0)
except asyncio.TimeoutError:
    source_track.stop()
    raise RuntimeError("Opened ... but no video frames arrived within 5s ...")
```

## Planned: `srt_video_source.py`

```python
open_srt_video(port: int, latency_ms: int = 120, timeout: float = 5.0) -> MediaStreamTrack
```
Same shape as `open_air_unit_video`, with input
`srt://0.0.0.0:{port}?mode=listener&latency={latency_ms}` and
`protocol_whitelist` extended to include `srt`. Keep the low-latency option
block verbatim. Needs per-session port allocation — reuse the port-scan
approach in `events/swarm_events.py`.

## Bitrate ceiling overrides (`__init__.py`)

```python
vpx.DEFAULT_BITRATE = 3_000_000;  vpx.MAX_BITRATE = 12_000_000
h264.DEFAULT_BITRATE = 3_000_000; h264.MAX_BITRATE = 12_000_000
```

Must be imported before any peer connection is created — `signaling.py` imports
the package first, which is what makes this work. Do not reorder.

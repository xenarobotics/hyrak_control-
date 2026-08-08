# Module: backend-webrtc

Path: `backend/app/webrtc/`

## Purpose

Own the server's WebRTC peer connections and every video source, and funnel all
of them into one processing pipeline that vision analyzers consume.

## Responsibilities

- Negotiate offers/answers over socket.io, including ICE/TURN server lists.
- Decide per-session where video comes from (browser track vs server-opened).
- Run the vision pipeline on frames and either return annotated video or
  `cv_results` JSON only.
- Track peer lifecycle and clean up on disconnect/failure.

## Files

| File | Role |
|---|---|
| `__init__.py` | **Raises aiortc's hard-coded encoder bitrate ceilings** before any peer connection exists (VP8/H264: 3 Mbps default, 12 Mbps max; stock 0.5/1.5 caused visibly smeared 1080p) |
| `signaling.py` | Offer/answer handling, video-source branching, `_sort_relay_urls`, `_attach_video_track` |
| `stream_track.py` | `MultiModeVideoStreamTrack` — the single funnel; pixel work on a 1-worker executor |
| `peer_registry.py` | `PeerEntry` / `PeerRegistry` lifecycle |
| `turn.py` | Cloudflare TURN credential minting (24h TTL, cached, re-mint under 1h left) |
| `udp_video_source.py` | Opens RTP/H.265 from a **local** UDP port via `MediaPlayer` + a generated SDP |
| `rtsp_video_source.py` | Opens a networked RTSP camera (e.g. SIYI gimbal) **from the server** — only works when the server shares a network with the camera, i.e. dev only (ADR-008) |
| `relay_video_source.py` | Receives the desktop app's `-c copy` uplink. `RelayIngest` per session: an ffmpeg SRT/TCP listener remuxing to loopback UDP, which `MediaPlayer` then opens. `allocate()` is **idempotent** and `open_track()` **retries to a deadline** — see below |

## Dependencies

`aiortc`, `av` (PyAV), `opencv-contrib-python-headless`, `numpy`,
`app.vision.worker_pool`, `app.sessions`, `httpx` (TURN API).

## Configuration

- `videoSource` in the offer payload: `camera` | `air_unit_udp` | `siyi_rtsp`
- `airUnitVideoPort` (default 5600), `rtspUrl`
- `clientOverlay` boolean
- `TURN_KEY_ID` / `TURN_API_TOKEN` from the root `.env` (gitignored)

## Load-bearing details

- **`relay_video_source.allocate()` must stay idempotent.** It once
  released-then-recreated on every call, so an ordinary retry killed the
  ffmpeg an in-flight `open_track` was reading AND moved the public port,
  stranding a client that had already begun pushing.
- **`open_track()` retries rather than opening once.** PyAV fails *fast* on a
  silent UDP port instead of waiting out its timeout, so a single attempt
  races the client's connect + first keyframe — a race the client cannot win.
 — do not change casually

- **`relay.subscribe(track, buffered=False)`** — the buffered default queued
  frames unboundedly; latency crept 300ms → 1s+.
- **The low-latency `MediaPlayer` options** in `udp_video_source.py`
  (`fflags nobuffer`, `flags low_delay`, `max_delay 100000`,
  `reorder_queue_size 0`) fix a real ~1s of fixed delay from ffmpeg's
  VOD-tuned defaults. Mirrored in the desktop bridge — keep both in sync.
- **`_sort_relay_urls`** — aiortc uses only the **first** STUN and **first**
  TURN url. Cloudflare lists UDP TURN first, which is dead on UDP-blocking
  networks, so TLS/TCP:443 must be reordered to the front.
- **The 5s `recv()` guard** on server-sourced tracks. An SDP declares the format
  statically, so opening "succeeds" instantly even with zero packets arriving;
  without the guard a dead feed negotiates a connected-but-permanently-black
  session with no error anywhere.
- **`return_video=False`** — client-overlay mode; skips all output composition
  and the downlink encode.

## Known issues

- `udp_video_source.py` binds `127.0.0.1`, so `air_unit_udp` only works when
  the backend is co-located with the RF link. Its own error string documents
  this. See `docs/KNOWN_ISSUES.md` #2.
- `signaling.py` knows every source by string literal; adding one is a
  four-file coordinated edit.
- `client_overlay` is disabled for server-sourced feeds
  (`... and not server_sourced`) purely because there is no local preview to
  draw on. A local preview would unlock it (ADR-004).
- One re-encode per browser spectator; no SFU fan-out.

## Future improvements

- `srt_video_source.py` — an SRT listener modeled on `udp_video_source.py`
  (ADR-002).
- Allow `client_overlay` for `air_unit_srt`.
- Replace the string-literal source branching with a registry if modes keep
  growing.

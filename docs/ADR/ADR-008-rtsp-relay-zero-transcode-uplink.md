# ADR-008 — Networked cameras relay through the client, not the server

Date: 2026-07-26 · Status: **Accepted and implemented** (desktop 0.1.7)

## Problem

`siyi_rtsp` (ADR pre-dates this file; see `rtsp_video_source.py`) has the
**backend** open `rtsp://192.168.144.25:8554/video1`. That works on a
developer's machine, where backend and camera share a network, and cannot
work anywhere else:

- `192.168.144.25` is link-local to the SIYI ground unit's own WiFi hotspot.
  Only the laptop plugged into that hotspot can reach it.
- That laptop is behind NAT, so the server can't reach *it* either.
- RTSP is a **pull** protocol. There is no arrangement of it in which a
  server outside the hotspot fetches the stream.

The shipped mode is therefore mislabelled rather than broken: it is
dev-only, and it is the option whose name most invites a real deployment to
select it. Same trap as `air_unit_udp`, whose own error string already
documents it.

## Decision

The client pulls the camera and **pushes the camera's original bytes**
to the backend. `ffmpeg -c copy` — remux, never re-encode.

```
SIYI hotspot ──RTSP/TCP──► desktop ffmpeg -c copy ──┬──► MPEG-TS/SRT ──► server
                                                    └──► fragmented MP4 ──► local preview
```

New mode `rtsp_relay`, alongside — not replacing — every existing source.

### Why not decode on the client and reuse WebRTC

That is what `rtspBridge.ts` already does, and it is retained as the
fallback (ADR-003: multi-mode is mandatory, because SRT cannot traverse a
UDP-blocking network at all while WebRTC-over-TURN-TLS:443 can). But as the
*default* it is the wrong trade: it spends a decode **and** an encode on a
client that is typically an Intel i5, and CPU exhaustion mid-flight is a
more common stream-killer than any network fault. `-c copy` removes that
failure mode entirely and also removes the generation loss.

### Why the preview comes off the same ffmpeg

The operator sits at the machine holding the camera. Sending video to the
server so it can come back is a round trip for nothing. Teeing a second
output costs no extra decode, no extra RTSP session, and no extra network
path — the operator's picture never leaves the laptop.

## Consequences

### The uplink does NOT go through the cloudflared tunnel

This is the load-bearing operational fact. The tunnel proxies HTTP; SRT is
raw UDP. `relay_public_host` must name a **directly reachable** address with
the relay port range forwarded, or the mode cannot connect. It defaults to
empty and the UI refuses to start rather than letting the operator debug a
silent connect timeout.

### PyAV cannot open `srt://`

Verified: `ProtocolNotFoundError`, and there is no `libsrt` in its bundled
`av.libs`, so aiortc's `MediaPlayer` cannot ingest SRT directly. Rebuilding
PyAV was rejected as fragile and as touching every existing video path.

Instead the server runs one `-c copy` ffmpeg per session that receives the
SRT connection and re-emits MPEG-TS to loopback UDP, which PyAV opens
happily — reusing the pattern `udp_video_source.py` already proved. That hop
is a remux, ~1-5 ms, no decode and no encode.

### Latency is a wash, not a win — and that is fine

Removing the client transcode saves ~30-60 ms on an i5 at 1080p; SRT's
latency window adds back whatever it is set to. At the ffmpeg default
(120 ms) the mode would be *slower*. Hence a 60 ms default and an exposed
setting. The honest wins here are **CPU** and **quality**, not latency; the
real latency win is the local preview deleting the round trip.

### Allocation is a socket event, not an HTTP endpoint

An HTTP endpoint was written first and reverted: the backend keys sessions
by socket id and the browser never learns its own `session_id`, so an HTTP
call had nothing to identify itself with. `allocate_video_relay` /
`release_video_relay` use socket acks, where the backend derives the session
from `sid`.

Ordering is load-bearing: **allocate → start relaying → send the offer.**
`on_offer` attaches to an already-arriving stream and gives up if no frame
appears, so an offer sent before the push is guaranteed to fail.

## Verified during implementation

- Bundled `ffmpeg-static` has `srt`, `mpegts`, `tee`, and the `rtsp` demuxer.
- SRT's `latency` option is **microseconds** (default 120000), not ms.
- The mp4 flag is `default_base_moof`, not `default_base_is_moof`.
- ffmpeg-static **segfaults** acting as an SRT *listener*; the server uses
  system ffmpeg (6.1.1), which is clean. The client only ever calls.
- End-to-end through the real `RelayIngest`: 10 frames at 1280x720 decoded
  after a genuine SRT push, and `release()` reaped its ffmpeg.

## Still unverified

- Nothing has been run against actual SIYI hardware — the dev machine is not
  on the hotspot. Codec is unconfirmed; `ffprobe` on the operator's laptop
  will settle whether the server must transcode H.265 for remote browsers.
- Preview latency through Chromium's media stack for progressive fMP4 is
  unmeasured. If it proves high, ADR-004's WebCodecs path is the upgrade —
  the relay itself would not change.

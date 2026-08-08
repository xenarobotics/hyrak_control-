# ADR-002 — SRT for the client→server video uplink

Date: 2026-07-26 · Status: **Accepted (planned, not implemented)**

## Problem

The server must receive the air unit's video to run AI inference, but:

- The existing `camera` path makes the client re-encode (CPU + generation loss).
- The existing `air_unit_udp` path has the *server* bind `127.0.0.1:5600`,
  which only works when the backend is co-located with the RF link — never
  true for a real client. `signaling.py` already documents this in its own
  error string.

## Decision

Add a **client-pushes / server-listens** mode using **SRT** carrying MPEG-TS
with the original H.265, copied with `-c copy` (no transcode).

Client: `-f mpegts "srt://<server>:<port>?mode=caller&latency=120&streamid=<session>"`
Server: `srt://0.0.0.0:<port>?mode=listener`

## Reason

- **Zero new dependencies** — the bundled `ffmpeg-static` already speaks SRT.
- **Bounded retransmission**: ARQ like TCP, but only within a configurable
  latency window; unrecoverable packets are dropped so the stream keeps
  moving. Glitch instead of freeze — deliberately between plain UDP (no
  recovery) and TCP (unbounded stalls).
- The latency window is a knob we own, not an opaque heuristic.
- Built-in AES; caller/listener/rendezvous NAT modes need no STUN/TURN.
- Congestion control tuned for CBR live video.
- Industry standard (OBS, GStreamer, MediaMTX, SRS); Linux Foundation
  governed, Haivision-originated.
- Server-side it feeds the existing `MediaPlayer` → `MultiModeVideoStreamTrack`
  pipeline unchanged — `udp_video_source.py` is ~90% of the implementation.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Tunnel RTP over the existing socket.io channel | **Rejected** — TCP retransmit-and-wait stalls under loss. This was the basis of the original objection to "push UDP to the server"; it does not apply to SRT. |
| Plain RTP/UDP relay | **Kept as an optional additional mode** (ADR-003) — ~0 added latency but zero loss recovery. Right for LAN/VPN only. |
| RIST | Rejected — comparable to SRT, thinner tooling. |
| RTMP / SRT-over-TCP | Rejected — seconds of latency. |

## Trade-offs

- Adds the SRT window (~120ms) plus WAN to the **server's** view. This does
  **not** affect the pilot's own view (ADR-004) — that decoupling is the
  design's most important property.
- Requires an inbound UDP port range on the server, plus firewall config.
- **Pure UDP, no TCP fallback** — cannot connect at all on UDP-blocking
  networks. This limitation is what forces ADR-003.

## Consequences

- Server gets pristine H.265 instead of a re-encode: strictly better AI input.
- Client does zero encodes.
- Needs a per-session listener port and an allocation scheme (reuse the
  port-scan approach in `events/swarm_events.py`).
- **Open decision:** how the client learns its port. Recommended: a signaling
  round trip returning `{srtHost, srtPort}` before the client starts ffmpeg.

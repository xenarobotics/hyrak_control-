# ADR-001 — Keep WebRTC; the problem is transcode count, not transport

Date: 2026-07-26 · Status: **Accepted**

## Problem

The air unit emits UDP RTP/H.265. Video quality looked degraded and client CPU
was high. The working hypothesis was "WebRTC is the bottleneck — replace it."

## Decision

**Keep WebRTC for the final hop to any browser viewer.** Reframe the problem
as eliminating *transcode passes* on the client, not replacing the transport.

## Reason

- SRTP is a lossless envelope; it transports exactly what the encoder emits.
  The quality loss is **generation loss from re-encoding**, plus the encoder's
  congestion-driven bitrate adaptation — the reason
  `backend/app/webrtc/__init__.py` already had to raise aiortc's 1.5/3 Mbps
  ceilings, which were "heavily smearing" 1080p.
- SRTP/ICE overhead is negligible next to an H.265 encode pass.
- The real trap was discovered separately: **Chromium refuses H.265 in WebRTC
  SDP negotiation** (Safari accepts it). Since the air unit emits H.265 and
  operators run Chromium, true passthrough-to-browser is impossible, so
  *someone* must transcode. Today that someone is the weakest machine in the
  system.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| MSE (`MediaSource` + fragmented MP4) | **Rejected.** A playback *sink* only — cannot be an `RTCPeerConnection` send source, so it does nothing for video that must reach the server. Its stall-free-playback buffering is also higher latency than WebRTC. Was briefly recommended, then withdrawn. |
| RTMP | Rejected — TCP, 2-5s, no native browser playback. |
| LL-HLS / DASH-CMAF | Rejected for flying (1-3s best case). Acceptable only for passive spectators. |
| WebTransport + WebCodecs | Rejected — build-your-own-WebRTC: re-implement jitter buffering, congestion control, packetization. Doesn't reduce encode CPU. |
| Media over QUIC (MoQ) | Rejected for now — IETF draft, no browser player without custom plumbing. Worth watching. |
| RTSP | Never a candidate — a session-control protocol, not a transport or codec. Nothing in the chain runs an RTSP server; `wfb_rx` just fires UDP packets. |
| Ship H.264 from the air unit instead | **Still open.** Would dissolve the codec-negotiation problem entirely and allow true passthrough, at ~30-40% more RF bandwidth. Out of scope, deliberately noted. |

## Trade-offs

Keeps a mature, well-understood transport and its TURN fallback. Accepts that
one transcode must exist somewhere — the decision is only *where*.

## Consequences

- Motivates ADR-002 (SRT for the client→server leg) and ADR-004 (local
  preview without a fake webcam).
- QUIC was checked and confirmed absent from the stack; no reason to add it.

# ADR-003 — Video transport is user-selectable, multi-mode by necessity

Date: 2026-07-26 · Status: **Accepted**

## Problem

Given SRT's clear advantages (ADR-002), the tempting conclusion is "ship only
SRT and delete the rest." Is one best mode sufficient?

## Decision

**No. Ship multiple selectable modes**, chosen by the operator in
Settings → Video → Video source, with per-scenario guidance. **Retain the
v4l2loopback path** rather than deleting it.

## Reason

One hard, field-proven fact:

> **Japesh's college WiFi blocks all outbound UDP.** Documented in
> `app/webrtc/signaling.py` (`_sort_relay_urls`, commit `a0dc785`); the
> signature was `socket.send() raised exception` spam and peer connections
> stuck at "connecting". The fix was forcing Cloudflare's `turns:443` TCP/TLS
> relay to the front of the ICE list — the only thing that traverses such a
> network.

**SRT is pure UDP with no TCP fallback.** On such a network `air_unit_srt`
cannot connect at all, while WebRTC survives via TURN over TLS/443.
Conversely, on a normal network SRT is dramatically better on client CPU and
video quality. **Neither dominates.**

So the mode selector is load-bearing infrastructure: it is what lets one build
serve a client on a locked-down campus network *and* a client on home
broadband with a weak PC.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| SRT only | **Rejected** — fails completely on UDP-blocking networks. |
| WebRTC only (status quo) | Rejected — double transcode on weak clients, Linux-only for the air unit. |
| Expose the four underlying axes (source × transport × preview × downlink) as separate settings | **Rejected.** Operators are traffic police, not network engineers. Four dropdowns is a usability failure. |
| Auto-detect only, no manual control | Rejected *for now* — needs the manual selector to exist and be trusted first, plus a visible "which path is live" status. Revisit later. |

## Trade-offs

- More code paths to maintain and test, including one (v4l2loopback) that was
  slated for deletion.
- Users can pick a suboptimal mode. Mitigated by `tip` text on each chip
  carrying the "use when" guidance, since operators will not read docs.

## Consequences

- **The SRT rearchitecture plan's Phase 3 was corrected**: it had said to
  delete the v4l2loopback path. That would have removed the only mode that
  works on UDP-blocking networks.
- Users pick **one named profile** that fixes all four internal axes. The
  existing `VideoSource` enum already works this way — its three values are
  three tuples, not three "sources". **Do not refactor into orthogonal knobs.**
- Six chips will overflow the Settings row; group them or switch to a select
  when the fourth mode lands.
- `air_unit_udp` must be relabelled "Air unit (server-local)" so no remote
  client picks it and gets a connected-but-black stream.

Full matrix and per-scenario defaults: `docs/video-transport-modes.md`.

# frontend-transport — TODO

## air_unit_srt (planned — docs/ROADMAP.md, ADR-002/003/004)

- [ ] Add `air_unit_srt` to the `VideoSource` type and the `SOURCES` allowlist
      in `videoSource.ts`.
- [ ] Add the chip to `VideoGroup` in `settings/page.tsx` with a `tip` carrying
      the operator-facing "use when" guidance from
      `docs/video-transport-modes.md` — operators do not read docs.
- [ ] Per-mode conditional `PrefRow`s (SRT latency window, uplink bandwidth
      ceiling), following the existing `{source === 'air_unit_udp' && ...}` shape.
- [ ] **Fix the chip-row overflow** — six chips will not fit. Group them
      (Camera / Air unit / Network camera with a sub-choice) or switch to a select.
- [ ] Relabel `air_unit_udp` → "Air unit (server-local)" with the co-location
      requirement in its `sub`, so no remote client picks it and gets a
      connected-but-black stream.
- [ ] New WebCodecs preview hook + component: `VideoDecoder` → `VideoFrame` →
      canvas, fed encoded access units from the bridge over the new binary IPC
      channel.
- [ ] `VideoStream.tsx`: render the preview canvas for `air_unit_srt`, extending
      the existing `isRaw` branch rather than adding a parallel one.
- [ ] Runtime check + graceful degradation for
      `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})`; fall back to
      the ffmpeg-rawvideo-at-720p path.

## Tech debt

- [ ] Audit other `socket.on` gaps for the ADR-007 defect class — are there
      other server events that should exit a pending UI state but have no
      listener? The generic `error` was one; there may be more.
- [ ] Recording in overlay mode captures raw video without annotations
      (`docs/KNOWN_ISSUES.md` #4). Either composite the canvas into the
      recording or label the limitation in the UI.
- [ ] `localStorage`-only configuration means the server cannot see a client's
      settings, which makes remote diagnosis hard. Consider reporting the active
      transport/mode in `session_ready` or a session-info event.

## Robustness

- [ ] The udp bridge only signals the **first** packet. A source that dies
      mid-session leaves the UI looking healthy. Add a stalled-traffic
      indicator once the bridge emits one.
- [ ] Show which transport path is actually live (direct vs TURN relay, SRT vs
      WebRTC) — needed before the planned auto-probe fallback ships, or
      operators will not know what they are on (ADR-003).

# ROADMAP

## Now — unblock and confirm

1. **Restart the backend** so the telemetry error-reporting fix is live.
2. **Confirm the SITL root cause.** Needs one fact from the client: native
   SITL, or WSL2/Docker/VM? (KNOWN_ISSUES #1)
3. **Commit the untracked surface.** Highest-risk item in the project.
   (KNOWN_ISSUES #7)

## Next — `air_unit_srt` video rearchitecture

Full plan: `~/.claude/plans/hyrak-srt-video-rearchitecture.md`.
Mode matrix: `docs/video-transport-modes.md`. Rationale: ADR-002, ADR-004.

Two decisions gate the work:
- **SRT port handshake.** Recommended: a signaling round trip where the client
  offers, the server allocates a listener, and returns `{srtHost, srtPort}`
  before the client starts ffmpeg. This reorders today's "start bridge, then
  start stream" flow, so it needs an explicit decision.
- **WebCodecs HEVC availability** on client hardware. Check
  `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})`; may need
  `enable-features=PlatformHEVCDecoderSupport`. Fallback is ffmpeg software
  decode to rawvideo at 720p preview — still zero encodes.

### Phase 1 — Server SRT ingest + client SRT push

Additive only; the existing v4l2loopback preview stays untouched so nothing can
regress.

- New `backend/app/webrtc/srt_video_source.py`, modeled on
  `udp_video_source.py` (**keep its low-latency option block verbatim**), with
  input `srt://0.0.0.0:<port>?mode=listener&latency=<ms>` and
  `protocol_whitelist` extended with `srt`.
- Per-session listener port allocation — reuse the port-scan approach in
  `events/swarm_events.py`.
- `signaling.py`: add `air_unit_srt` to the `server_sourced` tuple with its own
  branch. Keep the 5s no-frames guard.
- Verify `ffmpeg -protocols | grep srt` on the server; open an inbound UDP
  port range.
- `airUnitVideoBridge.ts`: add a second output —
  `-map 0:v -c copy -f mpegts "srt://<host>:<port>?mode=caller&latency=120&streamid=<session>"`.
  `-c copy` means ~0% added CPU. RTP depayload already yields Annex-B, so no
  bitstream filter is needed. New config: `srtHost`, `srtPort`,
  `srtLatencyMs`, `streamId`.

**Outcome:** the server receives pristine H.265 from a genuinely remote client.

### Phase 2 — Local WebCodecs preview, retire the fake webcam for this mode

- Bridge: replace `-f v4l2 <device>` with `-c copy -f hevc pipe:1`; drop the
  `/dev/video10` precondition and the `modprobe` error string. ffmpeg becomes a
  pure packet mover with no decode at all.
- Add a binary IPC channel for encoded access units (KB-sized). **Never send
  raw decoded frames over IPC** — 1080p yuv420 @30fps is ~93 MB/s.
- Renderer: `VideoDecoder` → `VideoFrame` → canvas. Needs in-band VPS/SPS/PPS
  with `annexb` description mode.
- `VideoStream.tsx`: render the preview canvas for `air_unit_srt`, extending
  the existing `isRaw` branch.
- `signaling.py`: allow `client_overlay` for `air_unit_srt`, which drops the
  downlink video leg entirely (already-built machinery — ADR-004).

**Outcome:** ~20-60ms pilot view, one decode, zero encodes, Windows/macOS
possible.

### Phase 3 — Mode selector and cross-platform

- Add `air_unit_srt` to `VideoSource` and the `VideoGroup` `ChipGroup`, with
  per-mode conditional `PrefRow`s (latency window, bandwidth ceiling).
- **Do not delete the v4l2loopback path** — it is the UDP-blocked fallback
  (ADR-003).
- Relabel `air_unit_udp` → "Air unit (server-local)".
- Fix the chip-row overflow.
- Build and smoke-test the Windows NSIS target.
- Optional: `air_unit_rtp_relay` for LAN/VPN clients (~0 added latency, no loss
  recovery) — or decide `latency=20` SRT covers it.

## Later

- **Auto-probe with fallback**: try SRT, fall back to `camera`/WebRTC, with a
  visible "UDP blocked, using WebRTC" status so the operator always knows which
  path is live. Same probe-then-fallback shape as ADR-005. Needs the manual
  selector trusted first.
- **Authentication / login.** Blocks external use (KNOWN_ISSUES #6).
- **Zones / identity / multi-tenant** expansion.
- **Code signing** (CSC secrets) for Windows and macOS.
- **CI deploy** (`DEPLOY_*` secrets, `DEPLOY_CONFIGURED`).
- **`.deb` packaging** — deliberately on hold.
- **RTSP bridge → video-source UI wiring** (the desktop `rtspBridge` exists but
  isn't surfaced as a source).
- **Measure concurrent-session capacity** (KNOWN_ISSUES #11).
- **Verify the crowd/plate session-end ZIP export + purge flow** against
  `vision/persistence.py` — may already be complete.

## Explicitly out of scope

- Changing the air unit's codec to H.264. Would dissolve the WebRTC
  codec-negotiation problem and enable true passthrough, at ~30-40% more RF
  bandwidth. A real option, deliberately not taken now.
- QUIC / WebTransport / MoQ. Evaluated and rejected (ADR-001) — they solve
  transport problems this project doesn't have and none of the CPU problem it
  does.
- Remote-spectator fan-out / SFU. The server keeps one re-encode for browser
  viewers; scaling that is a later problem.

# desktop-bridges — TODO

## air_unit_srt rearchitecture (planned — see docs/ROADMAP.md)

- [ ] **Phase 1** — add a second ffmpeg output to `airUnitVideoBridge.ts`:
      `-map 0:v -c copy -f mpegts "srt://<host>:<port>?mode=caller&latency=120&streamid=<session>"`.
      Additive only; leave the v4l2loopback output untouched so nothing regresses.
      New config: `srtHost`, `srtPort`, `srtLatencyMs`, `streamId`.
- [ ] **Phase 2** — replace `-f v4l2 <device>` with `-c copy -f hevc pipe:1`;
      drop the `fs.existsSync(device)` precondition and the `modprobe` error
      string. ffmpeg becomes a pure packet mover with no decode.
- [ ] **Phase 2** — add a binary IPC channel for encoded access units
      (`hyrak-bridge-frame`, or a `frame`-typed event with a `Uint8Array`).
      **Never send raw decoded frames** — 1080p yuv420 @30fps ≈ 93 MB/s.
- [ ] **Phase 2** — verify `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})`
      in Electron 32 on client hardware; may need
      `app.commandLine.appendSwitch('enable-features','PlatformHEVCDecoderSupport')`
      in `app-main.ts`. Fallback: ffmpeg → rawvideo at 720p preview.
- [ ] **Phase 3** — build and smoke-test the Windows NSIS target once nothing
      in the video path is Linux-specific.

## Tech debt

- [ ] De-duplicate the low-latency ffmpeg option block shared with
      `backend/app/webrtc/udp_video_source.py`, or add a test asserting the two
      copies match. Drift silently regresses latency.
- [ ] Wire `rtspBridge` to a video source in the UI, or remove it. It is
      implemented and unreachable.
- [ ] Consider re-probing VAAPI on demand rather than caching for the process
      lifetime, so a newly installed driver is noticed without a restart.

## Nice to have

- [ ] Surface `bindAddress` in Settings for users who want SITL/swarm ports off
      their LAN (ADR-006 accepted the LAN exposure by default).
- [ ] Emit a periodic throughput stat per port so the UI can show a live
      bytes/sec indicator rather than only a first-packet signal.
- [ ] Consider a `receiving:false` / stalled event if traffic stops for N
      seconds mid-session — currently only the *first* packet is signalled, so
      a mid-flight source death looks like a healthy bridge.

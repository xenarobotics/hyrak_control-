# Module: desktop-bridges

Path: `desktop/src/bridges/`

## Purpose

Give the renderer capabilities a browser cannot have — raw UDP/TCP sockets,
serial ports, ffmpeg subprocesses — by running them in the Electron **main**
process and exposing a single generic IPC surface.

## Responsibilities

- Own all sockets, child processes, and native modules on the client.
- Present one uniform contract (`NativeBridge`) so the renderer never learns
  protocol specifics.
- Detect hardware capability at runtime and degrade gracefully rather than fail.
- Report enough status that the renderer can distinguish "started" from
  "actually working".

## Files

| File | Role |
|---|---|
| `types.ts` | `NativeBridge` contract, `BridgeEvent`, `EmitFn`. `start()` may return `meta` — use it for anything the caller needs immediately |
| `registry.ts` | Maps `kind` string → bridge instance |
| `udpBridge.ts` | N tagged UDP ports; SITL (14540) and swarm (14541+) |
| `tcpBridge.ts` | TCP relay |
| `serialBridge.ts` | Serial ports via `serialport` |
| `rtspBridge.ts` | RTSP → local HTTP MJPEG (`http://127.0.0.1:PORT/stream`). Now reachable: it is `rtsp_camera`'s codec-independent fallback, since ffmpeg decodes rather than the browser |
| `rtspRelayBridge.ts` | RTSP → `ffmpeg -c copy` → tee: MPEG-TS/SRT uplink to the backend **+** fragmented-MP4 local preview on loopback HTTP. No decode, no encode (ADR-008). With `uplink: false` it serves preview only — the source of the `rtsp_camera` MediaStream |
| `airUnitVideoBridge.ts` | RTP/H.265 UDP → decode → v4l2loopback virtual webcam |

## Dependencies

- Node built-ins: `dgram`, `net`, `child_process`, `fs`, `os`, `path`
- `ffmpeg-static` (asar-unpacked), `serialport`
- Optional at runtime: a **system** ffmpeg with working VAAPI; the
  `v4l2loopback` kernel module

## Configuration

Per-`start()` config objects. Notable:

- `udp`: `{ ports: [{tag, port}], bindAddress? }` — `bindAddress` defaults to
  `0.0.0.0`.
- `air-unit-video`: `{ port = 5600, device = '/dev/video10', mode = 'auto'|'hw'|'sw' }`.

## Known issues

- `airUnitVideoBridge` is **Linux-only** (v4l2loopback), blocking the declared
  Windows and macOS builds until `air_unit_srt` lands.
- Its low-latency ffmpeg option block is duplicated from
  `backend/app/webrtc/udp_video_source.py`, synced by comment only.
- The VAAPI probe result is cached per process, so a driver installed later
  needs an app restart to be noticed.
- `rtspBridge` is implemented but unreachable from the UI. It is deliberately
  kept as the compatibility fallback to `rtspRelayBridge`: it decodes to MJPEG
  so frames enter the ordinary WebRTC path, which works on UDP-blocking
  networks where SRT cannot connect at all (ADR-003).
- **`rtspRelayBridge` is caller-only, never listener.** `ffmpeg-static`
  segfaults acting as an SRT listener; only the server (system ffmpeg) listens.
- **SRT `latency` is microseconds** (ffmpeg default 120000 = 120 ms) and is a
  floor on glass-to-glass delay, not just a retransmit budget. The bridge
  defaults to 60 ms.
- The fMP4 preview caches everything before the first `moof` box as the init
  segment and replays it to late-joining viewers — without `ftyp`+`moov` a
  viewer that connects mid-stream sees only undecodable fragments.
- Binding `0.0.0.0` exposes bound ports to the client's LAN — deliberate
  (ADR-006), overridable.

## Future improvements

See `TODO.md`. Headline: turn `airUnitVideoBridge` into a pure packet mover
(`-c copy`), add an SRT output, and drop the virtual-camera dependency.

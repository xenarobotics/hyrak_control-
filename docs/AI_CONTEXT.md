# AI_CONTEXT — read this first

Single-file orientation for an AI or engineer picking up **hyrak_control**.
Everything here is reverse-engineered from the code, which is the source of
truth. Anything unconfirmed is marked **Needs verification.**

## Project summary

HYRAK (package name `verocore-backend`) is a **cloud drone ground-control
platform**. An operator's browser or Electron desktop app streams video and
MAVLink telemetry to a central server, which runs AI vision inference
(detection, tracking, depth, crowd counting, ANPR) and returns results.

The defining constraint: **the server owns no hardware.** The drone, RF link,
and camera are all on the *client's* machine. Everything must be relayed to
the server. Clients run modest hardware (Intel i5 + iGPU), so client-side CPU
is the scarcest resource in the system.

## Architecture summary

Three deployable pieces plus a read-only reference dir:

| Piece | Stack | Role |
|---|---|---|
| `backend/` | Python 3.11, FastAPI + uvicorn, python-socketio, aiortc | Session state, WebRTC peer, vision inference, MAVSDK telemetry, Postgres |
| `frontend/` | Next.js (App Router), React, Zustand, socket.io-client | Operator UI — Fly, Modules, Telemetry, Settings tabs |
| `desktop/` | Electron 32, TypeScript, electron-builder | Native escape hatch: raw UDP/TCP/serial sockets, ffmpeg, auto-update |
| `communication/` | shell | **READ-ONLY reference.** wfb-ng ground-station scripts. Never modify. |

Two transports run side by side:
- **socket.io over WebSocket (TCP)** — signaling, telemetry, commands, AI results.
- **WebRTC (SRTP/UDP)** — video, with Cloudflare TURN over TLS:443 as fallback.

**QUIC/HTTP3 is not used anywhere.** This was checked and deliberately rejected.

## Folder map

```
hyrak_control/
├── backend/app/
│   ├── server.py          # create_app(): FastAPI + socket.io wiring
│   ├── main.py            # uvicorn entry (reload_dirs=["app"] on purpose)
│   ├── config.py          # pydantic-settings; port 8001, Postgres DSN
│   ├── webrtc/            # signaling, stream_track, peer_registry, turn,
│   │                      #   udp_video_source, rtsp_video_source
│   ├── vision/            # base.py, drawing.py, persistence.py,
│   │   └── modules/       #   7 registered analyzers + __registry__.py
│   ├── telemetry/         # manager.py (MAVSDK), serial_bridge.py, rf_bridge.py
│   ├── events/            # socket.io handlers (telemetry, swarm, admin, ...)
│   ├── sessions/          # SessionManager, AnalysisMode enum
│   ├── db/, flights/, zones/, permits/, api/, registry/, sandbox/, utils/
├── frontend/src/
│   ├── app/(platform)/    # fly, modules, telemetry, settings routes
│   ├── lib/               # socket, nativeBridge, videoSource, videoSettings,
│   │                      #   remoteSitlRelay, localSwarmRelay, localRfRelay
│   ├── hooks/             # useDrone, useWebRTC, useAirUnitVideoBridge, useCamera
│   ├── components/        # video/, vision/, controls/, osd/, updater/
│   ├── contexts/, store/, types/
├── desktop/src/
│   ├── app-main.ts, main.ts, preload.ts, updater.ts
│   └── bridges/           # udp, tcp, serial, rtsp, airUnitVideo + registry
├── docs/                  # this knowledge base
├── modules/               # per-module docs
└── start.sh               # one-click backend+frontend launcher
```

## The two process types that define what is possible

This is the single most misunderstood thing in the project:

- **Electron main process** = full Node.js, **not sandboxed**. Raw UDP
  (`dgram`), child processes (ffmpeg), native modules. All of
  `desktop/src/bridges/` runs here.
- **Electron renderer** = Chromium, **identical restrictions to a browser
  tab**. No raw UDP, no RTSP, ever.

So "the browser can't do UDP" and "the desktop app reads UDP" are both true
simultaneously. Sockets live in main; only decoded frames or relayed bytes
cross to the renderer over Electron IPC.

## Data flow (video)

`videoSource` (`frontend/src/lib/videoSource.ts`) selects one of three
**shipped** paths — see `docs/video-transport-modes.md` for the full matrix:

1. `camera` — browser `getUserMedia` → encode → WebRTC uplink. For the RF air
   unit this needs the **v4l2loopback fake-webcam hack** (ffmpeg decodes
   H.265 to `/dev/video10`, browser re-captures it). **Two transcodes on the
   client, and Linux-only.**
2. `air_unit_udp` — server binds `127.0.0.1:5600` itself. **Only works when
   the backend is on the same machine as the RF link** (dev only).
3. `siyi_rtsp` — server pulls RTSP from a networked gimbal camera.

Server side: any source track → `MultiModeVideoStreamTrack.recv()`
(`webrtc/stream_track.py`) → vision analyzer → either an annotated frame
re-encoded downlink, or (`clientOverlay` mode) `cv_results` JSON only with
`return_video=False`, and the browser draws overlays on `CvOverlayCanvas`.

## Data flow (telemetry)

`radio/SITL → client → socket.io serial_uplink → SerialBridge (loopback UDP)
→ mavsdk_server → TelemetryManager → telemetry_update events`, and the
reverse via `serial_downlink`. `SerialBridge` (`telemetry/serial_bridge.py`)
makes a remote radio look local to MAVSDK. One bridge per session.

## Conventions

- **Comments explain *why*, densely.** Almost every non-obvious line carries
  the bug or constraint that produced it. Match this density; do not strip
  these comments — several encode hard-won findings that cost debugging days.
- Backend: snake_case, module-scoped `logging.getLogger("verocore.<area>")`,
  `db_available()`/`get_session()` guards around all DB writes.
- Frontend: `'use client'`, Zustand store, camelCase, localStorage prefs
  namespaced `hyrak-*`.
- Desktop bridges: implement `NativeBridge` (`kind`/`start`/`stop`/`send`),
  register in `bridges/registry.ts`. The IPC surface is generic
  (`kind + id + config`) so adding a bridge never touches `main.ts` or
  `preload.ts`.
- Failure reporting: **every** connect path must emit a terminal status the
  UI understands. See ADR-007.

## Design philosophy

1. **Count the transcodes.** On weak clients, encode/decode passes dominate;
   protocol overhead is noise.
2. **Probe capability at runtime, never trust compile-time flags**, and
   always degrade to a working path instead of failing. See ADR-005.
3. **Multiple transports on purpose.** No single mode works on every
   network. See ADR-003.
4. **Latency decoupling.** The pilot's own view must never be routed through
   the server.

## Current implementation status

Shipped and working: all three video sources, client-side overlays, TURN
relay, swarm SITL (10 drones), zones/permits/flights with Postgres, desktop
auto-update, 7 vision modules — **including `crowd_manager.py` (268 lines)
and `plate_tracker.py` (410 lines), both registered in `__registry__.py`**.

Planned, not built: `air_unit_srt` (SRT uplink + local WebCodecs preview).
See `ROADMAP.md` and `~/.claude/plans/hyrak-srt-video-rearchitecture.md`.

## Known issues

See `KNOWN_ISSUES.md`. Highest priority: a client's SITL connect hangs on
"connecting" — partially fixed in desktop 0.1.4 (loopback-bind fix), **root
cause not fully confirmed**.

## Important commands

```bash
./start.sh                              # backend + frontend (NO backend auto-reload)
cd frontend && npm run dev              # hot-reloads for browser AND desktop users
cd desktop && npm run deploy:local      # REQUIRES a package.json version bump first
cd backend && python3 -m py_compile app/**/*.py
cd frontend && node ./node_modules/typescript/bin/tsc --noEmit
```

## Never change without understanding

- `communication/` — read-only reference for the RF ground station.
- The low-latency ffmpeg option block (`-fflags nobuffer -flags low_delay
  -max_delay 100000 -reorder_queue_size 0`) in `udp_video_source.py` and
  `airUnitVideoBridge.ts`. It exists to fix a real ~1s lag bug. Keep both
  copies in sync.
- `relay.subscribe(track, buffered=False)` — the buffered default caused
  unbounded latency creep to 1s+.
- aiortc bitrate ceiling overrides in `webrtc/__init__.py`.
- `_sort_relay_urls` in `signaling.py` — aiortc uses only the FIRST turn url;
  TLS/TCP must come first or UDP-blocked networks break.
- Unique gRPC port per MAVSDK `System()` — sharing 50051 makes all drones
  mirror one vehicle.
- The socket.io shared secret (`NEXT_PUBLIC_SECRET_TOKEN` /
  `secret_token`). **Never print its value.**

## Recommended reading order

1. This file → `CURRENT_STATE.md` → `SESSION_HANDOVER.md`
2. `docs/video-transport-modes.md` for anything video
3. `docs/ADR/` for why things are the way they are
4. Relevant `modules/<name>/` docs
5. Source only after the above

## Current priorities

1. Confirm the SITL connect root cause (needs client environment info).
2. Decide the SRT port handshake and verify WebCodecs HEVC support.
3. Commit the large untracked surface — `desktop/`, `docs/`, `releases/`,
   `communication/`, and the crowd/plate modules are all untracked.

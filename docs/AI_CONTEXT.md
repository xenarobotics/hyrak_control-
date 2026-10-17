# AI_CONTEXT - read this first

Single-file orientation for an AI or engineer picking up **hyrak_control**.
Everything here is reverse-engineered from the code, which is the source of
truth. Anything unconfirmed is marked **Needs verification.** Updated
2026-10-18. The standing rules for AI sessions are in the root `CLAUDE.md`.

## Project summary

HYRAK (package name `verocore-backend`) is a **cloud drone platform where
the cloud is the drone's companion computer**. An operator's browser or
Electron desktop app relays video and MAVLink telemetry from their own
machine to a central server, which runs AI vision (detection, tracking,
depth, crowd, ANPR, traffic, 3D scan), obstacle avoidance, mission planning,
deliveries and fleet control, and sends commands back down the same link.

The defining constraint: **the server owns no hardware.** The drone, RF link,
ground decoder and camera are all on the *client's* machine or network.
Clients run modest hardware (Intel i5 + iGPU), so client-side CPU is the
scarcest resource in the system.

Users sign in with roles viewer / operator / admin (`docs/AUTH.md`,
`SECURITY.md`). The backend is on the public internet through a Cloudflare
tunnel (`dev.xenarobotics.com` -> :3000, `api.xenarobotics.com` -> :8001).

## Architecture summary

| Piece | Stack | Role |
|---|---|---|
| `backend/` | Python 3.11, FastAPI 0.143 + uvicorn, python-socketio, aiortc, MAVSDK, PyTorch 2.4.1 | Auth, session state, WebRTC peer, vision inference, telemetry and commands, avoidance, fleet / deliveries, Postgres |
| `frontend/` | Next.js (App Router), React, Zustand, socket.io-client, Cesium / MapLibre / Leaflet | Operator UI: Command, Fly, Mission, Deliveries, Modules, Telemetry, Settings; `/login`, `/admin` |
| `desktop/` | Electron 44.9, TypeScript, electron-builder 26 | Native escape hatch: raw UDP/TCP/serial, ffmpeg / GStreamer, receiver, auto-update |
| `simulation/` | PX4 + Gazebo | `hyrak_sim.sh` single-vehicle demo (udp:14600 on the server), swarm scripts, worlds |
| `communication/` | shell | **READ-ONLY reference.** wfb-ng ground-station scripts. Never modify. |

Two transports run side by side:
- **socket.io over WebSocket (TCP)**: signaling, telemetry, commands, AI results.
- **Video**: WebRTC (SRTP/UDP, Cloudflare TURN over TLS:443 as fallback), or
  zero-transcode relays (SRT / TCP / UDP to the relay listener, DataChannel
  over WebRTC), depending on the source.

**QUIC/HTTP3 is not used anywhere.** Checked and deliberately rejected.

## Folder map

```
hyrak_control/
├── CLAUDE.md, SECURITY.md
├── backend/app/
│   ├── server.py          # create_app(): FastAPI + socket.io wiring, socket auth, resume
│   ├── main.py            # uvicorn entry, reload=True, reload_dirs=["app"]
│   ├── config.py          # pydantic-settings (.env); port 8001
│   ├── auth/              # users, tokens, roles, require_user, socket_guard, CLI
│   ├── api/               # REST routes, /v1 public delivery API, /releases
│   ├── events/            # socket.io handlers: telemetry, swarm, admin, permits, gs-relay
│   ├── sessions/          # SessionManager, DroneSession, AnalysisMode
│   ├── telemetry/         # TelemetryManager (MAVSDK), serial/rf bridges, failsafe check
│   ├── webrtc/            # signaling, stream_track, peer_registry, relay/udp/rtsp/
│   │                      #   datachannel video sources, feeds, mesh_units, wall, turn
│   ├── vision/            # base.py, model_cache.py, worker_pool.py, persistence.py,
│   │   └── modules/       #   9 registered analyzers + __registry__.py
│   ├── avoidance/         # decision core, sensing, executor, routes
│   ├── fleet/, tasks/, planner/   # server fleet, delivery dispatcher, missions
│   ├── flights/, zones/, permits/, registry/, reconstruction/, db/
│   └── latency_probe.py, loop_stall.py
├── backend/alembic/       # 19 revisions, head e4b7a2c9d013
├── frontend/src/
│   ├── app/(platform)/    # command, fly, mission, deliveries, modules, telemetry, settings
│   ├── app/login, app/admin
│   ├── lib/               # socket, auth, api, server-url, nativeBridge, videoSource,
│   │                      #   remoteSitlRelay, localSwarmRelay, localRfRelay, droneId, ...
│   ├── hooks/             # useDrone, useWebRTC, useAuthGate, useClientValue, ...
│   ├── components/        # video, vision, controls, osd, command, mission, avoidance, ...
│   ├── contexts/, store/, types/
├── desktop/src/
│   ├── app-main.ts, main.ts, preload.ts, updater.ts, netProbe.ts, site-url.ts
│   └── bridges/           # 9 bridges + registry, processGuard, annexb
├── simulation/            # hyrak_sim.sh, swarm*.sh, worlds, depth bench
├── sitl_relay/, air_unit_relay/   # optional origin-locked local relays
├── docs/                  # this knowledge base
├── modules/               # per-module docs
└── start.sh               # backend + frontend + tunnel launcher (uv run)
```

## The two process types that define what is possible

- **Electron main process** = full Node.js, **not sandboxed**. Raw UDP
  (`dgram`), child processes (ffmpeg, GStreamer), native modules. All of
  `desktop/src/bridges/` runs here. IPC handlers accept calls only from the
  HYRAK site's origin, and the window cannot navigate away from it.
- **Electron renderer** = Chromium, **identical restrictions to a browser
  tab**. No raw UDP, no RTSP, ever.

So "the browser can't do UDP" and "the desktop app reads UDP" are both true
simultaneously. Sockets live in main; only decoded frames, encoded access
units or relayed bytes cross to the renderer over IPC.

## Data flow (video)

`videoSource` (`frontend/src/lib/videoSource.ts`, catalogue `VIDEO_SOURCES`)
selects one of **ten** sources; see `docs/video-transport-modes.md`:
`camera`, `air_unit_udp`, `siyi_rtsp`, `rtsp_relay`, `rtsp_camera`,
`rtsp_datachannel`, `air_unit_datachannel`, `air_unit_srt`, `air_unit_gst`,
`hyrak_receiver`. Server-sourced modes (`air_unit_udp`, `siyi_rtsp`,
`rtsp_relay`, `air_unit_srt`, `air_unit_gst`, `hyrak_receiver`) send no
browser track; the pilot's preview stays local where the mode allows it.

Server side: any source track -> `MultiModeVideoStreamTrack.recv()`
(`webrtc/stream_track.py`) -> vision analyzer (worker thread, latest frame
wins) -> either an annotated frame re-encoded downlink, or (`clientOverlay`)
`cv_results` JSON only and the browser draws on `CvOverlayCanvas`.

Model weights come from `vision/model_cache.py`: one YOLO / InsightFace /
fast-alpr / DA3 per (kind, weights, device, precision) for the whole
process, refcounted, with per-session tracker state.

## Data flow (telemetry)

`radio/SITL -> client -> socket.io serial_uplink -> SerialBridge (loopback
UDP) -> mavsdk_server -> TelemetryManager -> telemetry_update events`, and
the reverse via `serial_downlink`. One bridge per session. Alternatives: the
`/gs-relay` namespace for a ground-station agent, the desktop UDP bridge for
SITL (udp:14540) and swarms, and "Gazebo sim on server" (backend binds
udp:14600). Every stream subscription retries with backoff; Offboard
tracking has a keepalive that repeats the last setpoint and zeroes after
2 s.

## Conventions

- **Comments explain *why*, densely.** Match this density; do not strip
  these comments. Several encode findings that cost days.
- **No em-dashes** in code, comments, docs or UI text. Use hyphens.
- Backend: snake_case, `logging.getLogger("verocore.<area>")`,
  `db_available()` / `get_session()` guards around DB writes (the DB is
  optional; flying never depends on it). New command socket events start
  with `if not await require_operator(sid, "<event>", data): return`; new
  mutating routes take `Depends(require_operator)` (or admin).
- Frontend: `'use client'`, Zustand with per-field selectors, camelCase,
  localStorage prefs namespaced `hyrak-*`, REST through `apiFetch` /
  `authHeaders` (bearer token), hydration-safe client values via
  `useClientValue` / `useHydrated`.
- Desktop bridges: implement `NativeBridge` (`kind`/`start`/`stop`/`send`),
  register in `bridges/registry.ts`. The IPC surface is generic.
- Failure reporting: **every** connect path must emit a terminal status the
  UI understands (ADR-007).

## Design philosophy

1. **Count the transcodes.** On weak clients, encode/decode passes dominate;
   protocol overhead is noise.
2. **Probe capability at runtime, never trust compile-time flags**, and
   always degrade to a working path (ADR-005).
3. **Multiple transports on purpose.** No single mode works on every
   network (ADR-003).
4. **Latency decoupling.** The pilot's own view should not be routed
   through the server.
5. **The cloud is the companion computer.** Fixes never move control
   onboard or demote it to advisory-only.

## Current implementation status

See `CURRENT_STATE.md`. In short: ten video sources, nine vision modes,
per-user auth, shared model cache, obstacle avoidance (cloud reroute +
Offboard local planner, awaiting SITL validation), deliveries stack, link
resilience, Command tab, desktop 0.1.57 on Electron 44.9.

## Known issues

See `KNOWN_ISSUES.md`. Highest priority: unauthenticated read GETs, a viewer
can start a video stream, and the ground-station relay agent still on the
legacy token.

## Important commands

```bash
./start.sh                              # backend + frontend + tunnel (backend auto-reloads on app/ edits)
./start.sh status | logs backend        # health, one service's log
cd backend && .venv/bin/python -m pytest -q
cd frontend && npx tsc --noEmit -p . && node ./node_modules/eslint/bin/eslint.js src
cd desktop && npx tsc --noEmit -p tsconfig.json
cd desktop && npm run deploy:local      # REQUIRES a package.json version bump first
cd backend && .venv/bin/alembic upgrade head
cd backend && .venv/bin/python -m app.auth.cli create-user <name> --role admin
```

## Never change without understanding

- `communication/`: read-only reference for the RF ground station.
- The low-latency ffmpeg option block (`-fflags nobuffer -flags low_delay
  -max_delay ... -reorder_queue_size 0`), now in several backend and desktop
  files. It fixes a real ~1 s lag bug. Keep the copies in sync.
- `relay.subscribe(track, buffered=False)`: the buffered default caused
  unbounded latency creep.
- aiortc bitrate ceiling overrides in `webrtc/__init__.py`.
- `_sort_relay_urls` in `signaling.py`: aiortc uses only the FIRST TURN url;
  TLS/TCP must come first or UDP-blocked networks break.
- Unique gRPC port per MAVSDK `System()`: sharing 50051 makes all drones
  mirror one vehicle. Fleet GCS sysids are 200+i, never two links on 245.
- `PeerRegistry.remove` owns feed-port and relay release; a superseded
  `PeerEntry` must not release anything.
- Auth tokens and passwords: never print, log or commit them. Credentials
  are the owner's to set.

## Recommended reading order

1. Root `CLAUDE.md` -> this file -> `CURRENT_STATE.md` -> `SESSION_HANDOVER.md`
2. `SECURITY.md` and `docs/AUTH.md` for anything touching routes or events
3. `docs/video-transport-modes.md` for anything video
4. `docs/avoidance/README.md` for avoidance
5. `docs/ADR/` for why things are the way they are
6. Relevant `modules/<name>/` docs, then source

## Current priorities

1. Owner auth setup; Cloudflare Access decision.
2. Close the remaining auth gaps (read GETs, signaling role checks,
   ground-station agent token).
3. Avoidance SITL validation (owner flies).

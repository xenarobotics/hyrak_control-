# PROJECT_OVERVIEW

## What HYRAK is

A cloud drone platform where **the cloud is the drone's companion
computer**. Operators connect their own drone hardware from their own
machines; a central server does the heavy compute (AI vision, obstacle
avoidance, mission planning, fleet and delivery dispatch) and sends the
resulting commands back to the aircraft over the operator's link.

Internal package name: `verocore-backend` (the product name HYRAK came later;
both appear in the code).

## Deployment model

**Confirmed 2026-07-26** - this is load-bearing for every design decision:

- **The server** is a single PC, reachable from the internet through a
  Cloudflare tunnel (`dev.xenarobotics.com` / `api.xenarobotics.com`). **No drone hardware is ever attached to it.**
  It runs the backend, serves desktop releases at `/releases`, and does all
  vision inference. Currently Japesh's laptop, which travels with him.
- **Clients** run the desktop app (or a plain browser, with reduced
  capability) on their own machines, with the RF ground unit / telemetry radio
  / drone attached locally. Typical spec: **Intel i5 + integrated GPU, limited
  CPU headroom.**
- Consequence: everything - video and telemetry - must be relayed from client
  to server. Any design that assumes co-location is dev-only.

## Who uses it

Two distinct audiences, which pulls the UI in two directions:

- **Pilots / engineers** flying custom airframes (see the related PX4 SITL
  work on a mono-coaxial drone and a tandem tilt-wing VTOL).
- **Non-technical surveillance operators** - traffic police and similar - who
  use the AI modes (crowd management, vehicle/plate tracking) and must never
  be shown a network-engineering decision.

## Core capabilities

| Capability | Where |
|---|---|
| Live video streaming (browser camera, RF air unit, RTSP gimbal, ground decoder; 10 sources) | `webrtc/`, `frontend/src/components/video/` |
| AI vision: detection, human/person tracking, depth, enhance, crowd, ANPR, traffic, 3D reconstruction | `vision/modules/` (9 registered), weights shared via `vision/model_cache.py` |
| Login, roles (viewer / operator / admin), bearer tokens | `auth/`, `frontend/src/lib/auth.ts`, `docs/AUTH.md`, `SECURITY.md` |
| Obstacle avoidance (cloud reroute + Offboard local planner) | `avoidance/`, `docs/avoidance/` |
| Mission planner, deliveries board, `/v1` delivery API | `planner/`, `tasks/`, `fleet/`, `api/public.py` |
| Link resilience (LINK LOST watchdog, session resume, failsafe pre-check) | `server.py`, `sessions/`, `telemetry/failsafe_check.py` |
| MAVLink telemetry + commands via MAVSDK | `telemetry/`, `events/telemetry_events.py` |
| Client-side overlay rendering (halves bandwidth) | `CvOverlayCanvas.tsx`, `stream_track.py` |
| Swarm / multi-drone SITL (10 instances) | `localSwarmRelay.ts`, `events/swarm_events.py` |
| Geofence zones, permits, flight recording | `zones/`, `permits/`, `flights/`, Postgres |
| Native sockets, ffmpeg, auto-update | `desktop/src/` |
| TURN relay for UDP-blocking networks | `webrtc/turn.py`, `signaling.py` |

## Technology choices at a glance

- **Video transport:** WebRTC (SRTP/UDP) with Cloudflare TURN TLS:443
  fallback. QUIC/HTTP3 deliberately not used (ADR-002).
- **Signaling/telemetry:** socket.io pinned to the `websocket` transport.
- **Inference:** PyTorch + ultralytics YOLO + ONNX Runtime (insightface,
  fast-alpr). CUDA when present.
- **Persistence:** PostgreSQL via SQLAlchemy + asyncpg, alembic migrations.
- **Desktop:** Electron 44.9, electron-builder 26, electron-updater, generic
  publish provider pointing at `https://api.xenarobotics.com/releases/`.

## Build and run

```bash
./start.sh                            # backend (:8001) + frontend (:3000) + tunnel
cd frontend && npm run dev            # frontend alone, hot-reloads
cd desktop && npm run deploy:local    # build + publish an AppImage to /releases
```

**Deploy discipline (violating this wastes a whole cycle):**
- Frontend changes hot-reload for browser *and* desktop users.
- Backend **auto-reloads** on any edit under `backend/app/`. That restarts
  the companion computer: never edit it while a drone is airborne.
- Desktop changes **require bumping `desktop/package.json` version** before
  `deploy:local`, or electron-updater reports clients as up-to-date.

## Build targets

AppImage (Linux, built and tested), NSIS (Windows, built and shipped since
`air_unit_srt` removed the v4l2loopback dependency), DMG x64+arm64 (macOS,
declared, never built). CI builds all three and deploys from one Linux job.
Code signing is not configured (`SECURITY.md`).

## Related documents

- `../CLAUDE.md` (repo root): rules for AI sessions
- `../SECURITY.md` (repo root): threat model, what is protected, what is open
- `AUTH.md`: login, roles, tokens, bootstrap
- `AI_CONTEXT.md` - start here
- `ARCHITECTURE.md` - component and data-flow detail
- `video-transport-modes.md` - the video mode matrix
- `DATABASE.md` - Postgres schema, retention, and why the DB is optional
- `GROUND_DECODER.md` - Luckfox ground decoder (RF → Ethernet → PC), design
- `PC_VIDEO_TELEMETRY_INTEGRATION.md` - what the built decoder emits
- `HYRAK_RECEIVER.md` - the app's consumer for it (`hyrak_receiver` mode)
- `CURRENT_STATE.md`, `KNOWN_ISSUES.md`, `ROADMAP.md`
- `ADR/` - decision records

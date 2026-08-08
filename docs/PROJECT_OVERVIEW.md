# PROJECT_OVERVIEW

## What HYRAK is

A cloud-hosted drone ground-control and AI-vision platform. Operators connect
their own drone hardware from their own machines; a central server does the
heavy compute and AI inference.

Internal package name: `verocore-backend` (the product name HYRAK came later;
both appear in the code).

## Deployment model

**Confirmed 2026-07-26** — this is load-bearing for every design decision:

- **The server** is a single PC. **No drone hardware is ever attached to it.**
  It runs the backend, serves desktop releases at `/releases`, and does all
  vision inference. Currently Japesh's laptop, which travels with him.
- **Clients** run the desktop app (or a plain browser, with reduced
  capability) on their own machines, with the RF ground unit / telemetry radio
  / drone attached locally. Typical spec: **Intel i5 + integrated GPU, limited
  CPU headroom.**
- Consequence: everything — video and telemetry — must be relayed from client
  to server. Any design that assumes co-location is dev-only.

## Who uses it

Two distinct audiences, which pulls the UI in two directions:

- **Pilots / engineers** flying custom airframes (see the related PX4 SITL
  work on a mono-coaxial drone and a tandem tilt-wing VTOL).
- **Non-technical surveillance operators** — traffic police and similar — who
  use the AI modes (crowd management, vehicle/plate tracking) and must never
  be shown a network-engineering decision.

## Core capabilities

| Capability | Where |
|---|---|
| Live video streaming (browser camera, RF air unit, RTSP gimbal) | `webrtc/`, `frontend/src/components/video/` |
| AI vision: detection, human/person tracking, depth, enhance, crowd, ANPR | `vision/modules/` (7 registered) |
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
- **Desktop:** Electron 32, electron-builder, electron-updater, generic
  publish provider pointing at `https://api.xenarobotics.com/releases/`.

## Build and run

```bash
./start.sh                            # backend (:8001) + frontend (:3000)
cd frontend && npm run dev            # frontend alone, hot-reloads
cd desktop && npm run deploy:local    # build + publish an AppImage to /releases
```

**Deploy discipline (violating this wastes a whole cycle):**
- Frontend changes hot-reload for browser *and* desktop users.
- Backend has **no auto-reload for practical purposes** — it must be
  restarted (`Ctrl+C` then `./start.sh`).
- Desktop changes **require bumping `desktop/package.json` version** before
  `deploy:local`, or electron-updater reports clients as up-to-date.

## Build targets

AppImage (Linux, built and tested), NSIS (Windows, declared, **not yet
built** — blocked by v4l2loopback in the video path until `air_unit_srt`
lands), DMG x64+arm64 (macOS, declared, same blocker). Code signing is not
configured.

## Related documents

- `AI_CONTEXT.md` — start here
- `ARCHITECTURE.md` — component and data-flow detail
- `video-transport-modes.md` — the video mode matrix
- `DATABASE.md` — Postgres schema, retention, and why the DB is optional
- `GROUND_DECODER.md` — Luckfox ground decoder (RF → Ethernet → PC), design
- `PC_VIDEO_TELEMETRY_INTEGRATION.md` — what the built decoder emits
- `HYRAK_RECEIVER.md` — the app's consumer for it (`hyrak_receiver` mode)
- `CURRENT_STATE.md`, `KNOWN_ISSUES.md`, `ROADMAP.md`
- `ADR/` — decision records

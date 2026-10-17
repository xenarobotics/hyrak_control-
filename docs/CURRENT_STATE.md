# CURRENT_STATE

Last updated: **2026-10-18**. Branch: `vision/tracking-overhaul` (all six
audit fix streams merged). Desktop version: **0.1.57** (Electron 44.9).
Backend package `verocore-backend` 0.1.0. Alembic head: `e4b7a2c9d013`
(19 revisions, 22 tables).

Source of truth for open defects: `docs/AUDIT_2026-10-17.md`. This file is
the summary.

## Completed

- **Per-user login** (2026-10-17): users with roles viewer / operator /
  admin, bearer tokens (stored as SHA-256), scrypt passwords, socket auth at
  connect, one `require_operator` guard on every command event,
  `require_user(min_role)` on every mutating route, resume bound to user +
  per-session secret, login rate limits, trusted-proxy client IP, security
  headers, `hyrak.audit` log. The shared `SECRET_TOKEN` is off by default.
  See `docs/AUTH.md` and `SECURITY.md`.
- **Process-wide model cache** (`backend/app/vision/model_cache.py`):
  YOLO, InsightFace, fast-alpr and DA3 weights are shared across sessions
  with refcounts and a 60 s idle grace. One DA3 serves depth sessions and the
  avoidance camera (measured 2680 MB -> 1340 MB torch-allocated). Tracker
  state stays per session.
- **Vision pipeline hardening**: per-client state lock between socket
  setters and the worker thread, awaited stop, `torch.cuda.empty_cache` off
  the loop, warm-up at each mode's real width, bounded id sets, one evidence
  pair per vehicle, frame caches cleared on mode change, failing analyzers
  reported instead of looping tracebacks.
- **WebRTC**: feed port and relay ownership live on the `PeerEntry`, so a
  re-offer no longer blacks out the new connection; every offer failure
  answers with `error`; unbuffered feed proxies; relay ingest lock no longer
  blocks the event loop; SRT relay listeners require a per-allocation
  passphrase.
- **Telemetry / fleet**: fleet `in_air` subscribed (and derived from
  altitude as a backstop), every telemetry stream retried with backoff,
  Offboard keepalive (re-sends the last tracker setpoint at 10 Hz, zeroes
  after 2 s of silence), COMMAND_LONG targets the real autopilot sysid,
  per-instance fleet connect lock, NaN-safe fleet status, swarm relay bridge
  follows the session across resume, browser connect never stops the server
  fleet's manager, recorder arm race closed.
- **Frontend**: separate VIDEO stream status vs CLOUD (socket) status, login
  page and auth gate, bearer headers everywhere (no token in the bundle),
  ESLint 199 errors -> 0 (30 warnings), lazy camera scan, shared drone-id
  resolver with back-off, typed `cv_results`, runtime API override
  (`window.__HYRAK_API__`).
- **Desktop**: Electron 32 -> 44.9, electron-builder 26, IPC sender-origin
  checks and navigation lock, differential updates on, build-time site URL,
  scoped ffmpeg reaping. CI deploys all three installers from one Linux job,
  actions pinned by SHA.
- **Scripts**: `start.sh` and `simulation/hyrak_sim.sh` kill only the PIDs
  they recorded and report foreign port holders; logs rotate at 5 MB;
  `swarm.sh stop` is PID-scoped; `scripts/prune-releases.sh` (dry run by
  default).
- **Dependencies**: fastapi 0.143, starlette 1.8, uvicorn 0.54, Pillow 12.3,
  transformers 4.57. torch 2.4.1 deliberately unchanged.
- **Earlier and still current** (August-September): 10 video sources
  including `air_unit_srt`, `air_unit_gst`, DataChannel modes and
  `hyrak_receiver` (ground decoder); 9 vision modes (object detection, human
  tracking, depth, person tracking, enhance, crowd, vehicle/plate, traffic,
  3D reconstruction); obstacle avoidance (cloud reroute + grid / Offboard
  local planner, depth-camera truth sensor, mono calibration); deliveries
  stack (planner, orders, `/deliveries` board, `/v1` API); Command tab;
  link resilience (LINK LOST watchdog, 90 s session resume, PX4 failsafe
  pre-check); latency probe; mesh camera wall; Postgres layer with zones,
  permits, flights, face gallery, missions, tasks, avoidance events.

## In Progress

- **Owner setup for auth** (not code): `alembic upgrade head`, create the
  first admin, remove `NEXT_PUBLIC_SECRET_TOKEN` from
  `frontend/.env.local`. Steps in `SECURITY.md`.
- **Avoidance closed-loop results**: the perception redesign (grid +
  Offboard local planner) waits on the owner's SITL flights.

## Blocked

| Item | Blocker |
|---|---|
| Code signing | No certificates / CSC secrets |
| CI deploy | `DEPLOY_*` secrets not configured |
| `.deb` packaging | On hold (deliberate) |
| User-uploaded models | Design open (`docs/custom_models/DESIGN.md`); needs the torch upgrade or a sandboxed loader first |
| Real-flight latency number | Needs a real flight with the latency probe on |

## Known Bugs

See `KNOWN_ISSUES.md`. Summary:

1. Many read-only GET routes are still unauthenticated (positions, plate and
   face history, reports).
2. A viewer can start a video stream (signaling events have no role check).
3. TCP / UDP relay transports accept any sender on the allocated port.
4. Recording in client-overlay mode captures video without boxes.
5. Mono depth stays advisory until calibrated error is below 15 %.

## Technical Debt

- torch 2.4.1 (`torch.load` advisory) held back for DA3 / ultralytics /
  aiortc compatibility.
- Duplicated ffmpeg low-latency option block (seven files, no drift test).
- Duplicated mode-switch / attach logic in `modules/page.tsx` and
  `command/AiPanel.tsx` (audit F30).
- Capture-time latency: `submit_frame(captured_at=, source_latency_s=)`
  exists, but the stream track does not yet stamp frames at capture.
- Repo-root clutter (untracked): vendored upstream trees, `communication/`,
  `reconstruction/` data, `frontend/home`, `air_unit_relay.zip`, `logs/`, a
  `.env.bak.*` file; `releases/` is 13 GB until `prune-releases.sh --apply`
  is run.
- `gs_relay_agent.py` (ground-station relay script, not in this repo) still
  sends the legacy shared token.

## Immediate Next Tasks

1. Owner: auth setup (above), then decide whether to put Cloudflare Access
   in front of the tunnel.
2. Put the remaining read GETs behind `require_viewer`; add role checks to
   the signaling events.
3. Move the ground-station relay agent to a bearer token.
4. Run `scripts/prune-releases.sh --apply`; delete `.env.bak.*`.
5. SITL flights for the avoidance local planner (owner).

## Long-term Goals

- Custom user models (sandboxed sidecar runner, action catalogue).
- Transport auto-probe with a visible "which path is live" status.
- Zones / identity / multi-tenant.
- Signed installers on all three platforms.
- Measured concurrent-session capacity.

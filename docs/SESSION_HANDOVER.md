# SESSION_HANDOVER

Written 2026-10-18. Read after the root `CLAUDE.md`, `AI_CONTEXT.md` and
`CURRENT_STATE.md`.

## Current objective

The 2026-10-17 audit fix pass is merged. What is left is mostly the owner's
setup and the security gaps the pass did not close:

1. **Owner auth setup** (not code): migrate, create the first admin, remove
   `NEXT_PUBLIC_SECRET_TOKEN` from `frontend/.env.local`. Steps in
   `SECURITY.md`. Until the first admin exists nobody can sign in.
2. **Close the remaining auth gaps**: role checks on the read GETs and the
   video signaling events; the ground-station relay agent on a bearer token.
3. **Avoidance SITL validation**: the grid + Offboard local planner waits on
   the owner's flights.

## Current branch

`vision/tracking-overhaul`. All six fix streams (auth, vision, webrtc,
frontend, telemetry, infra) merged; last code commit `2884009` (dependency
upgrades). Not pushed by the doc session.

## Implementation status

### Finished in the 2026-10-17/18 pass

See `CHANGELOG.md` (2026-10-18) for the full list. Headlines:

- Per-user login, roles, bearer tokens, socket auth, resume bound to user +
  secret (`backend/app/auth/`, `docs/AUTH.md`).
- Process-wide model cache (`backend/app/vision/model_cache.py`).
- WebRTC peer ownership on re-offer; every offer failure answers.
- Fleet `in_air`, retrying telemetry subscriptions, Offboard keepalive
  (re-sends the last setpoint, zeroes after 2 s), real target sysid.
- Frontend VIDEO vs CLOUD status, ESLint 0 errors.
- Electron 44.9; `start.sh` / `hyrak_sim.sh` kill only recorded PIDs.
- fastapi 0.143, starlette 1.8, Pillow 12.3, transformers 4.57; torch
  2.4.1 unchanged on purpose.

### Remains

- Items in `KNOWN_ISSUES.md` #13-#19 and the OPEN rows of
  `AUDIT_2026-10-17.md`.
- Capture-time stamping for avoidance latency compensation (API exists).
- Custom models design decisions (`docs/custom_models/DESIGN.md`).

## Important files

| File | Why |
|---|---|
| `backend/app/server.py` | App factory, socket connect / auth / resume, security headers |
| `backend/app/auth/` | Login, tokens, roles, `require_user`, `require_operator` socket guard, CLI |
| `backend/app/events/telemetry_events.py` | Every telemetry connect and command event |
| `backend/app/telemetry/manager.py` | MAVSDK manager, subscriptions with retry, Offboard keepalive |
| `backend/app/webrtc/signaling.py`, `peer_registry.py` | Video source selection, PeerEntry ownership |
| `backend/app/vision/model_cache.py`, `base.py`, `worker_pool.py` | Shared weights, analyzer lifecycle |
| `backend/app/fleet/service.py`, `tasks/dispatcher.py` | Server fleet and delivery dispatch |
| `frontend/src/lib/auth.ts`, `api.ts`, `socket.ts` | Token handling and bearer headers |
| `frontend/src/hooks/useWebRTC.ts`, `useDrone.ts` | Video and telemetry client flows |
| `desktop/src/app-main.ts` | IPC sender checks, navigation lock |
| `start.sh` | Launcher; `uv run` syncs the venv to `uv.lock` |

## Important classes / functions

- `require_user(min_role)` (`auth/deps.py`), `require_operator(sid, event,
  data)` (`auth/socket_guard.py`).
- `SessionManager.resumable(session_id, user_id, secret)`.
- `MultiModeVideoStreamTrack` (`stream_track.py`): the single funnel every
  video source passes through.
- `PeerRegistry.remove`: the only place feed ports and relays are released.
- `TelemetryManager._run_subscription`: the retry wrapper around every
  MAVSDK stream.
- `model_cache.shared_yolo()`, `shared_face_app()`, `shared_alpr()`,
  `depth_models.load_shared()`.

## Known blockers

1. First admin not created yet (owner).
2. Code signing: no certificates.
3. Avoidance closed-loop results: owner's SITL flights.

## Recommended next steps

1. Owner: run the setup in `SECURITY.md`; sign in on the web and the
   desktop app; check that a viewer account gets `forbidden` on commands.
2. `require_viewer` on the read GETs; role check on `offer`,
   `allocate_video_relay`, `datachannel_video_offer`, `wall_offer`.
3. Move `gs_relay_agent.py` to `HYRAK_TOKEN`; keep the legacy flag off.
4. `scripts/prune-releases.sh --apply`; delete `.env.bak.*`.
5. Consider Cloudflare Access in front of the tunnel.

## Recommended files to read first

1. `CLAUDE.md` (root)
2. `docs/AI_CONTEXT.md`
3. `docs/CURRENT_STATE.md`
4. this file
5. `SECURITY.md`, `docs/AUTH.md`
6. `docs/AUDIT_2026-10-17.md` for defect IDs

## Warnings

- **Do not modify `communication/`.**
- **Never print tokens or passwords.** Credentials are the owner's to set.
- **The owner flies all tests.** Never arm, take off or fly.
- **The backend auto-reloads on any `backend/app/` edit**, which reboots
  the companion computer. Check `/api/fleet` and live sessions before
  touching it; never while a drone is airborne.
- **Never pattern-kill `gz sim`, never run `swarm.sh`.** Kill by PID.
- **Desktop changes need a `desktop/package.json` version bump before
  `npm run deploy:local`.**
- **Do not delete the `camera` / v4l2loopback path.** It is the only mode
  that works on UDP-blocking networks (ADR-003).
- Do not strip the dense "why" comments.

## Open questions

1. Cloudflare Access in front of the tunnel: yes or no?
2. Should viewers be able to start a video stream at all?
3. torch upgrade path before custom models ship (DA3 / ultralytics / aiortc
   regression pass needed).
4. Does `air_unit_rtp_relay` ship, or does a short-latency SRT cover LAN?

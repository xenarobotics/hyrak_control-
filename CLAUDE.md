# CLAUDE.md

Orientation and standing rules for AI sessions in this repo. Read this, then
`docs/AI_CONTEXT.md`, then `docs/CURRENT_STATE.md`.

## What this is

HYRAK is a cloud drone platform. The **cloud is the drone's companion
computer**: an operator's browser or Electron desktop app relays the drone's
video and MAVLink telemetry (from the radio / air unit / ground decoder on
their own machine) to this server, which runs vision inference (detection,
tracking, depth, crowd, ANPR, traffic, 3D scan), obstacle avoidance, mission
planning, deliveries and fleet control, and sends commands back down the same
link. The server has no drone hardware attached.

Users sign in (roles viewer / operator / admin, see `docs/AUTH.md` and
`SECURITY.md`). The backend is public through a Cloudflare tunnel
(`dev.xenarobotics.com` -> frontend, `api.xenarobotics.com` -> backend).

## Layout

| Path | What |
|---|---|
| `backend/` | Python 3.11, FastAPI + python-socketio + aiortc + MAVSDK, port 8001. Package `app/`: `server.py` (factory), `main.py` (uvicorn, `reload=True` on `app/`), `auth/`, `api/`, `events/` (socket handlers), `sessions/`, `telemetry/`, `webrtc/`, `vision/` (+ `modules/`, `model_cache.py`), `avoidance/`, `fleet/`, `tasks/`, `planner/`, `flights/`, `zones/`, `permits/`, `reconstruction/`, `db/`. Alembic in `backend/alembic/`. Tests in `backend/tests/`. |
| `frontend/` | Next.js (App Router), React, Zustand, socket.io-client, port 3000. Routes under `src/app/(platform)/`: command, fly, mission, deliveries, modules, telemetry, settings; plus `/login`, `/admin`. |
| `desktop/` | Electron 44 shell that loads the live site and adds 9 native bridges (UDP, TCP, serial, RTSP, ffmpeg/GStreamer video, receiver). See `desktop/README.md`. |
| `simulation/` | PX4 + Gazebo launchers (`hyrak_sim.sh`, `swarm*.sh`), worlds, depth bench. |
| `sitl_relay/`, `air_unit_relay/` | Optional local WebSocket relays (origin-locked). |
| `docs/` | Knowledge base. `AI_CONTEXT.md`, `CURRENT_STATE.md`, `KNOWN_ISSUES.md`, `ROADMAP.md`, `AUTH.md`, `DATABASE.md`, `CHANGELOG.md`, `ADR/`, `avoidance/`. |
| `modules/` | Per-module deep docs (desktop bridges, webrtc, telemetry, frontend transport). |
| `start.sh` | Launcher: backend + frontend + tunnel, kills only its own recorded PIDs. |
| `communication/` | Read-only RF ground-station reference. Do not modify. |

## Checks

```bash
# backend (from backend/)
.venv/bin/python -m pytest -q

# frontend (from frontend/)
npx tsc --noEmit -p .
node ./node_modules/eslint/bin/eslint.js src      # 0 errors expected

# desktop (from desktop/)
npx tsc --noEmit -p tsconfig.json
```

## Standing rules

**Writing**
- No em-dashes anywhere: code, comments, docs, UI strings, commit messages.
  Use a plain hyphen.

**Flight safety**
- The owner flies all tests. Never arm, take off or fly a vehicle, real or
  simulated, and do not write throwaway flight scripts.
- Never edit `backend/app/` while a drone is airborne. The backend
  auto-reloads on any change there, which is a companion-computer reboot
  mid-flight. Check `/api/fleet` and the live sessions first.
- The cloud is the companion computer. Never "fix" something by moving
  control onboard or by demoting it to advisory-only.

**Processes**
- Never pattern-kill `gz sim` and never run `swarm.sh`. Kill by PID only.
- Never `pgrep -f` / `pkill -f` a pattern that also appears in your own
  command line (it matches your own shell and kills it).
- Wrap `ss -ltnp` in `timeout` (`timeout 5 ss -ltnp`); `ss -p` can hang.
- Keep udp 5601-5603 free (mesh video units) and send no bitrate commands to
  mesh units.

**Environment**
- Never symlink `backend/.venv` into a git worktree; `uv run` re-points the
  shared editable install at the worktree.
- `start.sh` runs the backend with `uv run`, which syncs the venv to
  `uv.lock`. Dependency changes go into `pyproject.toml` and `uv.lock`, never
  a bare `pip install`.
- Never merge the "SITL" (desktop relay, udp:14540) and "Gazebo sim on
  server" (udp:14600) telemetry link options. They are separate on purpose.

**Ownership**
- Credentials are the owner's to set. Never generate, print or commit real
  tokens, passwords or keys; never edit `.env` / `frontend/.env.local` values.
- Don't build or deploy every iteration. Build the desktop app or redeploy
  only when asked or for a major update (desktop deploys need a
  `desktop/package.json` version bump first).

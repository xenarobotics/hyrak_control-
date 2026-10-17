# Security

HYRAK flies real aircraft from a server that is reachable from the internet.
This file says who can reach what, what stops them, what is still open, and
how to set up and report. Detail on the login model lives in `docs/AUTH.md`;
the audit that drove the current design is `docs/AUDIT_2026-10-17.md`.

## Threat model

**What is exposed.** The Cloudflare tunnel publishes two hostnames:

| Hostname | Points at | What it carries |
|---|---|---|
| `dev.xenarobotics.com` | Next.js frontend, `127.0.0.1:3000` | the operator UI (public pages + login) |
| `api.xenarobotics.com` | FastAPI + python-socketio backend, `127.0.0.1:8001` | REST (`/api/*`, `/v1/*`), Socket.IO (telemetry, commands, WebRTC signaling), `/releases` installers |

Outside the tunnel, the relay ingest ports (default 3478-3578, forwarded from
the relay VPS) accept raw SRT/TCP video from the desktop app, and the desktop
app and the optional local relay scripts open local ports on the operator's
own machine.

**What the server controls.** The cloud is the drone's companion computer:
MAVLink commands (arm, takeoff, missions, Offboard velocity setpoints, mode
changes, parameter writes) originate on this backend and travel to the
vehicle through the operator's radio link.

**Worst outcome.** An outsider commanding a drone: arming, taking off,
changing a mission, steering it in Offboard, or writing parameters. Next
after that: injecting video or MAVLink into an operator's session, reading
live positions and client IPs, and pulling the plate / face / crowd data the
vision modes store.

**Who we defend against.** Anyone on the internet who can reach the tunnel
hostnames; any web page an operator happens to open (cross-origin requests to
local relays, navigation inside the desktop shell); a signed-in user trying to
do more than their role allows.

## What is protected, and how

### Login and roles

* Every browser, script and relay agent signs in as a user
  (`POST /api/auth/login`). The old shared `SECRET_TOKEN`, which shipped in
  the public JS bundle, grants nothing by default.
* Roles are ranked `viewer` < `operator` < `admin` and compared by rank.
  * **viewer**: read-only GETs and a socket session (telemetry mirrors,
    video). No command reaches a drone.
  * **operator**: everything that flies or changes vehicle state.
  * **admin**: operator rights plus user management (`/api/auth/users`),
    `GET /api/sessions`, the `/admin` console, zone / permit / API-key writes.
* Passwords are hashed with **scrypt**. The check runs scrypt even for an
  unknown username, and the error text is the same, so timing and messages do
  not reveal whether a name exists.
* Tokens are 32 random bytes; the database stores only their **SHA-256**
  (`auth_tokens.token_hash`), never the token. 30-day expiry that slides on
  use, with a 60 s in-memory cache.
* Disabling a user, changing their password or role, deleting them, or
  revoking their tokens disconnects every live socket they hold at once. Live
  sockets also re-check their token every 60 s.

### Socket events

A socket is refused at connect (`unauthorized`) without a valid token. The
user is stamped on the session, and every command-type event starts with one
`require_operator` line (`backend/app/auth/socket_guard.py`); a viewer gets an
`error` event with `code: "forbidden"`.

Operator-only events include: `connect_telemetry`, `connect_rf_bridge`,
`connect_browser_serial`, `disconnect_telemetry`, `drone_command`,
`drone_action`, `upload_mission`, `set_param`, `set_tracking`,
`set_analysis_mode`, every tracking / follow / altitude / profile setter,
`enrol_person_live`, `request_permit`, and all swarm events
(`connect_swarm_relay`, `swarm_relay_uplink`, `scan_swarm_drones`,
`set_swarm_mode`, `connect_swarm_drone`, `disconnect_swarm_drone`,
`swarm_action`, `swarm_group_action`, `swarm_upload_mission`).

Admin-only: `admin_hello`, `watch_session`.

The ground-station relay namespace (`/gs-relay`) requires an operator token
at connect.

### REST routes

`require_user(min_role)` (`backend/app/auth/deps.py`) guards every mutating
route in `app/api/`, avoidance, reconstruction, the mesh feeds and the
latency probe. `GET /api/sessions` (client IPs and positions), `GET
/api/api-keys` and zone / permit / API-key writes need admin.
`/api/terrain/elevation` needs a signed-in user and caps at 500 points.
Numeric body fields are validated by pydantic. Every accepted mutating
request and command event writes one line to the `hyrak.audit` logger
(user, role, session, event, drone).

### Feed routes

`/api/video/feeds/{port}/hevc` and `/h264` (the mesh unit streams) need an
operator token and only accept ports in the feed range, so they can no
longer be used to spawn unbounded ffmpeg processes.

### Login rate limits and client IP

* Per client IP: 5 failures in 15 minutes lock that address out for the
  window (HTTP 429).
* Per username: exponential backoff after 5 failures (2 s doubling to a 120 s
  cap), one attempt in flight while in backoff, hard cap of 20 attempts per
  window. Deliberately not a hard lock, so an attacker spraying an operator's
  name cannot lock the operator out of their aircraft.
* Attempts are counted before the first await, so concurrent requests cannot
  slip past the limit.
* The client IP is taken from `CF-Connecting-IP` or `X-Forwarded-For` (read
  right to left) **only** when the socket peer is in `TRUSTED_PROXIES`
  (default loopback, where cloudflared runs). Otherwise it is the socket peer.
  A client cannot pick its own IP for rate-limit purposes.

### Session resume

A dropped socket can reclaim its session (drone link, relay, flight record)
only if the **same user** asks and presents the per-session
`resume_secret` (constant-time compare). A session id alone, which shows up
in logs and the admin page, is not enough to take over a drone. Resume
re-stamps the role from the fresh authentication.

### HTTP hardening

`SecurityHeadersMiddleware` (`backend/app/server.py`) sets
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a `Permissions-Policy` that keeps camera,
microphone, serial and USB to the app's own origin. CORS is an explicit
allow-list (`ALLOWED_ORIGINS` plus the LAN origin), never `*`. The frontend
login page validates its `next` redirect (single-slash same-origin path only).

### Video relay ingest

SRT relay listeners are opened with a per-allocation passphrase and
`enforced_encryption=1`, so a caller without it fails the handshake instead
of injecting video into someone's session.

### Desktop app

* The window uses `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`.
* **IPC sender checks**: every native-bridge IPC handler checks that the
  sender frame's origin is the HYRAK site (`isTrustedSender` in
  `desktop/src/app-main.ts`). The bridges drive ffmpeg, raw UDP and serial,
  so no other page may call them.
* **Navigation lock**: the window never leaves the site origin
  (`will-navigate` is cancelled and the URL opened in the system browser);
  popups are denied (`setWindowOpenHandler`).
* Electron is on 44.9 (32 was end-of-life).
* The ffmpeg orphan reaper only touches ffmpeg binaries under this app's own
  install path or a previous HYRAK AppImage mount.

### Local relay scripts

`sitl_relay/swarm_relay.py` and `air_unit_relay/telemetry_relay.py` bind
loopback and accept WebSocket connections only from the HYRAK site and
`localhost:3000` (extend with `HYRAK_ALLOWED_ORIGINS` / `--allow-origin`), so
a random web page cannot inject MAVLink through them. `HYRAK_RELAY_TOKEN`
adds a shared secret as the first message.

### Secrets in git

`.env`, `.env.bak.*` and `frontend/.env.local` are git-ignored; nothing
secret is tracked. `.env.example` lists every setting with its code default
and no real values.

## What is still open

* **Unauthenticated read GETs.** Many GET routes still answer without a
  token: `/api/fleet`, `/api/drones`, `/api/zones`, `/api/missions`,
  `/api/tasks`, `/api/pads`, `/api/permits`, `/api/flights/{id}` and its
  download, the crowd / plate report downloads, `/api/vision/plate-history`
  and its images, the face gallery and sightings, avoidance status / events
  / obstacles, the reconstruction proxies, `/api/video/mesh-units`,
  `/api/video/feeds`, the latency probe stats. Some of this is personal data
  (plates, faces, positions). These should move behind `require_viewer`.
* **A viewer can start a video stream.** The WebRTC signaling events
  (`offer`, `ice_candidate`, `stop_stream`, `allocate_video_relay`,
  `release_video_relay`, `datachannel_video_offer`) and the camera wall
  (`wall_offer`, `wall_close`) have no role check. A viewer cannot command a
  drone with them, but can consume server GPU and relay ports and receive
  video. `fetch_params` / `get_param` and `start_rc_monitor` are also
  unguarded (read-only).
* **TCP / UDP relay transports have no admission control.** Only the SRT
  transport carries a passphrase; a `tcp` or `udp` relay listener accepts
  whoever connects to the allocated port first.
* **`gs_relay_agent.py` still uses the legacy shared token.** The
  ground-station relay agent (a script on the ground-station laptop, not in
  this repo) sends `SECRET_TOKEN`. The backend only accepts that with
  `AUTH_LEGACY_TOKEN_ENABLED=true` (and never the published default). Move the
  agent to an operator's bearer token in `HYRAK_TOKEN`, then keep the flag
  off.
* **torch 2.4.1 and `torch.load`.** torch is deliberately held at 2.4.1
  (DA3 / ultralytics / aiortc compatibility). It carries the `torch.load`
  remote-code advisory (CVE-2025-32434): `weights_only=True` is not a safe
  boundary on that version. Today every checkpoint is one we put on disk.
  This becomes a real hole the moment user-uploaded models exist
  (`docs/custom_models/DESIGN.md`): upgrade torch, or load uploaded weights
  only inside the sandboxed runner, before that feature ships.
* **Unsigned installers.** Windows and macOS builds are not code-signed, and
  electron-updater trusts the sha512 in a manifest served from the same host
  as the installer. Anyone who can write to `releases/` on the server can
  ship code to every desktop client. Keep `releases/` write-restricted until
  signing is configured.
* **Development server on the public hostname.** `./start.sh` serves the
  Next.js dev server through the tunnel unless `--prod` is passed.

## Recommendation: Cloudflare Access in front of the tunnel

The login is the only lock between the internet and the drones. Put
**Cloudflare Access** (Zero Trust) in front of `dev.xenarobotics.com` and
`api.xenarobotics.com` as a second, independent layer: an allow-list of
operator emails (or an identity provider) checked at Cloudflare's edge
before a request reaches this machine. It also covers the unauthenticated
GETs above until they are closed. Use service tokens for non-browser
clients (the desktop app's API calls, `gz_depth_sensor.py`, the
ground-station agent), and leave `/releases` and the `/v1` delivery API on
a bypass policy only if they must stay public.

## Operator setup

Run these on the server after pulling the auth changes. Credentials are the
owner's to choose; none appear in this repo.

1. Create the `users` and `auth_tokens` tables:

   ```bash
   cd ~/hyrak_control/backend
   .venv/bin/alembic upgrade head
   ```

2. Create the first admin (the password is prompted, never passed on the
   command line):

   ```bash
   .venv/bin/python -m app.auth.cli create-user <name> --role admin
   ```

   More users: `create-user` again (`--role operator` or `--role viewer`), or
   `POST /api/auth/users` as an admin. Optional safety net that works with
   Postgres down: `HYRAK_ADMIN_USER` + `HYRAK_ADMIN_PASSWORD_HASH` in `.env`
   (hash from `.venv/bin/python -m app.auth.cli hash-password`); see
   `docs/AUTH.md`.

3. Remove `NEXT_PUBLIC_SECRET_TOKEN` from `frontend/.env.local`. The
   frontend no longer reads it, and anything `NEXT_PUBLIC_*` ends up in the
   public bundle.

4. Leave `AUTH_LEGACY_TOKEN_ENABLED` off unless an external script is
   mid-migration. Scripts (`simulation/gz_depth_sensor.py`, the ground-station
   agent) take an operator's bearer token in `HYRAK_TOKEN`.

5. If cloudflared runs anywhere other than this host's loopback, set
   `TRUSTED_PROXIES` to its address, or every client will share one IP for
   rate-limit purposes.

## Reporting a security issue

Report privately to the repository owner (the GitHub account that owns
`hyrak_control-`), not in a public issue. Include what you found, how to
reproduce it, and whether a vehicle or live session could be affected. Do
not test against a live aircraft or another user's session. Expect an
acknowledgement before any details are shared further.

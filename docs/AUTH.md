# Authentication and roles

Since 2026-10-17 every browser, script and relay agent signs in as a user.
The old shared `SECRET_TOKEN` (which shipped in the public JS bundle as
`NEXT_PUBLIC_SECRET_TOKEN`) no longer grants anything by default. Audit items
B12, I1, F16, B8, B20, B30 in `docs/AUDIT_2026-10-17.md`.

## The model

| thing | where | notes |
|---|---|---|
| user | `users` table | username (unique, lower-case), scrypt password hash, role, disabled flag |
| role | `viewer` < `operator` < `admin` | compared by rank, never by string |
| token | `auth_tokens` table | 32 random bytes (urlsafe), stored as SHA-256 only; 30-day expiry that slides on use; cached in memory for 60 s |
| session | in memory (`DroneSession`) | stamped with `user_id` / `username` / `role` at socket connect, plus a random `resume_secret` |

What each role can do:

* **viewer**: read-only GETs, a socket session (telemetry mirrors, video), nothing that commands a drone. Command events answer with an `error` event `{code: "forbidden"}`.
* **operator**: everything that flies: `drone_action`, `drone_command`, missions, tracking, swarm, avoidance, vision uploads, calibration, mesh feeds, planner edits.
* **admin**: operators' rights plus user management (`/api/auth/users`), `GET /api/sessions`, the `/admin` console (`admin_hello`, `watch_session`), zone / permit / API-key writes.

Every accepted command-type socket event and every accepted mutating route writes one line to the `hyrak.audit` logger:

```
audit user=<name> role=<role> session=<id8> event=<name> drone=<id>
```

## Sending the token

* REST: `Authorization: Bearer <token>`.
* Socket.IO: `auth: {token, resume_session, resume_secret}`. A refused handshake carries the message `unauthorized`; the frontend clears its token and goes to `/login`.
* Frontend: `src/lib/auth.ts` (`login`, `logout`, `getToken`, `getUser`, `authHeaders`, `liveAuthHeaders`) and `src/lib/api.ts` (`apiFetch`, redirects to `/login` on 401). The token lives in `localStorage` under `hyrak-auth-token`. `src/hooks/useAuthGate.ts` keeps the platform layout and `/admin` behind the login; `/` stays public.
* Scripts (`simulation/gz_depth_sensor.py`, `gs_relay_agent.py`): put an operator's bearer token in `HYRAK_TOKEN`. Get one with the login call below or from a signed-in browser's `localStorage`.

```
curl -s -X POST http://localhost:8001/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username": "<name>", "password": "<password>"}'
# -> {"token": "...", "user": {...}, "expires_at": "..."}
```

## Session resume

A socket that drops and comes back sends `resume_session` and `resume_secret`. The server hands the session back only if it still exists, the same `user_id` is asking, and the secret matches (constant-time compare). It no longer matters whether the old socket has been noticed as gone: a client reconnecting inside the ping timeout supersedes its old socket, whose late disconnect is then ignored (audit B8).

## Bootstrapping the first admin

All commands run from `backend/` with the project venv (`.venv/bin/python` or `uv run python`). Passwords are always prompted with `getpass`, never passed on the command line.

**With Postgres up** (the normal path):

```
cd backend
alembic upgrade head                       # creates users + auth_tokens
.venv/bin/python -m app.auth.cli create-user <your-name> --role admin
.venv/bin/python -m app.auth.cli list-users
```

**Without a database**, or as a safety net that works on every start: put an env admin in the repo `.env`:

```
cd backend
.venv/bin/python -m app.auth.cli hash-password     # prompts, prints scrypt$...
```

then in `.env`:

```
HYRAK_ADMIN_USER=<your-name>
HYRAK_ADMIN_PASSWORD_HASH=scrypt$...
```

On startup the backend installs that admin in memory (and in the DB when it is reachable), so sign-in works with Postgres down. If the DB is down and no env admin is set, the log says so in capitals: nobody can log in until one of the two is fixed.

Further users: `create-user` again, or `POST /api/auth/users` as an admin (`{username, password, role}`); `PATCH /api/auth/users/<id>` with `{role?, disabled?, password?}`; `DELETE /api/auth/users/<id>`. Disabling a user or changing a password revokes every token they hold.

## The legacy shared token

`AUTH_LEGACY_TOKEN_ENABLED=true` in `.env` re-admits `X-Auth-Token: <SECRET_TOKEN>` and socket `{token: <SECRET_TOKEN>}` as an **operator** (never admin). Two rules:

1. The published default `dev_token_change_in_production` is refused whatever the flag says, with an error in the log.
2. The flag is off by default. Turn it on only while an external script is being moved to a user token, then turn it off again.

Generate a real value with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.

## Login protection

* 5 failed attempts per username **and** per client IP in 15 minutes lock that name / address out for the window (HTTP 429). Client IP is `CF-Connecting-IP`, then `X-Forwarded-For`, then the socket peer.
* The username / password check runs scrypt even for an unknown user, so timing does not reveal whether a name exists; the error text is the same either way.
* Every success and failure is logged with the IP; passwords are never logged.

## HTTP hardening

`SecurityHeadersMiddleware` (server.py) adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a `Permissions-Policy` that keeps camera / microphone / serial / usb to the app's own origin. CORS stays an explicit allow-list (`ALLOWED_ORIGINS` + the LAN origin), never `*`.

## Files

* `backend/app/auth/passwords.py`: scrypt hash / verify.
* `backend/app/auth/store.py`: `DbStore` (tables) and `MemoryStore` (env admin, tests).
* `backend/app/auth/service.py`: login, verify, cache, rate limit, legacy token, startup bootstrap.
* `backend/app/auth/deps.py`: `require_user(min_role)` FastAPI dependency.
* `backend/app/auth/socket_guard.py`: `require_operator(sid, event, data)` for socket handlers.
* `backend/app/auth/routes.py`: `/api/auth/*`.
* `backend/app/auth/cli.py`: `create-user`, `hash-password`, `list-users`.
* `backend/alembic/versions/e4b7a2c9d013_users_and_auth_tokens.py`.
* `backend/tests/test_auth.py`, plus the `auth_headers` fixture in `tests/conftest.py` for route tests.

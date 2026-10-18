# Authentication and roles

Who may do what is defined in **`docs/ACCESS_MODEL.md`** (workspaces,
scoped roles, invites, zone layers). This document covers sign-in, tokens,
revocation, bootstrap and the CLI. Phase 1 of the access model landed on
2026-10-18 (migration `f6c2a8d4e1b7`).

Since 2026-10-17 every browser, script and relay agent signs in as a user.
The old shared `SECRET_TOKEN` (which shipped in the public JS bundle as
`NEXT_PUBLIC_SECRET_TOKEN`) no longer grants anything by default. Audit items
B12, I1, F16, B8, B20, B30 in `docs/AUDIT_2026-10-17.md`.

## The model

| thing | where | notes |
|---|---|---|
| user | `users` table | username (unique, lower-case, no `@`), email (unique, lower-case, optional for old accounts) with `email_verified`, display name, scrypt password hash, disabled flag, last_login_at. **No role column** |
| membership | `memberships` table | one role on one workspace, optional GeoJSON area and title. See `docs/ACCESS_MODEL.md` section 2 |
| compatibility role | computed | `member` < `viewer` < `operator` < `admin`, derived from memberships (founder -> admin; HYRAK pilot, or manager anywhere while the account is staff -> operator; any other HYRAK membership -> viewer; customer-only -> member). What `require_user(...)` and the staff socket guards compare. Only staff hold viewer and above, so every rank check is a staff-only check |
| token | `auth_tokens` table | 32 random bytes (urlsafe), stored as SHA-256 only; 30-day expiry that slides on use; cached in memory for 60 s together with the user's memberships |
| session | in memory (`DroneSession`) | stamped with `user_id` / `username` / compatibility `role` at socket connect, the session's `workspace_id`, the user's `perms` on it and `is_staff` (phase 2a), plus a random `resume_secret` |

What each compatibility role can do on the live control paths (staff):

* **viewer**: read-only GETs, a socket session (telemetry mirrors, video), nothing that commands a drone. Command events answer with an `error` event `{code: "forbidden"}`.
* **operator**: everything that flies: `drone_action`, `drone_command`, missions, tracking, swarm, avoidance, vision uploads, calibration, mesh feeds, planner edits.
* **admin** (= founder): operators' rights plus `GET /api/sessions`, the `/admin` console (`admin_hello`, `watch_session`), permit / API-key writes and account administration (`/api/auth/users`).

Workspace, member, invite, zone and drone-assignment routes do not use the
rank: they ask the permission engine (`app/auth/perms.py`) with the
caller's memberships.

**Customer sessions (phase 2a, `docs/ACCESS_MODEL.md` 8a).** A
customer-only account (rank `member`) gets a socket session in one of its
workspaces and is checked on its perms there, never on the rank: `view`
for the session's own video, link and params read, `fly` for commands and
the session's AI pipeline, plus `fly` on the drone's own workspace for
anything that acts on the vehicle. Every socket event is classified in
`app/auth/socket_classes.py`; everything not listed as a session event is
staff only. On REST a customer reaches only the account, workspace, zone
and audit routes (which check workspace permissions), `GET /api/zones`,
`/api/zones/check`, `/api/vision/calibration`, `/api/terrain/elevation`,
`/api/webrtc/ice-servers`, and the crowd / plate reports of their own
sessions. The socket error codes a client must handle: connect refused
with `unauthorized` (sign in again) or `no_workspace_access` (pick another
workspace); `error` events with `code` `forbidden`, `drone_not_in_workspace`,
`drone_unidentified` or `access_unverified` (staff too: the 60 s re-check
did not complete within 5 s; commands wait, hold / return / land and the
session's own video and link do not).

Every accepted command-type socket event and every accepted mutating route writes one line to the `hyrak.audit` logger:

```
audit user=<name> role=<role> session=<id8> event=<name> drone=<id>
```

Access and airspace changes (memberships, invites, workspaces, zones, drone
assignment, accounts) are also stored as rows in `audit_events` with the
actor and client IP, readable through `GET /api/audit`.

## Sending the token

* REST: `Authorization: Bearer <token>`.
* Socket.IO: `auth: {token, resume_session, resume_secret}`. A refused handshake carries the message `unauthorized`; the frontend clears its token and goes to `/login`.
* Frontend: `src/lib/auth.ts` (`login`, `logout`, `getToken`, `getUser`, `authHeaders`, `liveAuthHeaders`) and `src/lib/api.ts` (`apiFetch`, redirects to `/login` on 401). The token lives in `localStorage` under `hyrak-auth-token`. `src/hooks/useAuthGate.ts` keeps the platform layout and `/admin` behind the login; `/` stays public.
* Scripts (`simulation/gz_depth_sensor.py`, `gs_relay_agent.py`): put an operator's bearer token in `HYRAK_TOKEN`. Get one with the login call below or from a signed-in browser's `localStorage`.

```
curl -s -X POST http://localhost:8001/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"login": "<username or email>", "password": "<password>"}'
# -> {"token": "...", "user": {...}, "expires_at": "..."}
```

`username` is still accepted as an alias of `login`. Signing in by email
works only for a **verified** email; otherwise use the username.

### Verified emails

With no outgoing email in phase 1, an address someone types is only a
claim. `email_verified` becomes true only when the account was created by
accepting an email-locked invite with exactly that address (the inviter
sent the link to it), or when a founder (or the CLI) sets the address
(`PATCH /api/auth/users/{id}` with `email`, `POST /api/auth/users`,
`create-user --email`). Users cannot change their own email yet
(`PATCH /api/auth/me` with `email` is 400); self-service change returns
with verification links. Only verified addresses resolve in lookups:
sign-in by email, adding a member by email, and email-locked invites (a
signed-in account must hold the locked address verified; a signed-out
sign-up must use the locked address). The full account API
(profile, password change, devices, invites, reset links) is in
`docs/ACCESS_MODEL.md` section 7 and its phase 1 notes.

## Revocation on live sockets

The role stamped on a session at connect is not trusted forever. The socket guard re-checks the session's token hash every 60 s (through the service's cache, so it costs nothing in the common case) and refreshes the compatibility role, the perms on the session's workspace and the session's drone access; a token that no longer verifies, or a customer who lost `view` on the session's workspace, disconnects the socket. These disconnect every live socket of the user immediately (the session is parked like any other drop; a still-valid token resumes it with the fresh role, a revoked one cannot):

* revoking tokens, disabling, deleting, changing or resetting the password (all other devices are signed out; a password change keeps the current one);
* a membership change that removes a membership, changes its role or area, or moves the user's compatibility role. Adding a membership or editing only a title just drops the cached token entry, so the next request sees it.

Resume always re-stamps the role and perms from the freshly authenticated user.

**Changes made from the CLI** (`create-user`, `grant`, `grant --remove`)
run in their own process, so they cannot drop the running server's token
cache or reach its sockets; cross-process invalidation (Redis or Postgres
LISTEN/NOTIFY) is planned work. The server still applies them within one
`TOKEN_CACHE_S` (60 s): the cached entry expires, the next request reloads
the user and memberships from the database, and a live socket's next
revalidation (also every 60 s) refreshes its compatibility role, or
disconnects it when its token is gone (re-running `create-user` replaces
the password and deletes the account's tokens). The CLI prints a one-line
note saying so after every such change. The same change made through the
API applies immediately.

## Failing closed

With the database up, a user or membership query that errors is a refusal (sign-in answers 503), never a fall-back to the memory store's copy of an account the database knows about: that copy could predate a disable or demotion. A token whose user cannot be read is served only from a cache entry the database itself produced moments ago, as before. With the database down, durable writes (workspaces, memberships, invites, accounts, zones) answer 503 instead of landing in memory and vanishing on restart.

## Session resume

A socket that drops and comes back sends `resume_session` and `resume_secret`. The server hands the session back only if it still exists, the same `user_id` is asking, and the secret matches (constant-time compare). It no longer matters whether the old socket has been noticed as gone: a client reconnecting inside the ping timeout supersedes its old socket, whose late disconnect is then ignored (audit B8).

A session also belongs to one workspace for its whole life: a resume that
names a different `workspace_id` gets a fresh session (the old one is
parked and expires as usual), and omitting `workspace_id` keeps the
session's own. The user's access to that workspace is re-checked on every
resume, so a customer who lost `view` cannot reclaim the session.

## Bootstrapping the first founder

All commands run from `backend/` with the project venv (`.venv/bin/python`). Passwords are always prompted with `getpass`, never passed on the command line, and must be at least 10 characters.

**With Postgres up** (the normal path):

```
cd backend
alembic upgrade head                       # users, auth_tokens, workspaces, memberships, ...
.venv/bin/python -m app.auth.cli create-user <your-name> --founder --email you@example.com
.venv/bin/python -m app.auth.cli list-users
```

`--role admin|operator|viewer` still works as an alias: it sets the user's
membership on the HYRAK workspace (admin -> founder, operator -> HYRAK
pilot, viewer -> HYRAK viewer), so `create-user <name> --role admin` is
the same as `--founder`. Re-running `create-user` for an existing name
replaces the password (and a given email / display name) and never
re-enables a disabled account.

Other CLI commands:

```
.venv/bin/python -m app.auth.cli grant <username|email> <workspace-id|hyrak> <role> [--title "..."] [--area-file area.geojson]
.venv/bin/python -m app.auth.cli grant <username|email> <workspace-id|hyrak> --remove
.venv/bin/python -m app.auth.cli list-users          # accounts, compatibility role, every membership
.venv/bin/python -m app.auth.cli hash-password
```

`grant` is the owner's tool and bypasses the API grant rules (it can make
managers and airspace managers; airspace needs `--area-file`). It refuses
to remove the last founder.

**Without a database**, or as a safety net that works on every start: put an env founder in the repo `.env`:

```
cd backend
.venv/bin/python -m app.auth.cli hash-password     # prompts, prints scrypt$...
```

then in `.env`:

```
HYRAK_ADMIN_USER=<your-name>
HYRAK_ADMIN_PASSWORD_HASH=scrypt$...
```

On startup the backend installs that account as a founder in memory (and in the DB, with a founder membership on HYRAK, when it is reachable), so sign-in works when Postgres was unreachable at startup. A founder disabled through the API stays disabled. If the DB is down and no env founder is set, the log says so in capitals: nobody can log in until one of the two is fixed.

Further accounts normally come from **invite links** (`POST /api/workspaces/<id>/invites`, see `docs/ACCESS_MODEL.md`). Founders can also use `POST /api/auth/users` (`{username, password, role, email?, display_name?}`, `role` in the compatibility vocabulary), `PATCH /api/auth/users/<id>` with `{disabled?, display_name?, password?}` (a `role` is refused with 400: change memberships instead), `DELETE /api/auth/users/<id>` (not yourself, not the last founder) and `POST /api/auth/users/<id>/reset-link` (one hour, single use). Disabling a user, setting or resetting a password revokes every token they hold.

**Migrating an existing database**: `alembic upgrade head` creates the HYRAK platform workspace, turns admin / operator / viewer into founder / HYRAK pilot / HYRAK viewer memberships, makes every zone regulatory on HYRAK and assigns every drone to HYRAK. Deploy the code and the migration together: the new code reads `users.email` and `memberships`, and against the old schema every DB account fails closed (only the env founder can sign in). `alembic downgrade e4b7a2c9d013` restores `users.role` with the compatibility mapping.

## The legacy shared token

`AUTH_LEGACY_TOKEN_ENABLED=true` in `.env` re-admits `X-Auth-Token: <SECRET_TOKEN>` and socket `{token: <SECRET_TOKEN>}` as an **operator** (never admin) with no memberships: it flies, but owns no workspace and can change no access. Two rules:

1. The published default `dev_token_change_in_production` is refused whatever the flag says, with an error in the log.
2. The flag is off by default. Turn it on only while an external script is being moved to a user token, then turn it off again.

Generate a real value with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.

## Login protection

* Per client IP: 5 failures in 15 minutes lock that address out for the window (HTTP 429).
* Per account: each attempt is reserved, before the first await, under the login string as typed (username or email), and once the account resolves also under a canonical per-account key (`uid:<id>`), so alternating an account's username and email does not double the guess budget. A success clears both. After 5 failures each further attempt must wait an exponentially growing delay (2 s, 4 s, 8 s ... capped at 120 s), reset by a success or 15 minutes of quiet, with at most one attempt in flight while in backoff and a hard cap of 20 attempts per username per window. Attempts are counted before the first await, so concurrent requests cannot slip past the limit. Deliberately not a hard lock: an attacker spraying a known operator name from many addresses must not lock the operator out of their aircraft.
* Client IP is `CF-Connecting-IP`, then `X-Forwarded-For` read right to left (the first entry that is not a trusted proxy), but only when the socket peer is in `TRUSTED_PROXIES` (default loopback, where cloudflared runs); otherwise the socket peer itself.
* The username / password check runs scrypt even for an unknown user, so timing does not reveal whether a name exists; the error text is the same either way.
* Every success and failure is logged with the IP; passwords are never logged.
* A password change counts a wrong current password against the same canonical per-account limit as sign-in, so a stolen token cannot be used to brute-force the password.
* Invite preview / accept and reset links: 5 bad tokens per IP per 15 minutes, in buckets of their own (a mistyped invite link does not lock the address out of signing in). The tokens are 32 random bytes, so this is defence in depth.

## HTTP hardening

`SecurityHeadersMiddleware` (server.py) adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a `Permissions-Policy` that keeps camera / microphone / serial / usb to the app's own origin. CORS stays an explicit allow-list (`ALLOWED_ORIGINS` + the LAN origin), never `*`.

## Files

* `backend/app/auth/passwords.py`: scrypt hash / verify, minimum length 10.
* `backend/app/auth/perms.py`: the pure permission engine (role matrix, inheritance, area checks, grant rules, compatibility role).
* `backend/app/auth/store.py`: `DbStore` (tables) and `MemoryStore` (platform workspace, env founder, tests).
* `backend/app/auth/service.py`: login, verify, cache, rate limits, legacy token, account self-service, reset links, startup bootstrap.
* `backend/app/auth/deps.py`: `require_user(min_role)`, `require_founder`, `optional_user` FastAPI dependencies.
* `backend/app/auth/socket_guard.py`: `require_session_view`, `require_session_fly` (customer-reachable events), `require_operator`, `require_admin`, `require_staff` (staff only) for socket handlers.
* `backend/app/auth/socket_classes.py`: the classification of every socket event, drone events, the hold / return / land safety actions, customer-blocked video sources and AI modes.
* `backend/app/auth/live_scope.py`: the session's workspace and perms at connect and revalidation, the drone claim, drone access.
* `backend/app/auth/routes.py`: `/api/auth/*`.
* `backend/app/auth/audit.py`: `hyrak.audit` lines and `audit_events` rows.
* `backend/app/auth/cli.py`: `create-user`, `grant`, `list-users`, `hash-password`.
* `backend/app/workspaces/`: workspaces, members, invites, drone assignment, zone layer rules, staff and audit routes.
* `backend/alembic/versions/e4b7a2c9d013_users_and_auth_tokens.py`, `backend/alembic/versions/f6c2a8d4e1b7_workspaces_memberships_invites.py`.
* `backend/tests/test_auth.py`, `test_perms.py`, `test_workspaces.py`, `test_live_scope.py`, `test_socket_classes.py`, `test_auth_dbstore.py` (opt-in: `HYRAK_TEST_DATABASE_URL` pointing at a disposable migrated database), plus the `auth_headers` fixture in `tests/conftest.py` for route tests.

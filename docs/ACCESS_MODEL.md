# Access model: workspaces, roles, portals

Status: design agreed 2026-10-18; phase 1 backend built on `feat/workspaces` (see "Phase 1 as built" in section 7); phase 2a backend built on `feat/live-scope` (see "Phase 2a as built" in section 8a); phase 2b stream A (customer missions and permits) built on `feat/2b-missions` (section 8b).
Supersedes the flat viewer / operator / admin model in `docs/AUTH.md`
(login, tokens, rate limits and revocation from that document stay as they are).

## 1. The hierarchy

Everything a customer owns lives in a **workspace**. Workspaces form a tree
with HYRAK at the root.

```
HYRAK                              platform   (exactly one, the root)
├── IITH                           organization
│   ├── Civil Engineering Dept     client     (a customer of IITH)
│   └── Campus Security            client
├── SkyServe Pvt Ltd               organization (a drone-service company)
│   ├── Client X                   client
│   └── Client Y                   client
└── A. Kumar                       individual (one person flying their own drones)
```

| kind | parent | can have children | who it is for |
|---|---|---|---|
| platform | none | organizations, individuals | HYRAK itself. Holds HYRAK's own drones |
| organization | platform | clients | Institutions and companies, incl. service companies that run drones for their own customers |
| individual | platform | none | One person. Can be converted to an organization later without moving data |
| client | organization | none | A customer of an organization |

A **person** has exactly one account (email + password today, Google later)
and can belong to any number of workspaces. One person can be a pilot in
their own individual workspace and an admin at IITH, and switches between
them in the app.

## 2. Roles

A role is always held **on a workspace** (a "membership"). Some roles can also
carry a geographic **area** (a GeoJSON polygon) that limits where their map
powers apply.

### On the HYRAK workspace (staff)

| role | label | what it means |
|---|---|---|
| founder | Founder / owner | Everything, everywhere: all workspaces, all zone layers, staff, accounts. Today's /admin console |
| airspace | Airspace manager | Area required. Edits area-layer zones and decides permits inside that area, across all workspaces. Cannot fly or see customer data |
| pilot | HYRAK pilot | Flies HYRAK's own drones (the ones assigned to the HYRAK workspace) |
| viewer | HYRAK viewer | Watches HYRAK's own drones |

Anyone with any membership on the HYRAK workspace is **staff**. Staff see the
HYRAK console; what they can do in it is exactly what their memberships allow.

### On a customer workspace (organization, individual, client)

| role | who holds it | what it means |
|---|---|---|
| manager | HYRAK staff only, granted by a founder | "Manager / service operator". Runs the workspace together with the customer: flies its drones, plans, manages members and drones, draws area-layer zones inside its area, decides permits. Optional area |
| owner | customer | Everything in the workspace: members (incl. other owners), clients, drones, site zones, models, flying. Deletes the workspace |
| admin | customer | Like owner, but cannot change owners or delete the workspace |
| pilot | customer | Flies, plans missions, runs models |
| viewer | customer | Watches: live video, telemetry, flights, recordings |

Managers and service operators are the same level by design; the `title`
field on a membership carries the human label ("Service operator, IITH").

### Inheritance

* A membership covers its workspace **and every workspace below it**. An IITH
  admin manages IITH's clients; a SkyServe owner manages Client X and Client Y.
* **Exception: the HYRAK workspace does not inherit downward**, except for
  founders. A HYRAK pilot flies HYRAK's drones, not a customer's. Staff reach
  a customer only through an explicit `manager` membership on it (or an
  `airspace` area for zones). This keeps "staff" from silently meaning "can
  touch every customer".

### Permissions

Checks in code are on permissions, never on role names.

| permission | founder | airspace | manager | owner | admin | pilot | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| view | x | | x | x | x | x | x |
| fly | x | | x | x | x | x | |
| plan (missions, pads, tasks) | x | | x | x | x | x | |
| models.run | x | | x | x | x | x | |
| models.manage | x | | x | x | x | | |
| drones.manage | x | | x | x | x | | |
| members.manage | x | | x | x | x | | |
| children.manage (clients) | x | | x | x | x | | |
| zones.site (inside operating area) | x | | x | x | x | | |
| zones.area (inside own area) | x | x | x | | | | |
| permits.approve (inside own area) | x | x | x | | | | |
| workspace.operating_area | x | | x | | | | |
| audit.view | x | | x | x | x | | |
| workspace.delete | x | | | x | | | |
| zones.regulatory | x | | | | | | |
| staff.manage, accounts | x | | | | | | |
| sessions.takeover (take control of a live session, 8b) | x | | x | | | | |

### Who may grant what

* Founders: any role on any workspace.
* Owners: owner, admin, pilot, viewer in their subtree.
* Admins: admin, pilot, viewer in their subtree; cannot touch owners.
* Managers: owner, admin, pilot, viewer on the workspaces they manage (so they
  can onboard a customer); never manager.
* `manager` and `airspace` are granted only by founders, and `manager` only
  to staff.
* Nobody edits their own memberships. The last owner of a workspace and the
  last founder cannot be removed (a founder can remove a last owner).
* Account-wide actions (disable an account, issue a password reset link) are
  founder-only, because an account can be staff somewhere else: a customer
  admin resetting a password could otherwise take over a staff account.

## 3. Zones in layers

Airspace is shared, so **every active zone applies to every drone and is
visible to every signed-in user**. Layers decide only who may edit a zone.

| layer | edited by | where |
|---|---|---|
| regulatory | founders | anywhere (Digital Sky red/yellow, airports) |
| area | airspace managers, workspace managers | inside their membership area, else inside the workspace's operating area |
| site | workspace owners and admins (and managers) | inside the workspace's operating area |

The engine already enforces "strictest zone wins" (`app/zones/engine.py`
takes the worst class covering a point), so a lower layer can add
restrictions but can never cancel a higher one. A green zone relaxes
nothing.

A workspace's **operating area** is set by staff (founder or its manager),
never by the customer, so customers cannot widen their own drawing area.
Geometry containment is checked on the server with shapely `covers`.
Every zone create / edit / delete writes an audit event.

## 4. Sign-in

**Phase 1 (now):** email or username + password.

* New accounts come from **invite links**: a founder, manager, owner or admin
  creates an invite for a workspace and role; the link (32 random bytes,
  stored as SHA-256, single use, 7-day expiry, optionally locked to one
  email) is copied and sent by hand. The invitee sets name, email and
  password. A signed-in person opening an invite just gains the membership.
* No public self sign-up yet (a settings flag later).
* Password reset: founders issue a one-hour single-use reset link. Self-service
  "forgot password" arrives with outgoing email.
* Passwords: at least 10 characters, no composition rules (NIST 800-63B),
  scrypt as today. Changing a password needs the current one and signs out
  every other device.
* "My devices": a user lists their signed-in browsers (the auth_tokens rows)
  and signs any of them out.
* Everything already in `docs/AUTH.md` stays: hashed opaque tokens, 30-day
  sliding expiry, per-IP and per-account login limits, live-socket
  revocation.

**Phase 2:** two-factor codes (TOTP authenticator app), mandatory for founders
and managers. These accounts can redraw airspace and fly customer drones; a
leaked password alone must not be enough.

**Phase 3:** "Sign in with Google" (OpenID Connect). Google proves who the
person is; it never decides whether they get in. A Google login is linked to
an existing account by verified email, or accepted only together with an
invite. Then outgoing email (invites, resets) and optionally passkeys.

Why not Google first: it needs an OAuth client in Google Cloud and a public
redirect URL, does not remove the need for invites or roles, and the
Electron app needs a system-browser login flow. It slots in later without
changing anything below.

## 5. Portals

One Next.js app, two areas, chosen by memberships:

* **HYRAK console** (`/admin`): staff only. Founders see everything. Managers
  see only the workspaces they manage and their areas. Tabs: map, drones,
  zones (with layer), permits, **workspaces** (tree, members, invites,
  drones, operating area), **staff** (founders), **audit**.
* **Customer app** (the existing platform pages): a workspace switcher in the
  sidebar (shown when a person has more than one workspace), plus
  Settings > Account (profile, password, devices) and Settings > Workspace
  (members and invites for owners/admins, read-only list for others).
* Public pages: `/login`, `/invite/<token>`, `/reset/<token>`.

The two areas can later move to separate hostnames (console.xenarobotics.com)
without code changes, since both are routes over the same API.

## 6. Data model (alembic, after e4b7a2c9d013)

| table | columns |
|---|---|
| workspaces | id, kind, name, parent_id (null only for the platform row; one platform row enforced by a partial unique index), path (materialized `/<root>/<org>/<client>/`, indexed for prefix search), operating_area (GeoJSON, null), disabled, created_by, created_at |
| memberships | id, user_id (cascade), workspace_id (cascade), role, area (GeoJSON, null), title, created_by, created_at; unique (user_id, workspace_id) |
| invites | id, workspace_id, role, area, title, email (null = anyone with the link), token_hash (unique), created_by, created_at, expires_at, accepted_at, accepted_by, revoked_at |
| password_resets | id, user_id, token_hash (unique), created_by, created_at, expires_at, used_at |
| audit_events | id, at, actor_id, actor_name, workspace_id, action, target_type, target_id, detail (JSON), ip |
| users | + email (unique, lower-case, null for old accounts), display_name, last_login_at; **role column dropped** (moved into memberships) |
| zones | + layer (regulatory / area / site), workspace_id, created_by, updated_by, updated_at |
| drones | + workspace_id (defaults to the platform workspace) |

Migration of existing data: one platform workspace "HYRAK" is created;
users with role admin become founders, operators become HYRAK pilots,
viewers become HYRAK viewers; every existing zone becomes regulatory on
HYRAK; every drone is assigned to HYRAK.

## 7. API (phase 1)

All under `/api`, bearer token as today. Errors: 401 not signed in,
403 not allowed, 404 also returned for workspaces the caller cannot see (no
existence leak), 409 rule violations (last owner, area outside), 503 DB down.

Auth and account:

* `POST /auth/login` `{login, password, label?}`; `username` is still
  accepted as an alias of `login`. Returns `{token, user, expires_at}`.
* `GET /auth/me` returns
  `{user: {id, username, email, display_name, is_founder, is_staff, role}, memberships: [{id, workspace_id, workspace_name, workspace_kind, role, area, title}], workspaces: [{id, name, kind, parent_id, path, operating_area, my_role, perms: [..], inherited: bool}]}`.
  `role` is the compatibility role (section 8).
* `PATCH /auth/me` `{display_name?, email?}`; `POST /auth/me/password` `{current_password, new_password}`.
* `GET /auth/sessions` `[{id, label, created_at, last_seen_at, current}]`; `DELETE /auth/sessions/{id}`; `POST /auth/sessions/revoke-others`.
* `GET /auth/invites/{token}` (no auth, rate limited) `{workspace_name, workspace_kind, role, title, email_locked: bool, expires_at, invited_by}`.
* `POST /auth/invites/{token}/accept`: signed in, empty body, adds the
  membership; signed out, `{display_name, email, password, username?}`,
  creates the account and returns `{token, user, expires_at}`.
* `POST /auth/reset/{token}` `{password}`.
* Founders: `GET /auth/users`, `PATCH /auth/users/{id}` `{disabled?, display_name?}`,
  `DELETE /auth/users/{id}`, `POST /auth/users/{id}/reset-link` returns `{url, expires_at}`.

Workspaces:

* `GET /workspaces` everything the caller can see, flat, with `my_role`, `perms`, `inherited`.
* `POST /workspaces` `{name, kind, parent_id, operating_area?}`. Top level (organization, individual): founders. Clients: `children.manage` on the parent organization.
* `GET|PATCH|DELETE /workspaces/{id}`. PATCH `{name?, operating_area?, disabled?}`; operating_area needs `workspace.operating_area`. DELETE needs `workspace.delete`, refuses with children or drones (409).
* `GET /workspaces/{id}/members` `[{id, user: {id, username, email, display_name}, role, area, title, workspace_id, inherited_from?}]` (direct plus inherited from ancestors, the latter marked).
* `POST /workspaces/{id}/members` `{login, role, area?, title?}` adds an existing account; `PATCH /workspaces/{id}/members/{mid}` `{role?, area?, title?}`; `DELETE` likewise.
* `GET|POST /workspaces/{id}/invites`, POST body `{role, email?, area?, title?, expires_days? (1-30)}` returns `{invite, url}`; `DELETE /workspaces/{id}/invites/{iid}`.
* `GET /workspaces/{id}/drones`; `POST /drones/{drone_id}/workspace` `{workspace_id}` needs `drones.manage` on both the current and the new workspace.
* `GET /staff` (founders) staff accounts with all their memberships.
* `GET /audit?workspace_id=&limit=&before=` founders see all; others `audit.view` on that workspace.

Zones: `GET /zones` unchanged plus `layer`, `workspace_id`. POST/PATCH take
`layer` and `workspace_id` and apply section 3.

### Phase 1 as built (backend, `feat/workspaces`)

The contract above holds, with these additions and deviations the frontend
should code against:

* **Response wrappers.** Lists and objects come wrapped: `{workspaces}`,
  `{workspace}`, `{members}`, `{member}`, `{invites}`, `{drones}`,
  `{drone}`, `{staff}`, `{events}`, `{user}`. `GET /auth/sessions` is a
  bare list. `POST /workspaces/{id}/invites` returns `{invite, url}`;
  `POST /auth/users/{id}/reset-link` returns `{url, expires_at}`.
* **Links.** `url` is a path (`/invite/<token>`, `/reset/<token>`) unless
  `PUBLIC_APP_URL` is set in `.env`, in which case it is absolute. The
  frontend should prefix its own origin when it gets a path.
* **`user` objects.** Login, `/auth/me` and invite sign-up return
  `{id, username, email, email_verified, display_name, is_founder, is_staff, role}`.
  `PATCH /auth/me` and the founder routes return the account record
  `{id, username, email, email_verified, display_name, disabled, created_at, last_login_at}`
  (founder routes add `memberships` and the compatibility `role`). Member
  rows' `user` also carries `email_verified`.
* **Verified emails.** `users.email_verified` is true only after accepting
  an email-locked invite with exactly that address, or when a founder sets
  the address (`PATCH /auth/users/{id}` accepts `email` for founders; `""`
  clears it). `PATCH /auth/me` accepts `display_name` only: `email` is
  400 until outgoing email brings verification links. Only verified
  addresses resolve: sign-in by email, `POST /workspaces/{id}/members`
  with an email `login` (otherwise 404 "use the username"), and
  email-locked invites (signed in: your verified email must match;
  signed out: you must sign up with the locked address).
* **Workspace entries** (`/auth/me`, `GET /workspaces`) also carry
  `disabled` and `created_at`. `disabled` is resolved down the tree: a
  client of a disabled organization is disabled. On a disabled workspace
  only founders and managers keep any permission.
* **Status codes.** A wrong current password on `POST /auth/me/password`
  is **403**, not 401 (the frontend treats 401 as "signed out"). It
  returns `{ok, other_sessions_ended}`; `POST /auth/sessions/revoke-others`
  returns `{ok, ended}`. Sessions also carry `expires_at`.
* **Invites.** Bad, used, revoked or expired tokens are 404; 5 bad tokens
  per IP per 15 min then 429. Accept while signed in returns
  `{membership: {id, workspace_id, workspace_name, workspace_kind, role, area, title}}`;
  a stale bearer on accept is 401 (not a silent signed-out accept).
  Email mismatch is 403; "already a member", "account with this email
  exists, sign in first" and "username taken" are 409. Without
  `username` one is derived from the email. Revoking an invite needs the
  right to grant its role. **`manager` cannot be invited** (409): it is
  granted only to existing staff accounts with `POST /workspaces/{id}/members`.
* **Areas.** Only `airspace` (required) and `manager` (optional)
  memberships and invites carry an `area`; on any other role it is 400.
  All GeoJSON (areas, operating areas, zone geometry) must be a valid
  Polygon / MultiPolygon in lng/lat range with at most 2000 vertices.
* **Members.** `GET /workspaces/{id}/members` items also have `disabled`;
  `user.email` is null unless the caller has `members.manage`. Inherited
  rows come from customer ancestors only: platform memberships (founders,
  HYRAK staff) are not listed on customer workspaces. Editing a
  membership needs the right to touch its old role and grant its new one
  (so an admin cannot edit an owner's title either). The last-owner and
  last-founder rules count only enabled accounts.
* **Workspaces.** PATCH `name` needs `members.manage`; `disabled` needs
  `workspace.operating_area` (staff), and HYRAK can be neither disabled
  nor deleted (409). **DELETE also refuses while zones belong to the
  workspace** (409), besides children and drones: silently dropping its
  area zones would remove airspace restrictions.
* **Drones.** `GET /workspaces/{id}/drones` lists drones assigned
  directly to that workspace (not its subtree). Moving a drone answers
  404 when its current workspace (or the target) is invisible to the
  caller, 403 when `drones.manage` is missing on either.
* **Audit.** `workspace_id` is required for non-founders (400) and
  includes that workspace's subtree; `before` is an event `id`; events are
  newest first with `{id, at, actor_id, actor_name, workspace_id, action,
  target_type, target_id, detail, ip}`.
* **Zones.** `layer` defaults to `regulatory` and `workspace_id` to HYRAK;
  a regulatory zone must sit on HYRAK (400). A refused edit on a customer
  workspace the caller cannot see is 404. PATCH may move `layer` /
  `workspace_id` and then needs rights on both the old and the new
  placement; geometry still changes only by delete + redraw.
* **Founder account routes.** `POST /auth/users` stays as the old admin
  form (`{username, password, role, email?, display_name?}` with `role` in
  viewer / operator / admin, mapped to a HYRAK membership; the email is
  verified). `PATCH /auth/users/{id}` also accepts `password` and
  `email`; a `role` there is refused with 400. Deleting the last founder
  is 409.
* **Database down.** Reads fall back to the in-memory platform workspace
  and env founder; every write answers 503.
* **Not yet scoped:** `permits.approve` is in the engine but permit routes
  still use the compatibility admin rank (phase 2, with the live paths).
  Done in 2b: permit routes decide with `permits.approve` (section 8b).

## 8. Phasing and what phase 1 does not do yet

Phase 1 builds the structure: workspaces, memberships, invites, accounts,
the permission engine, zone layers, drone assignment, audit, and the
console / settings UI.

The live control paths (socket commands, telemetry sessions, fleet, missions,
vision history, recordings) still use the existing rank check. They see a
**compatibility role** computed from memberships:

| memberships | compatibility role |
|---|---|
| founder | admin |
| HYRAK pilot, or manager anywhere | operator |
| any other HYRAK membership (viewer, airspace) | viewer |
| customer memberships only, or none | member (below viewer) |

`member` passes no compatibility-rank check: no viewer routes, no staff
socket events. (Phase 1 also refused its socket with `no_live_access`;
phase 2a replaces that with the workspace check in section 8a.) The live paths are not scoped per
workspace yet, so a viewer rank would let a customer watch HYRAK's and other
customers' drones. Account, workspace and zone-write routes use
`require_signed_in` and decide with workspace permissions instead. A staff
account demoted to customer-only loses its open socket at the next
revalidation.

So in phase 1 a customer can sign in, see their workspace, members, drones
and zones, and invite people (on the standalone `/account` page), but cannot
open live sessions or command drones yet; HYRAK staff fly as today. Phase 2 scopes every live path by the drone's workspace
(`fly` on that workspace), gives customers flying rights on their own drones,
scopes recordings / vision history / flights per workspace, and adds TOTP.
Phase 3 adds Google sign-in and outgoing email.

## 8a. Phase 2a: customers in the live app (enough for Custom Models)

Goal: a customer pilot opens Fly / AI / Config for **their own** workspace,
connects their own drone and camera, runs AI modes (and later their own
models) on their own video, and commands their own drone. Nothing shared
with other workspaces is reachable. Staff keep working exactly as today.

### Who gets what

| account | console (/admin) | live app |
|---|---|---|
| founder | everything | everything (as today) |
| manager / service operator | SPACES, ZONES, AUDIT for the workspaces they manage | as today (compat operator) |
| other HYRAK staff | SPACES / ZONES / PERMITS / AUDIT as their memberships allow | as today (compat rank) |
| customer owner / admin | **organization console**: SPACES, ZONES (site layer) and AUDIT, scoped to their workspaces | Fly, AI, Config, Settings for the active workspace |
| customer pilot | none | Fly, AI, Config, Settings; commands own drone |
| customer viewer | none | Fly, AI, Config, Settings read-only (video, telemetry, AI overlays) |

Customers never see: Command-tab fleet aside / swarm, Mission and Deliver
tabs, "Gazebo sim on server", mesh units, ground decoder relays, video wall,
the fleet, other sessions, global vision history, other workspaces' flights.

### Socket sessions

* Handshake `auth: {token, workspace_id?, resume_session?, resume_secret?}`.
  Staff: `workspace_id` optional, defaults to HYRAK. Customer-only accounts:
  must have `view` on `workspace_id` (default: their first workspace with
  `view`), else refused with `no_workspace_access`.
* The session is stamped with `workspace_id`, the user's perms on it and
  `is_staff`; `session_ready` carries `{workspace_id, perms, staff}`.
  Revalidation (every 60 s and on membership change) refreshes the perms
  and disconnects a session that lost `view`.
* Switching the active workspace in the UI reconnects the socket (a session
  belongs to exactly one workspace).

### Every socket event is classified (default deny for customers)

| class | guard | examples |
|---|---|---|
| session view | `view` on the session workspace (staff: signed in) | WebRTC offer / ICE / stop_stream for the session's own stream, own telemetry, own params read |
| session command | `fly` on the session workspace (staff: compat operator) **and** drone access (below) | drone_action, drone_command, offboard, tracking, AI mode / params, calibration, own telemetry link connect |
| staff only | compat rank as today | fleet / swarm, server-side links (udp:14600 Gazebo on server), mesh units, gs relay, allocate/release_video_relay, wall_offer/close, admin_hello / watch_session, permits, deliveries |

Existing guards (`require_operator`, `require_admin`) keep meaning
**staff only**; only events explicitly moved to the session guards become
reachable for customers. A test enumerates every registered socket handler
and fails if one is not in the classification table, so a new event cannot
ship unclassified.

### Drone access

* On telemetry connect the registry records the drone with the session's
  workspace: an **unassigned** drone is claimed by that workspace (audit
  `drone.claimed`). Simulated drones are never claimed and never block.
* A drone that belongs to a workspace where the user lacks `fly` is
  read-only for that session: commands answer `{code: "drone_not_in_workspace"}`
  with a message naming the fix (ask its owner to move it).
* **Safety exception**: hold, return-to-launch and land are never refused
  for a session that holds the drone's link, whoever owns it. Blocking a
  safety command on a link the pilot physically holds is worse than any
  ownership rule.

### REST

* Global data becomes staff-only (compat viewer): vision history (crowd,
  plates and plate images, faces, sightings), flights and their downloads,
  `/api/drones`, `/api/fleet`, sessions, missions, tasks, pads.
* Session reports (`/sessions/{id}/crowd-report`, `plate-report`): the
  session's own user or staff.
* `/api/zones` GET and terrain: any signed-in account.
* Org console data comes from the existing `/api/workspaces*`, zones and
  `/api/audit` routes, which already check workspace permissions.

### Phase 2a as built (backend, `feat/live-scope`)

The contract above holds, with these decisions and deviations the
frontend should code against.

**Handshake.** `auth: {token, workspace_id?, resume_session?, resume_secret?}`.

* Staff without `workspace_id` land on HYRAK. A staff account may also
  name a workspace, but only one it has `view` on (HYRAK itself is always
  allowed, so an airspace manager without `view` still gets a session).
  A HYRAK pilot naming a customer workspace is refused. A staff session
  stays a staff session (compatibility rank) whatever workspace it names.
* Customer-only accounts without `workspace_id` get the first of their own
  memberships (in grant order) whose workspace gives `view`. Inherited
  workspaces can be named (an IITH pilot may open a session in IITH's
  client).
* Refusals (socket.io `connect_error` message): `unauthorized` (no or bad
  token: sign in again) and `no_workspace_access` (signed in, but no
  `view` on the named or any workspace, or the workspace is disabled or
  unknown: keep the token, offer another workspace or the `/account`
  page). `no_live_access` is gone.
* `session_ready` (new and resumed) adds
  `{workspace_id, perms: [sorted perm names], staff: bool}` next to the
  existing `session_id, device, gpu_count, max_sessions, resume_secret,
  user` (and `resumed, away_s, telemetry_connected` on a resume).
* **Resume is bound to the same user and the same workspace.** Omitting
  `workspace_id` on resume keeps the session's own; naming a different
  one starts a fresh session (the old one is parked and expires as
  usual). The workspace access is re-checked on resume: a customer who
  lost `view` gets `no_workspace_access`.
* Revalidation (60 s, or immediately on a membership change that reduces
  access, through the existing revocation listener) refreshes perms and
  drone access; a customer session that lost `view` is disconnected (the
  session parks; its drone link runs out the 90 s grace and then drops,
  so PX4's link-loss failsafe takes over). One re-check per session runs
  at a time and every event arriving meanwhile waits for its answer. A
  re-check the store does not answer within 5 s (or that errors) leaves
  the session unverified: session-view events continue on the last known
  perms, every command and staff event is refused with `access_unverified`,
  except hold / return / land on a held link; the next event retries.
* Customer sessions never load the enrolled-face gallery (it is HYRAK's
  global data): person-tracking and traffic modes match nobody.

**Socket error codes** (`error` event `{msg, event, code}`; for
`drone_action` also an `action_result` `{action, ok: false, error, code}`):
`forbidden` (the session lacks the perm, or a staff-only event / video
source / AI mode), `drone_not_in_workspace` (the drone on the link belongs
to a workspace where the user lacks `fly`), `access_unverified` (the
periodic access re-check could not reach the account store in time:
retry in a few seconds; hold / return / land still pass),
`drone_unidentified` (customer
session holds a link whose drone is not identified yet: no UID read yet,
FC reported none, or the registry is offline). Staff-only socket acks
(`allocate_video_relay`, `datachannel_video_offer`, ...) answer
`{error, code: "forbidden"}`.

**Event classification** (`backend/app/auth/socket_classes.py`; a test
walks every handler socketio registered and also checks each handler
calls the guard of its class): 56 handlers on the default namespace and 4
on `/gs-relay`.

| class | count | events |
|---|---|---|
| lifecycle | 2 | connect, disconnect |
| session view | 7 | offer, ice_candidate, stop_stream, serial_uplink, disconnect_telemetry, fetch_params, get_param |
| session command | 19 (+ upload_mission in 2b, section 8b) | connect_browser_serial, drone_action, drone_command, set_param, set_tracking, set_vehicle_tracking, set_follow_vehicle, set_follow_person, set_multi_follow, select_person, set_pd_params, set_altitude_mode, set_altitude_nudge, set_tracking_params, set_analysis_mode, set_profile_override, set_zone_names, set_enhance_params, clear_reference |
| staff | 28 + 4 (27 + 4 after 2b) | connect_telemetry, connect_rf_bridge, start_rc_monitor, upload_mission (session command since 2b), set_gallery_mode, enrol_person_live, set_crowd_thresholds, allocate_video_relay, release_video_relay, datachannel_video_offer, datachannel_video_stats, wall_offer, wall_ice_candidate, wall_close, admin_hello, watch_session, unwatch_session, request_permit, list_my_permits, the 9 swarm events, and the 4 `/gs-relay` agent events |

Notes on the split:

* Of the session commands, the 13 that act on the vehicle (drone_action,
  drone_command, set_param and the follow / tracking controls) also need
  drone access; the other 6 (connect_browser_serial and the AI pipeline
  controls) do not.
* `disconnect_telemetry` is session view: dropping your own link is always
  allowed. `serial_uplink` is session view: bytes reach only the
  session's own bridge, and blocking them would cut the link's downlink.
* Staff for a reason other than the table above: `upload_mission` and
  permits (customer mission planning is 2b), `set_crowd_thresholds`
  (persists to the server-wide calibration file), `set_gallery_mode` and
  `enrol_person_live` (global face gallery), 3D reconstruction as an
  analysis mode (one engine process for the server; refused in
  `set_analysis_mode` for customers). `rc_channels` now goes only to the
  sockets that called `start_rc_monitor` (it was a broadcast to every
  socket).
* Formerly ungated events moved behind a staff guard: start_rc_monitor,
  allocate / release_video_relay, datachannel_video_offer / stats,
  wall_offer / wall_ice_candidate / wall_close, unwatch_session,
  list_my_permits. Formerly ungated events now behind a session guard:
  offer, ice_candidate, stop_stream, serial_uplink, fetch_params,
  get_param.

**Telemetry links a customer can use:** only `connect_browser_serial`, a
per-session loopback bridge on an ephemeral port fed by the socket's own
`serial_uplink` bytes. That covers every client-side relay: Web Serial,
the desktop's SITL relay ("SITL", the client's own udp:14540), and the
desktop's native serial, native RF, local RF agent and SIYI relays.
`connect_telemetry` (any address the server can reach, including "Gazebo
sim on server" on udp:14600) and `connect_rf_bridge` (the shared RF bridge
and ground-station relay) are staff only.

**Video sources a customer can use:** only the WebRTC track their own
browser sends (`videoSource` "camera" or any other client-side source;
the server consumes it from the peer connection). Every server-sourced
`videoSource` is refused for customers with `forbidden`, because each has
the server open something: `siyi_rtsp` (the server dials an RTSP URL),
`air_unit_udp` (a shared UDP feed port), `rtsp_relay`, `air_unit_srt`,
`air_unit_gst`, `hyrak_receiver` (a public relay port from
allocate_video_relay), `rtsp_datachannel`, `air_unit_datachannel` (a
loopback port from a fixed pool shared by all sessions). A customer's
offer also has its `iceServers` replaced by the server's own list, so the
server never dials a TURN host the customer typed.

**Drone access as built.**

* "Unassigned" means **never seen by the registry**: drones default to
  the HYRAK workspace (phase 1), and every drone seen before 2a was seen
  by staff, so a known drone on HYRAK is HYRAK's and is never claimed. The
  first connect of a new real drone puts it in the session's workspace;
  `drone.claimed` is audited when that is a customer workspace. A known
  drone is moved only by `POST /api/drones/{id}/workspace`.
* The ownership check is skipped only for a **simulated drone**: the
  registry record carries the stored `is_simulated` flag **and** the
  session's current link is simulator-type. Only one link is
  simulator-type: a direct udp address the server dials on a staff
  `connect_telemetry` (the Gazebo sim on this server, udp:14600). Every
  client-side relay (`connect_browser_serial`) and the RF bridge are never
  simulator-type, though MAVSDK sees loopback udp for both; the link kind
  comes from the handler that opened the link, never from the client's
  payload (`live_scope.link_kind_for`). Either condition alone is not
  enough: a real drone on WiFi UDP telemetry is on a udp link too, and a
  SITL UID repeats across instances.
* A new record is stored as simulated (and left unclaimed, on HYRAK) only
  when a staff session first sees it on a simulator-type link. Records
  created or first seen through a customer session's link are never
  simulated, so a customer cannot launder a real drone into "simulated". A
  customer's desktop SITL arrives through the relay bridge, so it is
  treated as a real drone: the first workspace to connect a given SITL UID
  claims it, and a SITL UID already registered to HYRAK is read-only for
  customers until staff move it.
* The check applies to staff sessions too (a HYRAK pilot does not command
  a customer's drone). **HYRAK's drones are flown only by accounts with
  `fly` on the HYRAK workspace by the perms** (founders, HYRAK pilots);
  the compatibility operator rank is no shortcut. A manager whose own
  HYRAK membership is viewer flies the drones of the customer workspaces
  they manage, and flies HYRAK's drones (including customer drones still
  sitting on HYRAK from before 2a) only by also holding a HYRAK pilot
  membership. Staff are still not held back while a drone is unidentified.
  The legacy shared token flies HYRAK drones only.
* `drone_identity` (sent once the UID is read) carries `drone_fly`:
  `true` = this session may command the drone, `false` = read-only here,
  `null` = unknown (customers cannot command until it is known).
  `/api/sessions` (founders) shows each session's `workspace_id` and
  `staff`.
* **Safety exception:** `drone_action` with `hold`, `pause_mission`,
  `return` or `land`, or `set_mode` with `HOLD` / `RETURN` /
  `LAND`, passes both the workspace `fly` check and drone access whenever
  the session holds a telemetry link. It is audited with a `(safety)`
  suffix when it bypassed either. `rtl_home` is deliberately not in the
  set: it takes a caller-chosen altitude, so it is a goto, not a return.

**REST as built.**

* Staff only (compat viewer): `GET /api/drones`, `/api/fleet`,
  `/api/missions`, `/api/missions/{id}`, `/api/pads`, `/api/tasks`,
  `/api/tasks/{ref}`, `/api/permits`, `/api/planner/meta`,
  `/api/map-features`, `/api/drones/{id}/flights`, `/api/flights/{id}`,
  `/api/flights/{id}/download`, `/api/vision/crowd-history`,
  `/api/vision/plate-history`, `/api/vision/plate-history/{id}/image`,
  `/api/vision/face-gallery`, `/api/vision/sightings`, every
  `GET /api/avoidance/*`, `/api/video/mesh-units`, `/api/video/feeds`,
  `GET /api/latency-probe` and `/stats`, every `GET /api/recon/*`. Writes
  already needed operator or admin.
* Any signed-in account: `GET /api/zones`, `/api/zones/check`,
  `/api/vision/calibration` (read-only; customers' AI modes run with it),
  `/api/terrain/elevation`, `/api/webrtc/ice-servers`.
* Session reports (`/api/sessions/{id}/crowd-report/download`,
  `plate-report/download`): staff, or the user who opened the session;
  404 for anyone else. The owner is remembered in memory (bounded), so
  after a server restart a pre-restart report is staff-only.
* Still public: `GET /api/health`, `/api/auth/login`, `/api/auth/logout`,
  `GET /api/auth/invites/{token}`, `POST /api/auth/invites/{token}/accept`
  (signed out or in), `POST /api/auth/reset/{token}`, the `/v1` partner
  API (API key checked in every handler), `/releases/*` (desktop
  installers and update manifests).
* The org console needs nothing new: `/api/workspaces*`, the zone writes
  and `/api/audit` already scope an owner or admin to their subtree
  (tested in `test_live_scope.py` and `test_workspaces.py`).
* `start.sh` probes `/api/health` for readiness (it used `/api/fleet`).
* **The frontend sends the bearer everywhere.** Every backend call goes
  through `apiFetch` (`src/lib/api.ts`), which adds the token and sends
  the browser to `/login` on a 401: the zone, drone, permit, flight,
  map-feature, planner, task, pad, fleet, sessions, vision history /
  calibration / face gallery / sightings, avoidance, mesh-unit, recon and
  ICE-server reads, and the writes that already carried the token. The
  exceptions are deliberate: the auth calls themselves,
  `src/lib/workspaces.ts` in its soft mode (no redirect), the
  `/api/video/feeds` stream reader in `WebCodecsVideo.tsx` and the public
  `/releases` fetches.
* The bearer goes only to the configured API base (`getServerUrl()`):
  `apiFetch` drops it for any other host, and `isApiUrl` /
  `authHeadersFor` in `src/lib/auth.ts` state the rule. The localhost
  shortcut for the server video feeds probes the public `/api/health`
  (which now carries a per-process `instance` id) and streams from
  localhost only when it is the same process as the API base, with a URL
  ticket for the feed path instead of the bearer. Desktop preview servers
  get no credential at all.
* Elements that cannot send a header: the plate crop
  (`/api/vision/plate-history/{id}/image`) is fetched into a blob and shown
  through an object URL revoked on unmount (`useApiObjectUrl`); the flight
  CSV, the session report zips and the recon result files are fetched into
  a blob and saved through an object URL revoked a minute after the click
  (`apiDownload`; the backend now exposes `Content-Disposition` to CORS so
  the server's file name survives). The recon MJPEG streams
  (`/api/recon/stream/video`, `/depth`) use **URL tickets**:
  `POST /api/auth/url-ticket {path}` returns a 60 s ticket bound to the
  user, the token and that exact path, reusable within the window so the
  `<img>` can reconnect, re-checked against the token on every use, and
  accepted only by routes that opted in with `require_user_or_ticket` (the
  recon streams, viewer; the `/api/video/feeds/{port}/hevc` and `/h264`
  streams, operator, for the localhost shortcut above). Details in `docs/AUTH.md` "URL tickets".
* Video sources: the frontend hides the two DataChannel modes
  (`rtsp_datachannel`, `air_unit_datachannel`) from customers as well, to
  match the backend (`datachannel_video_offer` is staff-only because of the
  shared 5800-5900 loopback pool). Customers keep `camera` (including the
  desktop's virtual webcam) and `rtsp_camera` (RTSP decoded on their own
  machine): both produce a WebRTC track in the browser and need no
  server-sourced `videoSource` or relay allocation.

### Not in 2a (phase 2b)

Customer mission planning, customer flight history and recordings per
workspace, customer fleet views, TOTP for founders and managers. Phase 2b
landed below: monitoring, per-workspace history, customer avoidance and
takeover in 8b, the premium cloud simulator in 8c, customer mission
planning and permits in 8d (`upload_mission` is a session command there
and the PERMITS console tab uses `permits.approve`).

## 8b. Phase 2b: monitoring, per-workspace history, customer avoidance, takeover

Goal: staff (founders, managers) can see and follow what customers are
doing, customers see their own flight and AI history, and customers run
obstacle avoidance on their own drone. HYRAK operations can take control
of a customer's flight when something looks wrong.

### Who sees what now

| account | live sessions (console MAP / DRONES, `/api/sessions`) | history (flights, crowd, plates) | sightings, face gallery |
|---|---|---|---|
| founder | every session, every workspace | everything, including rows of deleted workspaces | yes |
| manager | the workspaces they manage (with `view`), plus HYRAK if they also hold a HYRAK viewer or pilot membership | same workspaces | sightings of those workspaces; the gallery (staff) |
| HYRAK pilot / viewer | HYRAK's sessions | HYRAK's history | HYRAK's sightings; the gallery |
| airspace manager | none (no `view` anywhere) | none | gallery only (staff) |
| customer owner / admin / pilot / viewer | no console session list (the console stays SPACES / ZONES / AUDIT) | their workspace and the ones below it | no |
| legacy shared token | HYRAK | HYRAK | HYRAK |

The rule in every case is the permission engine: `view` on the row's
workspace (`app/auth/data_scope.py`), with fresh memberships per request.
Founders have no filter. A requested workspace outside the caller's scope
reads as empty (lists) or 404 (one row), never 403, so ids cannot be probed.

### Staff monitoring

* `/api/sessions` and the console socket (`admin_hello`, `watch_session`,
  `unwatch_session`) are open to all staff (compatibility viewer rank) and
  scoped as above. `/api/drones` is scoped the same way.
* Each session row carries `workspace_id`, `workspace_name`, `username`,
  `role` (the user's strongest role on that workspace), `staff`,
  `link_kind` (`client_relay`, `rf_bridge`, `server_udp`, `server_direct`,
  or null), `armed`, `in_air`, `ai_mode`, `video`, `drone`, `detached`
  (client away, session parked) and `takeover` (who holds it, or null).
* `watch_session` is view only: telemetry, video frames and overlays. It
  answers `Session not found` for a session outside the caller's scope.
  `admin_alert` (zone transitions, AI alerts) goes only to observers who
  can view the session's workspace.
* **Observers cannot hide.** `admin_hello` marks a socket as a console
  observer, which keeps it off the session list. It is refused on a session
  that holds a drone link or sends video, attaching a link clears it, and
  a session with a link or video is listed and can be taken over whatever
  the flag says (`SessionManager.is_observer_only`).
* Console: MAP and DRONES are shown to all staff (STAFF stays founders).
  Session cards show workspace, user and role, AI mode and a HYRAK CONTROL
  tag. Drone RENAME is founders only in the UI.
* SPACES detail has an **Activity** section
  (`GET /api/workspaces/{id}/activity`, needs `view`): live sessions,
  recent flights and, with `audit.view`, recent audit events of the
  workspace and its subtree (HYRAK's activity is HYRAK's own).

### Per-workspace history

* `flights`, `crowd_snapshots`, `crowd_alerts`, `plate_events` and
  `person_sightings` have `workspace_id` (alembic `b8e4f0c2d5a3`): NOT
  NULL, indexed, default HYRAK, a plain string like
  `audit_events.workspace_id` (history never fails to write; a deleted
  workspace's rows stay readable by founders). Existing rows went to HYRAK.
* Stamped at record time: a flight takes its drone's workspace (the
  registry's, read once on the arm edge), falling back to the session's;
  vision rows take the session's workspace through a resolver the server
  installs (`persistence.set_workspace_resolver`). A `workspace_id` in an
  analyzer's payload is ignored.
* Reads, signed in, scoped: `GET /api/flights?workspace_id=&drone_id=`,
  `/api/drones/{id}/flights`, `/api/flights/{id}` (track replay) and
  `/download` (CSV), `/api/vision/crowd-history?workspace_id=`,
  `/api/vision/plate-history?workspace_id=` and `/{id}/image`.
* Session reports (`/api/sessions/{id}/crowd-report/download`,
  `plate-report/download`) are now **durable**: access is `view` on the
  workspace the session's rows were recorded in, which survives a restart;
  a live session that wrote no rows yet falls back to the session manager.
  The 2a "the user who opened it" rule is gone (a colleague with `view` on
  the workspace reads it; staff only with `view` there).
* Clearing history (`DELETE /api/vision/crowd-history`, `plate-history`,
  `sightings`, optional `workspace_id`) stays staff operators, and deletes
  only rows of workspaces where they hold `fly` (founders: all).
* **Privacy decision:** the face gallery (`persons`, `person_faces`) and
  the gallery-match log (`/api/vision/sightings`) stay HYRAK staff-only.
  Sightings are scoped per workspace for staff, but customers never read
  them, and customer sessions never load the gallery (8a), so their
  workspaces have no sightings.
* Frontend: Settings has a **Flights** category (track replay with a
  scrubber, CSV download), scoped to the session's workspace for customers.
  The AI panels' history asks for the session's workspace for customers;
  their "clear" buttons are staff only.

### Avoidance for customers on their own drone

* Per-drone routes (`/api/avoidance/{drone_id}/...`): staff keep the rank
  check (reads viewer, writes operator). A customer reads with `view` and
  writes with `fly`, either on the drone's registry workspace (drone
  access) or on a live session holding the drone's link (for writes that
  session must also be allowed to command the drone, `drone_fly`). Anything
  else is 404. `drone_id` "auto" and `GET /api/avoidance/status` (every
  drone) stay staff only.
* The shared hazard map: `GET /api/avoidance/hazards` any signed-in
  account; `POST /hazards` and `/hazards/clear` staff operators.
* Frontend: the AVOID dock tab, the avoidance panels, the Mission map
  overlay (their own drone's obstacles and reroute) and the Settings
  Avoidance category are back for customers; "Pin hazard" and "Forget
  hazards" stay staff.

### Takeover

HYRAK operations can take control of a session's drone. The permission is
`sessions.takeover` (founder, manager; owners and admins do not hold it
yet, and since it is a permission it can be granted to them later without
code changes), checked on the **target session's workspace** with the
staff member's own memberships. A manager of another workspace, a HYRAK
pilot and the legacy token are refused.

* **Quick actions.** From the console's watch view: HOLD, RTL and LAND,
  sent as `drone_action {action, target_session}` and run through the
  session's own drone_action handler (red-zone checks, action_result to
  the console). No takeover needed. The customer sees a short notice
  (`staff_intervention {action, by}`).
* **Full takeover.** `takeover_session {session_id}` (staff, plus the
  permission) puts the session in TAKEOVER mode; `takeover_result` answers
  the console, `takeover_status {active, by, since}` tells the customer
  (and `session_ready` carries `takeover` on a reload or resume). While it
  lasts:
  * Staff `drone_action` / `drone_command` naming `target_session` act on
    that session's drone. Only the holding console may; another staff
    member gets `taken_over`.
  * The customer's every session command is refused with `taken_over`,
    **hold, return and land included**: staff now own the decision, and
    two parties issuing safety commands at once is the worse failure.
  * The customer's link events are refused too: `disconnect_telemetry`
    (cutting the link would cut staff off), `connect_browser_serial`
    while a link is up (relinking a dropped radio is allowed, it gives
    staff their link back). A taken-over **staff** session also loses
    `connect_telemetry`, `connect_rf_bridge` and `upload_mission`.
  * Avoidance writes for that drone answer 423 `{code: "taken_over"}`
    unless the caller is the holding staff user. Reads continue.
  * Automated sources stop: the link is marked `automation_locked`, so AI
    follow setpoints, avoidance commands, Offboard starts and the Offboard
    re-send loop send nothing; stream_track drops the vision pipeline's
    velocity commands; the dispatcher offers the drone to no order. If the
    AI follow was flying it in Offboard, the drone is put in HOLD at the
    moment of takeover.
  * All of the above go through one check: `takeover.blocking()` (and
    `socket_guard.takeover_stops()` on the socket paths).
* `release_session` hands control back (the holder, or anyone else allowed
  to take that session over, such as a founder). The drone keeps its
  current mode: nothing is sent. If the holding console's socket drops,
  the takeover is released after `RELEASE_GRACE_S` (15 s) unless that
  console session resumes first; no auto-land. A takeover also ends when
  either session is torn down.
* Audit rows (`audit_events`, with actor, workspace and drone in
  `detail`): `session.takeover`, `session.takeover.command` (each staff
  drone_action while holding it), `session.quick_action`, and
  `session.release` with a reason (`released`, `released by <name>`,
  `staff_disconnected`, `session_ended`, `staff_session_ended`).
* **Residual risk (radio relay).** `serial_uplink` carries the radio's
  downlink into mavsdk_server; it cannot be refused without blinding
  staff. While taken over it is filtered: COMMAND_LONG / INT, SET_MODE,
  mission writes, PARAM_SET, setpoints, MANUAL_CONTROL and
  RC_CHANNELS_OVERRIDE frames are dropped (`serial_bridge.CommandFilter`).
  That is defence in depth: those bytes reach the ground-side
  mavsdk_server, not the aircraft. The customer's own machine owns the
  physical radio and can still write to it directly, stop relaying staff
  commands, or unplug it; no server-side check can prevent that, and an
  RC transmitter on the aircraft can always override too. A drone whose
  customer must not be able to override HYRAK needs that enforced on the
  aircraft (phase 3).
* Socket classes: `takeover_session` and `release_session` are STAFF
  (58 handlers on the default namespace). `drone_action` / `drone_command`
  stay SESSION_COMMAND; their `target_session` routing is checked inside
  `require_session_fly`.
* Frontend: the console detail panel has HOLD / RTL / LAND, "Take
  control" (with a confirm) and, while held, ARM / DISARM / TAKEOFF /
  START and PAUSE MISSION / a mode menu bound to that session, and
  "Release control". These are console controls that emit the same
  drone_action names as the app's flight controls, not the app's
  DroneControls component itself (that one is bound to the page's own
  session). Customers get a red banner, "HYRAK operations has taken control
  (name)", with no buttons.

## 8c. Cloud SITL (premium, phase 2b)

The customer's **default** simulator runs on their own computer: PX4 or
Gazebo on their machine, linked through the desktop app's "SITL" relay
(the client's udp:14540, `connect_browser_serial`). Only telemetry and
camera pass through HYRAK. The cloud simulator is an optional **premium
extra**: a per-session PX4 + Gazebo instance on the HYRAK server that the
session flies from Fly, Mission and AI exactly like a real drone.

Three link options stay distinct and are never merged or relabelled:

| option | what | who |
|---|---|---|
| SITL | the desktop relay of the client's own SITL (udp:14540 on their machine) | everyone, the default |
| Gazebo sim on server | the owner's shared demo sim, udp:14600 (`connect_telemetry`) | staff |
| Cloud simulator (premium) | this section: one sim per session, launched by the server | staff always; customers with the workspace feature |

### Entitlement

* `workspaces.features` (JSON, migration `c9f5a1d3e6b4`), e.g.
  `{"cloud_sim": true}`. Absent key = off. Not inherited by clients.
* Only founders change it: `PATCH /api/workspaces/{id}` with
  `{"features": {"cloud_sim": true}}` (403 for anyone else, 400 for an
  unknown key or a non-boolean). The console's workspace page has a
  CLOUD SIM ON / OFF button for founders. Audited as `workspace.update`.
* Staff sessions are always entitled. A customer session in a workspace
  without the feature gets `cloud_sim_not_entitled` and the message
  "Cloud simulator is a premium feature ...", and the link picker shows
  the option disabled with that note.

### Socket events

| event | class | notes |
|---|---|---|
| `start_cloud_sim` `{airframe?, home?: {lat, lon}}` | session command (`fly`; staff: operator) | plus the entitlement. Starting when the session already has one returns it (and re-links it if it is up but unlinked) |
| `stop_cloud_sim` | session view | stopping your own sim, like `disconnect_telemetry`: a pilot demoted mid-session can still stop it |
| `cloud_sim_status` | session view | |

All three answer with the status as the ack and as a `cloud_sim_status`
event, which the server also pushes on every change: `state` is `none`,
`starting`, `ready`, `stopping` or `error` (with `code`, `error`), plus
`entitled`, `enabled`, `quota {workspace_used, workspace_max,
global_used, global_max}`, `idle_minutes`, `idle_stop_in_s`, `home`,
`boot_s`, `linked`, and `ended` (`idle`, `stopped`, `session_ended`,
`error`, `server_shutdown`) after one ended. Staff also get `staff
{address, slot, instance, partition, pid, sim_id}` and, after a failure,
the log tail in `detail`. Codes: `cloud_sim_not_entitled`,
`cloud_sim_quota_workspace`, `cloud_sim_quota_global`,
`cloud_sim_unavailable`, `cloud_sim_bad_request`, `cloud_sim_failed`.

The client never supplies an address (any `address` in the payload is
ignored). When the sim is up the server links the session's telemetry to
the loopback port it chose (`udpin://127.0.0.1:<port>`) through the same
connect flow as every other link, with origin `start_cloud_sim`.

### Drone access

* The link kind is `live_scope.CLOUD_SIM_LINK`, decided by the handler
  that opened it, never by the client. It is simulator-type for
  customers too, because nothing about it comes from the client: the
  process, the port and the identity are the server's.
* The identity is synthetic: `cloudsim-<workspace_id>-<n>` (n = 0 up to
  the workspace cap), assigned by the server instead of the FC's UID
  (PX4 SITL reports the same UID everywhere). A real FC's UID is hex, so
  no other link can produce one.
* The record is stored simulated and never claimed (it stays on HYRAK),
  and `drone_fly` is true for the session holding the link. The rule of 8a
  becomes: the ownership check is skipped only when the record is
  simulated AND the session's link is simulator-type, which is either a
  staff server-sim link (`SIM_LINK`) or the session's own cloud sim
  (`CLOUD_SIM_LINK` with a `cloudsim-` UID). The same UID on any other
  link gets the normal rules.

### How it runs (backend/app/sim, simulation/cloud_sim.sh)

* **Pool.** 64 slots. Slot k owns udp `base + 10k` (the backend's MAVSDK,
  loopback only), `base + 10k + 1` (PX4's MAVLink port) and `base + 10k +
  2` (PX4's uXRCE-DDS client, pointed at nothing), PX4 instance `100 + k`
  (MAV_SYS_ID 101+, clear of the owner's 0-30 and the backend's GCS ids
  200+) and a fresh `GZ_PARTITION=hyrak_cloud_<k>_<random>`. The default
  base 15000 gives 15000-15639. `ports.validate_plan` refuses a base that
  overlaps any reserved port (14540-14571 SITL / fleet, 14550, 14600-14601,
  5600-5603, 5800-5900, 8001, 3000, 8888, gz discovery 10317-10318, PX4's
  default per-instance ports for instances 0-99, the ephemeral range), and
  allocation skips a slot whose ports are bound or whose PX4 lock
  (`/tmp/px4_lock-<n>`) is held.
* **Launch.** `cloud_sim.sh` (derived from `hyrak_sim.sh`): `GZ_IP=127.0.0.1`,
  the unique partition, `hyrak_server.config` (no GstCameraSystem leak),
  headless gz server first, then PX4 adopts the world (no
  `PX4_GZ_STANDALONE`), `PX4_HOME_ALT=0`, `NAV_DLL_ACT=2`, `RTL_RETURN_ALT=10`,
  logger off, a fresh working dir per instance. `cloud_sim_rc/px4-rc.mavlink`
  replaces PX4's stock MAVLink startup: ONE link to the backend, no FTP,
  no forwarding, nothing to udp:14550 or 1454x. Airframe: x500 only
  (allowlist in `app/sim/manager.py`). Home: the customer's `{lat, lon}`,
  else a point inside the workspace's operating area, else the server
  default.
* **Ready** when PX4 has run its startup script and opened the backend
  link (not "Ready for takeoff": PX4 withholds that until a ground station
  connects, and the backend link is the ground station). Pre-flight state
  then reaches the pilot as telemetry, like a real drone's.
* **Processes.** The backend starts the script as the leader of a new
  process group and stops it with SIGINT to the group, SIGKILL after 8 s,
  then a sweep of every process whose environment carries
  `HYRAK_CLOUD_SIM_ID=<this instance>` (a positive match in
  `/proc/<pid>/environ`, this user's processes only). It never
  pattern-matches command lines and never touches a gz or px4 it did not
  start. Instances are recorded in `simulation/.cloud_sim/instances.json`;
  on startup the backend sweeps every recorded instance by its marker
  (orphans of a crash or a hard restart) and removes their working dirs.
* **Teardown.** On `stop_cloud_sim` (and Disconnect while the cloud sim is
  the link), when the session ends (its socket did not return within the
  90 s resume window), after `CLOUD_SIM_IDLE_MINUTES` on the ground
  (disarmed or not linked; armed time never counts), when it exits on its
  own (reported as an error), when it does not come up within
  `CLOUD_SIM_BOOT_TIMEOUT_S`, and on backend shutdown (which includes the
  dev backend's auto-reload). A linked session's telemetry is released
  first (`telemetry_status: disconnected`).

### Not yet

* **Camera.** No video from the cloud sim. `hyrak_sim.sh`'s camera
  bridge sends H.265 RTP to a fixed udp:5600 consumed by the staff-only
  `air_unit_udp` source; feeding a customer session safely needs a
  per-instance port and a server video source allowed only for the
  session that owns the sim. Follow-up; until then the x500 has no camera
  model (it would render for nothing).
* Mission planning for customers is stream A of 2b; the cloud sim takes
  whatever the session may upload.
* Per-workspace quotas beyond the one setting, billing, usage metering.

### Operator note: sizing and the firewall

Settings (`.env`):

| setting | default | meaning |
|---|---|---|
| `CLOUD_SIM_ENABLED` | true | off hides the option and refuses starts |
| `CLOUD_SIM_MAX_GLOBAL` | 2 | instances on the server at once |
| `CLOUD_SIM_MAX_PER_WORKSPACE` | 1 | instances per workspace (staff share HYRAK's) |
| `CLOUD_SIM_IDLE_MINUTES` | 15 | on the ground this long: stopped |
| `CLOUD_SIM_BOOT_TIMEOUT_S` | 150 | not ready by then: stopped as an error |
| `CLOUD_SIM_PORT_BASE` | 15000 | first port of the 640-port block |
| `CLOUD_SIM_INSTANCE_BASE` | 100 | first PX4 instance (100-199 allowed) |
| `CLOUD_SIM_PX4_DIR` | ~/PX4-Autopilot | PX4 checkout built with `make px4_sitl_default` |
| `CLOUD_SIM_WORLD` | default | PX4 gz world |
| `CLOUD_SIM_REQUIRE_FIREWALL_ACK` | false | set true on servers after applying the rule below |

Measured on the dev laptop (2026-10-18, one headless x500, default
world): ready in 14.7 s, about 0.95 CPU core in lockstep at real time,
about 245 MB RSS (gz server ~220 MB, PX4 ~20 MB). Size
`CLOUD_SIM_MAX_GLOBAL` to the cores left after vision inference: on a
dedicated 32-core box with GPU inference, 16-24 is a reasonable start;
keep 2 on a laptop. A real-time factor below 1 (too many instances)
stretches PX4's clock and heartbeats: watch for MAVSDK "heartbeats timed
out" in the log.

**Firewall (required on a server).** PX4's MAVLink module binds its port
on 0.0.0.0 (this PX4 tree has no loopback-only option) and, once its
partner is set, still accepts datagrams from ANY source. So anyone who
can reach the server on the block can send MAVLink, including commands,
to a customer's sim while the backend link is live. Firewall the block to
loopback, then set `CLOUD_SIM_REQUIRE_FIREWALL_ACK=true`; until then the
backend logs a warning at every startup. Example (nftables, default
block 15000-15639; the backend never changes firewall settings itself):

```
nft add table inet hyrak_cloud_sim
nft add chain inet hyrak_cloud_sim input '{ type filter hook input priority 0; policy accept; }'
nft add rule inet hyrak_cloud_sim input iifname != "lo" udp dport 15000-15639 drop
```

## 8d. Phase 2b: customer missions and permits (as built)

Goal: Fly, Mission, AI, Config and Settings are every customer's. A
customer plans, saves and flies their own missions with what a
QGroundControl / Mission Planner user expects, and asks for permission to
cross restricted airspace; staff keep working as before.

### Missions, pads and route profiles belong to a workspace

Migration `a7d3e9b1c4f2` adds `workspace_id` (cascade with the workspace;
every existing row goes to HYRAK) to `missions`, `pads`, `route_profiles`
and `permits`, plus `missions.name`. Pad and profile names are unique per
workspace (two customers may each have a "Home" pad).

Who reads and writes which workspace's plans is `app/planner/scope.py`:

| | read | write |
|---|---|---|
| a customer workspace | `view` on it (viewers included) | `plan` on it (pilot, admin, owner, manager, founder) |
| HYRAK's own plans (delivery legs, pads, stations, the builtin profiles) | staff (compat viewer), as before | compat operator, as before |
| staff on a customer workspace | every workspace's, as before (compat viewer) | only with `plan` there (managers, founders) |

* A request names its workspace (`workspace_id`, query or body). Without
  one, staff act on HYRAK and a customer on the first of their own
  memberships (grant order) that allows the action, the same pick as the
  live session. Unknown or invisible workspace: 404; visible without the
  right: 403.
* **HYRAK's pads and route profiles are shared vocabulary**: listed to
  every planner next to their own (`global: true`, `editable: false`) and
  never writable by customers (403). Only these two kinds of row are
  global; HYRAK's missions and permits are 404 to customers.
* **Map features** stay global, read-only land-use data: `GET
  /api/map-features` is open to any signed-in account; writes stay
  operator.
* **Deliveries stay HYRAK's**: `/api/tasks*`, `/v1` and the delivery
  planner resolve HYRAK's pads and stations only; a customer pad is never
  a delivery address. Stations can only be created on HYRAK.

REST (all `require_signed_in`, decided by the scope):

* `POST /api/missions/plan` `{..., workspace_id?, name?}`: needs `plan`.
  Profiles resolve among HYRAK's and the workspace's own (the workspace's
  wins a name clash); a `drone_id` must be a drone of that workspace (409).
  `requested_by` defaults to the caller's username.
* `POST /api/missions` `{name, waypoints, workspace_id?, drone_id?}`: save
  a hand-drawn plan (the Mission tab's library). Waypoints are validated
  (finite, in range, at most 500) and keep `turn_radius`; distance,
  duration and the zones crossed are computed on the server.
* `GET /api/missions?workspace_id=&status=&drone_id=`: one workspace's,
  each with `editable`. Staff without `workspace_id`: every workspace's.
* `GET|PATCH|DELETE /api/missions/{id}`: PATCH `{name?, waypoints?
  (planned only), drone_id? (null clears), status?}`. DELETE is refused
  (409) while flying or while a delivery order uses it; permits that named
  it keep their frozen waypoints.
* `GET /api/pads?workspace_id=`, `POST /api/pads {..., workspace_id?}`,
  `PATCH|DELETE /api/pads/{id}`; `GET /api/planner/meta?workspace_id=`
  (profiles with `global`, `editable`), `POST /api/route-profiles {...,
  workspace_id?}`, `PATCH|DELETE /api/route-profiles/{id}` (deleting a
  profile clears it from missions; their `profile_name` stays).
* `POST /api/zones/check-path` `{waypoints, workspace_id?, drone_id?}`:
  `{zone_class, zones, needs, permit, workspace_id}` with `needs` one of
  `none`, `ack` (orange: acknowledge at upload, or a permit), `permit`
  (red: an approved permit), `prohibited`. `permit` is the approved,
  in-window permit of the workspace (and drone) covering the path. Zone
  entries now carry `permission_required`, `floor_m`, `ceiling_m`.

### Socket

* `upload_mission` is a **session command with drone access**
  (`socket_classes.SESSION_COMMAND`, in `DRONE_EVENTS`): `fly` on the
  session workspace (staff: operator) and `fly` on the drone's workspace.
  The completeness test now counts 20 session commands and 27 + 4 staff
  events. Staff uploads to a customer's drone they cannot fly are refused
  too (`drone_not_in_workspace`), as for every drone event.
* Every upload (socket, swarm, the fleet's `/api/fleet/{id}/fly`) goes
  through one gate, `permits.gate_upload`: red is refused unless an
  approved, in-window permit of the drone's workspace covers it; orange
  needs `ack_orange` unless a permit covers it too; a red zone with
  `permission_required = false` is refused outright (`prohibited: true`,
  `can_request: false`). The result shape is the old one (`blocked`,
  `can_request`, `needs_ack`, `zones`, `msg`) plus `prohibited`,
  `permit_check_failed` and, on success, `permit_id`.
* A successful upload marks a planned mission `uploaded` only within the
  drone's workspace (one workspace's upload never advances another's
  identical plan).
* `request_permit` / `list_my_permits` stay staff-only (swarm and fleet
  drones; a socket request gets a 24 h window). Customers, and the
  Mission tab for a single drone, use REST.

### Permits

A permit is for a **mission** (frozen waypoints; matched within GPS-noise
tolerance, any edit invalidates it) or an **area** (a polygon: any path
inside it). It belongs to a workspace and optionally one drone (null =
any drone of the workspace), names the zones it covers (orange, and red
with `permission_required`), and has a window `[valid_from, valid_until)`
(required for new requests, at most 30 days).

Statuses: `pending -> approved | denied | withdrawn`, `approved -> revoked
| withdrawn | superseded`. `expired` is shown (`status_effective`), not
stored: an approved permit past its window.

* **Request** `POST /api/permits {workspace_id?, description, valid_from?,
  valid_until, drone_id?, and waypoints | mission_id (+ waypoints) |
  area}`: `plan` on the workspace (HYRAK: operator). `workspace_id`
  defaults to the drone's. Refused: no restricted zone crossed (400), a
  prohibited zone (409), a drone of another workspace (409).
* **List** `GET /api/permits?workspace_id=` that workspace's (read access
  to its plans; customers see their own and their status). Without
  `workspace_id`: the caller's decision queue, every permit they may
  decide (founders: all). Items add `status_effective`, `in_window`,
  `workspace_name`, `drone_name`, `can_decide`.
* **Decide** `POST /api/permits/{id}/decision {approve, note?}` (pending:
  approve / deny; approved: `approve: false` revokes). Who: anyone with
  `permits.approve` covering the **restricted footprint** - the flight's
  path (widened by the 20 m corridor) or area, intersected with the zones
  the permit names - by `perms.check_area`: founders anywhere, airspace
  managers inside their area (any workspace), managers of the workspace
  (or an ancestor) inside their membership area, else the workspace's
  operating area. **Nobody but a founder decides their own request.**
  Approval records each zone's current class, `floor_m` and `ceiling_m`
  on the permit and is refused if a zone became prohibited meanwhile.
* **Withdraw** `POST /api/permits/{id}/withdraw`: `plan` on its workspace,
  or the requester.
* **Audit**: `permit.request`, `permit.approve`, `permit.deny`,
  `permit.revoke`, `permit.withdraw`, `permit.supersede` rows in
  `audit_events`, on the permit's workspace.

**Honoured** (upload gate, arm / takeoff in a red zone, the in-flight zone
monitor) only when all hold: status `approved`, inside the window, the
permit's workspace is the drone's **current** workspace (a moved drone
leaves its permits behind), the drone matches (or the permit is for any
drone), the path matches (mission) or stays inside the area, every zone
needing cover is named on the permit, and each such zone is **live with
exactly the recorded class and altitudes** and still admits a permit. A
permit recorded before 8b has no altitudes and exempts nothing.

* **Zone edits supersede.** Changing a zone's `zone_class`,
  `permission_required`, `floor_m` or `ceiling_m` first marks every
  approved permit naming it `superseded` (audited); if that cannot be
  written the edit is refused (503) and the zone stays as it was. Geometry
  changes are delete + redraw, a new zone no permit names.
* **Zone monitor.** A zone named by an honoured permit does not count
  while the aircraft is within 30 m of the mission permit's path or inside
  the area permit's polygon (5 m slack): no warning, no pushback (it says
  "under permit" instead, `zone_status.permitted_zones`). Leaving the
  footprint, the window ending, a revocation or a zone change makes the
  zone count again. The monitor caches a drone's permits for 15 s and
  refetches at once after any permit write; it **fails closed**: a failed
  refetch does not refresh the cache, and the cached answer is used only
  while no permit was written since and it is under 30 s old.
* **Arm / takeoff in a red zone** read the permits fresh; if they cannot
  be read the action is refused with a clear message. The upload gate
  likewise refuses red when permits cannot be read (orange can still be
  acknowledged).
* **Zones** gain `permission_required` (default true; only meaningful on
  red): false = prohibited, no permit can be requested or approved. The
  console's zone editor sets it ("Prohibited - no permits").
* **Known limit:** the PX4 exclusion fence uploaded at connect still holds
  every red zone, permitted or not; a permitted red crossing is cleared by
  the server (upload, arm, monitor) but PX4's own geofence still reacts
  (GF_ACTION). Re-uploading the fence per permit is a separate,
  flight-tested change.

### Frontend

* Customers get the Mission tab in both UI modes (dev: Mission; normal:
  Plan); the 2a redirect is gone. Deliver stays staff-only.
* On the Mission tab, for the session's workspace: waypoint planning
  (map, list, editor, survey grid, import / export `.plan`, terrain
  follow, auto heading, 2D / 3D), **Plans** (open, save as new, save
  over, rename, delete the workspace's saved missions), the **airspace
  bar** (live zone check with an orange / red / prohibited explanation,
  the covering permit, **Request permit** with purpose, window and drone,
  **Permits** with status, load a permitted plan, withdraw), an
  **altitude profile**, and upload / start / pause / RTL to their own
  drone. A red upload refusal opens the permit dialog.
* Viewers get read-only plans: open and inspect, no map edits, disabled
  waypoint fields, no import / clear / upload / start / RTL (pause stays:
  a safety action).
* Hidden for customers: obstacle avoidance, the fleet mission panel, the
  "Connect SITL" (server udp) button (they get a pointer to connect
  their own drone).
* The Command tab's mission bar links to the Mission / Plan tab.
* Console PERMITS tab: visible to anyone with `permits.approve` (founders,
  airspace managers, managers); shows the caller's decision queue with
  workspace, drone, requester, window and zones, takes a note with
  approve / deny, revokes approved permits. A permit the caller requested
  shows as someone else's to decide.

### Tests

`tests/test_mission_permits.py` (no database): planning scope, permit
window / drone / coverage / live-zone rules, decision area rules (founder,
airspace in / out, manager of the workspace, other workspace's manager,
customer owner, self-approval), the upload gate, the monitor standing down
only under a permit and failing closed (revoke during cache, fetch
failure, generation change), arm / upload refusals when permits cannot be
read, refused zone edit when supersede fails, `upload_mission` as a
session command with drone access on the real handler.
`tests/test_planning_db.py` (opt in, `HYRAK_TEST_DATABASE_URL`): HTTP
isolation of missions, pads and profiles, and request -> decide -> honour
with expiry, revoke, deny, withdraw, supersede on a zone edit, and their
audit rows.

## 9. Scaling to a dedicated server

* Workspaces, memberships and tokens live in Postgres; permission checks are
  pure functions over a user's memberships (cached with the token for 60 s),
  so any number of API workers can evaluate them.
* Subtree queries use the materialized `path` with a prefix index; no
  recursive queries on the hot path.
* Still per-process today and to move to Redis when running more than one
  backend process: the login rate limiter, the 60 s token cache, Socket.IO
  rooms (needs sticky sessions plus the Redis adapter) and live sessions.
  This is the main item before horizontal scaling, independent of this
  design.
* Model storage per workspace (`orgs/<workspace_id>/models/...`) and quotas
  hang off the workspace id; see `docs/custom_models/DESIGN.md`.

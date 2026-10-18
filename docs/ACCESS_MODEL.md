# Access model: workspaces, roles, portals

Status: design agreed 2026-10-18, phase 1 being built on `feat/workspaces`.
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
| anything else | viewer |

So in phase 1 a customer can sign in, see their workspace, members, drones
and zones, and invite people, but cannot command drones yet; HYRAK staff fly
as today. Phase 2 scopes every live path by the drone's workspace
(`fly` on that workspace), gives customers flying rights on their own drones,
scopes recordings / vision history / flights per workspace, and adds TOTP.
Phase 3 adds Google sign-in and outgoing email.

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

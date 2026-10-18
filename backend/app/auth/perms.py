"""
The permission engine: who may do what on which workspace.

Pure functions over a user's memberships and a workspace, no database and
no FastAPI, so every rule in docs/ACCESS_MODEL.md section 2 and 3 can be
unit-tested on its own and evaluated by any number of API workers from the
memberships cached with the token.

Vocabulary:
  * A membership is one role on one workspace, optionally limited to a
    GeoJSON area. Anything with the attributes `workspace_id`,
    `workspace_path`, `workspace_kind`, `role`, `area` and (optionally)
    `workspace_disabled` works; the store's MembershipRecord is one.
  * A workspace is anything with `id`, `kind`, `path`, `operating_area` and
    `disabled`, where `disabled` means "this workspace or an ancestor is
    disabled" (the caller resolves the chain).
  * Checks in code are on permissions, never on role names. Role names
    appear only in the tables below and in the grant rules.

Inheritance: a membership covers its workspace and every workspace below it
(prefix match on the materialized path), EXCEPT memberships on the platform
workspace, which do not inherit downward unless they are founder. Staff
reach a customer only through an explicit manager membership, or an
airspace area for zones.

Decisions carry an HTTP-ish status so routes can map them without
re-deriving why: 400 malformed request, 403 not allowed, 409 a rule
violation (last owner, outside the area, no area set).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

# ── Workspace kinds ───────────────────────────────────────────────────────

PLATFORM = "platform"
ORGANIZATION = "organization"
INDIVIDUAL = "individual"
CLIENT = "client"
KINDS = (PLATFORM, ORGANIZATION, INDIVIDUAL, CLIENT)

# Which kinds may sit directly under which.
CHILD_KINDS: dict[str, tuple[str, ...]] = {
    PLATFORM: (ORGANIZATION, INDIVIDUAL),
    ORGANIZATION: (CLIENT,),
    INDIVIDUAL: (),
    CLIENT: (),
}

# ── Roles ─────────────────────────────────────────────────────────────────

FOUNDER = "founder"
AIRSPACE = "airspace"
MANAGER = "manager"
OWNER = "owner"
ADMIN = "admin"
PILOT = "pilot"
VIEWER = "viewer"
ALL_ROLES = (FOUNDER, AIRSPACE, MANAGER, OWNER, ADMIN, PILOT, VIEWER)

STAFF_ROLES = (FOUNDER, AIRSPACE, PILOT, VIEWER)            # on the platform workspace
CUSTOMER_ROLES = (MANAGER, OWNER, ADMIN, PILOT, VIEWER)     # everywhere else

# Roles whose membership may carry an area. Airspace must; manager may.
AREA_ROLES = (AIRSPACE, MANAGER)

# Display strength, for "my_role" when several memberships apply. Not used
# for any permission decision.
_ROLE_STRENGTH = {FOUNDER: 100, MANAGER: 60, OWNER: 50, ADMIN: 40, PILOT: 30,
                  AIRSPACE: 20, VIEWER: 10}


def roles_for_kind(kind: str) -> tuple[str, ...]:
    return STAFF_ROLES if kind == PLATFORM else CUSTOMER_ROLES


# ── Permissions ───────────────────────────────────────────────────────────

VIEW = "view"
FLY = "fly"
PLAN = "plan"
MODELS_RUN = "models.run"
MODELS_MANAGE = "models.manage"
DRONES_MANAGE = "drones.manage"
MEMBERS_MANAGE = "members.manage"
CHILDREN_MANAGE = "children.manage"
ZONES_SITE = "zones.site"
ZONES_AREA = "zones.area"
PERMITS_APPROVE = "permits.approve"
WORKSPACE_OPERATING_AREA = "workspace.operating_area"
AUDIT_VIEW = "audit.view"
WORKSPACE_DELETE = "workspace.delete"
ZONES_REGULATORY = "zones.regulatory"
STAFF_MANAGE = "staff.manage"
ACCOUNTS = "accounts"

ALL_PERMS = frozenset({
    VIEW, FLY, PLAN, MODELS_RUN, MODELS_MANAGE, DRONES_MANAGE, MEMBERS_MANAGE,
    CHILDREN_MANAGE, ZONES_SITE, ZONES_AREA, PERMITS_APPROVE,
    WORKSPACE_OPERATING_AREA, AUDIT_VIEW, WORKSPACE_DELETE, ZONES_REGULATORY,
    STAFF_MANAGE, ACCOUNTS,
})

# Permissions that only hold inside a geographic area.
AREA_PERMS = frozenset({ZONES_SITE, ZONES_AREA, PERMITS_APPROVE})

_RUN = frozenset({VIEW, FLY, PLAN, MODELS_RUN})
_ADMIN = _RUN | {MODELS_MANAGE, DRONES_MANAGE, MEMBERS_MANAGE, CHILDREN_MANAGE,
                 ZONES_SITE, AUDIT_VIEW}

# The matrix in docs/ACCESS_MODEL.md section 2, verbatim.
ROLE_PERMS: dict[str, frozenset[str]] = {
    FOUNDER: ALL_PERMS,
    AIRSPACE: frozenset({ZONES_AREA, PERMITS_APPROVE}),
    MANAGER: _ADMIN | {ZONES_AREA, PERMITS_APPROVE, WORKSPACE_OPERATING_AREA},
    OWNER: _ADMIN | {WORKSPACE_DELETE},
    ADMIN: _ADMIN,
    PILOT: _RUN,
    VIEWER: frozenset({VIEW}),
}

# Who may grant (and edit / remove) which roles on a workspace they hold
# the key role on. Founders may grant anything valid for the kind; manager
# and airspace are founder-only.
_GRANTS: dict[str, frozenset[str]] = {
    MANAGER: frozenset({OWNER, ADMIN, PILOT, VIEWER}),
    OWNER: frozenset({OWNER, ADMIN, PILOT, VIEWER}),
    ADMIN: frozenset({ADMIN, PILOT, VIEWER}),
}


# ── Decisions ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Decision:
    ok: bool
    status: int = 200
    reason: str = ""

    def __bool__(self) -> bool:       # `if decision:` reads naturally
        return self.ok


ALLOW = Decision(True)


def deny(status: int, reason: str) -> Decision:
    return Decision(False, status, reason)


# ── Membership helpers ────────────────────────────────────────────────────

def _is_platform_membership(m) -> bool:
    return getattr(m, "workspace_kind", None) == PLATFORM


def is_founder(memberships: Iterable) -> bool:
    return any(m.role == FOUNDER and _is_platform_membership(m) for m in memberships)


def is_staff(memberships: Iterable) -> bool:
    """Anyone with any membership on the platform workspace."""
    return any(_is_platform_membership(m) for m in memberships)


def compat_role(memberships: Iterable) -> str:
    """The viewer / operator / admin rank the live control paths still use
    in phase 1 (docs/ACCESS_MODEL.md section 8)."""
    ms = list(memberships)
    if is_founder(ms):
        return "admin"
    # Manager counts only while the account is still staff. It is granted
    # only to staff, but an account removed from HYRAK keeps its manager
    # rows until someone cleans them up, and the compatibility rank is what
    # every staff-only path checks (phase 2a: operator and above = staff).
    staff = is_staff(ms)
    for m in ms:
        if getattr(m, "workspace_disabled", False):
            continue
        if (m.role == PILOT and _is_platform_membership(m)) or (m.role == MANAGER and staff):
            return "operator"
    # Any other HYRAK membership (viewer, airspace) is staff and keeps the
    # viewer rank. A customer-only account gets "member", below viewer: the
    # live paths (sessions, telemetry, recordings, flights) are not scoped
    # per workspace until phase 2, so a viewer rank would let a customer
    # watch HYRAK's and other customers' drones.
    if any(_is_platform_membership(m) and not getattr(m, "workspace_disabled", False) for m in ms):
        return "viewer"
    return "member"


def applicable(memberships: Iterable, ws) -> list[tuple[object, bool]]:
    """The memberships that apply on `ws`, each with `inherited` (True when it
    reaches ws from an ancestor). Implements the platform non-inheritance
    rule and the disabled-workspace rule (only founders and managers keep
    any power on a disabled workspace, so they can re-enable it)."""
    out: list[tuple[object, bool]] = []
    path = ws.path or ""
    for m in memberships:
        if m.role not in ROLE_PERMS:
            continue
        if m.workspace_id == ws.id:
            inherited = False
        elif m.role == FOUNDER and _is_platform_membership(m):
            inherited = True                       # founders reach everything
        elif (not _is_platform_membership(m) and m.workspace_path
              and path.startswith(m.workspace_path)):
            inherited = True
        else:
            continue
        if getattr(ws, "disabled", False) and m.role not in (FOUNDER, MANAGER):
            continue
        out.append((m, inherited))
    return out


def effective_perms(memberships: Iterable, ws) -> frozenset[str]:
    perms: set[str] = set()
    for m, _ in applicable(memberships, ws):
        perms |= ROLE_PERMS[m.role]
    return frozenset(perms)


def can(memberships: Iterable, ws, perm: str) -> bool:
    return perm in effective_perms(memberships, ws)


def visible(memberships: Iterable, ws) -> bool:
    """Whether the workspace exists as far as this user is concerned. Callers
    return 404, not 403, for an invisible workspace (no existence leak)."""
    return bool(effective_perms(memberships, ws))


def my_role(memberships: Iterable, ws) -> tuple[Optional[str], bool]:
    """(strongest applicable role, inherited). A direct membership wins a tie."""
    best = None
    for m, inherited in applicable(memberships, ws):
        key = (_ROLE_STRENGTH.get(m.role, 0), not inherited)
        if best is None or key > best[0]:
            best = (key, m.role, inherited)
    if best is None:
        return None, False
    return best[1], best[2]


# ── Geometry ──────────────────────────────────────────────────────────────

MAX_AREA_VERTICES = 2000


def _shape(geojson):
    from shapely.geometry import shape
    return shape(geojson)


def validate_area(geojson, *, field: str = "area") -> Optional[str]:
    """None when `geojson` is a usable GeoJSON Polygon / MultiPolygon in
    lng/lat degrees, else a human-readable reason. Used for membership
    areas, operating areas, invite areas and zone geometry alike."""
    if not isinstance(geojson, dict) or geojson.get("type") not in ("Polygon", "MultiPolygon"):
        return f"{field} must be a GeoJSON Polygon or MultiPolygon"
    coords = geojson.get("coordinates")
    if not isinstance(coords, list) or not coords:
        return f"{field} has no coordinates"
    polygons = coords if geojson["type"] == "MultiPolygon" else [coords]
    n = 0
    try:
        for poly in polygons:
            for ring in poly:
                for pt in ring:
                    n += 1
                    if n > MAX_AREA_VERTICES:
                        return f"{field} has more than {MAX_AREA_VERTICES} vertices"
                    lng, lat = float(pt[0]), float(pt[1])
                    if not (-180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0):
                        return f"{field} has a point outside longitude/latitude range"
    except (TypeError, ValueError, IndexError):
        return f"{field} has malformed coordinates"
    try:
        geom = _shape(geojson)
    except Exception as e:
        return f"{field} is not a valid polygon ({e})"
    if geom.is_empty or not geom.is_valid:
        return f"{field} is not a valid polygon (self-intersecting or empty)"
    return None


def _covered(bounds: list, geom) -> bool:
    from shapely.ops import unary_union
    try:
        union = unary_union([_shape(b) for b in bounds])
    except Exception:
        return False
    return union.covers(geom)


def check_area(memberships: Iterable, ws, perm: str, geometry) -> Decision:
    """May this user exercise an area permission (zones.site, zones.area,
    permits.approve) on `ws` for `geometry` (GeoJSON or a shapely shape)?

    * founders: anywhere.
    * zones.site: inside the workspace's operating area.
    * zones.area / permits.approve: inside the membership's own area, else
      inside the workspace's operating area. HYRAK airspace memberships
      apply on every workspace, always with their own (required) area.
    * a role that would allow it but has no area to bound it gets a 409
      saying so, rather than an unlimited pass.
    """
    ms = list(memberships)
    if perm not in AREA_PERMS:
        raise ValueError(f"{perm} is not an area permission")
    if is_founder(ms):
        return ALLOW
    candidates = [m for m, _ in applicable(ms, ws) if perm in ROLE_PERMS[m.role]]
    if perm in (ZONES_AREA, PERMITS_APPROVE):
        for m in ms:
            if m.role == AIRSPACE and _is_platform_membership(m) and m not in candidates:
                candidates.append(m)
    if not candidates:
        return deny(403, "Your role does not allow this on this workspace")
    bounds = []
    for m in candidates:
        if perm == ZONES_SITE:
            b = ws.operating_area
        elif m.role == AIRSPACE:
            b = m.area
        else:
            b = m.area or ws.operating_area
        if b:
            bounds.append(b)
    if not bounds:
        if perm == ZONES_SITE:
            return deny(409, "This workspace has no operating area yet. Ask HYRAK staff "
                             "(a founder or the workspace's manager) to set one.")
        return deny(409, "No area applies: neither your membership nor this workspace has "
                         "an area set. Ask a founder to set one.")
    geom = geometry if hasattr(geometry, "geom_type") else _shape(geometry)
    if not _covered(bounds, geom):
        return deny(409, "The shape is outside the area you may edit in")
    return ALLOW


def check_zone_layer(memberships: Iterable, ws, layer: str, geometry) -> Decision:
    """Section 3: who may create / edit / delete a zone of `layer` in `ws`."""
    ms = list(memberships)
    if layer == "regulatory":
        if is_founder(ms):
            return ALLOW
        return deny(403, "Regulatory zones are edited by founders only")
    if layer == "area":
        return check_area(ms, ws, ZONES_AREA, geometry)
    if layer == "site":
        return check_area(ms, ws, ZONES_SITE, geometry)
    return deny(400, "layer must be regulatory, area or site")


# ── Grant rules ───────────────────────────────────────────────────────────

def grantable_roles(memberships: Iterable, ws) -> frozenset[str]:
    """Roles this user may grant, edit or remove on `ws`."""
    ms = list(memberships)
    valid = frozenset(roles_for_kind(ws.kind))
    if is_founder(ms):
        return valid
    out: set[str] = set()
    for m, _ in applicable(ms, ws):
        out |= _GRANTS.get(m.role, frozenset())
    return frozenset(out) & valid


def check_membership_change(
    memberships: Iterable, ws, *,
    actor_id: str,
    target_user_id: str,
    new_role: Optional[str] = None,
    old_role: Optional[str] = None,
    area=None,
    grantee_is_staff: bool = False,
    owners_after: Optional[int] = None,
    founders_after: Optional[int] = None,
) -> Decision:
    """Add (old_role None), edit (both), or remove (new_role None) a
    membership. `owners_after` / `founders_after` are the counts the
    workspace / platform would be left with, for the last-owner and
    last-founder rules."""
    ms = list(memberships)
    founder = is_founder(ms)
    if new_role is not None and new_role not in roles_for_kind(ws.kind):
        return deny(400, f"{new_role} is not a valid role on a {ws.kind} workspace "
                         f"(use one of: {', '.join(roles_for_kind(ws.kind))})")
    if actor_id == target_user_id:
        return deny(403, "You cannot change your own memberships")
    allowed = grantable_roles(ms, ws)
    if not allowed:
        return deny(403, "You cannot manage members of this workspace")
    if old_role is not None and old_role not in allowed:
        return deny(403, f"You cannot change a {old_role} membership")
    if new_role is not None and new_role not in allowed:
        return deny(403, f"You cannot grant the {new_role} role")
    if new_role == MANAGER and not grantee_is_staff:
        return deny(409, "The manager role is granted only to HYRAK staff")
    if new_role is not None and area is not None and new_role not in AREA_ROLES:
        return deny(400, "Only airspace and manager memberships carry an area")
    if new_role == AIRSPACE and not area:
        return deny(400, "An airspace membership needs an area")
    if old_role == OWNER and new_role != OWNER and owners_after == 0 and not founder:
        return deny(409, "This is the last owner of the workspace; add another owner first")
    if old_role == FOUNDER and new_role != FOUNDER and founders_after == 0:
        return deny(409, "This is the last founder; add another founder first")
    return ALLOW


def check_invite(memberships: Iterable, ws, role: str, area=None) -> Decision:
    """May this user create an invite for `role` on `ws`? Same rules as a
    direct grant, except manager, which only goes to existing staff and so
    is granted directly rather than by link."""
    ms = list(memberships)
    if role not in roles_for_kind(ws.kind):
        return deny(400, f"{role} is not a valid role on a {ws.kind} workspace")
    if role == MANAGER:
        return deny(409, "The manager role is granted directly to a staff account, not by invite")
    allowed = grantable_roles(ms, ws)
    if not allowed:
        return deny(403, "You cannot invite people to this workspace")
    if role not in allowed:
        return deny(403, f"You cannot invite someone as {role}")
    if area is not None and role not in AREA_ROLES:
        return deny(400, "Only airspace and manager memberships carry an area")
    if role == AIRSPACE and not area:
        return deny(400, "An airspace invite needs an area")
    return ALLOW


def check_create_workspace(memberships: Iterable, parent, kind: str) -> Decision:
    """Top-level workspaces (organization, individual) are founders' to
    create; clients need children.manage on the parent organization."""
    ms = list(memberships)
    if kind not in KINDS or kind == PLATFORM:
        return deny(400, "kind must be organization, individual or client")
    if kind not in CHILD_KINDS.get(parent.kind, ()):
        return deny(400, f"A {kind} workspace cannot sit under a {parent.kind} workspace")
    if parent.kind == PLATFORM:
        return ALLOW if is_founder(ms) else deny(403, "Only founders create top-level workspaces")
    if can(ms, parent, CHILDREN_MANAGE):
        return ALLOW
    return deny(403, "You cannot add clients to this workspace")

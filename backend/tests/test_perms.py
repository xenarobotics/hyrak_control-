"""
The pure permission engine (app/auth/perms.py): the role matrix, the
inheritance rule and its platform exception, area containment, grant rules
and the compatibility role. No database, no app.
"""
from dataclasses import dataclass
from typing import Optional

import pytest

from app.auth import perms as P

ROOT = "root"


@dataclass(frozen=True)
class WS:
    id: str
    kind: str
    path: str
    operating_area: Optional[dict] = None
    disabled: bool = False
    name: str = ""


@dataclass(frozen=True)
class M:
    workspace_id: str
    workspace_path: str
    workspace_kind: str
    role: str
    area: Optional[dict] = None
    workspace_disabled: bool = False


def box(x0, y0, x1, y1):
    return {"type": "Polygon",
            "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


HYRAK = WS(ROOT, P.PLATFORM, f"/{ROOT}/")
IITH = WS("iith", P.ORGANIZATION, f"/{ROOT}/iith/", operating_area=box(78, 17, 79, 18))
CIVIL = WS("civil", P.CLIENT, f"/{ROOT}/iith/civil/", operating_area=box(78.1, 17.1, 78.5, 17.5))
SKY = WS("sky", P.ORGANIZATION, f"/{ROOT}/sky/")
KUMAR = WS("kumar", P.INDIVIDUAL, f"/{ROOT}/kumar/")


def on(ws, role, area=None):
    return M(ws.id, ws.path, ws.kind, role, area)


# ── the matrix ────────────────────────────────────────────────────────────

MATRIX = {
    # permission:          founder airspace manager owner admin pilot viewer
    "view":                (1, 0, 1, 1, 1, 1, 1),
    "fly":                 (1, 0, 1, 1, 1, 1, 0),
    "plan":                (1, 0, 1, 1, 1, 1, 0),
    "models.run":          (1, 0, 1, 1, 1, 1, 0),
    "models.manage":       (1, 0, 1, 1, 1, 0, 0),
    "drones.manage":       (1, 0, 1, 1, 1, 0, 0),
    "members.manage":      (1, 0, 1, 1, 1, 0, 0),
    "children.manage":     (1, 0, 1, 1, 1, 0, 0),
    "zones.site":          (1, 0, 1, 1, 1, 0, 0),
    "zones.area":          (1, 1, 1, 0, 0, 0, 0),
    "permits.approve":     (1, 1, 1, 0, 0, 0, 0),
    "workspace.operating_area": (1, 0, 1, 0, 0, 0, 0),
    "audit.view":          (1, 0, 1, 1, 1, 0, 0),
    "workspace.delete":    (1, 0, 0, 1, 0, 0, 0),
    "zones.regulatory":    (1, 0, 0, 0, 0, 0, 0),
    "staff.manage":        (1, 0, 0, 0, 0, 0, 0),
    "accounts":            (1, 0, 0, 0, 0, 0, 0),
}
ORDER = ("founder", "airspace", "manager", "owner", "admin", "pilot", "viewer")


@pytest.mark.parametrize("perm", sorted(MATRIX))
def test_role_matrix_matches_the_design_doc(perm):
    for role, expected in zip(ORDER, MATRIX[perm]):
        assert (perm in P.ROLE_PERMS[role]) == bool(expected), (perm, role)


def test_matrix_covers_every_permission():
    assert set(MATRIX) == set(P.ALL_PERMS)


def test_roles_per_kind():
    assert P.roles_for_kind(P.PLATFORM) == ("founder", "airspace", "pilot", "viewer")
    for kind in (P.ORGANIZATION, P.INDIVIDUAL, P.CLIENT):
        assert P.roles_for_kind(kind) == ("manager", "owner", "admin", "pilot", "viewer")


# ── inheritance ───────────────────────────────────────────────────────────

def test_customer_membership_inherits_down_the_tree():
    ms = [on(IITH, "admin")]
    assert P.can(ms, IITH, "members.manage")
    assert P.can(ms, CIVIL, "members.manage")              # IITH admin manages its clients
    assert not P.visible(ms, SKY) and not P.visible(ms, HYRAK)
    assert P.my_role(ms, CIVIL) == ("admin", True)
    assert P.my_role(ms, IITH) == ("admin", False)


def test_child_membership_does_not_reach_up():
    ms = [on(CIVIL, "owner")]
    assert P.can(ms, CIVIL, "workspace.delete")
    assert not P.visible(ms, IITH)


def test_platform_memberships_do_not_inherit_except_founders():
    pilot = [on(HYRAK, "pilot")]
    assert P.can(pilot, HYRAK, "fly")
    assert not P.visible(pilot, IITH) and not P.visible(pilot, CIVIL)
    viewer = [on(HYRAK, "viewer")]
    assert not P.visible(viewer, IITH)
    airspace = [on(HYRAK, "airspace", box(0, 0, 1, 1))]
    assert not P.visible(airspace, IITH)
    founder = [on(HYRAK, "founder")]
    for ws in (HYRAK, IITH, CIVIL, SKY, KUMAR):
        assert P.effective_perms(founder, ws) == P.ALL_PERMS
    assert P.my_role(founder, CIVIL) == ("founder", True)


def test_staff_reach_a_customer_only_through_manager():
    ms = [on(HYRAK, "pilot"), on(IITH, "manager")]
    assert P.can(ms, IITH, "fly") and P.can(ms, CIVIL, "fly")
    assert not P.visible(ms, SKY)


def test_permissions_union_across_memberships_and_direct_wins_tie():
    ms = [on(IITH, "viewer"), on(CIVIL, "pilot")]
    assert P.can(ms, CIVIL, "fly") and not P.can(ms, IITH, "fly")
    assert P.my_role(ms, CIVIL) == ("pilot", False)
    ms = [on(IITH, "admin"), on(CIVIL, "admin")]
    assert P.my_role(ms, CIVIL) == ("admin", False)


def test_disabled_workspace_keeps_only_founders_and_managers():
    off = WS("off", P.ORGANIZATION, f"/{ROOT}/off/", disabled=True)
    assert not P.visible([on(off, "owner")], off)
    assert P.can([on(off, "manager")], off, "workspace.operating_area")
    assert P.visible([on(HYRAK, "founder")], off)


def test_staff_and_founder_flags():
    assert P.is_staff([on(HYRAK, "viewer")]) and not P.is_founder([on(HYRAK, "viewer")])
    assert P.is_founder([on(HYRAK, "founder")])
    assert not P.is_staff([on(IITH, "owner")])
    # "founder" on a non-platform workspace is not a founder.
    assert not P.is_founder([M("iith", IITH.path, P.ORGANIZATION, "founder")])


# ── compatibility role ────────────────────────────────────────────────────

def test_compat_role_mapping():
    assert P.compat_role([on(HYRAK, "founder")]) == "admin"
    assert P.compat_role([on(HYRAK, "pilot")]) == "operator"
    assert P.compat_role([on(IITH, "manager")]) == "operator"
    assert P.compat_role([on(HYRAK, "viewer")]) == "viewer"
    assert P.compat_role([on(HYRAK, "airspace", box(0, 0, 1, 1))]) == "viewer"
    assert P.compat_role([on(IITH, "owner")]) == "viewer"
    assert P.compat_role([on(IITH, "pilot")]) == "viewer"       # customer pilot: phase 2
    assert P.compat_role([]) == "viewer"
    assert P.compat_role([on(HYRAK, "viewer"), on(HYRAK, "founder")]) == "admin"
    off = M("off", "/root/off/", P.ORGANIZATION, "manager", workspace_disabled=True)
    assert P.compat_role([off]) == "viewer"


# ── area checks ───────────────────────────────────────────────────────────

INSIDE_CIVIL = box(78.2, 17.2, 78.3, 17.3)
INSIDE_IITH_OUTSIDE_CIVIL = box(78.7, 17.7, 78.8, 17.8)
OUTSIDE_ALL = box(10, 10, 11, 11)


def test_founder_draws_anywhere():
    f = [on(HYRAK, "founder")]
    for layer in ("regulatory", "area", "site"):
        assert P.check_zone_layer(f, SKY, layer, OUTSIDE_ALL).ok


def test_regulatory_is_founder_only():
    d = P.check_zone_layer([on(IITH, "manager")], IITH, "regulatory", INSIDE_CIVIL)
    assert not d.ok and d.status == 403


def test_site_zones_inside_operating_area_only():
    owner = [on(CIVIL, "owner")]
    assert P.check_zone_layer(owner, CIVIL, "site", INSIDE_CIVIL).ok
    d = P.check_zone_layer(owner, CIVIL, "site", INSIDE_IITH_OUTSIDE_CIVIL)
    assert not d.ok and d.status == 409 and "outside" in d.reason
    # Inherited: an IITH admin draws site zones in the client's area.
    assert P.check_zone_layer([on(IITH, "admin")], CIVIL, "site", INSIDE_CIVIL).ok
    # Pilots cannot draw site zones; owners cannot draw area zones.
    assert P.check_zone_layer([on(CIVIL, "pilot")], CIVIL, "site", INSIDE_CIVIL).status == 403
    assert P.check_zone_layer(owner, CIVIL, "area", INSIDE_CIVIL).status == 403


def test_no_operating_area_is_a_clear_409():
    d = P.check_zone_layer([on(SKY, "owner")], SKY, "site", INSIDE_CIVIL)
    assert not d.ok and d.status == 409 and "operating area" in d.reason
    d = P.check_zone_layer([on(SKY, "manager")], SKY, "area", INSIDE_CIVIL)
    assert not d.ok and d.status == 409 and "No area applies" in d.reason


def test_manager_area_falls_back_to_operating_area():
    mgr = [on(IITH, "manager")]
    assert P.check_zone_layer(mgr, IITH, "area", INSIDE_IITH_OUTSIDE_CIVIL).ok
    assert P.check_zone_layer(mgr, IITH, "area", OUTSIDE_ALL).status == 409
    # With its own area, the membership area is what bounds it.
    small = [on(IITH, "manager", area=box(78.2, 17.2, 78.4, 17.4))]
    assert P.check_zone_layer(small, IITH, "area", INSIDE_CIVIL).ok
    assert P.check_zone_layer(small, IITH, "area", INSIDE_IITH_OUTSIDE_CIVIL).status == 409


def test_airspace_area_applies_on_every_workspace():
    air = [on(HYRAK, "airspace", area=box(78, 17, 78.5, 17.5))]
    assert P.check_zone_layer(air, HYRAK, "area", INSIDE_CIVIL).ok
    assert P.check_zone_layer(air, IITH, "area", INSIDE_CIVIL).ok     # across workspaces
    assert P.check_zone_layer(air, SKY, "area", INSIDE_CIVIL).ok
    assert P.check_zone_layer(air, IITH, "area", INSIDE_IITH_OUTSIDE_CIVIL).status == 409
    assert P.check_zone_layer(air, IITH, "site", INSIDE_CIVIL).status == 403
    assert P.check_area(air, IITH, "permits.approve", INSIDE_CIVIL).ok
    # An airspace membership without an area (should not exist) grants nothing.
    bare = [on(HYRAK, "airspace")]
    assert P.check_zone_layer(bare, HYRAK, "area", INSIDE_CIVIL).status == 409


def test_area_union_of_memberships():
    ms = [on(HYRAK, "airspace", area=box(0, 0, 1, 1)),
          on(IITH, "manager", area=box(1, 0, 2, 1))]
    assert P.check_zone_layer(ms, IITH, "area", box(0.5, 0.2, 1.5, 0.8)).ok


def test_unknown_layer():
    assert P.check_zone_layer([on(HYRAK, "founder")], HYRAK, "nope", INSIDE_CIVIL).status == 400


# ── geometry validation ───────────────────────────────────────────────────

def test_validate_area():
    assert P.validate_area(INSIDE_CIVIL) is None
    assert P.validate_area({"type": "MultiPolygon", "coordinates": [INSIDE_CIVIL["coordinates"]]}) is None
    assert "Polygon" in P.validate_area({"type": "Point", "coordinates": [1, 2]})
    assert "range" in P.validate_area(box(170, 80, 190, 85))
    assert "range" in P.validate_area(box(10, 80, 11, 95))
    bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}
    assert "valid" in P.validate_area(bowtie)
    ring = [[i * 1e-4, (i % 2) * 1e-4] for i in range(P.MAX_AREA_VERTICES + 5)]
    assert "vertices" in P.validate_area({"type": "Polygon", "coordinates": [ring]})
    assert "malformed" in P.validate_area({"type": "Polygon", "coordinates": [[["a", "b"]]]})
    assert P.validate_area(None) is not None


# ── grant rules ───────────────────────────────────────────────────────────

def change(ms, ws, **kw):
    kw.setdefault("actor_id", "actor")
    kw.setdefault("target_user_id", "target")
    return P.check_membership_change(ms, ws, **kw)


def test_founders_grant_anything_valid():
    f = [on(HYRAK, "founder")]
    for role in ("owner", "admin", "pilot", "viewer"):
        assert change(f, IITH, new_role=role).ok
    assert change(f, IITH, new_role="manager", grantee_is_staff=True).ok
    assert change(f, HYRAK, new_role="airspace", area=box(0, 0, 1, 1)).ok
    assert change(f, HYRAK, new_role="founder").ok
    # Kind validity: no founder on a customer, no owner on HYRAK.
    assert change(f, IITH, new_role="founder").status == 400
    assert change(f, HYRAK, new_role="owner").status == 400


def test_nobody_edits_their_own_membership():
    f = [on(HYRAK, "founder")]
    d = change(f, IITH, new_role="owner", target_user_id="actor")
    assert not d.ok and d.status == 403 and "own" in d.reason


def test_owner_admin_manager_grant_sets():
    assert P.grantable_roles([on(IITH, "owner")], IITH) == {"owner", "admin", "pilot", "viewer"}
    assert P.grantable_roles([on(IITH, "admin")], IITH) == {"admin", "pilot", "viewer"}
    assert P.grantable_roles([on(IITH, "manager")], IITH) == {"owner", "admin", "pilot", "viewer"}
    assert P.grantable_roles([on(IITH, "pilot")], IITH) == frozenset()
    assert P.grantable_roles([on(IITH, "owner")], CIVIL) == {"owner", "admin", "pilot", "viewer"}
    # Staff roles on HYRAK are founders' alone.
    assert P.grantable_roles([on(HYRAK, "pilot")], HYRAK) == frozenset()


def test_admin_cannot_touch_owners():
    a = [on(IITH, "admin")]
    assert change(a, IITH, new_role="owner").status == 403
    assert change(a, IITH, old_role="owner", new_role="admin").status == 403
    assert change(a, IITH, old_role="owner").status == 403              # remove
    assert change(a, IITH, old_role="pilot", new_role="admin").ok


def test_manager_and_airspace_are_founder_only_and_manager_only_to_staff():
    assert change([on(IITH, "owner")], IITH, new_role="manager", grantee_is_staff=True).status == 403
    assert change([on(IITH, "manager")], IITH, new_role="manager", grantee_is_staff=True).status == 403
    d = change([on(HYRAK, "founder")], IITH, new_role="manager", grantee_is_staff=False)
    assert d.status == 409 and "staff" in d.reason
    assert change([on(HYRAK, "founder")], HYRAK, new_role="airspace").status == 400   # area required
    # A manager cannot remove another manager.
    assert change([on(IITH, "manager")], IITH, old_role="manager").status == 403


def test_area_only_on_area_roles():
    d = change([on(HYRAK, "founder")], IITH, new_role="pilot", area=box(0, 0, 1, 1))
    assert d.status == 400


def test_last_owner_and_last_founder():
    o = [on(IITH, "owner")]
    d = change(o, IITH, old_role="owner", owners_after=0)
    assert d.status == 409 and "last owner" in d.reason
    assert change(o, IITH, old_role="owner", new_role="admin", owners_after=0).status == 409
    assert change(o, IITH, old_role="owner", owners_after=1).ok
    # A founder may remove a last owner.
    assert change([on(HYRAK, "founder")], IITH, old_role="owner", owners_after=0).ok
    # Nobody removes the last founder.
    d = change([on(HYRAK, "founder")], HYRAK, old_role="founder", founders_after=0)
    assert d.status == 409 and "last founder" in d.reason
    assert change([on(HYRAK, "founder")], HYRAK, old_role="founder", founders_after=1).ok


def test_unrelated_user_cannot_manage():
    d = change([on(SKY, "owner")], IITH, new_role="viewer")
    assert d.status == 403


def test_invite_rules():
    assert P.check_invite([on(IITH, "admin")], IITH, "pilot").ok
    assert P.check_invite([on(IITH, "admin")], IITH, "owner").status == 403
    assert P.check_invite([on(IITH, "pilot")], IITH, "viewer").status == 403
    assert P.check_invite([on(HYRAK, "founder")], IITH, "manager").status == 409
    assert P.check_invite([on(HYRAK, "founder")], HYRAK, "airspace").status == 400
    assert P.check_invite([on(HYRAK, "founder")], HYRAK, "airspace", box(0, 0, 1, 1)).ok
    assert P.check_invite([on(HYRAK, "founder")], IITH, "founder").status == 400
    assert P.check_invite([on(IITH, "manager")], CIVIL, "owner").ok


def test_create_workspace_rules():
    f = [on(HYRAK, "founder")]
    assert P.check_create_workspace(f, HYRAK, "organization").ok
    assert P.check_create_workspace(f, HYRAK, "individual").ok
    assert P.check_create_workspace(f, HYRAK, "client").status == 400
    assert P.check_create_workspace(f, IITH, "organization").status == 400
    assert P.check_create_workspace(f, KUMAR, "client").status == 400   # individuals have no children
    assert P.check_create_workspace(f, HYRAK, "platform").status == 400
    assert P.check_create_workspace([on(IITH, "admin")], IITH, "client").ok
    assert P.check_create_workspace([on(IITH, "pilot")], IITH, "client").status == 403
    assert P.check_create_workspace([on(HYRAK, "pilot")], HYRAK, "organization").status == 403

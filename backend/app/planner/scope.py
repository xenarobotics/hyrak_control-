"""
Whose planning data a request may read and write (docs/ACCESS_MODEL.md 8d).

Missions, pads, route profiles and permit requests each belong to one
workspace. The rules, over the pure permission engine (app/auth/perms.py):

  * Read a workspace's plans: `view` on it. Staff (the compatibility viewer
    rank) keep reading every workspace's plans, as before 8b.
  * Write them: `plan` on it. HYRAK's own plans (the delivery fleet's
    legs, pads, stations, the builtin profiles) keep the compatibility
    operator rank they always needed, so nothing a HYRAK pilot does today
    changes and no customer reaches them.
  * HYRAK's pads and route profiles are global vocabulary: anyone who may
    read some workspace's plans also reads HYRAK's (never writes them).

A request names its workspace (`workspace_id`); without one, staff act on
HYRAK and a customer on the first of their own memberships (grant order)
whose workspace allows the action, the same pick the live session makes.
An unknown or invisible workspace is 404 (no existence leak), a visible
one without the right is 403.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.auth import perms
from app.auth.service import AuthUser, role_at_least
from app.auth.store import PLATFORM_WORKSPACE_ID
from app.workspaces.service import NOT_FOUND, Refused, Tree, _fresh_memberships, _tree

HYRAK = PLATFORM_WORKSPACE_ID


@dataclass
class Scope:
    user: AuthUser
    ms: list
    tree: Tree

    @property
    def staff_reader(self) -> bool:
        """Staff read every workspace's plans (pre-8b access, kept)."""
        return role_at_least(self.user.role or "member", "viewer")

    @property
    def hyrak_writer(self) -> bool:
        return role_at_least(self.user.role or "member", "operator")

    def perms_on(self, workspace_id: str) -> frozenset:
        ws = self.tree.get(workspace_id)
        return perms.effective_perms(self.ms, ws) if ws is not None else frozenset()

    def can_read(self, workspace_id: Optional[str]) -> bool:
        workspace_id = workspace_id or HYRAK
        if self.staff_reader:
            return True
        return perms.VIEW in self.perms_on(workspace_id)

    def can_write(self, workspace_id: Optional[str]) -> bool:
        workspace_id = workspace_id or HYRAK
        if workspace_id == HYRAK:
            return self.hyrak_writer
        return perms.PLAN in self.perms_on(workspace_id)

    def readable_global(self) -> bool:
        """HYRAK's pads / profiles: readable by anyone who reads any plans."""
        return self.staff_reader or any(
            perms.VIEW in perms.effective_perms(self.ms, w) for w in self.tree.all())

    def visible(self, workspace_id: str) -> bool:
        if workspace_id == HYRAK or self.staff_reader:
            return True
        ws = self.tree.get(workspace_id)
        return ws is not None and perms.visible(self.ms, ws)

    def resolve(self, requested, *, write: bool) -> str:
        """The workspace a request acts on (see the module docstring)."""
        if requested is not None and not isinstance(requested, str):
            raise Refused(400, "workspace_id must be a string")
        if requested:
            if requested != HYRAK and self.tree.get(requested) is None:
                raise Refused(404, NOT_FOUND)
            if not self.visible(requested):
                raise Refused(404, NOT_FOUND)
            ok = self.can_write(requested) if write else self.can_read(requested)
            if not ok:
                raise Refused(403, "You cannot plan missions in this workspace" if write
                              else "You cannot see this workspace's plans")
            return requested
        if self.user.is_staff or self.staff_reader:
            if write and not self.can_write(HYRAK):
                raise Refused(403, "Planning HYRAK missions needs the operator role")
            return HYRAK
        for m in self.ms:
            ws = self.tree.get(m.workspace_id)
            if ws is None:
                continue
            ok = self.can_write(ws.id) if write else self.can_read(ws.id)
            if ok:
                return ws.id
        raise Refused(403, "You cannot plan missions in any workspace" if write
                      else "You cannot see any workspace's plans")


async def scope_for(user: AuthUser) -> Scope:
    """The caller's planning scope, with memberships re-read from the store
    (a just-demoted pilot must not keep planning for a minute on the token
    cache)."""
    return Scope(user=user, ms=await _fresh_memberships(user), tree=await _tree())


def scope_from(user: AuthUser, ms, tree: Tree) -> Scope:
    """For callers that already hold the memberships and tree (tests)."""
    return Scope(user=user, ms=list(ms), tree=tree)

"""
Which workspaces' live sessions and history a signed-in account may read
(docs/ACCESS_MODEL.md section 8b).

Phase 2a made the session list, the console's live map and every history
table (flights, crowd, plates, sightings) staff-only and global. Phase 2b
scopes them per workspace instead, with the one permission engine:

  * founders read everything, including rows of a workspace that was
    deleted since (their scope has no filter);
  * everyone else reads the workspaces where they hold `view` by the perms:
    a manager the customer workspaces they manage (and HYRAK if they are
    also a HYRAK viewer or pilot), a HYRAK pilot or viewer HYRAK itself, a
    customer their own workspace and the ones below it. An airspace manager
    holds no `view` anywhere and reads no history;
  * the legacy shared token reads HYRAK only (it flies HYRAK's drones and
    holds no memberships to check).

Rows written before phase 2b carry the HYRAK workspace (the migration's
backfill), so they stay with HYRAK staff.

The memberships are read fresh from the store, like the workspace routes
do, not from the 60 s token cache: a person removed from a workspace stops
reading its history on the next request.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional

from app.auth import perms
from app.auth import service as auth
from app.auth.store import PLATFORM_WORKSPACE_ID


@dataclass(frozen=True)
class DataScope:
    """`everything`: no filter (founders). Otherwise `granted` maps each
    workspace id the user can see to their perms on it."""
    everything: bool = False
    granted: dict = field(default_factory=dict)
    names: dict = field(default_factory=dict)
    staff: bool = False
    # The workspace tree the scope was computed over (None when it could
    # not be read), for callers that need the records themselves.
    tree: object = field(default=None, compare=False, repr=False)

    def workspace(self, workspace_id: Optional[str]):
        if self.tree is None:
            return None
        return self.tree.get(workspace_id or PLATFORM_WORKSPACE_ID)

    def can(self, workspace_id: Optional[str], perm: str = perms.VIEW) -> bool:
        if self.everything:
            return True
        return perm in self.granted.get(workspace_id or PLATFORM_WORKSPACE_ID, frozenset())

    def ids(self, perm: str = perms.VIEW) -> Optional[list[str]]:
        """The workspace ids to filter on, or None for no filter."""
        if self.everything:
            return None
        return sorted(w for w, p in self.granted.items() if perm in p)

    def narrow(self, requested: Optional[str], perm: str = perms.VIEW) -> Optional[list[str]]:
        """`ids(perm)`, narrowed to one requested workspace when given. A
        requested workspace outside the scope yields an empty list (nothing
        to read), never an error that would confirm it exists."""
        if not requested:
            return self.ids(perm)
        return [requested] if self.can(requested, perm) else []

    def name(self, workspace_id: Optional[str]) -> str:
        return self.names.get(workspace_id or PLATFORM_WORKSPACE_ID, "")


async def _tree():
    from app.workspaces.service import Tree
    return Tree(await auth.read_store().list_workspaces())


def scope_from(memberships: Iterable, tree, *, legacy: bool = False) -> DataScope:
    """Pure: the scope for these memberships over this workspace tree."""
    ms = list(memberships)
    names = {w.id: w.name for w in tree.all()} if tree is not None else {}
    if legacy:
        return DataScope(granted={PLATFORM_WORKSPACE_ID: frozenset({perms.VIEW, perms.FLY})},
                         names=names, staff=True, tree=tree)
    staff = perms.is_staff(ms)
    if perms.is_founder(ms):
        return DataScope(everything=True, names=names, staff=True, tree=tree)
    granted = {}
    if tree is not None:
        for ws in tree.all():
            p = perms.effective_perms(ms, ws)
            if perms.VIEW in p:
                granted[ws.id] = p
    return DataScope(granted=granted, names=names, staff=staff, tree=tree)


async def scope_for(user) -> DataScope:
    """The data scope of a signed-in AuthUser. Fails closed: if the tree or
    the memberships cannot be read, a non-founder reads nothing."""
    if user.id == auth.LEGACY_USER_ID:
        try:
            tree = await _tree()
        except Exception:
            tree = None
        return scope_from((), tree, legacy=True)
    try:
        ms = await auth.memberships_of(user.id)
        tree = await _tree()
    except Exception:
        # The cached memberships still say whether this is a founder; nobody
        # else gets anything while the store is away.
        if perms.is_founder(user.memberships):
            return DataScope(everything=True, staff=True)
        return DataScope(staff=bool(user.is_staff))
    return scope_from(ms, tree)


def session_scope(session, tree) -> DataScope:
    """The scope of a live socket session (the console's observer socket),
    from the memberships stamped on it and refreshed by revalidation."""
    legacy = session.user_id == auth.LEGACY_USER_ID
    return scope_from(getattr(session, "memberships", ()) or (), tree, legacy=legacy)


async def session_scope_now(session) -> DataScope:
    try:
        tree = await _tree()
    except Exception:
        tree = None
    return session_scope(session, tree)

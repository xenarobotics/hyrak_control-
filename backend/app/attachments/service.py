"""
Configuring a drone's attachments, and the bench Test (REST, routes.py).

Who may do what, on the DRONE's workspace (app/auth/perms.py):
  * list: `view` (pilots need the list to fly);
  * add, edit, remove, Test: `drones.manage` (owners, admins, managers of
    the workspace, HYRAK founders everywhere).
A drone the caller cannot view is a 404, like every other registry read.

Test runs the real command so the person can watch it move on the bench,
and only then: the drone is linked (a live session holds its link), it is
DISARMED, and no HYRAK takeover holds that session (unless the caller is
the staff member holding it). Every change and every Test is an
audit_events row.
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

from app.attachments import control, kinds
from app.attachments import store as att_store
from app.auth import audit, perms
from app.auth import service as auth
from app.auth.store import PLATFORM_WORKSPACE_ID

logger = logging.getLogger("verocore.attachments")


class AttachmentFailure(Exception):
    def __init__(self, status: int, code: str, error: str = ""):
        super().__init__(error or code)
        self.status, self.code, self.error = status, code, error or code

    def public(self) -> dict:
        return {"code": self.code, "error": self.error}


NOT_FOUND = (404, "not_found", "Drone or attachment not found")


def _refuse(status: int, code: str, error: str = "") -> AttachmentFailure:
    return AttachmentFailure(status, code, error)


async def _memberships(actor) -> list:
    if actor.id == auth.LEGACY_USER_ID:
        return []
    return await auth.memberships_of(actor.id)


def _can(actor, ms, ws, perm: str) -> bool:
    if actor.id == auth.LEGACY_USER_ID:
        # The legacy shared token reads HYRAK's own drones and nothing more.
        return ws.id == PLATFORM_WORKSPACE_ID and perm == perms.VIEW
    return perms.can(ms, ws, perm)


async def _drone(actor, drone_id: str, perm: str):
    """(drone dict, memberships, workspace). 404 when the caller cannot
    view it, 403 without `perm`."""
    from app.workspaces.service import Tree
    store = auth.read_store()
    drone = await store.get_drone(drone_id)
    ms = await _memberships(actor)
    tree = Tree(await store.list_workspaces())
    ws = tree.get(drone.get("workspace_id") or PLATFORM_WORKSPACE_ID) if drone else None
    if drone is None or ws is None or not _can(actor, ms, ws, perms.VIEW):
        raise _refuse(*NOT_FOUND)
    if perm != perms.VIEW and not _can(actor, ms, ws, perm):
        raise _refuse(403, "forbidden",
                      "Changing a drone's attachments needs the owner or admin role on its workspace")
    return drone, ms, ws


async def _audit(actor, action: str, drone: dict, detail: dict, ip: str) -> None:
    await audit.record(auth.write_store(), actor, action, workspace_id=drone.get("workspace_id"),
                       target_type="drone", target_id=drone["id"],
                       detail={"drone_name": drone.get("name"), **detail}, ip=ip)


def _bad(e: kinds.AttachmentError) -> AttachmentFailure:
    return _refuse(400, "bad_request", str(e))


# ── link of a drone (for Test and the list's live facts) ─────────────────

def _link(session_manager, drone_id: str):
    """(session, telemetry) of a live session holding this drone's link,
    or (None, None)."""
    if session_manager is None:
        return None, None
    for s in session_manager.all_sessions():
        if control.drone_id_of(s) != drone_id:
            continue
        tel = session_manager.get_telemetry(s.session_id)
        if control._linked(tel):
            return s, tel
    return None, None


# ── routes' work ─────────────────────────────────────────────────────────

async def list_for_drone(actor, drone_id: str, session_manager=None) -> dict:
    drone, ms, ws = await _drone(actor, drone_id, perms.VIEW)
    items = await att_store.read_store().list_for_drone(drone_id)
    s, tel = _link(session_manager, drone_id)
    return {"drone_id": drone_id,
            "attachments": [kinds.public(a) for a in items],
            "can_manage": _can(actor, ms, ws, perms.DRONES_MANAGE),
            "linked": tel is not None,
            "armed": control._armed(tel) if tel is not None else None,
            "max": kinds.MAX_PER_DRONE}


async def create(actor, drone_id: str, body: dict, *, ip: str = "") -> dict:
    drone, _, _ = await _drone(actor, drone_id, perms.DRONES_MANAGE)
    store = att_store.write_store()
    items = await store.list_for_drone(drone_id)
    if len(items) >= kinds.MAX_PER_DRONE:
        raise _refuse(400, "bad_request", f"a drone has at most {kinds.MAX_PER_DRONE} attachments")
    try:
        rec = kinds.clean(body)
    except kinds.AttachmentError as e:
        raise _bad(e)
    if await store.id_taken(rec["id"]):
        raise _refuse(400, "bad_request", "that attachment id is already used")
    rec = await store.create(drone_id, rec)
    await _audit(actor, "attachment.create", drone,
                 {"attachment_id": rec["id"], "kind": rec["kind"], "name": rec["name"],
                  "wiring": rec["wiring"]}, ip)
    return kinds.public(rec)


async def update(actor, drone_id: str, attachment_id: str, body: dict, *, ip: str = "") -> dict:
    drone, _, _ = await _drone(actor, drone_id, perms.DRONES_MANAGE)
    store = att_store.write_store()
    old = await store.get(drone_id, attachment_id)
    if old is None:
        raise _refuse(*NOT_FOUND)
    if isinstance(body, dict) and body.get("id") not in (None, attachment_id):
        raise _refuse(400, "bad_request", "the id of an attachment cannot change")
    try:
        rec = kinds.clean(body, existing=old)
    except kinds.AttachmentError as e:
        raise _bad(e)
    rec = await store.update(drone_id, rec)
    if rec is None:
        raise _refuse(*NOT_FOUND)
    await _audit(actor, "attachment.update", drone,
                 {"attachment_id": attachment_id, "fields": sorted(body)}, ip)
    return kinds.public(rec)


async def delete(actor, drone_id: str, attachment_id: str, *, ip: str = "") -> dict:
    drone, _, _ = await _drone(actor, drone_id, perms.DRONES_MANAGE)
    store = att_store.write_store()
    old = await store.get(drone_id, attachment_id)
    if old is None or not await store.delete(drone_id, attachment_id):
        raise _refuse(*NOT_FOUND)
    await _audit(actor, "attachment.delete", drone,
                 {"attachment_id": attachment_id, "kind": old.get("kind"), "name": old.get("name")}, ip)
    return {"ok": True}


async def test(actor, drone_id: str, attachment_id: str, body: dict, *, session_manager=None,
               ip: str = "") -> dict:
    """The bench Test: the real command on a linked, DISARMED drone.
    Answers like attachment_result: {attachment_id, action_id, ok,
    reason_code?, message, ts}."""
    from app.sessions import takeover
    drone, _, _ = await _drone(actor, drone_id, perms.DRONES_MANAGE)
    body = body if isinstance(body, dict) else {}
    action_id = body.get("action_id")
    att = await att_store.read_store().get(drone_id, attachment_id)
    if att is None:
        raise _refuse(*NOT_FOUND)
    action = kinds.find_action(att, action_id)
    if action is None:
        raise _refuse(400, "bad_request", "that attachment has no such action")
    level = None
    if att["kind"] == "sprayer" and action["id"] == "level":
        try:
            level = kinds.level_pct(body.get("value"))
        except kinds.AttachmentError as e:
            raise _bad(e)
    what = control.label_of(att, action, level)
    session, tel = _link(session_manager, drone_id)
    code, error = None, ""
    sessions = session_manager.all_sessions() if session_manager is not None else []
    if tel is None:
        code = "not_linked"
    elif takeover.blocking_drone(drone_id, sessions, actor_user_id=actor.id) is not None:
        code = "taken_over"
    elif control._armed(tel):
        code = "armed"
    else:
        ok, code, error = await control.execute(tel, att, action, level)
    extra = {"source": "test", **({"level": level} if level is not None else {})}
    extra["name"] = att.get("name")
    if code:
        out = control.result(attachment_id, action_id, False,
                             f"{what} not done: {control.reason(code, error)}", code, **extra)
    else:
        out = control.result(attachment_id, action_id, True, f"{what}: sent", **extra)
    logger.info(f"Attachment test {drone_id[:8]}/{attachment_id}/{action_id} by "
                f"{actor.username}: {'ok' if out['ok'] else code}")
    who = SimpleNamespace(id=actor.id, username=actor.username,
                          role=getattr(actor, "role", None), client_ip=ip)
    await control.audit_use(who, session or SimpleNamespace(drone=drone, session_id=None,
                                                             workspace_id=drone.get("workspace_id")),
                            att, action_id, out, source="test", kind="attachment.test")
    return out


def kinds_catalogue() -> dict:
    return kinds.catalogue()


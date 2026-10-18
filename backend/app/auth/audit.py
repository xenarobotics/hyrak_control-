"""
Two audit trails.

1. Command lines, one per accepted command (socket event or mutating route):

       audit user=<name> role=<role> session=<id8> event=<name> drone=<id>

   Logger "hyrak.audit" - separate from the verocore.* tree so it can be
   routed to its own file or shipped elsewhere without touching app logging.

2. Access and airspace changes (memberships, invites, workspaces, zones,
   drone assignment, accounts) as rows in audit_events via record(), with
   actor and client IP, readable through GET /api/audit. Each also writes a
   hyrak.audit line. A failed row write is logged loudly but does not undo
   the change it describes (that change is already committed).
"""
from __future__ import annotations

import logging

logger = logging.getLogger("hyrak.audit")


def log(user, event: str, *, session_id: str | None = None, drone=None) -> None:
    name = getattr(user, "username", None) or "-"
    role = getattr(user, "role", None) or "-"
    sid8 = (session_id or "-")[:8]
    logger.info(
        "audit user=%s role=%s session=%s event=%s drone=%s",
        name, role, sid8, event, "-" if drone in (None, "") else drone,
    )


async def record(store, actor, action: str, *, workspace_id: str | None = None,
                 target_type: str = "", target_id: str = "", detail: dict | None = None,
                 ip: str = "") -> None:
    from app.auth.store import AuditRecord
    actor_id = getattr(actor, "id", None)
    actor_name = getattr(actor, "username", None) or ""
    logger.info("audit user=%s action=%s workspace=%s target=%s:%s ip=%s",
                actor_name or "-", action, workspace_id or "-", target_type or "-",
                target_id or "-", ip or "-")
    try:
        await store.add_audit(AuditRecord(
            action=action, actor_id=actor_id, actor_name=actor_name,
            workspace_id=workspace_id, target_type=target_type, target_id=str(target_id or ""),
            detail=detail, ip=ip or ""))
    except Exception as e:
        logger.error("audit: could not write audit_events row for %s: %s", action, e)

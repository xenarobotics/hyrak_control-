"""
Command audit trail: one structured line per accepted command.

    audit user=<name> role=<role> session=<id8> event=<name> drone=<id>

Logger "hyrak.audit" - separate from the verocore.* tree so it can be
routed to its own file or shipped elsewhere without touching app logging.
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

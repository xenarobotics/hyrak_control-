"""
Live sessions scoped to a workspace (docs/ACCESS_MODEL.md section 8a).

A socket session belongs to exactly one workspace, picked at the handshake
and kept for the session's whole life (resume included). This module
answers the three questions the live paths ask about it, with the pure
permission engine (app/auth/perms.py) over the user's memberships:

  * Which workspace does this connect land in, and with which perms?
    Staff land on HYRAK unless they name another workspace; customer-only
    accounts must have `view` on the one they name (default: their first
    workspace with `view`), otherwise the connect is refused with
    `no_workspace_access`.
  * Do they still have it? Revalidation (every SOCKET_REVALIDATE_S and on
    membership change) recomputes the perms; a customer session that lost
    `view` is disconnected.
  * May this session command the drone it holds a link to? Only with `fly`
    on the DRONE's workspace, which can differ from the session's: a
    customer pilot who plugs their radio into someone else's drone sees it
    read-only. An unassigned drone (one the registry has never seen) is
    claimed by the session's workspace on first connect. A simulated drone
    (a registry record marked simulated, on a server-side simulator link)
    is never claimed and never blocks.

Why staff are special: staff sessions keep the compatibility rank checks
(require_operator and friends) exactly as before, so nothing a founder or a
HYRAK pilot does today changes. The workspace and perms are still stamped
on their sessions, for the drone check and for session_ready.

Fails closed: if the workspace tree cannot be read, a customer connect is
refused and a drone's access stays unknown (which refuses customer
commands); staff fall back to HYRAK as they would with the database down.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Optional

from app.auth import audit, perms
from app.auth import service as auth
from app.auth.store import PLATFORM_WORKSPACE_ID

logger = logging.getLogger("verocore.auth.live")

NO_WORKSPACE_ACCESS = "no_workspace_access"


@dataclass(frozen=True)
class SessionScope:
    workspace_id: str
    perms: frozenset
    is_staff: bool


def is_staff_user(user) -> bool:
    """Staff for the live paths: any HYRAK membership, or the legacy shared
    token (which flies as a compatibility operator and has no memberships)."""
    return user.id == auth.LEGACY_USER_ID or bool(user.is_staff)


async def _tree():
    from app.workspaces.service import Tree
    return Tree(await auth.read_store().list_workspaces())


async def resolve(user, requested: Optional[str]) -> Optional[SessionScope]:
    """The scope a new session gets, or None to refuse it with
    NO_WORKSPACE_ACCESS. `requested` is the handshake's workspace_id."""
    staff = is_staff_user(user)
    ms = list(user.memberships)
    try:
        tree = await _tree()
    except Exception as e:
        logger.warning(f"workspace tree unavailable at connect: {e}")
        tree = None
    if requested is not None and not isinstance(requested, str):
        return None
    if requested:
        ws = tree.get(requested) if tree is not None else None
        if ws is None:
            if staff and requested == PLATFORM_WORKSPACE_ID:
                return SessionScope(PLATFORM_WORKSPACE_ID, frozenset(), True)
            return None
        granted = perms.effective_perms(ms, ws)
        # Staff are always welcome on HYRAK itself (an airspace manager has
        # no `view` there but has always had a live session).
        if perms.VIEW not in granted and not (staff and ws.id == PLATFORM_WORKSPACE_ID):
            return None
        return SessionScope(ws.id, granted, staff)
    if staff:
        ws = tree.get(PLATFORM_WORKSPACE_ID) if tree is not None else None
        granted = perms.effective_perms(ms, ws) if ws is not None else frozenset()
        return SessionScope(PLATFORM_WORKSPACE_ID, granted, True)
    if tree is None:
        return None
    # Customer default: the first of their own memberships (in the order
    # they were granted) whose workspace gives `view`, so the pick is
    # stable and is a workspace they were actually invited to.
    for m in ms:
        ws = tree.get(m.workspace_id)
        if ws is None:
            continue
        granted = perms.effective_perms(ms, ws)
        if perms.VIEW in granted:
            return SessionScope(ws.id, granted, False)
    return None


async def rescope(user, workspace_id: str) -> Optional[SessionScope]:
    """The same session's scope with the user's CURRENT memberships, or None
    when it may no longer exist (a customer who lost `view`). Raises when
    the tree cannot be read, so the caller can keep the old scope through
    a database blip instead of dropping a pilot mid-flight."""
    staff = is_staff_user(user)
    ms = list(user.memberships)
    tree = await _tree()
    ws = tree.get(workspace_id)
    if ws is None:
        if staff and workspace_id == PLATFORM_WORKSPACE_ID:
            return SessionScope(PLATFORM_WORKSPACE_ID, frozenset(), True)
        return None
    granted = perms.effective_perms(ms, ws)
    if perms.VIEW not in granted and not (staff and ws.id == PLATFORM_WORKSPACE_ID):
        return None
    return SessionScope(ws.id, granted, staff)


def stamp(session, user, scope: SessionScope) -> None:
    session.workspace_id = scope.workspace_id
    session.perms = scope.perms
    session.is_staff = scope.is_staff
    session.memberships = tuple(user.memberships)


# ── Drones ────────────────────────────────────────────────────────────────

# How the current telemetry link was opened, as far as drone access cares.
# Only SIM_LINK is simulator-type: a direct udp address that the server
# dials on a staff connect_telemetry (the Gazebo sim on this server,
# udp:14600). Every client-side relay (connect_browser_serial: Web Serial,
# the desktop's SITL / serial / RF / SIYI relays) and the RF bridge are
# never simulator-type, whatever address MAVSDK sees.
SIM_LINK = "server_udp"
DIRECT_LINK = "server_direct"      # connect_telemetry to tcp / serial / anything not udp
RELAY_LINK = "client_relay"        # connect_browser_serial
RF_LINK = "rf_bridge"              # connect_rf_bridge


def link_kind_for(origin: str, address: str, *, has_bridge: bool) -> str:
    """The link kind from the handler that opened the link (never from the
    client's payload) and the address it dialled."""
    if origin == "connect_browser_serial":
        return RELAY_LINK
    if origin == "connect_rf_bridge":
        return RF_LINK
    if origin == "connect_telemetry" and address.startswith("udp") and not has_bridge:
        return SIM_LINK
    return DIRECT_LINK


async def drone_fly_allowed(session, drone: Optional[dict]) -> Optional[bool]:
    """May `session` command `drone` (a registry record)? None when the
    drone is unknown or its workspace cannot be read.

    The ownership check is skipped only for a simulated drone: the registry
    record carries the stored is_simulated flag AND the session's current
    link is simulator-type (session.link_simulated, SIM_LINK). Either alone
    is not enough: a real drone on a WiFi UDP link is a udp link too, and a
    SITL UID repeats across instances. Records first seen through a
    customer's link are never stored as simulated (identify_drone)."""
    if not drone:
        return None
    if getattr(session, "link_simulated", False) and drone.get("is_simulated"):
        return True
    ws_id = drone.get("workspace_id") or PLATFORM_WORKSPACE_ID
    if session.user_id == auth.LEGACY_USER_ID:
        # The legacy token flies HYRAK's drones (it always has) and no one
        # else's: it holds no memberships to check.
        return ws_id == PLATFORM_WORKSPACE_ID
    # No rank shortcut: HYRAK's drones need `fly` on the HYRAK workspace by
    # the perms like any other workspace (founders, HYRAK pilots). A
    # manager flies them by also holding a HYRAK pilot membership.
    try:
        tree = await _tree()
    except Exception as e:
        logger.warning(f"drone access: workspace tree unavailable: {e}")
        return None
    ws = tree.get(ws_id)
    if ws is None:
        return False
    return perms.can(session.memberships, ws, perms.FLY)


async def refresh_drone_access(session) -> None:
    """Re-read the session's drone (it may have been moved to another
    workspace) and recompute drone_fly. Keeps the previous answer when the
    registry or the tree cannot be read."""
    drone = session.drone
    if not drone or not drone.get("id"):
        return
    try:
        fresh = await auth.read_store().get_drone(drone["id"])
    except Exception as e:
        logger.debug(f"drone access: could not re-read drone: {e}")
        fresh = None
    if fresh:
        session.drone = {**drone, **fresh}
    answer = await drone_fly_allowed(session, session.drone)
    if answer is not None:
        session.drone_fly = answer


async def identify_drone(session, hardware_uid: str, *, link_kind: str) -> Optional[dict]:
    """Registry upsert on telemetry connect, with the claim: a drone the
    registry has never seen joins the session's workspace (audited as
    drone.claimed when that is a customer workspace). Sets session.drone,
    session.link_simulated and session.drone_fly; returns the record.

    A new record is stored as simulated (and left unclaimed, on HYRAK) only
    when a staff session saw it on a SIM_LINK. A customer session never
    reaches one (connect_telemetry is staff-only), and the staff check is
    repeated here so a customer can never launder a real drone into
    "simulated": their desktop SITL is claimed by their own workspace like
    any new drone."""
    from app.registry import drones as drone_registry

    sim_link = link_kind == SIM_LINK and bool(getattr(session, "is_staff", False))
    claim = None if sim_link else session.workspace_id
    session.link_simulated = sim_link
    drone = await drone_registry.upsert_seen(hardware_uid, is_simulated=sim_link,
                                             claim_workspace_id=claim)
    if drone and drone.pop("claimed", False):
        actor = SimpleNamespace(id=session.user_id, username=session.username)
        try:
            await audit.record(auth.write_store(), actor, "drone.claimed",
                               workspace_id=drone.get("workspace_id"),
                               target_type="drone", target_id=drone.get("id", ""),
                               detail={"drone_name": drone.get("name"),
                                       "hardware_uid": hardware_uid,
                                       "session_id": session.session_id},
                               ip=session.client_ip or "")
        except Exception as e:
            logger.error(f"drone.claimed audit row not written: {e}")
        logger.info(f"Drone {drone.get('name')} claimed by workspace {claim} "
                    f"({session.username}, session {session.session_id[:8]})")
    session.drone = drone
    session.drone_fly = await drone_fly_allowed(session, drone)
    return drone

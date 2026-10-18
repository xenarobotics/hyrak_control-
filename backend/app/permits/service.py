"""
Flight permits (docs/ACCESS_MODEL.md 8b).

A pilot whose flight crosses restricted airspace (orange zones, and red
zones that admit a permit: Zone.permission_required) asks for permission
with a written justification and a time window. Two kinds:

  mission  the waypoint list is frozen into the permit. Once approved,
           uploading a mission that matches it (within GPS-noise
           tolerance - any deliberate edit invalidates it) passes the zone
           gate for the zones the permit names.
  area     a polygon. Any mission that stays inside it may use the zones
           the permit names.

A permit belongs to a workspace and optionally one drone (null = any drone
of that workspace). It is honoured, at upload, at arm / takeoff and by the
in-flight zone monitor, only while it is approved, inside its window, for
a drone currently assigned to its workspace, and only for the zones it
names (a red zone drawn after approval is not covered).

Zones change. A permit records each zone's class (refreshed at approval);
editing a zone's class, permission_required or altitudes marks every
approved permit naming it `superseded` (supersede_for_zone, audited), and
at use a zone is exempted only while the live zone is no stricter than
recorded and still admits a permit (honoured_zone_ids).

Who decides: anyone with `permits.approve` covering the restricted airspace
the flight uses (perms.check_area over the flight's footprint inside the
named zones): founders anywhere, airspace managers inside their area,
managers of the workspace inside theirs. Nobody but a founder decides their
own request.

The pure functions (window, coverage, footprint) are the rules; the async
ones store and filter. Who may request or list which workspace's permits
is app/permits/routes.py over app/planner/scope.py.
"""
import hashlib
import json
import logging
import math
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import or_, select, type_coerce
from sqlalchemy.dialects.postgresql import JSONB

from app.db import db_available, get_session
from app.db.models import PLATFORM_WORKSPACE_ID, Permit

logger = logging.getLogger("verocore.permits")

# Numeric tolerance when matching an upload to an approved permit:
# ~1e-5 deg ≈ 1.1 m - absorbs float noise, rejects real edits.
_TOL_DEG = 1.1e-5
_TOL_ALT = 0.5

PENDING, APPROVED, DENIED, REVOKED, WITHDRAWN, SUPERSEDED = (
    "pending", "approved", "denied", "revoked", "withdrawn", "superseded")
STATUSES = (PENDING, APPROVED, DENIED, REVOKED, WITHDRAWN, SUPERSEDED)
_SEVERITY = {"green": 0, "orange": 1, "red": 2}


class PermitCheckUnavailable(Exception):
    """The permits for a drone could not be read just now. Callers that
    would let a flight into restricted airspace refuse (fail closed)."""
# Not stored: an approved permit whose window has ended.
EXPIRED = "expired"

MAX_WINDOW_DAYS = 30
# The corridor check_path flags orange zones with; a mission permit's
# footprint is its path widened by the same amount.
CORRIDOR_M = 20.0
# In flight, how far off a mission permit's path the aircraft may be and
# still fly under it (GPS error, wind, turn overshoot).
ON_PATH_M = 30.0
# An area permit's polygon, widened this much for the same reasons.
AREA_SLACK_M = 5.0

# Bumped on every write so the zone monitor's per-session cache refetches
# at once after an approval, a revocation or a withdrawal.
_generation = 0


def generation() -> int:
    return _generation


def _bump() -> None:
    global _generation
    _generation += 1


def mission_hash(waypoints: list[dict]) -> str:
    canon = [
        (round(float(w["lat"]), 6), round(float(w["lng"]), 6),
         round(float(w.get("altitude", 0.0)), 1))
        for w in waypoints
    ]
    return hashlib.sha256(json.dumps(canon).encode()).hexdigest()


def _matches(permit_wps: list[dict], wps: list[dict],
             alt_slack: float = 0.0) -> bool:
    """alt_slack: extra altitude tolerance for the fleet's per-drone
    separation bands - the permit froze the PLANNED altitudes, but the
    aircraft flies plan + band. Horizontal tolerance never widens."""
    if len(permit_wps) != len(wps):
        return False
    for a, b in zip(permit_wps, wps):
        if abs(float(a["lat"]) - float(b["lat"])) > _TOL_DEG:
            return False
        if abs(float(a["lng"]) - float(b["lng"])) > _TOL_DEG:
            return False
        if (abs(float(a.get("altitude", 0)) - float(b.get("altitude", 0)))
                > _TOL_ALT + alt_slack):
            return False
    return True


# ── Pure rules ────────────────────────────────────────────────────────────

def _ts(v) -> Optional[datetime]:
    if v is None or isinstance(v, datetime):
        return v
    try:
        t = datetime.fromisoformat(str(v))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def in_window(p: dict, now: Optional[datetime] = None) -> bool:
    """Approved and inside [valid_from, valid_until). A permit from before
    8b has no window and counts while approved."""
    if p.get("status") != APPROVED:
        return False
    now = now or now_utc()
    vf, vu = _ts(p.get("valid_from")), _ts(p.get("valid_until"))
    if vf is not None and now < vf:
        return False
    if vu is not None and now >= vu:
        return False
    return True


def effective_status(p: dict, now: Optional[datetime] = None) -> str:
    """The stored status, with an approved permit past its window shown as
    expired."""
    vu = _ts(p.get("valid_until"))
    if p.get("status") == APPROVED and vu is not None and (now or now_utc()) >= vu:
        return EXPIRED
    return p.get("status") or PENDING


def applies_to_drone(p: dict, drone: Optional[dict]) -> bool:
    """For this drone: the permit's workspace is the drone's CURRENT one (a
    drone moved to another workspace leaves its permits behind), and the
    permit names this drone or any drone."""
    if not drone or not drone.get("id"):
        return False
    if p.get("workspace_id", PLATFORM_WORKSPACE_ID) != (drone.get("workspace_id") or PLATFORM_WORKSPACE_ID):
        return False
    return p.get("drone_id") in (None, "", drone["id"])


def zone_ids(p: dict) -> set:
    return {z.get("id") for z in (p.get("zones") or []) if isinstance(z, dict)}


def _live(ids, live: Optional[dict]) -> dict:
    if live is not None:
        return live
    from app.zones import engine as zone_engine
    return zone_engine.zone_info(ids)


def honoured_zone_ids(p: dict, live: Optional[dict] = None) -> set:
    """The zones this permit still exempts, judged against the live zones
    (`live`: {id: {zone_class, permission_required}}, default the engine).
    Never one that is now red without permission_required, nor one whose
    class is stricter than the class recorded on the permit. A zone no
    longer loaded (deleted, inactive) exempts nothing because nothing
    flags it."""
    recorded = {z.get("id"): z for z in (p.get("zones") or []) if isinstance(z, dict)}
    live = _live(recorded.keys(), live)
    out = set()
    for zid, rec in recorded.items():
        now = live.get(zid)
        if now is None:
            continue
        if now["zone_class"] == "red" and not now.get("permission_required", True):
            continue
        if _SEVERITY.get(now["zone_class"], 2) > _SEVERITY.get(rec.get("zone_class"), 0):
            continue
        out.add(zid)
    return out

def _m2deg(lat: float) -> float:
    return 1.0 / (111_320 * max(0.2, math.cos(math.radians(lat))))


def _path(waypoints: list[dict]):
    from shapely.geometry import LineString, Point
    pts = [(float(w["lng"]), float(w["lat"])) for w in waypoints]
    return LineString(pts) if len(pts) > 1 else Point(pts[0])


def footprint(p: dict, widen_m: float = CORRIDOR_M):
    """The airspace a permit is for, as a shapely geometry in lng/lat: the
    area, or the frozen path widened by `widen_m`. None when it has neither."""
    from shapely.geometry import shape
    if p.get("area"):
        geom = shape(p["area"])
        c = geom.centroid
        return geom.buffer(AREA_SLACK_M * _m2deg(c.y)) if widen_m else geom
    wps = p.get("waypoints") or []
    if not wps:
        return None
    path = _path(wps)
    return path.buffer(widen_m * _m2deg(float(wps[0]["lat"])))


def restricted_footprint(p: dict, zone_geoms: dict):
    """The part of the permit's footprint inside the zones it names - what
    an approver's area must cover. Falls back to the whole footprint when
    the zones are no longer loaded (deleted since the request)."""
    from shapely.ops import unary_union
    fp = footprint(p, widen_m=CORRIDOR_M)
    if fp is None:
        return None
    geoms = [g for zid, g in zone_geoms.items() if zid in zone_ids(p)]
    if not geoms:
        return fp
    inside = fp.intersection(unary_union(geoms))
    return fp if inside.is_empty else inside


def covers_path(p: dict, waypoints: list[dict], required: set,
                alt_slack: float = 0.0, live: Optional[dict] = None) -> bool:
    """Does this permit cover flying `waypoints` through the zones in
    `required`? (Window and drone are checked separately.)"""
    if not required <= zone_ids(p):
        return False
    if required and not required <= honoured_zone_ids(p, live):
        return False
    if p.get("area"):
        fp = footprint(p, widen_m=AREA_SLACK_M)
        return fp is not None and bool(waypoints) and fp.covers(_path(waypoints))
    frozen = p.get("waypoints") or []
    if not frozen:
        return False
    return p.get("mission_hash") == mission_hash(waypoints) or _matches(frozen, waypoints, alt_slack)


def permitted_zone_ids_at(permits: Iterable[dict], lat: float, lng: float,
                          now: Optional[datetime] = None, live: Optional[dict] = None) -> set:
    """Zones the aircraft at (lat, lng) may be in right now, by the in-window
    permits among `permits`: an area permit's zones while inside its area,
    a mission permit's while within ON_PATH_M of its path; only those the
    live zones still allow (honoured_zone_ids)."""
    from shapely.geometry import Point
    now = now or now_utc()
    pt = Point(lng, lat)
    out: set = set()
    for p in permits:
        if not in_window(p, now):
            continue
        fp = footprint(p, widen_m=AREA_SLACK_M if p.get("area") else ON_PATH_M)
        if fp is not None and fp.covers(pt):
            out |= honoured_zone_ids(p, live)
    return out


def split_zones(zones: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """(red that admit a permit, orange, prohibited red) among check results."""
    red = [z for z in zones if z.get("zone_class") == "red" and z.get("permission_required", True)]
    orange = [z for z in zones if z.get("zone_class") == "orange"]
    prohibited = [z for z in zones if z.get("zone_class") == "red"
                  and not z.get("permission_required", True)]
    return red, orange, prohibited


def can_decide(memberships, ws, p: dict, *, actor_id: Optional[str] = None,
               zone_geoms: Optional[dict] = None):
    """perms.Decision: may this user approve / deny / revoke permit `p` of
    workspace `ws`?"""
    from app.auth import perms
    if ws is None:
        return perms.deny(404, "Permit not found")
    ms = list(memberships)
    if actor_id and p.get("requested_by") == actor_id and not perms.is_founder(ms):
        return perms.deny(403, "You requested this permit; someone else has to decide it")
    if zone_geoms is None:
        from app.zones import engine as zone_engine
        zone_geoms = zone_engine.geometries(zone_ids(p))
    geom = restricted_footprint(p, zone_geoms)
    if geom is None:
        return perms.deny(409, "This permit has no path or area to decide on")
    return perms.check_area(ms, ws, perms.PERMITS_APPROVE, geom)


# ── Storage ───────────────────────────────────────────────────────────────

async def create(*, workspace_id: str = PLATFORM_WORKSPACE_ID, description: str,
                 waypoints: list[dict], zones: list[dict], drone_id: Optional[str] = None,
                 mission_id: Optional[str] = None, area: Optional[dict] = None,
                 valid_from: Optional[datetime] = None, valid_until: Optional[datetime] = None,
                 requested_by: Optional[str] = None, requested_by_name: str = "") -> dict | None:
    if not db_available():
        return None
    permit = Permit(
        workspace_id=workspace_id or PLATFORM_WORKSPACE_ID,
        drone_id=drone_id or None,
        mission_id=mission_id or None,
        description=description.strip()[:500],
        waypoints=waypoints or [],
        mission_hash=mission_hash(waypoints) if waypoints else "",
        area=area,
        zones=zones,
        valid_from=valid_from,
        valid_until=valid_until,
        requested_by=requested_by,
        requested_by_name=(requested_by_name or "")[:120],
    )
    async with get_session() as db:
        db.add(permit)
        await db.commit()
        d = permit.to_dict(include_waypoints=True)
    _bump()
    logger.info(f"Permit requested: {d['id'][:8]} (workspace {d['workspace_id'][:8]}, "
                f"drone {(drone_id or 'any')[:8]})")
    return d


async def get(permit_id: str) -> dict | None:
    if not db_available():
        return None
    async with get_session() as db:
        p = (await db.execute(select(Permit).where(Permit.id == permit_id))).scalar_one_or_none()
    return p.to_dict(include_waypoints=True) if p else None


async def list_permits(status: str | None = None,
                       drone_id: str | None = None,
                       include_waypoints: bool = False,
                       workspace_id: str | None = None,
                       limit: int = 200) -> list[dict]:
    if not db_available():
        return []
    stmt = select(Permit).order_by(Permit.requested_at.desc()).limit(limit)
    if status:
        stmt = stmt.where(Permit.status == status)
    if drone_id:
        stmt = stmt.where(Permit.drone_id == drone_id)
    if workspace_id:
        stmt = stmt.where(Permit.workspace_id == workspace_id)
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [p.to_dict(include_waypoints=include_waypoints) for p in rows]


async def usable_for_drone(drone: Optional[dict]) -> list[dict]:
    """Approved permits for this drone that are or will be in their window
    (the caller checks the window at the moment it matters)."""
    if not db_available() or not drone or not drone.get("id"):
        return []
    ws = drone.get("workspace_id") or PLATFORM_WORKSPACE_ID
    now = now_utc()
    stmt = select(Permit).where(
        Permit.status == APPROVED,
        Permit.workspace_id == ws,
        or_(Permit.drone_id == drone["id"], Permit.drone_id.is_(None)),
        or_(Permit.valid_until.is_(None), Permit.valid_until > now),
    )
    async with get_session() as db:
        rows = (await db.execute(stmt)).scalars().all()
    return [p.to_dict(include_waypoints=True) for p in rows]


async def _drone_record(drone) -> Optional[dict]:
    if isinstance(drone, dict) or drone is None:
        return drone
    try:
        from app.auth import service as auth
        return await auth.read_store().get_drone(str(drone))
    except Exception as e:
        logger.warning(f"permit check: drone {str(drone)[:8]} unreadable: {e}")
        return None


async def find_approved(drone, waypoints: list[dict], required: Optional[set] = None,
                        wanted: Optional[set] = None, alt_slack: float = 0.0) -> dict | None:
    """An approved, in-window permit for this drone (a registry record or
    its id) covering these waypoints through the `required` zones; among
    several, one that also covers `wanted` wins. `required` None = the
    zones the path crosses that need a permit."""
    drone = await _drone_record(drone)
    if not drone or not waypoints:
        return None
    if required is None:
        from app.zones import engine as zone_engine
        check = zone_engine.check_path([(float(w["lat"]), float(w["lng"])) for w in waypoints])
        red, orange, _ = split_zones(check["zones"])
        required = {z["id"] for z in red + orange}
    now = now_utc()
    best = None
    if not db_available():
        raise PermitCheckUnavailable("the permit database is offline")
    try:
        rows = await usable_for_drone(drone)
    except Exception as e:
        raise PermitCheckUnavailable(str(e)) from e
    for p in rows:
        if not (in_window(p, now) and applies_to_drone(p, drone)):
            continue
        if not covers_path(p, waypoints, required, alt_slack):
            continue
        if wanted is None or covers_path(p, waypoints, wanted, alt_slack):
            return p
        best = best or p
    return best


async def gate_upload(drone, waypoints: list[dict], *, ack_orange: bool,
                      alt_slack: float = 0.0) -> dict:
    """The zone gate every mission upload goes through. Returns
    {ok: True, permit, zones, orange_acked} or a refusal shaped like the
    upload results the frontend already reads:
      {ok: False, blocked: "red", zones, can_request, prohibited, msg}
      {ok: False, needs_ack: True, zones, msg}"""
    from app.zones import engine as zone_engine
    check = zone_engine.check_path([(float(w["lat"]), float(w["lng"])) for w in waypoints])
    zones = check["zones"]
    red, orange, prohibited = split_zones(zones)
    drone = await _drone_record(drone)
    if prohibited:
        names = ", ".join(z["name"] for z in prohibited)
        return {"ok": False, "blocked": "red", "zones": zones, "can_request": False,
                "prohibited": True,
                "msg": f"Mission crosses PROHIBITED (red) zone: {names} - no permit can be issued"}
    red_ids, orange_ids = {z["id"] for z in red}, {z["id"] for z in orange}
    permit = None
    if (red_ids or orange_ids) and drone:
        try:
            permit = await find_approved(drone, waypoints, required=red_ids,
                                         wanted=red_ids | orange_ids, alt_slack=alt_slack)
        except PermitCheckUnavailable as e:
            # Fail closed: without a fresh read no permit counts. Orange can
            # still be acknowledged; red waits until permits can be read.
            logger.warning(f"upload gate: permits unreadable ({e})")
            if red_ids:
                names = ", ".join(z["name"] for z in red)
                return {"ok": False, "blocked": "red", "zones": zones, "can_request": False,
                        "prohibited": False, "permit_check_failed": True,
                        "msg": f"Mission crosses NO-FLY (red) zone: {names} - its permit could "
                               "not be checked just now (database unreachable). Try again shortly"}
    if red_ids and permit is None:
        names = ", ".join(z["name"] for z in red)
        return {"ok": False, "blocked": "red", "zones": zones, "can_request": bool(drone),
                "prohibited": False,
                "msg": f"Mission crosses NO-FLY (red) zone: {names} - permission required"}
    orange_covered = permit is not None and orange_ids <= zone_ids(permit)
    if orange_ids and not orange_covered and not ack_orange:
        names = ", ".join(z["name"] for z in orange)
        return {"ok": False, "needs_ack": True, "zones": zones,
                "msg": f"Mission passes through restricted (orange) zone: {names}"}
    return {"ok": True, "permit": permit, "zones": zones,
            "orange_acked": bool(orange_ids and not orange_covered)}


_NEXT = {
    PENDING: {APPROVED, DENIED, WITHDRAWN},
    APPROVED: {REVOKED, WITHDRAWN, SUPERSEDED},
}


def transition_ok(current: str, new: str) -> bool:
    return new in _NEXT.get(current, set())


def record_live_zones(zones: list[dict], live: Optional[dict] = None) -> tuple[list[dict], list[dict]]:
    """At approval: the permit's zones with their CURRENT class and
    permission_required (what the approver actually approves), and the ones
    that now admit no permit at all."""
    live = _live({z.get("id") for z in zones}, live)
    out, prohibited = [], []
    for z in zones:
        now = live.get(z.get("id"))
        z = dict(z, **now) if now else dict(z)
        if z.get("zone_class") == "red" and not z.get("permission_required", True):
            prohibited.append(z)
        out.append(z)
    return out, prohibited


async def set_status(permit_id: str, status: str, *, actor_id: Optional[str] = None,
                     actor_name: str = "", note: str = "",
                     expect: Optional[str] = None,
                     zones: Optional[list] = None) -> tuple[dict | None, str]:
    """Move a permit along its lifecycle. Decisions (approve, deny, revoke)
    record the decider; a withdrawal records only the time. `expect` is the
    status the caller checked rights against (a concurrent change refuses).
    Returns (permit, error)."""
    if not db_available():
        return None, "Database offline"
    async with get_session() as db:
        permit = (
            await db.execute(select(Permit).where(Permit.id == permit_id).with_for_update())
        ).scalar_one_or_none()
        if permit is None:
            return None, "Permit not found"
        if expect is not None and permit.status != expect:
            return None, f"The permit is now {permit.status}; reload and try again"
        if not transition_ok(permit.status, status):
            return None, f"A {permit.status} permit cannot become {status}"
        permit.status = status
        if zones is not None:
            permit.zones = zones
        if status != WITHDRAWN:
            permit.decided_by = actor_id
            permit.decided_by_name = (actor_name or "")[:120]
            permit.decision_note = (note or "").strip()[:500]
        permit.decided_at = now_utc()
        await db.commit()
        d = permit.to_dict(include_waypoints=True)
    _bump()
    logger.info(f"Permit {permit_id[:8]} {status}")
    return d, ""


async def supersede_for_zone(zone_id: str, reason: str) -> list[dict]:
    """A zone's rules changed (class, permission_required, altitudes): every
    approved permit naming it stops counting at once, as `superseded`, and
    has to be requested again against the zone as it is now. Returns the
    superseded permits (the caller audits them)."""
    if not db_available():
        return []
    async with get_session() as db:
        rows = (await db.execute(
            select(Permit).where(Permit.status == APPROVED,
                                 type_coerce(Permit.zones, JSONB).contains([{"id": zone_id}]))
            .with_for_update()
        )).scalars().all()
        for p in rows:
            p.status = SUPERSEDED
            p.decided_at = now_utc()
            p.decision_note = (f"Superseded: {reason}")[:500]
        if rows:
            await db.commit()
        out = [p.to_dict() for p in rows]
    _bump()
    if out:
        logger.info(f"Zone {zone_id[:8]} changed: superseded permits {[p['id'][:8] for p in out]}")
    return out

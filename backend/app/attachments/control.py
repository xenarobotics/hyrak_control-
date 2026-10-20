"""
Using an attachment in flight: the guards, the command, the answer.

Every in-flight use goes through use() - the strip's buttons (socket
attachment_action), a mission's "at this waypoint" actions
(app/attachments/mission.py) and the custom-model rule action
(app/models_custom/actions.py). The bench Test in Config is
app/attachments/service.test, which runs only on a disarmed drone.

The guards, in order (check()):

  1. the drone link is up                                    no_link
  2. not taken over by HYRAK staff, unless the caller is
     the staff session holding the takeover                  taken_over
  3. the attachment exists, has that action, is enabled      no_attachment, disabled
  4. for an action that can hurt someone (hazard):
       the pilot confirmed it                                needs_confirm
       not under the red-zone pushback                       red_zone
       the drone is in the air                               not_flying
       height within the attachment's limits                 too_low, too_high
       the zone here: red refused, orange without a permit
       refused (a permit read that fails counts as none)     red_zone, orange_no_permit
       people check: a person-like class at 0.4 or more in
       this session's AI results of the last 2 s             people_below
       (no fresh AI results: allowed, and the answer says
       there was no people check)

Then the command (kinds.command_for) through the TelemetryManager:
set_actuator, gripper_command or winch_command. A plugin the installed
MAVSDK lacks answers not_supported; a refusal from the drone answers
failed with the drone's words.

Each use is answered with `attachment_result` and the session's
`attachment_state` (last command per attachment; v1 has no hardware
feedback), and audit-logged: a hyrak.audit line and an audit_events row.
"""
from __future__ import annotations

import logging
import math
import time
from types import SimpleNamespace
from typing import Any, Dict, Optional, Tuple

from app.attachments import kinds, people
from app.attachments import store as att_store

logger = logging.getLogger("verocore.attachments")

_sio = None
_session_manager = None

REASONS = {
    "needs_confirm": "it can hurt someone, so it needs a confirm first",
    "not_flying": "the drone is not flying (use Test in Config on the bench)",
    "too_low": "the drone is below this attachment's minimum height",
    "no_altitude": "the drone's height is not known, so the height limit cannot be checked",
    "too_high": "the drone is above this attachment's maximum height",
    "red_zone": "the drone is in a no-fly (red) zone",
    "orange_no_permit": "the drone is in a restricted (orange) zone without a permit",
    "people_below": "the camera sees people below",
    "taken_over": "HYRAK staff have taken over this flight",
    "no_link": "there is no drone link",
    "no_attachment": "that attachment is not fitted to this drone",
    "disabled": "that attachment is switched off in Config",
    "not_supported": "this flight controller software cannot drive that wiring",
    "failed": "the drone did not accept the command",
    "model_control_off": "model control is off",
    "rules_changed": "the model's rules changed; turn model control on again to accept them",
    "armed": "the drone is armed; Test works only on a disarmed drone",
    "not_linked": "the drone is not linked; connect it first",
    "bad_request": "that request is not valid",
    "passed_waypoint": "the drone had already left the waypoint",
}
NO_PEOPLE_CHECK = "no people check: no AI running"


def configure(sio, session_manager) -> None:
    global _sio, _session_manager
    _sio, _session_manager = sio, session_manager


def reason(code: Optional[str], error: Optional[str] = None) -> str:
    text = REASONS.get(code or "", code or "")
    if code == "failed" and error:
        text = f"{text}: {error}"
    return text


# ── per-session last command (attachment_state) ───────────────────────────

_state: Dict[str, Dict[str, dict]] = {}


def state(session_id: str) -> dict:
    return {"attachments": [dict(v) for v in (_state.get(session_id) or {}).values()]}


def _note(session_id: str, attachment_id: str, action_id: str, ok: bool) -> None:
    _state.setdefault(session_id, {})[attachment_id] = {
        "id": attachment_id, "last_action_id": action_id, "last_at": time.time(), "ok": ok}


def drop(session_id: str) -> None:
    """Session torn down."""
    _state.pop(session_id, None)
    people.drop(session_id)


def reset_for_tests() -> None:
    _state.clear()
    people.reset_for_tests()


# ── lookups ───────────────────────────────────────────────────────────────

def _tel(session_id: str):
    return _session_manager.get_telemetry(session_id) if _session_manager is not None else None


def _linked(tel) -> bool:
    if tel is None or not getattr(tel, "is_connected", False):
        return False
    snap = getattr(tel, "snapshot", None)
    return bool(getattr(snap, "link_ok", True)) if snap is not None else True


def _in_air(tel) -> bool:
    try:
        return bool(tel.snapshot.flight_mode.is_in_air)
    except Exception:
        return False


def _armed(tel) -> bool:
    try:
        return bool(tel.snapshot.flight_mode.is_armed)
    except Exception:
        return True                     # unknown: not safe to call it disarmed


def _rel_alt(tel) -> Optional[float]:
    try:
        v = tel.snapshot.position.relative_altitude_m
        v = None if v is None else float(v)
        return v if v is not None and math.isfinite(v) else None
    except Exception:
        return None


def drone_id_of(session) -> Optional[str]:
    d = getattr(session, "drone", None)
    return d.get("id") if isinstance(d, dict) else None


async def load(drone_id: Optional[str]) -> list:
    if not drone_id:
        return []
    try:
        return await att_store.read_store().list_for_drone(drone_id)
    except Exception as e:
        logger.warning(f"Attachments of drone {drone_id[:8]} unreadable: {e}")
        return []


async def find(session, attachment_id) -> Optional[dict]:
    if not isinstance(attachment_id, str):
        return None
    for a in await load(drone_id_of(session)):
        if a.get("id") == attachment_id:
            return a
    return None


async def first_of_kind(session, kind: str) -> Optional[dict]:
    """The rule action's attachment: the first enabled one of that kind on
    the session's drone."""
    for a in await load(drone_id_of(session)):
        if a.get("kind") == kind and a.get("enabled", True):
            return a
    return None


# ── guards ────────────────────────────────────────────────────────────────

async def zone_reason(session, tel) -> Optional[str]:
    """red_zone / orange_no_permit at the drone's position. Permits are
    read fresh; a read that fails counts as no permit. No position fix: no
    zone applies (as in the zone monitor)."""
    try:
        pos = tel.snapshot.position
        lat, lng = float(pos.latitude_deg or 0.0), float(pos.longitude_deg or 0.0)
        alt = float(pos.relative_altitude_m or 0.0)
    except Exception:
        return None
    if not lat and not lng:
        return None
    from app.zones import engine
    res = engine.check_point(lat, lng, alt)
    if res["zone_class"] == "red":
        return "red_zone"
    orange = [z for z in res["zones"]
              if z["zone_class"] == "orange" and z.get("permission_required", True)]
    if not orange:
        return None
    from app.zones import monitor
    try:
        permitted = await monitor.permitted_zone_ids(session, lat, lng, fresh=True)
    except Exception:
        permitted = set()                         # fail closed
    if any(z["id"] not in permitted for z in orange):
        return "orange_no_permit"
    return None


async def check(session, att: Optional[dict], action_id, *, value=None, confirm: bool = False,
                actor_session_id: Optional[str] = None) -> Tuple[Optional[str], str, Optional[dict],
                                                                  Optional[float]]:
    """(first failing guard or None, note, the action, sprayer level)."""
    from app.sessions import takeover
    sid = session.session_id
    tel = _tel(sid)
    if not _linked(tel):
        return "no_link", "", None, None
    if takeover.blocking(sid, actor_session_id=actor_session_id or sid) is not None:
        return "taken_over", "", None, None
    if att is None:
        return "no_attachment", "", None, None
    action = kinds.find_action(att, action_id)
    if action is None:
        return "no_attachment", "", None, None
    if not att.get("enabled", True):
        return "disabled", "", action, None
    level = None
    if att.get("kind") == "sprayer" and action.get("id") == "level":
        try:
            level = kinds.level_pct(value)
        except kinds.AttachmentError:
            return "bad_request", "", action, None
    if not action.get("hazard"):
        return None, "", action, level
    if not confirm:
        return "needs_confirm", "", action, level
    if getattr(session, "zone_lock", False):
        return "red_zone", "", action, level
    if not _in_air(tel):
        return "not_flying", "", action, level
    lim = att.get("limits") or {}
    alt = _rel_alt(tel)
    if alt is None and (float(lim.get("min_alt_m") or 0.0) > 0 or lim.get("max_alt_m") is not None):
        return "no_altitude", "", action, level          # a limit we cannot check: fail closed
    if alt is not None:
        if alt < float(lim.get("min_alt_m") or 0.0):
            return "too_low", "", action, level
        if lim.get("max_alt_m") is not None and alt > float(lim["max_alt_m"]):
            return "too_high", "", action, level
    code = await zone_reason(session, tel)
    if code:
        return code, "", action, level
    note = ""
    if lim.get("people_check", True):
        seen = people.check(sid)
        if seen == "people":
            return "people_below", "", action, level
        if seen == "no_ai":
            note = NO_PEOPLE_CHECK
    return None, note, action, level


async def execute(tel, att: dict, action: dict, level: Optional[float] = None) -> Tuple[bool, Optional[str], str]:
    """(ok, reason_code, the drone's words). Sends the command once."""
    cmd = kinds.command_for(att, action, level)
    try:
        if cmd["type"] == kinds.ACTUATOR:
            ok = await tel.set_actuator(cmd["index"], cmd["value"])
        elif cmd["type"] == kinds.GRIPPER:
            ok = await tel.gripper_command(cmd["instance"], cmd["op"])
        else:
            ok = await tel.winch_command(cmd["instance"], cmd["op"])
    except (NotImplementedError, AttributeError) as e:
        return False, "not_supported", str(e)
    except Exception as e:
        logger.warning(f"Attachment command failed: {e}")
        return False, "failed", str(e)
    if ok:
        return True, None, ""
    return False, "failed", getattr(tel, "last_action_error", None) or ""


# ── the answer and the audit ──────────────────────────────────────────────

def label_of(att: Optional[dict], action: Optional[dict], level: Optional[float]) -> str:
    what = (action or {}).get("label") or "Command"
    if level is not None:
        what = f"{what} {level:g}%"
    name = (att or {}).get("name")
    return f"{name}: {what}" if name else what


def result(attachment_id, action_id, ok: bool, message: str, code: Optional[str] = None,
           **extra) -> dict:
    out: Dict[str, Any] = {"attachment_id": attachment_id, "action_id": action_id, "ok": ok,
                           "message": message, "ts": time.time(), **extra}
    if code:
        out["reason_code"] = code
    return out


async def _emit(to, event: str, payload: dict) -> None:
    if _sio is None or not to:
        return
    try:
        await _sio.emit(event, payload, to=to)
    except Exception as e:
        logger.debug(f"{event} failed: {e}")


async def audit_use(actor, session, att: Optional[dict], action_id, out: dict, *,
                    source: str, kind: str = "attachment.use") -> None:
    """A hyrak.audit line and an audit_events row. Never raises."""
    from app.auth import audit
    from app.auth import service as auth
    drone = getattr(session, "drone", None) or {}
    sid = getattr(session, "session_id", None)
    audit.log(actor, f"{kind} {source} {(att or {}).get('id')}/{action_id} "
                     f"{'ok' if out.get('ok') else out.get('reason_code')}",
              session_id=sid, drone=drone.get("id"))
    detail = {"attachment_id": (att or {}).get("id") or out.get("attachment_id"),
              "attachment_name": (att or {}).get("name"), "kind": (att or {}).get("kind"),
              "action_id": action_id, "ok": bool(out.get("ok")),
              "reason_code": out.get("reason_code"), "source": source, "session_id": sid,
              "drone_name": drone.get("name")}
    if out.get("level") is not None:
        detail["level"] = out["level"]
    try:
        await audit.record(auth.write_store(), actor, kind,
                           workspace_id=drone.get("workspace_id") or getattr(session, "workspace_id", None),
                           target_type="drone", target_id=drone.get("id") or "", detail=detail,
                           ip=getattr(actor, "client_ip", None) or "")
    except Exception as e:
        logger.warning(f"audit row for {kind} not written: {e}")


def _actor(session) -> SimpleNamespace:
    return SimpleNamespace(id=getattr(session, "user_id", None),
                           username=getattr(session, "username", None),
                           role=getattr(session, "role", None),
                           client_ip=getattr(session, "client_ip", None))


async def use(session, attachment_id, action_id, *, value=None, confirm: bool = False,
              source: str = "manual", actor_session=None, att: Optional[dict] = None,
              extra: Optional[dict] = None) -> dict:
    """One in-flight use, guarded, sent, answered and audited. Returns the
    attachment_result payload. `actor_session` is the staff session when a
    takeover holder sends it to this session's drone."""
    sid = session.session_id
    actor_session = actor_session or session
    if att is None:
        att = await find(session, attachment_id)
    code, note, action, level = await check(
        session, att, action_id, value=value, confirm=confirm,
        actor_session_id=actor_session.session_id)
    what = label_of(att, action or kinds.find_action(att or {}, action_id), level)
    extra = dict(extra or {}, source=source)
    if att is not None:
        extra["name"] = att.get("name")
    if level is not None:
        extra["level"] = level
    sent = not code
    if code:
        out = result(attachment_id, action_id, False, f"{what} not done: {reason(code)}", code, **extra)
    else:
        tel = _tel(sid)
        ok, code, error = await execute(tel, att, action, level)
        if ok:
            msg = f"{what}: sent" + (f" ({note})" if note else "")
            out = result(attachment_id, action_id, True, msg, **extra)
        else:
            out = result(attachment_id, action_id, False,
                         f"{what} not done: {reason(code, error)}", code, **extra)
        _note(sid, att["id"], action["id"], ok)
    logger.info(f"Session {sid[:8]}: attachment {attachment_id}/{action_id} ({source}) -> "
                f"{'ok' if out['ok'] else out.get('reason_code')}")
    targets = {session.socket_id, getattr(actor_session, "socket_id", None)}
    for to in targets:
        await _emit(to, "attachment_result", out)
    if sent:
        for to in targets:
            await _emit(to, "attachment_state", state(sid))
    await audit_use(_actor(actor_session), session, att, action_id, out, source=source)
    return out

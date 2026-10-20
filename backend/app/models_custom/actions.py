"""
No-code rules, the part that acts: what a fired rule does, the pilot's
"Allow model control" switch, and the guards in front of anything that
moves the drone. The rule logic itself is app/models_custom/rules.py.

Called from the event loop only:
  * stream_track, once per analysed custom-model frame (on_result): runs
    the rules that fired, keeps or ends an active follow, strips
    `drone_command` unless a follow is on, adds `model_control` to
    cv_results.
  * app/models_custom/events.py: set_model_control, rule_confirm.
  * the switch-off hooks: staff takeover (admin_events), pilot override
    and link release (telemetry_events), every telemetry update
    (on_telemetry: link lost, red-zone lock, pilot, takeover), leaving the
    model (set_analysis_mode, notify.stop_sessions_running), the pilot's
    socket going away, and session teardown (drop).

Actions:
  alert   rule_event done, plus the admin alert HYRAK staff see.
  mark    a pinned sighting on the map (app/mapdetect/live.pin), saved
          with the flight; no position for the frame -> refused.
  hover   mission paused, else HOLD.
  follow  Offboard, then the analyzer steers toward the locked box
          (analyzer.start_follow); stopped with HOLD when the target is
          lost for rules.LOST_S, or when a guard fails on any frame.
  attachment  the first enabled attachment of the rule's kind on the
          session's drone does the rule's action (app/attachments). Its
          own guards (app/attachments/control.py) run as for a button
          press; one that can hurt someone always asks first.

hover, follow and attachment need model control on (per session, in memory, off by
default, never stored) and, unless the rule says otherwise, the pilot's
yes on a confirm chip (rules.PendingConfirms, 10 s). Every moving action
checks ALL guards at the moment it runs, a confirmed one included
(_guard): model control, takeover, pilot control, link, in air, red-zone
lock, and for follow the zone at the current position (red, or orange
without a permit).

Ending a follow commands HOLD only when nobody else owns the drone at that
moment: not after a takeover (staff decide, _stop_ai_steering already
holds), a pilot override (the pilot is flying), a red-zone lock (the zone
monitor's pushback is flying it out) or a lost link (nothing reaches it).
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.models_custom import rules as _rules
from app.models_custom import runtime

logger = logging.getLogger("verocore.models.actions")

_sio = None
_session_manager = None
_vision_pool = None

REASONS = {
    "model_control_off": "model control is off",
    "taken_over": "HYRAK staff have taken over this flight",
    "pilot_control": "the pilot has the drone",
    "no_link": "there is no drone link",
    "not_flying": "the drone is not flying",
    "red_zone": "the drone is in a no-fly (red) zone",
    "orange_no_permit": "the drone is in a restricted (orange) zone without a permit",
    "no_position": "this frame has no position to put on the map",
    "target_lost": "the target was out of sight for 3 s",
    "mode_changed": "the AI model is no longer running",
    "link_lost": "the drone link was lost",
    "failed": "the drone did not accept the command",
    "rules_changed": "the model's hover, follow or attachment rules changed; turn model control "
                     "on again to accept them",
}
# Ending a follow for these leaves the drone to whoever owns it now.
_NO_HOLD = frozenset({"taken_over", "pilot_control", "red_zone", "link_lost"})


def configure(sio, session_manager, vision_pool=None) -> None:
    global _sio, _session_manager, _vision_pool
    _sio, _session_manager, _vision_pool = sio, session_manager, vision_pool


@dataclass
class Control:
    enabled: bool = False
    mode: str = ""                          # the custom mode it was switched on for
    follow: Optional[Dict[str, Any]] = None  # {rule_id, label, since, model_id}
    busy: bool = False                      # a follow is starting
    # The hover/follow rules the pilot accepted by switching control on.
    # Rules are edited live by workspace owners and admins: a change to any
    # rule that moves the drone switches control off, so the pilot opts in
    # to the new rules instead of an editor arming them mid-flight.
    accepted: tuple = ()


_controls: Dict[str, Control] = {}
_pending = _rules.PendingConfirms()


def reset_for_tests() -> None:
    _controls.clear()
    _pending._by_token.clear()


def control(session_id: str) -> Optional[Control]:
    return _controls.get(session_id)


def is_enabled(session_id: str) -> bool:
    c = _controls.get(session_id)
    return bool(c and c.enabled)


def following(session_id: str) -> bool:
    c = _controls.get(session_id)
    return bool(c and c.follow)


def drop(session_id: str) -> None:
    """Session torn down."""
    _controls.pop(session_id, None)
    _pending.drop_session(session_id)


# ── helpers ───────────────────────────────────────────────────────────────

def _session(session_id: str):
    return _session_manager.get(session_id) if _session_manager is not None else None


def _tel(session_id: str):
    return _session_manager.get_telemetry(session_id) if _session_manager is not None else None


def _analyzer(session_id: str):
    if _vision_pool is None:
        return None
    try:
        a = _vision_pool.get_for_session(session_id)
    except Exception:
        return None
    return a if hasattr(a, "start_follow") else None


def _custom_mode(session) -> Optional[str]:
    mode = getattr(session, "mode", None)
    if mode is None or getattr(mode, "spec", None) is None:
        return None
    return mode.value


def _moving_rules(session) -> tuple:
    """The running model's current hover/follow/attachment rules (all that
    need model control), as a comparable snapshot of everything that
    decides when they fire and what they do (live edits included, as the
    analyzer reads them). Each rule carries the class indices its label
    matches under the current class names, so renaming a class onto such
    a rule's label counts as a change too."""
    spec = getattr(getattr(session, "mode", None), "spec", None)
    if spec is None:
        return ()
    rules = getattr(spec, "rules", None)
    labels = list(getattr(spec, "labels", None) or (getattr(spec, "spec", None) or {}).get("labels") or [])
    if not getattr(spec, "via_catalogue", False):
        live = runtime.live(spec.model_id) or {}
        if "rules" in live:
            rules = live["rules"]
        if live.get("labels") and live.get("labels_version") == getattr(spec, "version", None):
            labels = list(live["labels"])
    lowered = [str(n).lower() for n in labels]
    return tuple(sorted(
        (str(r.get("id")), str(r.get("label")).lower(),
         tuple(i for i, n in enumerate(lowered) if n == str(r.get("label")).lower()),
         float(r.get("min_score", 0)), float(r.get("for_s", 0)), float(r.get("cooldown_s", 0)),
         r.get("action"), bool(r.get("confirm", True)), bool(r.get("enabled", True)),
         r.get("attachment_kind"), r.get("attachment_action"), r.get("attachment_value"))
        for r in (rules or []) if r.get("action") in _rules.NEEDS_CONTROL))


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


def _seen(label: str, score: Optional[float]) -> str:
    name = (label or "Object")[:1].upper() + (label or "Object")[1:]
    return f"{name} seen ({score * 100:.0f}%)" if score is not None else f"{name} seen"


def _reason(code: Optional[str], tel=None) -> str:
    text = REASONS.get(code or "", code or "")
    if code == "failed" and tel is not None and getattr(tel, "last_action_error", None):
        text = f"{text}: {tel.last_action_error}"
    return text


async def _emit(session_id: str, event: str, payload: dict) -> None:
    s = _session(session_id)
    if _sio is None or s is None or not s.socket_id:
        return
    try:
        await _sio.emit(event, payload, to=s.socket_id)
    except Exception as e:
        logger.debug(f"{event} to {session_id[:8]} failed: {e}")


def _spawn(coro) -> None:
    try:
        asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        coro.close()


def state(session_id: str, reason_code: Optional[str] = None) -> dict:
    """The `model_control` payload."""
    c = _controls.get(session_id)
    out: Dict[str, Any] = {"enabled": bool(c and c.enabled)}
    if reason_code:
        out["reason_code"] = reason_code
        out["reason"] = _reason(reason_code)
    if c and c.follow:
        out["following"] = {"label": c.follow["label"], "since": c.follow["since"]}
    return out


def _event(base: dict, status: str, message: str, *, reason_code: Optional[str] = None,
           token: Optional[str] = None, expires_at: Optional[float] = None) -> dict:
    ev = {"id": secrets.token_hex(8), **base, "status": status, "message": message,
          "ts": time.time()}
    if reason_code:
        ev["reason_code"] = reason_code
    if token:
        ev["token"] = token
    if expires_at is not None:
        ev["expires_at"] = expires_at
    return ev


def _base(fire: dict, session=None) -> dict:
    rule = fire.get("rule") or {}
    spec = getattr(getattr(session, "mode", None), "spec", None)
    return {"rule_id": rule.get("id"), "model_id": fire.get("model_id") or getattr(spec, "model_id", None),
            "model_name": fire.get("model_name") or getattr(spec, "name", None),
            "label": fire.get("label"), "score": fire.get("score"), "action": rule.get("action")}


# ── guards ────────────────────────────────────────────────────────────────

def _off_reason(session, c: Control) -> Optional[str]:
    """Why model control must switch itself off now, or None."""
    from app.sessions import takeover
    sid = session.session_id
    if takeover.blocking(sid, actor_session_id=sid) is not None:
        return "taken_over"
    tel = _tel(sid)
    if tel is not None and getattr(tel, "pilot_has_control", False):
        return "pilot_control"
    if not _linked(tel):
        return "link_lost"
    if getattr(session, "zone_lock", False):
        return "red_zone"
    if _custom_mode(session) != c.mode:
        return "mode_changed"
    if _moving_rules(session) != c.accepted:
        return "rules_changed"
    return None


async def _zone_reason(session, tel) -> Optional[str]:
    """red_zone / orange_no_permit at the drone's current position. No
    position fix: no zone applies (as in the zone monitor)."""
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
        permitted = await monitor.permitted_zone_ids(session, lat, lng)
    except Exception:
        permitted = set()                         # fail closed
    if any(z["id"] not in permitted for z in orange):
        return "orange_no_permit"
    return None


async def _guard(session, action: str) -> Optional[str]:
    """The first guard a moving action fails, or None. Runs at the moment
    the action runs, confirmed or not."""
    from app.sessions import takeover
    sid = session.session_id
    c = _controls.get(sid)
    if c is None or not c.enabled:
        return "model_control_off"
    if takeover.blocking(sid, actor_session_id=sid) is not None:
        return "taken_over"
    tel = _tel(sid)
    if tel is not None and getattr(tel, "pilot_has_control", False):
        return "pilot_control"
    if not _linked(tel):
        return "no_link"
    if not _in_air(tel):
        return "not_flying"
    if getattr(session, "zone_lock", False):
        return "red_zone"
    if _custom_mode(session) != c.mode:
        return "mode_changed"
    if _moving_rules(session) != c.accepted:
        return "rules_changed"
    if action == "follow":
        return await _zone_reason(session, tel)
    return None


# ── stopping ──────────────────────────────────────────────────────────────

async def _hold(tel) -> bool:
    """Leave Offboard and HOLD, unless someone else owns the drone."""
    if not _linked(tel) or getattr(tel, "pilot_has_control", False) \
            or getattr(tel, "automation_locked", False):
        return False
    try:
        if getattr(tel, "_offboard_active", False):
            await tel.stop_offboard()
        return bool(await tel.set_flight_mode("HOLD"))
    except Exception as e:
        logger.warning(f"Rule follow stop: HOLD failed: {e}")
        return False


def _end_follow_now(session_id: str) -> Optional[dict]:
    """The synchronous half of ending a follow: no more commands from this
    moment (the analyzer stops steering, on_result strips any in flight).
    Returns what was being followed."""
    c = _controls.get(session_id)
    if c is None or c.follow is None:
        return None
    f, c.follow = c.follow, None
    a = _analyzer(session_id)
    if a is not None:
        a.stop_follow()
    return f


async def _after_follow(session_id: str, f: dict, code: Optional[str], *, hold: bool,
                        message: Optional[str] = None) -> None:
    tel = _tel(session_id)
    if hold:
        await _hold(tel)
    base = {"rule_id": f.get("rule_id"), "model_id": f.get("model_id"),
            "model_name": f.get("model_name"), "label": f.get("label"),
            "score": f.get("score"), "action": "follow"}
    await _emit(session_id, "rule_event", _event(
        base, "stopped", message or f"Follow stopped: {_reason(code)}", reason_code=code))
    logger.info(f"Session {session_id[:8]}: rule follow of {f.get('label')} stopped ({code})")


async def stop_follow(session_id: str, code: Optional[str], *, hold: Optional[bool] = None) -> bool:
    f = _end_follow_now(session_id)
    if f is None:
        return False
    await _after_follow(session_id, f, code, hold=(code not in _NO_HOLD) if hold is None else hold)
    await _emit(session_id, "model_control", state(session_id))
    return True


def _off_now(session_id: str) -> tuple[bool, Optional[dict]]:
    c = _controls.get(session_id)
    if c is None or (not c.enabled and c.follow is None):
        return False, None
    c.enabled = False
    return True, _end_follow_now(session_id)


async def _after_off(session_id: str, code: Optional[str], f: Optional[dict],
                     hold: Optional[bool] = None) -> None:
    if f is not None:
        await _after_follow(session_id, f, code or "model_control_off",
                            hold=(code not in _NO_HOLD) if hold is None else hold)
    await _emit(session_id, "model_control", state(session_id, code))
    if code:
        logger.info(f"Session {session_id[:8]}: model control switched off ({code})")


async def switch_off(session_id: str, code: Optional[str], *, hold: Optional[bool] = None) -> bool:
    """Model control off, an active follow stopped (HOLD unless `code`
    leaves the drone to someone else), `model_control` pushed. False when
    it was already off."""
    changed, f = _off_now(session_id)
    if not changed:
        return False
    await _after_off(session_id, code, f, hold)
    return True


def on_telemetry(session_id: str) -> None:
    """Every telemetry update (the link watchdog pushes one during an
    outage too): switch off on link loss, red-zone lock, pilot or takeover.
    A dict lookup when model control is off."""
    c = _controls.get(session_id)
    if c is None or not c.enabled:
        return
    s = _session(session_id)
    if s is None:
        return
    code = _off_reason(s, c)
    if code:
        _, f = _off_now(session_id)
        _spawn(_after_off(session_id, code, f))


# ── the frame hook ────────────────────────────────────────────────────────

async def on_result(session_id: str, mode: str, meta: Dict[str, Any],
                    capture: Optional[Dict[str, Any]] = None, frame=None) -> None:
    """One analysed custom-model frame, on the event loop, before
    stream_track looks at drone_command."""
    fires = meta.pop("_rule_fires", None)
    lost = meta.pop("_follow_lost", False)
    session = _session(session_id)
    c = _controls.get(session_id)
    if c is not None and session is not None and c.enabled:
        code = _off_reason(session, c)
        if code:
            _, f = _off_now(session_id)
            _spawn(_after_off(session_id, code, f))
    if c is not None and c.follow is not None and session is not None:
        code = "target_lost" if lost else await _zone_reason(session, _tel(session_id))
        if code and c.follow is not None:
            f = _end_follow_now(session_id)
            _spawn(_after_follow(session_id, f, code, hold=code not in _NO_HOLD))
            _spawn(_emit(session_id, "model_control", state(session_id)))
    if c is None or c.follow is None:
        # No follow, no command: whatever the analyzer still produced.
        meta.pop("drone_command", None)
        meta.pop("follow", None)
        a = _analyzer(session_id)
        if a is not None and a.following:
            a.stop_follow()
    else:
        c.follow["score"] = (meta.get("follow") or {}).get("score", c.follow.get("score"))
    meta["model_control"] = bool(c and c.enabled)
    for p in _pending.expired(session_id=session_id):
        e = p.entry
        _spawn(_emit(session_id, "rule_event", _event(
            e["base"], "expired", f"{_seen(e['base']['label'], e['base']['score'])}: "
            f"not done, nobody answered in time", token=p.token)))
    if fires and session is not None:
        for fire in fires:
            fire.setdefault("model_id", meta.get("model_id"))
            fire.setdefault("model_name", meta.get("model_name"))
            handle_fire(session, mode, fire, meta, capture, frame)


def handle_fire(session, mode: str, fire: dict, meta=None, capture=None, frame=None) -> None:
    sid = session.session_id
    base = _base(fire, session)
    action = base["action"]
    seen = _seen(base["label"], base["score"])
    if action == "alert":
        _spawn(_emit(sid, "rule_event", _event(base, "done", seen)))
        from app.events.admin_events import emit_admin_alert
        drone = (getattr(session, "drone", None) or {}).get("name") or f"session {sid[:8]}"
        name = base.get("model_name") or "Custom model"
        _spawn(emit_admin_alert(_session_manager, {
            "level": "warning", "session_id": sid, "drone": drone, "ts": time.time(),
            "message": f"{name}: {seen}", "source": "custom_model",
            "model_id": base.get("model_id")}))
    elif action == "mark":
        from app.mapdetect import live as map_live
        sighting, why = map_live.pin(sid, mode, meta or {}, capture, frame,
                                     label=base["label"], score=base["score"], box=fire.get("box"),
                                     rule=(fire.get("rule") or {}).get("label") or base["label"])
        if sighting is None:
            _spawn(_emit(sid, "rule_event", _event(
                base, "refused", f"Mark not done: {_reason('no_position')}",
                reason_code="no_position")))
        else:
            _spawn(_emit(sid, "rule_event", _event(base, "done", f"{seen}: marked on the map")))
    elif action in _rules.MOVING:
        _spawn(run_moving(session, fire, base))
    elif action == "attachment":
        _spawn(run_attachment(session, fire, base))


_QUESTION = {"hover": "Stop and hover here?", "follow": "Follow it?"}
_DONE = {"hover": "hovering", "follow": "following"}
_NAME = {"hover": "Hover", "follow": "Follow"}


async def run_moving(session, fire: dict, base: dict, *, token: Optional[str] = None) -> None:
    """hover or follow: guards, then the confirm chip (unless the rule says
    no, or this IS the confirmed run), then the action, guards again."""
    sid = session.session_id
    action = base["action"]
    rule = fire.get("rule") or {}
    c = _controls.get(sid)
    if action == "follow" and c is not None and (c.follow is not None or c.busy):
        if token is not None:
            await _emit(sid, "rule_event", _event(
                base, "refused", "Follow not done: already following", reason_code="failed",
                token=token))
        return                                    # already on it
    code = await _guard(session, action)
    if code:
        await _emit(sid, "rule_event", _event(
            base, "refused", f"{_NAME[action]} not done: {_reason(code)}",
            reason_code=code, token=token))
        return
    seen = _seen(base["label"], base["score"])
    if rule.get("confirm", True) and token is None:
        p = _pending.add(sid, {"fire": fire, "base": base})
        await _emit(sid, "rule_event", _event(
            base, "awaiting_confirm", f"{seen}. {_QUESTION[action]}",
            token=p.token, expires_at=p.expires_at))
        return
    tel = _tel(sid)
    if action == "hover":
        ok = await _do_hover(sid, tel)
    else:
        ok = await _do_follow(session, tel, fire, base, confirmed=token is not None)
    if ok is True:
        await _emit(sid, "rule_event", _event(base, "done", f"{seen}: {_DONE[action]}", token=token))
        if action == "follow":
            await _emit(sid, "model_control", state(sid))
    else:
        code = ok or "failed"
        await _emit(sid, "rule_event", _event(
            base, "refused", f"{_NAME[action]} not done: {_reason(code, tel)}",
            reason_code=code, token=token))


async def _do_hover(session_id: str, tel):
    f = _end_follow_now(session_id)
    if f is not None:
        await _after_follow(session_id, f, None, hold=False,
                            message="Follow stopped: hovering instead")
        await _emit(session_id, "model_control", state(session_id))
    try:
        if getattr(tel, "_offboard_active", False):
            await tel.stop_offboard()
        if tel.snapshot.flight_mode.mode == "MISSION":
            return True if await tel.pause_mission() else "failed"
        return True if await tel.set_flight_mode("HOLD") else "failed"
    except Exception as e:
        logger.warning(f"Rule hover failed on {session_id[:8]}: {e}")
        return "failed"


async def _do_follow(session, tel, fire: dict, base: dict, confirmed: bool = False):
    sid = session.session_id
    c = _controls.get(sid)
    a = _analyzer(sid)
    if c is None or a is None or not fire.get("box"):
        return "failed"
    # A confirmed follow starts seconds after the rule fired: lock on where
    # the target is now. Out of view now: nothing to follow, nothing started.
    box, score = fire.get("box"), base["score"] or 0.0
    now = a.current_box(base["label"], box)
    if now is not None:
        box, score = now
    elif confirmed:
        return "target_lost"
    c.busy = True
    try:
        if not await tel.start_offboard():
            return "failed"
        # Anything may have changed while Offboard started.
        code = await _guard(session, "follow")
        if code:
            if code not in _NO_HOLD:
                await _hold(tel)
            return code
        c.follow = {"rule_id": base["rule_id"], "label": base["label"], "score": score,
                    "since": time.time(), "model_id": base["model_id"],
                    "model_name": base["model_name"]}
        a.start_follow(base["label"], box, score)
        logger.info(f"Session {sid[:8]}: rule follow of {base['label']} started")
        return True
    except Exception as e:
        logger.warning(f"Rule follow start failed on {sid[:8]}: {e}")
        return "failed"
    finally:
        c.busy = False


# ── socket handlers' work (app/models_custom/events.py) ───────────────────

async def set_enabled(session, enabled: bool) -> dict:
    """Pilot's switch. On is refused when staff hold the flight, the pilot
    has the drone, there is no link, or no custom model is running; off is
    always allowed and stops an active follow with HOLD."""
    from app.sessions import takeover
    sid = session.session_id
    if not enabled:
        changed, f = _off_now(sid)
        if f is not None:
            await _after_follow(sid, f, "model_control_off", hold=True)
        out = state(sid)
        await _emit(sid, "model_control", out)
        return out
    tel = _tel(sid)
    code = None
    if takeover.blocking(sid, actor_session_id=sid) is not None:
        code = "taken_over"
    elif tel is not None and getattr(tel, "pilot_has_control", False):
        code = "pilot_control"
    elif not _linked(tel):
        code = "no_link"
    elif _custom_mode(session) is None:
        code = "mode_changed"
    elif getattr(session, "zone_lock", False):
        code = "red_zone"
    if code:
        out = {"enabled": False, "reason_code": code,
               "reason": "no custom model is running" if code == "mode_changed" else _reason(code)}
        await _emit(sid, "model_control", out)
        return out
    c = _controls.setdefault(sid, Control())
    c.enabled, c.mode = True, _custom_mode(session)
    c.accepted = _moving_rules(session)
    logger.info(f"Session {sid[:8]}: model control on for {c.mode}")
    out = state(sid)
    await _emit(sid, "model_control", out)
    return out


async def confirm(session, token, accept: bool) -> None:
    sid = session.session_id
    p = _pending.take(token, sid)
    if p is None:
        await _emit(sid, "rule_event", _event(
            {"rule_id": None, "model_id": None, "model_name": None, "label": None,
             "score": None, "action": None},
            "expired", "That request has run out. Nothing was done.",
            token=token if isinstance(token, str) else None))
        return
    base = p.entry["base"]
    if not accept:
        await _emit(sid, "rule_event", _event(
            base, "declined", f"{_seen(base['label'], base['score'])}: left as is", token=p.token))
        return
    if base.get("action") == "attachment":
        await run_attachment(session, p.entry["fire"], base, token=p.token)
        return
    await run_moving(session, p.entry["fire"], base, token=p.token)


# ── attachment rules (app/attachments) ────────────────────────────────────

def _control_reason(session) -> Optional[str]:
    """model control on, for this model, with the rules the pilot accepted."""
    c = _controls.get(session.session_id)
    if c is None or not c.enabled:
        return "model_control_off"
    if _custom_mode(session) != c.mode:
        return "mode_changed"
    if _moving_rules(session) != c.accepted:
        return "rules_changed"
    return None


async def run_attachment(session, fire: dict, base: dict, *, token: Optional[str] = None) -> None:
    """An attachment rule: model control, then the attachment's own guards,
    then the confirm chip (always for an action that can hurt someone, else
    as the rule says), then the command through app/attachments/control.use,
    which checks every guard again at that moment."""
    from app.attachments import control as att_control
    from app.attachments import kinds as att_kinds
    sid = session.session_id
    rule = fire.get("rule") or {}
    kind, action_id = rule.get("attachment_kind"), rule.get("attachment_action")
    value = rule.get("attachment_value")
    seen = _seen(base["label"], base["score"])
    base = {**base, "attachment_kind": kind, "attachment_action": action_id}

    async def refuse(code: str, text: str) -> None:
        await _emit(sid, "rule_event", _event(base, "refused", f"{text} not done: "
                                              f"{_reason(code) if code in REASONS else att_control.reason(code)}",
                                              reason_code=code, token=token))

    code = _control_reason(session)
    if code:
        await refuse(code, "Attachment")
        return
    att = await att_control.first_of_kind(session, kind)
    action = att_kinds.find_action(att, action_id) if att else None
    if att is None or action is None:
        await refuse("no_attachment", "Attachment")
        return
    what = att_control.label_of(att, action, None if value is None else float(value))
    base["attachment_id"] = att["id"]
    # A custom attachment's states are the user's own: always ask first.
    hazard = bool(action.get("hazard")) or kind == "custom"
    code, _, _, _ = await att_control.check(session, att, action_id, value=value, confirm=True)
    if code:
        await refuse(code, what)
        return
    if (hazard or rule.get("confirm", True)) and token is None:
        p = _pending.add(sid, {"fire": fire, "base": base})
        await _emit(sid, "rule_event", _event(
            base, "awaiting_confirm", f"{seen}. {what}?", token=p.token, expires_at=p.expires_at))
        return
    out = await att_control.use(session, att["id"], action_id, value=value, confirm=True,
                                source="rule", att=att, extra={"rule_id": base.get("rule_id")})
    if out["ok"]:
        await _emit(sid, "rule_event", _event(base, "done", f"{seen}: {out['message']}", token=token))
    else:
        await _emit(sid, "rule_event", _event(base, "refused", f"{seen}: {out['message']}",
                                              reason_code=out.get("reason_code"), token=token))

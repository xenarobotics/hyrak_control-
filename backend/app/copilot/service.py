"""
Copilot per session: on/off, the conversation, plan cards, the one active
task, and the hooks the rest of the backend calls.

Flow of an utterance (handle_text; audio is transcribed first):
  1. An open card and a yes / no / "number two": answer the card.
  2. The local parser's safety skills (hold, stop_task, land, return_home)
     and status run at once, never behind the network or a busy planner.
  3. Otherwise, under the session's lock: describe / count from the local
     parser, else Claude when ANTHROPIC_API_KEY is set (the local parser
     when it fails), else the local parser.
  4. run_plan: arguments checked (skills.validate), guards checked
     (skills.guard), then either the answer, or a plan card the pilot
     confirms within CARD_TTL_S. Accepting re-checks every guard at that
     moment (execute).

Tasks (one per session): follow (a built-in tracker's track, flown by the
tracker and pursuit exactly as a tap-to-follow), follow_me (guarded
reposition toward the pilot's browser position, <= 1 Hz), track (highlight
and map pin, no motion), orbit (MAVSDK do_orbit), survey (uploaded mission).
A task stops on: takeover, pilot override, link loss, red-zone lock
(on_telemetry / the event hooks, no HOLD: someone else owns the drone),
Copilot switched off, hold / stop / cancel (HOLD), the analysis mode
changing under a follow or track, and for follow_me a position that stops
arriving for FOLLOW_ME_LOST_S.

Hooks (called from elsewhere, cheap when Copilot is off):
  stream_track    note_frame (latest raw frame), on_result (tracks, the
                  task's box, cv_results.copilot_target, map pins)
  telemetry       on_telemetry, on_pilot_override, link release
  admin_events    takeover
  server.py       socket gone, session teardown (drop)
  telemetry_events.apply_mode_switch  on_mode_changed
"""
from __future__ import annotations

import asyncio
import logging
from functools import partial
import math
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.copilot import planner as _planner
from app.copilot import skills, stt, survey, vision
from app.copilot.models import UNLOAD_AFTER_S

logger = logging.getLogger("verocore.copilot")

CARD_TTL_S = 15.0
FRAME_FRESH_S = 3.0
TRACKS_FRESH_S = 2.0
MODE_WAIT_S = 15.0
MATCH_IOU = 0.3
FOLLOW_ME_STANDOFF_M = 10.0
FOLLOW_ME_LOST_S = 5.0
FOLLOW_ME_FIRST_FIX_S = 20.0
FOLLOW_ME_MIN_INTERVAL_S = 1.0
FOLLOW_ME_MIN_MOVE_M = 2.0
FOLLOW_ME_MAX_ACCURACY_M = 30.0
PIN_EVERY_S = 10.0
MODE_WATCH_GRACE_S = 3.0
TARGET_SEEN_S = 1.0
MAX_TEXT = 500
MAX_AUDIO = stt.MAX_BYTES

PERSON_MODE = "person-tracking"
TRAFFIC_MODE = "traffic-management"
TRACKER_MODES = (PERSON_MODE, TRAFFIC_MODE)

VEHICLE_WORDS = frozenset("car cars truck trucks bus buses van vans vehicle vehicles bike bikes "
                          "motorcycle motorcycles motorbike motorbikes scooter scooters jeep suv "
                          "auto rickshaw taxi lorry tractor bicycle bicycles cycle pickup sedan "
                          "hatchback ambulance".split())
PERSON_WORDS = frozenset("man men woman women person people persons guy guys lady ladies boy boys "
                         "girl girls kid kids child children someone somebody pedestrian "
                         "pedestrians runner runners jogger player players worker workers "
                         "officer soldier human humans he she him her".split())

_sio = None
_sm = None
_pool = None
_planner_client = None          # tests inject a fake Anthropic client here


def configure(sio, session_manager, vision_pool=None) -> None:
    global _sio, _sm, _pool
    _sio, _sm, _pool = sio, session_manager, vision_pool


def set_planner_client(client) -> None:
    """Tests: a stand-in for anthropic.AsyncAnthropic."""
    global _planner_client, _claude
    _planner_client = client
    _claude = None


# ── state ─────────────────────────────────────────────────────────────────

@dataclass
class Task:
    kind: str                         # follow | follow_me | track | orbit | survey
    label: str
    since: float = field(default_factory=time.time)
    started: float = field(default_factory=time.monotonic)
    track_id: Optional[int] = None
    subject: Optional[str] = None     # person | vehicle
    mode: Optional[str] = None        # the analysis mode the track lives in
    box: Optional[list] = None
    frame_w: int = 0
    frame_h: int = 0
    seen: float = 0.0                 # monotonic, last frame with the target
    moves: bool = True
    data: Dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict:
        out = {"kind": self.kind, "label": self.label, "since": self.since}
        if self.box is not None and self.kind in ("follow", "track"):
            out["target_box"] = list(self.box)
            out["frame_w"], out["frame_h"] = self.frame_w, self.frame_h
        return out


@dataclass
class State:
    enabled: bool = False
    history: List[Dict[str, str]] = field(default_factory=list)
    task: Optional[Task] = None
    card: Optional[Dict[str, Any]] = None       # the open card + what accepting it does
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    frame: Any = None                           # latest raw av.VideoFrame (or BGR array)
    frame_t: float = 0.0
    tracks: List[Dict[str, Any]] = field(default_factory=list)
    tracks_mode: Optional[str] = None
    tracks_t: float = 0.0
    counts: Dict[str, Any] = field(default_factory=dict)
    frame_w: int = 0
    frame_h: int = 0
    pilot_pos: Optional[Dict[str, float]] = None
    last_reposition: float = 0.0
    last_pin: float = 0.0
    ticker: Optional[asyncio.Task] = None
    loading: set = field(default_factory=set)


_states: Dict[str, State] = {}
_unload_task: Optional[asyncio.Task] = None
_claude: Optional[_planner.ClaudePlanner] = None


def reset_for_tests() -> None:
    global _unload_task
    tasks = [st.ticker for st in _states.values()] + [_unload_task]
    for t in tasks:
        if t is not None:
            try:
                t.cancel()
            except RuntimeError:        # its loop is already closed
                pass
    _states.clear()
    _unload_task = None


def state(session_id: str) -> Optional[State]:
    return _states.get(session_id)


def enabled(session_id: str) -> bool:
    st = _states.get(session_id)
    return bool(st and st.enabled)


def _session(session_id: str):
    return _sm.get(session_id) if _sm is not None else None


def _tel(session_id: str):
    return _sm.get_telemetry(session_id) if _sm is not None else None


def _analyzer(session_id: str):
    if _pool is None:
        return None
    try:
        return _pool.get_for_session(session_id)
    except Exception:
        return None


def _spawn(coro) -> None:
    try:
        asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        coro.close()


def claude() -> Optional[_planner.ClaudePlanner]:
    """The Claude planner when a key (or a test client) is there."""
    global _claude
    if _planner_client is None and not _planner.ClaudePlanner.available():
        return None
    if _claude is None:
        _claude = _planner.ClaudePlanner(client=_planner_client)
    return _claude


# ── pushes ────────────────────────────────────────────────────────────────

async def _emit(session_id: str, event: str, payload: dict) -> None:
    s = _session(session_id)
    if _sio is None or s is None or not s.socket_id:
        return
    try:
        await _sio.emit(event, payload, to=s.socket_id)
    except Exception as e:
        logger.debug(f"{event} to {session_id[:8]} failed: {e}")


def state_payload(session_id: str) -> dict:
    st = _states.get(session_id) or State()
    loading = sorted(st.loading | {n for n, sl in (("stt", stt.slot), ("vision", vision.slot))
                                   if sl.loading})
    out = {"enabled": st.enabled, "loading": loading,
           "ready": {"stt": stt.slot.loaded, "vision": vision.slot.loaded,
                     "planner": "claude" if claude() is not None else "local"},
           "task": st.task.public() if st.task else None}
    if st.enabled:
        out["listening_hint"] = "Hold the button or V to talk"
    return out


async def push_state(session_id: str) -> None:
    await _emit(session_id, "copilot_state", state_payload(session_id))


def _msg_id() -> str:
    return secrets.token_hex(6)


LOG_TRANSCRIPTS = os.environ.get("COPILOT_LOG_TRANSCRIPTS", "") == "1"


async def say(session_id: str, text: str, *, role: str = "copilot", status: str = "done",
              msg_id: Optional[str] = None, card: Optional[dict] = None,
              speak: Optional[bool] = None) -> str:
    mid = msg_id or _msg_id()
    payload: Dict[str, Any] = {"id": mid, "role": role, "text": text, "ts": time.time(),
                               "status": status}
    if status != "thinking":
        # Metadata always, so "it did nothing" can be traced; what was said
        # only with COPILOT_LOG_TRANSCRIPTS=1 (a debugging opt-in: pilots'
        # and customers' words do not belong in ordinary server logs).
        said = f": {text[:160]}" if LOG_TRANSCRIPTS else f": {len(text)} chars"
        logger.info(f"Copilot {session_id[:8]} {role}/{status}{said}"
                    + (f" [card {card.get('kind')}]" if card else ""))
    if speak is None:
        speak = role == "copilot" and status != "thinking"
    payload["speak"] = bool(speak)
    if card is not None:
        payload["card"] = card
    await _emit(session_id, "copilot_message", payload)
    return mid


async def refuse(session_id: str, text: str, *, status: str = "refused",
                 msg_id: Optional[str] = None) -> None:
    """A refusal or error the pilot sees in the conversation (and hears)."""
    await say(session_id, text, role="copilot" if msg_id else "system", status=status,
              msg_id=msg_id, speak=True)


def _remember(st: State, pilot: str, copilot: str) -> None:
    st.history.append({"pilot": pilot, "copilot": copilot})
    del st.history[:-_planner.HISTORY_EXCHANGES]


# ── on / off and model lifetime ───────────────────────────────────────────

def _any_enabled() -> bool:
    return any(st.enabled for st in _states.values())


async def _unload_later() -> None:
    try:
        await asyncio.sleep(UNLOAD_AFTER_S)
    except asyncio.CancelledError:
        return
    if _any_enabled():
        return
    loop = asyncio.get_running_loop()
    for slot in (stt.slot, vision.slot):
        if slot.loaded:
            await loop.run_in_executor(slot.executor, slot.unload)


def _schedule_unload() -> None:
    global _unload_task
    if _any_enabled():
        return
    if _unload_task is not None and not _unload_task.done():
        return
    try:
        _unload_task = asyncio.get_running_loop().create_task(_unload_later())
    except RuntimeError:
        pass


def _cancel_unload() -> None:
    global _unload_task
    if _unload_task is not None:
        _unload_task.cancel()
        _unload_task = None


async def _warm(session_id: str, slot) -> None:
    """Load a model in the background, with the loading chip on meanwhile."""
    if slot.loaded or slot.loading:
        return
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(slot.executor, slot.get)
    await asyncio.sleep(0)
    await push_state(session_id)
    try:
        await fut
    except Exception:
        await refuse(session_id, f"The {slot.name} model could not load: {slot.error}", status="error")
    await push_state(session_id)


async def set_enabled(session, on: bool) -> dict:
    sid = session.session_id
    if not on:
        await switch_off(sid, "copilot_off")
        return state_payload(sid)
    st = _states.setdefault(sid, State())
    if not st.enabled:
        st.enabled = True
        _cancel_unload()
        st.ticker = asyncio.get_running_loop().create_task(_tick(sid))
        logger.info(f"Session {sid[:8]}: Copilot on")
        # Speech is what the pilot uses first: warm it now. Vision loads
        # on its first question.
        _spawn(_warm(sid, stt.slot))
    await push_state(sid)
    return state_payload(sid)


async def switch_off(session_id: str, code: str = "copilot_off", *, hold: bool = True) -> bool:
    """Copilot off for the session: the open card expires, a task stops
    (HOLD unless `hold` is False), models unload UNLOAD_AFTER_S after the
    last session switches off."""
    st = _states.get(session_id)
    if st is None or (not st.enabled and st.task is None and st.card is None):
        return False
    st.enabled = False
    if st.ticker is not None:
        st.ticker.cancel()
        st.ticker = None
    await _expire_card(session_id, "Copilot was switched off; nothing was done.")
    if st.task is not None:
        await stop_task(session_id, code, hold=hold)
    st.frame = None
    st.pilot_pos = None
    logger.info(f"Session {session_id[:8]}: Copilot off ({code})")
    await push_state(session_id)
    _schedule_unload()
    return True


def drop(session_id: str) -> None:
    """Session torn down."""
    st = _states.pop(session_id, None)
    if st is not None and st.ticker is not None:
        st.ticker.cancel()
    _schedule_unload()


async def _tick(session_id: str) -> None:
    """Once a second while on: cards run out, follow-me loses its pilot."""
    try:
        while True:
            await asyncio.sleep(1.0)
            await tick_once(session_id)
    except asyncio.CancelledError:
        pass


async def tick_once(session_id: str, now: Optional[float] = None) -> None:
    st = _states.get(session_id)
    if st is None:
        return
    now = time.time() if now is None else now
    if st.card is not None and now > st.card["card"]["expires_at"]:
        await _expire_card(session_id, "Nobody answered in time; nothing was done.")
    t = st.task
    if t is not None and t.kind == "follow_me":
        mono = time.monotonic()
        fix_t = (st.pilot_pos or {}).get("mono")
        if fix_t is None and mono - t.started > FOLLOW_ME_FIRST_FIX_S:
            await stop_task(session_id, "position_lost", hold=True)
        elif fix_t is not None and mono - fix_t > FOLLOW_ME_LOST_S:
            await stop_task(session_id, "position_lost", hold=True)
    if t is not None and t.kind in ("orbit", "survey"):
        _watch_mode(session_id)


# ── plan cards ────────────────────────────────────────────────────────────

def _card(kind: str, title: str, lines: List[str], skill: str, args: dict, *, moves: bool,
          candidates: Optional[list] = None, preview: Optional[dict] = None) -> dict:
    c = {"token": secrets.token_urlsafe(12), "kind": kind, "title": title, "lines": lines,
         "moves": moves, "expires_at": time.time() + CARD_TTL_S, "skill": skill,
         "args": _public_args(args)}
    if candidates is not None:
        c["candidates"] = candidates
    if preview is not None:
        c["preview"] = preview
    return c


def _public_args(args: dict) -> dict:
    return {k: v for k, v in (args or {}).items() if not k.startswith("_")}


async def _open_card(session_id: str, card: dict, entry: dict, text: str,
                     msg_id: Optional[str] = None) -> None:
    st = _states.setdefault(session_id, State())
    if st.card is not None:
        await _card_update(session_id, st.card["card"]["token"], "expired",
                           "Replaced by a newer plan.")
    st.card = {"card": card, **entry}
    await say(session_id, text, msg_id=msg_id, card=card)


async def _card_update(session_id: str, token: str, status: str, message: str) -> None:
    await _emit(session_id, "copilot_card_update", {"token": token, "status": status,
                                                    "message": message})


async def _expire_card(session_id: str, message: str) -> None:
    st = _states.get(session_id)
    if st is None or st.card is None:
        return
    token = st.card["card"]["token"]
    st.card = None
    await _card_update(session_id, token, "expired", message)


def _take_card(session_id: str, token) -> Optional[dict]:
    st = _states.get(session_id)
    if st is None or st.card is None or not isinstance(token, str):
        return None
    if st.card["card"]["token"] != token:
        return None
    c, st.card = st.card, None
    if time.time() > c["card"]["expires_at"]:
        return None
    return c


async def confirm(session, token, accept: bool) -> None:
    sid = session.session_id
    c = _take_card(sid, token)
    if c is None:
        await refuse(sid, "That plan has run out. Nothing was done.", status="refused")
        if isinstance(token, str):
            await _card_update(sid, token, "expired", "That plan has run out. Nothing was done.")
        return
    tok = c["card"]["token"]
    if c["card"]["kind"] == "choose":
        if not accept:
            await _card_update(sid, tok, "declined", "Cancelled. Nothing was done.")
            await say(sid, "Okay, left it.")
            return
        # A yes to a choose card is not a choice: the card stays open.
        _states.setdefault(sid, State()).card = c
        await refuse(sid, "Which one? Say a number.", status="refused")
        return
    if not accept:
        await _card_update(sid, tok, "declined", "Cancelled. Nothing was done.")
        await say(sid, "Cancelled.")
        return
    await _card_update(sid, tok, "accepted", "Doing it now.")
    await execute(session, c["card"]["skill"], c["args"], token=tok)


async def choose(session, token, index) -> None:
    sid = session.session_id
    st = _states.get(sid)
    c = st.card if st is not None else None
    if c is None or not isinstance(token, str) or c["card"]["token"] != token or \
            time.time() > c["card"]["expires_at"] or c["card"]["kind"] != "choose":
        await refuse(sid, "That choice has run out. Ask me again.", status="refused")
        return
    try:
        idx = int(index)
    except (TypeError, ValueError):
        idx = -1
    if not any(x["index"] == idx for x in c["card"].get("candidates") or []):
        await refuse(sid, f"There is no number {index}.", status="refused")
        return
    st.card = None
    await _card_update(sid, token, "accepted", f"Number {idx}.")
    await _chosen(session, c, idx)


async def cancel(session) -> None:
    """The panel's cancel: the open card declined, the task stopped with HOLD."""
    sid = session.session_id
    st = _states.get(sid)
    if st is not None and st.card is not None:
        tok = st.card["card"]["token"]
        st.card = None
        await _card_update(sid, tok, "declined", "Cancelled. Nothing was done.")
    if st is not None and st.task is not None:
        await stop_task(sid, "stopped", hold=True)
    else:
        await say(sid, "Cancelled.")


# ── utterances ────────────────────────────────────────────────────────────

IMMEDIATE = frozenset({"hold", "stop_task", "land", "return_home", "status"})
LOCAL_FIRST = frozenset({"describe", "count"})


async def handle_audio(session, audio, mime: str = "") -> None:
    sid = session.session_id
    if not enabled(sid):
        await refuse(sid, "Copilot is off. Switch it on first.")
        return
    if isinstance(audio, str):
        audio = audio.encode("latin-1", errors="ignore")
    if not isinstance(audio, (bytes, bytearray, memoryview)) or not audio:
        await refuse(sid, "No audio arrived. Try again.", status="error")
        return
    audio = bytes(audio)
    if len(audio) > MAX_AUDIO:
        await refuse(sid, "That recording is too long. Keep it under 15 seconds.")
        return
    loop = asyncio.get_running_loop()
    if not stt.slot.loaded:
        st = _states.setdefault(sid, State())
        st.loading.add("stt")
        await push_state(sid)
    try:
        text = await loop.run_in_executor(stt.slot.executor, stt.transcribe_bytes, audio, mime)
    except stt.AudioError as e:
        await refuse(sid, f"I could not read that recording: {e}.", status="error")
        return
    except Exception as e:
        logger.exception(f"Copilot speech failed for {sid[:8]}")
        await refuse(sid, f"Speech recognition failed ({type(e).__name__}).", status="error")
        return
    finally:
        st = _states.get(sid)
        if st is not None and "stt" in st.loading:
            st.loading.discard("stt")
            await push_state(sid)
    if not text.strip():
        await say(sid, "I didn't catch that. Try again.", status="refused")
        return
    await handle_text(session, text)


async def handle_text(session, text) -> None:
    sid = session.session_id
    if not enabled(sid):
        await refuse(sid, "Copilot is off. Switch it on first.")
        return
    text = " ".join(str(text or "").split())[:MAX_TEXT]
    if not text:
        return
    st = _states.setdefault(sid, State())
    await say(sid, text, role="pilot", speak=False)

    reply = _planner.parse_reply(text)
    if reply is not None and st.card is not None:
        kind, val = reply
        tok = st.card["card"]["token"]
        if kind == "confirm":
            await confirm(session, tok, val)
        else:
            await choose(session, tok, val)
        return

    local = _planner.parse_local(text)
    if local is not None and local.skill in IMMEDIATE:
        await run_plan(session, local, text)
        return

    async with st.lock:
        mid = await say(sid, "Thinking...", status="thinking")
        plan = None
        if local is not None and local.skill in LOCAL_FIRST:
            plan = local
        else:
            c = claude()
            if c is not None:
                try:
                    plan = await c.plan(text, context_text(sid), st.history)
                except Exception as e:
                    logger.warning(f"Copilot planner failed for {sid[:8]}: {type(e).__name__}: {e}")
                    plan = None
                if plan is not None and plan.status == "error":
                    plan = None
                if plan is None and local is None:
                    await refuse(sid, "I could not reach the planner just now. Try a simple "
                                 "command like hold, land or take off to 10 metres.",
                                 status="error", msg_id=mid)
                    _remember(st, text, "(planner unavailable)")
                    return
            if plan is None:
                plan = local
        if plan is None:
            msg = ("I did not understand that. I can hold, land, come back, take off, climb, move, "
                   "follow or track something, count, describe what I see, survey, orbit or give "
                   "the status.")
            await say(sid, msg, msg_id=mid, status="refused")
            _remember(st, text, msg)
            return
        if plan.status == "refused":
            await say(sid, plan.reply, msg_id=mid, status="refused")
            _remember(st, text, plan.reply)
            return
        await run_plan(session, plan, text, msg_id=mid)


async def run_plan(session, plan: _planner.Plan, said: str = "",
                   msg_id: Optional[str] = None) -> None:
    sid = session.session_id
    st = _states.setdefault(sid, State())
    if plan.skill is None:
        await say(sid, plan.reply or "Okay.", msg_id=msg_id)
        _remember(st, said, plan.reply)
        return
    try:
        args = skills.validate(plan.skill, plan.args)
    except skills.ArgError as e:
        text = f"I can't do that: {e}."
        await say(sid, text, msg_id=msg_id, status="refused")
        _remember(st, said, text)
        return
    try:
        text = await _dispatch(session, plan.skill, args, msg_id)
    except Exception as e:
        logger.exception(f"Copilot {plan.skill} failed for {sid[:8]}")
        text = f"That failed: {type(e).__name__}."
        await say(sid, text, msg_id=msg_id, status="error")
    _remember(st, said, f"[{plan.skill} {_public_args(args)}] {text or ''}".strip())


async def _dispatch(session, skill: str, args: dict, msg_id: Optional[str]) -> str:
    """Answer, start, or open a card for one validated skill. Returns what
    was said (for the history)."""
    sid = session.session_id
    tel = _tel(sid)
    if skill == "status":
        text = status_text(sid)
        await say(sid, text, msg_id=msg_id)
        return text
    if skill == "hold":
        return await do_hold(session, msg_id=msg_id)
    if skill == "stop_task":
        st = _states.get(sid)
        if st is None or st.task is None:
            text = "There is no task running."
            await say(sid, text, msg_id=msg_id)
            return text
        label, moves = st.task.label, st.task.moves
        await stop_task(sid, "stopped", hold=moves, quiet=True)
        text = f"Stopped: {label}. Holding." if moves else f"Stopped: {label}."
        await say(sid, text, msg_id=msg_id)
        return text
    if skill == "count":
        return await do_count(session, args["what"], msg_id)
    if skill == "describe":
        return await do_describe(session, args.get("question") or "", msg_id)
    if skill in ("follow", "track"):
        if skill == "follow" and args["target"] == "me":
            return await _offer(session, "follow", {"target": "me"}, msg_id)
        return await find_target(session, skill, args["target"], msg_id)
    return await _offer(session, skill, args, msg_id)


# ── the confirm card for a motion skill ───────────────────────────────────

async def _offer(session, skill: str, args: dict, msg_id: Optional[str],
                 candidates: Optional[list] = None) -> str:
    sid = session.session_id
    tel = _tel(sid)
    code = await skills.guard(session, tel, skill)
    if code is None:
        code, plan = await _prepare(session, tel, skill, args)
    else:
        plan = None
    if code:
        text = f"I can't {_verb(skill, args)}: {skills.reason(code, tel)}."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    title, lines, preview = plan["title"], plan["lines"], plan.get("preview")
    card = _card("confirm", title, lines, skill, args, moves=True, candidates=candidates,
                 preview=preview)
    text = f"{title}. Confirm?"
    await _open_card(sid, card, {"args": {**args, **plan.get("hidden", {})}}, text, msg_id)
    return text


def _verb(skill: str, args: dict) -> str:
    return {"land": "land", "return_home": "come back", "takeoff": "take off",
            "change_altitude": "change altitude", "move": "move", "survey": "survey",
            "orbit": "orbit", "follow": "follow " + ("you" if args.get("target") == "me" else "that"),
            "hold": "hold"}.get(skill, skill)


def _heading(tel) -> float:
    try:
        return float(tel.snapshot.heading_deg or 0.0)
    except Exception:
        return 0.0


def _move_target(tel, forward: float, right: float):
    pos = skills.position(tel)
    if pos is None:
        return None
    h = math.radians(_heading(tel))
    north = forward * math.cos(h) - right * math.sin(h)
    east = forward * math.sin(h) + right * math.cos(h)
    lat, lng = survey.offset(pos[0], pos[1], east, north)
    return lat, lng, pos[2], (pos[0], pos[1])


def _fmt(v: float) -> str:
    return f"{v:g}"


async def _prepare(session, tel, skill: str, args: dict):
    """(refusal code, None) or (None, {title, lines, preview?, hidden?}):
    the plan card's contents, with the skill's own destination checks."""
    pos = skills.position(tel)
    if skill == "land":
        return None, {"title": "Land here", "lines": ["Lands where the drone is now."]}
    if skill == "return_home":
        return None, {"title": "Return home", "lines": ["Flies back to the home point and lands."]}
    if skill == "takeoff":
        alt = args["altitude_m"]
        armed = bool(getattr(getattr(tel.snapshot, "flight_mode", None), "is_armed", False))
        lines = [f"Climbs to {_fmt(alt)} m above home."]
        if not armed:
            lines.insert(0, "Arms the motors first.")
        if pos is not None:
            code = await skills.dest_reason(session, pos[0], pos[1], alt)
            if code:
                return code, None
        return None, {"title": f"{'Arm and take' if not armed else 'Take'} off to {_fmt(alt)} m",
                      "lines": lines}
    if skill == "change_altitude":
        if pos is None:
            return "no_position", None
        target = args.get("altitude_m")
        if target is None:
            target = pos[2] + args["delta_m"]
        if not (skills.TAKEOFF_MIN <= target <= skills.TAKEOFF_MAX):
            return f"the result, {target:.0f} m, is outside {skills.TAKEOFF_MIN:g} to " \
                   f"{skills.TAKEOFF_MAX:g} m", None
        code = await skills.dest_reason(session, pos[0], pos[1], target)
        if code:
            return code, None
        verb = "Climb" if target > pos[2] else "Descend"
        return None, {"title": f"{verb} to {target:.0f} m",
                      "lines": [f"From {pos[2]:.0f} m to {target:.0f} m, holding position."],
                      "hidden": {"_target_alt": target}}
    if skill == "move":
        mt = _move_target(tel, args["forward_m"], args["right_m"])
        if mt is None:
            return "no_position", None
        lat, lng, alt, here = mt
        code = await skills.dest_reason(session, lat, lng, alt, from_point=here)
        if code:
            return code, None
        parts = []
        if args["forward_m"]:
            parts.append(f"{abs(args['forward_m']):g} m {'forward' if args['forward_m'] > 0 else 'back'}")
        if args["right_m"]:
            parts.append(f"{abs(args['right_m']):g} m {'right' if args['right_m'] > 0 else 'left'}")
        return None, {"title": "Move " + " and ".join(parts),
                      "lines": [f"Keeps {alt:.0f} m altitude.", "Relative to where the drone faces."],
                      "preview": {"waypoints": [{"lat": round(lat, 7), "lng": round(lng, 7),
                                                 "alt": alt}]},
                      "hidden": {"_lat": lat, "_lng": lng, "_alt": alt}}
    if skill == "survey":
        if args.get("center") == "point":
            clat, clng = args["center_lat"], args["center_lon"]
        elif pos is not None:
            clat, clng = pos[0], pos[1]
        else:
            return "no_position", None
        try:
            p = survey.plan(clat, clng, args["radius_m"], args["altitude_m"])
        except ValueError as e:
            return str(e), None
        code = await _gate_survey(session, p["waypoints"])
        if code:
            return code, None
        mins = p["length_m"] / survey.SPEED_M_S / 60.0
        return None, {"title": f"Survey {_fmt(args['radius_m'])} m radius at {_fmt(args['altitude_m'])} m",
                      "lines": [f"{len(p['waypoints'])} waypoints, lines {p['spacing_m']:g} m apart.",
                                f"About {p['length_m'] / 1000:.1f} km, {max(1, round(mins))} min, "
                                "then returns home."],
                      "preview": p["preview"], "hidden": {"_waypoints": p["waypoints"]}}
    if skill == "orbit":
        center = await _orbit_center(session, tel, args["center"])
        if isinstance(center, str):
            return center, None
        clat, clng, alt = center
        pos = skills.position(tel)
        code = await _ring_reason(session, clat, clng, args["radius_m"], alt,
                                  from_point=(pos[0], pos[1]) if pos else None)
        if code:
            return code, None
        ring = [survey.offset(clat, clng, args["radius_m"] * math.sin(a), args["radius_m"] * math.cos(a))
                for a in (i * math.pi / 8 for i in range(16))]
        return None, {"title": f"Orbit {'the target' if args['center'] == 'target' else 'here'} at "
                               f"{_fmt(args['radius_m'])} m radius",
                      "lines": [f"{_fmt(args['speed_m_s'])} m/s at {alt:.0f} m.",
                                "Say hold or stop to end it."],
                      "preview": {"waypoints": [{"lat": round(a, 7), "lng": round(b, 7), "alt": alt}
                                                for a, b in ring],
                                  "area": {"center": {"lat": clat, "lng": clng},
                                           "radius_m": args["radius_m"]}},
                      "hidden": {"_lat": clat, "_lng": clng, "_alt": alt}}
    if skill == "follow":
        if args.get("target") == "me":
            return None, {"title": "Follow you",
                          "lines": [f"Stays {FOLLOW_ME_STANDOFF_M:g} m from you at this altitude, "
                                    "using your device's position.",
                                    "Stops if your position stops arriving."]}
        return None, {"title": f"Follow {args['target']}",
                      "lines": ["The tracker flies the follow, with avoidance and the stall brake.",
                                "Say hold or stop to end it."]}
    return "not_supported", None


async def _gate_survey(session, waypoints) -> Optional[str]:
    """The mission upload's own zone gate, asked early (it only reads):
    orange is never acknowledged by voice."""
    from app.permits import service as permit_service
    try:
        gate = await permit_service.gate_upload(getattr(session, "drone", None), waypoints,
                                                ack_orange=False)
    except Exception as e:
        logger.warning(f"Copilot survey gate failed: {e}")
        return "dest_red"
    if gate.get("ok"):
        return None
    return "dest_red" if gate.get("blocked") else "dest_orange"


async def _orbit_center(session, tel, center: str):
    pos = skills.position(tel)
    if pos is None:
        return "no_position"
    if center == "drone":
        return pos
    st = _states.get(session.session_id)
    t = st.task if st else None
    tp = (t.data.get("target_pos") if t is not None else None)
    if not tp:
        return "I don't know where the target is on the map yet"
    return tp[0], tp[1], pos[2]


async def _ring_reason(session, lat, lng, radius, alt, *,
                       from_point: Optional[Tuple[float, float]] = None) -> Optional[str]:
    """Zones anywhere the orbit can take the drone: the circle itself, the
    disc inside it (radial segments, so a zone wholly inside the circle is
    caught too), and the transit from the drone to the nearest point of the
    circle."""
    from app.zones import engine
    ring = [survey.offset(lat, lng, radius * math.sin(a), radius * math.cos(a))
            for a in (i * math.pi / 8 for i in range(17))]
    zones = list(engine.check_path(ring, corridor_m=5.0)["zones"])
    zones += engine.check_point(lat, lng, alt)["zones"]
    for p in ring[:16]:
        zones += engine.check_path([(lat, lng), p], corridor_m=5.0)["zones"]
    if from_point is not None:
        nearest = min(ring, key=lambda p: (p[0] - from_point[0]) ** 2 + (p[1] - from_point[1]) ** 2)
        zones += engine.check_path([from_point, nearest], corridor_m=5.0)["zones"]
    seen, unique = set(), []
    for z in zones:
        if z["id"] not in seen:
            seen.add(z["id"]); unique.append(z)
    return await skills._zones_reason(session, unique, lat, lng)


# ── running a confirmed plan ──────────────────────────────────────────────

async def execute(session, skill: str, args: dict, *, token: Optional[str] = None) -> bool:
    """A plan the pilot accepted: every guard again, now, then the command."""
    sid = session.session_id
    tel = _tel(sid)
    code = await skills.guard(session, tel, skill)
    if code is None:
        code, plan = await _prepare(session, tel, skill, args)
        if plan is not None:
            args = {**args, **plan.get("hidden", {})}
    if code:
        text = f"Not done: {skills.reason(code, tel)}."
        if token:
            await _card_update(sid, token, "refused", text)
        await refuse(sid, text)
        return False
    ok, text = await _run(session, tel, skill, args)
    if token:
        await _card_update(sid, token, "done" if ok else "refused", text)
    await say(sid, text, status="done" if ok else "refused")
    await push_state(sid)
    return ok


async def _guarded_action(session, tel, action: str, data: Optional[dict] = None) -> dict:
    """telemetry_events.run_guarded_action: the drone_action checks."""
    from app.events.telemetry_events import run_guarded_action
    return await run_guarded_action(_sio, session, tel, action, dict(data or {}, action=action),
                                    session.socket_id)


def _fail(res: dict, tel) -> str:
    return res.get("error") or res.get("msg") or skills.reason("failed", tel)


async def _run(session, tel, skill: str, args: dict):
    sid = session.session_id
    if skill in ("land", "return_home"):
        await _end_task_for_new_command(sid)
        res = await _guarded_action(session, tel, "land" if skill == "land" else "return")
        if not res.get("ok"):
            return False, f"Not done: {_fail(res, tel)}."
        return True, "Landing." if skill == "land" else "Returning home."
    if skill == "takeoff":
        armed = bool(tel.snapshot.flight_mode.is_armed)
        if not armed:
            res = await _guarded_action(session, tel, "arm")
            if not res.get("ok"):
                return False, f"Not armed: {_fail(res, tel)}."
        res = await _guarded_action(session, tel, "takeoff", {"altitude": args["altitude_m"]})
        if not res.get("ok"):
            return False, f"Takeoff refused: {_fail(res, tel)}."
        return True, f"Taking off to {_fmt(args['altitude_m'])} metres."
    if skill == "change_altitude":
        target = float(args["_target_alt"])
        if not await tel.goto_altitude(target):
            return False, f"Not done: {skills.reason('failed', tel)}."
        return True, f"Going to {target:.0f} metres."
    if skill == "move":
        await _end_task_for_new_command(sid)
        if not await tel.goto_custom_rtl(args["_lat"], args["_lng"], args["_alt"]):
            return False, f"Not done: {skills.reason('failed', tel)}."
        return True, "Moving."
    if skill == "survey":
        await _end_task_for_new_command(sid)
        from app.events.telemetry_events import upload_mission_for
        up = await upload_mission_for(session, tel, {"waypoints": args["_waypoints"],
                                                     "terrain_follow": False, "ack_orange": False})
        if not up.get("ok"):
            return False, f"Survey not uploaded: {up.get('msg') or 'refused'}."
        res = await _guarded_action(session, tel, "start_mission")
        if not res.get("ok"):
            return False, f"Survey uploaded but not started: {_fail(res, tel)}."
        _set_task(sid, Task(kind="survey", label=f"Survey {_fmt(args['radius_m'])} m",
                            data={"watch_mode": None}))
        return True, f"Surveying: {len(args['_waypoints'])} waypoints."
    if skill == "orbit":
        await _end_task_for_new_command(sid, keep_track=args.get("center") == "target")
        if not hasattr(tel, "do_orbit"):
            return False, f"Not done: {skills.reason('not_supported')}."
        try:
            ok = await tel.do_orbit(args["radius_m"], args["speed_m_s"], args["_lat"], args["_lng"],
                                    args["_alt"])
        except NotImplementedError:
            return False, f"Not done: {skills.reason('not_supported')}."
        if not ok:
            return False, f"Not done: {skills.reason('failed', tel)}."
        _set_task(sid, Task(kind="orbit", label=f"Orbit {_fmt(args['radius_m'])} m",
                            data={"watch_mode": None}))
        return True, f"Orbiting at {_fmt(args['radius_m'])} metres."
    if skill == "follow":
        if args.get("target") == "me":
            await _end_task_for_new_command(sid)
            st = _states.setdefault(sid, State())
            st.pilot_pos = None
            _set_task(sid, Task(kind="follow_me", label="Following you"))
            return True, "Following you. Keep this page open so your position reaches me."
        return await _start_follow(session, tel, args)
    return False, skills.reason("not_supported")


def _set_task(session_id: str, task: Task) -> None:
    st = _states.setdefault(session_id, State())
    st.task = task
    logger.info(f"Session {session_id[:8]}: Copilot task {task.kind} ({task.label})")


async def _end_task_for_new_command(session_id: str, keep_track: bool = False) -> None:
    """A new motion command replaces the running task, without a HOLD of
    its own (the new command is what the drone does next)."""
    st = _states.get(session_id)
    if st is None or st.task is None:
        return
    if keep_track and st.task.kind == "track":
        return
    await stop_task(session_id, "replaced", hold=False, quiet=True)


async def do_hold(session, msg_id: Optional[str] = None) -> str:
    sid = session.session_id
    tel = _tel(sid)
    st = _states.setdefault(sid, State())
    if st.card is not None:
        await _expire_card(sid, "Held instead; nothing else was done.")
    if st.task is not None:
        await stop_task(sid, "stopped", hold=False, quiet=True)
    code = await skills.guard(session, tel, "hold")
    if code:
        text = f"I can't hold: {skills.reason(code, tel)}."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    _release_tracker(sid)
    try:
        if getattr(tel, "_offboard_active", False):
            await tel.stop_offboard()
    except Exception:
        pass
    res = await _guarded_action(session, tel, "hold")
    text = "Holding." if res.get("ok") else f"Hold failed: {_fail(res, tel)}."
    await say(sid, text, msg_id=msg_id, status="done" if res.get("ok") else "error")
    await push_state(sid)
    return text


# ── stopping a task ───────────────────────────────────────────────────────

_NO_HOLD = frozenset({"taken_over", "pilot_control", "link_lost", "red_zone", "no_link"})


def _release_tracker(session_id: str) -> None:
    """The built-in follow stops computing: tracking off. Every pursuit
    analyzer (telemetry_events._pursuit_analyzers) has set_tracking."""
    a = _analyzer(session_id)
    if a is None or not hasattr(a, "set_tracking"):
        return
    try:
        a.set_tracking(session_id, False)
    except Exception as e:
        logger.warning(f"Copilot: stopping the tracker failed: {e}")


async def _hold_now(tel) -> bool:
    """Leave Offboard and HOLD, unless someone else owns the drone."""
    if not skills.linked(tel) or getattr(tel, "pilot_has_control", False) \
            or getattr(tel, "automation_locked", False):
        return False
    try:
        if getattr(tel, "_offboard_active", False):
            await tel.stop_offboard()
        return bool(await tel.set_flight_mode("HOLD"))
    except Exception as e:
        logger.warning(f"Copilot stop: HOLD failed: {e}")
        return False


async def stop_task(session_id: str, code: str, *, hold: Optional[bool] = None,
                    quiet: bool = False) -> bool:
    """End the session's task. hold: HOLD after (default: unless `code`
    leaves the drone to someone else). quiet: no message (the caller says
    what happened)."""
    st = _states.get(session_id)
    if st is None or st.task is None:
        return False
    t, st.task = st.task, None
    if hold is None:
        hold = code not in _NO_HOLD
    if t.kind == "follow":
        _release_tracker(session_id)
        a = _analyzer(session_id)
        try:
            if hasattr(a, "follow_track") and t.mode == PERSON_MODE:
                a.follow_track(session_id, None)
            elif hasattr(a, "request_follow") and t.mode == TRAFFIC_MODE:
                a.request_follow(session_id, None)
        except Exception:
            pass
        status_ev = "tracking_status" if t.subject != "vehicle" else "vehicle_tracking_status"
        await _emit(session_id, status_ev, {"active": False})
    tel = _tel(session_id)
    held = False
    if hold and t.moves:
        held = await _hold_now(tel)
    elif t.kind == "follow" and code not in _NO_HOLD:
        # Replaced by a new command: Offboard ends, the new command flies.
        try:
            if getattr(tel, "_offboard_active", False):
                await tel.stop_offboard()
        except Exception:
            pass
    logger.info(f"Session {session_id[:8]}: Copilot task {t.kind} stopped ({code})")
    if not quiet:
        text = f"Stopped {t.label.lower()}: {skills.reason(code)}." + (" Holding." if held else "")
        await say(session_id, text, role="copilot", status="done")
    await push_state(session_id)
    return True


def on_telemetry(session_id: str) -> None:
    """Every telemetry update: a running task stops on takeover, pilot,
    link loss or a red-zone lock (no HOLD), orbit / survey end when the
    flight mode moves on. A dict lookup when no task runs."""
    st = _states.get(session_id)
    if st is None or st.task is None or not st.task.moves:
        return
    s = _session(session_id)
    tel = _tel(session_id)
    if s is None:
        return
    code = skills.control_reason(s, tel)
    if code == "no_fly_permission":
        code = None if st.task.kind == "track" else code
    if code:
        _spawn(stop_task(session_id, "link_lost" if code == "no_link" else code))
        return
    if st.task.kind in ("orbit", "survey"):
        _watch_mode(session_id)


def _watch_mode(session_id: str) -> None:
    st = _states.get(session_id)
    t = st.task if st else None
    tel = _tel(session_id)
    if t is None or tel is None:
        return
    try:
        mode = tel.snapshot.flight_mode.mode
    except Exception:
        return
    if time.monotonic() - t.started < MODE_WATCH_GRACE_S:
        return
    if t.data.get("watch_mode") is None:
        t.data["watch_mode"] = mode
        return
    finished = t.kind == "survey" and bool(getattr(tel.snapshot, "mission_finished", False))
    if mode != t.data["watch_mode"] or finished:
        _spawn(stop_task(session_id, "task_ended", hold=False))


async def on_mode_changed(session_id: str, mode_value: str) -> None:
    """The analysis mode is changing: a follow or track on the old tracker ends."""
    st = _states.get(session_id)
    t = st.task if st else None
    if t is None or t.kind not in ("follow", "track") or t.mode == mode_value:
        return
    await stop_task(session_id, "mode_changed", hold=t.kind == "follow")


async def on_pilot_override(session_id: str) -> None:
    await stop_task(session_id, "pilot_control", hold=False)


async def on_takeover(session_id: str) -> None:
    await stop_task(session_id, "taken_over", hold=False)
    await _expire_card(session_id, "HYRAK staff took control; nothing was done.")


async def on_link_released(session_id: str) -> None:
    await stop_task(session_id, "link_lost", hold=False)
    await _expire_card(session_id, "The drone link was released; nothing was done.")


# ── frames and tracker results (stream_track) ─────────────────────────────

def wants_frames(session_id: str) -> bool:
    st = _states.get(session_id)
    return bool(st and st.enabled)


def note_frame(session_id: str, frame) -> None:
    """The latest raw frame, kept by reference (converted only when a
    question needs it)."""
    st = _states.get(session_id)
    if st is None or not st.enabled:
        return
    st.frame, st.frame_t = frame, time.monotonic()


def tracks_from_meta(mode: str, meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    """[{id, box, kind, label}] from a built-in tracker's cv_results."""
    out: List[Dict[str, Any]] = []
    for p in meta.get("persons") or []:
        if p.get("id") is not None and p.get("box"):
            out.append({"id": int(p["id"]), "box": list(p["box"])[:4], "kind": "person",
                        "label": "person"})
    for p in meta.get("people") or []:
        if p.get("id") is not None and p.get("box"):
            out.append({"id": int(p["id"]), "box": list(p["box"])[:4], "kind": "person",
                        "label": "person"})
    for v in meta.get("vehicles") or []:
        if v.get("track_id") is not None and v.get("box"):
            color = v.get("color") if v.get("color") not in (None, "unknown") else ""
            out.append({"id": int(v["track_id"]), "box": list(v["box"])[:4], "kind": "vehicle",
                        "label": " ".join(x for x in (color, v.get("type") or "vehicle") if x)})
    return out


def on_result(session_id: str, mode: str, meta: Dict[str, Any], capture=None, frame=None) -> None:
    """One analysed frame, on the event loop, before cv_results goes out."""
    st = _states.get(session_id)
    if st is None or (not st.enabled and st.task is None):
        return
    if mode in TRACKER_MODES:
        st.tracks = tracks_from_meta(mode, meta)
        st.tracks_mode, st.tracks_t = mode, time.monotonic()
    st.counts = {k: meta.get(k) for k in ("person_count", "vehicles_in_frame", "vehicle_types",
                                          "count", "counts") if meta.get(k) is not None}
    st.counts["_mode"], st.counts["_t"] = mode, time.monotonic()
    if capture:
        st.frame_w = int(capture.get("width") or st.frame_w or 0)
        st.frame_h = int(capture.get("height") or st.frame_h or 0)
    t = st.task
    if t is None or t.kind not in ("follow", "track") or t.mode != mode:
        return
    if t.kind == "follow":
        locked = meta.get("target_id") if mode == PERSON_MODE else meta.get("locked_track_id")
        if locked is not None and int(locked) != t.track_id and \
                time.monotonic() - t.started > 1.0:
            t.track_id = int(locked)          # the tracker re-acquired under a new id
        if meta.get("tracking") is False and time.monotonic() - t.started > 3.0:
            # Follow switched off elsewhere (the panel's own controls).
            _spawn(stop_task(session_id, "task_ended", hold=False))
            return
    now = time.monotonic()
    for tr in st.tracks:
        if tr["id"] == t.track_id:
            t.box, t.seen = tr["box"], now
            break
    if t.box is not None:
        meta["copilot_target"] = {"box": list(t.box), "label": t.label, "track_id": t.track_id,
                                  "kind": t.kind, "lost": now - t.seen > TARGET_SEEN_S}
        if capture:
            t.frame_w = int(capture.get("width") or t.frame_w)
            t.frame_h = int(capture.get("height") or t.frame_h)
    if t.seen == now and capture and now - st.last_pin > PIN_EVERY_S:
        st.last_pin = now
        try:
            from app.mapdetect import live as map_live
            sighting, _why = map_live.pin(session_id, mode, meta, capture, frame, label=t.label,
                                          score=None, box=t.box, rule="copilot")
            if sighting:
                t.data["target_pos"] = (sighting.get("lat"), sighting.get("lon"))
        except Exception as e:
            logger.debug(f"Copilot map pin failed: {e}")


# ── follow / track: finding the target ────────────────────────────────────

def subject_of(target: str) -> Optional[str]:
    words = set(re.findall(r"[a-z]+", target.lower()))
    if words & VEHICLE_WORDS:
        return "vehicle"
    if words & PERSON_WORDS:
        return "person"
    return None


def mode_for(subject: Optional[str], current: Optional[str]) -> str:
    """The built-in tracker a follow / track runs on: keep the current one
    when it sees this kind of subject."""
    if subject == "person" and current in TRACKER_MODES:
        return current
    if subject == "person":
        return PERSON_MODE
    return TRAFFIC_MODE


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = (float(v) for v in a[:4])
    bx1, by1, bx2, by2 = (float(v) for v in b[:4])
    iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union > 0 else 0.0


def _inside(pt, box) -> bool:
    return box[0] <= pt[0] <= box[2] and box[1] <= pt[1] <= box[3]


def _centre(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def _contained(inner, outer) -> float:
    """How much of `inner` lies inside `outer` (0..1)."""
    iw = max(0.0, min(inner[2], outer[2]) - max(inner[0], outer[0]))
    ih = max(0.0, min(inner[3], outer[3]) - max(inner[1], outer[1]))
    area = max(1e-6, (inner[2] - inner[0]) * (inner[3] - inner[1]))
    return iw * ih / area


def match_candidates(grounded: List[Dict], tracks: List[Dict], subject: Optional[str] = None,
                     frame_w: int = 0, frame_h: int = 0) -> List[Dict]:
    """Grounded boxes matched to tracker tracks: IoU >= MATCH_IOU, each
    box's centre inside the other, or the grounded box lying within the
    track (Florence often boxes the described part, "the red shirt", not
    the whole person). The best-overlapping track wins, so a part box goes
    to the smallest track around it. One candidate per track, numbered 1..
    left to right."""
    best: Dict[int, Dict] = {}
    for g in grounded:
        gb = g["box"]
        top = None
        for tr in tracks:
            if subject and tr["kind"] != subject:
                continue
            tb = tr["box"]
            score = iou(gb, tb)
            mutual = _inside(_centre(gb), tb) and _inside(_centre(tb), gb)
            part = _contained(gb, tb) >= 0.8
            if score < MATCH_IOU and not mutual and not part:
                continue
            if score < MATCH_IOU:
                score = MATCH_IOU * (1.0 if mutual else _contained(tb, gb) + 0.5)
            if top is None or score > top[0]:
                top = (score, tr)
        if top is None:
            continue
        score, tr = top
        if tr["id"] not in best or score > best[tr["id"]]["score"]:
            best[tr["id"]] = {"track_id": tr["id"], "box": [round(float(v), 1) for v in tr["box"]],
                              "label": tr["label"], "kind": tr["kind"], "score": round(score, 2)}
    out = sorted(best.values(), key=lambda c: c["box"][0])
    for i, c in enumerate(out, start=1):
        c["index"] = i
        c["frame_w"], c["frame_h"] = frame_w, frame_h
    return out


def _frame_bgr(st: State):
    f = st.frame
    if f is None or time.monotonic() - st.frame_t > FRAME_FRESH_S:
        return None
    if hasattr(f, "to_ndarray"):
        return f.to_ndarray(format="bgr24")
    return f


async def _current_frame(session_id: str):
    st = _states.get(session_id)
    if st is None:
        return None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(vision.slot.executor, _frame_bgr, st)


async def _vision(session_id: str, fn, *args):
    """A Florence call on the vision worker, with the loading chip while
    the model loads."""
    st = _states.setdefault(session_id, State())
    loop = asyncio.get_running_loop()
    if not vision.slot.loaded:
        st.loading.add("vision")
        await push_state(session_id)
    try:
        return await loop.run_in_executor(vision.slot.executor, fn, *args)
    finally:
        if "vision" in st.loading:
            st.loading.discard("vision")
            await push_state(session_id)


async def _ensure_tracker(session, mode_value: str) -> bool:
    """Put the session on `mode_value` (the set_analysis_mode path) and
    wait for its first tracks."""
    sid = session.session_id
    st = _states.setdefault(sid, State())
    current = getattr(getattr(session, "mode", None), "value", None)
    if current != mode_value:
        from app.events.telemetry_events import apply_mode_switch
        from app.sessions.models import AnalysisMode
        old = session.mode
        new = AnalysisMode(mode_value)
        st.tracks_t = 0.0                    # only tracks from the new tracker count
        _sm.set_mode(sid, new)
        await _emit(sid, "mode_changed", {"mode": new.value})
        await _emit(sid, "model_status", {"status": "loading", "mode": new.value})
        if _pool is not None and not await apply_mode_switch(_sio, _sm, _pool, session, old, new,
                                                             session.socket_id):
            return False
    deadline = time.monotonic() + MODE_WAIT_S
    while time.monotonic() < deadline:
        if st.tracks_mode == mode_value and time.monotonic() - st.tracks_t < TRACKS_FRESH_S:
            return True
        await asyncio.sleep(0.25)
    return False


async def find_target(session, skill: str, target: str, msg_id: Optional[str]) -> str:
    sid = session.session_id
    tel = _tel(sid)
    st = _states.setdefault(sid, State())
    if skill == "follow":
        code = await skills.guard(session, tel, "follow")
        if code:
            text = f"I can't follow: {skills.reason(code, tel)}."
            await say(sid, text, msg_id=msg_id, status="refused")
            return text
    if st.frame is None or time.monotonic() - st.frame_t > FRAME_FRESH_S:
        text = "I can't see anything: start the video first."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    subject = subject_of(target)
    mode_value = mode_for(subject, getattr(getattr(session, "mode", None), "value", None))
    await say(sid, f"Looking for {target}...", msg_id=msg_id, status="thinking")
    if not await _ensure_tracker(session, mode_value):
        text = "The tracker did not start, so I can't lock on to anything. Try again."
        await say(sid, text, msg_id=msg_id, status="error")
        return text
    frame = await _current_frame(sid)
    if frame is None:
        text = "The video stopped, so I can't look."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    h, w = frame.shape[:2]
    try:
        boxes = await _vision(sid, vision.ground, frame, target)
    except Exception as e:
        logger.exception("Copilot grounding failed")
        text = f"Vision failed ({type(e).__name__})."
        await say(sid, text, msg_id=msg_id, status="error")
        return text
    cands = match_candidates(boxes, st.tracks, subject, w, h)
    if not cands:
        text = (f"I see {target}, but the tracker has not picked it up yet. Try again in a moment."
                if boxes else f"I can't see {target} right now.")
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    for c in cands:
        c["label"] = target if len(cands) == 1 else f"{target} {c['index']}"
    entry = {"args": {"target": target, "_subject": subject, "_mode": mode_value},
             "candidates": cands, "skill": skill}
    if len(cands) == 1:
        return await _with_candidate(session, skill, entry, cands[0], msg_id)
    card = _card("choose", f"Which {target}?",
                 [f"{len(cands)} match. Say or tap a number."], skill,
                 {"target": target}, moves=skill == "follow",
                 candidates=[_pub_cand(c) for c in cands])
    text = f"I see {len(cands)}. Which one? Say a number."
    await _open_card(sid, card, entry, text, msg_id)
    return text


def _pub_cand(c: Dict) -> Dict:
    return {k: c[k] for k in ("index", "label", "score", "box", "frame_w", "frame_h")}


async def _chosen(session, c: dict, index: int) -> None:
    cand = next(x for x in c["candidates"] if x["index"] == index)
    await _with_candidate(session, c["skill"], c, cand, None)


async def _with_candidate(session, skill: str, entry: dict, cand: dict,
                          msg_id: Optional[str]) -> str:
    sid = session.session_id
    args = {**entry["args"], "_track_id": cand["track_id"], "_box": cand["box"],
            "_frame_w": cand["frame_w"], "_frame_h": cand["frame_h"]}
    if skill == "track":
        await _end_task_for_new_command(sid)
        t = Task(kind="track", label=entry["args"]["target"], track_id=cand["track_id"],
                 subject=entry["args"].get("_subject"), mode=entry["args"]["_mode"],
                 box=cand["box"], frame_w=cand["frame_w"], frame_h=cand["frame_h"],
                 seen=time.monotonic(), moves=False)
        _set_task(sid, t)
        text = f"Tracking {t.label}. It's highlighted on the video."
        await say(sid, text, msg_id=msg_id)
        await push_state(sid)
        return text
    return await _offer(session, "follow", args, msg_id, candidates=[_pub_cand(cand)])


async def _start_follow(session, tel, args: dict):
    """Lock the built-in tracker on the chosen track, Offboard, guards
    again, then the tracker flies it (the same two halves set_tracking
    does: Offboard first, tracker second)."""
    sid = session.session_id
    mode = args.get("_mode")
    a = _analyzer(sid)
    current = getattr(getattr(session, "mode", None), "value", None)
    if a is None or current != mode:
        return False, "Not done: the tracker is no longer running."
    st = _states.setdefault(sid, State())
    tid = args.get("_track_id")
    if not any(tr["id"] == tid for tr in st.tracks):
        return False, "Not done: the target is out of sight now."
    await _end_task_for_new_command(sid)
    if mode == PERSON_MODE and hasattr(a, "follow_track"):
        a.follow_track(sid, tid)
    elif hasattr(a, "request_follow"):
        a.request_follow(sid, tid)
    else:
        return False, "Not done: this tracker can't follow."
    if not await tel.start_offboard():
        _release_lock(sid, a, mode)
        return False, f"Not done: {skills.reason('failed', tel)}."
    code = await skills.guard(session, tel, "follow")
    if code:
        _release_lock(sid, a, mode)
        if code not in _NO_HOLD:
            await _hold_now(tel)
        return False, f"Not done: {skills.reason(code, tel)}."
    a.set_tracking(sid, True)
    subject = args.get("_subject") or next(
        (tr["kind"] for tr in st.tracks if tr["id"] == tid), "person")
    _set_task(sid, Task(kind="follow", label=args["target"], track_id=tid, subject=subject,
                        mode=mode, box=args.get("_box"), frame_w=args.get("_frame_w") or 0,
                        frame_h=args.get("_frame_h") or 0, seen=time.monotonic()))
    await _emit(sid, "tracking_status" if subject != "vehicle" else "vehicle_tracking_status",
                {"active": True})
    return True, f"Following {args['target']}."


def _release_lock(sid: str, a, mode: Optional[str]) -> None:
    try:
        if mode == PERSON_MODE and hasattr(a, "follow_track"):
            a.follow_track(sid, None)
        elif hasattr(a, "request_follow"):
            a.request_follow(sid, None)
    except Exception:
        pass


# ── follow me ─────────────────────────────────────────────────────────────

def standoff_point(pilot_lat: float, pilot_lng: float, drone_lat: float, drone_lng: float,
                   standoff_m: float = FOLLOW_ME_STANDOFF_M):
    """Where the drone should be: standoff_m from the pilot, on the side it
    is now (behind the pilot as seen from the drone)."""
    d = survey.distance_m(pilot_lat, pilot_lng, drone_lat, drone_lng)
    if d < 0.5:
        return drone_lat, drone_lng
    north = (drone_lat - pilot_lat) * survey.M_PER_DEG_LAT
    east = (drone_lng - pilot_lng) * survey.M_PER_DEG_LAT * math.cos(math.radians(pilot_lat))
    k = standoff_m / d
    return survey.offset(pilot_lat, pilot_lng, east * k, north * k)


async def pilot_position(session, data: dict) -> None:
    """The pilot's browser position while follow-me runs: a guarded
    reposition at most once a second, toward the standoff point."""
    sid = session.session_id
    st = _states.get(sid)
    if st is None or st.task is None or st.task.kind != "follow_me":
        return
    try:
        lat, lng = float(data.get("lat")), float(data.get("lon", data.get("lng")))
        acc = float(data.get("accuracy_m") or 0.0)
    except (TypeError, ValueError):
        return
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (not lat and not lng):
        return
    if acc > FOLLOW_ME_MAX_ACCURACY_M:
        return                      # too coarse to steer by; the lost timer still runs
    now = time.monotonic()
    st.pilot_pos = {"lat": lat, "lon": lng, "accuracy_m": acc, "mono": now}
    if now - st.last_reposition < FOLLOW_ME_MIN_INTERVAL_S:
        return
    tel = _tel(sid)
    code = await skills.guard(session, tel, "follow")
    if code:
        await stop_task(sid, "link_lost" if code == "no_link" else code)
        return
    pos = skills.position(tel)
    if pos is None:
        return
    tlat, tlng = standoff_point(lat, lng, pos[0], pos[1])
    if survey.distance_m(pos[0], pos[1], tlat, tlng) < FOLLOW_ME_MIN_MOVE_M:
        return
    code = await skills.dest_reason(session, tlat, tlng, pos[2], from_point=(pos[0], pos[1]))
    if code:
        await stop_task(sid, code, hold=True)
        return
    st.last_reposition = now
    if not await tel.goto_custom_rtl(tlat, tlng, pos[2]):
        await stop_task(sid, "failed", hold=True)


# ── answers: status, count, describe ──────────────────────────────────────

def context_text(session_id: str) -> str:
    """The drone and camera state Claude sees with each request."""
    s = _session(session_id)
    tel = _tel(session_id)
    st = _states.get(session_id)
    lines = []
    if tel is None or not skills.linked(tel):
        lines.append("Drone link: none.")
    else:
        snap = tel.snapshot
        fm = snap.flight_mode
        lines.append(f"Flight mode {fm.mode}, armed {fm.is_armed}, in air {fm.is_in_air}.")
        pos = skills.position(tel)
        if pos:
            lines.append(f"Altitude {pos[2]:.1f} m above home, heading {_heading(tel):.0f} deg.")
        b = getattr(snap, "battery", None)
        if b is not None:
            lines.append(f"Battery {b.remaining_percent:.0f} percent, {b.voltage_v:.1f} V.")
        if getattr(tel, "pilot_has_control", False):
            lines.append("The pilot has taken the drone on the sticks.")
    if s is not None:
        lines.append(f"AI mode: {getattr(s.mode, 'value', s.mode)}.")
    if st is not None:
        if st.task:
            lines.append(f"Copilot task: {st.task.kind} ({st.task.label}).")
        c = st.counts
        if c and time.monotonic() - c.get("_t", 0) < TRACKS_FRESH_S:
            if c.get("person_count") is not None:
                lines.append(f"Tracker sees {c['person_count']} people.")
            if c.get("vehicles_in_frame") is not None:
                lines.append(f"Tracker sees {c['vehicles_in_frame']} vehicles.")
        lines.append("Video: " + ("live." if st.frame is not None and
                                  time.monotonic() - st.frame_t < FRAME_FRESH_S else "none."))
    return "\n".join(lines)


def status_text(session_id: str) -> str:
    tel = _tel(session_id)
    st = _states.get(session_id)
    if tel is None or not skills.linked(tel):
        base = "No drone link."
    else:
        snap = tel.snapshot
        fm = snap.flight_mode
        parts = []
        b = getattr(snap, "battery", None)
        if b is not None and (b.remaining_percent or b.voltage_v):
            parts.append(f"Battery {b.remaining_percent:.0f} percent, {b.voltage_v:.1f} volts.")
        pos = skills.position(tel)
        state = "flying" if fm.is_in_air else ("armed on the ground" if fm.is_armed else "on the ground")
        alt = f" at {pos[2]:.0f} metres" if pos and fm.is_in_air else ""
        parts.append(f"{state.capitalize()}{alt}, mode {fm.mode.replace('_', ' ').lower()}.")
        gps = getattr(snap, "gps", None)
        if gps is not None and getattr(gps, "seen", True):
            parts.append(f"GPS {gps.satellites_visible} satellites.")
        if getattr(tel, "pilot_has_control", False):
            parts.append("The pilot has the sticks.")
        base = " ".join(parts)
    if st is not None and st.task is not None:
        base += f" Task: {st.task.label.lower()}."
    return base


_COUNT_ALIASES = {
    "person": {"person", "people", "persons", "man", "men", "woman", "women", "human", "humans",
               "pedestrian", "pedestrians", "kid", "kids", "child", "children", "boy", "boys",
               "girl", "girls"},
    "vehicle": {"vehicle", "vehicles", "car", "cars", "truck", "trucks", "bus", "buses",
                "motorcycle", "motorcycles", "bike", "bikes", "van", "vans"},
}


def _count_class(what: str) -> Optional[str]:
    w = set(re.findall(r"[a-z]+", what.lower()))
    for k, al in _COUNT_ALIASES.items():
        if w & al and len(w - al - {"the", "all", "of", "any"}) == 0:
            return k
    return None


def _plural(n: int, what: str) -> str:
    return f"{n} {what}"


async def do_count(session, what: str, msg_id: Optional[str]) -> str:
    sid = session.session_id
    st = _states.setdefault(sid, State())
    cls = _count_class(what)
    c = st.counts
    fresh = c and time.monotonic() - c.get("_t", 0) < TRACKS_FRESH_S
    if fresh and cls == "person" and c.get("person_count") is not None:
        text = f"I count {_plural(int(c['person_count']), what)} in view."
        await say(sid, text, msg_id=msg_id)
        return text
    if fresh and cls == "vehicle" and c.get("vehicles_in_frame") is not None:
        n = int(c["vehicles_in_frame"])
        types = c.get("vehicle_types") or {}
        word = re.sub(r"s$", "", what.lower().split()[-1])
        if word in ("car", "truck", "bus", "motorcycle", "van") and types:
            n = sum(int(v) for k, v in types.items() if str(k).lower().startswith(word))
        text = f"I count {_plural(n, what)} in view."
        await say(sid, text, msg_id=msg_id)
        return text
    if st.frame is None or time.monotonic() - st.frame_t > FRAME_FRESH_S:
        text = "I can't see anything: start the video first."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    frame = await _current_frame(sid)
    if frame is None:
        text = "The video stopped, so I can't count."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    boxes = await _vision(sid, partial(vision.ground, every=True), frame, what)
    text = f"I count {_plural(len(boxes), what)} in view." if boxes else f"I don't see any {what}."
    await say(sid, text, msg_id=msg_id)
    return text


def _jpeg(frame, max_side: int = 1280) -> Optional[bytes]:
    import cv2
    h, w = frame.shape[:2]
    if max(h, w) > max_side:
        k = max_side / float(max(h, w))
        frame = cv2.resize(frame, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes() if ok else None


async def do_describe(session, question: str, msg_id: Optional[str]) -> str:
    sid = session.session_id
    st = _states.setdefault(sid, State())
    if st.frame is None or time.monotonic() - st.frame_t > FRAME_FRESH_S:
        text = "I can't see anything: start the video first."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    frame = await _current_frame(sid)
    if frame is None:
        text = "The video stopped, so I can't look."
        await say(sid, text, msg_id=msg_id, status="refused")
        return text
    c = claude()
    if c is not None:
        jpeg = await asyncio.get_running_loop().run_in_executor(None, _jpeg, frame)
        try:
            p = await c.answer_scene(question, jpeg, context_text(sid))
            if p.status != "error" and p.reply:
                await say(sid, p.reply, msg_id=msg_id,
                          status="refused" if p.status == "refused" else "done")
                return p.reply
        except Exception as e:
            logger.warning(f"Copilot scene answer failed: {type(e).__name__}: {e}")
    caption = await _vision(sid, vision.caption, frame)
    generic = not question or bool(re.match(r"(?i)\s*(what do you see|describe|what is there|"
                                            r"what's there|look)", question))
    text = caption if generic else f"Here is what I see: {caption}"
    await say(sid, text, msg_id=msg_id)
    return text

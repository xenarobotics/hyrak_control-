"""
Turning what the pilot said into a skill.

parse_local(text): a deterministic parser for the core commands. Works with
no network and no key, and runs FIRST for the safety words (hold, stop,
land, come back) so they never wait on the network. Numbers may be digits
or words ("fifteen metres").

parse_reply(text): yes / no / "number two", the answers to an open plan card.

ClaudePlanner: when ANTHROPIC_API_KEY is set, Claude (claude-opus-5-5,
adaptive thinking at effort low, strict tools, tool_choice auto) CHOOSES one
skill from the catalogue and writes the spoken reply. It never sends a
command: what it chooses goes through skills.validate and the same guards
and plan cards as the local parser. Refusals (stop_reason "refusal") and
cut-off answers (max_tokens) are checked before any content is read.
Server-side fallbacks ("default", beta server-side-fallback-2026-07-01) are
asked for; if the API refuses the parameter it is dropped for the process.
"""
from __future__ import annotations

import base64
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.copilot import skills

logger = logging.getLogger("verocore.copilot.planner")

MODEL = os.environ.get("COPILOT_CLAUDE_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 4096
TIMEOUT_S = 25.0
HISTORY_EXCHANGES = 10


@dataclass
class Plan:
    skill: Optional[str]                 # None: a reply only
    args: Dict[str, Any] = field(default_factory=dict)
    reply: str = ""                      # what Copilot says when there is no skill (or before it)
    source: str = "local"                # "local" | "claude"
    status: str = "done"                 # "done" | "refused" | "error"


# ── text normalisation ────────────────────────────────────────────────────

_UNITS = {"zero": 0, "oh": 0, "one": 1, "a": 1, "an": 1, "two": 2, "three": 3, "four": 4,
          "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
          "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
          "seventeen": 17, "eighteen": 18, "nineteen": 19}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50, "sixty": 60,
         "seventy": 70, "eighty": 80, "ninety": 90}
_ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
             "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "1st": 1, "2nd": 2,
             "3rd": 3, "4th": 4, "5th": 5}


def _words_to_numbers(text: str) -> str:
    """"one hundred and twenty five metres" -> "125 metres". "a" and "an"
    only count before hundred ("a hundred metres")."""
    toks = text.split()
    out: List[str] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in _UNITS or t in _TENS or t == "hundred":
            j, total, cur, used = i, 0, 0, False
            while j < len(toks):
                w = toks[j]
                if w in ("a", "an"):
                    if j + 1 < len(toks) and toks[j + 1] == "hundred" and not used:
                        cur, used = 1, True
                        j += 1
                        continue
                    break
                if w in _UNITS and w not in ("a", "an"):
                    if used and cur % 10 != 0 and cur >= 10 and cur < 20:
                        break
                    cur += _UNITS[w]
                    used = True
                elif w in _TENS:
                    cur += _TENS[w]
                    used = True
                elif w == "hundred":
                    cur = (cur or 1) * 100
                    used = True
                elif w == "and" and used and j + 1 < len(toks) and \
                        (toks[j + 1] in _UNITS or toks[j + 1] in _TENS):
                    pass
                else:
                    break
                j += 1
            if used:
                out.append(str(total + cur))
                i = j
                continue
        out.append(t)
        i += 1
    return " ".join(out)


def normalise(text: str, numbers: bool = True) -> str:
    t = (text or "").lower().replace("\u2019", "'")
    t = re.sub(r"(\d),(\d{3})", r"\1\2", t)
    t = re.sub(r"(\d)\s*(m|metres?|meters?|mtrs?)\b", r"\1 metres", t)
    t = re.sub(r"[^a-z0-9.'\s-]", " ", t)
    t = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", t)
    t = t.replace("-", " ")
    t = " ".join(t.split())
    return _words_to_numbers(t) if numbers else t


_NUM = r"(\d+(?:\.\d+)?)"
_UNIT = r"(?:\s*(?:metres?|meters?|m)\b)?"


def _f(s: Optional[str]) -> Optional[float]:
    return float(s) if s is not None else None


# ── replies to an open card ───────────────────────────────────────────────

_YES = re.compile(r"^(?:yes|yeah|yep|yup|confirm(?:ed)?|do it|go ahead|go for it|affirmative|"
                  r"ok(?:ay)?|sure|approved?|proceed|correct)(?:\s+(?:please|do it|go))?$")
_NO = re.compile(r"^(?:no|nope|nah|cancel(?: that| it)?|abort|negative|never ?mind|don't|"
                 r"do not|decline|stop that)(?:\s+please)?$")


def parse_reply(text: str) -> Optional[Tuple[str, Any]]:
    """("confirm", True|False) or ("choose", 1-based index) or None."""
    t = normalise(text)
    t = re.sub(r"^(?:hyrak|copilot)\s+", "", t)
    if _YES.match(t):
        return ("confirm", True)
    if _NO.match(t):
        return ("confirm", False)
    m = re.match(r"^(?:the\s+)?(?:number|option|target|choice|no)?\s*(\d{1,2})(?:\s+(?:one|please))?$", t)
    if m and (t.split()[0] in ("number", "option", "target", "choice", "the", "no") or t.isdigit()):
        return ("choose", int(m.group(1)))
    m = re.match(r"^(?:the\s+)?(" + "|".join(_ORDINALS) + r")(?:\s+(?:one|1|person|car|target))?$", t)
    if m:
        return ("choose", _ORDINALS[m.group(1)])
    return None


# ── the local parser ──────────────────────────────────────────────────────

_POLITE = re.compile(r"^(?:(?:hey|ok|okay|please|hyrak|copilot|drone|now|and|then|can you|could you|"
                     r"would you|i want you to|i need you to)\s+)+")


def _strip(t: str) -> str:
    t = _POLITE.sub("", t)
    return re.sub(r"\s+(?:please|now|thanks|thank you)$", "", t).strip()


def _plan(skill: str, **args) -> Plan:
    return Plan(skill=skill, args=args, source="local")


def parse_local(text: str) -> Optional[Plan]:
    """The skill for an utterance, or None when this parser does not know it."""
    t = _strip(normalise(text))
    if not t:
        return None
    # Targets keep their words: "the one in red" is not "the 1 in red".
    words = _strip(normalise(text, numbers=False))

    # ── safety words first ──
    if re.fullmatch(r"(?:hold|hover|stop|freeze|halt|wait)(?: (?:here|there|position|"
                    r"right there|in place|the drone|it|now))*", t) or \
            re.fullmatch(r"(?:emergency )?(?:stop|hold) (?:everything|all)", t):
        return _plan("hold")
    if re.fullmatch(r"(?:stop|end|cancel|quit|abort) (?:following|tracking|the follow|the track|"
                    r"the orbit|orbiting|the survey|surveying|the task|task|that task)"
                    r"(?: (?:him|her|them|it|me|that|the target))?", t) or \
            t in ("stop following me", "unfollow"):
        return _plan("stop_task")
    if re.fullmatch(r"land(?: (?:now|here|the drone|it|immediately|right here|right now))*", t) or \
            t in ("touch down", "go down and land", "set it down"):
        return _plan("land")
    if re.fullmatch(r"(?:come|fly|go|head) (?:back|home)(?: (?:home|here|now|to (?:me|home|base|"
                    r"the home point|launch)))*", t) or \
            re.fullmatch(r"(?:return|go back|fly back)(?: to)? (?:home|base|launch|the home point)", t) or \
            t in ("rtl", "return", "return home", "return to launch", "r t l", "come home"):
        return _plan("return_home")

    # ── takeoff ──
    m = re.fullmatch(r"(?:take ?off|launch|lift off|start flying)(?: (?:and )?(?:to|at|up to|"
                     r"climb to|go to))?(?: " + _NUM + _UNIT + r")?(?: (?:altitude|high|up|"
                     r"in the air|above ground))?", t)
    if m:
        alt = _f(m.group(1))
        return _plan("takeoff", **({"altitude_m": alt} if alt is not None else {}))

    # ── altitude ──
    m = re.fullmatch(r"(?:go|fly|move|climb|ascend|rise|come) (?:up )?(?:to|at) (?:an altitude of )?"
                     + _NUM + _UNIT + r"(?: (?:altitude|high|up|agl))?", t) or \
        re.fullmatch(r"(?:set |change )?(?:the )?altitude (?:to )?" + _NUM + _UNIT, t)
    if m:
        return _plan("change_altitude", altitude_m=float(m.group(1)))
    m = re.fullmatch(r"(?:go|fly|move|climb|ascend|rise|raise|come)(?: (?:it|the drone))?"
                     r"(?: up)?(?: by)? " + _NUM + _UNIT + r"(?: (?:up|higher))?", t)
    if m and re.match(r"(?:climb|ascend|rise|raise)|.* up\b|.*higher", t):
        return _plan("change_altitude", delta_m=float(m.group(1)))
    m = re.fullmatch(r"(?:go|fly|move|climb|ascend|rise|raise)(?: (?:it|the drone))? up(?: by)? "
                     + _NUM + _UNIT, t)
    if m:
        return _plan("change_altitude", delta_m=float(m.group(1)))
    m = re.fullmatch(r"(?:go|fly|move|come|drop|lower|descend|sink)(?: (?:it|the drone))?"
                     r"(?: down)?(?: by)? " + _NUM + _UNIT + r"(?: (?:down|lower))?", t)
    if m and re.match(r"(?:descend|drop|lower|sink)|.* down\b|.*lower", t):
        return _plan("change_altitude", delta_m=-float(m.group(1)))
    m = re.fullmatch(r"(?:go|fly|move|come|drop|descend)(?: (?:it|the drone))? down(?: by)? "
                     + _NUM + _UNIT, t)
    if m:
        return _plan("change_altitude", delta_m=-float(m.group(1)))

    # ── relative moves ──
    m = re.fullmatch(r"(?:move|go|fly|head|come|shift|slide|step)(?: the drone)? (forward|forwards|ahead|"
                     r"back|backward|backwards|left|right)(?: by)? " + _NUM + _UNIT, t) or \
        re.fullmatch(r"(?:move|go|fly|head|shift|slide)(?: the drone)? " + r"(?:by )?" + _NUM + _UNIT +
                     r" (forward|forwards|ahead|back|backward|backwards|to the left|to the right|"
                     r"left|right)", t)
    if m:
        g = m.groups()
        direction, dist = (g[0], g[1]) if not g[0].replace(".", "").isdigit() else (g[1], g[0])
        dist = float(dist)
        direction = direction.replace("to the ", "")
        if direction in ("forward", "forwards", "ahead"):
            return _plan("move", forward_m=dist, right_m=0.0)
        if direction.startswith("back"):
            return _plan("move", forward_m=-dist, right_m=0.0)
        if direction == "left":
            return _plan("move", forward_m=0.0, right_m=-dist)
        return _plan("move", forward_m=0.0, right_m=dist)

    # ── follow / track ──
    if re.fullmatch(r"follow (?:me|myself|the pilot)(?: (?:around|please|now))?", t) or \
            t in ("come with me", "stay with me", "follow along with me"):
        return _plan("follow", target="me")
    m = re.fullmatch(r"(?:follow|chase|pursue|go after|tail)(?: after)? (.+)", words)
    if m:
        return _plan("follow", target=_target(m.group(1)))
    m = re.fullmatch(r"(?:track|keep (?:an )?eye on|watch|highlight|mark|lock on(?: to)?|lock onto)"
                     r" (.+?)(?: (?:but )?(?:don't|do not) (?:follow|move))?", words)
    if m:
        return _plan("track", target=_target(m.group(1)))

    # ── survey / orbit ──
    if re.match(r"(?:survey|scan|map|sweep|search)\b", t):
        r = re.search(r"(?:radius (?:of )?" + _NUM + r"|" + _NUM + _UNIT + r" radius|" +
                      _NUM + _UNIT + r" (?:around|round)|(?:within|of) " + _NUM + _UNIT + r")", t)
        alt = re.search(r"(?:at|altitude(?: of)?|from|height(?: of)?) " + _NUM + _UNIT +
                        r"(?: (?:altitude|high|up|agl))?$", t) or \
            re.search(r"at " + _NUM + _UNIT + r"(?: altitude| high)?", t)
        radius = next((float(x) for x in (r.groups() if r else ()) if x), None)
        args: Dict[str, Any] = {}
        if radius is not None:
            args["radius_m"] = radius
        if alt:
            args["altitude_m"] = float(alt.group(1))
        return Plan(skill="survey", args=args, source="local")
    if re.match(r"(?:orbit|circle|loiter|go (?:a)?round|fly (?:a)?round|do (?:an orbit|a circle))\b", t):
        r = re.search(r"(?:radius (?:of )?" + _NUM + r"|" + _NUM + _UNIT + r" radius|" +
                      _NUM + _UNIT + r"(?: away| out)?$|at " + _NUM + _UNIT + r")", t)
        sp = re.search(_NUM + r" (?:metres? (?:a|per) second|m s|mps|meters per second)", t)
        radius = next((float(x) for x in (r.groups() if r else ()) if x), None)
        args = {"center": "target" if re.search(r"\b(?:target|it|him|her|them|the (?:car|person|man|"
                                                 r"woman|vehicle))\b", t) else "drone"}
        if radius is not None:
            args["radius_m"] = radius
        if sp:
            args["speed_m_s"] = float(sp.group(1))
        return Plan(skill="orbit", args=args, source="local")

    # ── counts ──
    m = re.fullmatch(r"(?:count|number of)(?: all)?(?: the)? (.+?)(?: (?:in view|in frame|you see|you can see|"
                     r"below|down there|there|here))?", words)
    if m:
        return _plan("count", what=_target(m.group(1)))
    m = re.fullmatch(r"how many (.+?)(?: (?:are there|are (?:in view|in frame|below|down there|here|"
                     r"visible)|can you see|do you see|you see|in view|in frame|below|there|here|"
                     r"are visible))?", words)
    if m:
        return _plan("count", what=_target(m.group(1)))

    # ── status ──
    if re.fullmatch(r"(?:what(?:'s| is) (?:the |our |my )?)?(?:battery|status|altitude|height|"
                    r"speed|gps|signal|link)(?: (?:level|left|status|now))?", t) or \
            re.fullmatch(r"(?:how(?:'s| is| much)) (?:the |our |my )?(?:battery|drone|flight|"
                         r"altitude|link)(?: (?:is )?(?:left|doing|level|remaining))?", t) or \
            t in ("status report", "report", "how high are we", "how high is the drone",
                  "where are we", "what's our status", "sitrep"):
        return _plan("status")

    # ── scene questions ──
    if re.match(r"(?:what (?:do|can) you see|what(?:'s| is) (?:there|in front|below|down there|"
                r"happening|going on|on the ground|in view)|describe|look|tell me what|"
                r"is (?:there|anyone|anybody|someone|somebody)|are (?:there|any)|"
                r"can you see|do you see|where is|where are|is the|are the|which|who is)\b", t):
        return _plan("describe", question=text.strip()[:skills.TEXT_MAX])
    return None


# "follow the man in red and take off to 15 metres": the target ends where
# the next command starts (the local parser does one skill at a time).
_NEXT_CLAUSE = re.compile(r"\s+(?:and|then|and then)\s+(?:take ?off|land|go|fly|move|climb|descend|"
                          r"come|return|hold|stop|orbit|survey|count|track|follow|keep|stay)\b.*$")


def _target(s: str) -> str:
    s = _NEXT_CLAUSE.sub("", s.strip())
    s = re.sub(r"\s+(?:please|now|for me|around|again)$", "", s)
    return re.sub(r"^(?:the|that|this|those|these|all the|all)\s+", "", s)


# ── Claude ────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are HYRAK Copilot, the voice assistant in a drone pilot's ground station.
The pilot talks to you while flying. You answer in one or two short spoken sentences, plain words,
no lists, no markdown, metres not feet.

You act ONLY by choosing one of the provided tools. Each tool is a skill of the drone; the ground
station checks every skill against its safety guards and shows the pilot a plan card to confirm before
anything that moves the drone. You never send commands yourself and you never claim something has
happened: say what you are proposing ("I'll land here once you confirm").

Choose at most one tool per message. If the pilot asks for something no tool does, or something
unsafe or unclear (a missing distance, an ambiguous direction), do not call a tool: ask a short
question or say what you can do instead. Directions are relative to the drone's heading. Altitudes
are metres above the home point. For follow and track, pass the target exactly as the pilot
described it ("man in the red shirt", "white car"), or "me" when the pilot means themself.
Scene questions ("what do you see", "is anyone lying down") use the describe tool with the
pilot's question. Counting uses count. When a tool fits, call it without writing text first.
The state of the drone and the camera is given with each message; use it, and never invent
readings that are not there."""

SCENE_PROMPT = """You are HYRAK Copilot, looking through a drone's camera for its pilot.
Answer the pilot's question about this frame in one to three short spoken sentences, plain words,
no lists or markdown. Say only what you can actually see; if something cannot be told from the
frame, say so. If the frame shows a person who may be hurt or in danger, say that first."""


class ClaudePlanner:
    """Claude through the official SDK. `client` is an anthropic.AsyncAnthropic
    (or a stand-in with the same .beta.messages.create)."""

    def __init__(self, client=None, model: str = MODEL):
        self.model = model
        self._client = client
        self._fallbacks = True

    @staticmethod
    def available() -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    @property
    def client(self):
        if self._client is None:
            import anthropic
            # The key is read from ANTHROPIC_API_KEY by the SDK; never logged.
            self._client = anthropic.AsyncAnthropic(timeout=TIMEOUT_S, max_retries=1)
        return self._client

    async def _create(self, **kw):
        params = dict(model=self.model, max_tokens=MAX_TOKENS, thinking={"type": "adaptive"},
                      output_config={"effort": "low"}, **kw)
        if self._fallbacks:
            try:
                return await self.client.beta.messages.create(
                    betas=[FALLBACK_BETA], fallbacks="default", **params)
            except Exception as e:
                if not _is_bad_request(e) or "fallback" not in str(e).lower():
                    raise
                logger.warning("Copilot: server-side fallbacks not accepted; continuing without")
                self._fallbacks = False
        return await self.client.beta.messages.create(**params)

    async def plan(self, text: str, context: str, history: List[Dict[str, str]]) -> Plan:
        messages = _history_messages(history)
        messages.append({"role": "user", "content": f"<drone_state>\n{context}\n</drone_state>\n\n"
                                                    f"Pilot: {text}"})
        resp = await self._create(
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            tools=skills.tool_schemas(),
            tool_choice={"type": "auto", "disable_parallel_tool_use": True},
            messages=messages)
        return read_plan(resp)

    async def answer_scene(self, question: str, jpeg: bytes, context: str) -> Plan:
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.standard_b64encode(jpeg).decode("ascii")}},
            {"type": "text", "text": f"<drone_state>\n{context}\n</drone_state>\n\n"
                                     f"Pilot: {question or 'What do you see?'}"},
        ]
        resp = await self._create(system=SCENE_PROMPT, messages=[{"role": "user", "content": content}])
        p = read_plan(resp)
        p.skill = None
        return p


def _is_bad_request(e: Exception) -> bool:
    try:
        import anthropic
        return isinstance(e, anthropic.BadRequestError)
    except Exception:
        return getattr(e, "status_code", None) == 400


def _history_messages(history: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    """The last HISTORY_EXCHANGES exchanges as plain text turns (tool calls
    are summarised in the assistant text, so no tool_use ids need pairing)."""
    out: List[Dict[str, Any]] = []
    for ex in history[-HISTORY_EXCHANGES:]:
        if ex.get("pilot"):
            out.append({"role": "user", "content": f"Pilot: {ex['pilot']}"})
        if ex.get("copilot"):
            out.append({"role": "assistant", "content": ex["copilot"]})
    return out


def _block(b, key, default=None):
    return b.get(key, default) if isinstance(b, dict) else getattr(b, key, default)


def read_plan(resp) -> Plan:
    """A Plan from a Messages response. stop_reason first: a refusal or a
    cut-off answer is never read as a plan."""
    stop = _block(resp, "stop_reason")
    if stop == "refusal":
        return Plan(skill=None, reply="I can't help with that one.", source="claude", status="refused")
    if stop == "max_tokens":
        return Plan(skill=None, reply="", source="claude", status="error")
    content = _block(resp, "content") or []
    texts, tool = [], None
    for b in content:
        kind = _block(b, "type")
        if kind == "text":
            texts.append(_block(b, "text") or "")
        elif kind == "tool_use" and tool is None:
            tool = b
    reply = " ".join(t.strip() for t in texts if t and t.strip())
    if tool is not None:
        name = _block(tool, "name")
        args = _block(tool, "input") or {}
        if name not in skills.SKILLS or not isinstance(args, dict):
            return Plan(skill=None, reply="", source="claude", status="error")
        # Strict schemas send optional values as null; validate() reads
        # absent and null the same.
        args = {k: v for k, v in args.items() if v is not None}
        return Plan(skill=name, args=args, reply=reply, source="claude")
    if not reply:
        return Plan(skill=None, reply="", source="claude", status="error")
    return Plan(skill=None, reply=reply, source="claude")

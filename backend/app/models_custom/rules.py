"""
No-code rules for custom models: the pure part (no sockets, no drone).

A rule is a sentence on a model, stored in models.settings.rules:

    "When [label] is seen above [min_score] for [for_s] s, then [action]"

    {id, enabled, label, min_score, for_s, action, confirm, cooldown_s}

action is alert, mark, hover or follow. hover and follow move the drone;
app/models_custom/actions.py runs them behind the pilot's "Allow model
control" switch and its guards. This module has:

  * validate_rules: the PATCH check (service.py turns RuleError into a
    400 bad_request with the reason).
  * RuleEngine: per rule, how long the label has been seen without a gap
    longer than GAP_S, whether it fires on this frame, and its cooldown.
    One per analyzer (one session), driven from the analyzer's thread.
  * PendingConfirms: "Ask me first" tokens, CONFIRM_S to answer.
  * FollowTarget / FollowController: keeping the lock on the followed
    box by IoU or centre distance, and the velocity command toward it.

Clocks: callers pass `now` (time.monotonic() on the frame path, time.time()
for tokens shown to the client), so everything here is testable without
sleeping.
"""
from __future__ import annotations

import math
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

MAX_RULES = 6
ACTIONS = ("alert", "mark", "hover", "follow")
MOVING = frozenset({"hover", "follow"})
BOX_ACTIONS = frozenset({"mark", "follow"})      # need a box: not for classify models
GAP_S = 0.5            # a gap this long still counts as "seen continuously"
CONFIRM_S = 10.0       # "Ask me first": the chip is on screen this long
LOST_S = 3.0           # follow: target unseen this long ends the follow

# Follow speed caps (body frame). Altitude is held by the telemetry
# manager's Offboard hold (start_offboard), so down is always 0.
MAX_FORWARD_M_S = 3.0
MAX_RIGHT_M_S = 1.5
MAX_YAW_DEG_S = 30.0

_ID = re.compile(r"^[a-z0-9]{8,16}$")


class RuleError(ValueError):
    """A rule list that cannot be saved; str(e) is the plain reason."""


def _num(r: dict, key: str, default: float, lo: float, hi: float, what: str) -> float:
    v = r.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool):
        raise RuleError(f"{what} is a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise RuleError(f"{what} is a number")
    if not math.isfinite(f) or not lo <= f <= hi:
        raise RuleError(f"{what} is between {lo:g} and {hi:g}")
    return f


def clean_rule(r, *, labels: Optional[List[str]] = None, task: str = "detect") -> dict:
    if not isinstance(r, dict):
        raise RuleError("each rule is an object")
    rid = r.get("id")
    if not isinstance(rid, str) or not _ID.match(rid):
        raise RuleError("a rule id is 8 to 16 lowercase letters or digits")
    label = str(r.get("label") or "").strip()
    if not label or len(label) > 64:
        raise RuleError("a rule needs a class name")
    if labels:
        by_lower = {str(n).lower(): str(n) for n in labels}
        if label.lower() not in by_lower:
            raise RuleError(f"\"{label}\" is not one of this model's classes")
        label = by_lower[label.lower()]
    action = r.get("action")
    if action not in ACTIONS:
        raise RuleError("a rule's action is alert, mark, hover or follow")
    if task == "classify" and action in BOX_ACTIONS:
        raise RuleError(f"{action} needs boxes, and this model names the whole picture")
    enabled = r.get("enabled", True)
    confirm = r.get("confirm", True)
    if not isinstance(enabled, bool) or not isinstance(confirm, bool):
        raise RuleError("enabled and confirm are true or false")
    return {
        "id": rid, "enabled": enabled, "label": label,
        "min_score": _num(r, "min_score", 0.5, 0.05, 0.99, "min_score"),
        "for_s": _num(r, "for_s", 1.0, 0.0, 30.0, "for_s"),
        "action": action,
        # Only moving actions ask first; alert and mark just happen.
        "confirm": confirm if action in MOVING else False,
        "cooldown_s": _num(r, "cooldown_s", 30.0, 5.0, 600.0, "cooldown_s"),
    }


def validate_rules(rules, *, labels: Optional[List[str]] = None,
                   task: str = "detect") -> Optional[List[dict]]:
    """The cleaned rule list, or RuleError. None clears the rules."""
    if rules is None:
        return None
    if not isinstance(rules, list):
        raise RuleError("rules is a list")
    if len(rules) > MAX_RULES:
        raise RuleError(f"a model has at most {MAX_RULES} rules")
    out = [clean_rule(r, labels=labels, task=task) for r in rules]
    if len({r["id"] for r in out}) != len(out):
        raise RuleError("two rules have the same id")
    if sum(1 for r in out if r["enabled"] and r["action"] == "follow") > 1:
        raise RuleError("only one follow rule can be on at a time")
    return out


# ── The engine ────────────────────────────────────────────────────────────

Hit = Tuple[str, float, Optional[list]]      # (class name, score, box or None)


@dataclass
class _Track:
    first_seen: Optional[float] = None
    last_seen: Optional[float] = None
    last_fired: Optional[float] = None


class RuleEngine:
    """Per-rule continuity, firing and cooldown for one session.

    A rule's label counts as seen on a frame when a hit of that class
    scores at least min_score. Seen-for runs from the first such frame and
    survives gaps up to GAP_S; a longer gap starts it again. The rule fires
    on a frame where it is seen and has been for for_s, unless it is
    cooling down (cooldown_s from its last firing)."""

    def __init__(self):
        self._t: Dict[str, _Track] = {}

    def reset(self) -> None:
        self._t.clear()

    def update(self, rules: Optional[List[dict]], hits: List[Hit],
               now: float) -> Tuple[List[dict], List[dict]]:
        """(fires, rules_state) for this frame. A fire is {rule, label,
        score, box}: the rule as configured and its best matching hit."""
        fires: List[dict] = []
        state: List[dict] = []
        live_ids = set()
        for rule in rules or []:
            rid = rule.get("id")
            if not rid:
                continue
            live_ids.add(rid)
            t = self._t.setdefault(rid, _Track())
            cooldown = float(rule.get("cooldown_s", 30.0))
            cooling = 0.0
            if t.last_fired is not None:
                cooling = max(0.0, t.last_fired + cooldown - now)
            if not rule.get("enabled", True):
                t.first_seen = t.last_seen = None
                state.append(self._row(rule, 0.0, False, cooling))
                continue
            want = str(rule.get("label") or "").lower()
            min_score = float(rule.get("min_score", 0.5))
            best: Optional[Hit] = None
            for name, score, box in hits:
                if name.lower() == want and score >= min_score and (best is None or score > best[1]):
                    best = (name, score, box)
            if best is not None:
                if t.last_seen is None or now - t.last_seen > GAP_S:
                    t.first_seen = now
                t.last_seen = now
            elif t.last_seen is not None and now - t.last_seen > GAP_S:
                t.first_seen = t.last_seen = None
            seen_for = (now - t.first_seen) if t.first_seen is not None else 0.0
            met = t.first_seen is not None and seen_for >= float(rule.get("for_s", 1.0))
            if met and best is not None and cooling <= 0.0:
                t.last_fired = now
                cooling = cooldown
                fires.append({"rule": dict(rule), "label": best[0], "score": float(best[1]),
                              "box": list(best[2]) if best[2] is not None else None})
            state.append(self._row(rule, seen_for, met, cooling))
        for gone in set(self._t) - live_ids:
            self._t.pop(gone, None)
        return fires, state

    @staticmethod
    def _row(rule: dict, seen_for: float, firing: bool, cooling: float) -> dict:
        return {"rule_id": rule.get("id"), "label": rule.get("label"), "action": rule.get("action"),
                "seen_for_s": round(seen_for, 2), "firing": bool(firing),
                "cooling_s": round(cooling, 1)}


# ── "Ask me first" ────────────────────────────────────────────────────────

@dataclass
class Pending:
    token: str
    session_id: str
    expires_at: float
    entry: Dict[str, Any] = field(default_factory=dict)


class PendingConfirms:
    """Tokens for moving actions waiting on the pilot. A token is good
    once, for its own session, until expires_at (wall clock: the client
    shows it)."""

    def __init__(self, ttl_s: float = CONFIRM_S):
        self.ttl_s = ttl_s
        self._by_token: Dict[str, Pending] = {}

    def add(self, session_id: str, entry: Dict[str, Any], now: Optional[float] = None) -> Pending:
        now = time.time() if now is None else now
        p = Pending(token=secrets.token_urlsafe(12), session_id=session_id,
                    expires_at=now + self.ttl_s, entry=dict(entry))
        self._by_token[p.token] = p
        return p

    def take(self, token, session_id: str, now: Optional[float] = None) -> Optional[Pending]:
        """The pending action for this token, removed; None when unknown,
        another session's, or expired (an expired one is removed too)."""
        if not isinstance(token, str):
            return None
        now = time.time() if now is None else now
        p = self._by_token.get(token)
        if p is None or p.session_id != session_id:
            return None
        del self._by_token[token]
        if now > p.expires_at:
            return None
        return p

    def expired(self, now: Optional[float] = None, session_id: Optional[str] = None) -> List[Pending]:
        """Remove and return the tokens that ran out (of one session)."""
        now = time.time() if now is None else now
        out = [p for p in self._by_token.values()
               if now > p.expires_at and (session_id is None or p.session_id == session_id)]
        for p in out:
            self._by_token.pop(p.token, None)
        return out

    def drop_session(self, session_id: str) -> None:
        for tok in [t for t, p in self._by_token.items() if p.session_id == session_id]:
            self._by_token.pop(tok, None)

    def __len__(self) -> int:
        return len(self._by_token)


# ── Follow ────────────────────────────────────────────────────────────────

def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = (float(v) for v in a[:4])
    bx1, by1, bx2, by2 = (float(v) for v in b[:4])
    iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union > 0 else 0.0


def _centre(b) -> Tuple[float, float]:
    return (float(b[0]) + float(b[2])) / 2.0, (float(b[1]) + float(b[3])) / 2.0


class FollowTarget:
    """The one box being followed. Custom models have no tracker, so the
    lock is kept frame to frame by overlap with the last box (IoU at least
    MIN_IOU), else the nearest centre of the same class within
    MAX_JUMP of the frame diagonal. With no starting box the first frame
    locks on the best-scoring box of the label."""

    MIN_IOU = 0.1
    MAX_JUMP = 0.2

    def __init__(self, label: str, box: Optional[list], score: float, now: float):
        self.label = label
        self.box = list(box) if box else None
        self.score = float(score)
        self.since = now
        self.last_seen = now
        self.size_ref: Optional[float] = None      # box height / frame height at lock

    def update(self, hits: List[Hit], frame_w: int, frame_h: int,
               now: float) -> Optional[Hit]:
        want = self.label.lower()
        same = [h for h in hits if h[0].lower() == want and h[2]]
        match: Optional[Hit] = None
        if same and self.box is None:
            match = max(same, key=lambda h: h[1])
        elif same:
            best = max(same, key=lambda h: iou(self.box, h[2]))
            if iou(self.box, best[2]) >= self.MIN_IOU:
                match = best
            else:
                cx, cy = _centre(self.box)
                diag = math.hypot(frame_w, frame_h) or 1.0
                near = min(same, key=lambda h: math.dist((cx, cy), _centre(h[2])))
                if math.dist((cx, cy), _centre(near[2])) <= self.MAX_JUMP * diag:
                    match = near
        if match is not None:
            self.box = list(match[2])
            self.score = float(match[1])
            self.last_seen = now
            if self.size_ref is None and frame_h > 0:
                self.size_ref = max(1e-3, (self.box[3] - self.box[1]) / frame_h)
        return match

    def lost_s(self, now: float) -> float:
        return max(0.0, now - self.last_seen)

    def public(self, now: float) -> dict:
        return {"active": True, "label": self.label, "score": round(self.score, 4),
                "box": [int(v) for v in self.box] if self.box else None,
                "lost_s": round(self.lost_s(now), 2)}


def velocity(forward: float = 0.0, right: float = 0.0, yaw: float = 0.0) -> Dict[str, Any]:
    """A capped body-frame velocity command, down always 0."""
    return {"type": "velocity",
            "forward_m_s": round(max(-MAX_FORWARD_M_S, min(MAX_FORWARD_M_S, forward)), 3),
            "right_m_s": round(max(-MAX_RIGHT_M_S, min(MAX_RIGHT_M_S, right)), 3),
            "down_m_s": 0.0,
            "yaw_deg_s": round(max(-MAX_YAW_DEG_S, min(MAX_YAW_DEG_S, yaw)), 3)}


class FollowController:
    """Yaw centres the box; forward keeps its apparent height at what it
    was when the lock started (app/vision/controllers.range_error_ratio, so
    the tolerance is a fraction of range); no sideways or vertical motion.
    Forward is throttled while the box is off-centre, a retreat never.
    The same PD gains as the built-in follow modes, capped lower."""

    YAW_PRIORITY_THRESHOLD = 0.30
    YAW_PRIORITY_FLOOR = 0.35

    def __init__(self):
        from app.vision.controllers import PDController
        try:
            from app.vision.pursuit import new_yaw_pd
            self.yaw_pd = new_yaw_pd()
        except Exception:
            self.yaw_pd = PDController(kp=60.0, kd=15.0, max_output=MAX_YAW_DEG_S, deadband=0.03)
        self.yaw_pd.max_output = min(self.yaw_pd.max_output, MAX_YAW_DEG_S)
        self.dist_pd = PDController(kp=4.0, kd=1.0, max_output=MAX_FORWARD_M_S, deadband=0.08)

    def command(self, target: FollowTarget, frame_w: int, frame_h: int) -> Dict[str, Any]:
        from app.vision.controllers import range_error_ratio
        if not target.box or frame_w <= 0 or frame_h <= 0:
            return velocity()
        cx, _ = _centre(target.box)
        err_yaw = cx / frame_w - 0.5
        yaw = self.yaw_pd.compute(err_yaw)
        h_now = (target.box[3] - target.box[1]) / frame_h
        forward = self.dist_pd.compute(range_error_ratio(target.size_ref or h_now, h_now))
        if forward > 0:
            forward *= max(self.YAW_PRIORITY_FLOOR,
                           1.0 - abs(err_yaw) / self.YAW_PRIORITY_THRESHOLD)
        return velocity(forward=forward, yaw=yaw)

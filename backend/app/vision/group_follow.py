"""
Group follow: keeping SEVERAL subjects in frame at once.
========================================================

A different controller from single-target follow, and the difference is the
whole feature.

    Single follow chases a SETPOINT - centre the subject, hold it at 30% of
    frame height. Group follow enforces a CONTAINMENT CONSTRAINT - everyone
    inside the frame with margin - and otherwise does nothing at all.

That distinction is what keeps the aircraft calm. With two subjects moving
independently there is no position that satisfies a setpoint for both, so any
controller chasing one will pump in and out every time either of them takes a
step. Containment has a dead band by construction: while the group fits, the
correct action is to hold, and holding is what it does.

WHAT IS ACTUALLY BEING CONTROLLED
    The union of the members' boxes - the GROUP BOX. Its centre drives yaw and
    (in Auto altitude) the vertical axis; its SIZE drives the forward axis.
    Nobody is centred, and that is deliberate: demanding two subjects be
    centred at once is a demand for the impossible, which the operator would
    experience as an aircraft that never settles.

THE CONSTRAINT IS A BAND, NOT A LINE
    Back off above the max fill, close in below the min, do nothing between.
    A single threshold means retreating at 81% and advancing at 79%, twice a
    second, forever.

HEIGHT IS TIGHTER THAN WIDTH, BECAUSE THE CAMERA IS BOLTED DOWN
    With a fixed mount pitched down, the frame's vertical axis IS the range
    axis - the bottom edge is near the aircraft and the top is far. A subject
    walking toward the drone exits the BOTTOM long before a side-by-side pair
    troubles the width. So the vertical margin is the one that gets breached
    first in practice, and it is set tighter to match.

EDGE PROXIMITY TRIGGERS THE RETREAT; FILL TRIGGERS THE CLOSE-IN
    Group fill only correlates with losing someone. A member's box approaching
    a frame EDGE is the thing that actually predicts it - a group box at 75%
    fill sitting off-centre is closer to a loss than a centred one at 85%.
    Fill is still the right signal for closing back in, because that is a
    question about the group as a whole and there is no urgency in it.

WIDENING SPLITS BETWEEN RETREAT AND CLIMB, AT CONSTANT DEPRESSION
    See widen_velocity. Backing off alone keeps the look angle shallow but
    walks the aircraft backwards into airspace its camera is not pointing at;
    climbing alone is laterally safe but steepens the depression until faces
    and plates stop being readable. Splitting the required range increase
    between the two along the current sight line grows the range while leaving
    the look angle where it was, so the analytics this module reports on
    survive the manoeuvre.

WHEN IT CANNOT BE DONE, IT SAYS SO AND STOPS
    Two people walking opposite ways at 1.5 m/s separate at 3 m/s and the
    range needed to frame them grows without bound. There is no "keep both
    framed" - only "keep both framed for the next N seconds". Past the
    give-up window the group is declared UNFRAMEABLE: translation stops, yaw
    keeps the group centred, and the operator is told what range would be
    needed. Nothing is silently dropped, because a group that quietly became a
    single-subject follow is the failure this module exists to make visible.
"""
import logging
import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.utils.geo import haversine_m

logger = logging.getLogger("verocore.vision.group_follow")


#: Hard cap on group size. Past four subjects the range needed to frame them
#: makes every analytic in this module worthless - plates need ~7 m slant
#: range - and what the operator actually wants is crowd management, which
#: this same module already provides. A cap that refuses is better than a
#: follow that technically works and reports nothing readable.
MAX_FOLLOW_MEMBERS = 4

#: Upper edge of the containment band, as a fraction of the frame.
GROUP_MAX_FILL_W = 0.80
GROUP_MAX_FILL_H = 0.70
#: Lower edge. The gap to the max IS the dead band, and it is wide on purpose.
GROUP_MIN_FILL_W = 0.45
GROUP_MIN_FILL_H = 0.40

#: How close a member's box may come to a frame edge before the retreat is
#: forced regardless of fill. 4% of the frame is ~43 px at 1080p - far enough
#: out to act before the box starts being truncated, which is the point at
#: which the box stops describing the subject.
GROUP_EDGE_MARGIN = 0.04

#: A definite, bounded "back off" when an edge is breached. Same shape as
#: pursuit._ROW_TRUNCATED_ERROR: clear of any sane deadband, small enough not
#: to lurch.
_EDGE_URGENT_ERROR = -0.06

#: How long a NON-URGENT action must be wanted before it is adopted. Stops one
#: noisy frame from commanding a manoeuvre. Widening is exempt - see settle().
GROUP_DWELL_S = 0.5

# ── THE WIDEN BUDGET ────────────────────────────────────────────────────────
#
# A widen has to be bounded, because two subjects walking apart need a range
# that grows without limit and there is no manoeuvre that wins. The question is
# what to bound it WITH, and the honest answer is metres, not seconds.
#
# WHAT ACTUALLY GOES WRONG IS DISPLACEMENT. The cost of an over-long widen is
# that the aircraft ends up somewhere the operator did not put it - and,
# because the retreat is backwards, somewhere its camera has not been looking.
# Seconds are only a proxy for that, and a bad one: the widen speed is
# proportional to how far past the margin the group is, so the same 15 seconds
# is 2 m of travel for a group barely over the line and 35 m for one that is
# diverging hard. A time bound is therefore simultaneously too tight for the
# case that would have recovered and too loose for the case that will not.
#
# MEASURED, NOT INTEGRATED. This differences two GPS fixes. Integrating the
# COMMANDED velocity instead would be dead reckoning of a setpoint the aircraft
# may not be achieving - wind, saturation, attitude limits - against the vision
# loop's dt, which is the exact clock the blind-flight work already established
# cannot be trusted (frames are not seconds). That would produce a number with
# a metre sign on it that is really a guess.

#: Ground track allowed while widening, metres. Roughly the radius within which
#: an operator watching the aircraft still recognises where it is.
GROUP_WIDEN_LIMIT_M = 15.0

#: The FALLBACK bound, used only when there is no position fix good enough to
#: measure the distance with.
#:
#: NOT tied to the reacquisition ladder's WIDEN_UNTIL_S, which it briefly was.
#: That tie was justified as keeping the flown timeout from drifting from the
#: displayed one, but the two were never measuring the same thing: the ladder
#: counts time since the subject was last SEEN, and this counts time spent
#: widening while everyone is in plain sight. There was nothing for them to
#: disagree about, so matching them only made this one longer than it needed
#: to be.
GROUP_GIVE_UP_S = 8.0

# ── MEMBERSHIP OUTLIVES A TRACK ID ─────────────────────────────────────────
#
# A group member is stored as a ByteTrack id, and a ByteTrack id is not a
# person. Walk behind a pole and come back and you are a NEW id - so a member
# bound to the old one is gone forever, while standing in plain sight with
# their name drawn over them by the face recogniser.
#
# That failure is unbounded in a way the single-subject one is not. A lost
# single subject runs the reacquisition ladder and ends in a hover after 15 s,
# and the operator taps again. A lost GROUP MEMBER is permanent: the group
# reports "1 of 2" for the rest of the session, and because closing in is
# blocked while anyone is missing, the aircraft can never approach again.
#
# So membership is resolved through the DURABLE identity where one exists - a
# confirmed face for a person, the vehicle_id the plate registry restores for a
# vehicle - and a member who is genuinely gone is RETIRED rather than left to
# cripple the group.

#: How long a member may be missing before they are dropped from the group.
#: The reacquisition ladder's final rung: past this the rest of the system has
#: already declared a subject lost, and a group that kept waiting would be
#: holding the aircraft to a standard nothing else in the codebase holds.
MEMBER_RETIRE_S = 15.0

#: Minimum GPS quality to measure a 15 m displacement with. A 2D fix has no
#: usable horizontal accuracy for this, and a thin constellation wanders by
#: metres while the aircraft sits still - which would spend the budget without
#: the aircraft moving.
_MIN_FIX_TYPE = 3
_MIN_SATS = 6


class GroupAction(str, Enum):
    """
    What the forward axis should do. Named rather than implied by a sign,
    because the operator has to be able to see WHY the aircraft is moving -
    "backing off to keep 3 in frame" and "closing in, group has bunched up"
    look identical from the ground and mean opposite things.
    """
    HOLD = "hold"          # inside the band; translation quiet
    WIDEN = "widen"        # too big or touching an edge; retreat + climb
    CLOSE = "close"        # too small; close in
    UNFRAMEABLE = "unframeable"   # given up widening; holding and reporting


@dataclass(frozen=True)
class GroupBox:
    """The union of the members' boxes, normalised to the frame."""
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2.0

    @property
    def w(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def h(self) -> float:
        return max(0.0, self.y2 - self.y1)


def group_box(boxes: Sequence[Sequence[float]], W: int, H: int) -> Optional[GroupBox]:
    """
    Union of pixel boxes, normalised. None for an empty sequence - an empty
    group has no box, and returning a degenerate one at the origin would read
    as a subject in the top-left corner.
    """
    if not boxes or W <= 0 or H <= 0:
        return None
    xs1 = min(float(b[0]) for b in boxes)
    ys1 = min(float(b[1]) for b in boxes)
    xs2 = max(float(b[2]) for b in boxes)
    ys2 = max(float(b[3]) for b in boxes)
    return GroupBox(xs1 / W, ys1 / H, xs2 / W, ys2 / H)


def edge_breach(boxes: Sequence[Sequence[float]], W: int, H: int) -> Optional[str]:
    """
    Which frame edge a member has come too close to, or None.

    Checked per MEMBER rather than on the group box, because the group box can
    sit comfortably inside the margins while one member hugs an edge - the
    union's extent says nothing about where the individual subjects are once
    there are more than two of them.
    """
    if not boxes or W <= 0 or H <= 0:
        return None
    m = GROUP_EDGE_MARGIN
    for b in boxes:
        if float(b[0]) / W <= m:
            return "left"
        if float(b[2]) / W >= 1.0 - m:
            return "right"
        if float(b[1]) / H <= m:
            return "top"
        if float(b[3]) / H >= 1.0 - m:
            return "bottom"
    return None


@dataclass
class GroupFraming:
    """
    The framing assessment for one frame. Carries the numbers the panel shows
    as well as the decision, so the operator can see the margin they are
    flying on rather than only the action it produced.
    """
    box: GroupBox
    fill_w: float
    fill_h: float
    action: GroupAction
    #: Signed, in frame fractions, same convention as every other distance
    #: error in this codebase: POSITIVE means move forward, NEGATIVE means back
    #: off. Zero inside the band.
    error: float
    edge: Optional[str] = None
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fill_w_pct": round(self.fill_w * 100.0, 1),
            "fill_h_pct": round(self.fill_h * 100.0, 1),
            "max_fill_w_pct": round(GROUP_MAX_FILL_W * 100.0, 1),
            "max_fill_h_pct": round(GROUP_MAX_FILL_H * 100.0, 1),
            "action": self.action.value,
            "edge": self.edge,
            "reason": self.reason,
            "box": [round(self.box.x1, 4), round(self.box.y1, 4),
                    round(self.box.x2, 4), round(self.box.y2, 4)],
        }


def assess_framing(
    box: GroupBox,
    boxes_px: Sequence[Sequence[float]],
    W: int,
    H: int,
) -> GroupFraming:
    """
    Turn a group box into an action plus the signed forward error that
    produces it.

    Both axes are checked and the TIGHTER one wins, because fitting on width
    while overflowing on height is not fitting.
    """
    fw, fh = box.w, box.h
    edge = edge_breach(boxes_px, W, H)

    over_w = fw - GROUP_MAX_FILL_W
    over_h = fh - GROUP_MAX_FILL_H
    overshoot = max(over_w, over_h)

    if overshoot > 0.0:
        axis = "width" if over_w >= over_h else "height"
        err = -overshoot
        reason = (f"group fills {fw * 100:.0f}%x{fh * 100:.0f}% - over the "
                  f"{axis} margin, widening")
        action = GroupAction.WIDEN
    elif edge is not None:
        err = _EDGE_URGENT_ERROR
        reason = f"a subject is at the {edge} edge - widening"
        action = GroupAction.WIDEN
    else:
        under_w = GROUP_MIN_FILL_W - fw
        under_h = GROUP_MIN_FILL_H - fh
        # Closing in is governed by whichever axis is FURTHEST from its floor,
        # i.e. the smaller undershoot - closing until the tighter axis reaches
        # its minimum would overshoot the other one straight out of the band.
        undershoot = min(under_w, under_h)
        if undershoot > 0.0:
            err = undershoot
            reason = (f"group fills only {fw * 100:.0f}%x{fh * 100:.0f}% - "
                      f"closing in")
            action = GroupAction.CLOSE
        else:
            err = 0.0
            reason = f"group framed at {fw * 100:.0f}%x{fh * 100:.0f}%"
            action = GroupAction.HOLD

    return GroupFraming(box=box, fill_w=fw, fill_h=fh, action=action,
                        error=err, edge=edge, reason=reason)


@dataclass
class GroupLatch:
    """
    Dwell filter over the action, so the aircraft does not change its mind on
    single-frame noise.

    THE ASYMMETRY IS THE POINT. WIDEN is adopted the instant it is wanted;
    everything else has to be wanted for GROUP_DWELL_S first. Waiting half a
    second to react to a subject leaving the frame defeats the entire feature,
    while waiting half a second before closing in costs nothing. Same stance
    the altitude guards take: the safe direction is free, the risky one waits.
    """
    action: GroupAction = GroupAction.HOLD
    _pending: Optional[GroupAction] = None
    _pending_since: float = 0.0

    def settle(self, want: GroupAction, now: float) -> GroupAction:
        if want == self.action:
            self._pending = None
            return self.action
        if want == GroupAction.WIDEN:
            self.action = want
            self._pending = None
            return self.action
        if self._pending != want:
            self._pending = want
            self._pending_since = now
            return self.action
        if now - self._pending_since >= GROUP_DWELL_S:
            self.action = want
            self._pending = None
        return self.action

    def reset(self) -> None:
        self.action = GroupAction.HOLD
        self._pending = None
        self._pending_since = 0.0


def widen_velocity(
    speed_m_s: float,
    depression_deg: Optional[float],
) -> Tuple[float, float]:
    """
    Split a required RANGE increase between backing off and climbing so the
    depression angle stays where it is.

    Returns (forward_m_s, down_m_s) in the usual NED-ish convention: forward is
    negative for a retreat, down is negative for a climb.

    THE GEOMETRY. With the camera on the sight line at depression theta, slant
    range R relates to altitude and ground distance as h = R*sin(theta) and
    d = R*cos(theta). To grow R at v m/s while holding theta constant, climb at
    v*sin(theta) and back off at v*cos(theta). Straight down (theta -> 90) the
    split becomes all climb, which is correct - moving horizontally under a
    subject directly below changes the slant range by almost nothing. Level
    (theta -> 0) it becomes all retreat, equally correct.

    WHY HOLD THETA AT ALL. This module reports which analytics its geometry can
    resolve, and depression is one of the two things that determines that. A
    widen that climbed alone would grow the range AND steepen the look angle,
    losing plates and faces twice over; one that backed off alone would flatten
    the angle and walk the aircraft backwards. Holding theta means the only
    thing the manoeuvre costs is range, which is the thing being spent
    deliberately.

    NO DEPRESSION READING MEANS NO CLIMB. Same stance decide_elevation takes:
    without pose there is no AGL either, so neither altitude bound can be
    enforced and an autonomous climb would be unbounded. Retreat is the
    survivable half and it is what happens.
    """
    v = abs(float(speed_m_s))
    if v <= 0.0:
        return 0.0, 0.0
    if depression_deg is None:
        return -v, 0.0
    theta = math.radians(max(0.0, min(90.0, float(depression_deg))))
    return -v * math.cos(theta), -v * math.sin(theta)


def required_range_m(
    framing: GroupFraming,
    agl_m: Optional[float],
    depression_deg: Optional[float],
) -> Optional[float]:
    """
    Roughly how far back the aircraft would have to be for this group to fit,
    in metres of slant range. None when the geometry is unknown.

    Angular extent is proportional to 1/R for a group of fixed ground size, so
    R_needed = R_now * (fill / max_fill). Approximate - it treats the group as
    planar and ignores the members' own depth - but it is the difference
    between "cannot frame all" and "cannot frame all, needs about 45 m", and
    only the second one tells the operator whether to back off or give up.
    """
    if agl_m is None or depression_deg is None:
        return None
    theta = math.radians(max(1.0, min(89.0, float(depression_deg))))
    r_now = float(agl_m) / math.sin(theta)
    ratio = max(framing.fill_w / GROUP_MAX_FILL_W,
                framing.fill_h / GROUP_MAX_FILL_H)
    if ratio <= 1.0:
        return None
    return r_now * ratio


def fix_from_telemetry(
    telemetry: Optional[Dict[str, Any]]
) -> Optional[Tuple[float, float]]:
    """
    (lat, lon) when the position solution is good enough to difference, else
    None.

    This reads the RAW telemetry snapshot rather than the CameraPose the rest
    of the vision layer works from, because pose_from_telemetry keeps only
    altitude and attitude - it has no reason to carry a position. So the fix
    was already arriving at every follow module every frame and being thrown
    away one layer above this one.

    The quality gate is not decoration. Differencing two positions turns any
    wander in the solution into apparent travel, so a marginal fix would spend
    the widen budget while the aircraft hovers, and the aircraft would give up
    on a group it was successfully framing.
    """
    if not telemetry:
        return None
    gps = telemetry.get("gps") or {}
    if int(gps.get("fix_type") or 0) < _MIN_FIX_TYPE:
        return None
    if int(gps.get("satellites_visible") or 0) < _MIN_SATS:
        return None
    pos = telemetry.get("position") or {}
    lat = pos.get("latitude_deg")
    lon = pos.get("longitude_deg")
    if lat is None or lon is None:
        return None
    if lat == 0.0 and lon == 0.0:
        # Null Island. A zeroed PositionData is the dataclass default, not a
        # reading, and it is indistinguishable from one off the coast of Ghana.
        return None
    return float(lat), float(lon)


@dataclass
class WidenBudget:
    """
    How much of the widen allowance has been spent, and - the part the operator
    needs - WHICH bound is actually in force.

    Reported rather than kept internal for the same reason limit_climb reports
    that it cannot enforce the ceiling without an AGL reading: "we are bounding
    this by time because there is no GPS" is a fact about how much the aircraft
    is being trusted with, and silence about it reads as the tighter bound
    being in force when it is not.
    """
    by: str                       # "distance" | "time"
    spent_m: Optional[float]
    spent_s: float
    exhausted: bool

    def describe(self) -> str:
        if self.by == "distance":
            return (f"widened {self.spent_m:.0f} m of the "
                    f"{GROUP_WIDEN_LIMIT_M:.0f} m allowed")
        return (f"widened for {self.spent_s:.0f}s of {GROUP_GIVE_UP_S:.0f}s "
                f"- no usable GPS fix, so this is bounded by time, not distance")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "by": self.by,
            "spent_m": None if self.spent_m is None else round(self.spent_m, 1),
            "limit_m": GROUP_WIDEN_LIMIT_M,
            "spent_s": round(self.spent_s, 1),
            "limit_s": GROUP_GIVE_UP_S,
            "exhausted": self.exhausted,
        }


@dataclass
class GroupState:
    """
    Everything group follow keeps between frames. Held in the session state
    dict rather than on the analyzer, because two clients following different
    groups must not share a latch.
    """
    latch: GroupLatch = field(default_factory=GroupLatch)
    #: When widening began without succeeding. 0.0 = not currently struggling.
    struggling_since: float = 0.0
    #: Where the aircraft was when this widen began, if it was knowable.
    widen_origin: Optional[Tuple[float, float]] = None

    def note(
        self,
        action: GroupAction,
        now: float,
        fix: Optional[Tuple[float, float]] = None,
    ) -> None:
        if action != GroupAction.WIDEN:
            self.struggling_since = 0.0
            self.widen_origin = None
            return
        if self.struggling_since == 0.0:
            self.struggling_since = now
            self.widen_origin = fix
        elif self.widen_origin is None and fix is not None:
            # A fix that arrived mid-widen. The origin is stamped HERE rather
            # than backdated, so the distance measured is one the aircraft
            # actually flew under observation - crediting it with the metres it
            # covered while the fix was unusable would be inventing them.
            self.widen_origin = fix

    def struggling_for(self, now: float) -> float:
        if self.struggling_since == 0.0:
            return 0.0
        return max(0.0, now - self.struggling_since)

    def budget(
        self, now: float, fix: Optional[Tuple[float, float]] = None
    ) -> WidenBudget:
        """
        Distance when it can be measured, time when it cannot.

        The fallback is not a lesser version of the same bound - it is a
        different and looser one, which is exactly why it has to be named in
        the payload rather than substituted quietly.
        """
        spent_s = self.struggling_for(now)
        if self.widen_origin is not None and fix is not None:
            spent_m = haversine_m(*self.widen_origin, *fix)
            return WidenBudget(
                by="distance", spent_m=spent_m, spent_s=spent_s,
                exhausted=spent_m >= GROUP_WIDEN_LIMIT_M,
            )
        return WidenBudget(
            by="time", spent_m=None, spent_s=spent_s,
            exhausted=spent_s > GROUP_GIVE_UP_S,
        )

    def has_given_up(
        self, now: float, fix: Optional[Tuple[float, float]] = None
    ) -> bool:
        return self.budget(now, fix).exhausted

    def reset(self) -> None:
        self.latch.reset()
        self.struggling_since = 0.0
        self.widen_origin = None


def should_retire(seconds_missing: float, has_durable_id: bool) -> bool:
    """
    Drop a member who has been missing this long?

    A member WITHOUT a durable identity is retired on the same clock as one
    with it, deliberately. It is tempting to keep the anonymous one longer -
    there is no other way to find them again - but that has it backwards: an
    anonymous member is precisely the one that can never be re-bound, so
    waiting is not patience, it is a group that stays crippled forever. The one
    with a durable id is the one that can still come back, and it gets the same
    window because within it, re-binding does not need this function at all.
    """
    return seconds_missing > MEMBER_RETIRE_S


def clamp_members(members: Sequence[int]) -> List[int]:
    """De-duplicate preserving order, then cap. members[0] stays the primary,
    which is what every single-subject code path downstream still keys off."""
    seen: List[int] = []
    for m in members:
        mi = int(m)
        if mi not in seen:
            seen.append(mi)
    return seen[:MAX_FOLLOW_MEMBERS]

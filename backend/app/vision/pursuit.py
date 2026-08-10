"""
Pursuit policy: the chase fallback and the reacquisition ladder.
================================================================

Two behaviours that share one idea — DEGRADE VISIBLY, NEVER SILENTLY. Both
failures this module handles (a target outrunning the drone, a target
disappearing) end with the drone doing something autonomous while nobody is
sure whether it still has the right subject. So every state here is named,
reported, and bounded in time.

AUTO-ELEVATE IS AN EXCEPTION PATH, NOT A MODE
    It fires only when a locked target is genuinely outpacing the airframe.
    Climbing widens the ground footprint, which is the only way a fixed-mount
    camera can keep a faster target in frame — it cannot simply look further
    ahead the way a gimbal would.

    Bounded by TWO independent ceilings, because they fail differently and the
    operator has to be told which one was hit:

      max_altitude_agl_m   A LEGAL stop. DGCA is 120 m. Reaching it means the
                           drone must not climb regardless of what it costs.
      max_depression_deg   A RECOGNITION stop. Past this the camera is looking
                           too steeply down for a face to be a face or a plate
                           to be readable. Still flying, analytics worthless.

REACQUISITION IS AN ESCALATING LADDER
    Coast, then re-identify, then widen, then admit it. The timings matter far
    less than the ordering: reacting instantly to a two-frame occlusion loses
    more locks than it saves, because most losses are a pole or a passing
    truck and resolve on their own.
"""
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("verocore.vision.pursuit")


class LockState(str, Enum):
    """
    What the operator sees. The distinction between COASTING and SEARCHING is
    the important one: in the first the drone still believes it knows where the
    target is, in the second it is guessing. Collapsing them into one
    "tracking" flag is what leaves someone unsure whether the drone is still
    following the right person.
    """
    IDLE = "idle"
    LOCKED = "locked"        # target visible right now
    COASTING = "coasting"    # briefly hidden, prediction still trusted
    SEARCHING = "searching"  # actively hunting near the last known position
    LOST = "lost"            # given up, holding position, operator informed


# Ladder boundaries, in seconds since the target was last actually seen.
#
# COAST: most occlusions are a pole, a tree, or a passing vehicle. Doing
# nothing visible for the first stretch resolves them without the drone
# reacting to noise.
COAST_UNTIL_S = 1.5
# RE-ID: appearance matching against the remembered target. For a vehicle a
# re-read plate is an identity, not a guess; for a person a re-matched face
# embedding is the same.
REID_UNTIL_S = 5.0
# WIDEN: climb and sweep. Only now does the drone change what it is doing.
WIDEN_UNTIL_S = 15.0
# Past WIDEN_UNTIL_S -> LOST. Hold position and report; do not wander.


@dataclass
class PursuitLimits:
    """Operator-adjustable per mission, unlike the camera calibration which is
    a fixed property of the rig."""
    max_altitude_agl_m: float = 120.0
    # The counterpart to the ceiling, and the one that was missing. See
    # limit_descent for what its absence actually cost.
    min_altitude_agl_m: float = 1.0
    max_depression_deg: float = 70.0
    # Climb rate while elevating, m/s. Gentle: a fast climb changes scale
    # quickly and costs the tracker its size reference.
    climb_rate_m_s: float = 1.2
    # Fraction of the airframe's top speed at which the target counts as
    # outpacing us. Below 1.0 so the climb starts BEFORE the target is gone,
    # rather than after — by the time forward speed is saturated the gap is
    # already opening.
    outpaced_fraction: float = 0.85

    @classmethod
    def from_settings(cls) -> "PursuitLimits":
        """Reads the EFFECTIVE values, so a ceiling an operator set for this
        mission is honoured rather than the deploy-time default."""
        from app.vision.calibration import effective
        cal = effective()
        return cls(
            max_altitude_agl_m=cal["max_altitude_agl_m"],
            min_altitude_agl_m=cal["min_altitude_agl_m"],
            max_depression_deg=cal["max_depression_deg"],
        )


@dataclass
class ElevateDecision:
    """Why the drone is or is not climbing. `reason` is meant for the operator,
    not the log — a climb the pilot cannot explain is a climb they will fight."""
    climb_m_s: float          # NED: negative is UP
    elevating: bool
    blocked_by: Optional[str] = None
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "elevating": self.elevating,
            "climb_m_s": round(self.climb_m_s, 2),
            "blocked_by": self.blocked_by,
            "reason": self.reason,
        }


def decide_elevation(
    *,
    target_outpacing: bool,
    agl_m: Optional[float],
    depression_deg: Optional[float],
    limits: PursuitLimits,
) -> ElevateDecision:
    """
    Should the drone climb to keep a faster target in frame?

    Returns a decision even when the answer is no, carrying the reason. A bare
    "0.0 m/s" tells an operator nothing about whether the system considered
    climbing and declined, or never noticed the target pulling away.
    """
    if not target_outpacing:
        return ElevateDecision(0.0, False, reason="target within reach")

    # Unknown altitude is not permission to climb. Without AGL neither ceiling
    # can be enforced, and an unbounded autonomous climb is the one outcome
    # that must be impossible.
    if agl_m is None:
        return ElevateDecision(
            0.0, False, blocked_by="no_altitude",
            reason="target outpacing us, but AGL is unknown — refusing to climb blind",
        )

    if agl_m >= limits.max_altitude_agl_m:
        return ElevateDecision(
            0.0, False, blocked_by="altitude_cap",
            reason=(f"at the {limits.max_altitude_agl_m:.0f} m ceiling — "
                    f"cannot climb further; target will be lost"),
        )

    # The recognition ceiling. Hitting this means the drone could legally climb
    # but the analytics have already stopped being usable, which the operator
    # needs told rather than discovering from unreadable output.
    if depression_deg is not None and depression_deg >= limits.max_depression_deg:
        return ElevateDecision(
            0.0, False, blocked_by="depression_cap",
            reason=(f"looking down at {depression_deg:.0f}deg "
                    f"(cap {limits.max_depression_deg:.0f}deg) — climbing further "
                    f"would make faces and plates unreadable"),
        )

    # Ease off approaching the ceiling so the drone settles at the cap instead
    # of slamming into it and bouncing.
    headroom = limits.max_altitude_agl_m - agl_m
    rate = limits.climb_rate_m_s * min(1.0, headroom / 10.0) if headroom < 10.0 \
        else limits.climb_rate_m_s
    return ElevateDecision(
        -abs(rate), True,          # NED: negative is up
        reason=(f"target outpacing us — climbing at {rate:.1f} m/s to widen "
                f"the footprint ({headroom:.0f} m of headroom)"),
    )


def is_outpaced(
    commanded_forward_m_s: float,
    max_speed_m_s: float,
    limits: PursuitLimits,
    target_growing_distance: bool = True,
) -> bool:
    """
    Is the target pulling away?

    Requires BOTH a near-saturated forward command and the distance actually
    increasing. Saturation alone is not enough — a drone accelerating hard from
    a standstill is briefly at full command while closing, and climbing then
    would be exactly wrong.
    """
    if max_speed_m_s <= 0:
        return False
    saturated = commanded_forward_m_s >= max_speed_m_s * limits.outpaced_fraction
    return bool(saturated and target_growing_distance)


def lock_state_for(
    *, visible: bool, seconds_lost: float, tracking: bool
) -> Tuple[LockState, str]:
    """
    Map "how long since we saw it" onto a named state plus operator-facing text.

    Deliberately a pure function of elapsed time: the state shown must not
    depend on how many frames happened to be processed, which varies with load.
    """
    if not tracking:
        return LockState.IDLE, ""
    if visible:
        return LockState.LOCKED, ""
    if seconds_lost <= COAST_UNTIL_S:
        # Nothing visible changes here on purpose — see the module docstring.
        return LockState.COASTING, f"briefly hidden ({seconds_lost:.1f}s)"
    if seconds_lost <= REID_UNTIL_S:
        return LockState.SEARCHING, f"re-identifying ({seconds_lost:.1f}s)"
    if seconds_lost <= WIDEN_UNTIL_S:
        return LockState.SEARCHING, f"widening search ({seconds_lost:.1f}s)"
    return LockState.LOST, f"lost {seconds_lost:.0f}s ago — holding position"


def should_widen_search(seconds_lost: float) -> bool:
    """True only in the third rung. Climbing to search earlier reacts to
    occlusions that would have resolved themselves."""
    return REID_UNTIL_S < seconds_lost <= WIDEN_UNTIL_S


def has_given_up(seconds_lost: float) -> bool:
    return seconds_lost > WIDEN_UNTIL_S


# Width of the easing band above the floor. Descent is scaled down across it
# so the aircraft settles onto the floor rather than arriving at full rate and
# stopping dead, which reads as a bounce and upsets the position controller.
_DESCENT_TAPER_M = 1.5


def limit_descent(
    down_m_s: float,
    agl_m: Optional[float],
    limits: PursuitLimits,
) -> Tuple[float, Optional[str]]:
    """
    Clamp a commanded DESCENT so tracking cannot fly the aircraft into terrain.
    Returns (allowed_down_m_s, reason_if_limited).

    THIS EXISTS BECAUSE ITS ABSENCE CRASHED A SITL FLIGHT.
    Every tracking mode could command descent without bound — decide_elevation
    enforced a ceiling and there was no floor anywhere in the codebase. A
    vehicle-follow run held a sustained +0.5 m/s descent for twelve seconds,
    took the aircraft 6.6m -> 2.5m -> 0m, and PX4 finished with "invalid
    setpoints / Failsafe: blind land". Nothing in the loop objected, because
    from the controller's point of view descending was simply how you get the
    subject where you want it in frame.

    Only DESCENT is limited here. limit_climb is the counterpart, and the two
    are kept apart because the bound each enforces is a different KIND of bound
    — terrain versus airspace law — and the operator has to be told which.

    Unknown AGL blocks descent entirely — the same stance decide_elevation
    takes on climbing blind, for the same reason: without a height reading
    neither bound can be enforced, and of the two possible mistakes, refusing
    to descend is the recoverable one.
    """
    if down_m_s <= 0.0:
        return down_m_s, None          # climbing or level — not this function's job

    if agl_m is None:
        return 0.0, ("no AGL reading — refusing to descend blind")

    floor = limits.min_altitude_agl_m
    if agl_m <= floor:
        return 0.0, (f"at the {floor:.1f} m altitude floor — descent blocked")

    headroom = agl_m - floor
    if headroom < _DESCENT_TAPER_M:
        eased = down_m_s * (headroom / _DESCENT_TAPER_M)
        return eased, (f"{headroom:.1f} m above the {floor:.1f} m floor — "
                       f"descent eased to {eased:.2f} m/s")
    return down_m_s, None


#: Easing band below the ceiling, mirroring _DESCENT_TAPER_M.
_CLIMB_TAPER_M = 1.5


def limit_climb(
    down_m_s: float,
    agl_m: Optional[float],
    limits: PursuitLimits,
) -> Tuple[float, Optional[str]]:
    """
    Clamp a commanded CLIMB against max_altitude_agl_m. NED, so a climb is
    negative. Returns (allowed_down_m_s, reason_if_limited).

    THE GAP THIS CLOSES. decide_elevation enforces the ceiling on the climbs IT
    decides — auto-elevate, the chase fallback — and every module applied
    limit_descent to catch descent from any source. Nothing enforced the ceiling
    on a climb from any OTHER source, and there is one: the operator's ▲ nudge
    in Fixed altitude mode, which reaches down_m_s having passed through no
    altitude check whatsoever. Held down, it climbs through 120 m without a word.

    So the guard belongs here, at the same single convergence point the floor
    uses, rather than inside the one climb source that already had it. The
    overlap with decide_elevation is harmless: it eases over 10 m of headroom
    and this eases over 1.5, so for auto-elevate this is a near no-op that only
    ever tightens.

    UNKNOWN AGL PASSES THROUGH, WHICH IS THE OPPOSITE OF WHAT limit_descent
    DOES, and the asymmetry is deliberate. decide_elevation ALREADY refuses to
    climb without an AGL reading, so the only climb that can reach here blind is
    the operator's held ▲ — a deliberate, human-in-the-loop command from someone
    watching their own altitude readout. Zeroing it would kill a manual control
    outright in exchange for a ceiling we cannot measure anyway, whereas the
    descent guard is protecting against an AUTONOMOUS descent nobody asked for,
    where the failure is immediate and destroys the aircraft. The reason is
    still reported, so "the ceiling is not being enforced" reaches the operator
    rather than being assumed.
    """
    if down_m_s >= 0.0:
        return down_m_s, None          # descending or level — not this function's job

    if agl_m is None:
        return down_m_s, ("no AGL reading — altitude ceiling is not being enforced")

    ceiling = limits.max_altitude_agl_m
    if agl_m >= ceiling:
        return 0.0, (f"at the {ceiling:.0f} m altitude ceiling — climb blocked")

    headroom = ceiling - agl_m
    if headroom < _CLIMB_TAPER_M:
        eased = down_m_s * (headroom / _CLIMB_TAPER_M)
        return eased, (f"{headroom:.1f} m below the {ceiling:.0f} m ceiling — "
                       f"climb eased to {abs(eased):.2f} m/s")
    return down_m_s, None


# --------------------------------------------------------------------------- #
# FIXED-ALTITUDE RANGING: the frame row, not apparent size                     #
# --------------------------------------------------------------------------- #
#
# At a HELD altitude, with a camera bolted to the airframe looking downward,
# the row a subject's FEET occupy in the frame is a direct and monotonic
# measure of horizontal range. Further away is higher up the frame; closer is
# lower down. With altitude fixed there is nothing else in the geometry left
# free to move, so the row IS the range signal — and apparent size, which was
# driving this axis, is a far worse one for the job.
#
# THIS NEEDS NO CAMERA ANGLE, NO FIELD OF VIEW AND NO SUBJECT HEIGHT.
# Every one of those would only put a SCALE on the response, and the PD gain
# already does that. The SIGN — the whole question of forward versus back —
# follows from the single fact that the camera points downward at all. So this
# path keeps working on a rig nobody has calibrated, which the size path does
# not: size ranging needs the mount tilt to de-foreshorten and the subject's
# real height to mean anything.
#
# WHY THE FEET AND NOT THE BOX CENTRE. A box centre floats at half the
# subject's height, so it climbs the frame as the subject draws nearer and the
# box grows taller — putting range error into the very signal that is supposed
# to measure range. The bottom edge sits on the ground plane and does not move
# for any reason except the subject's actual position.

#: Rows above this are too near the horizon for the row to mean a finite
#: distance: a pixel of noise there is tens of metres of range. A target row is
#: clamped down to it, so locking a subject in the top of the frame closes in
#: to here rather than trying to hold an unbounded distance.
_ROW_TARGET_MIN = 0.18
#: Kept clear of _ROW_FOOT_OFF_FRAME so a legal target row is always one whose
#: error can actually be measured.
_ROW_TARGET_MAX = 0.92
#: At or past this the ground contact has left the bottom of the frame, so the
#: subject is bottom-truncated, h_ema understates their height, and foot_row
#: understates how close they are. With a downward camera that only happens
#: when they are nearly underneath the aircraft.
_ROW_FOOT_OFF_FRAME = 0.985
#: What to report while the feet are off-frame: a definite, bounded "back off"
#: — clear of any sane deadband, small enough not to lurch.
_ROW_TRUNCATED_ERROR = -0.08
#: One press of CLOSER / FURTHER, in frame heights.
ROW_NUDGE_STEP = 0.05
#: Below this the altitude counts as held and the row reference stays valid.
ROW_REFERENCE_HOLD_EPS_M_S = 0.05


def foot_row(centre_row_n: float, height_ratio: float) -> float:
    """
    Normalised row of the subject's ground contact, built from the two smoothed
    quantities every follow module already keeps: the Kalman-filtered box centre
    and the EMA-filtered box height. Reusing those rather than the raw bottom
    edge keeps this as quiet as the signals feeding it.
    """
    return centre_row_n + height_ratio / 2.0


def clamp_row_target(row_n: float) -> float:
    """Hold a target row inside the band where it means a measurable distance."""
    return min(_ROW_TARGET_MAX, max(_ROW_TARGET_MIN, row_n))


def frame_row_range_error(foot_row_n: float, target_row_n: float) -> float:
    """
    Range error for the Fixed-altitude forward axis, in frame heights.

    POSITIVE means the subject sits ABOVE the row we want them on — further away
    than wanted, so move FORWARD. NEGATIVE means they have dropped below it —
    too close, so move BACK. Deliberately the same sign convention as
    range_error_ratio, so one distance PD reads either source the same way up
    and the two are interchangeable at the call site.
    """
    if foot_row_n >= _ROW_FOOT_OFF_FRAME:
        # Ground contact is off the bottom of the frame. The row error is not
        # measurable, and the ONE thing we know is that the subject is very
        # close, so this must never be allowed to read as "far" and command
        # forward — which is exactly what an understated foot_row would do.
        return _ROW_TRUNCATED_ERROR
    return target_row_n - foot_row_n


def row_reference_is_stale(altitude_mode: str, down_m_s: float) -> bool:
    """
    Does the target row need re-taking?

    Row ranging assumes a HELD altitude — that is its entire premise. The
    moment the aircraft moves vertically, from an operator nudge or from
    auto-elevate, the map from row to range changes underneath the reference and
    the subject appears to move without having moved. Climbing makes the
    depression steeper, drops the subject down the frame, and reads as "too
    close" — so an uncorrected reference would command a RETREAT during exactly
    the climb auto-elevate ordered to chase something pulling away.

    Re-taking the row while altitude is moving costs nothing and fixes it: the
    forward axis goes quiet for the duration (its error is zero by
    construction), and the reference that resumes afterwards describes the same
    RANGE at the new height. The operator's chosen follow distance survives a
    climb without anyone having to store it.
    """
    return altitude_mode != "auto" and abs(down_m_s) > ROW_REFERENCE_HOLD_EPS_M_S


def new_row_pd():
    """
    The Fixed-altitude distance PD, built here so all five follow modules get
    the same one.

    Error is in FRAME HEIGHTS, which is why this cannot share an instance with
    the size-based dist_pd: the two carry derivatives in unrelated units and
    swapping between them mid-flight would kick. kp=8 reaches full speed at
    ~0.31 of a frame height of error. deadband=0.025 is ~27 px at 1080p, tight
    because a row is a position and far quieter than a box height.

    The row->range map is left deliberately un-linearised. Near the top of the
    frame a small row change is a large distance change and near the bottom the
    reverse, so the response is firm when the subject is far and gentle when
    they are close — which is what you would tune for by hand anyway.
    """
    from app.vision.controllers import PDController
    return PDController(kp=8.0, kd=1.5, max_output=2.5, deadband=0.025)


def distance_axis(
    *,
    state: Dict[str, Any],
    altitude_mode: str,
    foot_row_n: float,
    size_range_error: float,
) -> Tuple[float, float]:
    """
    The forward/back command before yaw priority, plus the error that produced
    it — choosing whichever sensor the current altitude mode makes honest.

    FIXED  -> the frame row. Height is held, so the row the subject's feet sit
              on is horizontal range and nothing else.
    AUTO   -> apparent size, unchanged. Height is a free variable there, so the
              row is not a range signal.

    Shared rather than copied into each module because the five had already
    drifted apart once — one of them still computes its size error as a raw fill
    difference where the rest use a fraction of range — and *which sensor owns
    the forward axis* is not a thing that should be able to differ between them.

    Seeds target_row from the subject on first use. A row nobody has observed
    cannot be known to be reachable; see clamp_row_target.
    """
    if altitude_mode == "auto":
        return state["dist_pd"].compute(size_range_error), size_range_error
    if state.get("target_row") is None:
        state["target_row"] = clamp_row_target(foot_row_n)
    err = frame_row_range_error(foot_row_n, state["target_row"])
    return state["row_pd"].compute(err), err


def scale_forward(forward_raw: float, yaw_factor: float, altitude_mode: str) -> float:
    """
    Apply yaw priority — to a FORWARD command only.

    Yaw priority exists to stop the aircraft charging at a subject it has not
    centred yet. A subject too CLOSE is the one case where the drone should be
    leaving at full authority, and scaling the retreat by the same factor made
    it back away slowest exactly when it was nearest and most off-axis.

    Auto keeps the old symmetric expression, because Auto is flying well and a
    change to how it retreats is not part of fixing Fixed.
    """
    if forward_raw > 0 or altitude_mode == "auto":
        return forward_raw * yaw_factor
    return forward_raw

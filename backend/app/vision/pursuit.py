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
from typing import Optional, Tuple

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

    Only DESCENT is limited. Climbing has its own, separate ceiling in
    decide_elevation, and clamping both here would silently duplicate it.

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

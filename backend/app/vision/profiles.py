"""
Capability profiles — spend the frame budget on what the optics can deliver.
============================================================================

viability.py answers "is this subject resolvable right now?". This module acts
on that answer: it decides which analytics traffic-management should ATTEMPT on
this frame, and hands back the freed budget so the ones that CAN work run
harder.

WHY THIS IS NOT AN ALTITUDE TABLE
    The obvious implementation is a ladder of heights — plates below 8m, crowd
    above 25m. It would work today and be wrong forever after, because the
    numbers in it are not properties of the job. They are properties of THIS
    lens on THIS sensor.

    Fit a 4K sensor and every one of those constants is off by a factor of two,
    silently, in the unsafe direction: the mode would refuse to read plates at
    a range where they are perfectly legible. Fit a narrower lens and it is
    wrong again by a different factor.

    So the currency here is PIXELS ON TARGET, computed from the calibrated lens
    and the measured slant range. A resolution or lens change moves the ranges
    on its own, with no constant to update and nothing to remember —

        plate readable to   6.9 m  at 1080p / 70deg
        plate readable to  13.7 m  at 4K    / 70deg
        plate readable to  19.6 m  at 4K    / 50deg

    all out of the same expression. That is the whole reason this is written
    against pixels.

WHAT IT ACTUALLY BUYS
    Face recognition needs a subject far closer than plate OCR does (a 230mm
    face vs a 500mm plate, for the same 100px), so from any real drone standoff
    faces are out of range essentially always. Detecting that and skipping the
    model is not a small saving — it is most of the optional per-frame cost,
    reclaimed on nearly every frame, and spent on the plate reads that are
    actually achievable.

HYSTERESIS, BECAUSE ALTITUDE IS NOISY
    A drone holding station still breathes a metre or two, and barometric AGL
    adds its own noise. A bare threshold on top of that flaps — OCR switching
    on and off frame to frame, which both wastes the calls it does make and
    makes the readout untrustworthy to watch. A subject therefore has to clear
    the bar to switch ON and fall well below it to switch OFF.
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger("verocore.vision.profiles")

# Subjects whose analytic is optional per-frame work that can be skipped.
# vehicle/person are NOT here: they come from the single YOLO pass this module
# is built around, so there is no budget to reclaim by skipping them, and
# skipping them would leave the mode with nothing to track.
_GATED = ("plate", "face")

# Measured on this hardware — see the traffic_manager docstring.
# fast-alpr letterboxes to 384x384, so a call costs the same whatever it is
# given: the budget is a COUNT OF CALLS, not an area.
_COST_MS = {
    "plate": 14.7,   # one fast-alpr call
    "face": 7.6,     # one check, up to 2 person crops at ~3.8ms each
}

# Fallback per-frame budget for OPTIONAL analytics, on top of detection and
# speed. Overridden by settings.traffic_optional_budget_ms — see the note
# there for why it is deliberately generous rather than sized to hold 30fps.
_DEFAULT_BUDGET_MS = 45.0

# Hysteresis. A subject switches ON at its marginal requirement and OFF only
# once it falls this far below it — wide enough to swallow altitude jitter,
# narrow enough that a genuine climb still turns it off promptly.
_OFF_FRACTION = 0.85

# Ceiling on OCR calls per frame however much budget is free: past this the
# calls start landing on the same vehicles within one frame and stop buying
# new information.
_MAX_OCR_CALLS = 3


@dataclass
class SubjectDecision:
    subject: str
    attempt: bool
    status: str            # the viability status that drove this
    px_on_target: float
    px_needed: float
    reason: str
    forced: bool = False   # operator override, not geometry

    def to_dict(self) -> dict:
        return {
            "subject": self.subject,
            "attempt": self.attempt,
            "status": self.status,
            "px_on_target": round(self.px_on_target, 1),
            "px_needed": round(self.px_needed, 1),
            "reason": self.reason,
            "forced": self.forced,
        }


@dataclass
class Profile:
    """What this frame should attempt, and how much of it."""
    name: str
    label: str
    subjects: Dict[str, SubjectDecision] = field(default_factory=dict)
    ocr_calls: int = 0
    faces: bool = False
    headline: str = ""

    def attempting(self, subject: str) -> bool:
        d = self.subjects.get(subject)
        return bool(d and d.attempt)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "ocr_calls": self.ocr_calls,
            "faces": self.faces,
            "headline": self.headline,
            "subjects": [d.to_dict() for d in self.subjects.values()],
        }


def _name_for(plate: bool, face: bool) -> tuple:
    """Profiles are NAMED so an operator can learn them, but the name is a
    label on the decision rather than an input to it — nothing branches on
    these strings."""
    if face and plate:
        return "forensic", "Forensic — plates + faces"
    if plate:
        return "identify", "Identify — plates"
    return "survey", "Survey — count, track, speed"


class ProfileSelector:
    """
    Per-session. Holds only the hysteresis latch, so two clients at different
    altitudes cannot pull each other's profile around.
    """

    def __init__(self) -> None:
        self._on: Dict[str, bool] = {s: False for s in _GATED}
        self._last_name: Optional[str] = None

    def _latch(self, subject: str, px: float, needed: float) -> bool:
        """ON at the requirement, OFF only once well below it."""
        if needed <= 0:
            return self._on[subject]
        if self._on[subject]:
            self._on[subject] = px >= needed * _OFF_FRACTION
        else:
            self._on[subject] = px >= needed
        return self._on[subject]

    def select(
        self,
        viability_items: List[dict],
        *,
        overrides: Optional[Dict[str, str]] = None,
        alpr_available: bool = True,
        faces_available: bool = True,
        budget_ms: Optional[float] = None,
    ) -> Profile:
        """
        `viability_items` are viability.SubjectViability.to_dict() entries.
        `overrides` maps a subject to "auto" | "on" | "off".
        """
        overrides = overrides or {}
        by_subject = {i["subject"]: i for i in viability_items}
        decisions: Dict[str, SubjectDecision] = {}

        available = {"plate": alpr_available, "face": faces_available}

        for subject in _GATED:
            item = by_subject.get(subject)
            mode = str(overrides.get(subject, "auto")).lower()

            if not available.get(subject, True):
                self._on[subject] = False
                decisions[subject] = SubjectDecision(
                    subject=subject, attempt=False, status="unavailable",
                    px_on_target=0.0, px_needed=0.0,
                    reason=f"{subject} model not loaded",
                )
                continue

            if item is None:
                # No viability entry at all — attempt rather than silently
                # disable an analytic for a reason nobody can see.
                decisions[subject] = SubjectDecision(
                    subject=subject, attempt=True, status="unknown",
                    px_on_target=0.0, px_needed=0.0,
                    reason="no viability reading — attempting anyway",
                )
                continue

            px = float(item.get("px_on_target") or 0.0)
            needed = float(item.get("px_needed_marginal") or 0.0)
            status = str(item.get("status") or "unknown")

            if mode == "on":
                self._on[subject] = True
                decisions[subject] = SubjectDecision(
                    subject=subject, attempt=True, status=status,
                    px_on_target=px, px_needed=needed, forced=True,
                    reason=f"forced on by operator ({px:.0f}px on target)",
                )
                continue
            if mode == "off":
                self._on[subject] = False
                decisions[subject] = SubjectDecision(
                    subject=subject, attempt=False, status=status,
                    px_on_target=px, px_needed=needed, forced=True,
                    reason="switched off by operator",
                )
                continue

            if status == "unknown":
                # No telemetry means no range, which is NOT the same as out of
                # range. Fail open: refusing to read plates on a bench with no
                # GPS lock would look exactly like a broken plate reader, and
                # that has already cost this project a debugging session.
                decisions[subject] = SubjectDecision(
                    subject=subject, attempt=True, status=status,
                    px_on_target=px, px_needed=needed,
                    reason="no altitude — attempting anyway",
                )
                continue

            on = self._latch(subject, px, needed)
            if on:
                reason = f"{px:.0f}px on target, needs {needed:.0f}"
            else:
                reason = (f"{px:.0f}px on target, needs {needed:.0f} — "
                          f"skipped, budget spent elsewhere")
            decisions[subject] = SubjectDecision(
                subject=subject, attempt=on, status=status,
                px_on_target=px, px_needed=needed, reason=reason,
            )

        plate_on = decisions["plate"].attempt
        face_on = decisions["face"].attempt

        # Budget. Faces are reserved first because that analytic is all-or-
        # nothing per frame, whereas OCR degrades gracefully by making fewer
        # calls. Whatever faces do not take goes to plate reading.
        remaining = _DEFAULT_BUDGET_MS if budget_ms is None else float(budget_ms)
        if face_on:
            remaining -= _COST_MS["face"]
        ocr_calls = 0
        if plate_on:
            ocr_calls = max(1, int(remaining // _COST_MS["plate"]))
            ocr_calls = min(ocr_calls, _MAX_OCR_CALLS)

        name, label = _name_for(plate_on, face_on)
        skipped = [s for s in _GATED if not decisions[s].attempt
                   and decisions[s].status not in ("unavailable",)]
        headline = ""
        if skipped:
            # "Nearest" means nearest to being ACHIEVABLE, so rank by the
            # fraction of the requirement already met, not by the pixel gap.
            # A raw gap is not comparable across subjects of different physical
            # size: at 50m a plate sits 56px short and a face 54px short, which
            # would nominate the face — yet the plate needs half the descent,
            # because a 500mm plate and a 230mm face do not gain pixels at the
            # same rate. The fraction is scale-free and orders identically to
            # viability.summarise's max_range, so both readouts agree.
            nearest = max(
                (decisions[s] for s in skipped),
                key=lambda d: (d.px_on_target / d.px_needed) if d.px_needed else 0.0,
            )
            headline = (
                f"{', '.join(skipped)} out of range — "
                f"{nearest.subject} needs {nearest.px_needed:.0f}px, "
                f"has {nearest.px_on_target:.0f}px"
            )

        if name != self._last_name:
            logger.info(
                f"profile -> {name} (ocr_calls={ocr_calls}, faces={face_on})"
                + (f"; {headline}" if headline else "")
            )
            self._last_name = name

        return Profile(
            name=name, label=label, subjects=decisions,
            ocr_calls=ocr_calls, faces=face_on, headline=headline,
        )

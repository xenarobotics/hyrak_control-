"""
What can this altitude actually deliver?
========================================

Every analytic needs a minimum number of pixels on its subject. Given the
calibrated lens and the current height, that requirement becomes a range - and
outside it the honest answer is "too far", not a guess.

WHY THIS MODULE EXISTS
    Left unchecked, plate OCR at 45 pixels does not fail. It returns
    WA01WMWH, then WA02MM901, then WA12MMSH for the same car, and reads
    SUBSCRIBE off a video overlay. Guards in the reader now reject those, but
    rejection alone leaves an operator staring at a mode that appears broken.

    The useful thing is to say WHY: at this altitude a plate is 22 px across and
    needs 100, so descend to 12 m or accept that plates will not read. That
    turns an apparent malfunction into a flight decision.

    It is also the honest way to offer one mode covering every analytic. The
    five requirements do not share an altitude - plates want low and oblique,
    crowd counting wants high and near-nadir, faces want close and frontal. A
    module claiming all five simultaneously would be lying. A module that runs
    all five and reports which are IN RANGE right now is telling the truth.

PIXELS ON TARGET IS THE ONLY CURRENCY
    Requirements are expressed as "px across the subject" rather than as
    altitudes, because that is what is actually model-dependent. Convert with
    the calibrated lens and the answer follows for any camera.
"""
import math
from dataclasses import dataclass
from typing import Dict, List, Optional

# subject -> (physical size in metres, px needed for GOOD, px for MARGINAL)
#
# The plate floor matches _PLATE_MIN_WIDTH_PX in traffic_manager: 70px is where
# OCR stops inventing. 100 is where it is comfortable.
_REQUIREMENTS = {
    "vehicle": (4.20, 40, 25, "Vehicle detection, counting, colour"),
    "person": (1.70, 40, 25, "Crowd counting and person tracking"),
    "plate": (0.50, 100, 70, "Number plate OCR"),
    "face": (0.23, 100, 60, "Face recognition"),
}


@dataclass
class SubjectViability:
    subject: str
    label: str
    px_on_target: float
    px_needed_good: int
    px_needed_marginal: int
    status: str          # "good" | "marginal" | "out_of_range"
    max_range_m: float   # slant range at which it would be GOOD
    advice: str

    def to_dict(self) -> dict:
        return {
            "subject": self.subject,
            "label": self.label,
            "px_on_target": round(self.px_on_target, 1),
            "px_needed": self.px_needed_good,
            "px_needed_marginal": self.px_needed_marginal,
            "status": self.status,
            "max_range_m": round(self.max_range_m, 1),
            "advice": self.advice,
        }


def px_per_metre(hfov_deg: float, frame_width_px: int, distance_m: float) -> float:
    """Pixels per metre of subject at a given slant range."""
    if distance_m <= 0 or frame_width_px <= 0:
        return 0.0
    ifov = 2.0 * math.tan(math.radians(hfov_deg) / 2.0) / frame_width_px
    return 1.0 / (distance_m * ifov)


def range_for_px(hfov_deg: float, frame_width_px: int,
                 physical_m: float, px_needed: int) -> float:
    """Slant range at which `physical_m` spans `px_needed` pixels."""
    # frame_width_px <= 0 is not a legal camera, but it IS what a caller
    # passes when it forwards an inference width of 0 meaning "native". That
    # used to divide by zero here - inside the analyzer's worker thread, so
    # the mode produced no metadata at all while the video kept streaming,
    # indistinguishable from a model that finds nothing. Callers resolve 0 to
    # the real frame width now; this refuses rather than crashes if one is
    # ever missed again.
    if px_needed <= 0 or frame_width_px <= 0:
        return 0.0
    ifov = 2.0 * math.tan(math.radians(hfov_deg) / 2.0) / frame_width_px
    return physical_m / (px_needed * ifov)


def assess(
    hfov_deg: float,
    frame_width_px: int,
    slant_range_m: Optional[float],
    *,
    effective_width_px: Optional[Dict[str, int]] = None,
) -> List[SubjectViability]:
    """
    One entry per subject, describing whether it is readable at this range.

    `effective_width_px` lets a caller say which width each subject is ACTUALLY
    analysed at, which is not always the frame width: detection runs on a
    downscaled copy, while plate OCR runs on a per-vehicle crop at native
    resolution. Using the frame width for everything would overstate detection
    and understate plate reading - the two errors that matter most here.
    """
    out: List[SubjectViability] = []
    if not slant_range_m or slant_range_m <= 0:
        # No telemetry: report the requirement without pretending to know range.
        for key, (phys, good, marginal, label) in _REQUIREMENTS.items():
            w = (effective_width_px or {}).get(key, frame_width_px)
            out.append(SubjectViability(
                subject=key, label=label, px_on_target=0.0,
                px_needed_good=good, px_needed_marginal=marginal,
                status="unknown",
                max_range_m=range_for_px(hfov_deg, w, phys, good),
                advice="No altitude - connect telemetry to know what is in range",
            ))
        return out

    for key, (phys, good, marginal, label) in _REQUIREMENTS.items():
        w = (effective_width_px or {}).get(key, frame_width_px)
        px = phys * px_per_metre(hfov_deg, w, slant_range_m)
        good_range = range_for_px(hfov_deg, w, phys, good)

        if px >= good:
            status, advice = "good", ""
        elif px >= marginal:
            status = "marginal"
            advice = (f"{px:.0f}px on target - workable but unreliable; "
                      f"{good_range:.0f}m or closer for a solid read")
        else:
            status = "out_of_range"
            advice = (f"{px:.0f}px on target, needs {good} - "
                      f"descend to about {good_range:.0f}m")
        out.append(SubjectViability(
            subject=key, label=label, px_on_target=px,
            px_needed_good=good, px_needed_marginal=marginal,
            status=status, max_range_m=good_range, advice=advice,
        ))
    return out


def summarise(items: List[SubjectViability]) -> dict:
    """Compact payload for the UI, plus the one-line headline worth showing."""
    usable = [i.subject for i in items if i.status == "good"]
    blocked = [i for i in items if i.status == "out_of_range"]
    headline = ""
    if blocked:
        # Name the nearest thing to fix rather than listing everything wrong:
        # the subject needing the smallest descent is the actionable one.
        nearest = max(blocked, key=lambda i: i.max_range_m)
        headline = (
            f"{', '.join(i.subject for i in blocked)} out of range at this "
            f"altitude - {nearest.subject} needs ~{nearest.max_range_m:.0f}m"
        )
    return {
        "subjects": [i.to_dict() for i in items],
        "usable": usable,
        "headline": headline,
    }

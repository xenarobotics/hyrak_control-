"""
Vehicle colour classification.
==============================

Deliberately not a neural network. Colour is one of the few attributes that
is genuinely a property of the pixels, so a hand-built HSV classifier is
faster, needs no weights, no training set, and - the part that matters
operationally - can explain itself. A CNN that says "silver" gives you
nothing to debug when it says "silver" about a white car.

Kept separate from plate_tracker because the traffic-management module will
want it too.

THE THREE THINGS THAT MAKE THIS HARD FROM A DRONE

  1. The box is not all car. A YOLO box around a vehicle always contains some
     road, and road is grey. Sampling the whole box drags every colour toward
     grey, so only a central inset is used.

  2. Mean colour is meaningless. Averaging a red car's body with its black
     windows gives dark maroon; averaging red and white gives pink. The
     dominant CLUSTER is what identifies a car, so hue is taken as a
     saturation-weighted histogram mode, never a mean.

  3. Lighting moves value far more than saturation. The same car in sun and
     in shade differs hugely in V and only mildly in S, so the
     chromatic/achromatic decision leans on saturation, and the
     white/grey/black split - which unavoidably needs V - is reported with
     lower confidence.
"""
import logging
from typing import Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger("verocore.vision.vehicle_color")

# Hue ranges in OpenCV's 0-179 scale. Red wraps, so it appears at both ends.
_HUE_BANDS = [
    ("red",    0,   8),
    ("orange", 9,   20),
    ("yellow", 21,  33),
    ("green",  34,  77),
    ("cyan",   78,  95),
    ("blue",   96,  130),
    ("purple", 131, 155),
    ("red",    156, 179),
]

# Below this saturation a pixel carries no usable hue - it is white, grey or
# black, and its hue value is numerically unstable noise.
_ACHROMATIC_S_MAX = 55
# Value splits for achromatic pixels. Wide middle band because "silver" and
# "grey" are the same thing under different light.
_BLACK_V_MAX = 65
_WHITE_V_MIN = 175

# HSV saturation is (max-min)/max, so it is UNRELIABLE AT THE EXTREMES OF
# VALUE and this is not a subtle effect. On a black car at V=40, a few levels
# of sensor noise between channels computes as saturation ~95 - well past
# _ACHROMATIC_S_MAX - and the resulting hue is pure noise. Without this gate
# every dark vehicle gets a confident random colour.
#
# The same applies at the top: a specular highlight is white whatever the
# paint underneath, so blown-out pixels are excluded from the hue vote too.
_HUE_VALID_V_MIN = 60
_HUE_VALID_V_MAX = 248

# Fraction of the box kept, centred. 0.5 keeps the middle half in each axis -
# enough pixels to be statistically meaningful, tight enough to exclude the
# road that a vehicle box always includes.
_INSET = 0.5
# Fewer pixels than this and the answer is noise, not a colour.
_MIN_PIXELS = 40


def _body_roi(frame_bgr: np.ndarray, box) -> Optional[np.ndarray]:
    """Central inset of the box - the part most likely to be bodywork."""
    h, w = frame_bgr.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in box]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    bw, bh = x2 - x1, y2 - y1
    if bw <= 2 or bh <= 2:
        return None

    dx = int(bw * (1.0 - _INSET) / 2.0)
    dy = int(bh * (1.0 - _INSET) / 2.0)
    roi = frame_bgr[y1 + dy:y2 - dy, x1 + dx:x2 - dx]
    return roi if roi.size and roi.shape[0] > 1 and roi.shape[1] > 1 else None


def classify_vehicle_color(
    frame_bgr: np.ndarray, box, min_confidence: float = 0.0
) -> Tuple[str, float]:
    """
    Dominant body colour of the vehicle in `box`.

    Returns (name, confidence) where confidence is the fraction of sampled
    pixels agreeing with the verdict. ("unknown", 0.0) when the box is too
    small or too mixed to call - which is the honest answer for a distant
    vehicle, and better than a coin-flip colour attached to a plate record.
    """
    roi = _body_roi(frame_bgr, box)
    if roi is None or roi.shape[0] * roi.shape[1] < _MIN_PIXELS:
        return "unknown", 0.0

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0].astype(np.int32).ravel()
    sat = hsv[:, :, 1].astype(np.int32).ravel()
    val = hsv[:, :, 2].astype(np.int32).ravel()
    total = hue.size

    # A pixel votes on hue only if it is saturated AND its value is in the
    # range where saturation means anything at all - see _HUE_VALID_V_MIN.
    chromatic = (
        (sat > _ACHROMATIC_S_MAX)
        & (val >= _HUE_VALID_V_MIN)
        & (val <= _HUE_VALID_V_MAX)
    )
    n_chromatic = int(np.count_nonzero(chromatic))

    # A car is called coloured only when a real majority of its body pixels
    # carry saturation. Otherwise the few saturated pixels are usually
    # reflections, brake lights or number plates rather than paint.
    if n_chromatic < total * 0.35:
        achromatic_v = val[~chromatic]
        if achromatic_v.size == 0:
            return "unknown", 0.0
        median_v = float(np.median(achromatic_v))
        if median_v <= _BLACK_V_MAX:
            name = "black"
        elif median_v >= _WHITE_V_MIN:
            name = "white"
        else:
            name = "silver/grey"
        agree = float(np.count_nonzero(
            (achromatic_v <= _BLACK_V_MAX) if name == "black"
            else (achromatic_v >= _WHITE_V_MIN) if name == "white"
            else ((achromatic_v > _BLACK_V_MAX) & (achromatic_v < _WHITE_V_MIN))
        )) / total
        # Capped below the chromatic path's ceiling: this verdict rests on
        # value, which lighting moves the most.
        conf = min(0.85, agree)
        return (name, round(conf, 3)) if conf >= min_confidence else ("unknown", round(conf, 3))

    # Saturation-weighted hue histogram: a vivid pixel says more about the
    # paint than a washed-out one, and weighting beats a plain mode when a
    # body is partly in shadow.
    h_sel, s_sel = hue[chromatic], sat[chromatic]
    scores = {}
    for name, lo, hi in _HUE_BANDS:
        band = (h_sel >= lo) & (h_sel <= hi)
        if not band.any():
            continue
        # Red spans two bands and must accumulate across both.
        scores[name] = scores.get(name, 0.0) + float(s_sel[band].sum())
    if not scores:
        return "unknown", 0.0

    best = max(scores, key=scores.get)
    weight_total = sum(scores.values())
    conf = (scores[best] / weight_total) if weight_total > 0 else 0.0
    # Scaled by how much of the whole box was chromatic at all, so a mostly
    # grey box with one vivid corner cannot report a confident colour.
    conf *= n_chromatic / total
    return (best, round(conf, 3)) if conf >= min_confidence else ("unknown", round(conf, 3))

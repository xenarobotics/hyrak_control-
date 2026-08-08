"""
Shared OpenCV drawing helpers used across vision analyzer modules
(object detector, human tracker, person tracker).
"""
import cv2
import numpy as np


def draw_brackets(img, x1, y1, x2, y2, color, thickness=1, ratio=0.22, radius=5):
    """Corner L-brackets with slightly rounded inner corners."""
    lx = max(12, int((x2 - x1) * ratio))
    ly = max(12, int((y2 - y1) * ratio))
    r  = min(radius, lx // 2, ly // 2)

    # top-left
    cv2.line(img, (x1 + r, y1), (x1 + lx, y1), color, thickness, cv2.LINE_AA)
    cv2.line(img, (x1, y1 + r), (x1, y1 + ly), color, thickness, cv2.LINE_AA)
    cv2.ellipse(img, (x1 + r, y1 + r), (r, r), 0, 180, 270, color, thickness, cv2.LINE_AA)
    # top-right
    cv2.line(img, (x2 - lx, y1), (x2 - r, y1), color, thickness, cv2.LINE_AA)
    cv2.line(img, (x2, y1 + r), (x2, y1 + ly), color, thickness, cv2.LINE_AA)
    cv2.ellipse(img, (x2 - r, y1 + r), (r, r), 0, 270, 360, color, thickness, cv2.LINE_AA)
    # bottom-left
    cv2.line(img, (x1 + r, y2), (x1 + lx, y2), color, thickness, cv2.LINE_AA)
    cv2.line(img, (x1, y2 - ly), (x1, y2 - r), color, thickness, cv2.LINE_AA)
    cv2.ellipse(img, (x1 + r, y2 - r), (r, r), 0, 90, 180, color, thickness, cv2.LINE_AA)
    # bottom-right
    cv2.line(img, (x2 - lx, y2), (x2 - r, y2), color, thickness, cv2.LINE_AA)
    cv2.line(img, (x2, y2 - ly), (x2, y2 - r), color, thickness, cv2.LINE_AA)
    cv2.ellipse(img, (x2 - r, y2 - r), (r, r), 0, 0, 90, color, thickness, cv2.LINE_AA)


def draw_badge(img, text, x, y, fg=(255, 255, 255), bg=(10, 10, 10)):
    """Small dark-background label badge."""
    font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.36, 1
    (tw, th), _ = cv2.getTextSize(text, font, scale, thick)
    pad = 3
    cv2.rectangle(img, (x, y - th - pad), (x + tw + pad * 2, y + pad), bg, -1)
    cv2.putText(img, text, (x + pad, y), font, scale, fg, thick, cv2.LINE_AA)


def draw_tint_rect(img, x1, y1, x2, y2, color, alpha=0.15, border=True):
    """
    Translucent fill over a region + a solid border.

    Blends ONLY the region, never the whole frame. The previous version did
    `img.copy()` and then an `addWeighted` across all 1080p for every call —
    4.1ms each. That is invisible for one box, but a 3x3 density grid makes nine
    calls and cost 37ms PER FRAME, on top of inference. And draw_overlay runs on
    every camera frame rather than only analysed ones, so it capped the whole
    stream at ~27fps before any model had run. Region-local blending does the
    same nine cells in under 1ms.

    alpha <= 0 draws the border only and skips the blend entirely, which is what
    an empty grid cell wants — previously it paid the full frame cost to change
    nothing.
    """
    h, w = img.shape[:2]
    xa, ya = max(0, int(x1)), max(0, int(y1))
    xb, yb = min(w, int(x2)), min(h, int(y2))
    if xb <= xa or yb <= ya:
        return
    if alpha > 0:
        roi = img[ya:yb, xa:xb]
        block = np.empty_like(roi)
        block[:] = color
        cv2.addWeighted(block, alpha, roi, 1.0 - alpha, 0, roi)
    if border:
        cv2.rectangle(img, (xa, ya), (xb, yb), color, 2, cv2.LINE_AA)
    return None

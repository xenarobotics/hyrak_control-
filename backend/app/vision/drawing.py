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


def draw_ring(img, x1, y1, x2, y2, color, thickness=2, radius=10):
    """Rounded-rect subject ring — the modern replacement for corner brackets
    on anything that is a subject rather than clutter. Mirrors the canvas
    drawSubjectRing so both render paths agree."""
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
    r = max(2, min(radius, (x2 - x1) // 2, (y2 - y1) // 2))
    t, ls = int(thickness), cv2.LINE_AA
    cv2.line(img, (x1 + r, y1), (x2 - r, y1), color, t, ls)
    cv2.line(img, (x1 + r, y2), (x2 - r, y2), color, t, ls)
    cv2.line(img, (x1, y1 + r), (x1, y2 - r), color, t, ls)
    cv2.line(img, (x2, y1 + r), (x2, y2 - r), color, t, ls)
    for cx, cy, a0, a1 in ((x1 + r, y1 + r, 180, 270), (x2 - r, y1 + r, 270, 360),
                           (x1 + r, y2 - r, 90, 180), (x2 - r, y2 - r, 0, 90)):
        cv2.ellipse(img, (cx, cy), (r, r), 0, a0, a1, color, t, ls)


def draw_badge(img, text, x, y, fg=(255, 255, 255), bg=(18, 14, 12)):
    """
    Rounded, translucent label chip.

    Matches the client canvas (CvOverlayCanvas.drawBadge), because the same
    scene is drawn by both — the browser in overlay mode, this in processed
    mode — and two different label styles for one product reads as two
    products. A hard black rectangle with white text was the old look; the
    chip sits ON the image rather than punching a hole in it.
    """
    font, scale, thick = cv2.FONT_HERSHEY_DUPLEX, 0.42, 1
    (tw, th), base = cv2.getTextSize(text, font, scale, thick)
    px, py, r = 8, 5, 7
    x1, y1 = int(x), int(y - th - py - base // 2)
    x2, y2 = int(x + tw + px * 2), int(y + py)
    h, w = img.shape[:2]
    x1c, y1c = max(0, x1), max(0, y1)
    x2c, y2c = min(w, x2), min(h, y2)
    if x2c > x1c and y2c > y1c:
        roi = img[y1c:y2c, x1c:x2c]
        block = np.empty_like(roi)
        block[:] = bg
        cv2.addWeighted(block, 0.66, roi, 0.34, 0, roi)
        # Rounded hairline in the accent colour, same as the canvas version.
        draw_ring(img, x1c, y1c, x2c - 1, y2c - 1, fg, 1, radius=r)
    cv2.putText(img, text, (x1 + px, y - 1), font, scale, fg, thick, cv2.LINE_AA)


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

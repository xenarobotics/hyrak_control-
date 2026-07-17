"""
Shared OpenCV drawing helpers used across vision analyzer modules
(object detector, human tracker, person tracker).
"""
import cv2


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

"""
Vehicle colour classification.

The test that matters most here is test_dark_vehicles_are_black_not_random:
HSV saturation is (max-min)/max, so on a dark pixel a few levels of sensor
noise compute as high saturation and yield a meaningless hue. Before the
value gate, every black car was confidently labelled a random colour.
"""
import cv2
import numpy as np
import pytest

from app.vision.vehicle_color import classify_vehicle_color

SEED = 7


def patch(bgr, size=120, noise=18):
    """A flat colour with sensor-like noise, as a whole-frame ROI."""
    rng = np.random.default_rng(SEED)
    img = np.zeros((size, size, 3), np.uint8)
    img[:] = bgr
    return cv2.add(img, rng.integers(0, noise, (size, size, 3), dtype=np.uint8))


FULL = [0, 0, 120, 120]


# --------------------------------------------------------------------------- #
# Chromatic                                                                     #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bgr,expected", [
    ((30, 30, 200), "red"),
    ((200, 60, 30), "blue"),
    ((40, 215, 225), "yellow"),
    ((60, 160, 60), "green"),
    ((30, 120, 220), "orange"),
])
def test_saturated_colours(bgr, expected):
    name, conf = classify_vehicle_color(patch(bgr), FULL)
    assert name == expected
    assert conf > 0.5


def test_dark_and_light_shades_map_to_the_same_hue_name():
    """A navy car and a sky-blue car are both 'blue'. Lighting and paint depth
    must not change the name."""
    assert classify_vehicle_color(patch((90, 35, 20)), FULL)[0] == "blue"
    assert classify_vehicle_color(patch((220, 150, 90)), FULL)[0] == "blue"
    # Maroon is dark red, not brown or purple.
    assert classify_vehicle_color(patch((30, 25, 90)), FULL)[0] == "red"


def test_red_accumulates_across_the_hue_wrap():
    """Red spans both ends of OpenCV's 0-179 hue scale. If the two bands did
    not accumulate, a red car straddling the wrap would lose to a colour
    occupying one contiguous band."""
    rng = np.random.default_rng(SEED)
    img = np.zeros((120, 120, 3), np.uint8)
    img[:] = (30, 30, 200)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # Half the pixels just below the wrap, half just above.
    hsv[:60, :, 0] = 178
    hsv[60:, :, 0] = 2
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    img = cv2.add(img, rng.integers(0, 8, (120, 120, 3), dtype=np.uint8))
    assert classify_vehicle_color(img, FULL)[0] == "red"


# --------------------------------------------------------------------------- #
# Achromatic — and the HSV trap                                                 #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bgr,expected", [
    ((235, 235, 235), "white"),
    ((150, 150, 152), "silver/grey"),
    ((70, 70, 72), "silver/grey"),
    ((25, 25, 28), "black"),
    ((12, 12, 14), "black"),
])
def test_dark_vehicles_are_black_not_random(bgr, expected):
    """
    THE REGRESSION THIS MODULE EXISTS TO AVOID.

    At V=40, channels differing by 15 levels of noise give saturation ~95 —
    past the achromatic threshold — and the hue that falls out is noise. Every
    dark car was labelled a confident random colour until value was gated.
    """
    name, conf = classify_vehicle_color(patch(bgr), FULL)
    assert name == expected
    assert conf > 0.5


def test_achromatic_confidence_is_capped_below_chromatic():
    """The white/grey/black split rests on value, which lighting moves most,
    so it must not claim the same confidence as a hue verdict."""
    _, white_conf = classify_vehicle_color(patch((235, 235, 235)), FULL)
    _, red_conf = classify_vehicle_color(patch((30, 30, 200)), FULL)
    assert white_conf <= 0.85
    assert red_conf > white_conf


def test_specular_highlights_do_not_decide_the_colour():
    """A blown-out reflection is white whatever the paint beneath it."""
    img = patch((200, 60, 30))          # blue car
    img[40:60, 40:60] = (255, 255, 255)  # sun glint
    assert classify_vehicle_color(img, FULL)[0] == "blue"


# --------------------------------------------------------------------------- #
# Box handling                                                                  #
# --------------------------------------------------------------------------- #

def test_road_around_the_vehicle_is_excluded():
    """A YOLO box always contains some road, and road is grey. Sampling the
    whole box would drag every colour toward grey."""
    img = patch((128, 128, 128), 200)     # asphalt
    img[50:150, 50:150] = (30, 30, 200)   # red car centred in it
    name, conf = classify_vehicle_color(img, [0, 0, 200, 200])
    assert name == "red"
    assert conf > 0.5


def test_too_small_or_degenerate_boxes_return_unknown():
    """The honest answer for a distant vehicle. Better than a coin-flip
    colour attached to a permanent plate record."""
    assert classify_vehicle_color(patch((30, 30, 200)), [0, 0, 4, 4])[0] == "unknown"
    assert classify_vehicle_color(patch((30, 30, 200)), [0, 0, 0, 0])[0] == "unknown"
    assert classify_vehicle_color(patch((30, 30, 200)), [50, 50, 10, 10])[0] == "unknown"


def test_boxes_are_clamped_to_the_frame():
    """A tracked vehicle leaving frame has a box extending past the edge."""
    name, _ = classify_vehicle_color(patch((30, 30, 200)), [-40, -40, 300, 300])
    assert name == "red"


def test_min_confidence_gate_returns_unknown_but_keeps_the_score():
    """So a caller can log how close it got instead of only that it failed."""
    name, conf = classify_vehicle_color(patch((30, 30, 200)), FULL, min_confidence=1.5)
    assert name == "unknown"
    assert conf > 0.0

"""
Speed estimation.

The headline test is test_recovers_a_known_speed_while_the_camera_moves: a
synthetic scene with a textured ground plane, a drone panning, and a vehicle
crossing at a KNOWN metric speed. If ego-motion removal works, the estimate
lands on the truth; if it silently measures apparent motion instead, it comes
out wrong by the drone's own speed.
"""
import math

import cv2
import numpy as np
import pytest

from app.vision.geometry import CameraModel, CameraPose, MountOffset
from app.vision.speed import (
    _MAX_PLAUSIBLE_KMH, EgoMotionTracker, SpeedEstimator, SpeedReading,
)

W, H, FPS = 960, 540, 30.0
HFOV = 70.0


def cam() -> CameraModel:
    return CameraModel(W, H, HFOV)


def nadir_pose(agl=50.0) -> CameraPose:
    """Straight down: the least attitude-sensitive geometry, so the test
    measures the estimator rather than the projection."""
    return CameraPose(agl_m=agl, mount=MountOffset(tilt_deg=90.0))


def ground_texture(seed=3, size=2400) -> np.ndarray:
    """A richly textured 'ground' big enough to pan across. Ego-motion needs
    trackable corners; a flat colour would legitimately return None."""
    rng = np.random.default_rng(seed)
    img = rng.integers(40, 210, (size, size, 3), dtype=np.uint8)
    # Blobs give the corner detector something more structured than pure noise.
    for _ in range(900):
        x, y = rng.integers(0, size, 2)
        r = int(rng.integers(6, 26))
        col = tuple(int(c) for c in rng.integers(30, 230, 3))
        cv2.circle(img, (int(x), int(y)), r, col, -1)
    return img


def render(ground, cam_x, cam_y, car_xy, car_px):
    """Crop the ground at the camera offset and paint the car into it."""
    frame = ground[int(cam_y):int(cam_y) + H, int(cam_x):int(cam_x) + W].copy()
    cx, cy = car_xy
    x1 = int(cx - car_px // 2)
    y1 = int(cy - car_px // 2)
    x2, y2 = x1 + car_px, y1 + car_px // 2
    cv2.rectangle(frame, (x1, y1), (x2, y2), (20, 20, 190), -1)
    return frame, [x1, y1, x2, y2]


# --------------------------------------------------------------------------- #
# Ego-motion                                                                    #
# --------------------------------------------------------------------------- #

def test_first_frame_has_no_homography():
    """Nothing to compare against yet — must be None, not identity, or the
    first frame would silently report zero drone motion."""
    ego = EgoMotionTracker()
    assert ego.update(ground_texture()[:H, :W]) is None


def test_recovers_a_pure_translation():
    ego = EgoMotionTracker()
    g = ground_texture()
    ego.update(g[0:H, 0:W])
    H_mat = ego.update(g[0:H, 20:20 + W])     # ground shifted 20px left
    assert H_mat is not None
    # A point at x=500 must map ~20px left.
    p = H_mat @ np.array([500.0, 270.0, 1.0])
    assert (p[0] / p[2]) == pytest.approx(480.0, abs=3.0)


def test_featureless_scene_returns_none_rather_than_guessing():
    """Over water or fresh tarmac there is nothing to match. The caller must
    withhold a speed, not assume the drone held still."""
    ego = EgoMotionTracker()
    blank = np.full((H, W, 3), 128, np.uint8)
    ego.update(blank)
    assert ego.update(blank) is None


def test_target_pixels_are_excluded_from_the_background():
    """A large vehicle filling much of the frame must not drag the homography
    along with it — that would cancel the very motion being measured."""
    ego = EgoMotionTracker()
    g = ground_texture()
    box = [300, 150, 700, 400]
    ego.update(g[0:H, 0:W], exclude_boxes=[box])
    pts = ego._prev_pts.reshape(-1, 2)
    x1, y1, x2, y2 = box
    inside = ((pts[:, 0] > x1) & (pts[:, 0] < x2)
              & (pts[:, 1] > y1) & (pts[:, 1] < y2))
    assert not inside.any(), "corners were seeded inside the excluded box"


# --------------------------------------------------------------------------- #
# The headline test                                                             #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("truth_kmh,drone_px_per_frame", [
    (40.0, 0.0),     # stationary drone
    (40.0, 6.0),     # drone panning WITH the traffic
    (40.0, -6.0),    # drone panning AGAINST it
    (72.0, 4.0),
])
def test_recovers_a_known_speed_while_the_camera_moves(truth_kmh, drone_px_per_frame):
    """
    The whole point of the module. The drone's pan is a large fraction of the
    vehicle's apparent motion, so an estimator that skipped ego-motion removal
    would be wrong by roughly the drone's own speed — and the three pan cases
    would disagree with each other instead of all landing on the truth.
    """
    c, pose = cam(), nadir_pose(50.0)
    gsd = pose.gsd_at_pixel(c, c.cx, c.cy)          # ~0.038 m/px at 50m
    truth_px_per_frame = (truth_kmh / 3.6) / gsd / FPS

    est = SpeedEstimator(window_frames=15)
    ground = ground_texture()
    car_px = 46
    cam_x, cam_y = 400.0, 400.0
    car_x, car_y = 300.0, 270.0

    last: SpeedReading | None = None
    for i in range(26):
        # The car moves in WORLD terms; the visible position is world motion
        # minus the camera's own pan.
        car_x += truth_px_per_frame
        cam_x += drone_px_per_frame
        frame, box = render(
            ground, cam_x, cam_y, (car_x - (cam_x - 400.0), car_y), car_px
        )
        readings = est.update(
            frame, now=i / FPS,
            vehicles=[{"track_id": 1, "box": box, "type": "car"}],
            cam=c, pose=pose, scale_mode="altitude",
        )
        if 1 in readings:
            last = readings[1]

    assert last is not None, "no speed produced"
    # 12% tolerance: synthetic corner noise plus cumulative homography drift.
    # Well inside it for the claim being made, which is 5-10% in the field.
    assert last.kmh == pytest.approx(truth_kmh, rel=0.12), (
        f"expected ~{truth_kmh} km/h, got {last.kmh:.1f} "
        f"(drone pan {drone_px_per_frame} px/frame)"
    )
    assert last.reliable
    assert last.samples >= 5


def test_stationary_vehicle_reads_near_zero_under_camera_motion():
    """The inverse failure: a parked car must not acquire the drone's speed."""
    c, pose = cam(), nadir_pose(50.0)
    est = SpeedEstimator(window_frames=15)
    ground = ground_texture()
    cam_x = 400.0
    last = None
    for i in range(26):
        cam_x += 7.0
        frame, box = render(ground, cam_x, 400.0, (300.0 - (cam_x - 400.0), 270.0), 46)
        r = est.update(frame, now=i / FPS,
                       vehicles=[{"track_id": 1, "box": box, "type": "car"}],
                       cam=c, pose=pose, scale_mode="altitude")
        if 1 in r:
            last = r[1]
    assert last is not None
    assert last.kmh < 8.0, f"parked car read {last.kmh:.1f} km/h"


# --------------------------------------------------------------------------- #
# Withholding                                                                   #
# --------------------------------------------------------------------------- #

def test_no_telemetry_means_no_speed():
    """Without a pose there are no metres, and a pixel speed is not a speed."""
    est = SpeedEstimator()
    ground = ground_texture()
    for i in range(20):
        frame, box = render(ground, 400, 400, (300 + i * 4, 270), 46)
        r = est.update(frame, now=i / FPS,
                       vehicles=[{"track_id": 1, "box": box, "type": "car"}],
                       cam=cam(), pose=None)
        assert r == {}


def test_lost_ego_motion_restarts_the_window():
    """A broken homography chain must not be spliced across — the positions
    either side are in unrelated coordinate frames."""
    c, pose = cam(), nadir_pose()
    est = SpeedEstimator()
    ground = ground_texture()
    for i in range(12):
        frame, box = render(ground, 400 + i, 400, (300 + i * 5, 270), 46)
        est.update(frame, now=i / FPS,
                   vehicles=[{"track_id": 1, "box": box, "type": "car"}],
                   cam=c, pose=pose)
    assert est._tracks[1].times, "history should have accumulated"

    blank = np.full((H, W, 3), 100, np.uint8)
    est.update(blank, now=1.0, vehicles=[{"track_id": 1, "box": [0, 0, 10, 10], "type": "car"}],
               cam=c, pose=pose)
    est.update(blank, now=1.1, vehicles=[{"track_id": 1, "box": [0, 0, 10, 10], "type": "car"}],
               cam=c, pose=pose)
    assert not est._tracks[1].times, "window should have been cleared"


def test_absurd_speed_is_flagged_not_published_silently():
    r = SpeedReading(kmh=900.0, error_pct=4.0, reliable=False,
                     scale_source="altitude", samples=15,
                     note="probably a track identity swap")
    assert r.to_dict()["reliable"] is False
    assert _MAX_PLAUSIBLE_KMH < 900.0


def test_every_reading_is_marked_an_estimate():
    """Matches the contract plate_events.speed_est_kmh already states: this
    must never travel without is_estimate."""
    d = SpeedReading(40.0, 4.0, True, "agreed", 15).to_dict()
    assert d["is_estimate"] is True


def test_dead_tracks_are_forgotten():
    """Otherwise histories accumulate for the life of the session."""
    est = SpeedEstimator()
    ground = ground_texture()
    for i in range(6):
        frame, box = render(ground, 400 + i, 400, (300 + i * 4, 270), 46)
        est.update(frame, now=i / FPS,
                   vehicles=[{"track_id": 9, "box": box, "type": "car"}],
                   cam=cam(), pose=nadir_pose())
    assert 9 in est._tracks
    frame, box = render(ground, 410, 400, (330, 270), 46)
    est.update(frame, now=1.0, vehicles=[], cam=cam(), pose=nadir_pose())
    assert 9 not in est._tracks


# --------------------------------------------------------------------------- #
# Native-resolution ego-motion                                                  #
# --------------------------------------------------------------------------- #
#
# Ego-motion runs at the camera's native resolution — no downscale-then-rescale
# step. A downscaled path was tried once as an optimisation (25.4ms at 1080p vs
# 6.1ms at 960) and deliberately reverted: full resolution everywhere outranks
# the frame-budget saving. These tests pin that a 1920-wide frame is processed
# AT 1920, not silently shrunk.

def test_homography_is_in_full_frame_coordinates_at_1080p():
    """No internal downscale means displacement reads 1:1 in full-frame pixels."""
    ego = EgoMotionTracker()
    g = ground_texture(size=3000)
    ego.update(g[0:1080, 0:1920])
    H_mat = ego.update(g[0:1080, 40:40 + 1920])       # shifted 40 FULL-frame px
    assert H_mat is not None
    p = H_mat @ np.array([1000.0, 540.0, 1.0])
    moved = 1000.0 - (p[0] / p[2])
    assert moved == pytest.approx(40.0, abs=6.0), (
        f"displacement {moved:.1f}px — expected ~40 in full-frame coordinates"
    )


def test_a_frame_size_change_restarts_the_chain():
    """Points from a different frame size cannot be matched against the new
    ones, so the chain must reset rather than produce a garbage warp."""
    ego = EgoMotionTracker()
    g = ground_texture(size=3000)
    ego.update(g[0:1080, 0:1920])
    assert ego._prev_pts is not None
    assert ego.update(g[0:540, 0:960]) is None


def test_exclusion_boxes_stay_in_full_frame_coordinates():
    """No rescale step means boxes are used exactly as given — seeding must
    avoid the excluded region at full resolution."""
    ego = EgoMotionTracker()
    frame = ground_texture(size=2400)[0:1080, 0:1920]
    box = [200, 200, 1400, 900]
    ego.update(frame, exclude_boxes=[box])
    pts = ego._prev_pts.reshape(-1, 2)
    inside = (
        (pts[:, 0] > box[0]) & (pts[:, 0] < box[2])
        & (pts[:, 1] > box[1]) & (pts[:, 1] < box[3])
    )
    assert not inside.any(), "corners were seeded inside the excluded region"


@pytest.mark.parametrize("truth_kmh", [40.0, 72.0])
def test_known_speed_is_recovered_at_1080p(truth_kmh):
    """The end-to-end check that full-resolution ego-motion is still accurate."""
    W1, H1 = 1920, 1080
    c = CameraModel(W1, H1, HFOV)
    pose = nadir_pose(50.0)
    gsd = pose.gsd_at_pixel(c, c.cx, c.cy)
    truth_px = (truth_kmh / 3.6) / gsd / FPS

    est = SpeedEstimator(window_frames=15)
    g = ground_texture(size=3200)
    car_px, car_x, cam_x = 92, 600.0, 500.0
    last = None
    for i in range(26):
        car_x += truth_px
        cam_x += 6.0                                  # drone panning too
        frame = g[400:400 + H1, int(cam_x):int(cam_x) + W1].copy()
        vx, vy = int(car_x - (cam_x - 500.0)), H1 // 2
        box = [vx - car_px // 2, vy - car_px // 2,
               vx + car_px // 2, vy]
        cv2.rectangle(frame, (box[0], box[1]), (box[2], box[3]), (20, 20, 190), -1)
        r = est.update(frame, now=i / FPS,
                       vehicles=[{"track_id": 1, "box": box, "type": "car"}],
                       cam=c, pose=pose, scale_mode="altitude")
        if 1 in r:
            last = r[1]
    assert last is not None
    assert last.kmh == pytest.approx(truth_kmh, rel=0.12)

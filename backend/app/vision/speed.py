"""
Vehicle speed estimation from a moving drone.
=============================================

Geometry, not a learned model. That is a feature: the result can be explained,
audited, and checked against a second independent measurement — which matters
the moment anyone says the word "enforcement".

THE PROBLEM
    The camera is bolted to an airframe that tilts in order to translate, so
    a vehicle's apparent motion is its real motion plus the drone's. Removing
    the drone's contribution is the entire job.

WHY NOT USE THE IMU
    Because it is aliased. Attitude arrives at 4 Hz over the RF telemetry link
    (telemetry/manager.py: set_rate_attitude_euler at 4.0 when serial) while
    video runs at 30 fps, and the airframe oscillates faster than 4 Hz. The
    per-frame camera orientation simply is not in that signal, and no amount
    of interpolation puts it back.

    The consequences are not subtle. Ground range is h*cot(theta), so range
    error per degree of pitch is h/sin^2(theta): at 50 m and a shallow 20 deg
    depression that is 7.5 m per degree. A tenth of a degree of unmodelled
    jitter between two frames 33 ms apart fabricates ~27 km/h out of nothing.

WHAT IS USED INSTEAD
    The background. Static ground features give the frame-to-frame image warp
    caused by drone motion directly, measured from the pixels at full frame
    rate, needing no telemetry and no timestamp alignment. Attitude and
    altitude are then used only for slowly-varying quantities — the metric
    scale and the ground plane — where 4 Hz is entirely adequate.

ERROR BUDGET (measured, HFOV 70 deg, 1080p, 15-frame window)
    pixel jitter        <1 km/h     — a least-squares slope over 15 samples
                                      averages 1.5 px of box noise down to
                                      almost nothing. Two-frame differencing
                                      would leave several km/h.
    altitude +-1.5 m    15% at 10 m, 3% at 50 m, 1.5% at 100 m
    object ruler        ~4% flat, independent of altitude AND attitude
    -> better than 5% above about 30 m, which is inside the tolerance this
       was built for.
"""
import logging
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Sequence, Tuple

import numpy as np

from app.vision.geometry import (
    CameraModel, CameraPose,
    resolve_scale, scale_from_altitude, scale_from_object_width,
)

logger = logging.getLogger("verocore.vision.speed")

# Sparse-flow parameters. Deliberately modest: this runs per frame on CPU
# alongside two neural networks, and a few hundred well-spread corners
# estimate a homography just as well as a few thousand clustered ones.
_MAX_CORNERS = 400
_CORNER_QUALITY = 0.01
_MIN_CORNER_DISTANCE = 12
# Below this many tracked correspondences the homography is not trustworthy —
# happens over water, fresh tarmac, or a featureless field.
_MIN_INLIERS = 12
_RANSAC_REPROJ_PX = 3.0

# A vehicle cannot accelerate from 0 to this in the time between two frames;
# anything above it is a tracker identity swap, not a fast car.
_MAX_PLAUSIBLE_KMH = 250.0

# Below this the direction of travel is noise, not a heading. A stationary
# vehicle still shows a couple of px/s of box jitter, and atan2 of jitter is a
# uniformly random compass bearing — which would then be published as fact and
# would poison the flow consensus that wrong-way detection is built on.
_MIN_HEADING_KMH = 5.0

# How far ahead the vehicle is projected in order to measure where it is going.
# Long enough that the two ground points are separated by far more than the
# projection's own error, short enough that the straight-line assumption holds.
_HEADING_LOOKAHEAD_S = 1.0


# --------------------------------------------------------------------------- #
# Ego-motion                                                                    #
# --------------------------------------------------------------------------- #

class EgoMotionTracker:
    """
    Frame-to-frame background homography.

    Corners are seeded OUTSIDE the tracked target boxes, because a vehicle's
    own features are exactly what must not contribute: include them and the
    homography partly follows the car, which is the one thing that would
    cancel the signal being measured.

    RUNS AT THE CAMERA'S NATIVE RESOLUTION.
        A downscaled path (960 wide, homography rescaled back) was measured
        once as an optimisation — 25.4ms at 1080p vs 6.1ms at 960 — and then
        deliberately reverted: the operator wants every stage running at the
        camera's actual resolution rather than trading accuracy headroom for
        frame budget. The 25.4ms/frame cost is the price of that and is
        accounted for in the per-frame budget alongside YOLO.
    """

    def __init__(self):
        self._prev_gray: Optional[np.ndarray] = None
        self._prev_pts: Optional[np.ndarray] = None
        self.last_inliers: int = 0
        self.last_ok: bool = False

    def reset(self) -> None:
        self._prev_gray = None
        self._prev_pts = None
        self.last_ok = False

    @staticmethod
    def _background_mask(shape, exclude_boxes: Sequence[Sequence[int]]) -> np.ndarray:
        h, w = shape[:2]
        mask = np.full((h, w), 255, dtype=np.uint8)
        for box in exclude_boxes or ():
            x1, y1, x2, y2 = [int(v) for v in box]
            # Dilated by 15%: a box clips a vehicle's edges, and the corners
            # just outside it still belong to the vehicle, not the road.
            pw, ph = int((x2 - x1) * 0.15), int((y2 - y1) * 0.15)
            mask[max(0, y1 - ph):min(h, y2 + ph),
                 max(0, x1 - pw):min(w, x2 + pw)] = 0
        return mask

    def update(
        self, frame_bgr: np.ndarray, exclude_boxes: Sequence[Sequence[int]] = ()
    ) -> Optional[np.ndarray]:
        """
        3x3 homography mapping PREVIOUS frame pixels to CURRENT frame pixels,
        or None when the background could not be matched.

        None is a normal outcome, not an error: featureless ground, a hard
        exposure change, or a frame drop all produce it, and the caller must
        withhold a speed rather than assume the drone held still.
        """
        import cv2
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        mask = self._background_mask(gray.shape, exclude_boxes)

        # A resolution change (stream renegotiated, source swapped) invalidates
        # the previous frame's points outright — optical flow between two
        # differently-sized pyramids is not a "few pixels off", it is a hard
        # OpenCV assertion failure, so the chain must restart rather than run.
        if self._prev_gray is not None and self._prev_gray.shape != gray.shape:
            self._prev_gray, self._prev_pts = None, None

        if self._prev_gray is None or self._prev_pts is None or len(self._prev_pts) < _MIN_INLIERS:
            self._prev_gray = gray
            self._prev_pts = cv2.goodFeaturesToTrack(
                gray, maxCorners=_MAX_CORNERS, qualityLevel=_CORNER_QUALITY,
                minDistance=_MIN_CORNER_DISTANCE, mask=mask,
            )
            self.last_ok = False
            return None

        nxt, status, _err = cv2.calcOpticalFlowPyrLK(
            self._prev_gray, gray, self._prev_pts, None,
            winSize=(21, 21), maxLevel=3,
        )
        H = None
        if nxt is not None and status is not None:
            keep = status.ravel() == 1
            src = self._prev_pts[keep].reshape(-1, 2)
            dst = nxt[keep].reshape(-1, 2)
            if len(src) >= _MIN_INLIERS:
                H, inlier_mask = cv2.findHomography(
                    src, dst, cv2.RANSAC, _RANSAC_REPROJ_PX
                )
                self.last_inliers = (
                    int(inlier_mask.sum()) if inlier_mask is not None else 0
                )
                if self.last_inliers < _MIN_INLIERS:
                    H = None

        # Re-seed every frame rather than chaining tracked points: LK drift
        # accumulates, and corner detection is cheap next to the two networks
        # already running on this frame.
        self._prev_gray = gray
        self._prev_pts = cv2.goodFeaturesToTrack(
            gray, maxCorners=_MAX_CORNERS, qualityLevel=_CORNER_QUALITY,
            minDistance=_MIN_CORNER_DISTANCE, mask=mask,
        )
        self.last_ok = H is not None
        return H


# --------------------------------------------------------------------------- #
# Per-track velocity                                                           #
# --------------------------------------------------------------------------- #

@dataclass
class SpeedReading:
    kmh: float
    error_pct: float
    reliable: bool
    scale_source: str
    samples: int
    note: str = ""
    # ── Direction of travel ──────────────────────────────────────────────
    # The velocity VECTOR was always computed here; only its magnitude was
    # ever published. Both fields below come from the same least-squares fit
    # at no extra cost, and answer questions the magnitude cannot: which way
    # is this vehicle going, and is it coming at us.
    #
    # None whenever the vehicle is too slow for its direction to mean
    # anything (see _MIN_HEADING_KMH) or the ground projection failed — a
    # guessed heading is worse than no heading, because wrong-way detection
    # is built on top of it.
    #: Compass bearing of travel in degrees, 0=North, 90=East.
    heading_deg: Optional[float] = None
    #: Rate the SLANT RANGE to the camera is shrinking, m/s. Positive means
    #: closing on the drone, negative means opening away from it.
    closing_m_s: Optional[float] = None
    #: Unit vector of travel in CURRENT-FRAME pixels, (dx, dy), y down.
    #:
    #: Carried separately from heading_deg because the two are for different
    #: consumers and neither substitutes for the other. heading_deg is a
    #: compass bearing — right for a log, a report, and comparing two vehicles.
    #: This is where the vehicle is going ON THE PICTURE, which is the only
    #: thing an arrow drawn over the video can honestly point along. Derived
    #: from the same ground projection, so it carries the perspective the raw
    #: pixel velocity would get wrong.
    screen_dir: Optional[Tuple[float, float]] = None

    @property
    def direction(self) -> Optional[str]:
        """'approaching' | 'departing' | 'crossing', or None.

        The deadband matters: a vehicle crossing the frame laterally has a
        closing rate that hovers around zero and would otherwise flicker
        between the two labels every frame.
        """
        if self.closing_m_s is None:
            return None
        if self.closing_m_s > 1.0:
            return "approaching"
        if self.closing_m_s < -1.0:
            return "departing"
        return "crossing"

    def to_dict(self) -> dict:
        return {
            "kmh": round(self.kmh, 1),
            "error_pct": round(self.error_pct, 1),
            "reliable": self.reliable,
            "scale_source": self.scale_source,
            "samples": self.samples,
            # Never omitted. Every consumer must see that this is an estimate,
            # matching the contract plate_events.speed_est_kmh already states.
            "is_estimate": True,
            "note": self.note,
            "heading_deg": (round(self.heading_deg, 1)
                            if self.heading_deg is not None else None),
            "closing_m_s": (round(self.closing_m_s, 2)
                            if self.closing_m_s is not None else None),
            "direction": self.direction,
            "screen_dir": ([round(self.screen_dir[0], 3),
                            round(self.screen_dir[1], 3)]
                           if self.screen_dir is not None else None),
        }


@dataclass
class _TrackHistory:
    """Stabilised positions for one vehicle, in the coordinate frame of the
    window's first frame."""
    times: Deque[float] = field(default_factory=lambda: deque(maxlen=64))
    xs: Deque[float] = field(default_factory=lambda: deque(maxlen=64))
    ys: Deque[float] = field(default_factory=lambda: deque(maxlen=64))
    last_kmh: Optional[float] = None

    def clear(self) -> None:
        self.times.clear()
        self.xs.clear()
        self.ys.clear()


class SpeedEstimator:
    """
    Speeds for many tracks at once, from one shared ego-motion solution.

    Positions accumulate in a STABILISED frame: each new frame's homography is
    composed into a cumulative transform back to the window's first frame, and
    every target position is mapped through its inverse. Drone motion then
    lives entirely in the transform, and what remains in the stabilised
    coordinates is the vehicle's own motion.

    Cumulative homographies drift, which is precisely why the window is short
    (~0.5 s). Over 15 frames the drift is far below the tracker's own box
    noise; over 10 seconds it would dominate.
    """

    def __init__(self, window_frames: int = 15):
        self.window_frames = max(5, int(window_frames))
        self.ego = EgoMotionTracker()
        self._cumulative: Optional[np.ndarray] = None
        self._tracks: Dict[int, _TrackHistory] = {}

    def reset(self) -> None:
        self.ego.reset()
        self._cumulative = None
        self._tracks.clear()

    def forget(self, track_ids: Sequence[int]) -> None:
        for tid in track_ids:
            self._tracks.pop(tid, None)

    # ---------------------------------------------------------------- #

    def update(
        self,
        frame_bgr: np.ndarray,
        now: float,
        vehicles: List[dict],
        cam: Optional[CameraModel],
        pose: Optional[CameraPose],
        scale_mode: str = "auto",
        max_disagreement_pct: float = 10.0,
        vehicle_widths_m: Optional[Dict[str, float]] = None,
    ) -> Dict[int, SpeedReading]:
        """
        Advance one frame and return a reading per track that has one.

        `now` must be the frame's CAPTURE time (FrameContext.captured_at), not
        the current clock: frames are dropped, so the interval between frames a
        module actually sees is not 1/fps and assuming otherwise scales every
        speed by whatever the machine's load happened to be.
        """
        boxes = [v["box"] for v in vehicles if v.get("box")]
        H = self.ego.update(frame_bgr, exclude_boxes=boxes)

        if H is None:
            # Cannot separate drone motion from vehicle motion this frame.
            # Everything accumulated so far is still valid, but the chain is
            # broken, so the window restarts rather than splicing across a gap.
            self._cumulative = None
            for hist in self._tracks.values():
                hist.clear()
            return {}

        # Compose into the transform back to the window's first frame.
        self._cumulative = H if self._cumulative is None else (H @ self._cumulative)
        try:
            inv = np.linalg.inv(self._cumulative)
        except np.linalg.LinAlgError:
            self._cumulative = None
            return {}

        out: Dict[int, SpeedReading] = {}
        live_ids = set()

        for v in vehicles:
            tid = v.get("track_id")
            box = v.get("box")
            if tid is None or not box:
                continue
            live_ids.add(tid)

            x1, y1, x2, y2 = box
            # Bottom-centre, not centroid: it approximates where the vehicle
            # touches the ground plane being projected onto. A centroid sits
            # at a height that varies with vehicle size and viewing angle.
            px, py = (x1 + x2) / 2.0, float(y2)

            # Into the stabilised frame.
            p = inv @ np.array([px, py, 1.0], dtype=np.float64)
            if abs(p[2]) < 1e-9:
                continue
            sx_, sy_ = float(p[0] / p[2]), float(p[1] / p[2])

            hist = self._tracks.setdefault(tid, _TrackHistory())
            hist.times.append(now)
            hist.xs.append(sx_)
            hist.ys.append(sy_)
            while len(hist.times) > self.window_frames:
                hist.times.popleft()
                hist.xs.popleft()
                hist.ys.popleft()

            reading = self._fit(
                hist, v, cam, pose, px, py,
                scale_mode, max_disagreement_pct, vehicle_widths_m or {},
            )
            if reading is not None:
                out[tid] = reading

        # Drop tracks that have gone; otherwise stale histories accumulate
        # for the life of the session.
        self.forget([t for t in self._tracks if t not in live_ids])
        return out

    # ---------------------------------------------------------------- #

    def _fit(
        self, hist: _TrackHistory, vehicle: dict,
        cam: Optional[CameraModel], pose: Optional[CameraPose],
        px: float, py: float,
        scale_mode: str, max_disagreement_pct: float,
        vehicle_widths_m: Dict[str, float],
    ) -> Optional[SpeedReading]:
        n = len(hist.times)
        if n < 5:
            return None            # too few samples for a meaningful slope
        if cam is None or pose is None:
            return None            # no telemetry -> no metres, so no speed

        t = np.asarray(hist.times, dtype=np.float64)
        t = t - t[0]
        span = float(t[-1])
        if span <= 1e-3:
            return None

        # Least-squares slope, NOT a two-frame difference. With N samples the
        # slope error is sigma_px*sqrt(12/(N(N^2-1)))/dt, so 15 frames turn
        # 1.5 px of box jitter into well under 1 km/h.
        vx_px = float(np.polyfit(t, np.asarray(hist.xs), 1)[0])
        vy_px = float(np.polyfit(t, np.asarray(hist.ys), 1)[0])
        speed_px_s = math.hypot(vx_px, vy_px)

        # ── Scale: two independent sources, cross-checked ────────────────
        from_alt = scale_from_altitude(pose, cam, px, py)
        from_obj = None
        width_m = vehicle_widths_m.get(vehicle.get("type") or "")
        if width_m:
            # Extent across the direction of travel. Width varies least
            # between models; measuring along an arbitrary axis mixes length
            # into width and the ruler stops being one.
            x1, y1, x2, y2 = vehicle["box"]
            bw, bh = abs(x2 - x1), abs(y2 - y1)
            across = bw if abs(vy_px) >= abs(vx_px) else bh
            from_obj = scale_from_object_width(across, width_m)

        scale = resolve_scale(from_alt, from_obj, scale_mode, max_disagreement_pct)
        if scale is None:
            return None

        kmh = speed_px_s * scale.m_per_px * 3.6

        note = scale.note
        reliable = scale.reliable
        if kmh > _MAX_PLAUSIBLE_KMH:
            # Far more likely a tracker identity swap than a genuinely fast
            # vehicle. Reported as unreliable rather than silently dropped, so
            # the tracking problem stays visible.
            reliable = False
            note = (f"{kmh:.0f} km/h exceeds the plausible ceiling — "
                    f"probably a track identity swap")
        if span < 0.3:
            reliable = False
            note = note or f"only {span:.2f}s of history"

        heading_deg, closing, screen_dir = (None, None, None)
        if kmh >= _MIN_HEADING_KMH and reliable:
            heading_deg, closing, screen_dir = self._bearing(
                hist.xs[-1], hist.ys[-1], vx_px, vy_px, px, py, cam, pose
            )

        hist.last_kmh = kmh
        return SpeedReading(
            kmh=kmh,
            error_pct=scale.error_pct,
            reliable=reliable,
            scale_source=scale.source,
            samples=n,
            note=note,
            heading_deg=heading_deg,
            closing_m_s=closing,
            screen_dir=screen_dir,
        )

    def _bearing(
        self, sx: float, sy: float, vx_px: float, vy_px: float,
        px: float, py: float, cam: CameraModel, pose: CameraPose,
    ) -> tuple:
        """
        (compass bearing deg, closing rate m/s, screen unit vector) for one
        fitted velocity, or a triple of Nones when the geometry does not
        support an answer.

        WHY NOT JUST TAKE atan2 OF THE PIXEL VELOCITY
            Because image direction is not ground direction. Perspective
            compresses the far half of the frame, so the same ground heading
            produces a different pixel bearing depending on where in frame the
            vehicle is — badly enough near the top of frame that two vehicles
            in the same lane would be reported as travelling 30 degrees apart,
            which is exactly the error that would fabricate wrong-way alerts.

        So the velocity is projected onto the GROUND PLANE: the vehicle's
        current position and where it will be a second from now are both taken
        through the same pixel->ground projection already used for scale, and
        the bearing is measured between those two world points. That also
        yields the closing rate for free, since the projection returns slant
        range alongside the position.

        The lookahead point is carried back through the cumulative homography
        first, because the fit lives in the STABILISED frame of the window's
        first image while the projection is defined on the current one.
        """
        if self._cumulative is None:
            return (None, None, None)
        ahead = np.array(
            [sx + vx_px * _HEADING_LOOKAHEAD_S,
             sy + vy_px * _HEADING_LOOKAHEAD_S, 1.0], dtype=np.float64
        )
        q = self._cumulative @ ahead
        if abs(q[2]) < 1e-9:
            return (None, None, None)
        ux, uy = float(q[0] / q[2]), float(q[1] / q[2])

        # (px, py) is the CURRENT frame's own bottom-centre pixel — the same
        # point (sx, sy) is the stabilised image of — so it is used directly
        # rather than mapped back through the homography and returned to where
        # it started.
        here = pose.project_to_ground(cam, px, py)
        there = pose.project_to_ground(cam, ux, uy)
        # None is routine, not exceptional: the lookahead point can land above
        # the horizon for a vehicle heading away near the top of frame, and
        # there is no ground position for a ray that never meets the ground.
        if here is None or there is None:
            return (None, None, None)

        dn, de = there[0] - here[0], there[1] - here[1]
        if math.hypot(dn, de) < 1e-3:
            return (None, None, None)
        bearing = math.degrees(math.atan2(de, dn)) % 360.0
        # Slant range shrinking == closing. Divided by the lookahead so the
        # answer is a rate rather than a displacement.
        closing = (here[2] - there[2]) / _HEADING_LOOKAHEAD_S

        # Where that same motion points on the picture. Taken from the
        # PROJECTED lookahead pixel rather than from (vx_px, vy_px) directly,
        # so it inherits the same perspective handling the bearing does.
        sdx, sdy = ux - px, uy - py
        norm = math.hypot(sdx, sdy)
        screen = (sdx / norm, sdy / norm) if norm > 1e-6 else None
        return (bearing, closing, screen)

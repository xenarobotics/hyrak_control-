"""
Camera geometry for a FIXED-MOUNT (no gimbal) drone camera.
===========================================================

Turns pixels into metres. Everything metric the vision modules report -
vehicle speed, target ground position, distance-to-subject - comes through
here, so the conventions below are worth reading once.

WHY A FIXED MOUNT IS THE EASY CASE
    With no gimbal the camera's world orientation IS the airframe attitude
    composed with a one-time rig offset. There is no second IMU to fuse, no
    gimbal latency, and no calibration that drifts between flights.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
    It does not derive frame-to-frame motion from attitude. Attitude arrives
    at 4 Hz over the RF link (telemetry/manager.py sets
    set_rate_attitude_euler to 4.0 when serial) against 30 fps video - the
    airframe oscillates faster than that, so per-frame camera orientation is
    aliased and cannot be reconstructed by interpolating harder. Attitude
    here is only ever used for slowly-varying quantities: the metric scale
    and the ground-plane geometry, where 4 Hz is plenty. Per-frame ego-motion
    is measured from the pixels instead - see egomotion.py.

    A multirotor also has to tilt to translate, and ground range is
    h/tan(theta) so the error per degree of pitch is h/sin^2(theta): about
    1.75 m/deg at 45 deg depression and 50 m altitude, but 7.5 m/deg at
    20 deg. Trusting a 4 Hz attitude for per-frame geometry at a shallow
    angle would fabricate speeds in the hundreds of km/h from nothing.

FRAME CONVENTIONS
    world   local NED at the camera:  x=North  y=East   z=Down
    body    airframe:                 x=nose   y=right  z=down
    camera  OpenCV:                   x=right  y=down   z=optical axis

    Telemetry euler angles follow MAVSDK's signs (roll positive banking
    right, pitch positive nose UP, yaw positive clockwise from above), which
    is what the standard right-handed Rz(yaw)Ry(pitch)Rx(roll) expects, so no
    sign flipping happens on the way in.

    Mount tilt is DEPRESSION below the horizon - positive tilts the lens
    down, which is a negative body pitch, hence the Ry(-tilt).
"""
import logging
import math
from dataclasses import dataclass, field
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger("verocore.vision.geometry")


# --------------------------------------------------------------------------- #
# Rotations                                                                     #
# --------------------------------------------------------------------------- #

def _rx(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def _ry(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def _rz(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


# Camera axes expressed in body axes with the lens looking straight ahead.
# Columns are the images of the camera basis vectors:
#   x_cam (right)   -> body y (right)
#   y_cam (down)    -> body z (down)
#   z_cam (forward) -> body x (nose)
_CAM_TO_BODY_LEVEL = np.array(
    [[0, 0, 1],
     [1, 0, 0],
     [0, 1, 0]], dtype=np.float64
)


# --------------------------------------------------------------------------- #
# Camera model                                                                  #
# --------------------------------------------------------------------------- #

@dataclass
class CameraModel:
    """
    Pinhole intrinsics derived from field of view, because FOV is what can
    actually be measured on a bench without a calibration rig:

        place a target of known width W filling the frame at distance D
        hfov_deg = 2*atan(W / (2*D))

    vfov_deg=0 derives the vertical FOV from the aspect ratio, which is
    correct for a rectilinear lens (square pixels, fy == fx). Only set it
    explicitly if measured - a fisheye's vertical FOV does not follow from
    its horizontal one, and assuming it does skews every ground projection.
    """
    width: int
    height: int
    hfov_deg: float
    vfov_deg: float = 0.0
    distortion: Tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0)

    def __post_init__(self):
        if self.width <= 0 or self.height <= 0:
            raise ValueError(f"bad frame size {self.width}x{self.height}")
        if not 1.0 < self.hfov_deg < 179.0:
            raise ValueError(f"hfov_deg {self.hfov_deg} outside 1-179")
        self.fx = (self.width / 2.0) / math.tan(math.radians(self.hfov_deg) / 2.0)
        if self.vfov_deg and 1.0 < self.vfov_deg < 179.0:
            self.fy = (self.height / 2.0) / math.tan(math.radians(self.vfov_deg) / 2.0)
        else:
            self.fy = self.fx  # square pixels - the rectilinear default
        self.cx = self.width / 2.0
        self.cy = self.height / 2.0

    @property
    def derived_vfov_deg(self) -> float:
        return 2.0 * math.degrees(math.atan((self.height / 2.0) / self.fy))

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx],
                         [0, self.fy, self.cy],
                         [0, 0, 1]], dtype=np.float64)

    @property
    def has_distortion(self) -> bool:
        return any(abs(c) > 1e-9 for c in self.distortion)

    def scaled_to(self, width: int, height: int) -> "CameraModel":
        """
        Same lens, different frame size. Modules run inference on a
        downscaled copy (see inference_resize_width) and must not mix a
        640-wide detection box with 1920-wide intrinsics - the FOV is
        unchanged but every focal length and centre halves.
        """
        return CameraModel(width, height, self.hfov_deg, self.vfov_deg, self.distortion)

    def undistort(self, pts: np.ndarray) -> np.ndarray:
        """Nx2 pixel array -> undistorted Nx2. No-op when coefficients are zero."""
        if not self.has_distortion:
            return pts
        import cv2
        d = np.array(self.distortion[:5], dtype=np.float64).reshape(1, -1)
        src = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2)
        out = cv2.undistortPoints(src, self.K, d, P=self.K)
        return out.reshape(-1, 2)

    def ray(self, u: float, v: float) -> np.ndarray:
        """Unit direction in CAMERA frame through pixel (u, v)."""
        d = np.array([(u - self.cx) / self.fx,
                      (v - self.cy) / self.fy,
                      1.0], dtype=np.float64)
        return d / np.linalg.norm(d)


# --------------------------------------------------------------------------- #
# Pose                                                                          #
# --------------------------------------------------------------------------- #

@dataclass
class MountOffset:
    """Camera relative to the airframe. A one-time rig measurement."""
    tilt_deg: float = 45.0   # depression below horizon at frame centre
    yaw_deg: float = 0.0
    roll_deg: float = 0.0

    def rotation(self) -> np.ndarray:
        """body_from_camera."""
        return (_rz(self.yaw_deg) @ _ry(-self.tilt_deg)
                @ _rx(self.roll_deg) @ _CAM_TO_BODY_LEVEL)


@dataclass
class CameraPose:
    """
    Where the camera is looking, and how high above the target's ground.

    agl_m is height above the plane the TARGET stands on, not above the
    launch point. Barometric and GPS altitude are both launch-relative, so a
    vehicle on a road at a different elevation carries that offset straight
    into every speed estimate - which is what agl_offset_m exists to absorb.
    """
    agl_m: float
    roll_deg: float = 0.0
    pitch_deg: float = 0.0
    yaw_deg: float = 0.0
    mount: MountOffset = field(default_factory=MountOffset)

    def world_from_camera(self) -> np.ndarray:
        r_world_body = _rz(self.yaw_deg) @ _ry(self.pitch_deg) @ _rx(self.roll_deg)
        return r_world_body @ self.mount.rotation()

    def depression_deg(self, cam: CameraModel, u: float, v: float) -> Optional[float]:
        """
        Angle below horizontal of the ray through (u, v). None when the ray
        is at or above the horizon.

        Worth surfacing to the operator rather than keeping internal: it is
        what decides whether a face is a face or a scalp, and it is the cap
        auto-elevate has to respect (max_depression_deg).
        """
        d = self.world_from_camera() @ cam.ray(u, v)
        down = float(d[2])
        horiz = math.hypot(float(d[0]), float(d[1]))
        if down <= 0.0:
            return None
        return math.degrees(math.atan2(down, horiz))

    def project_to_ground(
        self, cam: CameraModel, u: float, v: float
    ) -> Optional[Tuple[float, float, float]]:
        """
        Pixel -> (north_m, east_m, slant_range_m), metres from the camera's
        nadir point on the ground plane.

        Returns None when the ray does not strike the ground: at or above the
        horizon, or with a nonsensical altitude. Callers MUST handle None -
        it happens routinely at shallow mount angles the moment the airframe
        pitches, and silently substituting a huge number puts a vehicle
        kilometres away and reports an absurd speed.
        """
        if not (self.agl_m and self.agl_m > 0.05):
            return None
        d = self.world_from_camera() @ cam.ray(u, v)
        down = float(d[2])
        if down <= 1e-6:
            return None
        t = self.agl_m / down          # slant range along the ray
        return float(t * d[0]), float(t * d[1]), float(t)

    def gsd_at_pixel(self, cam: CameraModel, u: float, v: float) -> Optional[float]:
        """
        Local metres-per-pixel at (u, v), measured rather than assumed: the
        ground distance between this pixel and its neighbour. Perspective
        makes this vary a lot across one frame, so a single frame-wide GSD is
        wrong everywhere except where it was computed.
        """
        a = self.project_to_ground(cam, u, v)
        b = self.project_to_ground(cam, u + 1.0, v)
        c = self.project_to_ground(cam, u, v + 1.0)
        if a is None or b is None or c is None:
            return None
        du = math.hypot(b[0] - a[0], b[1] - a[1])
        dv = math.hypot(c[0] - a[0], c[1] - a[1])
        return math.sqrt(du * dv) if (du > 0 and dv > 0) else None


# --------------------------------------------------------------------------- #
# Scale: two independent sources, cross-checked                                 #
# --------------------------------------------------------------------------- #

@dataclass
class ScaleEstimate:
    """
    Metres per pixel, plus how much to trust it.

    Two sources exist because they fail for unrelated reasons, so agreement
    is genuine evidence and disagreement is a reason to withhold a number
    rather than publish it:

      altitude  AGL + FOV. Relative error shrinks with height - +-1.5 m of
                baro drift is 15% at 10 m but 3% at 50 m. Also needs the
                attitude to be roughly right.
      object    a detected vehicle's known class width as a ruler. Flat ~4%
                from model-to-model variation, and completely independent of
                both altitude and attitude.
    """
    m_per_px: float
    source: str                      # "altitude" | "object" | "agreed"
    error_pct: float                 # 1-sigma, percent
    disagreement_pct: Optional[float] = None
    reliable: bool = True
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "m_per_px": round(self.m_per_px, 6),
            "source": self.source,
            "error_pct": round(self.error_pct, 1),
            "disagreement_pct": (round(self.disagreement_pct, 1)
                                 if self.disagreement_pct is not None else None),
            "reliable": self.reliable,
            "note": self.note,
        }


def scale_from_altitude(
    pose: CameraPose, cam: CameraModel, u: float, v: float,
    agl_error_m: float = 1.5,
) -> Optional[ScaleEstimate]:
    g = pose.gsd_at_pixel(cam, u, v)
    if g is None or g <= 0:
        return None
    # Scale is directly proportional to AGL, so the relative altitude error
    # passes through unchanged. This is why the estimate improves with height.
    err = (agl_error_m / pose.agl_m) * 100.0 if pose.agl_m > 0 else 100.0
    return ScaleEstimate(g, "altitude", err)


def scale_from_object_width(
    px_width: float, known_width_m: float, class_variation_pct: float = 4.0,
) -> Optional[ScaleEstimate]:
    """
    The vehicle itself as a ruler.

    Use the extent PERPENDICULAR to the direction of travel - which the
    tracker knows - because width varies least across models (1.70-1.85 m for
    cars, about +-4%) while length varies far more. Measuring along an
    arbitrary axis mixes length into width and the ruler stops being one.
    """
    if px_width <= 1.0 or known_width_m <= 0:
        return None
    return ScaleEstimate(known_width_m / px_width, "object", class_variation_pct)


def resolve_scale(
    from_alt: Optional[ScaleEstimate],
    from_obj: Optional[ScaleEstimate],
    mode: str = "auto",
    max_disagreement_pct: float = 10.0,
) -> Optional[ScaleEstimate]:
    """
    Pick the scale to use. In "auto", both are compared and the tighter wins,
    but a disagreement beyond the threshold marks the result unreliable
    instead of quietly averaging two numbers one of which is wrong.
    """
    if mode == "altitude":
        return from_alt
    if mode == "object":
        return from_obj
    if from_alt is None:
        return from_obj
    if from_obj is None:
        return from_alt

    mean = (from_alt.m_per_px + from_obj.m_per_px) / 2.0
    disagree = abs(from_alt.m_per_px - from_obj.m_per_px) / mean * 100.0 if mean > 0 else 100.0
    best = from_alt if from_alt.error_pct <= from_obj.error_pct else from_obj

    if disagree > max_disagreement_pct:
        return ScaleEstimate(
            best.m_per_px, best.source, max(best.error_pct, disagree),
            disagreement_pct=disagree, reliable=False,
            note=(f"altitude and object scale disagree by {disagree:.0f}% "
                  f"(> {max_disagreement_pct:.0f}%) - check AGL and mount tilt"),
        )
    return ScaleEstimate(
        best.m_per_px, "agreed", min(best.error_pct, disagree if disagree > 0 else best.error_pct),
        disagreement_pct=disagree, reliable=True,
        note=f"two independent sources agree within {disagree:.0f}%",
    )


# --------------------------------------------------------------------------- #
# Construction from settings                                                    #
# --------------------------------------------------------------------------- #

def camera_from_settings(width: int, height: int) -> CameraModel:
    """
    Built from the EFFECTIVE calibration - .env defaults with the operator's
    saved measurements layered on top (vision/calibration.py). Reading
    get_settings() directly here would silently ignore whatever was measured on
    the bench, which is the only source of these numbers that is ever right.
    """
    from app.config import get_settings
    from app.vision.calibration import effective
    cal = effective()
    return CameraModel(
        width=width, height=height,
        hfov_deg=cal["camera_hfov_deg"],
        vfov_deg=cal["camera_vfov_deg"],
        # Distortion is not operator-editable: it comes from an OpenCV
        # checkerboard run, not a tape measure, so it stays in .env.
        distortion=tuple(get_settings().camera_distortion or (0.0,) * 5),
    )


def mount_from_settings() -> MountOffset:
    from app.vision.calibration import effective
    cal = effective()
    return MountOffset(
        tilt_deg=cal["camera_mount_tilt_deg"],
        yaw_deg=cal["camera_mount_yaw_deg"],
        roll_deg=cal["camera_mount_roll_deg"],
    )


def pose_from_telemetry(telemetry: Optional[dict]) -> Optional[CameraPose]:
    """
    Build a pose from a telemetry snapshot dict (TelemetrySnapshot.to_dict()
    shape). Returns None when there is no usable altitude, which is the
    honest answer with no telemetry connected - every metric output should
    then be omitted rather than computed from a default.
    """
    from app.vision.calibration import effective
    cal = effective()
    if not telemetry:
        return None

    pos = telemetry.get("position") or {}
    att = telemetry.get("attitude") or {}
    if cal["agl_source"] == "gps":
        agl = float(pos.get("absolute_altitude_m") or 0.0)
    else:
        # "baro" and "rangefinder" both land on relative_altitude_m for now:
        # PX4 fuses a rangefinder into the local position estimate when one is
        # fitted, so there is no separate field to read.
        agl = float(pos.get("relative_altitude_m") or 0.0)
    agl -= float(cal["agl_offset_m"] or 0.0)
    if agl <= 0.05:
        return None

    return CameraPose(
        agl_m=agl,
        roll_deg=float(att.get("roll_deg") or 0.0),
        pitch_deg=float(att.get("pitch_deg") or 0.0),
        yaw_deg=float(att.get("yaw_deg") or 0.0),
        mount=mount_from_settings(),
    )


# --------------------------------------------------------------------------- #
# Foreshortening                                                                #
# --------------------------------------------------------------------------- #

#: Never inflate a measurement by more than this. Near nadir cos(phi) tends to
#: zero and the correction diverges, so it is capped rather than allowed to
#: fabricate an enormous range error from a subject almost underneath us.
_MAX_FORESHORTEN_GAIN = 4.0


def deforeshorten_size(
    size_ratio: float,
    depression_deg: float,
    reference_depression_deg: float,
) -> float:
    """
    Correct an apparent-size measurement for viewing angle.

    A standing person (or a vehicle's height) is a VERTICAL extent, and the
    projection of a vertical segment shrinks by cos(depression) as the camera
    looks more steeply down on it. Apparent size is therefore

        size  ~  cos(phi) / range

    which is NOT monotonic in range. Substituting range = h/sin(phi) gives
    size ~ sin(2*phi), so apparent size PEAKS at 45 degrees of depression -
    exactly where horizontal distance equals altitude - and falls away on
    both sides.

    WHY THAT IS DANGEROUS AND NOT MERELY INACCURATE
        Past the peak, a subject moving CLOSER looks SMALLER. A distance
        controller reading raw apparent size concludes they are moving away
        and commands forward, which brings them closer still, which shrinks
        them further. It is a positive feedback loop pointed directly at the
        subject. Measured at 6m AGL with a 70deg lens: a person at 6m ahead
        fills 18.0% of frame, at 3m fills 14.4%, at 1m fills 5.8% - so the
        closer they get the harder the drone is told to chase.

    This rescales the measurement to what it WOULD have looked like at the
    reference depression (the mount tilt, i.e. frame centre), which restores
    monotonicity in range and makes the operator's target ratio mean one
    distance instead of two.
    """
    phi = math.radians(max(0.0, min(89.0, depression_deg)))
    ref = math.radians(max(0.0, min(89.0, reference_depression_deg)))
    cos_phi = math.cos(phi)
    if cos_phi <= 1e-6:
        return size_ratio * _MAX_FORESHORTEN_GAIN
    gain = min(math.cos(ref) / cos_phi, _MAX_FORESHORTEN_GAIN)
    return size_ratio * gain


#: Depression angle at which position-based ranging overtakes size-based.
#: Measured against a 2-degree attitude error, the two swap accuracy at almost
#: exactly 45 degrees (position -3.3% vs size -3.6%), so the crossover is put
#: there and the blend is spread either side of it.
_RANGE_BLEND_CENTRE_DEG = 45.0
#: Half-width of the blend band. Wide enough that neither estimate ever
#: switches in abruptly - a step change in the range estimate would show up as
#: a lurch in the distance controller.
_RANGE_BLEND_HALF_WIDTH_DEG = 15.0


def blend_weight_for_position(depression_deg: float) -> float:
    """
    How much to trust POSITION-based range over SIZE-based, 0..1.

    The two ways to get range from one camera fail in opposite directions, and
    measured against a 2 degree attitude error they cross over at 45 degrees:

        depression   position-based   size + foreshortening correction
            15 deg        -11.5%                    -1.0%
            30 deg         -5.6%                    -2.1%
            45 deg         -3.3%                    -3.6%
            60 deg         -1.9%                    -6.1%
            70 deg         -1.2%                    -9.6%

    Shallow (subject far, high in frame) the ray is nearly parallel to the
    ground, so a small attitude error sweeps the intersection a long way -
    position is bad, apparent size is good. Steep (subject close, low in
    frame) the subject is foreshortened hard, so the cos() correction is
    doing most of the work and its own angular error dominates - size is bad,
    position is good.

    Position-based additionally needs ALTITUDE, which on baro drifts +-1.5m;
    at low AGL that is most of the measurement. Hence the blend rather than a
    switch: neither source is trusted alone anywhere.
    """
    lo = _RANGE_BLEND_CENTRE_DEG - _RANGE_BLEND_HALF_WIDTH_DEG
    hi = _RANGE_BLEND_CENTRE_DEG + _RANGE_BLEND_HALF_WIDTH_DEG
    if depression_deg <= lo:
        return 0.0
    if depression_deg >= hi:
        return 1.0
    # Smoothstep, so the weight has no kink at the band edges.
    t = (depression_deg - lo) / (hi - lo)
    return t * t * (3.0 - 2.0 * t)


def size_ratio_from_ground_range(
    slant_range_m: float,
    subject_height_m: float,
    cam: CameraModel,
    frame_height_px: int,
    reference_depression_deg: float,
) -> Optional[float]:
    """
    Convert a range in METRES into the same de-foreshortened size-ratio units
    the distance controller already works in.

    Expressing the position-based estimate in the controller's own units -
    rather than converting the controller to metres - keeps the operator's
    target ratio meaning exactly what it meant before, and keeps this whole
    blend optional: when there is no telemetry the size path is used
    unchanged, as it always was.
    """
    if slant_range_m is None or slant_range_m <= 1e-3 or frame_height_px <= 0:
        return None
    ref = math.radians(max(0.0, min(89.0, reference_depression_deg)))
    return (subject_height_m * cam.fy * math.cos(ref)
            / (slant_range_m * frame_height_px))

"""
Where on the ground is that detection? Pure geometry, no I/O.

Every detection an AI model reports (built-in modes and custom models) is a
box in the picture. To put it on a map we cast a ray from the camera through
one pixel of the box and intersect it with the ground, using the drone's
telemetry snapshotted when the frame was CAPTURED (vision/base.py
FrameContext), never the telemetry of the moment the result came back.

WHICH PIXEL
    detect    the bottom-centre of the box: where the object stands on the
              ground. The box centre would put a standing person a body
              height further away at an oblique angle.
    classify  the frame centre: a whole-frame label has no box, so the best
              we can say is "where the camera was looking".

ASSUMPTIONS (read these before trusting a position)
    1. FLAT GROUND. The ground is a horizontal plane `agl_m` below the camera.
       agl_m comes from a downward rangefinder when one reports a sane value,
       else from relative altitude (above the launch point) minus the terrain
       difference between under-the-drone and the launch point when the
       elevation service has answered for both, else relative altitude as is.
       A hill, a roof or a ditch at the target moves the position along the
       ray by (height difference) * tan(off-nadir angle).
    2. NO LENS DISTORTION. A pinhole camera with square pixels whose
       horizontal field of view is the camera setting. A wide lens with
       barrel distortion pushes edge detections further out than this says.
    3. CAMERA ORIENTATION.
         * gimbal pitch in telemetry (`gimbal.pitch_deg`, world frame,
           stabilised): used as is, airframe roll and pitch ignored;
         * otherwise the per-camera setting (default straight down, -90),
           relative to the airframe, composed with the airframe's attitude
           unless the setting says the camera is stabilised.
       Heading (compass, clockwise from north) rotates everything.
    4. GPS is the camera's position (no lever-arm offset), and the box is
       taken as exact (no detector jitter term).

ACCURACY
    `accuracy_m` is a typical (about one sigma) horizontal error, the root sum
    of squares of these independent terms:
        GPS              hdop * 2.5 m (1.5-15 m), 2.5 m when hdop is unknown
        height error     sigma_h * tan(theta)          along the ray's bearing
        pitch error      h * sigma_a / cos^2(theta)    along the ray's bearing
        sideways error   slant * sigma_a, ground range * sigma_heading
    with theta the ray's angle off straight down, sigma_h 0.3 m (rangefinder)
    or 2 m (barometric / flat-ground), sigma_a 1.5 deg (gimbal), 2 deg
    (stabilised), 3 deg (fixed mount through 4 Hz attitude), plus 2 deg when
    the camera angle is only the default, and sigma_heading 3 deg. It grows
    with altitude and very fast with obliqueness, which is the honest shape.
    At 100 m, frame centre, good GPS: straight down +/-8 m (fixed camera,
    angle set), +/-5.5 m (stabilised), +/-13 m (angle left at the default);
    a forward camera pitched -30 (60 deg off nadir) +/-25.5 m.

REFUSALS (no position rather than a wrong one)
    no_gps        no fix, or a 0,0 position
    no_altitude   height above ground unknown or below 0.5 m
    above_horizon the ray never meets the ground
    too_shallow   the ray meets the ground less than 5 deg below the horizon
                  or more than 3 km away: the error would be larger than the
                  answer is useful
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional

from app.vision.geometry import CameraModel, CameraPose, MountOffset

EARTH_RADIUS_M = 6_378_137.0   # WGS84 equatorial; the local tangent plane uses it

DEFAULT_HFOV_DEG = 80.0
DEFAULT_PITCH_DEG = -90.0      # straight down

MIN_AGL_M = 0.5
MIN_DEPRESSION_DEG = 5.0
MAX_RANGE_M = 3000.0
RANGEFINDER_MAX_M = 50.0       # past this a downward rangefinder reads clutter, not ground

SIGMA_HEADING_DEG = 3.0
SIGMA_ANGLE_DEG = {"gimbal": 1.5, "stabilised": 2.0, "fixed": 3.0}
SIGMA_ANGLE_DEFAULT_EXTRA_DEG = 2.0
SIGMA_H_RANGEFINDER_M = 0.3
SIGMA_H_BARO_M = 2.0


@dataclass(frozen=True)
class CameraSetup:
    """The per-camera setting. pitch_deg is the camera's pitch: 0 level,
    -90 straight down. `source` says where the angle came from ("setting":
    the operator set it, "default": nobody did). `stabilised`: the camera
    stays level by itself, so airframe roll and pitch do not move it."""
    hfov_deg: float = DEFAULT_HFOV_DEG
    pitch_deg: float = DEFAULT_PITCH_DEG
    stabilised: bool = False
    source: str = "default"

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> "CameraSetup":
        d = d or {}
        hfov = _num(d.get("hfov_deg"))
        pitch = _num(d.get("pitch_deg"))
        hfov = DEFAULT_HFOV_DEG if hfov is None else min(170.0, max(10.0, hfov))
        pitch = DEFAULT_PITCH_DEG if pitch is None else min(0.0, max(-90.0, pitch))
        return cls(hfov_deg=hfov, pitch_deg=pitch, stabilised=bool(d.get("stabilised")),
                   source="setting" if d.get("set") else "default")


@dataclass(frozen=True)
class GeoFix:
    lat: float
    lon: float
    accuracy_m: float
    ground_range_m: float      # horizontal distance drone -> point
    off_nadir_deg: float       # ray angle from straight down
    agl_m: float
    height_source: str         # rangefinder | terrain | relative
    angle_source: str          # gimbal | setting | default

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class GeoResult:
    fix: Optional[GeoFix] = None
    reason: Optional[str] = None   # set when fix is None

    @property
    def ok(self) -> bool:
        return self.fix is not None


def _num(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def offset_latlon(lat: float, lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    """Move a WGS84 point by metres north/east on the local tangent plane.
    Good to millimetres over the few hundred metres a camera sees."""
    dlat = math.degrees(north_m / EARTH_RADIUS_M)
    dlon = math.degrees(east_m / (EARTH_RADIUS_M * max(1e-9, math.cos(math.radians(lat)))))
    return lat + dlat, lon + dlon


def has_fix(telemetry: Optional[Dict[str, Any]]) -> bool:
    if not telemetry:
        return False
    pos = telemetry.get("position") or {}
    lat, lon = _num(pos.get("latitude_deg")), _num(pos.get("longitude_deg"))
    if lat is None or lon is None or (lat == 0.0 and lon == 0.0):
        return False
    if abs(lat) > 90 or abs(lon) > 180:
        return False
    gps = telemetry.get("gps") or {}
    # A link that never sent GPS_RAW_INT (some relays) still has a fused
    # global position; only a GPS message that SAYS no 3D fix refuses.
    if gps.get("seen") and int(gps.get("fix_type") or 0) < 3:
        return False
    return True


def gimbal_pitch(telemetry: Optional[Dict[str, Any]]) -> Optional[float]:
    """Gimbal pitch (world frame, degrees, -90 down) when telemetry carries
    one. Nothing on the link reports it today; the key is read so a gimbal
    feed lights up without touching this module."""
    g = (telemetry or {}).get("gimbal") or {}
    return _num(g.get("pitch_deg"))


def height_above_ground(telemetry: Dict[str, Any],
                        terrain_offset_m: Optional[float]) -> tuple[Optional[float], str]:
    """(agl_m, source). terrain_offset_m is ground elevation under the drone
    minus ground elevation at the launch point, when known."""
    rf = _num(telemetry.get("rangefinder_m"))
    if rf is not None and MIN_AGL_M <= rf <= RANGEFINDER_MAX_M:
        return rf, "rangefinder"
    rel = _num((telemetry.get("position") or {}).get("relative_altitude_m"))
    if rel is None:
        return None, "relative"
    if terrain_offset_m is not None and math.isfinite(terrain_offset_m):
        return rel - terrain_offset_m, "terrain"
    return rel, "relative"


def project_pixel(telemetry: Optional[Dict[str, Any]], u: float, v: float,
                  width: int, height: int, camera: CameraSetup = CameraSetup(),
                  terrain_offset_m: Optional[float] = None) -> GeoResult:
    """Pixel (u, v) of a width x height frame -> a GeoResult. See the module
    docstring for every assumption and refusal."""
    if not has_fix(telemetry):
        return GeoResult(reason="no_gps")
    assert telemetry is not None
    if width <= 0 or height <= 0:
        return GeoResult(reason="no_frame")
    agl, h_src = height_above_ground(telemetry, terrain_offset_m)
    if agl is None or agl < MIN_AGL_M:
        return GeoResult(reason="no_altitude")

    pos = telemetry.get("position") or {}
    att = telemetry.get("attitude") or {}
    heading = _num(telemetry.get("heading_deg"))
    if heading is None:
        heading = _num(att.get("yaw_deg")) or 0.0

    g_pitch = gimbal_pitch(telemetry)
    if g_pitch is not None:
        g = telemetry.get("gimbal") or {}
        pose = CameraPose(agl_m=agl, roll_deg=0.0, pitch_deg=0.0,
                          yaw_deg=heading + (_num(g.get("yaw_deg")) or 0.0),
                          mount=MountOffset(tilt_deg=-max(-90.0, min(90.0, g_pitch))))
        angle_src, sigma_a = "gimbal", SIGMA_ANGLE_DEG["gimbal"]
    else:
        roll = 0.0 if camera.stabilised else (_num(att.get("roll_deg")) or 0.0)
        pitch = 0.0 if camera.stabilised else (_num(att.get("pitch_deg")) or 0.0)
        pose = CameraPose(agl_m=agl, roll_deg=roll, pitch_deg=pitch, yaw_deg=heading,
                          mount=MountOffset(tilt_deg=-camera.pitch_deg))
        angle_src = camera.source
        sigma_a = SIGMA_ANGLE_DEG["stabilised" if camera.stabilised else "fixed"]
        if camera.source == "default":
            sigma_a += SIGMA_ANGLE_DEFAULT_EXTRA_DEG

    cam = CameraModel(width=int(width), height=int(height), hfov_deg=camera.hfov_deg)
    d = pose.world_from_camera() @ cam.ray(float(u), float(v))
    down = float(d[2])
    if down <= 1e-6:
        return GeoResult(reason="above_horizon")
    horiz = math.hypot(float(d[0]), float(d[1]))
    depression = math.degrees(math.atan2(down, horiz))
    if depression < MIN_DEPRESSION_DEG:
        return GeoResult(reason="too_shallow")
    t = agl / down
    north, east = t * float(d[0]), t * float(d[1])
    ground_range = math.hypot(north, east)
    if ground_range > MAX_RANGE_M:
        return GeoResult(reason="too_shallow")

    lat, lon = offset_latlon(float(pos["latitude_deg"]), float(pos["longitude_deg"]), north, east)
    theta = math.radians(90.0 - depression)          # off nadir
    hdop = _num((telemetry.get("gps") or {}).get("hdop"))
    acc = accuracy_m(agl=agl, theta_rad=theta, slant_m=t, ground_range_m=ground_range,
                     sigma_h=SIGMA_H_RANGEFINDER_M if h_src == "rangefinder" else SIGMA_H_BARO_M,
                     sigma_a_deg=sigma_a, hdop=hdop)
    return GeoResult(fix=GeoFix(lat=lat, lon=lon, accuracy_m=acc,
                                ground_range_m=round(ground_range, 2),
                                off_nadir_deg=round(math.degrees(theta), 2),
                                agl_m=round(agl, 2), height_source=h_src,
                                angle_source=angle_src))


def gps_sigma(hdop: Optional[float]) -> float:
    if hdop is None or hdop <= 0:
        return 2.5
    return min(15.0, max(1.5, hdop * 2.5))


def accuracy_m(*, agl: float, theta_rad: float, slant_m: float, ground_range_m: float,
               sigma_h: float, sigma_a_deg: float, hdop: Optional[float] = None,
               sigma_heading_deg: float = SIGMA_HEADING_DEG) -> float:
    """Typical horizontal error in metres (see the module docstring),
    rounded up to the next half metre, never under 1 m."""
    sa = math.radians(sigma_a_deg)
    cos2 = max(1e-6, math.cos(theta_rad) ** 2)
    radial = math.hypot(sigma_h * math.tan(theta_rad), agl * sa / cos2)
    cross = math.hypot(slant_m * sa, ground_range_m * math.radians(sigma_heading_deg))
    total = math.sqrt(gps_sigma(hdop) ** 2 + radial ** 2 + cross ** 2)
    return max(1.0, math.ceil(total * 2.0) / 2.0)


def nominal_accuracy_m(agl_m: float, camera: CameraSetup = CameraSetup()) -> Optional[float]:
    """The +/- for the centre of the frame at this height, for the one-line
    explanation the UI shows before anything has been detected."""
    if agl_m is None or agl_m < MIN_AGL_M:
        return None
    theta = math.radians(max(0.0, 90.0 + camera.pitch_deg))   # pitch -90 -> 0 off nadir
    if theta >= math.radians(90.0 - MIN_DEPRESSION_DEG):
        return None
    sa = SIGMA_ANGLE_DEG["stabilised" if camera.stabilised else "fixed"]
    if camera.source == "default":
        sa += SIGMA_ANGLE_DEFAULT_EXTRA_DEG
    gr = agl_m * math.tan(theta)
    return accuracy_m(agl=agl_m, theta_rad=theta, slant_m=agl_m / math.cos(theta),
                      ground_range_m=gr, sigma_h=SIGMA_H_BARO_M, sigma_a_deg=sa)


def box_anchor(box, task: str, width: int, height: int) -> tuple[float, float]:
    """The pixel to project: bottom-centre of a detect box, the frame
    centre for a whole-frame label (classify, or no box)."""
    if task == "classify" or not box or len(box) < 4:
        return width / 2.0, height / 2.0
    x1, y1, x2, y2 = (float(b) for b in box[:4])
    return (x1 + x2) / 2.0, max(y1, y2)

"""The ground fit uses ground within its own range limit (FIT_MAX_GROUND_M),
independent of the obstacle max range. Metric mono models saturate on far
ground: DA3 on the Gazebo world holds one scale to ~60 m and reads at half
that scale beyond (depth bench, 10 m up). Fitting the far ground too either
rejected the frame or locked onto the far scale (obstacles at 2x range)."""
import numpy as np
import pytest

from app.avoidance.sensing import mono_calibration as mc
from app.avoidance.sensing.depth_scan import vfov_for
from app.avoidance.sensing.mono_calibration import ScaleTracker, fit_scale

from avoid_harness import _ground_and_wall


def _da3_like(z_true):
    z = np.where(np.isfinite(z_true), z_true, 0.0)
    return np.where(z <= 60.0, z / 12.0, z / 24.0)      # true scale 12, halved past 60 m


@pytest.mark.parametrize("hfov,h,alt", [(99.7, 480, 15.0), (99.7, 480, 25.0), (69.0, 360, 10.0)])
def test_level_camera_at_altitude_fits_the_near_ground_scale(hfov, h, alt):
    vfov = vfov_for(hfov, 640, h)
    pred = _da3_like(_ground_and_wall(60, 80, hfov, vfov, alt, wall_x=12.0))
    f = fit_scale(pred, hfov, vfov, alt_m=alt)
    assert f is not None and f.scale == pytest.approx(12.0, rel=0.03)


def test_unlimited_fit_locked_onto_the_far_scale(monkeypatch):
    """The pre-fix behaviour, for the record: 69 deg 16:9 camera, 15 m up."""
    hfov, vfov, alt = 69.0, vfov_for(69.0, 640, 360), 15.0
    pred = _da3_like(_ground_and_wall(60, 80, hfov, vfov, alt))
    monkeypatch.setattr(mc, "FIT_MAX_GROUND_M", 1e9)
    f = fit_scale(pred, hfov, vfov, alt_m=alt)
    assert f is not None and f.scale == pytest.approx(24.0, rel=0.03)


def test_no_ground_within_fit_range_is_rejected_with_a_reason():
    hfov, vfov, alt = 69.0, vfov_for(69.0, 640, 360), 25.0  # nearest ground ~66 m
    pred = _da3_like(_ground_and_wall(60, 80, hfov, vfov, alt))
    why = {}
    assert fit_scale(pred, hfov, vfov, alt_m=alt, why=why) is None
    assert why["reason"] == "ground_out_of_range"
    t = ScaleTracker()
    t.update(None, why["reason"])
    t.update(None, "low_alt")
    assert t.status()["rejected_by"] == {"ground_out_of_range": 1, "low_alt": 1}

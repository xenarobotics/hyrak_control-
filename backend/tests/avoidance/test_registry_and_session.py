"""Controller registry, arming rules, and the camera-session -> drone bridge."""
from app.avoidance.core import controller as avoidance
from app.avoidance.core.controller import AvoidanceController, AvoidanceState


def test_arm_requires_enabled():
    c = AvoidanceController("d1")
    c.set_armed(True)
    assert c.armed is False           # cannot arm while detection is off
    c.set_enabled(True); c.set_armed(True)
    assert c.armed is True
    c.set_enabled(False)
    assert c.armed is False           # disabling detection disarms control

def test_any_enabled():
    from app.avoidance.core import controller as service
    assert service.any_enabled() is False
    service.controller("d").set_enabled(True)
    assert service.any_enabled() is True

def test_observe_from_session_feeds_enabled_drone():
    import types
    from app.avoidance.core import loop
    from app.avoidance.core import controller as service
    c = service.controller("droneX"); c.set_enabled(True)
    sess = types.SimpleNamespace(drone={"id": "droneX"})
    loop._session_manager = types.SimpleNamespace(get=lambda sid: sess)
    try:
        loop.observe_from_session("sess1", {"bearing_deg": 0, "distance_m": 6,
                                            "confidence": 0.5, "source": "monocular"})
        near = c.bus.nearest_ahead(cone_deg=60, min_confidence=0.3)
        assert near is not None and abs(near.distance_m - 6) < 0.01
    finally:
        loop._session_manager = None

def test_observe_from_session_ignores_disabled_drone():
    import types
    from app.avoidance.core import loop
    from app.avoidance.core import controller as service
    c = service.controller("droneY")   # NOT enabled
    sess = types.SimpleNamespace(drone={"id": "droneY"})
    loop._session_manager = types.SimpleNamespace(get=lambda sid: sess)
    try:
        loop.observe_from_session("s", {"bearing_deg": 0, "distance_m": 5})
        assert c.bus.nearest_ahead() is None   # nothing fed to a disabled drone
    finally:
        loop._session_manager = None

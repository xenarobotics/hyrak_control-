"""POST /enable must not crash when detection is switched on (it called a
sensing.warm() that the layered cleanup had dropped -> 500, 'Failed to fetch')."""
from app.avoidance.sensing import camera as sensing


def test_enable_route_dependencies_exist():
    assert callable(sensing.warm)


def test_warm_is_a_noop_once_the_model_is_known_bad(monkeypatch):
    monkeypatch.setattr(sensing, "_depth_failed", True)
    called = []
    monkeypatch.setattr(sensing._executor, "submit", lambda *a, **k: called.append(a))
    sensing.warm()
    assert called == []

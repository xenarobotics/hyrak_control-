"""
Shared test setup.

CALIBRATION IS ISOLATED FROM THE REAL FILE, FOR EVERY TEST.

calibration.save() writes to .data/camera_calibration.json — the operator's
actual flying configuration. Tests that exercise a setter which persists (the
crowd density thresholds are the obvious one, but agl_offset_m, camera HFOV and
the mount angles all behave the same way) were writing into it for real.

That is not a theoretical tidiness problem. A test asserting that an inverted
threshold pair gets corrected wrote light_max=30, moderate_max=31 into the live
file and left it there, so simply running the suite silently re-graded every
subsequent flight's crowd density — and the next person to look would have found
thresholds nobody set, with nothing connecting them to a test run.

Autouse and session-scoped: an opt-in fixture only protects the tests that
remember to ask for it, which is precisely the ones that already knew to clean
up after themselves.
"""
import pytest


@pytest.fixture(autouse=True)
def isolated_calibration(tmp_path, monkeypatch):
    """Point calibration at a throwaway file and reset its cache around it."""
    from app.vision import calibration

    monkeypatch.setattr(
        calibration, "CALIBRATION_PATH", str(tmp_path / "camera_calibration.json")
    )
    # The module memoises effective() and invalidates on save(), so the cache
    # has to be dropped on the way IN (it may hold values read from the real
    # file) and on the way OUT (so it cannot leak a test's values into
    # whatever runs next).
    calibration._cache = None
    yield
    calibration._cache = None


@pytest.fixture
def auth_headers(monkeypatch):
    """Bearer headers for a throwaway user of the given role, with the auth
    store forced in-memory (no database): `auth_headers("operator")`."""
    import asyncio
    from app.auth import service

    monkeypatch.setattr(service, "_db_up", lambda: False)
    service.reset_for_tests()

    def _make(role: str = "operator") -> dict:
        async def _mint():
            await service.create_user(f"test-{role}", "test-password-123", role, memory_only=True)
            token, _user, _exp = await service.login(f"test-{role}", "test-password-123", "127.0.0.1")
            return token
        token = asyncio.run(_mint())
        return {"Authorization": f"Bearer {token}"}

    yield _make
    service.reset_for_tests()

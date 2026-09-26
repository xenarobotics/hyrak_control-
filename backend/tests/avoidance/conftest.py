"""Every avoidance test starts from empty controller and pose registries."""
import pytest

from app.avoidance.core import controller as avoidance
from app.avoidance.mapping import pose_history


@pytest.fixture(autouse=True)
def _clean_registries():
    avoidance.reset()
    pose_history.reset()
    yield
    avoidance.reset()
    pose_history.reset()

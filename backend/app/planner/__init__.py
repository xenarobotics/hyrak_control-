"""
Mission path planner - generates a legal, preference-shaped waypoint route
between two points.

    features.py  - land-use overlay engine (what is under the drone)
    profiles.py  - route profiles (how the operator wants to fly over it)
    engine.py    - the cost-field A* planner itself
    service.py   - mission persistence (who/when/which drone/what path)
"""
from app.planner.engine import plan  # noqa: F401
from app.planner.profiles import CATEGORIES  # noqa: F401

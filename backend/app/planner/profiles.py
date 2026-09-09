"""
Route profiles - the preference layer of the mission planner.

A profile is a set of per-category rules over the map-feature overlay:

    prefer  weight < 1   flying over this is cheaper, so the planner will
                         spend real extra metres to stay on it
    avoid   weight > 1   crossing this costs more, so the planner detours
                         around it when the detour is worth it
    block                impassable to the planner (route-shaping only -
                         nothing enforces it in flight; that is what red
                         zones are for)

plus a policy for orange zones and a corner turn radius. Built-in profiles
are seeded into the DB at startup so admins can tune the weights; seeding
never overwrites an existing row, so a tuned builtin stays tuned.
"""
import logging

logger = logging.getLogger("verocore.planner.profiles")

# The category vocabulary map_features rows and profile rules share.
CATEGORIES = (
    "road", "forest", "water", "open_field", "farmland",
    "residential", "hostel", "school", "campus", "industrial",
)

_MODES = ("prefer", "avoid", "block")
_ORANGE_POLICIES = ("allow", "penalize", "block")

# Weight guard rails: a prefer weight of 0.01 would make the planner circle
# the planet to stay on a road; an avoid weight of 10000 is a block that
# lies about being one.
_MIN_WEIGHT, _MAX_WEIGHT = 0.2, 50.0

DEFAULT_ORANGE = {"policy": "penalize", "weight": 4.0}
DEFAULT_TURN_RADIUS_M = 8.0

BUILTIN_PROFILES: list[dict] = [
    {
        "name": "Direct",
        "description": "Shortest legal path. Ignores land use; red zones "
                       "blocked, orange penalised.",
        "rules": {"categories": {}, "orange": DEFAULT_ORANGE},
        "default_alt_m": 10.0,
        "default_speed_m_s": 8.0,
    },
    {
        "name": "Over roads",
        "description": "Follows the road network where reasonable; keeps "
                       "clear of homes and hostels.",
        "rules": {
            "categories": {
                "road":        {"mode": "prefer", "weight": 0.45},
                "residential": {"mode": "avoid",  "weight": 6.0},
                "hostel":      {"mode": "avoid",  "weight": 12.0},
                "school":      {"mode": "avoid",  "weight": 12.0},
            },
            "orange": DEFAULT_ORANGE,
        },
        "default_alt_m": 10.0,
        "default_speed_m_s": 8.0,
    },
    {
        "name": "Unmanned areas",
        "description": "Prefers forests, water and open ground; treats "
                       "hostels as no-go and avoids roads and homes.",
        "rules": {
            "categories": {
                "forest":      {"mode": "prefer", "weight": 0.5},
                "water":       {"mode": "prefer", "weight": 0.6},
                "open_field":  {"mode": "prefer", "weight": 0.6},
                "farmland":    {"mode": "prefer", "weight": 0.7},
                "road":        {"mode": "avoid",  "weight": 2.0},
                "residential": {"mode": "avoid",  "weight": 10.0},
                "hostel":      {"mode": "block"},
                "school":      {"mode": "block"},
            },
            "orange": DEFAULT_ORANGE,
        },
        "default_alt_m": 10.0,
        "default_speed_m_s": 10.0,
    },
    {
        "name": "Hybrid",
        "description": "Roads and unmanned ground both count as good; "
                       "populated areas cost, hostels cost heavily.",
        "rules": {
            "categories": {
                "road":        {"mode": "prefer", "weight": 0.55},
                "forest":      {"mode": "prefer", "weight": 0.55},
                "open_field":  {"mode": "prefer", "weight": 0.65},
                "water":       {"mode": "prefer", "weight": 0.7},
                "residential": {"mode": "avoid",  "weight": 6.0},
                "hostel":      {"mode": "avoid",  "weight": 15.0},
                "school":      {"mode": "avoid",  "weight": 15.0},
            },
            "orange": DEFAULT_ORANGE,
        },
        "default_alt_m": 10.0,
        "default_speed_m_s": 8.0,
    },
]


def validate_rules(rules: dict) -> tuple[bool, str]:
    """Shape-check a rules dict. Returns (ok, error_message)."""
    if not isinstance(rules, dict):
        return False, "rules must be an object"
    cats = rules.get("categories", {})
    if not isinstance(cats, dict):
        return False, "rules.categories must be an object"
    for cat, rule in cats.items():
        if cat not in CATEGORIES:
            return False, f"unknown category '{cat}' (valid: {', '.join(CATEGORIES)})"
        if not isinstance(rule, dict) or rule.get("mode") not in _MODES:
            return False, f"category '{cat}' needs a mode: prefer/avoid/block"
        if rule["mode"] != "block":
            try:
                w = float(rule.get("weight"))
            except (TypeError, ValueError):
                return False, f"category '{cat}' needs a numeric weight"
            if not (_MIN_WEIGHT <= w <= _MAX_WEIGHT):
                return False, (f"category '{cat}' weight {w} outside "
                               f"[{_MIN_WEIGHT}, {_MAX_WEIGHT}]")
            if rule["mode"] == "prefer" and w >= 1.0:
                return False, f"'{cat}': a prefer weight must be < 1.0"
            if rule["mode"] == "avoid" and w <= 1.0:
                return False, f"'{cat}': an avoid weight must be > 1.0"
    orange = rules.get("orange", DEFAULT_ORANGE)
    if not isinstance(orange, dict) or orange.get("policy", "penalize") not in _ORANGE_POLICIES:
        return False, "rules.orange.policy must be allow/penalize/block"
    return True, ""


def resolved_rules(rules: dict | None, overrides: dict | None = None) -> dict:
    """Merge inline overrides onto a profile's rules and normalise the
    result into the exact shape the engine consumes."""
    base = dict(rules or {})
    cats = dict(base.get("categories", {}))
    if overrides:
        for cat, rule in (overrides.get("categories") or {}).items():
            if rule is None:
                cats.pop(cat, None)   # explicit null removes the rule
            else:
                cats[cat] = rule
        if "orange" in overrides:
            base["orange"] = overrides["orange"]
        if "turn_radius_m" in overrides:
            base["turn_radius_m"] = overrides["turn_radius_m"]
    orange = dict(DEFAULT_ORANGE)
    orange.update(base.get("orange") or {})
    return {
        "categories": cats,
        "orange": orange,
        "turn_radius_m": float(base.get("turn_radius_m") or DEFAULT_TURN_RADIUS_M),
    }


async def ensure_builtins() -> None:
    """Seed built-in profiles that don't exist yet. Insert-only: an admin's
    tuning of a builtin is never overwritten by a restart."""
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import RouteProfile

    if not db_available():
        return
    try:
        async with get_session() as db:
            existing = {
                p.name for p in
                (await db.execute(select(RouteProfile))).scalars().all()
            }
            added = 0
            for spec in BUILTIN_PROFILES:
                if spec["name"] in existing:
                    continue
                db.add(RouteProfile(
                    name=spec["name"],
                    description=spec["description"],
                    rules=spec["rules"],
                    default_alt_m=spec["default_alt_m"],
                    default_speed_m_s=spec["default_speed_m_s"],
                    builtin=True,
                ))
                added += 1
            if added:
                await db.commit()
                logger.info(f"Seeded {added} builtin route profiles")
    except Exception as e:
        logger.warning(f"Builtin profile seeding failed: {e}")


async def get_profile(ref: str | None) -> dict | None:
    """Profile by id or (case-insensitive) name. None if DB offline or not
    found - callers fall back to the in-code 'Direct' spec."""
    from sqlalchemy import func, or_, select
    from app.db import db_available, get_session
    from app.db.models import RouteProfile

    if not ref or not db_available():
        return None
    try:
        async with get_session() as db:
            row = (
                await db.execute(
                    select(RouteProfile).where(
                        RouteProfile.active == True,  # noqa: E712
                        or_(RouteProfile.id == ref,
                            func.lower(RouteProfile.name) == ref.lower()),
                    )
                )
            ).scalars().first()
        return row.to_dict() if row else None
    except Exception as e:
        logger.warning(f"Profile lookup failed: {e}")
        return None

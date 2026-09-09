"""
Delivery task layer - the DB-free logic: lifecycle legality, key hygiene,
and what the public /v1 surface is allowed to reveal.
"""
import pytest

from app.api.public import _client_view
from app.tasks import auth as key_auth
from app.tasks import service as task_service


# ── Lifecycle map ────────────────────────────────────────────────────────


def test_every_status_is_known():
    for src, nexts in task_service.ALLOWED_NEXT.items():
        assert src in task_service.STATUSES
        for n in nexts:
            assert n in task_service.STATUSES


def test_terminal_states_have_no_exits():
    for terminal in ("delivered", "returned", "failed", "cancelled"):
        assert task_service.ALLOWED_NEXT[terminal] == set()


def test_happy_path_is_connected():
    path = ["received", "planned", "assigned", "to_pickup",
            "loading", "to_dropoff", "delivered"]
    for a, b in zip(path, path[1:]):
        assert b in task_service.ALLOWED_NEXT[a], f"{a} -> {b} must be legal"


def test_cancel_only_while_grounded():
    for src, nexts in task_service.ALLOWED_NEXT.items():
        if "cancelled" in nexts:
            assert src in ("received", "planned", "assigned"), \
                f"'{src}' is airborne - cancel must not be offered"


def test_airborne_states_can_return():
    for src in ("to_pickup", "loading", "to_dropoff"):
        assert "returned" in task_service.ALLOWED_NEXT[src]


def test_no_status_skips_delivery():
    # delivered is reachable ONLY from to_dropoff - no shortcut from the
    # ground states straight to "delivered".
    sources = [s for s, nxt in task_service.ALLOWED_NEXT.items() if "delivered" in nxt]
    assert sources == ["to_dropoff"]


@pytest.mark.asyncio
async def test_set_status_rejects_unknown():
    task, err = await task_service.set_status("whatever", "teleported")
    assert task is None and "Unknown status" in err


# ── API keys ─────────────────────────────────────────────────────────────


def test_key_hash_is_sha256_and_stable():
    h1 = key_auth.hash_key("hyk_abc")
    assert h1 == key_auth.hash_key("hyk_abc")
    assert len(h1) == 64
    assert h1 != key_auth.hash_key("hyk_abd")


@pytest.mark.asyncio
async def test_verify_rejects_malformed_without_db_lookup():
    assert await key_auth.verify(None) is None
    assert await key_auth.verify("") is None
    assert await key_auth.verify("not-a-hyrak-key") is None


# ── Tenant projection ────────────────────────────────────────────────────


def _full_task() -> dict:
    return {
        "id": "internal-uuid", "order_no": "HYK-00007",
        "client_name": "demo-storefront", "status": "to_dropoff",
        "api_key_id": "key-uuid",
        "pickup": {"pad_id": "pad-1", "name": "Mess-A", "lat": 17.6, "lng": 78.12},
        "dropoff": {"pad_id": "pad-2", "name": "Hostel-C", "lat": 17.61, "lng": 78.13},
        "payload": {"description": "documents", "kg": 0.4},
        "window_start": None, "window_end": None,
        "profile_name": "Hybrid", "mission_id": "mission-uuid",
        "drone_id": "drone-uuid", "fail_reason": "",
        "created_at": "2026-08-25T10:00:00+00:00",
        "updated_at": "2026-08-25T10:05:00+00:00",
        "mission": {"id": "mission-uuid", "status": "flying",
                    "distance_m": 1200.0, "est_duration_s": 190.0,
                    "waypoint_count": 5, "coverage": {},
                    "waypoints": [{"lat": 1, "lng": 2}]},
        "events": [{"t": "2026-08-25T10:00:00+00:00", "status": "received",
                    "note": "", "actor": "client"}],
    }


def test_client_view_hides_flight_internals():
    v = _client_view(_full_task())
    flat = str(v)
    assert "drone" not in flat            # no drone identity
    assert "waypoint" not in flat         # no flight plan
    assert "mission-uuid" not in flat     # no internal ids
    assert "internal-uuid" not in flat
    assert "pad_id" not in flat


def test_client_view_keeps_the_order_story():
    v = _client_view(_full_task())
    assert v["order_no"] == "HYK-00007"
    assert v["status"] == "to_dropoff"
    assert v["pickup"]["name"] == "Mess-A"
    assert v["route"] == {"distance_m": 1200.0, "est_duration_s": 190.0}
    assert v["events"][0]["status"] == "received"

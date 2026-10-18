"""
Every socket handler is classified, and its guard matches its class
(docs/ACCESS_MODEL.md 8a, app/auth/socket_classes.py).

Builds the real server (create_app, no startup, no network) and walks the
handlers socketio actually registered, so an event added anywhere - a new
module, a new namespace - fails here until it is put in the table. The
guard check reads each handler's source: a SESSION_VIEW handler must call
require_session_view, a SESSION_COMMAND handler require_session_fly, a
STAFF handler one of the compatibility-rank guards.
"""
import inspect

import pytest

from app.auth import socket_classes as classes

STAFF_GUARDS = ("require_operator(", "require_admin(", "require_staff(")

# Staff handlers whose check is not a socket_guard call, and why.
STAFF_EXCEPTIONS = {
    # The ground-station relay agent's namespace: connect demands an
    # operator token, every other event only listens to that one socket.
    ("/gs-relay", "connect"): 'has_role("operator")',
    ("/gs-relay", "disconnect"): "gs_relay.get_active()",
    ("/gs-relay", "gs_relay_video"): "gs_relay.get_active()",
    ("/gs-relay", "gs_relay_mavlink_down"): "gs_relay.get_active()",
}


@pytest.fixture(scope="module")
def handlers():
    from app.events import admin_events
    from app.server import create_app
    create_app()
    sio = admin_events._sio
    return {ns: dict(h) for ns, h in sio.handlers.items()}


def test_every_registered_handler_is_classified(handlers):
    missing = [(ns, ev) for ns, evs in handlers.items() for ev in evs
               if classes.classify(ev, ns) is None]
    assert not missing, f"unclassified socket events (add them to app/auth/socket_classes.py): {missing}"


def test_table_has_no_stale_entries(handlers):
    stale = [ev for ev in classes.EVENTS if ev not in handlers.get("/", {})]
    for ns, evs in classes.NAMESPACES.items():
        stale += [f"{ns}:{ev}" for ev in evs if ev not in handlers.get(ns, {})]
    assert not stale, f"classified events with no handler: {stale}"


def test_each_handler_uses_the_guard_of_its_class(handlers):
    wrong = []
    for ns, evs in handlers.items():
        for ev, fn in evs.items():
            cls = classes.classify(ev, ns)
            src = inspect.getsource(fn)
            if cls == classes.LIFECYCLE:
                continue
            if cls == classes.SESSION_VIEW:
                ok = f'require_session_view(sid, "{ev}"' in src
            elif cls == classes.SESSION_COMMAND:
                ok = f'require_session_fly(sid, "{ev}"' in src
            else:
                marker = STAFF_EXCEPTIONS.get((ns, ev))
                ok = (marker in src) if marker else any(g in src for g in STAFF_GUARDS)
                # A staff handler must never be reachable through a session guard.
                ok = ok and "require_session_" not in src
            if not ok:
                wrong.append((ns, ev, cls))
    assert not wrong, f"handlers whose guard does not match their class: {wrong}"


def test_drone_events_and_safety_names():
    assert classes.DRONE_EVENTS <= {e for e, c in classes.EVENTS.items() if c == classes.SESSION_COMMAND}
    # The safety names are real drone_action names.
    from app.events import telemetry_events
    src = inspect.getsource(telemetry_events._execute_drone_action)
    for action in classes.SAFETY_ACTIONS:
        assert f'action == "{action}"' in src
    assert classes.is_safety_action({"action": "land"})
    assert classes.is_safety_action({"action": "set_mode", "mode": "return"})
    assert not classes.is_safety_action({"action": "set_mode", "mode": "OFFBOARD"})
    assert not classes.is_safety_action({"action": "arm"})
    assert not classes.is_safety_action(None)


def test_server_video_sources_match_signaling():
    """The customer-blocked video sources are exactly signaling's
    server-sourced list (the two must not drift)."""
    from app.webrtc import signaling
    src = inspect.getsource(signaling)
    for s in classes.SERVER_VIDEO_SOURCES:
        assert f'"{s}"' in src
    assert "camera" not in classes.SERVER_VIDEO_SOURCES

"""
Every socket event, classified (docs/ACCESS_MODEL.md section 8a).

The live app is default-deny for customers: an event is reachable by a
customer session only if it is listed here as SESSION_VIEW or
SESSION_COMMAND, and its handler starts with the matching guard from
app/auth/socket_guard.py. Everything else is STAFF and keeps the
compatibility rank check it had (require_operator / require_admin, or
require_staff for the formerly ungated viewer-level events).

The rule for STAFF: anything that binds a server port, reaches a shared
server resource (the server-side Gazebo link on udp:14600 or any other
server-reachable address, the fleet, mesh units, the ground-station relay,
video relay ports, the camera wall, the RC monitor, the face gallery, the
3D reconstruction engine, global calibration) or touches another session
or drone. A customer reaches their drone only through links their own
device relays into a per-session loopback bridge (connect_browser_serial:
Web Serial, the desktop's SITL relay on its udp:14540, the desktop's
native serial / RF / SIYI relays), and their video only as a WebRTC
track their browser sends.

tests/test_socket_classes.py registers every handler on a real
socketio.AsyncServer and fails when one is missing from this table, so a
new event cannot ship unclassified.
"""
from __future__ import annotations

LIFECYCLE = "lifecycle"              # connect / disconnect, handled in server.py
SESSION_VIEW = "session_view"        # `view` on the session workspace (staff: signed in)
SESSION_COMMAND = "session_command"  # `fly` on the session workspace (staff: operator)
STAFF = "staff"                      # compatibility rank as before = staff only

CUSTOMER_CLASSES = frozenset({SESSION_VIEW, SESSION_COMMAND})

# Default namespace.
EVENTS: dict[str, str] = {
    "connect": LIFECYCLE,
    "disconnect": LIFECYCLE,

    # ── the session's own video (WebRTC track from the client) ──────────
    "offer": SESSION_VIEW,            # server-sourced videoSource values are staff-only
    "ice_candidate": SESSION_VIEW,
    "stop_stream": SESSION_VIEW,

    # ── the session's own telemetry link ────────────────────────────────
    "connect_browser_serial": SESSION_COMMAND,
    "serial_uplink": SESSION_VIEW,    # bytes into this session's own bridge only
    "disconnect_telemetry": SESSION_VIEW,  # dropping your own link is always allowed
    "fetch_params": SESSION_VIEW,
    "get_param": SESSION_VIEW,

    # ── commands to the session's drone ─────────────────────────────────
    "drone_action": SESSION_COMMAND,
    "drone_command": SESSION_COMMAND,
    "set_param": SESSION_COMMAND,
    "set_tracking": SESSION_COMMAND,
    "set_vehicle_tracking": SESSION_COMMAND,
    "set_follow_vehicle": SESSION_COMMAND,
    "set_follow_person": SESSION_COMMAND,
    "set_multi_follow": SESSION_COMMAND,
    "select_person": SESSION_COMMAND,
    "set_pd_params": SESSION_COMMAND,
    "set_altitude_mode": SESSION_COMMAND,
    "set_altitude_nudge": SESSION_COMMAND,
    "set_tracking_params": SESSION_COMMAND,
    "upload_mission": SESSION_COMMAND,  # phase 2b: customers fly their own plans

    # ── the session's AI pipeline ───────────────────────────────────────
    "set_analysis_mode": SESSION_COMMAND,  # minus CUSTOMER_BLOCKED_MODES
    "set_profile_override": SESSION_COMMAND,
    "set_zone_names": SESSION_COMMAND,
    "set_enhance_params": SESSION_COMMAND,
    "clear_reference": SESSION_COMMAND,

    # ── staff only ──────────────────────────────────────────────────────
    "connect_telemetry": STAFF,       # arbitrary address: server Gazebo udp:14600, LAN, anything
    "connect_rf_bridge": STAFF,       # the one shared RF bridge / ground-station relay
    "start_rc_monitor": STAFF,        # binds a server port, one monitor for the whole server
    "set_gallery_mode": STAFF,        # the face gallery is global
    "enrol_person_live": STAFF,       # writes the global face gallery
    "set_crowd_thresholds": STAFF,    # persisted to the server-wide calibration file
    "allocate_video_relay": STAFF,    # binds a public relay port
    "release_video_relay": STAFF,
    "datachannel_video_offer": STAFF,  # loopback port from a fixed shared pool
    "datachannel_video_stats": STAFF,
    "wall_offer": STAFF,              # mesh unit feeds on server ports
    "wall_ice_candidate": STAFF,
    "wall_close": STAFF,
    "admin_hello": STAFF,
    "watch_session": STAFF,           # another session's telemetry and video
    "unwatch_session": STAFF,
    "request_permit": STAFF,          # swarm / fleet drones; customers use REST /api/permits
    "list_my_permits": STAFF,
    "connect_swarm_relay": STAFF,
    "swarm_relay_uplink": STAFF,
    "scan_swarm_drones": STAFF,
    "set_swarm_mode": STAFF,
    "connect_swarm_drone": STAFF,
    "disconnect_swarm_drone": STAFF,
    "swarm_action": STAFF,
    "swarm_group_action": STAFF,
    "swarm_upload_mission": STAFF,
}

# Other namespaces: the ground-station relay agent (a script, operator token).
NAMESPACES: dict[str, dict[str, str]] = {
    "/gs-relay": {
        "connect": STAFF,
        "disconnect": STAFF,
        "gs_relay_video": STAFF,
        "gs_relay_mavlink_down": STAFF,
    },
}

# SESSION_COMMAND events that act on the vehicle itself (directly, or by
# arming a follow that streams setpoints). These also need drone access:
# `fly` on the drone's own workspace. The rest act on the session's AI
# pipeline only.
DRONE_EVENTS = frozenset({
    "drone_action", "drone_command", "set_param",
    "set_tracking", "set_vehicle_tracking", "set_follow_vehicle", "set_follow_person",
    "set_multi_follow", "select_person", "set_pd_params", "set_altitude_mode",
    "set_altitude_nudge", "set_tracking_params", "upload_mission",
})

# drone_action names that are never refused for a session holding the
# drone's link, whoever owns the drone and whatever the session's perms
# became: hold, return-to-launch, land. Blocking one of these on a link the
# pilot physically holds is worse than any ownership rule.
# Not rtl_home: it takes a caller-chosen altitude (goto_home), so it is a
# goto, not a return; `return` is the parameterless RTL.
SAFETY_ACTIONS = frozenset({"hold", "pause_mission", "return", "land"})
# The same, spelled as a set_mode request.
SAFETY_MODES = frozenset({"HOLD", "RETURN", "LAND"})

# Analysis modes a customer session may not select: the 3D reconstruction
# engine is one sidecar process for the whole server.
CUSTOMER_BLOCKED_MODES = frozenset({"3d-reconstruction"})

# WebRTC videoSource values a customer session may not offer: each one has
# the SERVER open something (an RTSP URL, a shared UDP feed port, a relay
# or DataChannel ingest port). A customer's video is the track their own
# browser sends ("camera", or any other client-side source).
SERVER_VIDEO_SOURCES = frozenset({
    "air_unit_udp", "siyi_rtsp", "rtsp_relay", "rtsp_datachannel",
    "air_unit_datachannel", "air_unit_srt", "air_unit_gst", "hyrak_receiver",
})


def is_safety_action(data) -> bool:
    if not isinstance(data, dict):
        return False
    action = data.get("action")
    if action in SAFETY_ACTIONS:
        return True
    return action == "set_mode" and str(data.get("mode", "")).upper() in SAFETY_MODES


def classify(event: str, namespace: str = "/") -> str | None:
    if namespace == "/":
        return EVENTS.get(event)
    return NAMESPACES.get(namespace, {}).get(event)


def customer_events() -> list[str]:
    return sorted(e for e, c in EVENTS.items() if c in CUSTOMER_CLASSES)

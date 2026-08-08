"""
Tunnels a remote ground-station laptop's wfb-ng UDP streams (video on
127.0.0.1:5600, MAVLink downlink + injected RADIO_STATUS on
127.0.0.1:14550) over Socket.IO instead of rf_bridge.py's assumption that
the backend and the ground station share localhost.

The ground-station laptop is normally behind a home/mobile NAT this server
can't reach inbound, so it dials OUT to us instead — same principle as a
browser's Web Serial radio bridge (serial_bridge.py). See
app/events/gs_relay_events.py for the Socket.IO side (namespace
"/gs-relay") and communication/luckfox_pico_airunit/gs_relay_agent.py for
the standalone script that runs on the ground-station laptop.

We re-inject the tunnelled downlink bytes as real loopback UDP on the
exact ports rf_bridge.py and udp_video_source.py already listen on, so
neither of those needs to know this isn't a co-located wfb_rx — only the
uplink direction (mavsdk -> drone) needs an actual new code path, wired
through rf_bridge.py's set_uplink_sink() hook, since nothing can push
straight back to the ground station's NAT'd local port.

One physical ground station at a time, same scope as rf_bridge.py's own
singleton design.
"""
import logging
import socket

logger = logging.getLogger("verocore.telemetry.gs_relay")

VIDEO_PORT = 5600
MAVLINK_DOWNLINK_PORT = 14550

_active_sid: str | None = None
_inject_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def is_connected() -> bool:
    return _active_sid is not None


def get_active() -> str | None:
    return _active_sid


def set_active(sid: str | None) -> None:
    global _active_sid
    _active_sid = sid


def inject_video(data: bytes) -> None:
    _inject_sock.sendto(data, ("127.0.0.1", VIDEO_PORT))


def inject_mavlink_downlink(data: bytes) -> None:
    _inject_sock.sendto(data, ("127.0.0.1", MAVLINK_DOWNLINK_PORT))

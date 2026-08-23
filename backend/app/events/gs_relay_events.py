"""
Socket.IO endpoint for the ground-station relay agent - a standalone
script (communication/luckfox_pico_airunit/gs_relay_agent.py) run on the
wfb-ng ground-station laptop, not a browser. It dials out to us the same
way a browser does (works through NAT with zero port-forwarding on the
laptop's side) and tunnels wfb-ng's local UDP traffic over this
connection; see app/telemetry/gs_relay.py for why.

Kept on its own namespace ("/gs-relay") rather than the default one so its
connect/disconnect handlers can't collide with server.py's session-per-
browser-connect handlers - this client isn't a session, it's the one
shared RF link every session's air_unit_udp video / connect_rf_bridge
telemetry ultimately reads from.
"""
import logging

from app.config import get_settings
from app.telemetry import gs_relay, rf_bridge

logger = logging.getLogger("verocore.events.gs_relay")

NAMESPACE = "/gs-relay"


def register_gs_relay_events(sio):
    settings = get_settings()

    async def _uplink_sink(data: bytes) -> None:
        sid = gs_relay.get_active()
        if sid:
            await sio.emit("gs_relay_uplink", data, to=sid, namespace=NAMESPACE)

    @sio.event(namespace=NAMESPACE)
    async def connect(sid, environ, auth):
        token = (auth or {}).get("token")
        if token != settings.secret_token:
            logger.warning(f"Rejected gs-relay agent {sid[:8]} - bad token")
            return False
        gs_relay.set_active(sid)
        bridge = await rf_bridge.ensure_started()
        bridge.set_uplink_sink(_uplink_sink)
        logger.info(f"Ground-station relay agent connected: {sid[:8]}")
        return True

    @sio.event(namespace=NAMESPACE)
    async def disconnect(sid):
        if gs_relay.get_active() == sid:
            gs_relay.set_active(None)
            bridge = rf_bridge.get()
            if bridge:
                bridge.set_uplink_sink(None)
            logger.info(f"Ground-station relay agent disconnected: {sid[:8]}")

    @sio.on("gs_relay_video", namespace=NAMESPACE)
    async def on_gs_relay_video(sid, data):
        if sid == gs_relay.get_active() and isinstance(data, (bytes, bytearray)):
            gs_relay.inject_video(bytes(data))

    @sio.on("gs_relay_mavlink_down", namespace=NAMESPACE)
    async def on_gs_relay_mavlink_down(sid, data):
        if sid == gs_relay.get_active() and isinstance(data, (bytes, bytearray)):
            gs_relay.inject_mavlink_downlink(bytes(data))

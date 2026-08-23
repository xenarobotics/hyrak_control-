"""Browser-relayed multi-drone SITL bridge for the cloud deployment.

This is SerialBridge (see serial_bridge.py) generalized from one drone to N.
A client's own PX4 SITL swarm runs entirely on THEIR machine - none of its
UDP traffic is reachable from this server directly, same reason a real
telemetry radio or the air-unit's RF link isn't. A local companion tool
(sitl_relay/swarm_relay.py) binds each drone instance's well-known local
MAVLink port and multiplexes all of them over ONE WebSocket to the browser,
tagging every frame with a 1-byte drone_id header. The browser doesn't
interpret the bytes, it just relays tagged frames to/from this bridge over
socket.io (swarm_relay_uplink / swarm_relay_downlink), and this bridge
demultiplexes them into one loopback UDP endpoint PER DRONE - each endpoint
is exactly what swarm_events.py hands a TelemetryManager, in place of the
direct udpin://0.0.0.0:{port} it uses when SITL runs on this same machine.

    N SITL instances ⇄ swarm_relay.py ⇄ (WS, drone_id-tagged) ⇄ browser
    ⇄ socket.io ⇄ SwarmRelayBridge ⇄ N mavsdk_servers

One bridge per session - each client's swarm is entirely their own, and a
drone_id only needs to be unique WITHIN a session (see the per-session
fleet storage in sessions/manager.py and swarm_events.py).
"""

import asyncio
import logging
import socket
from typing import Optional

logger = logging.getLogger("verocore.telemetry.swarm_relay_bridge")

# One bridge per session. Keyed by session_id.
_bridges: dict[str, "SwarmRelayBridge"] = {}


def _free_udp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _DroneEndpoint(asyncio.DatagramProtocol):
    """One loopback UDP socket for one drone in the bridge's fleet -
    mavsdk_server for this drone connects here exactly as if it were
    talking to a local SITL instance directly."""

    def __init__(self, bridge: "SwarmRelayBridge", drone_id: int):
        self._bridge = bridge
        self.drone_id = drone_id
        self._transport: Optional[asyncio.DatagramTransport] = None
        self.port = _free_udp_port()

    @classmethod
    async def create(cls, bridge: "SwarmRelayBridge", drone_id: int) -> "_DroneEndpoint":
        ep = cls(bridge, drone_id)
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: ep, local_addr=("127.0.0.1", 0)
        )
        ep._transport = transport
        return ep

    def uplink(self, data: bytes) -> None:
        """Relay agent → drone side: bytes read off the client's real SITL
        port, delivered here tagged with this drone_id."""
        if self._transport and not self._transport.is_closing():
            self._transport.sendto(data, ("127.0.0.1", self.port))

    def datagram_received(self, data: bytes, addr) -> None:
        """mavsdk → relay agent side: tag with drone_id and hand to the
        bridge to ship over socket.io."""
        self._bridge._emit_downlink(self.drone_id, bytes(data))

    def close(self) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.close()


class SwarmRelayBridge:
    def __init__(self, sio, socket_id: str):
        self._sio = sio
        self._socket_id = socket_id
        self._drones: dict[int, _DroneEndpoint] = {}

    async def get_or_create_port(self, drone_id: int) -> int:
        """Loopback port THIS drone's TelemetryManager should connect to -
        created on first use, reused after (mirrors SerialBridge.address,
        just one port per drone instead of one for the whole bridge)."""
        ep = self._drones.get(drone_id)
        if ep is None:
            ep = await _DroneEndpoint.create(self, drone_id)
            self._drones[drone_id] = ep
        return ep.port

    def address_for(self, drone_id: int) -> Optional[str]:
        ep = self._drones.get(drone_id)
        return f"udpin://127.0.0.1:{ep.port}" if ep else None

    def uplink(self, drone_id: int, data: bytes) -> None:
        """Relay agent → drone side: raw MAVLink bytes for one drone,
        already de-tagged by the caller."""
        ep = self._drones.get(drone_id)
        if ep:
            ep.uplink(data)

    def _emit_downlink(self, drone_id: int, data: bytes) -> None:
        frame = bytes([drone_id & 0xFF]) + data
        asyncio.create_task(
            self._sio.emit("swarm_relay_downlink", frame, to=self._socket_id)
        )

    def close_drone(self, drone_id: int) -> None:
        ep = self._drones.pop(drone_id, None)
        if ep:
            ep.close()

    def close(self) -> None:
        for ep in self._drones.values():
            ep.close()
        self._drones.clear()


def register_bridge(session_id: str, bridge: SwarmRelayBridge) -> None:
    close_bridge(session_id)
    _bridges[session_id] = bridge


def get_bridge(session_id: str) -> Optional[SwarmRelayBridge]:
    return _bridges.get(session_id)


def close_bridge(session_id: str) -> None:
    bridge = _bridges.pop(session_id, None)
    if bridge:
        bridge.close()
        logger.info(f"Swarm relay bridge closed for session {session_id[:8]}")

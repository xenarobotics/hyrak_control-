"""Browser-serial → mavsdk bridge for the cloud deployment.

The operator's telemetry radio (3DR/SiK) is plugged into THEIR device, not
this server — same model as camera sharing. The browser reads raw MAVLink
bytes with the Web Serial API and relays them over socket.io; this bridge
replays them into a loopback UDP socket that the session's mavsdk_server
listens on, and forwards mavsdk's replies (commands, mission uploads, param
requests) back down the socket for the browser to write out the radio.

    radio ⇄ browser (Web Serial) ⇄ socket.io ⇄ SerialBridge ⇄ mavsdk_server
"""

import asyncio
import logging
import socket
from typing import Optional

logger = logging.getLogger("verocore.telemetry.serial_bridge")

# One bridge per session (one cloud user = one radio). Keyed by session_id.
_bridges: dict[str, "SerialBridge"] = {}


def _free_udp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class SerialBridge(asyncio.DatagramProtocol):
    def __init__(self, sio, socket_id: str):
        self._sio = sio
        self._socket_id = socket_id
        self._transport: Optional[asyncio.DatagramTransport] = None
        # mavsdk_server listens here — loopback only, never exposed.
        self.mavsdk_port = _free_udp_port()

    @classmethod
    async def create(cls, sio, socket_id: str) -> "SerialBridge":
        bridge = cls(sio, socket_id)
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: bridge, local_addr=("127.0.0.1", 0)
        )
        bridge._transport = transport
        return bridge

    @property
    def address(self) -> str:
        """Connection string the TelemetryManager should connect to."""
        return f"udpin://127.0.0.1:{self.mavsdk_port}"

    def uplink(self, data: bytes) -> None:
        """Radio → drone side: browser serial bytes into mavsdk's UDP port."""
        if self._transport and not self._transport.is_closing():
            self._transport.sendto(data, ("127.0.0.1", self.mavsdk_port))

    def datagram_received(self, data: bytes, addr) -> None:
        """mavsdk → radio side: relay to the browser to write out the port."""
        asyncio.create_task(
            self._sio.emit("serial_downlink", bytes(data), to=self._socket_id)
        )

    def close(self) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.close()


def register_bridge(session_id: str, bridge: SerialBridge) -> None:
    close_bridge(session_id)
    _bridges[session_id] = bridge


def get_bridge(session_id: str) -> Optional[SerialBridge]:
    return _bridges.get(session_id)


def close_bridge(session_id: str) -> None:
    bridge = _bridges.pop(session_id, None)
    if bridge:
        bridge.close()
        logger.info(f"Serial bridge closed for session {session_id[:8]}")

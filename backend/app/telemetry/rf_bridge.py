"""
wfb-ng (or any similar) RF link bridge.

The ground-station side receives downlink telemetry on one fixed UDP port
and separately expects uplink commands on a DIFFERENT fixed UDP port — see
communiation/start-gs.sh: wfb_rx delivers drone->GS MAVLink to
127.0.0.1:<downlink_port>, wfb_tx listens on 127.0.0.1:<uplink_port> for
GS->drone MAVLink to transmit over RF. MAVSDK's normal udpin:// "reply to
whoever last sent a packet" can't reach that fixed uplink listener, since
wfb_rx sends from an unrelated ephemeral port — MAVSDK would reply to that,
which nothing is listening on.

This bridge sits in between so MAVSDK only ever needs an ordinary udpin://
connection to its own private loopback port, same trick as serial_bridge.py:

    wfb_rx  -> downlink_port          -> [bridge] -> mavsdk_port (MAVSDK udpin://)
    mavsdk_port (MAVSDK's replies)    -> [bridge] -> uplink_port -> wfb_tx
"""

import asyncio
import logging
import socket
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("verocore.telemetry.rf_bridge")

UplinkSink = Callable[[bytes], Awaitable[None]]

# One physical RF link -> one shared bridge, unlike serial_bridge.py's
# per-session bridges (a browser radio is per-operator; this is one fixed
# ground-station dongle). Persists across connect/disconnect so reconnecting
# telemetry doesn't need to re-bind the fixed downlink port each time.
_bridge: Optional["RFBridge"] = None


def _free_udp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _DownlinkProtocol(asyncio.DatagramProtocol):
    """Bound to the fixed downlink port — everything wfb_rx (and
    wfb_rssi_inject's synthetic RADIO_STATUS packets) sends here gets
    relayed straight into mavsdk's loopback port."""

    def __init__(self, forward):
        self._forward = forward

    def datagram_received(self, data: bytes, addr) -> None:
        self._forward(data)


class RFBridge(asyncio.DatagramProtocol):
    def __init__(self, downlink_port: int, uplink_port: int, uplink_host: str):
        self.downlink_port = downlink_port
        self.uplink_addr = (uplink_host, uplink_port)
        self.mavsdk_port = _free_udp_port()
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._downlink_transport: Optional[asyncio.DatagramTransport] = None
        # Set when the ground station is behind NAT and can't be reached by
        # a raw UDP send to uplink_addr — see app/telemetry/gs_relay.py.
        # None keeps the original co-located behaviour unchanged.
        self._uplink_sink: Optional[UplinkSink] = None

    @classmethod
    async def create(cls, downlink_port: int, uplink_port: int, uplink_host: str) -> "RFBridge":
        bridge = cls(downlink_port, uplink_port, uplink_host)
        loop = asyncio.get_running_loop()
        # Own socket: sends downlink packets on to mavsdk_port, and receives
        # mavsdk's replies back (it auto-targets whoever last sent it a
        # packet, which is always this socket).
        bridge._transport, _ = await loop.create_datagram_endpoint(
            lambda: bridge, local_addr=("127.0.0.1", 0)
        )
        bridge._downlink_transport, _ = await loop.create_datagram_endpoint(
            lambda: _DownlinkProtocol(bridge._relay_downlink),
            local_addr=("0.0.0.0", downlink_port),
        )
        logger.info(
            f"RF bridge up: downlink :{downlink_port} -> mavsdk :{bridge.mavsdk_port}, "
            f"mavsdk uplink -> {uplink_host}:{uplink_port}"
        )
        return bridge

    @property
    def address(self) -> str:
        """Connection string the TelemetryManager should connect to."""
        return f"udpin://127.0.0.1:{self.mavsdk_port}"

    def set_uplink_sink(self, sink: Optional[UplinkSink]) -> None:
        """Redirect mavsdk's outgoing packets through `sink` instead of a
        raw UDP send to uplink_addr — used when wfb_tx isn't reachable
        directly (a remote ground station behind NAT tunnels uplink bytes
        back over Socket.IO instead). Pass None to restore the default."""
        self._uplink_sink = sink

    def _relay_downlink(self, data: bytes) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.sendto(data, ("127.0.0.1", self.mavsdk_port))

    def datagram_received(self, data: bytes, addr) -> None:
        """mavsdk's replies (commands, mission uploads, param requests) —
        relay out to the RF uplink listener (wfb_tx), directly or via the
        uplink sink if one's set."""
        if self._uplink_sink:
            asyncio.ensure_future(self._uplink_sink(data))
        elif self._transport and not self._transport.is_closing():
            self._transport.sendto(data, self.uplink_addr)

    def close(self) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.close()
        if self._downlink_transport and not self._downlink_transport.is_closing():
            self._downlink_transport.close()


async def ensure_started(
    downlink_port: int = 14550, uplink_port: int = 14551, uplink_host: str = "127.0.0.1"
) -> RFBridge:
    """Idempotent for matching ports — returns the existing bridge if
    already running with the same config. Rebinds if the ports changed
    (e.g. edited in Settings), since the downlink port is bound once at
    creation and won't just start listening somewhere new on its own."""
    global _bridge
    if _bridge is not None:
        if (_bridge.downlink_port, _bridge.uplink_addr) == (downlink_port, (uplink_host, uplink_port)):
            return _bridge
        _bridge.close()
        _bridge = None
    _bridge = await RFBridge.create(downlink_port, uplink_port, uplink_host)
    return _bridge


def get() -> Optional[RFBridge]:
    """The running bridge, if any — None if ensure_started() hasn't been called."""
    return _bridge


def stop() -> None:
    global _bridge
    if _bridge:
        _bridge.close()
        _bridge = None
        logger.info("RF bridge stopped")

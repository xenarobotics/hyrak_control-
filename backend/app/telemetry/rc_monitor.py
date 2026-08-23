"""
Raw RC channel telemetry, for the Radio & RC page.

WHY THIS EXISTS AT ALL: MAVSDK's telemetry plugin exposes rc_status
(available + signal strength) and nothing else - the per-channel values that
a stick calibration needs are in the RC_CHANNELS MAVLink message, which
mavsdk_server parses and drops. There is no forwarding option in the bundled
server build, so the only way to see channels is to listen to the MAVLink
stream ourselves.

WHAT THAT MEANS PER LINK TYPE, honestly:
  - UDP (SITL, wfb-ng air unit): PX4 broadcasts the GCS stream to port
    14550; binding it with SO_REUSEADDR/SO_REUSEPORT means we coexist with a
    running QGC instead of fighting it for the socket.
  - Serial (USB FC): mavsdk_server owns the port exclusively and nothing can
    tee it. No channel data - the page says so instead of showing bars that
    never move.

The monitor is passive: it binds, parses, and reports. It never transmits,
so it cannot confuse the autopilot no matter what state it is in.
"""

import asyncio
import logging
import socket
import time
from typing import Callable, Optional

from pymavlink.dialects.v20 import common as mavlink2

logger = logging.getLogger("verocore.rc_monitor")

RC_MONITOR_PORT = 14550
#: Emit at most this often - RC_CHANNELS arrives at up to 50 Hz and the
#: browser needs 10 to animate a stick convincingly.
_EMIT_INTERVAL_S = 0.1
#: After this long with no RC_CHANNELS, report the feed as gone so the page
#: can drop back to its "no live channels on this link" state.
STALE_AFTER_S = 3.0


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, on_bytes: Callable[[bytes], None]):
        self._on_bytes = on_bytes

    def datagram_received(self, data: bytes, addr):
        self._on_bytes(data)


class RcChannelMonitor:
    """Binds a UDP port, parses RC_CHANNELS, and calls back with the values.

    The callback receives {"channels": [...], "count": n, "rssi": x} at most
    10 times a second. Channels are raw PWM microseconds, 0 for unset slots.
    """

    def __init__(self, on_channels: Callable[[dict], None], port: int = RC_MONITOR_PORT):
        self._on_channels = on_channels
        self._port = port
        self._transport: Optional[asyncio.DatagramTransport] = None
        # robust_parsing: a UDP port shared with a GCS sees mid-stream and
        # possibly corrupt packets; the parser must resync, not raise.
        self._parser = mavlink2.MAVLink(None)
        self._parser.robust_parsing = True
        self._last_emit = 0.0
        self.last_seen = 0.0

    @property
    def running(self) -> bool:
        return self._transport is not None

    @property
    def live(self) -> bool:
        return self.running and (time.monotonic() - self.last_seen) < STALE_AFTER_S

    async def start(self) -> bool:
        if self._transport:
            return True
        loop = asyncio.get_running_loop()
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # Share the port with a running QGC rather than losing the race
            # for it - both listeners receive the broadcast stream.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            sock.bind(("0.0.0.0", self._port))
            sock.setblocking(False)
            self._transport, _ = await loop.create_datagram_endpoint(
                lambda: _Proto(self._feed), sock=sock
            )
            logger.info(f"RC channel monitor listening on udp/{self._port}")
            return True
        except OSError as e:
            # Not fatal to anything: the Radio page simply has no live bars.
            logger.warning(f"RC channel monitor could not bind udp/{self._port}: {e}")
            return False

    def stop(self):
        if self._transport:
            self._transport.close()
            self._transport = None

    def _feed(self, data: bytes):
        try:
            msgs = self._parser.parse_buffer(data) or []
        except mavlink2.MAVError:
            return
        for m in msgs:
            if m.get_type() != "RC_CHANNELS":
                continue
            self.last_seen = time.monotonic()
            now = time.monotonic()
            if now - self._last_emit < _EMIT_INTERVAL_S:
                continue
            self._last_emit = now
            count = m.chancount
            channels = [getattr(m, f"chan{i}_raw", 0) for i in range(1, 19)][:max(count, 8)]
            self._on_channels({
                "channels": channels,
                "count": count,
                "rssi": m.rssi,
            })

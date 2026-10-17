"""
Bit-exact video ingestion over a WebRTC DataChannel.

This is the one transport that is BOTH bit-exact and NAT-traversing, which is
why it exists alongside the others (see docs/ARCHITECTURE.md "Secure transport
comparison" and ADR-009).

The problem it solves: aiortc cannot negotiate H.265 over WebRTC. Its entire
video codec table is VP8 and H.264 - there is no HEVC anywhere in the library.
So an H.265 air unit or camera cannot ride a WebRTC media *track* to this
server without being transcoded, which costs a generation of quality and
1.5-2x the bitrate for equal quality. On an RF link that is exactly backwards.

But a DataChannel carries opaque bytes. It does not know or care what codec is
inside, so it sidesteps codec negotiation entirely:

    client: air unit / camera -> RTP/H.265 datagrams
            -> DataChannel (ordered=False, maxRetransmits=0)   [ICE/DTLS/SCTP]
    server: each message -> sendto(127.0.0.1, loopback_port)
            -> udp_video_source.open_air_unit_video(port)      [PyAV/ffmpeg]

The last step is the point: the server ALREADY has a working RTP/H.265 UDP
decoder, used by the `air_unit_udp` source. Writing the datagrams to a loopback
port reuses it unchanged, including its low-latency ffmpeg options.

Measured (2026-07-27, werift -> aiortc, 1200-byte payloads, loopback):

    target      goodput   loss    p50      p95      latency trend
    2 Mbit/s    1.97      0.0%    0.24ms   0.53ms   0.25 -> 0.22
    8 Mbit/s    7.90      0.0%    0.26ms   0.62ms   0.28 -> 0.24
    20 Mbit/s   19.71     0.0%    0.41ms   0.77ms   0.45 -> 0.39
    50 Mbit/s   49.34     0.0%    0.71ms   1.43ms   0.76 -> 0.69

The trend column is what mattered: flat at every rate, so SCTP is not
buffering. That was the concern that gated this design - SCTP's congestion
control is tuned for bulk data, not realtime media, and the fear was it would
queue rather than shed. Note the test was on loopback, so it does NOT cover a
lossy, rate-limited WAN link; the client-side mitigation for that is to watch
its own `bufferedAmount` and drop rather than queue (see
desktop/src/bridges/webrtcSenderBridge.ts).
"""
import asyncio
import logging
import socket

logger = logging.getLogger("verocore.webrtc.datachannel_video_source")

# Distinct from relay_video_source's 5700-5800 so the two can run side by side
# and a stray packet can never be attributed to the wrong ingest.
_LOOPBACK_PORT_BASE = 5800
_LOOPBACK_PORT_LIMIT = 5900


def _free_loopback_port() -> int:
    for port in range(_LOOPBACK_PORT_BASE, _LOOPBACK_PORT_LIMIT):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"no free loopback UDP port in {_LOOPBACK_PORT_BASE}-{_LOOPBACK_PORT_LIMIT}"
    )


class DataChannelIngest:
    """Owns one session's datagram->UDP shim.

    Deliberately holds no decoder: the track is opened separately by
    udp_video_source, so this class stays a pure transport shim and the
    existing H.265 path remains the single place that knows about codecs.
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.loopback_port = _free_loopback_port()
        self.packets = 0
        self.bytes = 0
        self.closed = False
        # The desktop's PeerConnection currently feeding this ingest. Kept
        # HERE, not in a closure, so a re-offer can close the old one and so
        # only the CURRENT pc's failure tears the ingest down (audit B18):
        # the old pc going "closed" after a re-offer used to release the
        # ingest the new pc shared, by session_id.
        self.pc = None
        # SOCK_DGRAM to 127.0.0.1 - connect() once so every send skips route
        # lookup, which matters at thousands of packets/second.
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.connect(("127.0.0.1", self.loopback_port))
        logger.info(
            f"DataChannel ingest for {session_id[:8]} -> udp:127.0.0.1:{self.loopback_port}"
        )

    def feed(self, data: bytes) -> None:
        """Forwards one RTP packet, unchanged, to the loopback decoder.

        Never raises: a malformed or oversized datagram must not tear down the
        DataChannel, because the channel is also carrying the packets that are
        fine. Loss here is equivalent to radio loss, which H.265 already
        tolerates.
        """
        if self.closed:
            return
        try:
            self._sock.send(data)
            self.packets += 1
            self.bytes += len(data)
        except OSError as e:
            # ECONNREFUSED is normal and expected before the decoder has bound
            # the port: the client starts pushing as soon as the channel opens,
            # which is necessarily before open_air_unit_video() has probed the
            # stream. Dropping these is correct - there is no reader yet.
            if self.packets == 0:
                return
            logger.debug(f"datagram forward failed for {self.session_id[:8]}: {e}")

    def stats(self) -> dict:
        return {
            "loopbackPort": self.loopback_port,
            "packets": self.packets,
            "bytes": self.bytes,
        }

    def close(self) -> None:
        """Closes the socket. The PeerConnection is async and is closed by
        release_async(); sync callers get it scheduled on the running loop."""
        if self.closed:
            return
        self.closed = True
        try:
            self._sock.close()
        except OSError:
            pass
        pc, self.pc = self.pc, None
        if pc is not None:
            try:
                asyncio.get_running_loop().create_task(_close_pc(pc))
            except RuntimeError:
                logger.warning(
                    f"DataChannel ingest for {self.session_id[:8]}: no running loop, "
                    f"PeerConnection left for GC"
                )
        logger.info(
            f"DataChannel ingest closed for {self.session_id[:8]} "
            f"({self.packets} packets, {self.bytes / 1e6:.1f} MB)"
        )

    async def attach_pc(self, pc) -> None:
        """Make `pc` the ingest's feeder, closing whichever one came before.
        A re-offer (reconnect, second Start click) keeps the same loopback
        port - the browser is reading it - but must not leave the old
        PeerConnection open and feeding alongside the new one."""
        old, self.pc = self.pc, pc
        if old is not None and old is not pc:
            await _close_pc(old)


async def _close_pc(pc) -> None:
    try:
        await pc.close()
    except Exception as e:
        logger.debug(f"DataChannel pc close failed: {e}")


_ingests: dict[str, DataChannelIngest] = {}


def allocate(session_id: str) -> DataChannelIngest:
    """Idempotent: a re-offer on the same session reuses the live ingest.

    Not a micro-optimisation - allocating a second port would leave the browser
    reading the old one while the client pushed to the new, which presents as
    "connected but permanently black". The relay source had exactly this bug.
    """
    existing = _ingests.get(session_id)
    if existing is not None and not existing.closed:
        return existing
    ingest = DataChannelIngest(session_id)
    _ingests[session_id] = ingest
    return ingest


def get(session_id: str) -> DataChannelIngest | None:
    return _ingests.get(session_id)


def release(session_id: str) -> None:
    ingest = _ingests.pop(session_id, None)
    if ingest is not None:
        ingest.close()


async def release_async(session_id: str) -> None:
    """Release with the PeerConnection closed and awaited, not just scheduled."""
    ingest = _ingests.pop(session_id, None)
    if ingest is None:
        return
    pc, ingest.pc = ingest.pc, None
    if pc is not None:
        await _close_pc(pc)
    ingest.close()


async def release_if_owner(session_id: str, pc) -> bool:
    """Release the session's ingest only if `pc` is the one feeding it.
    The hook for a pc's own state handler: a superseded pc going "closed"
    must not take down the ingest its successor is using."""
    ingest = _ingests.get(session_id)
    if ingest is None or ingest.pc is not pc:
        return False
    await release_async(session_id)
    return True

"""
Server-side ingestion for the desktop app's zero-transcode RTSP relay
(desktop/src/bridges/rtspRelayBridge.ts).

The client can't hand us its camera directly: a SIYI ground unit lives on
its own hotspot at 192.168.144.25, reachable only from the laptop plugged
into it, and that laptop is behind NAT. RTSP is a *pull* protocol, so the
server can never fetch it - the laptop has to push. It pushes the camera's
ORIGINAL bytes (ffmpeg -c copy, no re-encode), so what arrives here is
bit-identical to what the camera produced.

Why there is an ffmpeg subprocess here instead of just handing the URL to
MediaPlayer: PyAV's bundled FFmpeg is built WITHOUT libsrt, so it raises
ProtocolNotFoundError on any srt:// URL - verified, and there is no libsrt
in its av.libs. The system ffmpeg does have SRT. So one `-c copy` ffmpeg
receives the SRT connection and re-emits plain MPEG-TS to loopback UDP,
which PyAV opens happily. That hop is a remux, not a transcode: no decode,
no encode, ~1-5ms, and it reuses exactly the loopback-UDP pattern
udp_video_source.py already proved out.

    laptop --SRT--> [ffmpeg -c copy] --mpegts/UDP--> 127.0.0.1 --> PyAV
"""
import asyncio
import contextlib
import logging
import shutil
import socket
import threading
import time
import subprocess
import uuid
from collections import deque

from aiortc.contrib.media import MediaPlayer

from app.webrtc.live_player import as_live

logger = logging.getLogger("verocore.webrtc.relay_video_source")

# Public listener ports handed out to clients, and the loopback ports used
# for the internal remux hop. Kept in distinct ranges so a stray packet on
# one can never be mistaken for the other while debugging.
#
# 3478, not 9000. Measured 2026-07-31 on the operator's own network: UDP to
# ports 3478 and 8801 reached the relay, while 443 and 9000 were dropped
# before leaving the network - the packets never arrived, with no error
# anywhere. That is an entire class of silent, un-debuggable failure sitting
# on the client's side of the link, where we have no visibility at all.
#
# 3478 is the STUN port. Any network that permits video calling permits it,
# which is exactly the population that would also want to fly a drone over
# the internet. 8801 (Zoom) is the fallback if a network somehow blocks STUN.
#
# The VPS relay's DNAT rule must cover the SAME range - see
# docs/srt-deployment.md and the memory note on the Vultr relay.
_PUBLIC_PORT_BASE = 3478
_PUBLIC_PORT_LIMIT = 3578
_LOOPBACK_PORT_BASE = 5700
_LOOPBACK_PORT_LIMIT = 5800

VALID_TRANSPORTS = ("srt", "tcp", "udp")

# Lines of ffmpeg stderr kept for diagnostics. Bounded so a relay that runs for
# hours and warns steadily cannot grow this without limit.
_STDERR_RING_LINES = 60

# SRT receiver buffer, milliseconds - the window inside which a lost packet can
# be retransmitted, and therefore also a FLOOR on glass-to-glass latency.
#
# SRT's own guidance is 2.5-4x RTT; below ~2.5x there is not enough time for a
# NAK and the resend to complete, so the window costs latency while recovering
# almost nothing. Measured RTT from this machine to a CDN edge is ~35ms (ICMP
# 1.1.1.1 avg 35.7ms, TCP connect to Cloudflare 29ms), which puts the useful
# range at ~90-140ms.
#
# 120 -> 300 -> 150. The 300 was an over-correction and is worth recording as
# such: it was chosen after seeing "RCV-DROPPED … delayed" and corrupt MPEG-TS
# at 120ms, and I attributed that to the window being too small. It was not.
# The corruption came from the desktop pipeline shedding COMPRESSED frames -
# `queue leaky=downstream max-size-time=500ms` on the uplink tee branch, and an
# rtpjitterbuffer running `latency=10 drop-on-latency=true`. Both are fixed
# (desktop 0.1.49), and with an intact stream the window no longer has to
# absorb someone else's bug.
#
# Sized from measurement, not guesswork: the relay is Vultr Bengaluru and ICMP
# RTT from this machine is 41.8ms avg (34.5 min / 49.9 max, 0% loss). SRT wants
# 2.5-4x RTT, so the useful band is ~105-170ms. 150 sits at ~3.6x, which allows
# a NAK plus resend with margin for the max-RTT case.
#
# IMPORTANT - this is a FIXED delay, not a ceiling. SRT delivers via TSBPD
# (timestamp-based packet delivery): every packet is released at a constant
# offset from its send timestamp, so a healthy link does NOT drain the window
# and converge to a lower figure once the stream is stable. Whatever is set
# here is added to the server's view of the world for the whole session. That
# is why lowering it is the single most effective thing available on this path.
#
# It costs the PILOT nothing in air_unit_gst mode - their preview is decoded
# locally off the same GStreamer pipeline and never waits on the uplink. The
# only thing it delays is the server's copy, i.e. how fresh the AI's view is.
DEFAULT_LATENCY_MS = 150


def _free_port(base: int, limit: int, kind: str) -> int:
    """First port in the range nothing is currently bound to. Racy in
    principle; in practice the caller binds within milliseconds and the
    ranges are private to this process."""
    for port in range(base, limit):
        sock_type = socket.SOCK_DGRAM if kind == "udp" else socket.SOCK_STREAM
        with socket.socket(socket.AF_INET, sock_type) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free {kind} port in {base}-{limit}")


def _listen_url(transport: str, port: int, latency_ms: int, passphrase: str = "") -> str:
    if transport == "srt":
        # latency is MICROSECONDS in ffmpeg's libsrt wrapper (default
        # 120000). Both ends should agree; the effective window is the max
        # of the two, so mismatching only ever costs extra delay.
        url = f"srt://0.0.0.0:{port}?mode=listener&latency={latency_ms * 1000}"
        if passphrase:
            # AES on the wire AND admission control in one mechanism.
            #
            # This listener is the only part of the system that must be
            # reachable from the public internet on a raw port - it cannot go
            # through the cloudflared tunnel, which carries no arbitrary UDP.
            # Without a passphrase ffmpeg's SRT listener accepts ANY caller, so
            # anyone who found the open port could inject their own video into
            # an operator's session. `streamid` was already being sent by the
            # client but is NOT checked by the listener, so it authenticated
            # nothing.
            #
            # enforced_encryption=1 makes a caller with no passphrase (or the
            # wrong one) fail the handshake rather than fall back to plaintext.
            url += f"&passphrase={passphrase}&pbkeylen=16&enforced_encryption=1"
        return url
    if transport == "tcp":
        return f"tcp://0.0.0.0:{port}?listen=1"
    return f"udp://0.0.0.0:{port}?fifo_size=1000000&overrun_nonfatal=1"


class RelayIngest:
    """One inbound relay: an ffmpeg listener plus the loopback port its
    remuxed output lands on. Created per session."""

    def __init__(self, session_id: str, transport: str = "srt", latency_ms: int = DEFAULT_LATENCY_MS):
        if transport not in VALID_TRANSPORTS:
            raise ValueError(f"transport must be one of {VALID_TRANSPORTS}, got {transport!r}")
        self.session_id = session_id
        self.transport = transport
        self.latency_ms = latency_ms
        self.token = uuid.uuid4().hex[:12]
        self.public_port = _free_port(
            _PUBLIC_PORT_BASE, _PUBLIC_PORT_LIMIT,
            "udp" if transport in ("srt", "udp") else "tcp",
        )
        self.loopback_port = _free_port(_LOOPBACK_PORT_BASE, _LOOPBACK_PORT_LIMIT, "udp")
        self.proc: subprocess.Popen | None = None
        # Bounded ring of ffmpeg's most recent stderr lines, filled by a
        # draining thread - see _drain_stderr for why a thread is required.
        self._stderr_lines: deque[str] = deque(maxlen=_STDERR_RING_LINES)
        self._stderr_thread: threading.Thread | None = None

    def start(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError(
                "ffmpeg not found on PATH - required to receive the relay uplink "
                "(PyAV's bundled build has no SRT support)."
            )
        args = [
            ffmpeg, "-hide_banner", "-loglevel", "warning",
            "-i", _listen_url(self.transport, self.public_port, self.latency_ms, self.token),
            "-c", "copy",                     # remux only; never re-encode
            "-f", "mpegts",
            f"udp://127.0.0.1:{self.loopback_port}?pkt_size=1316",
        ]
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self._start_stderr_drain()
        logger.info(
            f"Relay ingest for session {self.session_id[:8]} listening "
            f"{self.transport}:{self.public_port} -> loopback udp:{self.loopback_port}"
        )

    def open_track(self, timeout: float = 25.0):
        """aiortc-compatible video track reading the remuxed loopback feed.
        Blocking (ffmpeg probes synchronously) - call via run_in_executor.

        RETRIES until `timeout` rather than opening once. PyAV's open on a
        silent UDP port fails fast with "Immediate exit requested" instead of
        waiting the full timeout, so a single attempt is really a race
        against the laptop: it has to establish SRT and push a first keyframe
        - an internet round trip plus a GOP - before the server looks. That
        race is exactly what was failing. Retrying converts it into a plain
        wait, which is what it should have been."""
        deadline = time.monotonic() + timeout
        attempt = 0
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            attempt += 1
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(
                    f"Relay listener exited before any video arrived. "
                    f"ffmpeg said: {self.stderr_tail().strip() or '(nothing)'}"
                )
            try:
                player = MediaPlayer(
                    f"udp://127.0.0.1:{self.loopback_port}?fifo_size=1000000&overrun_nonfatal=1",
                    options={
                        # Same reasoning as udp_video_source.py: ffmpeg's
                        # defaults buffer for smooth VOD playback, which on a
                        # live feed is just permanent added delay. SRT already
                        # did the reordering/retransmission upstream of this hop.
                        "fflags": "nobuffer",
                        "flags": "low_delay",
                        # 0, not 100000. max_delay is a reorder window, and
                        # the comment above already stated the reason it is
                        # pointless here - SRT delivers in order, by
                        # construction, having already done the retransmission
                        # and resequencing upstream of this hop. Holding
                        # packets another 100ms in case an earlier one is
                        # still in flight is insurance against something that
                        # cannot happen on this transport, and it was pure
                        # added latency on every frame the AI ever sees.
                        "max_delay": "0",
                    },
                    timeout=min(3.0, max(0.5, deadline - time.monotonic())),
                )
                # MPEG-TS is not in aiortc's REAL_TIME_FORMATS, so without
                # this the track is paced against PTS and collapses to ~1 fps
                # against the live-edge skipper. See live_player.py.
                as_live(player, f"relay session {self.session_id[:8]}")
            except Exception as e:
                last_err = e
                time.sleep(0.5)
                continue
            if player.video is None:
                last_err = RuntimeError("stream carried no video")
                time.sleep(0.5)
                continue
            logger.info(
                f"Relay video opened for session {self.session_id[:8]} "
                f"after {attempt} attempt(s)"
            )
            return player.video

        raise RuntimeError(
            f"No video arrived on {self.transport}:{self.public_port} within {timeout:.0f}s. "
            f"The laptop never completed its push - check it is on the camera's network and "
            f"can reach this server on that port. ffmpeg: "
            f"{self.stderr_tail().strip() or '(no output)'} (last: {last_err})"
        )

    def _start_stderr_drain(self) -> None:
        """Continuously reads ffmpeg's stderr into a bounded ring.

        This is NOT just for nicer diagnostics - without it a long-running relay
        eventually HANGS. stderr is a pipe with a ~64KB kernel buffer; once it
        fills, ffmpeg blocks on write() and stops relaying video, silently and
        permanently. The old stderr_tail() only ever read after the process had
        exited (`poll() is not None`), so nothing drained the pipe while it was
        alive: any relay left running long enough to emit 64KB of warnings -
        "Non-monotonous DTS", PES errors, and similar, which a live feed
        produces steadily - would freeze with no error anywhere.

        The desktop side never had this bug: rtspRelayBridge.ts attaches
        `proc.stderr.on('data', ...)` and keeps a 4000-char tail. This is the
        same design, in the shape Python needs - a blocking readline loop, so it
        gets its own daemon thread.
        """
        if not self.proc or not self.proc.stderr:
            return

        stream = self.proc.stderr

        def drain() -> None:
            with contextlib.suppress(Exception):
                for raw in iter(stream.readline, b""):
                    line = raw.decode(errors="replace").rstrip()
                    if line:
                        self._stderr_lines.append(line)
            with contextlib.suppress(Exception):
                stream.close()

        # Daemon: this must never hold up interpreter shutdown, and it ends on
        # its own when ffmpeg exits and the pipe reaches EOF.
        self._stderr_thread = threading.Thread(
            target=drain,
            name=f"relay-stderr-{self.session_id[:8]}",
            daemon=True,
        )
        self._stderr_thread.start()

    def stderr_tail(self) -> str:
        """Most recent ffmpeg output. Works while the process is RUNNING, which
        the previous implementation could not do - and running is exactly when a
        stalled relay needs explaining."""
        return "\n".join(self._stderr_lines)[-500:]

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            with contextlib.suppress(Exception):
                self.proc.wait(timeout=3)
            if self.proc.poll() is None:
                self.proc.kill()
        self.proc = None
        logger.info(f"Relay ingest for session {self.session_id[:8]} closed")


_ingests: dict[str, RelayIngest] = {}


def allocate(session_id: str, transport: str = "srt", latency_ms: int = DEFAULT_LATENCY_MS) -> RelayIngest:
    """Reserve a listener for this session and start ffmpeg waiting on it.

    IDEMPOTENT, and that is load-bearing. This used to release-then-recreate
    unconditionally, which turned every ordinary retry into a self-inflicted
    failure: the client re-runs `allocate` (mode switch, reconnect, a second
    Start click), the old ffmpeg is killed while an earlier `open_track` is
    still blocked reading its loopback port - that read then dies with
    "Immediate exit requested" - and the public port MOVES, so a laptop that
    had already begun pushing to the old port is now talking to nothing.

    An existing, live relay for the same session with the same transport is
    therefore reused as-is. Only a missing or dead one is rebuilt."""
    existing = _ingests.get(session_id)
    if existing is not None:
        alive = existing.proc is not None and existing.proc.poll() is None
        if alive and existing.transport == transport:
            logger.info(
                f"Reusing relay ingest for session {session_id[:8]} "
                f"({transport}:{existing.public_port})"
            )
            return existing
        release(session_id)

    ingest = RelayIngest(session_id, transport=transport, latency_ms=latency_ms)
    ingest.start()
    _ingests[session_id] = ingest
    return ingest


def get(session_id: str) -> RelayIngest | None:
    return _ingests.get(session_id)


def release(session_id: str) -> None:
    ingest = _ingests.pop(session_id, None)
    if ingest:
        ingest.close()


async def release_async(session_id: str) -> None:
    await asyncio.get_event_loop().run_in_executor(None, release, session_id)

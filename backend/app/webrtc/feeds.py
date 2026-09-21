"""Shared air-unit feeds: ONE reader per udp port, two kinds of consumers.

A udp port can be bound by exactly one process, so everything that wants a
unit's video shares one reader per port (port = 5600 + mesh node id, the
unit's identity throughout the app). The reader thread demuxes the RTP/H.265
once and hands out:

  * RAW access units (Annex-B, keyframes carry VPS/SPS/PPS in-band) - for the
    bit-exact path: the browser decodes the unit's own bytes with WebCodecs,
    no re-encode, the picture the gst window shows. subscribe_raw()/unsubscribe_raw().
  * DECODED frames through a MediaRelay track - for WebRTC senders and the
    AI/avoidance pipelines. acquire()/release(), refcounted; the reader stops
    and the port is released when the last consumer lets go.

The reader re-opens its socket on ffmpeg's short I/O timeout instead of
dying: a mesh unit re-parenting through another node goes quiet for tens of
seconds, and a dead reader that still held the port made the next open fail.
"""
from __future__ import annotations

import asyncio
import fractions
import logging
import struct
import threading
import time

import av
from aiortc import MediaStreamTrack
from aiortc.contrib.media import MediaRelay

from app.webrtc.udp_video_source import _sdp_file

logger = logging.getLogger("verocore.webrtc.feeds")

IO_TIMEOUT_S = 3.0          # ffmpeg socket timeout; reader reopens, never dies
QUIET_LOG_S = 60.0          # complain once a minute while a port stays silent
AU_HEADER = struct.Struct(">IBI")   # [uint32 len][uint8 key][uint32 seq] (annexb.ts)


class DecodedTrack(MediaStreamTrack):
    """Latest-frame track fed from the reader thread. Never queues: a slow
    consumer sees the newest frame, not a growing backlog."""
    kind = "video"

    def __init__(self, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._loop = loop
        self._frame = None
        self._event = asyncio.Event()

    def push(self, frame) -> None:            # reader thread
        self._loop.call_soon_threadsafe(self._set, frame)

    def _set(self, frame) -> None:
        self._frame = frame
        self._event.set()

    async def recv(self):
        if self.readyState != "live":
            raise Exception("track ended")
        await self._event.wait()
        self._event.clear()
        return self._frame


def _nal_units(data: bytes):
    """Yield (nal_type, start, end) for every Annex-B NAL in an HEVC access unit."""
    n = len(data)
    i = data.find(b"\x00\x00\x01")
    while i >= 0 and i + 3 < n:
        j = data.find(b"\x00\x00\x01", i + 3)
        s = i - 1 if i > 0 and data[i - 1] == 0 else i
        e = n if j < 0 else (j - 1 if data[j - 1] == 0 else j)
        yield (data[i + 3] >> 1) & 0x3F, s, e
        i = j


class ParamSets:
    """VPS/SPS/PPS as last seen in-band (or from the SDP), so every keyframe
    handed to a raw consumer or a transcoder is self-contained. Some units
    emit an IDR with only SPS+PPS (VPS once per session), and a decoder that
    joins on such an IDR cannot start."""

    VPS, SPS, PPS = 32, 33, 34

    def __init__(self) -> None:
        self.nals: dict[int, bytes] = {}

    def learn_extradata(self, extradata: bytes | None) -> None:
        if extradata and extradata[:3] in (b"\x00\x00\x01", b"\x00\x00\x00"):
            for t, s, e in _nal_units(extradata):
                if t in (self.VPS, self.SPS, self.PPS):
                    self.nals[t] = extradata[s:e]

    def complete(self, au: bytes) -> bytes:
        """Learn parameter sets present in a key AU; prepend the missing ones."""
        present = set()
        for t, s, e in _nal_units(au):
            if t in (self.VPS, self.SPS, self.PPS):
                self.nals[t] = au[s:e]
                present.add(t)
            elif t < 32:
                break                        # first slice: no more parameter sets ahead
        missing = [t for t in (self.VPS, self.SPS, self.PPS) if t not in present and t in self.nals]
        if not missing or not present and not self.nals:
            return au
        return b"".join(self.nals[t] for t in missing) + au


class SharedReader:
    def __init__(self, port: int, loop: asyncio.AbstractEventLoop):
        self.port = port
        self.loop = loop
        self.track = DecodedTrack(loop)
        self.relay = MediaRelay()
        self.refs = 0
        self.raw_subs: list[asyncio.Queue] = []
        self.raw_refs = 0
        self.params = ParamSets()
        self.transcoders: dict[str, "Transcoder"] = {}   # codec -> GPU transcode lane
        self._stop = threading.Event()
        self._seq = 0
        self.last_packet_t = 0.0
        self.last_error = ""
        self.width = self.height = 0
        self._thread = threading.Thread(target=self._run, name=f"feed-{port}", daemon=True)
        self._thread.start()

    # ---- consumers ---------------------------------------------------------
    def subscribe_decoded(self):
        return self.relay.subscribe(self.track)

    def subscribe_raw(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=90)   # ~3 s at 30 fps
        q.wait_key = True                              # start at a keyframe
        self.raw_subs.append(q)
        self.raw_refs += 1
        return q

    def unsubscribe_raw(self, q: asyncio.Queue) -> None:
        if q in self.raw_subs:
            self.raw_subs.remove(q)
            self.raw_refs -= 1

    @property
    def idle(self) -> bool:
        return self.refs <= 0 and self.raw_refs <= 0 and not any(t.subs for t in self.transcoders.values())

    def transcoder(self, codec: str) -> "Transcoder":
        t = self.transcoders.get(codec)
        if t is None or not t.alive:
            t = self.transcoders[codec] = Transcoder(self, codec)
        return t

    def stop(self) -> None:
        self._stop.set()
        self.track.stop()
        for tr in list(self.transcoders.values()):
            tr.stop()

    # ---- reader thread -------------------------------------------------------
    def _deliver_raw(self, data: bytes, key: bool, seq: int) -> None:
        payload = AU_HEADER.pack(len(data), 1 if key else 0, seq & 0xFFFFFFFF) + data
        for q in list(self.raw_subs):
            if getattr(q, "wait_key", False):
                if not key:
                    continue
                q.wait_key = False
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Consumer is behind: drop its backlog and resync on a keyframe.
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.wait_key = True

    def _run(self) -> None:
        opts = {"protocol_whitelist": "file,udp,rtp", "fflags": "nobuffer", "flags": "low_delay",
                "reorder_queue_size": "0", "max_delay": "0"}
        quiet_since = None
        while not self._stop.is_set():
            container = None
            try:
                container = av.open(_sdp_file(self.port), format="sdp", options=opts, timeout=IO_TIMEOUT_S)
                vs = container.streams.video[0]
                cc = vs.codec_context
                cc.thread_type = "AUTO"
                self.params.learn_extradata(getattr(cc, "extradata", None))
                for pkt in container.demux(vs):
                    if self._stop.is_set():
                        break
                    if pkt.pts is None and pkt.dts is None:
                        continue
                    data = bytes(pkt)
                    if not data:
                        continue
                    self.last_packet_t = time.monotonic()
                    quiet_since = None
                    self._seq += 1
                    key = bool(pkt.is_keyframe)
                    if key and (self.raw_subs or self.transcoders):
                        data = self.params.complete(data)
                    if self.raw_subs:
                        self.loop.call_soon_threadsafe(self._deliver_raw, data, key, self._seq)
                    for codec, tr in list(self.transcoders.items()):
                        if not tr.alive:
                            # ffmpeg died (bad first AU, GPU hiccup): restart it for
                            # the subscribers still waiting, at most once a second.
                            if not tr.subs or time.monotonic() - tr.started_at < 1.0:
                                continue
                            nt = Transcoder(self, codec)
                            nt.subs = tr.subs
                            for q in nt.subs:
                                q.wait_key = True
                            tr = self.transcoders[codec] = nt
                        tr.feed(data, key)
                    if self.refs > 0:
                        try:
                            for frame in cc.decode(pkt):
                                if frame.time_base is None:
                                    frame.time_base = fractions.Fraction(1, 90000)
                                self.width, self.height = frame.width, frame.height
                                self.track.push(frame)
                        except av.AVError as e:
                            logger.debug(f"udp:{self.port} decode: {e}")
            except Exception as e:
                if self._stop.is_set():
                    break
                self.last_error = str(e)[:160]
                now = time.monotonic()
                if quiet_since is None:
                    quiet_since = now
                elif now - quiet_since > QUIET_LOG_S:
                    logger.warning(f"udp:{self.port}: no video for {now - quiet_since:.0f}s ({e})")
                    quiet_since = now
                time.sleep(0.3)
            finally:
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
        logger.info(f"Feed reader on udp:{self.port} stopped")


class Transcoder:
    """GPU transcode lane: the unit's H.265 units -> system ffmpeg (NVENC H.264)
    -> framed Annex-B access units for WebCodecs. Used when the browser has no
    HEVC decoder. The colour signalling of the source (full-range BT.709) is
    written into the H.264 VUI explicitly so the browser renders the same
    colours the gst window does - the VP8 WebRTC leg cannot carry it.
    PyAV's bundled ffmpeg has no NVENC, hence a subprocess."""
    ENCODERS = {
        "h264": ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll", "-rc", "cbr", "-b:v", "10M",
                 "-maxrate", "10M", "-bufsize", "2M", "-g", "30", "-forced-idr", "1", "-bf", "0",
                 "-color_range", "pc", "-colorspace", "bt709",
                 "-color_primaries", "bt709", "-color_trc", "bt709",
                 "-bsf:v", "h264_metadata=aud=insert,dump_extra=freq=keyframe", "-f", "h264"],
    }

    # NVDEC in front of NVENC: zero-copy on the GPU and, unlike ffmpeg's
    # frame-threaded software HEVC decoder, no multi-frame output delay.
    # Cleared if a CUDA start ever dies early, so the lane falls back to
    # software decode instead of staying dark.
    cuda_ok = True

    def __init__(self, reader: "SharedReader", codec: str):
        import subprocess, collections
        self.reader = reader
        self.codec = codec
        self.started_at = time.monotonic()
        self.frames_out = 0
        # -probesize 32 matters: with a full probe ffmpeg decodes the first frame in
        # software and builds a yuvj420p filter graph that the CUDA frames then
        # cannot enter ("Impossible to convert between the formats", lane dies).
        hw = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-c:v", "hevc_cuvid"] \
            if Transcoder.cuda_ok else ["-threads", "1"]
        self.subs: list[asyncio.Queue] = []
        self._in = collections.deque(maxlen=120)     # pending input AUs (never blocks the reader)
        self._in_ev = threading.Event()
        self._stop = threading.Event()
        self._seq = 0
        self._started = False
        self._err_n = 0
        self.proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-flags", "low_delay",
             "-probesize", "32", "-analyzeduration", "0"] + hw +
            ["-f", "hevc", "-i", "pipe:0", "-an"] + self.ENCODERS[codec] + ["pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        threading.Thread(target=self._writer, name=f"xcode-in-{reader.port}", daemon=True).start()
        threading.Thread(target=self._parser, name=f"xcode-out-{reader.port}", daemon=True).start()
        threading.Thread(target=self._stderr, name=f"xcode-err-{reader.port}", daemon=True).start()
        logger.info(f"Transcoder {codec} started for udp:{reader.port} (NVENC, {'NVDEC' if Transcoder.cuda_ok else 'sw decode'})")

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None and not self._stop.is_set()

    def feed(self, au: bytes, key: bool) -> None:          # reader thread
        # Begin at a keyframe: a decoder started mid-GOP spends the first
        # second emitting "PPS id out of range" / missing-ref warnings.
        if not self._started:
            if not key:
                return
            self._started = True
        self._in.append(au)
        self._in_ev.set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=90)
        q.wait_key = True
        self.subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self.subs:
            self.subs.remove(q)

    def stop(self) -> None:
        self._stop.set()
        self._in_ev.set()
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass

    def _writer(self) -> None:
        while not self._stop.is_set():
            self._in_ev.wait(1.0)
            self._in_ev.clear()
            while self._in and not self._stop.is_set():
                au = self._in.popleft()
                try:
                    self.proc.stdin.write(au)
                except Exception:
                    self._stop.set()
                    return

    def _stderr(self) -> None:
        for line in iter(self.proc.stderr.readline, b""):
            self._err_n += 1
            # CUDA/NVDEC unavailable or unsupported profile: ffmpeg dies at
            # once. Remember it so the next lane starts in software.
            if Transcoder.cuda_ok and self.frames_out == 0 and time.monotonic() - self.started_at < 5 and \
                    any(k in line for k in (b"cuda", b"CUDA", b"cuvid", b"hwaccel", b"hw_frames_ctx", b"No decoder")):
                Transcoder.cuda_ok = False
                logger.warning(f"xcode udp:{self.reader.port}: CUDA decode unavailable, lanes will use software decode")
            # Genuine loss upstream shows up here too; keep the first few and
            # then one in fifty so a bad link is visible without a flood.
            if self._err_n <= 5 or self._err_n % 50 == 0:
                logger.warning(f"xcode udp:{self.reader.port} ({self._err_n}): {line.decode(errors='replace').strip()[:160]}")

    def _parser(self) -> None:
        # Split the Annex-B output into access units on AUD (NAL 9); a key
        # AU is one containing an IDR slice (NAL 5).
        buf = b""
        au = bytearray()
        key = False
        out = self.proc.stdout
        while not self._stop.is_set():
            chunk = out.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                j = buf.find(b"\x00\x00\x01", 0)
                if j < 0:
                    break
                k = buf.find(b"\x00\x00\x01", j + 3)
                if k < 0:
                    break
                start = j - 1 if j > 0 and buf[j - 1] == 0 else j
                end = k - 1 if buf[k - 1] == 0 else k
                nal = buf[start:end]
                buf = buf[end:]
                ntype = nal[nal.find(b"\x00\x00\x01") + 3] & 0x1F if len(nal) > 4 else 0
                if ntype == 9:                       # AUD: flush the previous AU
                    if au:
                        self._emit(bytes(au), key)
                        au = bytearray(); key = False
                    continue
                if ntype == 5:
                    key = True
                au += nal
        self._stop.set()

    def _emit(self, data: bytes, key: bool) -> None:
        self._seq += 1
        self.frames_out += 1
        payload = AU_HEADER.pack(len(data), 1 if key else 0, self._seq & 0xFFFFFFFF) + data
        self.reader.loop.call_soon_threadsafe(self._fanout, payload, key)

    def _fanout(self, payload: bytes, key: bool) -> None:
        for q in list(self.subs):
            if getattr(q, "wait_key", False):
                if not key:
                    continue
                q.wait_key = False
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.wait_key = True


_feeds: dict[int, SharedReader] = {}
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


def _get_or_start(port: int) -> SharedReader:
    r = _feeds.get(port)
    if r is None:
        r = _feeds[port] = SharedReader(port, asyncio.get_event_loop())
        logger.info(f"Feed reader opened on udp:{port}")
    return r


def _maybe_stop(port: int) -> None:
    r = _feeds.get(port)
    if r is not None and r.idle:
        _feeds.pop(port, None)
        r.stop()
        logger.info(f"Feed reader closed on udp:{port}")


async def acquire(port: int, timeout: float = 5.0):
    """A relay-subscribed DECODED track for this port. `timeout` is how long
    to wait for the first frame before raising - the reader itself never
    gives up on a quiet port."""
    async with _get_lock():
        r = _get_or_start(port)
        r.refs += 1
        sub = r.subscribe_decoded()
    t0 = time.monotonic()
    while r.last_packet_t == 0.0 and time.monotonic() - t0 < timeout:
        await asyncio.sleep(0.1)
    if r.last_packet_t == 0.0:
        err = r.last_error
        await release(port)
        if "Address already in use" in err or "bind failed" in err:
            raise RuntimeError(f"udp:{port} is bound by another program on the ground station "
                               f"(a gst viewer or a measurement tool) - close it, the app must own the port")
        raise RuntimeError(f"No video on udp:{port} within {timeout:.0f}s - is the unit transmitting?"
                           + (f" (reader: {err})" if err else ""))
    return sub


async def release(port: int) -> None:
    async with _get_lock():
        r = _feeds.get(port)
        if r is None:
            return
        r.refs -= 1
        _maybe_stop(port)


async def subscribe_raw(port: int) -> asyncio.Queue:
    async with _get_lock():
        r = _get_or_start(port)
        return r.subscribe_raw()


async def unsubscribe_raw(port: int, q: asyncio.Queue) -> None:
    async with _get_lock():
        r = _feeds.get(port)
        if r is None:
            return
        r.unsubscribe_raw(q)
        _maybe_stop(port)


def open_ports() -> list[int]:
    return sorted(_feeds)


def status(port: int) -> dict | None:
    r = _feeds.get(port)
    if r is None:
        return None
    return {"port": port, "decoded_refs": r.refs, "raw_refs": r.raw_refs,
            "width": r.width, "height": r.height,
            "quiet_s": round(time.monotonic() - r.last_packet_t, 1) if r.last_packet_t else None}


async def subscribe_transcoded(port: int, codec: str) -> asyncio.Queue:
    async with _get_lock():
        r = _get_or_start(port)
        return r.transcoder(codec).subscribe()


async def unsubscribe_transcoded(port: int, codec: str, q: asyncio.Queue) -> None:
    async with _get_lock():
        r = _feeds.get(port)
        if r is None:
            return
        t = r.transcoders.get(codec)
        if t is not None:
            t.unsubscribe(q)
            if not t.subs:
                t.stop()
                r.transcoders.pop(codec, None)
        _maybe_stop(port)

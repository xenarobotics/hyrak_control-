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
import socket
import struct
import threading
import time

import av
from aiortc import MediaStreamTrack
from aiortc.contrib.media import MediaRelay


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

    def __init__(self, on_learn=None) -> None:
        self.nals: dict[int, bytes] = {}
        self.on_learn = on_learn

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
                if self.on_learn is not None:
                    self.on_learn(t, au[s:e])
            elif t < 32:
                break                        # first slice: no more parameter sets ahead
        missing = [t for t in (self.VPS, self.SPS, self.PPS) if t not in present and t in self.nals]
        if not missing or not present and not self.nals:
            return au
        return b"".join(self.nals[t] for t in missing) + au


class HevcDepacketizer:
    """RTP/H.265 (RFC 7798) to Annex-B access units. Single NAL units,
    aggregation packets (48) and fragmentation units (49); an access unit
    ends at the marker bit or at a timestamp change. A sequence gap inside an
    access unit marks it broken and it is dropped rather than handed to a
    decoder as a half picture."""

    def __init__(self) -> None:
        self.ssrc: int | None = None
        self.expected: int | None = None
        self.ts: int | None = None
        self.au = bytearray()
        self.frag = bytearray()
        self.broken = False
        self.key = False
        self.missed = 0
        self.broken_aus = 0
        self.sender_changes = 0
        self.pkts = 0

    def _flush(self):
        out = None
        if self.au and not self.broken:
            out = (bytes(self.au), self.key, self.ts)
        elif self.au:
            self.broken_aus += 1
        self.au = bytearray(); self.frag = bytearray(); self.broken = False; self.key = False
        return out

    def _add_nal(self, nal: bytes) -> None:
        t = (nal[0] >> 1) & 0x3F
        if 16 <= t <= 21:
            self.key = True
        self.au += b"\x00\x00\x00\x01" + nal

    def feed(self, d: bytes):
        """One UDP datagram in; a completed (annexb, key, rtp_ts) out, or None."""
        if len(d) < 14 or d[0] >> 6 != 2:
            return None
        pt = d[1] & 0x7F
        if 200 <= pt <= 204:                    # RTCP on the same port: ignore
            return None
        marker = bool(d[1] & 0x80)
        seq, ts, ssrc = struct.unpack(">HII", d[2:12])
        off = 12 + 4 * (d[0] & 0x0F)            # CSRCs
        if d[0] & 0x10:                         # extension header
            if len(d) < off + 4:
                return None
            off += 4 + 4 * struct.unpack(">H", d[off + 2:off + 4])[0]
        if d[0] & 0x20:                         # padding
            d = d[:len(d) - d[-1]]
        if len(d) <= off + 2:
            return None
        self.pkts += 1
        out = None
        if ssrc != self.ssrc:
            if self.ssrc is not None:
                self.sender_changes += 1
            out = self._flush() if self.au else None
            self.au = bytearray(); self.frag = bytearray(); self.broken = False
            self.ssrc, self.expected, self.ts = ssrc, None, None
            out = None                          # never trust an AU straddling senders
        if self.expected is not None and seq != self.expected:
            gap = (seq - self.expected) & 0xFFFF
            if gap < 0x8000:
                self.missed += gap
                self.broken = True              # something of this AU is gone
            else:
                return None                     # late duplicate / reordered behind: drop
        self.expected = (seq + 1) & 0xFFFF
        if self.ts is not None and ts != self.ts and self.au:
            out = self._flush()                 # sender never set the marker: close on ts change
        self.ts = ts
        pl = d[off:]
        t = (pl[0] >> 1) & 0x3F
        if t == 48:                             # aggregation packet
            i = 2
            while i + 2 <= len(pl):
                n = struct.unpack(">H", pl[i:i + 2])[0]
                nal = pl[i + 2:i + 2 + n]
                if len(nal) == n and n >= 2:
                    self._add_nal(nal)
                i += 2 + n
        elif t == 49:                           # fragmentation unit
            fu = pl[2]
            start, end, ftype = fu & 0x80, fu & 0x40, fu & 0x3F
            if start:
                self.frag = bytearray(bytes([(pl[0] & 0x81) | (ftype << 1), pl[1]]) + pl[3:])
            elif self.frag:
                self.frag += pl[3:]
            else:
                self.broken = True              # middle of a fragment we never saw the start of
            if end and self.frag:
                self._add_nal(bytes(self.frag))
                self.frag = bytearray()
        elif t < 48:
            self._add_nal(pl)
        if marker:
            done = self._flush()
            out = done if done is not None else out
        return out


class SharedReader:
    def __init__(self, port: int, loop: asyncio.AbstractEventLoop):
        self.port = port
        self.loop = loop
        self.track = DecodedTrack(loop)
        self.relay = MediaRelay()
        self.refs = 0
        self.raw_subs: list[asyncio.Queue] = []
        self.raw_refs = 0
        self.params = ParamSets(on_learn=lambda t, nal: _param_memory.setdefault(port, {}).__setitem__(t, nal))
        self.transcoders: dict[str, "Transcoder"] = {}   # codec -> GPU transcode lane
        self._stop = threading.Event()
        self._seq = 0
        self.last_packet_t = 0.0
        self.last_error = ""
        self.width = self.height = 0
        self.depack: HevcDepacketizer | None = None
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
        # One plain UDP socket per port, depacketized here. ffmpeg's SDP/RTP
        # layer was abandoned because it always binds port+1 for RTCP, which is
        # the next air unit's video port (units are 5600+id): the neighbour's
        # packets then land in this reader as "old packets", the neighbour's
        # own reader cannot bind, and a reorder queue of 0 mixed both streams.
        quiet_since = None
        while not self._stop.is_set():
            sock = None
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
                try:
                    sock.bind(("0.0.0.0", self.port))
                except OSError as e:
                    raise RuntimeError(f"bind failed: {e}") from e
                sock.settimeout(IO_TIMEOUT_S)
                self.depack = dp = HevcDepacketizer()
                codec = av.CodecContext.create("hevc", "r")
                codec.thread_type = "AUTO"
                decode_wait_key = True
                self.params.nals.clear()
                for t, nal in (_param_memory.get(self.port) or {}).items():
                    self.params.nals[t] = nal   # last known sets for this port, in-band ones replace them
                last_ssrc = None
                while not self._stop.is_set():
                    try:
                        d = sock.recv(65536)
                    except socket.timeout:
                        now = time.monotonic()
                        if quiet_since is None:
                            quiet_since = now
                        elif now - quiet_since > QUIET_LOG_S:
                            logger.warning(f"udp:{self.port}: no video for {now - quiet_since:.0f}s")
                            quiet_since = now
                        continue
                    quiet_since = None
                    au = dp.feed(d)
                    if dp.ssrc != last_ssrc:
                        if last_ssrc is not None:
                            # New sender: never carry parameter sets or decoder state across.
                            self.params.nals.clear()
                            codec = av.CodecContext.create("hevc", "r")
                            codec.thread_type = "AUTO"
                            decode_wait_key = True
                            logger.info(f"udp:{self.port}: new sender ssrc 0x{dp.ssrc:08X}")
                        last_ssrc = dp.ssrc
                    if au is None:
                        continue
                    data, key, ts = au
                    self.last_packet_t = time.monotonic()
                    self._seq += 1
                    if key:
                        data = self.params.complete(data)
                    if self.raw_subs:
                        self.loop.call_soon_threadsafe(self._deliver_raw, data, key, self._seq)
                    for codec_name, tr in list(self.transcoders.items()):
                        if not tr.alive:
                            # ffmpeg died (bad first AU, GPU hiccup, resolution change):
                            # restart it for the subscribers still waiting, at most once a second.
                            if not tr.subs or time.monotonic() - tr.started_at < 1.0:
                                continue
                            if Transcoder.cuda_ok and tr.frames_out == 0 and tr._cuda_err:
                                Transcoder.cuda_ok = False
                                logger.warning(f"xcode udp:{self.port}: CUDA decode unavailable, lanes will use software decode")
                            nt = Transcoder(self, codec_name)
                            nt.subs = tr.subs
                            for q in nt.subs:
                                q.wait_key = True
                            tr = self.transcoders[codec_name] = nt
                        tr.feed(data, key)
                    if self.refs > 0:
                        if decode_wait_key and not key:
                            continue
                        decode_wait_key = False
                        try:
                            pkt = av.Packet(data)
                            pkt.pts = pkt.dts = ts
                            pkt.time_base = fractions.Fraction(1, 90000)
                            for frame in codec.decode(pkt):
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
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:
                        pass
        logger.info(f"Feed reader on udp:{self.port} stopped")


def _h264_has_idr(au: bytes) -> bool:
    i = au.find(b"\x00\x00\x01")
    while i >= 0 and i + 3 < len(au):
        if au[i + 3] & 0x1F == 5:
            return True
        i = au.find(b"\x00\x00\x01", i + 3)
    return False


HEVC_AUD = b"\x00\x00\x00\x01\x46\x01\x50"     # NAL 35, pic_type any


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
                 # nvenc buffers (surfaces - 1) frames of output unless told not to
                 "-delay", "0", "-zerolatency", "1",
                 "-color_range", "pc", "-colorspace", "bt709",
                 "-color_primaries", "bt709", "-color_trc", "bt709",
                 "-bsf:v", "h264_metadata=aud=insert,dump_extra=freq=keyframe",
                 # Every packet written and flushed on its own, inside a RIFF
                 # chunk that carries its length: the parser hands a frame on
                 # as soon as its last byte is in, not when the next one starts.
                 "-flush_packets", "1", "-f", "avi"],
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
        # A mid-stream resolution change kills the lane the same way; the
        # reader restarts it at the next keyframe.
        # Measured on this lane, 1080p30 in -> H.264 out, AU in to AU out:
        # hwaccel cuda 37 ms, software 44 ms (0.4 core), hevc_cuvid 70 ms.
        hw = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] \
            if Transcoder.cuda_ok else ["-threads", "1"]
        self.subs: list[asyncio.Queue] = []
        self._in = collections.deque(maxlen=120)     # pending input AUs (never blocks the reader)
        self._in_ev = threading.Event()
        self._stop = threading.Event()
        self._seq = 0
        self._started = False
        self._err_n = 0
        self._cuda_err = False
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
        # The raw HEVC demuxer only knows an access unit ended when the next
        # one starts (a frame of delay). An access-unit delimiter after each
        # AU closes it immediately.
        self._in.append(au + HEVC_AUD)
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
            if any(k in line for k in (b"cuda", b"CUDA", b"cuvid", b"hwaccel", b"hw_frames_ctx", b"No decoder")):
                self._cuda_err = True
            # Genuine loss upstream shows up here too; keep the first few and
            # then one in fifty so a bad link is visible without a flood.
            if self._err_n <= 5 or self._err_n % 50 == 0:
                logger.warning(f"xcode udp:{self.reader.port} ({self._err_n}): {line.decode(errors='replace').strip()[:160]}")

    def _parser(self) -> None:
        # Walk the AVI (RIFF) stream ffmpeg writes: descend into LIST chunks,
        # every '00dc' chunk is one complete H.264 access unit (Annex B, AUD
        # first, SPS/PPS repeated on keyframes). A key AU contains an IDR
        # slice (NAL 5).
        buf = b""
        started = False
        out = self.proc.stdout
        while not self._stop.is_set():
            chunk = out.read1(65536) if hasattr(out, "read1") else out.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                if not started:
                    if len(buf) < 12:
                        break
                    if buf[:4] != b"RIFF":
                        logger.error(f"xcode udp:{self.reader.port}: unexpected output header {buf[:4]!r}")
                        self._stop.set()
                        return
                    buf = buf[12:]
                    started = True
                if len(buf) < 8:
                    break
                cid = buf[:4]
                ln = struct.unpack("<I", buf[4:8])[0]
                if cid == b"LIST":
                    if len(buf) < 12:
                        break
                    buf = buf[12:]
                    continue
                need = 8 + ln + (ln & 1)
                if len(buf) < need:
                    break
                if cid == b"00dc" and ln > 0:
                    au = buf[8:8 + ln]
                    self._emit(au, _h264_has_idr(au))
                buf = buf[need:]
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
# port -> {nal_type: Annex-B NAL}: the last VPS/SPS/PPS seen on that port. Survives
# reader reopens and sender restarts; only ever replaced by a newer in-band set.
_param_memory: dict[int, dict[int, bytes]] = {}
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


def _port_holder(port: int) -> str:
    """Who holds a UDP port on this machine, in words an operator can act on."""
    import subprocess
    try:
        out = subprocess.run(["ss", "-lunpH", f"sport = :{port}"], capture_output=True,
                             text=True, timeout=2).stdout
        import re
        m = re.search(r'users:\(\("([^"]+)",pid=(\d+)', out)
        if not m:
            return "another program"
        name, pid = m.group(1), m.group(2)
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            cmd = ""
        if name == "ffmpeg" and "/dev/video" in cmd:
            return ("the desktop app's Native air-unit video bridge (virtual webcam) - "
                    "Settings > Native air-unit video bridge > Stop")
        if name.startswith("gst"):
            return f"a GStreamer viewer ({name}, pid {pid})"
        return f"{name} (pid {pid})"
    except Exception:
        return "another program"


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
            raise RuntimeError(f"udp:{port} is already in use on the ground station by {_port_holder(port)} "
                               f"- stop it, the app must own the port")
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
    dp = getattr(r, "depack", None)
    return {"port": port, "decoded_refs": r.refs, "raw_refs": r.raw_refs,
            "width": r.width, "height": r.height,
            "quiet_s": round(time.monotonic() - r.last_packet_t, 1) if r.last_packet_t else None,
            "ssrc": f"0x{dp.ssrc:08X}" if dp and dp.ssrc is not None else None,
            "packets": dp.pkts if dp else 0, "missed_packets": dp.missed if dp else 0,
            "dropped_aus": dp.broken_aus if dp else 0, "sender_changes": dp.sender_changes if dp else 0}


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

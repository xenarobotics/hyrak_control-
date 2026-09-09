"""ffmpeg-backed ingest for RTSP, UDP/SRT MPEG-TS, local files and V4L2.

Frames are decoded by a child ffmpeg process and piped in as raw RGB24. NVDEC
(`h264_cuvid` / `hevc_cuvid` / `av1_cuvid`) is used when available, which keeps
1080p30 decode off the CPU entirely and leaves those 24 cores for tracking.

A reader thread drains the pipe continuously. This matters: for a live RTSP or
UDP stream the kernel socket buffer is small, and any hesitation in reading
shows up as decoder desync and macroblock corruption, not as a tidy backlog.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
import threading
import time
from collections import deque
from typing import Optional

import numpy as np

from ..config import Config
from .base import FrameSource

log = logging.getLogger(__name__)

_CUVID = {"h264": "h264_cuvid", "hevc": "hevc_cuvid", "av1": "av1_cuvid"}


class FFmpegSource(FrameSource):
    def __init__(self, cfg: Config) -> None:
        super().__init__(cfg)
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._child_lock = threading.Lock()
        self._codec = "h264"
        self._reconnectable = False
        self.reconnects = 0
        self._spawned_at = time.monotonic()
        self._buf: deque[np.ndarray] = deque(maxlen=4)
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._eof = threading.Event()
        self._w = 0
        self._h = 0
        self._src_fps = 0.0
        self._frame_bytes = 0
        self._replay_clock: Optional[float] = None
        self._stderr_tail: deque[str] = deque(maxlen=40)
        #: Live transports drop stale frames to stay at the live edge. A file
        #: replayed without `-re` decodes as fast as the disk allows, so the same
        #: policy would throw away nearly the whole recording -- an offline run
        #: must see every frame, so the reader blocks instead.
        self._lossless = False

    # -- probing ------------------------------------------------------------

    def _probe(self) -> dict:
        """Ask ffprobe for geometry/codec so we can size the pipe reads exactly."""
        uri = self.src.uri
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,codec_name,avg_frame_rate,r_frame_rate",
            "-of", "json",
        ]
        if self.src.kind == "rtsp":
            cmd += ["-rtsp_transport", "tcp"]
        if self.src.kind == "v4l2":
            cmd += ["-f", "v4l2"]
        if self.src.kind == "http":
            cmd += ["-analyzeduration", "5000000"]
        cmd += [uri]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            streams = json.loads(out.stdout or "{}").get("streams") or []
            if streams:
                return streams[0]
            log.warning("ffprobe returned no video stream: %s", (out.stderr or "").strip()[:300])
        except subprocess.TimeoutExpired:
            log.warning("ffprobe timed out on %s; falling back to configured geometry", uri)
        except Exception as exc:  # noqa: BLE001
            log.warning("ffprobe failed (%s); falling back to configured geometry", exc)
        return {}

    @staticmethod
    def _parse_fps(value: str | None) -> float:
        if not value or "/" not in value:
            return 0.0
        num, den = value.split("/", 1)
        try:
            den_f = float(den)
            return float(num) / den_f if den_f else 0.0
        except ValueError:
            return 0.0

    # -- lifecycle ----------------------------------------------------------

    def open(self) -> None:
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not found on PATH")

        self._lossless = (self.src.kind == "file" and not self.src.realtime_replay)
        info = self._probe()
        self._w = int(info.get("width") or self.cfg.camera.width)
        self._h = int(info.get("height") or self.cfg.camera.height)
        codec = info.get("codec_name") or (
            self.src.codec if self.src.codec != "auto" else "h264"
        )
        self._src_fps = self._parse_fps(info.get("avg_frame_rate")) or self._parse_fps(
            info.get("r_frame_rate")
        ) or self.src.target_fps
        self._frame_bytes = self._w * self._h * 3
        if self._frame_bytes <= 0:
            raise RuntimeError("could not determine stream geometry")

        # A file replayed without -re runs as fast as it decodes, so its frames
        # must be timestamped from the stream's own frame rate.
        self._use_media_time = (self.src.kind == "file" and not self.src.realtime_replay)
        self._media_fps = self._src_fps or self.src.target_fps or 30.0

        self._codec = codec
        self._reconnectable = (self.src.kind in ("rtsp", "udp", "http")
                               and self.src.reconnect_window_s > 0)
        log.info("ffmpeg ingest %dx%d %s @%.2ffps", self._w, self._h, codec, self._src_fps)
        self._spawn()

    def _spawn(self) -> None:
        """Start (or restart) the decoder child and its service threads."""
        cmd = self._build_command(self._codec)
        log.debug("ffmpeg cmd: %s", " ".join(cmd))
        with self._child_lock:
            if self._closed:
                raise RuntimeError("source closed")
            self._eof.clear()
            self._spawned_at = time.monotonic()
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            self._reader = threading.Thread(
                target=self._read_loop, args=(self._proc,),
                name="ffmpeg-reader", daemon=True)
            self._reader.start()
            self._stderr_thread = threading.Thread(
                target=self._drain_stderr, args=(self._proc,),
                name="ffmpeg-stderr", daemon=True)
            self._stderr_thread.start()

    def _stop_child(self) -> None:
        """Terminate the decoder, join its threads, and close its pipes.

        The joins and pipe closes matter: without them every reconnect (and
        every session, via close()) leaked two threads and two file
        descriptors per ffmpeg child.
        """
        with self._child_lock:
            proc, reader, drainer = self._proc, self._reader, self._stderr_thread
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                log.warning("ffmpeg did not terminate; killing")
                proc.kill()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        for t in (reader, drainer):
            if t is not None and t.is_alive() and t is not threading.current_thread():
                t.join(timeout=3)
        if proc is not None:
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError:
                        pass

    def _build_command(self, codec: str) -> list[str]:
        src = self.src
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]

        if src.kind == "rtsp":
            # TCP avoids the packet loss that shreds UDP RTSP over wifi; the
            # low-delay flags keep us near the live edge instead of buffering.
            cmd += ["-rtsp_transport", "tcp", "-fflags", "nobuffer",
                    "-flags", "low_delay", "-max_delay", "500000"]
        elif src.kind == "udp":
            cmd += ["-fflags", "nobuffer", "-flags", "low_delay"]
        elif src.kind == "http":
            # MJPEG-over-HTTP, as served by phone-camera apps (DroidCam on
            # :4747/video, IP Webcam on :8080/video) and many IP cameras.
            # Reconnect flags matter here: a phone drops the connection whenever
            # it changes network state, and without these ffmpeg simply exits.
            cmd += ["-fflags", "nobuffer", "-flags", "low_delay",
                    "-reconnect", "1", "-reconnect_streamed", "1",
                    "-reconnect_delay_max", "5"]
        elif src.kind == "v4l2":
            # Ask for MJPEG explicitly. Left to itself ffmpeg picks the first
            # advertised format, which on most UVC webcams is raw YUYV -- and raw
            # 4:2:2 saturates USB bandwidth, capping 720p at 10 fps and 1080p at
            # about 5. MJPEG delivers the sensor's full 30 fps, and NVDEC can
            # decode it. Falls back automatically if the camera lacks MJPEG.
            cmd += ["-f", "v4l2"]
            if _v4l2_has_mjpeg(src.uri):
                cmd += ["-input_format", "mjpeg"]
            # Loopback devices (v4l2loopback, as used by DroidCam and OBS) take
            # whatever the writer sends and reject attempts to set the rate --
            # ffmpeg fails with "the driver does not permit changing the time
            # per frame" and exits rather than falling back. Only real capture
            # hardware gets an explicit framerate.
            if not _is_loopback(src.uri):
                cmd += ["-framerate", str(int(src.target_fps or 30))]
            cmd += ["-video_size", f"{self._w}x{self._h}"]
        elif src.kind == "file":
            if src.loop:
                cmd += ["-stream_loop", "-1"]
            if src.realtime_replay:
                # Pace the file at its native rate so the pipeline sees the same
                # timing a live link would produce.
                cmd += ["-re"]

        # Hardware decode. Raw (non-cuvid) inputs like v4l2 have nothing to accelerate.
        if src.hwaccel and src.kind != "v4l2":
            dec = _CUVID.get(codec)
            if dec and _decoder_available(dec):
                cmd += ["-hwaccel", "cuda", "-c:v", dec]
            else:
                log.info("NVDEC decoder for %s unavailable; using CPU decode", codec)

        cmd += ["-i", src.uri]
        if src.target_fps and src.kind not in ("file", "folder"):
            cmd += ["-r", str(src.target_fps)]
        cmd += ["-an", "-sn", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        return cmd

    def _drain_stderr(self, proc: subprocess.Popen) -> None:
        """Keep ffmpeg's stderr drained; a full pipe would deadlock the child."""
        if proc is None or proc.stderr is None:
            return
        for line in iter(proc.stderr.readline, b""):
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self._stderr_tail.append(text)
                log.debug("ffmpeg: %s", text)

    @staticmethod
    def _read_exact(stream, nbytes: int, closed) -> Optional[bytes]:
        """Read exactly `nbytes`, or None at end of stream.

        The pipe is opened unbuffered (`bufsize=0`) so frames are handed over the
        moment ffmpeg emits them, which means `stdout` is a *raw* stream: one
        `read()` is one `read(2)` syscall and returns at most a pipe buffer --
        64 KiB on Linux. A single 640x360 RGB frame is 691 KiB and a 1080p frame
        is 6 MiB, so a naive `read(frame_bytes)` always comes back short and
        looks exactly like end-of-stream. Loop until the frame is complete.
        """
        buf = bytearray(nbytes)
        view = memoryview(buf)
        got = 0
        while got < nbytes:
            if closed():
                return None
            chunk = stream.read(nbytes - got)
            if not chunk:
                return None          # genuine EOF
            view[got:got + len(chunk)] = chunk
            got += len(chunk)
        return bytes(buf)

    def _read_loop(self, proc: subprocess.Popen) -> None:
        """Read fixed-size frames off the pipe as fast as they arrive."""
        assert proc is not None and proc.stdout is not None
        stdout = proc.stdout
        nbytes = self._frame_bytes
        try:
            while not self._closed:
                chunk = self._read_exact(stdout, nbytes, lambda: self._closed)
                if chunk is None:
                    break
                frame = np.frombuffer(chunk, dtype=np.uint8).reshape(self._h, self._w, 3)
                with self._cv:
                    if self._lossless:
                        # Offline replay: wait for the consumer rather than drop.
                        while len(self._buf) >= self._buf.maxlen and not self._closed:
                            self._cv.wait(0.1)
                        if self._closed:
                            break
                    # For live sources the maxlen deque discards the oldest
                    # automatically: staying at the live edge beats delivering
                    # stale frames in order.
                    self._buf.append(frame)
                    self._cv.notify_all()
        except Exception as exc:  # noqa: BLE001
            log.error("ffmpeg read loop failed: %s", exc)
        finally:
            self._eof.set()
            with self._cv:
                self._cv.notify_all()
            rc = proc.poll()
            if rc not in (0, None) and self._stderr_tail:
                log.error("ffmpeg exited %s: %s", rc, " | ".join(list(self._stderr_tail)[-3:]))

    #: Minimum time a freshly-spawned decoder gets to deliver its FIRST frame.
    #: A mid-stream network join must sync the transport stream and wait for a
    #: keyframe before anything decodes -- killing the child on the ordinary
    #: stall timeout starved every reconnect attempt right before it succeeded.
    STARTUP_GRACE_S = 10.0

    def _first_frame_deadline(self, stall: float) -> float:
        return max(time.monotonic() + stall,
                   self._spawned_at + max(stall, self.STARTUP_GRACE_S))

    def _read(self) -> Optional[np.ndarray]:
        stall = max(self.src.stall_timeout_s, 1.0)
        # An offline replay must never be declared stalled: the reader is simply
        # blocked waiting for this consumer.
        deadline = (float("inf") if self._lossless
                    else self._first_frame_deadline(stall))
        while True:
            with self._cv:
                while not self._buf:
                    if self._closed:
                        return None
                    if self._eof.is_set() or time.monotonic() > deadline:
                        break
                    self._cv.wait(0.1)
                if self._buf:
                    # Copy out of the shared buffer: the caller keeps the array,
                    # and the backing bytes are only borrowed from the pipe read.
                    frame = np.array(self._buf.popleft(), copy=True)
                    self._cv.notify_all()   # wake a blocked lossless reader
                    return frame

            # Decoder died or the link has been quiet past the stall budget.
            if self._closed or not self._reconnectable:
                if not self._eof.is_set():
                    log.warning("no frame for %.1fs; declaring stream stalled",
                                self.src.stall_timeout_s)
                return None
            if not self._reconnect():
                return None
            deadline = self._first_frame_deadline(stall)

    def _reconnect(self) -> bool:
        """Bounded reconnect-with-backoff for a dropped network link.

        RF video links drop routinely; ending the session (and auto-exporting
        a fragment) on every dropout would break the flagship scenario. The
        session instead rides the gap: the tracker coasts to LOST, and once
        frames return, relocalization re-anchors the pose. Returns True when
        frames are flowing again, False when the window is exhausted (the
        session then ends exactly as an un-recovered stall always did).
        """
        window = self.src.reconnect_window_s
        t0 = time.monotonic()
        attempt = 0
        log.warning("%s stream lost; reconnecting for up to %.0fs",
                    self.src.kind, window)
        while not self._closed and time.monotonic() - t0 < window:
            attempt += 1
            self._stop_child()
            delay = min(5.0, 0.5 * (2 ** (attempt - 1)))
            end = time.monotonic() + delay
            while time.monotonic() < end:
                if self._closed:
                    self._stop_child()
                    return False
                time.sleep(0.1)
            try:
                self._spawn()
            except Exception as exc:  # noqa: BLE001
                log.warning("reconnect attempt %d: could not restart decoder (%s)",
                            attempt, exc)
                continue
            # Give this attempt long enough to sync + reach a keyframe.
            probe_end = time.monotonic() + self.STARTUP_GRACE_S
            with self._cv:
                while (not self._buf and not self._closed
                       and not self._eof.is_set()
                       and time.monotonic() < probe_end):
                    self._cv.wait(0.2)
                if self._buf:
                    self.reconnects += 1
                    log.info("stream reconnected after %.1fs (attempt %d)",
                             time.monotonic() - t0, attempt)
                    return True
        if not self._closed:
            log.error("could not reconnect within %.0fs; ending the session",
                      window)
        # A close() that raced an attempt may have missed the child spawned
        # after its _stop_child ran; reap it here.
        self._stop_child()
        return False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop_child()
        with self._cv:
            self._cv.notify_all()

    @property
    def stats(self) -> dict:
        s = super().stats
        s["reconnects"] = self.reconnects
        return s


_loopback_cache: dict[str, bool] = {}


def _is_loopback(device: str) -> bool:
    """Is this a virtual v4l2 loopback rather than real capture hardware?

    Real capture devices hang off a bus and expose a `device` link in sysfs;
    loopback devices are created by a kernel module and have none.
    """
    if device not in _loopback_cache:
        name = Path(device).name
        sysfs = Path("/sys/class/video4linux") / name
        try:
            _loopback_cache[device] = sysfs.exists() and not (sysfs / "device").exists()
        except OSError:
            _loopback_cache[device] = False
    return _loopback_cache[device]


_mjpeg_cache: dict[str, bool] = {}


def _v4l2_has_mjpeg(device: str) -> bool:
    """Does this V4L2 device advertise an MJPEG format?"""
    if device not in _mjpeg_cache:
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-f", "v4l2", "-list_formats", "all",
                 "-i", device],
                capture_output=True, text=True, timeout=10,
            )
            _mjpeg_cache[device] = "mjpeg" in (out.stderr + out.stdout).lower()
        except Exception:  # noqa: BLE001
            _mjpeg_cache[device] = False
    return _mjpeg_cache[device]


_decoder_cache: dict[str, bool] = {}


def _decoder_available(name: str) -> bool:
    """Check once whether this ffmpeg build has the given decoder."""
    if name not in _decoder_cache:
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-decoders"],
                capture_output=True, text=True, timeout=15,
            ).stdout
            _decoder_cache[name] = name in out
        except Exception:  # noqa: BLE001
            _decoder_cache[name] = False
    return _decoder_cache[name]

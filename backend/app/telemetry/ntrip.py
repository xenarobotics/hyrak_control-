"""NTRIP client: RTK corrections from a caster to the aircraft's GPS.

QGroundControl's "RTK / NTRIP" feature, server side. The cloud is the
companion computer, so the corrections are fetched here and forwarded down
the session's own MAVLink link as GPS_RTCM_DATA, exactly as QGC forwards
them from the ground station.

  1. TCP (optionally TLS) to the caster, an NTRIP v1 style request:
         GET /<mountpoint> HTTP/1.0
         User-Agent: NTRIP HYRAK/1.0
         Authorization: Basic <user:password>
     The answer is "ICY 200 OK" (v1) or "HTTP/1.x 200 OK" (v2, possibly
     chunked); "SOURCETABLE 200 OK" means the mountpoint does not exist,
     401 means the credentials were refused.
  2. The byte stream is cut into RTCM3 frames (preamble 0xD3, 10-bit
     length, CRC-24Q checked), so a frame never straddles two messages and
     a corrupted one is dropped rather than forwarded.
  3. Each frame goes out as GPS_RTCM_DATA. Up to 180 bytes fit in one
     message (flags = sequence id << 3); a longer frame is fragmented per the
     MAVLink spec: flags bit 0 = fragmented, bits 1-2 fragment id (0-3), bits
     3-7 sequence id, at most 4 fragments (720 bytes). A frame longer than
     that cannot be sent and is counted as dropped. Same layout QGC's
     RTCMMavlink uses.
  4. Optionally an NMEA GGA with the aircraft's position every 10 s, which
     VRS / network mountpoints need to compute corrections for the rover.

CREDENTIALS. The username and password live only in the NtripClient object
for as long as it runs, in memory, for the one session that started it. They
are never logged (the Authorization header is built at connect time and
never stored; __repr__ and status() leave them out) and are dropped when the
client stops.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import ssl
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("verocore.ntrip")

RTCM_PREAMBLE = 0xD3
MAX_FRAGMENT = 180
MAX_FRAGMENTS = 4
GGA_INTERVAL_S = 10.0
READ_TIMEOUT_S = 30.0       # a caster that goes quiet this long is reconnected
CONNECT_TIMEOUT_S = 10.0
RECONNECT_S = (2.0, 5.0, 10.0, 30.0)


# ── RTCM3 framing ───────────────────────────────────────────────────────────

def _crc24q_table() -> list[int]:
    table = []
    for i in range(256):
        crc = i << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
        table.append(crc & 0xFFFFFF)
    return table


_CRC_TABLE = _crc24q_table()


def crc24q(data: bytes) -> int:
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFF) ^ _CRC_TABLE[((crc >> 16) ^ b) & 0xFF]
    return crc


def rtcm_frame(payload: bytes) -> bytes:
    """A complete RTCM3 frame around `payload` (for tests and fakes)."""
    if len(payload) > 1023:
        raise ValueError("RTCM3 payload is at most 1023 bytes")
    head = bytes([RTCM_PREAMBLE, (len(payload) >> 8) & 0x03, len(payload) & 0xFF])
    body = head + payload
    c = crc24q(body)
    return body + bytes([(c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF])


def rtcm_message_type(frame: bytes) -> Optional[int]:
    if len(frame) < 6:
        return None
    return (frame[3] << 4) | (frame[4] >> 4)


class RtcmParser:
    """Cuts a byte stream into CRC-checked RTCM3 frames. Garbage between
    frames (a caster banner, a half frame after a reconnect) is skipped."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.bad_crc = 0

    def feed(self, data: bytes) -> list[bytes]:
        self._buf.extend(data)
        out: list[bytes] = []
        buf = self._buf
        while True:
            i = buf.find(bytes([RTCM_PREAMBLE]))
            if i < 0:
                buf.clear()
                break
            if i:
                del buf[:i]
            if len(buf) < 3:
                break
            length = ((buf[1] & 0x03) << 8) | buf[2]
            total = 3 + length + 3
            if len(buf) < total:
                break
            frame = bytes(buf[:total])
            c = (frame[-3] << 16) | (frame[-2] << 8) | frame[-1]
            if crc24q(frame[:-3]) == c:
                out.append(frame)
                del buf[:total]
            else:
                # Not a frame start after all: skip this 0xD3, resync.
                self.bad_crc += 1
                del buf[:1]
        if len(buf) > 8192:          # never grow without bound on a junk stream
            del buf[:-1100]
        return out


# ── GPS_RTCM_DATA ───────────────────────────────────────────────────────────

def rtcm_messages(frame: bytes, seq: int) -> list[dict]:
    """GPS_RTCM_DATA field dicts for one frame; [] if it is too long."""
    seq &= 0x1F
    if len(frame) < MAX_FRAGMENT:
        return [{"flags": seq << 3, "len": len(frame), "data": list(frame) + [0] * (MAX_FRAGMENT - len(frame))}]
    parts = [frame[i:i + MAX_FRAGMENT] for i in range(0, len(frame), MAX_FRAGMENT)]
    if len(parts) > MAX_FRAGMENTS:
        return []
    out = []
    for frag_id, part in enumerate(parts):
        out.append({
            "flags": 1 | (frag_id << 1) | (seq << 3),
            "len": len(part),
            "data": list(part) + [0] * (MAX_FRAGMENT - len(part)),
        })
    return out


# ── Caster protocol ─────────────────────────────────────────────────────────

class NtripError(Exception):
    """A caster answer the pilot can act on. str() is the sentence to show."""


def build_request(mountpoint: str, username: str, password: str, host: str) -> bytes:
    lines = [
        f"GET /{mountpoint} HTTP/1.0",
        f"Host: {host}",
        "User-Agent: NTRIP HYRAK/1.0",
        "Accept: */*",
        "Connection: close",
    ]
    if username or password:
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        lines.append(f"Authorization: Basic {token}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


def parse_response_head(head: bytes) -> bool:
    """Check the caster's status line and headers. Returns True when the body
    is HTTP chunked. Raises NtripError otherwise."""
    text = head.decode("latin-1", "replace")
    first = text.split("\r\n", 1)[0].strip()
    up = first.upper()
    if up.startswith("SOURCETABLE"):
        raise NtripError("The caster does not have that mountpoint (it sent its source table). Check the mountpoint name")
    if up.startswith("ICY 200"):
        return False
    parts = first.split()
    if len(parts) >= 2 and parts[0].upper().startswith("HTTP/") and parts[1].isdigit():
        code = int(parts[1])
        if code == 200:
            if "content-type: gnss/sourcetable" in text.lower():
                raise NtripError("The caster does not have that mountpoint (it sent its source table). Check the mountpoint name")
            return "transfer-encoding: chunked" in text.lower()
        if code == 401:
            raise NtripError("The caster refused the username or password (401)")
        if code == 404:
            raise NtripError("The caster does not have that mountpoint (404)")
        # Status code only: the peer's own words are not echoed back, so the
        # client cannot be used to read banners off arbitrary servers.
        raise NtripError(f"The caster refused the connection (HTTP {code})")
    raise NtripError("That address did not answer like an NTRIP caster. Check the host and port")


class ChunkDecoder:
    """HTTP/1.1 chunked transfer decoding, incremental.

    Bounded: a chunk-size line longer than MAX_SIZE_LINE or a chunk bigger
    than MAX_CHUNK is a broken or hostile peer, not a caster."""

    MAX_SIZE_LINE = 64
    MAX_CHUNK = 1 << 20

    def __init__(self) -> None:
        self._buf = bytearray()
        self._left = 0          # bytes left in the current chunk
        self._crlf = 0          # CRLF after a chunk still to skip

    def feed(self, data: bytes) -> bytes:
        self._buf.extend(data)
        out = bytearray()
        while self._buf:
            if self._crlf:
                n = min(self._crlf, len(self._buf))
                del self._buf[:n]
                self._crlf -= n
                continue
            if self._left:
                n = min(self._left, len(self._buf))
                out.extend(self._buf[:n])
                del self._buf[:n]
                self._left -= n
                if self._left == 0:
                    self._crlf = 2
                continue
            i = self._buf.find(b"\r\n")
            if i < 0:
                if len(self._buf) > self.MAX_SIZE_LINE:
                    raise NtripError("The caster sent a malformed stream")
                break
            if i > self.MAX_SIZE_LINE:
                raise NtripError("The caster sent a malformed stream")
            size = self._buf[:i].split(b";")[0].strip()
            del self._buf[:i + 2]
            try:
                self._left = int(size or b"0", 16)
            except ValueError:
                raise NtripError("The caster sent a malformed stream") from None
            if self._left > self.MAX_CHUNK:
                raise NtripError("The caster sent a malformed stream")
            if self._left == 0:
                self._crlf = 2
        return bytes(out)


def nmea_gga(lat: float, lon: float, alt_m: float, sats: int, fix: int, now: Optional[float] = None) -> str:
    """$GPGGA sentence with checksum, for VRS mountpoints."""
    t = time.gmtime(now if now is not None else time.time())
    def dm(v: float, deg_digits: int) -> str:
        a = abs(v)
        d = int(a)
        m = (a - d) * 60.0
        return f"{d:0{deg_digits}d}{m:07.4f}"
    q = 4 if fix >= 6 else 5 if fix == 5 else 2 if fix == 4 else 1 if fix >= 2 else 0
    body = (f"GPGGA,{t.tm_hour:02d}{t.tm_min:02d}{t.tm_sec:02d}.00,"
            f"{dm(lat, 2)},{'N' if lat >= 0 else 'S'},{dm(lon, 3)},{'E' if lon >= 0 else 'W'},"
            f"{q},{max(0, min(99, int(sats))):02d},1.0,{alt_m:.1f},M,0.0,M,,")
    cs = 0
    for ch in body:
        cs ^= ord(ch)
    return f"${body}*{cs:02X}\r\n"


# ── Client ──────────────────────────────────────────────────────────────────

@dataclass
class NtripConfig:
    host: str
    port: int
    mountpoint: str
    username: str = field(default="", repr=False)
    password: str = field(default="", repr=False)
    tls: bool = False
    send_gga: bool = False


def validate_config(data: dict) -> NtripConfig:
    """Raise ValueError with a sentence for anything unusable."""
    if not isinstance(data, dict):
        raise ValueError("Enter the caster details")
    host = str(data.get("host", "")).strip()
    if "://" in host:
        host = host.split("://", 1)[1]
    host = host.strip("/")
    if not host or len(host) > 253 or any(c in host for c in " /\\@?#"):
        raise ValueError("Enter the caster host name, without http:// or a path")
    try:
        port = int(data.get("port", 2101))
    except (TypeError, ValueError):
        raise ValueError("The port must be a number") from None
    if not 1 <= port <= 65535:
        raise ValueError("The port must be between 1 and 65535")
    mount = str(data.get("mountpoint", "")).strip().lstrip("/")
    if not mount or len(mount) > 100 or not all(c.isalnum() or c in "-_.+" for c in mount):
        raise ValueError("Enter the mountpoint name (letters, digits, - _ . +)")
    user = str(data.get("username", "") or "")
    pw = str(data.get("password", "") or "")
    if len(user) > 128 or len(pw) > 128 or any(c in user + pw for c in "\r\n"):
        raise ValueError("The username or password is not valid")
    return NtripConfig(host=host, port=port, mountpoint=mount, username=user, password=pw,
                       tls=bool(data.get("tls")), send_gga=bool(data.get("send_gga")))


Connector = Callable[..., Awaitable[tuple]]
Sender = Callable[[dict], Awaitable[None]]


class NtripClient:
    """One caster connection, reconnecting until stopped. `send(fields)`
    puts one GPS_RTCM_DATA on the aircraft's link; `position()` returns
    (lat, lon, alt_m, sats, fix) or None for the GGA uplink; `on_state(dict)`
    is told every status change."""

    def __init__(self, cfg: NtripConfig, send: Sender, *,
                 position: Optional[Callable[[], Optional[tuple]]] = None,
                 on_state: Optional[Callable[[dict], None]] = None,
                 connect: Optional[Connector] = None,
                 reconnect_s: tuple = RECONNECT_S) -> None:
        self._cfg = cfg
        self._send = send
        self._position = position
        self._on_state = on_state
        self._connect = connect or asyncio.open_connection
        self._reconnect_s = reconnect_s
        self._task: Optional[asyncio.Task] = None
        self._seq = 0
        self.state = "idle"          # idle|connecting|connected|retrying|stopped|error
        self.error = ""
        self.bytes_in = 0
        self.frames = 0
        self.messages_sent = 0
        self.dropped = 0
        self.bad_crc = 0
        self.types: dict[int, int] = {}
        self.started_at = time.time()
        self.last_data_at = 0.0
        self.connected_at = 0.0
        self.attempts = 0

    def __repr__(self) -> str:      # never the credentials
        return f"NtripClient({self._cfg.host}:{self._cfg.port}/{self._cfg.mountpoint}, {self.state})"

    def status(self) -> dict:
        now = time.time()
        return {
            "state": self.state, "error": self.error,
            "host": self._cfg.host, "port": self._cfg.port, "mountpoint": self._cfg.mountpoint,
            "tls": self._cfg.tls, "send_gga": self._cfg.send_gga,
            "has_credentials": bool(self._cfg.username or self._cfg.password),
            "bytes_in": self.bytes_in, "frames": self.frames, "messages_sent": self.messages_sent,
            "dropped": self.dropped, "bad_crc": self.bad_crc,
            "types": {str(k): v for k, v in sorted(self.types.items())},
            "last_data_age_s": round(now - self.last_data_at, 1) if self.last_data_at else None,
            "connected_s": round(now - self.connected_at, 0) if self.connected_at and self.state == "connected" else None,
            "attempts": self.attempts,
        }

    def _set(self, state: str, error: str = "") -> None:
        self.state, self.error = state, error
        self._emit()

    def _emit(self) -> None:
        if self._on_state is not None:
            try:
                self._on_state(self.status())
            except Exception as e:
                logger.debug(f"ntrip state listener raised: {e}")

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="ntrip_client")

    async def stop(self, reason: str = "") -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass
        # Forget the secrets the moment corrections stop.
        self._cfg.username = ""
        self._cfg.password = ""
        self._set("stopped", reason)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def _run(self) -> None:
        fails = 0
        while True:
            self.attempts += 1
            try:
                await self._session()
                fails = 0
                self._set("retrying", "The caster closed the connection")
            except asyncio.CancelledError:
                raise
            except NtripError as e:
                # Wrong mountpoint or credentials will not fix themselves.
                logger.info(f"NTRIP {self._cfg.host}:{self._cfg.port}/{self._cfg.mountpoint}: {e}")
                self._set("error", str(e))
                return
            except Exception as e:
                fails += 1
                msg = self._words(e)
                logger.info(f"NTRIP {self._cfg.host}:{self._cfg.port}: {msg}")
                self._set("retrying", msg)
            delay = self._reconnect_s[min(fails, len(self._reconnect_s) - 1)] if self._reconnect_s else 0.0
            await asyncio.sleep(delay)

    @staticmethod
    def _words(e: Exception) -> str:
        if isinstance(e, asyncio.TimeoutError):
            return "No answer from the caster (timed out)"
        if isinstance(e, ConnectionRefusedError):
            return "The caster refused the connection. Check the host and port"
        if isinstance(e, OSError) and "Name or service not known" in str(e):
            return "Caster host name not found"
        if isinstance(e, ssl.SSLError):
            return "TLS failed. Turn TLS off unless the caster needs it"
        return f"Connection to the caster failed ({type(e).__name__})"

    async def _session(self) -> None:
        cfg = self._cfg
        self._set("connecting")
        kw = {"ssl": ssl.create_default_context()} if cfg.tls else {}
        reader, writer = await asyncio.wait_for(self._connect(cfg.host, cfg.port, **kw), timeout=CONNECT_TIMEOUT_S)
        try:
            writer.write(build_request(cfg.mountpoint, cfg.username, cfg.password, cfg.host))
            await writer.drain()
            head = bytearray()
            while b"\r\n\r\n" not in head and not head.upper().startswith(b"ICY 200 OK\r\n"):
                chunk = await asyncio.wait_for(reader.read(1024), timeout=CONNECT_TIMEOUT_S)
                if not chunk:
                    if not head:
                        raise NtripError("The caster closed the connection without answering")
                    break
                head.extend(chunk)
                if len(head) > 16384:
                    raise NtripError("The caster answer was too long")
            if head.upper().startswith(b"ICY 200 OK\r\n"):   # v1: data follows the status line
                h, rest = bytes(head).split(b"\r\n", 1)
            elif b"\r\n\r\n" in head:
                h, rest = bytes(head).split(b"\r\n\r\n", 1)
            else:
                h, rest = bytes(head), b""
            chunked = parse_response_head(h + b"\r\n")
            dechunk = ChunkDecoder() if chunked else None
            parser = RtcmParser()
            self.connected_at = time.time()
            self._set("connected")
            next_gga = 0.0
            data = rest
            last_emit = 0.0
            while True:
                if data:
                    if dechunk is not None:
                        data = dechunk.feed(data)
                    self.bytes_in += len(data)
                    self.last_data_at = time.time()
                    for frame in parser.feed(data):
                        await self._forward(frame)
                    self.bad_crc = parser.bad_crc
                now = time.monotonic()
                if cfg.send_gga and self._position is not None and now >= next_gga:
                    pos = self._position()
                    if pos is not None:
                        writer.write(nmea_gga(*pos).encode())
                        await writer.drain()
                        next_gga = now + GGA_INTERVAL_S
                if now - last_emit > 1.0:
                    last_emit = now
                    self._emit()
                data = await asyncio.wait_for(reader.read(4096), timeout=READ_TIMEOUT_S)
                if not data:
                    return
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), timeout=2.0)
            except Exception:
                pass

    async def _forward(self, frame: bytes) -> None:
        self.frames += 1
        t = rtcm_message_type(frame)
        if t is not None:
            self.types[t] = self.types.get(t, 0) + 1
        msgs = rtcm_messages(frame, self._seq)
        self._seq = (self._seq + 1) & 0x1F
        if not msgs:
            self.dropped += 1
            return
        for m in msgs:
            await self._send(m)
            self.messages_sent += 1


async def send_rtcm(tel, fields: dict) -> None:
    """One GPS_RTCM_DATA on the session's own MAVSDK link."""
    from mavsdk.mavlink_direct import MavlinkMessage
    sysid = int(getattr(tel, "_target_sysid", 1) or 1)
    await asyncio.wait_for(
        tel._drone.mavlink_direct.send_message(
            MavlinkMessage("GPS_RTCM_DATA", 0, 0, sysid, 1, json.dumps(fields))
        ),
        timeout=2.0,
    )


def vehicle_position(tel) -> Optional[tuple]:
    """(lat, lon, alt_m, sats, fix) for the GGA uplink, or None without a fix."""
    snap = getattr(tel, "snapshot", None)
    if snap is None:
        return None
    pos, gps = snap.position, snap.gps
    lat, lon = float(pos.latitude_deg or 0.0), float(pos.longitude_deg or 0.0)
    if (lat == 0.0 and lon == 0.0) or not math.isfinite(lat) or not math.isfinite(lon):
        return None
    return (lat, lon, float(pos.absolute_altitude_m or 0.0), int(gps.satellites_visible or 0), int(gps.fix_type or 0))

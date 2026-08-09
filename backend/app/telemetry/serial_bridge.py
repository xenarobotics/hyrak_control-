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



# MAVLink framing, enough to identify what is on the wire without decoding it.
#
# WHY SNIFF AT ALL. "Bytes arrived but no heartbeat" has two completely
# different causes that send you to opposite ends of the system:
#
#   * the bytes are NOISE — wrong baud, so nothing frames at all. Fix on the
#     operator's machine.
#   * the bytes are VALID MAVLINK but carry no autopilot heartbeat. A SiK
#     radio emits RADIO_STATUS from the GROUND module itself whether or not
#     the air side is linked, so a healthy trickle of framed MAVLink proves
#     the radio and the baud are right and the aircraft is not talking. Fix
#     at the airframe.
#
# Byte counts cannot tell those apart. Frame magic and message ids can, and it
# needs no CRC tables and no mavlink library — only the header.
_V1_MAGIC = 0xFE
_V2_MAGIC = 0xFD
_MSG_NAMES = {
    0: "HEARTBEAT", 1: "SYS_STATUS", 24: "GPS_RAW_INT", 30: "ATTITUDE",
    32: "LOCAL_POSITION_NED", 33: "GLOBAL_POSITION_INT", 74: "VFR_HUD",
    109: "RADIO_STATUS", 147: "BATTERY_STATUS", 242: "HOME_POSITION",
    245: "EXTENDED_SYS_STATE", 253: "STATUSTEXT",
}


class _FrameSniffer:
    """Counts MAVLink frames by message id, and which system ids sent them."""

    #: No real MAVLink message id comes near this. common.xml stops around 300
    #: and the dialects add a few hundred more; the 24-bit v2 field allows 16
    #: million, and noise happily produces them. Seeing msg4335019 is proof the
    #: "frame" was a coincidence, not a message.
    _MAX_PLAUSIBLE_MSGID = 512
    #: Fraction of the stream that must actually lie inside frames before this
    #: is called MAVLink. A real link is back-to-back frames — essentially
    #: every byte is inside one. Random bytes hit a 0xFD or 0xFE every ~128
    #: bytes by chance and "frame" a short run around it, which lands far
    #: below this. This single number is what separates the two diagnoses.
    _MIN_COVERAGE = 0.5

    def __init__(self):
        self._buf = bytearray()
        self.by_msg: dict[int, int] = {}
        self.sysids: set[int] = set()
        self.frames = 0
        self.framed_bytes = 0
        self.total_bytes = 0

    def feed(self, data: bytes) -> None:
        # Bounded: a stream that never frames must not grow this forever.
        # 512 bytes is well over the largest MAVLink frame (280), so a real
        # frame straddling two chunks is never lost.
        self.total_bytes += len(data)
        self._buf.extend(data)
        if len(self._buf) > 512:
            del self._buf[:-512]
        b = self._buf
        i = 0
        while i < len(b):
            magic = b[i]
            if magic == _V2_MAGIC:
                if len(b) - i < 12:
                    break
                total = b[i + 1] + 12 + (13 if b[i + 2] & 0x01 else 0)
                if len(b) - i < total:
                    break
                sysid = b[i + 5]
                msgid = b[i + 7] | (b[i + 8] << 8) | (b[i + 9] << 16)
                if msgid > self._MAX_PLAUSIBLE_MSGID or sysid == 0:
                    i += 1
                    continue
            elif magic == _V1_MAGIC:
                if len(b) - i < 8:
                    break
                total = b[i + 1] + 8
                if len(b) - i < total:
                    break
                sysid = b[i + 3]
                msgid = b[i + 5]
                if sysid == 0:
                    i += 1
                    continue
            else:
                i += 1
                continue
            self.frames += 1
            self.framed_bytes += total
            self.sysids.add(sysid)
            self.by_msg[msgid] = self.by_msg.get(msgid, 0) + 1
            i += total
        del b[:i]

    @property
    def coverage(self) -> float:
        """Fraction of the stream that lies inside plausible frames."""
        if self.total_bytes <= 0:
            return 0.0
        return min(1.0, self.framed_bytes / self.total_bytes)

    @property
    def looks_like_mavlink(self) -> bool:
        """Whether this stream is MAVLink at all, as opposed to bytes that
        happened to contain a start byte.

        THE FAILURE THIS EXISTS TO PREVENT was real and shipped: a noise stream
        produced "19 MAVLink frame(s) from system id(s) 24, 33, 45, 60, 64, 89,
        140, 152, 232, 234, 236: msg250 x5, msg4335019 x1" and the operator was
        told, confidently, that their baud rate was correct and to go and check
        the aircraft. Eleven system ids across nineteen frames and a
        seven-digit message id are not a link; they are what random bytes look
        like when something scans them for a one-byte marker and asks no
        further questions.
        """
        return self.frames >= 3 and self.coverage >= self._MIN_COVERAGE

    def summary(self) -> str:
        if not self.frames:
            return ""
        top = sorted(self.by_msg.items(), key=lambda kv: kv[1], reverse=True)[:4]
        msgs = ", ".join(f"{_MSG_NAMES.get(m, f'msg{m}')} x{n}" for m, n in top)
        ids = ", ".join(str(s) for s in sorted(self.sysids))
        return (f"{self.frames} frame(s) covering {self.coverage * 100:.0f}% of "
                f"the stream, from system id(s) {ids}: {msgs}")


class SerialBridge(asyncio.DatagramProtocol):
    def __init__(self, sio, socket_id: str):
        self._sio = sio
        self._socket_id = socket_id
        self._transport: Optional[asyncio.DatagramTransport] = None
        # mavsdk_server listens here — loopback only, never exposed.
        self.mavsdk_port = _free_udp_port()
        # Counted so a failed connect can say whether the radio delivered
        # anything — see traffic().
        self.bytes_in = 0
        self.packets_in = 0
        self._sniffer = _FrameSniffer()

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
        self.bytes_in += len(data)
        self.packets_in += 1
        self._sniffer.feed(data)
        if self._transport and not self._transport.is_closing():
            self._transport.sendto(data, ("127.0.0.1", self.mavsdk_port))

    def traffic(self) -> str:
        """One line on whether the radio is delivering anything at all.

        A failed connect otherwise looks identical whether the radio is unplugged,
        the baud rate is wrong, the air side is off, or the aircraft is simply out
        of range: mavsdk_server says "Waiting to discover system" and then the
        connect times out with nothing else recorded anywhere. This is the one
        fact that separates "no bytes reached us" — a radio, cable, permission or
        baud problem on the operator's machine — from "bytes arrived but carried
        no heartbeat", which is a link or airframe problem.
        """
        if self.packets_in == 0:
            return ("no bytes at all reached the bridge from the browser — check "
                    "the radio is plugged in, the serial port permission was "
                    "granted, and the baud rate matches")
        seen = self._sniffer.summary()
        if not self._sniffer.looks_like_mavlink:
            detail = f" (only {seen})" if seen else ""
            return (f"{self.bytes_in} bytes arrived from the radio but they are "
                    f"NOT MAVLink{detail} — that is a baud rate mismatch, not a "
                    f"drone problem. The radio is talking, just not MAVLink at "
                    f"this speed. Try 115200 instead of 57600 in Settings")
        if 0 in self._sniffer.by_msg:
            return (f"{seen} — heartbeats WERE seen, so the link is up; the "
                    f"connect timed out anyway, retry it")
        return (f"{self.bytes_in} bytes arrived and framed correctly — {seen}. "
                f"No HEARTBEAT among them means the baud and the ground radio "
                f"are RIGHT and the aircraft is not reaching them: check the "
                f"air-side radio is powered, paired (same NETID and air speed) "
                f"and in range")

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

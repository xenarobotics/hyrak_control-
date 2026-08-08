#!/usr/bin/env python3
"""
Single-drone SITL relay agent — bridges ONE lone PX4 SITL instance's
MAVLink to a local WebSocket the browser can read.

PX4 SITL's classic default MAVLink port is 14540 — distinct from the SWARM
numbering in swarm_relay.py, which deliberately starts at 14541 and skips
14540. This script is for the single/default-instance case specifically.

Unlike air_unit_relay/telemetry_relay.py (built for wfb-ng's RF link, which
genuinely has SEPARATE fixed downlink/uplink ports), SITL's MAVLink is
bidirectional on a SINGLE port with a dynamically-learned peer address —
same shape as swarm_relay.py's per-drone relay, just one port instead of N,
and with no tag byte (nothing to multiplex here) — so this speaks the
EXACT same wire format as telemetry_relay.py. That also means, for browser
users, this needs zero frontend changes: point the site's existing
"Local RF relay" telemetry option at this script's WebSocket URL instead.

Setup:
    pip install websockets

Usage (run alongside your SITL instance):
    python3 single_relay.py --port 14540
    # then in the site: Telemetry source -> "Local RF relay (air unit)"
    #   URL: ws://127.0.0.1:8767 (this script's default — different from
    #   telemetry_relay.py's 8765, so both can run at once if ever needed)
"""
import argparse
import asyncio
import logging

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("single_relay")


class SitlRelay(asyncio.DatagramProtocol):
    def __init__(self, current_client: dict):
        self.transport: asyncio.DatagramTransport | None = None
        self._peer = None  # SITL's actual source address, learned on first packet
        self._current_client = current_client

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        self._peer = addr
        ws = self._current_client["ws"]
        if ws is not None:
            asyncio.ensure_future(_safe_send(ws, data))

    def uplink(self, data: bytes) -> None:
        if self.transport and self._peer:
            self.transport.sendto(data, self._peer)


async def _safe_send(ws, data: bytes) -> None:
    try:
        await ws.send(data)
    except Exception:
        pass  # browser tab disconnected mid-send — next datagram just drops too


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ws-port", type=int, default=8767, help="Local WebSocket port the browser connects to")
    ap.add_argument("--port", type=int, default=14540, help="SITL's MAVLink UDP port (14540 = PX4's classic default)")
    args = ap.parse_args()

    current_client = {"ws": None}
    loop = asyncio.get_running_loop()

    relay = SitlRelay(current_client)
    await loop.create_datagram_endpoint(lambda: relay, local_addr=("127.0.0.1", args.port))
    logger.info(f"Relaying udp:{args.port}")

    async def _handle_client(ws) -> None:
        if current_client["ws"] is not None:
            logger.warning("New browser tab connected — replacing the previous one")
        current_client["ws"] = ws
        logger.info("Browser connected")
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    relay.uplink(bytes(message))
        finally:
            if current_client["ws"] is ws:
                current_client["ws"] = None
            logger.info("Browser disconnected")

    async with websockets.serve(_handle_client, "127.0.0.1", args.ws_port):
        logger.info(f"Single-drone relay ready at ws://127.0.0.1:{args.ws_port} — point the site's Telemetry source here")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

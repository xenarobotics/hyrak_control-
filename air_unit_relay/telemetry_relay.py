#!/usr/bin/env python3
"""
Local RF relay agent — bridges this ground-station laptop's wfb-ng MAVLink
UDP (start-gs.sh's downlink on 127.0.0.1:14550, uplink listener on
127.0.0.1:14551) to a plain loopback WebSocket the browser can actually
read — see frontend/src/lib/localRfRelay.ts for the browser side.

Never touches the internet — only 127.0.0.1. This plays exactly the role a
USB radio's OS driver already plays for the site's existing Web Serial
telemetry bridge: something has to turn "raw bytes on this machine" into a
form the browser has an API for. The browser is still the only thing that
ever talks to the actual server.

Setup:
    pip install websockets

Usage (run alongside start-gs.sh, on this same laptop):
    python3 telemetry_relay.py
    # then in the site: Telemetry source -> "Local RF relay (air unit)"
"""
import argparse
import asyncio
import logging
import socket

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("telemetry_relay")


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765, help="Local WebSocket port the browser connects to")
    ap.add_argument("--downlink-port", type=int, default=14550, help="wfb_rx's MAVLink downlink UDP port")
    ap.add_argument("--uplink-port", type=int, default=14551, help="wfb_tx's MAVLink uplink UDP port")
    args = ap.parse_args()

    current_client = {"ws": None}
    uplink_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    loop = asyncio.get_running_loop()

    async def _safe_send(ws, data: bytes) -> None:
        try:
            await ws.send(data)
        except Exception:
            pass  # client disconnected mid-send — next datagram will just drop too, fine for telemetry

    class _DownlinkProtocol(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:
            ws = current_client["ws"]
            if ws is not None:
                asyncio.ensure_future(_safe_send(ws, data))

    async def _handle_client(ws) -> None:
        if current_client["ws"] is not None:
            logger.warning("New browser tab connected — replacing the previous one")
        current_client["ws"] = ws
        logger.info("Browser connected")
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    uplink_sock.sendto(bytes(message), ("127.0.0.1", args.uplink_port))
        finally:
            if current_client["ws"] is ws:
                current_client["ws"] = None
            logger.info("Browser disconnected")

    await loop.create_datagram_endpoint(
        _DownlinkProtocol, local_addr=("127.0.0.1", args.downlink_port)
    )
    logger.info(f"Listening for MAVLink downlink on udp:{args.downlink_port}")
    logger.info(f"Forwarding uplink to udp:{args.uplink_port}")

    async with websockets.serve(_handle_client, "127.0.0.1", args.port):
        logger.info(f"WebSocket relay ready at ws://127.0.0.1:{args.port} — point the site's Telemetry source here")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

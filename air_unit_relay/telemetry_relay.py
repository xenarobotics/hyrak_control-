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
    # THE HOSTS WERE NOT LOOPBACK-FOREVER, AND WERE WRITTEN AS IF THEY WERE.
    #
    # Both directions assumed wfb-ng runs on this same laptop. Move the decoder
    # onto its own board — which is exactly what the Luckfox ground dongle is —
    # and the two directions break differently, which is what makes it so hard
    # to see:
    #
    #   * downlink binds a host, so a wrong one means NOTHING arrives. Loud.
    #   * uplink SENDS to a host, so a wrong one means every command leaves for
    #     an address with nothing on it. UDP reports nothing. Telemetry keeps
    #     streaming in perfectly and the aircraft never hears a word.
    #
    # That second one is the failure it is worth having a flag for: a ground
    # station that looks completely healthy and cannot fly the aircraft.
    ap.add_argument("--uplink-host", default="127.0.0.1",
                    help="Host running wfb_tx's uplink listener. Set this when the "
                         "RF decoder is NOT on this machine (e.g. a Luckfox dongle) "
                         "— otherwise commands go into this laptop's loopback and "
                         "vanish while telemetry keeps working.")
    ap.add_argument("--downlink-host", default="127.0.0.1",
                    help="Address to receive wfb_rx's downlink on. Use 0.0.0.0 when "
                         "wfb_rx is on another machine on the LAN.")
    args = ap.parse_args()

    current_client = {"ws": None}
    uplink_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    uplink_addr = (args.uplink_host, args.uplink_port)
    counts = {"down": 0, "up": 0}
    loop = asyncio.get_running_loop()

    async def _safe_send(ws, data: bytes) -> None:
        try:
            await ws.send(data)
        except Exception:
            pass  # client disconnected mid-send — next datagram will just drop too, fine for telemetry

    class _DownlinkProtocol(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:
            counts["down"] += len(data)
            ws = current_client["ws"]
            if ws is not None:
                asyncio.ensure_future(_safe_send(ws, data))

    async def _report() -> None:
        """Both directions, side by side, every 10 s.

        One number cannot show this failure. Telemetry pouring in says nothing
        about whether commands are leaving, and 'commands are not reaching the
        drone' is unanswerable without knowing whether they even left here.
        Printed together, a dead uplink is obvious: down climbing, up flat at
        zero, or up climbing while the aircraft still does nothing (in which
        case the bytes are leaving and --uplink-host is where to look).
        """
        last = dict(counts)
        while True:
            await asyncio.sleep(10)
            d, u = counts["down"] - last["down"], counts["up"] - last["up"]
            last = dict(counts)
            logger.info(
                f"down {d / 10:.0f} B/s  up {u / 10:.0f} B/s"
                + ("   <- NO uplink bytes: the browser is not sending commands"
                   if u == 0 and d > 0 else "")
            )

    async def _handle_client(ws) -> None:
        if current_client["ws"] is not None:
            logger.warning("New browser tab connected — replacing the previous one")
        current_client["ws"] = ws
        logger.info("Browser connected")
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    counts["up"] += len(message)
                    uplink_sock.sendto(bytes(message), uplink_addr)
        finally:
            if current_client["ws"] is ws:
                current_client["ws"] = None
            logger.info("Browser disconnected")

    await loop.create_datagram_endpoint(
        _DownlinkProtocol, local_addr=(args.downlink_host, args.downlink_port)
    )
    logger.info(f"Listening for MAVLink downlink on udp:{args.downlink_host}:{args.downlink_port}")
    logger.info(f"Forwarding uplink to udp:{args.uplink_host}:{args.uplink_port}")
    if args.uplink_host in ("127.0.0.1", "localhost"):
        logger.info("Uplink target is this machine. If wfb_tx runs elsewhere "
                    "(a Luckfox dongle, another PC), pass --uplink-host — "
                    "otherwise telemetry will work and commands will not.")
    asyncio.ensure_future(_report())

    async with websockets.serve(_handle_client, "127.0.0.1", args.port):
        logger.info(f"WebSocket relay ready at ws://127.0.0.1:{args.port} — point the site's Telemetry source here")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

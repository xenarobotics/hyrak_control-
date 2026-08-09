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
    ap.add_argument("--no-register", action="store_true",
                    help="Do not claim the decoder's feeds for this machine. Only "
                         "useful if something else on this network should own them.")
    ap.add_argument("--register-port", type=int, default=9000,
                    help="The decoder's registration listener.")
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

    async def _register() -> None:
        """Claim the decoder's MAVLink feed for THIS machine, and keep claiming.

        WHY THE AGENT AND NOT THE BROWSER. The decoder pushes telemetry to one
        client and must be told which. The desktop app tells it directly, but
        a browser tab cannot open a UDP socket — which is the entire reason
        this agent exists — so a browser session had no way to say so and fell
        back to the decoder inferring the destination from its DHCP lease
        file. That inference cannot see a statically addressed PC at all, and
        after another machine has held the address it keeps aiming at the
        departed one for hours.

        This process is not a browser. It already owns a UDP socket and
        already knows the decoder's address, so it can simply say so, and the
        browser path stops depending on inference entirely.

        Bare form, no address: the decoder reads it from the UDP source, so a
        wrong --uplink-host would misdirect commands but never the feeds.
        """
        if args.no_register or args.uplink_host in ("127.0.0.1", "localhost"):
            return                       # nothing to claim on our own loopback
        target = (args.uplink_host, args.register_port)
        # A datagram endpoint rather than a raw socket with loop.sock_recvfrom.
        # sock_recvfrom is NOT implemented on every event loop — uvloop raises
        # NotImplementedError — and this file is a standalone script that
        # someone may well run under uvloop for the same reason the server
        # does. create_datagram_endpoint is the portable spelling and it is
        # the one asyncio actually guarantees.
        replies: asyncio.Queue = asyncio.Queue()

        class _ReplyProtocol(asyncio.DatagramProtocol):
            def datagram_received(self, data: bytes, addr) -> None:
                replies.put_nowait(data)

        reg_transport, _ = await loop.create_datagram_endpoint(
            _ReplyProtocol, local_addr=("0.0.0.0", 0)
        )
        last_dest: str | None = None
        flaps = 0
        while True:
            # CLAIM THE FEED ONLY WHILE ACTUALLY SERVING SOMEONE.
            #
            # There is exactly ONE direct-UDP client on the decoder and an
            # explicit registration beats everything, including another
            # explicit registration — and a registration from a DIFFERENT
            # address does not update a variable, it tears down and respawns
            # both wfb_rx processes.
            #
            # So an idle agent left running on a spare laptop, with no browser
            # attached and nothing consuming anything, would fight a working
            # desktop session on another machine every ten seconds forever.
            # Both feeds would visibly break and it would look like an RF or
            # air-unit fault, which is the most expensive way for this to fail.
            #
            # An agent with no browser attached is not consuming the feed and
            # has no business claiming it. Note this is a pause, not an
            # UNREGISTER: unregistering would suppress this machine's lease as
            # well, which is a bigger hammer than "I am not using it today".
            if current_client["ws"] is None:
                await asyncio.sleep(2)
                continue
            try:
                reg_transport.sendto(b"HYRAK REGISTER", target)
            except OSError as e:
                logger.debug(f"registration send failed (feeds unaffected): {e}")

            # WATCH FOR A SECOND REGISTRANT. The reply names where the decoder
            # is sending. If that destination is different from the one our own
            # last registration produced, something else registered in between —
            # and two registrants on a timer thrash the feeds indefinitely.
            # We cannot see our own address, but we do not need to: a change
            # between our own consecutive registrations is the signal.
            dest = None
            try:
                data = await asyncio.wait_for(replies.get(), timeout=1.0)
                text = data.decode(errors="replace")
                if text.startswith("HYRAK OK"):
                    for field in text.split():
                        if field.startswith("mavlink="):
                            dest = field.split("=", 1)[1]
                elif text.startswith("HYRAK ERR"):
                    logger.warning(f"decoder refused the registration: {text.strip()}")
            except (asyncio.TimeoutError, OSError):
                pass                     # no reply is not an error; it is UDP

            if dest and last_dest and dest != last_dest:
                flaps += 1
                logger.warning(
                    f"the decoder's MAVLink destination changed to {dest} between our "
                    f"own registrations (was {last_dest}) — something else is "
                    f"registering too, and only one client can have the feeds"
                )
                if flaps >= 3:
                    reg_transport.close()
                    logger.error(
                        "STOPPING registration: another ground station keeps claiming "
                        "this decoder, and two registrants on a timer restart the feeds "
                        "every few seconds indefinitely — which looks exactly like an RF "
                        "or air-unit fault. Backing off so the other one wins and the "
                        "feeds stay up. Close the other ground station, or start this "
                        "agent with --no-register."
                    )
                    return
            if dest:
                last_dest = dest

            # Not a keepalive — the decoder never expires a client. This is
            # self-healing: if this PC's address changes, the next tick
            # re-points the feed with no user action. Measured free on the
            # decoder: no process restart, no stream churn.
            await asyncio.sleep(10)

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
    asyncio.ensure_future(_register())

    async with websockets.serve(_handle_client, "127.0.0.1", args.port):
        logger.info(f"WebSocket relay ready at ws://127.0.0.1:{args.port} — point the site's Telemetry source here")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

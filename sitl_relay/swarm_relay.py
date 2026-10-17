#!/usr/bin/env python3
"""
Swarm SITL relay agent - bridges a client's own local multi-drone PX4 SITL
swarm (see simulation/swarm.sh: instance i sends its MAVLink offboard stream
to UDP 14540+i, or 14541+i for i >= 10, skipping 14550/QGC) to a single
local WebSocket the browser can read - see
frontend/src/lib/localSwarmRelay.ts for the browser side.

This is the single-drone air_unit_relay/telemetry_relay.py bridge
generalized to N drones. Since a swarm needs N independent MAVLink streams
but a browser only gets one clean local companion connection, all drones
are multiplexed over ONE WebSocket: every frame is
    [drone_id: 1 byte][raw MAVLink bytes]
The browser doesn't interpret the bytes, it just relays tagged frames
to/from the server's per-session SwarmRelayBridge
(backend/app/telemetry/swarm_relay_bridge.py), which demultiplexes them
into one loopback UDP endpoint per drone.

For each configured drone id, this relay BINDS that drone's well-known
local MAVLink port (same convention as swarm.sh) and waits for PX4 to send
its stream there - exactly the role the backend's mavsdk_server plays when
SITL and the backend are on the same machine. The first packet from PX4
tells us its real (possibly ephemeral) peer address; uplink replies
(commands from the server) are sent back to that exact address, standard
UDP relay behavior - this works regardless of PX4's own internal socket
setup.

Never touches the internet - only 127.0.0.1. The browser is still the only
thing that ever talks to the actual server. Only the HYRAK site's origin may
connect (see allowed_origins below; HYRAK_ALLOWED_ORIGINS / --allow-origin
extend it) and HYRAK_RELAY_TOKEN adds a shared secret on top.

Setup:
    pip install websockets

Usage (run alongside your SITL swarm, e.g. simulation/swarm.sh start 10):
    python3 swarm_relay.py --count 10
    # then in the site: Fleet panel -> connect the swarm relay -> Scan
"""
import argparse
import asyncio
import logging
import os

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("swarm_relay")

# ---------------------------------------------------------------------------
# Who may connect. This socket is loopback-only, but ANY web page open in a
# browser on this machine can open ws://127.0.0.1:<port> and, before this
# check existed, inject MAVLink into the aircraft. Browsers always send an
# Origin header, so the relay only accepts the HYRAK site (and a dev
# frontend); add more with HYRAK_ALLOWED_ORIGINS=https://a,https://b or
# --allow-origin. Connections without an Origin come from non-browser
# processes on this machine, which could reach the UDP ports directly
# anyway, so they are allowed.
#
# Optional second lock: HYRAK_RELAY_TOKEN=<secret>. When set, the first
# WebSocket message must be exactly that token (text or bytes) or the
# connection is closed; the browser side sends it when configured with the
# same value.
# ---------------------------------------------------------------------------
DEFAULT_ORIGINS = ["https://dev.xenarobotics.com", "http://localhost:3000"]
RELAY_TOKEN = os.environ.get("HYRAK_RELAY_TOKEN", "")


def allowed_origins(extra: list[str] | None = None) -> list:
    origins = list(DEFAULT_ORIGINS)
    origins += [o.strip() for o in os.environ.get("HYRAK_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    origins += [o.strip() for o in (extra or []) if o.strip()]
    return origins + [None]   # None = no Origin header (non-browser client)


async def check_token(ws) -> bool:
    """First-message shared-secret check. True when the client may proceed."""
    if not RELAY_TOKEN:
        return True
    try:
        first = await asyncio.wait_for(ws.recv(), timeout=5.0)
    except Exception:
        logger.warning("client sent no token within 5 s - closing")
        await ws.close(1008, "token required")
        return False
    if isinstance(first, (bytes, bytearray)):
        first = first.decode(errors="replace")
    if first != RELAY_TOKEN:
        logger.warning("client sent a wrong HYRAK_RELAY_TOKEN - closing")
        await ws.close(1008, "bad token")
        return False
    return True


def port_for_drone(drone_id: int) -> int:
    # Mirrors backend/app/events/swarm_events.py's port_for_drone and
    # simulation/swarm.sh's port_for exactly.
    return 14541 + drone_id if drone_id > 9 else 14540 + drone_id


class DroneRelay(asyncio.DatagramProtocol):
    """Binds one drone's well-known local MAVLink port and relays both
    directions, tagging every frame with the drone id so N drones can
    share one WebSocket to the browser."""

    def __init__(self, drone_id: int, current_client: dict):
        self.drone_id = drone_id
        self.transport: asyncio.DatagramTransport | None = None
        self._peer = None  # PX4's actual source address, learned on first packet
        self._current_client = current_client

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        self._peer = addr
        ws = self._current_client["ws"]
        if ws is not None:
            frame = bytes([self.drone_id & 0xFF]) + data
            asyncio.ensure_future(_safe_send(ws, frame))

    def uplink(self, data: bytes) -> None:
        """Server (via browser) -> this drone: reply to PX4's last-known
        real peer address. Silently dropped if PX4 hasn't said hello yet -
        harmless, matches "drone not responding" on the scan side."""
        if self.transport and self._peer:
            self.transport.sendto(data, self._peer)


async def _safe_send(ws, data: bytes) -> None:
    try:
        await ws.send(data)
    except Exception:
        pass  # browser tab disconnected mid-send - next frame just drops too


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8766, help="Local WebSocket port the browser connects to")
    ap.add_argument("--count", type=int, default=10, help="Number of drone ids to relay (1..count)")
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="Extra browser origin allowed to connect (repeatable; also HYRAK_ALLOWED_ORIGINS)")
    args = ap.parse_args()

    current_client = {"ws": None}
    loop = asyncio.get_running_loop()

    relays: dict[int, DroneRelay] = {}
    for drone_id in range(1, args.count + 1):
        port = port_for_drone(drone_id)
        relay = DroneRelay(drone_id, current_client)
        try:
            await loop.create_datagram_endpoint(lambda relay=relay: relay, local_addr=("127.0.0.1", port))
        except OSError as e:
            logger.warning(f"Drone {drone_id}: couldn't bind udp:{port} ({e}) - skipping this drone")
            continue
        relays[drone_id] = relay
        logger.info(f"Drone {drone_id}: relaying udp:{port}")

    async def _handle_client(ws) -> None:
        if not await check_token(ws):
            return
        if current_client["ws"] is not None:
            logger.warning("New browser tab connected - replacing the previous one")
        current_client["ws"] = ws
        logger.info("Browser connected")
        try:
            async for message in ws:
                if not isinstance(message, (bytes, bytearray)) or len(message) < 1:
                    continue
                relay = relays.get(message[0])
                if relay:
                    relay.uplink(bytes(message[1:]))
        finally:
            if current_client["ws"] is ws:
                current_client["ws"] = None
            logger.info("Browser disconnected")

    origins = allowed_origins(args.allow_origin)
    async with websockets.serve(_handle_client, "127.0.0.1", args.port, origins=origins):
        logger.info(f"Swarm relay ready at ws://127.0.0.1:{args.port} for {len(relays)} drone(s) "
                    f"- point the site's Fleet panel here")
        logger.info("allowed origins: " + ", ".join(o for o in origins if o)
                    + ("; HYRAK_RELAY_TOKEN required" if RELAY_TOKEN else "; no HYRAK_RELAY_TOKEN set"))
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

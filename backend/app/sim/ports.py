"""
The cloud SITL port plan (docs/ACCESS_MODEL.md 8c).

Every cloud sim instance owns one SLOT. A slot is three UDP ports in a
private block, a PX4 instance index and a fresh GZ_PARTITION:

    port base + slot * STRIDE + 0   the backend's MAVSDK link binds it
                                     (udpin://127.0.0.1:<port>, loopback only)
    port base + slot * STRIDE + 1   PX4's own MAVLink port (-u), which sends
                                     to the one above (-o, -t 127.0.0.1)
    port base + slot * STRIDE + 2   uXRCE-DDS agent port, pointed at nothing
                                     (keeps PX4's DDS client off 8888)
    PX4 instance = instance base + slot   (MAV_SYS_ID = instance + 1,
                                           /tmp/px4_lock-<instance>)

PX4's stock MAVLink startup (px4-rc.mavlink) is replaced for these
instances by simulation/cloud_sim_rc/px4-rc.mavlink, so a cloud sim opens
NO other UDP link: not the GCS link to udp:14550 (the owner's QGC), not the
offboard link to 14540+i, not the payload / gimbal links.

The block must stay clear of every port the owner or the rest of the
platform uses (RESERVED below). validate_plan() refuses a configured base
that would overlap one, and allocation also skips a slot whose ports are
bound right now or whose PX4 instance lock is held by someone else.
"""
from __future__ import annotations

import fcntl
import os
import socket
from dataclasses import dataclass
from typing import Optional

STRIDE = 10
POOL_SLOTS = 64

# (first, last, who) - inclusive.
RESERVED: tuple[tuple[int, int, str], ...] = (
    (3000, 3000, "frontend"),
    (5600, 5603, "air unit and mesh video units"),
    (5800, 5900, "video relay / DataChannel ingest pool"),
    (8001, 8001, "backend"),
    (8888, 8888, "uXRCE-DDS agent default"),
    (10317, 10318, "gz-transport discovery"),
    (13030, 13130, "PX4 SITL gimbal ports, instances 0-99"),
    (13280, 13380, "PX4 SITL gimbal ports, instances 0-99"),
    (14030, 14130, "PX4 SITL payload ports, instances 0-99"),
    (14280, 14380, "PX4 SITL payload ports, instances 0-99"),
    (14540, 14549, "desktop SITL relay and swarm SITL"),
    (14550, 14551, "QGC broadcast and RF bridge"),
    (14540, 14571, "fleet / swarm scanner"),
    (14580, 14680, "PX4 SITL offboard ports, instances 0-99"),
    (14600, 14601, "Gazebo sim on server"),
    (18570, 18670, "PX4 SITL GCS ports, instances 0-99"),
)

# Linux's default ephemeral range: a port in it can be taken by any
# outgoing socket at any time, so a fixed plan must not live there.
EPHEMERAL = (32768, 60999)


@dataclass(frozen=True)
class SlotPorts:
    backend: int     # where the backend's MAVSDK listens
    px4: int         # PX4's own MAVLink port
    dds: int         # uXRCE-DDS dummy agent port

    def all(self) -> tuple[int, ...]:
        return (self.backend, self.px4, self.dds)


def slot_ports(base: int, slot: int) -> SlotPorts:
    p = base + slot * STRIDE
    return SlotPorts(backend=p, px4=p + 1, dds=p + 2)


def reserved_by(port: int) -> Optional[str]:
    for lo, hi, who in RESERVED:
        if lo <= port <= hi:
            return who
    return None


def validate_plan(base: int, slots: int = POOL_SLOTS, instance_base: int = 100) -> Optional[str]:
    """None when the whole pool is usable, else why not."""
    if slots < 1:
        return "the pool has no slots"
    if not (100 <= instance_base and instance_base + slots - 1 <= 199):
        # Below 100: the owner's swarm / demo instances (0-30 today). From
        # 200: MAV_SYS_ID would collide with the backend's own GCS ids.
        return "PX4 instance numbers must stay within 100-199"
    first, last = base, base + (slots - 1) * STRIDE + STRIDE - 1
    if first < 1024 or last > 65535:
        return f"ports {first}-{last} are outside 1024-65535"
    if not (last < EPHEMERAL[0] or first > EPHEMERAL[1]):
        return f"ports {first}-{last} overlap the ephemeral range {EPHEMERAL[0]}-{EPHEMERAL[1]}"
    for lo, hi, who in RESERVED:
        if lo <= last and first <= hi:
            return f"ports {first}-{last} overlap {lo}-{hi} ({who})"
    return None


def udp_port_free(port: int) -> bool:
    """True when nothing holds udp:<port>, on any address. Tries the
    wildcard bind, which fails if any address already has the port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def px4_instance_free(instance: int) -> bool:
    """True when no PX4 daemon holds instance <instance>'s lock. PX4 keeps
    an flock on /tmp/px4_lock-<n> for as long as its server runs; taking it
    for a moment (and letting go) cannot disturb anyone."""
    path = f"/tmp/px4_lock-{instance}"
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except OSError:
        return False        # held by a running PX4 (or unreadable): not ours to use
    finally:
        os.close(fd)


def slot_usable(base: int, slot: int, instance_base: int) -> bool:
    ports = slot_ports(base, slot)
    if any(reserved_by(p) for p in ports.all()):
        return False
    if not all(udp_port_free(p) for p in ports.all()):
        return False
    return px4_instance_free(instance_base + slot)

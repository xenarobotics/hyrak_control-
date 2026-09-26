"""
Verocore Telemetry Manager
Uses MAVSDK-Python to talk to PX4 over MAVLink.

Key concepts:
- MAVSDK connects via UDP to PX4 SITL (default port 14540)
- All telemetry subscriptions are async generators - they yield forever
- We run each subscription as a separate asyncio Task
- Commands go through a queue - this makes it thread-safe
- One TelemetryManager instance per drone session
"""
import asyncio
import contextlib
import functools
import json
import logging
import math
import socket
import time
from typing import Callable, Optional

from app.config import get_settings
from mavsdk import System
from mavsdk.action import ActionError
from mavsdk.offboard import (
    OffboardError,
    AttitudeRate,
    VelocityBodyYawspeed,
    VelocityNedYaw,
)
from app.telemetry.calibration import (
    LEVEL_MAX_TILT_DEG, SENSORS, CalibrationSession,
)
from app.telemetry.schemas import (
    TelemetrySnapshot,
    AttitudeData,
    PositionData,
    VelocityData,
    BatteryData,
    GPSData,
    FlightModeData,
    SensorHealthData,
    RcStatusData,
    DroneCommand,
)

logger = logging.getLogger("verocore.telemetry")


def _find_free_port() -> int:
    """Grab an OS-assigned free TCP port for a mavsdk_server gRPC endpoint."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _claims_mode_change(fn):
    """Marks a method that COMMANDS A FLIGHT MODE CHANGE, so the change it
    causes is not mistaken for a pilot taking the aircraft.

    A DECORATOR RATHER THAN NINE SCATTERED CALLS, because nine scattered calls
    is how this codebase already grew seven hand-copied copies of the pursuit
    analyzer list that had silently drifted apart. The list of things that move
    the aircraft only ever grows; a missing decorator is one visible line above
    a def, and test_pilot_handover walks every one of them.

    Getting this wrong is not cosmetic. SET ALT and RTL sit on screen DURING a
    follow: without the claim, using either mid-chase would read as a takeover,
    stop the tracker, and lock the operator out of Offboard for a pilot who was
    never there.
    """
    @functools.wraps(fn)
    async def _wrapper(self, *args, **kwargs):
        self._claim_next_mode_change()
        return await fn(self, *args, **kwargs)
    _wrapper._claims_mode_change = True
    return _wrapper


class TelemetryManager:
    """
    Manages the full lifecycle of a MAVLink connection to one drone.

    Usage:
        manager = TelemetryManager(on_update=my_callback)
        await manager.connect("udp://:14540")
        await manager.start()
        # ... later ...
        await manager.stop()
    """

    # Max rate at which we push snapshots to the frontend (Hz)
    _EMIT_RATE_HZ       = 10  # primary drone
    _FLEET_EMIT_RATE_HZ = 3   # fleet drones - lower to avoid overwhelming mavsdk_server queue

    def __init__(self, on_update: Optional[Callable[[dict], None]] = None, fleet_mode: bool = False,
                 on_fc_message: Optional[Callable[[dict], None]] = None,
                 on_pilot_override: Optional[Callable[[str], None]] = None,
                 sysid: int = 245):
        self._drone: Optional[System] = None
        # The MAVLink system id this link identifies itself with. Two ground
        # stations on one aircraft MUST differ here: PX4 routes a reply to the
        # link where it last saw the target sysid, so when the fleet link and a
        # browser session both used MAVSDK's default 245 the session's
        # identity read, geofence and mission uploads all timed out - PX4 was
        # answering them down the fleet's socket.
        self._sysid = int(sysid)
        self._on_update = on_update
        # Called with the mode PX4 moved to, the moment the aircraft leaves
        # Offboard without this app asking. The event layer uses it to stop
        # every tracker, because a tracker that keeps computing setpoints
        # while a human flies the aircraft is a tracker waiting to grab it
        # back the instant anything re-enters Offboard.
        self._on_pilot_override = on_pilot_override
        # Every line the autopilot says, pushed on as it arrives.
        #
        # These were already being collected - the refusal-reason work needed
        # the last few - but only ever read at the moment a command failed and
        # then discarded. That is a fraction of what the aircraft tells you:
        # preflight results, EKF and GPS state changes, failsafe warnings,
        # calibration complaints. QGroundControl shows the lot, which is most
        # of why a problem is diagnosable there and was not here.
        self._on_fc_message = on_fc_message
        self._fleet_mode = fleet_mode  # when True, use minimal subscriptions and slower rates
        self._snapshot = TelemetrySnapshot()
        self._tasks: list[asyncio.Task] = []
        self._command_queue: asyncio.Queue[DroneCommand] = asyncio.Queue(maxsize=5)
        self._running = False
        self._connected = False
        self._offboard_active = False
        self._offboard_hold_alt: Optional[float] = None  # relative altitude (m) to hold during AI/offboard tracking
        # Latched when the pilot takes the aircraft; see _note_pilot_override.
        self._pilot_override_mode: Optional[str] = None
        # The calibration in progress, if any. One at a time, deliberately:
        # PX4 runs a single calibration routine and a second START while one is
        # live is refused by the vehicle in a way that reads, on screen, as the
        # first one having crashed.
        self._calibration: Optional[CalibrationSession] = None
        self._calibration_task: Optional[asyncio.Task] = None
        self._on_calibration: Optional[Callable[[dict], None]] = None
        # Monotonic deadline before which a departure from Offboard is OURS.
        #
        # The alternative - a boolean cleared once the mode has settled - races
        # the flight-mode subscription, which is a separate task reading a 1 Hz
        # HEARTBEAT-derived stream. A window is honest about what is actually
        # being asserted: "we asked for a mode change just now, so the next one
        # to arrive is the answer to it and not a pilot."
        self._offboard_release_until: float = 0.0
        # Called with the snapshot on every attitude/position update, at the
        # moment it arrives - the avoidance pose history stamps observations
        # with these (see app/avoidance/pose_history.py).
        self._pose_listeners: list[Callable] = []
        self._pose_rates_boosted = False
        # Monotonic time of the last velocity setpoint from the commanding loop.
        # 0.0 = none yet, which the watchdog treats as "not commanding" rather
        # than "stale" - an armed Offboard session that has never been given a
        # velocity is not one that stopped being given them.
        self._last_velocity_cmd_t: float = 0.0
        self._offboard_stale: bool = False
        self._address: str = ""
        self._grpc_port: Optional[int] = None  # unique per drone - see connect()
        self._last_emit: float = 0.0  # monotonic time of last _emit() push
        # The in-flight altitude verifier, if any. Held so a NEW altitude
        # command can cancel it: two verifiers running at once would race, and
        # the older one settling last would overwrite the newer verdict with a
        # judgement about an altitude nobody is flying to any more.
        self._alt_verify_task: Optional[asyncio.Task] = None
        # What the link to the AIRCRAFT actually is - "radio" or "local".
        # Declared by whoever built the connection, because the MAVSDK address
        # only describes the hop to mavsdk_server. See _set_rates.
        self._link_kind: str = "local"
        # ACHIEVED stream rates, measured from arrivals. The commanded rate is
        # a request; what a 3DR radio actually delivers depends on its AIR_SPEED
        # and ECC settings, which are on the radio and not visible from here.
        # Asking for 10 Hz and receiving 3 is indistinguishable from a healthy
        # link unless the arrivals are counted, so they are.
        self._rate_counts: dict[str, int] = {}
        # None, not 0.0, for "no window open yet". time.monotonic()'s epoch is
        # unspecified and does start at zero on some platforms, where a falsy
        # sentinel would restart the window on every single arrival and no rate
        # would ever be published.
        self._rate_window_start: Optional[float] = None
        self._measured_rates: dict[str, float] = {}
        # THE AUTOPILOT ALREADY SAYS WHY IT REFUSED, AND WE THREW IT AWAY.
        #
        # A denied arm comes back through MAVSDK as COMMAND_DENIED and nothing
        # else, which reaches the operator as "arm failed" - indistinguishable
        # from the command never leaving the ground station. PX4 sends the
        # actual reason in the same breath as the refusal, as a STATUSTEXT
        # ("Arming denied: ...", "Preflight Fail: ..."). QGC shows exactly that
        # line and it is why QGC feels diagnosable and this did not. Nothing
        # here subscribed to status_text at all.
        self._status_text: list[tuple[float, str, str]] = []   # (monotonic, severity, text)
        self._status_event: Optional[asyncio.Event] = None
        #: Set whenever an action is refused - the FC's own words when it gave
        #: any, else the MAVSDK error. Read by execute_drone_action.
        self.last_action_error: Optional[str] = None

    #: Keep the tail only. This is for explaining the command you just sent,
    #: not a flight log - boot spam from the FC must not push memory around.
    _STATUS_TEXT_KEEP = 20
    #: How long to wait after a refusal for the FC's explanation to arrive.
    #: The ACK and the STATUSTEXT are separate messages, and on a 3DR link the
    #: second can trail the first by a good fraction of a second.
    _STATUS_WAIT_S = 1.5
    #: Only WARNING and above explain a refusal; INFO is routine chatter.
    _STATUS_MIN_SEVERITY = 3  # MAVSDK StatusTextType: 3 == WARNING

    #: Averaging window for the achieved-rate measurement. Long enough that a
    #: single late packet does not move the figure, short enough that turning a
    #: radio setting up shows its effect while you are still standing there.
    _RATE_WINDOW_S = 5.0

    def _count(self, stream: str) -> None:
        """Tally one arrival, and roll the window when it closes.

        Called from the subscription loops, which is the only place that knows
        a message genuinely arrived - mavsdk_server's own rate request is a
        statement of intent and says nothing about what the radio carried.
        """
        import time as _time
        now = _time.monotonic()
        if self._rate_window_start is None:
            self._rate_window_start = now
        self._rate_counts[stream] = self._rate_counts.get(stream, 0) + 1
        elapsed = now - self._rate_window_start
        if elapsed >= self._RATE_WINDOW_S:
            self._measured_rates = {
                k: round(v / elapsed, 1) for k, v in self._rate_counts.items()
            }
            self._snapshot.measured_rates = dict(self._measured_rates)
            self._rate_counts.clear()
            self._rate_window_start = now

    def set_link_kind(self, kind: str) -> None:
        """Declare the physical link to the aircraft: "radio" or "local".

        Must be called BEFORE start(), which is where the stream rates are
        chosen. A radio link gets the conservative profile; a local UDP hop to
        SITL or a same-machine autopilot gets the fast one.
        """
        if kind in ("radio", "local"):
            self._link_kind = kind

    # ------------------------------------------------------------------ #
    # Connection                                                           #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _kill_stale_mavsdk_servers(endpoint: str = "") -> None:
        """
        Kill leftover mavsdk_server processes so they release their MAVLink port.

        `endpoint` narrows the kill to servers whose command line contains it
        (e.g. '0.0.0.0:14540'), so reconnecting the primary drone never kills
        the fleet drones' servers and vice versa. Empty endpoint = kill all
        (legacy behavior, avoid in swarm mode).
        """
        pattern = f"mavsdk_server.*{endpoint}" if endpoint else "mavsdk_server"
        TelemetryManager._kill_mavsdk_by_pattern(pattern)

    @staticmethod
    def _kill_mavsdk_by_pattern(pattern: str) -> None:
        import subprocess, signal, os, time
        try:
            result = subprocess.run(
                ["pgrep", "-f", pattern],
                capture_output=True, text=True
            )
            pids = [int(p) for p in result.stdout.strip().split() if p]
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGTERM)
                    logger.info(f"Killed stale mavsdk_server (PID {pid})")
                except ProcessLookupError:
                    pass
            if pids:
                time.sleep(0.5)  # allow OS to release the UDP port + die
                # REAP them. mavsdk-python spawns each mavsdk_server as OUR child
                # but never wait()s on one we force-kill, so it lingers as a
                # zombie - and the fleet scan makes dozens per cycle, eventually
                # starving the process table / event loop. waitpid clears them.
                TelemetryManager._reap_children(pids)
        except Exception as e:
            logger.debug(f"mavsdk_server cleanup skipped: {e}")

    @staticmethod
    def _reap_children(pids: list[int] | None = None) -> int:
        """Reap zombie children. With `pids`, target those (mavsdk_servers we
        just killed); SIGKILL any still alive after the grace period, then
        waitpid. With no pids, sweep every dead child (os.waitpid(-1)). Only
        reaps OUR children - ChildProcessError just means it was not ours."""
        import os, signal
        reaped = 0
        if pids:
            for pid in pids:
                try:
                    wpid, _ = os.waitpid(pid, os.WNOHANG)
                    if wpid == 0:                 # still alive - force it
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        wpid, _ = os.waitpid(pid, 0)
                    if wpid:
                        reaped += 1
                except (ChildProcessError, ProcessLookupError):
                    pass
            return reaped
        while True:                               # generic sweep
            try:
                wpid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if wpid == 0:
                break
            reaped += 1
        return reaped

    async def connect(self, address: str = "udpin://0.0.0.0:14540", kill_stale: bool = True) -> bool:
        # Fix deprecated udp:// format automatically
        if address.startswith("udp://:"):
            port = address.split(":")[-1]
            address = f"udpin://0.0.0.0:{port}"

        self._address = address

        # Kill any stale mavsdk_server holding THIS address's port from a prior
        # session. Scoped to the endpoint so other drones' servers survive.
        if kill_stale:
            endpoint = address.split("://")[-1]
            await asyncio.get_event_loop().run_in_executor(
                None, self._kill_stale_mavsdk_servers, endpoint
            )

        # Create a fresh System() - reusing a stale one causes gRPC channel errors.
        # CRITICAL: each System must own a UNIQUE gRPC port. MAVSDK-Python defaults
        # every instance to port 50051; with multiple drones, only the first
        # mavsdk_server binds it and every later System silently connects to that
        # SAME server - so all drones mirror one vehicle and every command routes
        # to it (the "arm one drone, all show armed" bug).
        self._grpc_port = _find_free_port()
        self._drone = System(port=self._grpc_port, sysid=self._sysid, compid=190)
        logger.info(f"mavsdk_server gRPC port {self._grpc_port} for {address}")

        logger.info(f"Connecting to drone at {address} ...")

        async def _wait_for_heartbeat():
            async for state in self._drone.core.connection_state():
                if state.is_connected:
                    return True
            return False

        try:
            # This call itself (spawning/attaching to mavsdk_server and
            # establishing its gRPC channel) had no timeout - only the
            # heartbeat wait below did. If mavsdk_server fails to spawn or
            # the gRPC handshake stalls for any reason, this line alone
            # could hang forever with nothing ever timing out, leaving the
            # frontend stuck on "connecting" indefinitely with no error to
            # show - a real infinite hang, not just a slow connect.
            await asyncio.wait_for(self._drone.connect(system_address=address), timeout=10.0)
            logger.info("Waiting for heartbeat...")
            # No timeout here previously meant a link with a listening socket
            # but no traffic yet (e.g. an RF bridge waiting on real hardware)
            # hung this call forever instead of failing with a clear error.
            if await asyncio.wait_for(_wait_for_heartbeat(), timeout=15.0):
                self._connected = True
                logger.info(f"✅ Drone connected at {address}")
                return True
        except asyncio.TimeoutError:
            logger.error(f"❌ Connection timed out at {address}")
            return False
        except Exception as e:
            logger.error(f"❌ Connection failed: {e}")
            return False
        return False

    # ------------------------------------------------------------------ #
    # Start / Stop                                                         #
    # ------------------------------------------------------------------ #

    async def _set_rates(self):
        """
        Lower MAVLink telemetry rates to prevent mavsdk_server callback queue
        flooding (which can block mission upload ACKs).
        Each call has a 2s timeout so a non-responsive drone never hangs start().

        A real telemetry radio over serial has a fraction of the effective
        throughput of UDP/SITL (a 57600 baud SiK-style radio is often far below
        its nominal baud rate in practice, and half-duplex) - the UDP rates below
        can saturate it and cause exactly the kind of intermittent "Socket closed"
        disconnects that don't happen in QGroundControl, which is far more
        conservative over slow links. Use a lower profile for serial.

        THE ADDRESS DOES NOT TELL YOU WHAT THE LINK IS. It names the hop
        between this process and mavsdk_server, not the hop between the ground
        and the aircraft. In this product the radio is plugged into the
        OPERATOR'S machine and relayed to the backend (serial_bridge.py,
        rf_bridge.py), so mavsdk always sees `udpin://127.0.0.1:<port>` no
        matter what is at the far end - which meant a startswith("serial://")
        test was false on every real-radio flight this platform has ever
        made, and the "conservative over slow links" profile below was
        selected exactly never. The bridges now declare the physical link
        instead (`set_link_kind`), and the address is only the fallback for a
        genuinely local serial cable.
        """
        is_serial = (self._link_kind == "radio"
                     or self._address.startswith("serial://"))

        if self._fleet_mode:
            # Fleet drones: only the two streams we actually control via rate commands.
            # armed() and flight_mode() derive from HEARTBEAT (PX4 sends at 1 Hz by default,
            # no separate rate command needed). Velocity and GPS are dropped entirely.
            rates = [
                ("position", self._drone.telemetry.set_rate_position, 1.0),
                ("attitude", self._drone.telemetry.set_rate_attitude_euler, 2.0),
                ("battery",  self._drone.telemetry.set_rate_battery,  0.2),
            ]
        else:
            # WHAT DESERVES BANDWIDTH AND WHAT DOES NOT.
            #
            # These are not one dial. Position and attitude feed the tracking
            # geometry - every metric a follow makes is computed against them,
            # and a stale attitude is worse than a slow one because it is
            # confidently wrong. Battery, GPS count and home position are
            # dashboard numbers that change over minutes and cost the same
            # bandwidth per message as the ones that matter.
            #
            # EVERY FIGURE HERE IS THE ORIGINAL ONE. They were briefly raised
            # on the reasoning that QGroundControl sustains more over the same
            # 3DR radio; that produced a link which would not hold and commands
            # that did not arrive, because QGC is not also running this
            # application's uplink and a SiK radio is half-duplex - saturating
            # the downlink starves the commands going the other way.
            #
            # They are settings rather than constants now, which is the part
            # worth keeping: raise them deliberately, one step at a time,
            # against measured_rates on the telemetry page. A number measured
            # on THIS radio is worth more than one inferred from another
            # ground station's behaviour.
            cfg = get_settings()
            rates = [
                # POSITION CARRIES VELOCITY. Both MAVSDK setters drive the one
                # GLOBAL_POSITION_INT message and it keeps the higher of the
                # two (telemetry_impl.cpp: max(_position_rate_hz,
                # _velocity_ned_rate_hz)), so setting velocity separately
                # cannot buy a second stream - it can only push position up,
                # and setting it LOWER does nothing at all. It is deliberately
                # not set here: one message, one rate, and the budget below
                # counts it once.
                ("position",     self._drone.telemetry.set_rate_position,
                 cfg.telemetry_rate_position_radio if is_serial else cfg.telemetry_rate_position_udp),
                ("attitude",     self._drone.telemetry.set_rate_attitude_euler,
                 cfg.telemetry_rate_attitude_radio if is_serial else cfg.telemetry_rate_attitude_udp),
                # Dashboard-only from here down. A battery percentage that
                # updates twice a second is not twice as useful as one that
                # updates every two seconds, and on a shared radio the
                # difference is bandwidth taken from the tracking loop.
                ("battery",      self._drone.telemetry.set_rate_battery,        1.0 if is_serial else 2.0),
                ("gps_info",     self._drone.telemetry.set_rate_gps_info,       1.0 if is_serial else 2.0),
                ("home",         self._drone.telemetry.set_rate_home,           0.5 if is_serial else 1.0),
                # in_air is the one low-rate stream that IS load-bearing: the
                # UI picks TAKEOFF vs SET ALT from it. Cheap - EXTENDED_SYS_STATE
                # is a 2-byte payload - so there is no reason to starve it.
                ("in_air",       self._drone.telemetry.set_rate_in_air,         1.0 if is_serial else 2.0),
            ]
            budget = self._downlink_bytes_s(rates)
            logger.info(
                f"Telemetry profile: {'RADIO' if is_serial else 'UDP/local'} "
                f"- position {rates[0][2]:g} Hz, attitude {rates[1][2]:g} Hz "
                f"- ~{budget:.0f} B/s downlink"
                + (f" ({budget / self._RADIO_CEILING_BYTES_S * 100:.0f}% of a "
                   f"conservative 3DR ceiling)" if is_serial else "")
            )
            if is_serial and budget > self._RADIO_CEILING_BYTES_S * self._RADIO_BUDGET_WARN:
                logger.warning(
                    f"Requested streams total ~{budget:.0f} B/s, past "
                    f"{self._RADIO_BUDGET_WARN * 100:.0f}% of what a 3DR link "
                    f"can be relied on to carry. A SiK radio is half-duplex, so "
                    f"the downlink takes its slots from the SAME budget the "
                    f"commands go out on - this is how a link stays 'connected' "
                    f"while arm and takeoff stop arriving. Check measured_rates: "
                    f"if they are below what was asked for, the radio is already "
                    f"dropping this."
                )
        for name, setter, hz in rates:
            try:
                await asyncio.wait_for(setter(hz), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass  # best-effort; not all PX4 builds support every rate setter
        logger.info("Telemetry rates configured")

    #: MAVLink v2 wire size per stream, in bytes: 10 B header + payload + 2 B
    #: CRC, payload lengths from common.xml. Upper bounds - v2 truncates
    #: trailing zero bytes, so a real frame is usually a little smaller.
    _FRAME_BYTES = {
        "position": 40,    # GLOBAL_POSITION_INT, payload 28
        "attitude": 40,    # ATTITUDE, payload 28
        "battery": 48,     # BATTERY_STATUS, payload 36
        "gps_info": 42,    # GPS_RAW_INT, payload 30
        "home": 64,        # HOME_POSITION, payload 52
        "in_air": 14,      # EXTENDED_SYS_STATE, payload 2
    }
    #: What PX4 sends on its own whatever we ask for, and therefore has to be
    #: counted: HEARTBEAT (21 B, 1 Hz, fixed - PX4 calls it a constant-rate
    #: stream whose rate is never adjusted) and SYS_STATUS (43 B, 1 Hz).
    _UNREQUESTED_BYTES_S = 21 + 43

    #: Conservative usable DOWNLINK on a stock 3DR: 64 kbit/s air rate, halved
    #: by ECC, halved again because SiK is half-duplex TDM, less ~20% framing
    #: and preamble. Deliberately pessimistic - being wrong in this direction
    #: costs a warning, being wrong the other way costs a flight.
    _RADIO_CEILING_BYTES_S = 1600.0
    #: SiK degrades well before nominal saturation, because the uplink shares
    #: the same slots and loses them first. Half is where to start worrying.
    _RADIO_BUDGET_WARN = 0.5

    @classmethod
    def _downlink_bytes_s(cls, rates) -> float:
        """Bytes per second the requested streams will ask the link to carry.

        Turns "is 6 Hz safe?" from a matter of opinion into arithmetic. The
        number that matters is not the rate of any one stream but the sum, and
        the sum is what nobody was computing - including me, when I raised
        these to 10/8 Hz on the reasoning that QGroundControl sustains more.
        """
        total = float(cls._UNREQUESTED_BYTES_S)
        for name, _setter, hz in rates:
            total += cls._FRAME_BYTES.get(name, 40) * hz
        return total

    async def start(self):
        """Starts all telemetry subscription tasks."""
        if not self._connected:
            logger.error("Cannot start - not connected")
            return

        self._running = True

        # Lower MAVLink rates first to keep mavsdk_server callback queue healthy
        await self._set_rates()

        # Each subscription runs as an independent task.
        # If one crashes, the others keep running.
        # NOTE: groundspeed is computed inside _subscribe_velocity - no separate task.
        if self._fleet_mode:
            # Fleet drones: 4 gRPC streams only.
            # - position: 1 Hz for map markers
            # - armed + flight_mode: derived from HEARTBEAT (1 Hz), no extra overhead
            # - battery: 0.2 Hz for HUD indicator
            # Velocity and GPS are omitted - they add 2 more streams per drone
            # (6 total per drone × N drones) without adding essential fleet-control value.
            # This keeps N=3 drones at 12 total streams rather than 18.
            self._tasks = [
                asyncio.create_task(self._subscribe_position(),    name="fleet_position"),
                # Attitude at the fleet rate (2 Hz): heading is what places a
                # camera observation in the world. Without it the fleet
                # reported heading 0.0 for every drone and avoidance mapped
                # every obstacle relative to NORTH instead of the nose.
                asyncio.create_task(self._subscribe_attitude(),    name="fleet_attitude"),
                asyncio.create_task(self._subscribe_armed(),       name="fleet_armed"),
                asyncio.create_task(self._subscribe_flight_mode(), name="fleet_mode"),
                asyncio.create_task(self._subscribe_battery(),     name="fleet_battery"),
                # Mission progress is event-driven (only fires on waypoint
                # changes) - negligible cost, and fleet surveys need per-drone
                # WP progress in the UI.
                asyncio.create_task(self._subscribe_mission_progress(), name="fleet_mission"),
                asyncio.create_task(self._command_loop(),          name="fleet_cmd"),
                asyncio.create_task(self._offboard_watchdog(),      name="fleet_ob_watchdog"),
            ]
        else:
            self._tasks = [
                asyncio.create_task(self._subscribe_attitude(),        name="tel_attitude"),
                asyncio.create_task(self._subscribe_position(),        name="tel_position"),
                asyncio.create_task(self._subscribe_velocity(),        name="tel_velocity"),
                asyncio.create_task(self._subscribe_battery(),         name="tel_battery"),
                asyncio.create_task(self._subscribe_gps(),             name="tel_gps"),
                asyncio.create_task(self._subscribe_flight_mode(),     name="tel_mode"),
                asyncio.create_task(self._subscribe_armed(),           name="tel_armed"),
                asyncio.create_task(self._subscribe_in_air(),          name="tel_inair"),
                asyncio.create_task(self._subscribe_wind(),            name="tel_wind"),
                asyncio.create_task(self._subscribe_home(),            name="tel_home"),
                asyncio.create_task(self._subscribe_health(),          name="tel_health"),
                asyncio.create_task(self._subscribe_rc_status(),       name="tel_rc"),
                asyncio.create_task(self._subscribe_mission_progress(),name="tel_mission"),
                asyncio.create_task(self._poll_mission_finished(),     name="tel_mission_finished"),
                # Event-driven, no rate, no cost until the FC speaks - and it
                # carries the only explanation there is for a refused command.
                asyncio.create_task(self._subscribe_status_text(),      name="tel_statustext"),
                asyncio.create_task(self._command_loop(),              name="cmd_loop"),
                # The only stop for a runaway that does not depend on the vision
                # loop still working - see _offboard_watchdog.
                asyncio.create_task(self._offboard_watchdog(),          name="tel_ob_watchdog"),
            ]

        logger.info(f"Telemetry started - {len(self._tasks)} tasks ({'fleet' if self._fleet_mode else 'primary'})")

    async def stop(self, kill_stale: bool = True):
        """Cleanly cancels all tasks and closes connection."""
        self._running = False
        self._connected = False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        # Kill OUR OWN mavsdk_server, matched by its unique gRPC port - NOT by
        # the shared UDP endpoint. During a page reload the old session's
        # destroy runs concurrently with the new session's scan on the SAME
        # ports; an endpoint-wide kill here would murder the new session's
        # freshly spawned server ("drones won't connect until backend restart").
        if kill_stale and self._grpc_port:
            pattern = f"mavsdk_server -p {self._grpc_port} "
            await asyncio.get_event_loop().run_in_executor(
                None, self._kill_mavsdk_by_pattern, pattern
            )
        self._drone = None
        logger.info("Telemetry stopped")

    # ------------------------------------------------------------------ #
    # Telemetry subscriptions                                              #
    # Each one is an infinite async loop that updates _snapshot           #
    # ------------------------------------------------------------------ #

    async def _subscribe_attitude(self):
        try:
            async for att in self._drone.telemetry.attitude_euler():
                if not self._running:
                    break
                self._snapshot.attitude = AttitudeData(
                    roll_deg=round(att.roll_deg, 2),
                    pitch_deg=round(att.pitch_deg, 2),
                    yaw_deg=round(att.yaw_deg, 2),
                )
                # Compass heading is yaw remapped from -180..180 to 0..360 -
                # avoids a separate heading() gRPC streaming subscription
                # (one less stream in mavsdk_server's shared callback queue).
                self._snapshot.heading_deg = round(att.yaw_deg % 360, 1)
                self._count("attitude")
                self._notify_pose()
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Attitude subscription error: {e}")

    async def _subscribe_position(self):
        try:
            async for pos in self._drone.telemetry.position():
                if not self._running:
                    break
                self._snapshot.position = PositionData(
                    latitude_deg=pos.latitude_deg,
                    longitude_deg=pos.longitude_deg,
                    absolute_altitude_m=round(pos.absolute_altitude_m, 2),
                    relative_altitude_m=round(pos.relative_altitude_m, 2),
                )
                self._count("position")
                self._notify_pose()
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Position subscription error: {e}")

    async def _subscribe_velocity(self):
        try:
            async for vel in self._drone.telemetry.velocity_ned():
                if not self._running:
                    break
                self._snapshot.velocity = VelocityData(
                    north_m_s=round(vel.north_m_s, 2),
                    east_m_s=round(vel.east_m_s, 2),
                    down_m_s=round(vel.down_m_s, 2),
                )
                # Compute groundspeed here - avoids a duplicate velocity_ned() subscription
                self._snapshot.groundspeed_m_s = round(
                    math.sqrt(vel.north_m_s**2 + vel.east_m_s**2), 2
                )
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Velocity subscription error: {e}")

    async def _subscribe_battery(self):
        try:
            async for bat in self._drone.telemetry.battery():
                if not self._running:
                    break
                self._snapshot.battery = BatteryData(
                    voltage_v=round(bat.voltage_v, 2),
                    remaining_percent=round(bat.remaining_percent, 1),
                )
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Battery subscription error: {e}")

    async def _subscribe_gps(self):
        try:
            async for gps in self._drone.telemetry.gps_info():
                if not self._running:
                    break
                self._snapshot.gps = GPSData(
                    fix_type=gps.fix_type.value,
                    satellites_visible=gps.num_satellites,
                )
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"GPS subscription error: {e}")

    async def _subscribe_flight_mode(self):
        try:
            async for mode in self._drone.telemetry.flight_mode():
                if not self._running:
                    break
                name = str(mode).replace("FlightMode.", "")
                changed = self._snapshot.flight_mode.mode != name
                self._snapshot.flight_mode.mode = name
                if changed:
                    self._check_offboard_departure(name)
                self._emit(force=changed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Flight mode subscription error: {e}")

    async def _subscribe_armed(self):
        try:
            async for armed in self._drone.telemetry.armed():
                if not self._running:
                    break
                changed = self._snapshot.flight_mode.is_armed != armed
                self._snapshot.flight_mode.is_armed = armed
                if changed and not armed:
                    # A DISARM ENDS THE ARGUMENT. The latch exists to stop the
                    # app grabbing an aircraft out of a flying pilot's hands;
                    # on the ground there is nothing to grab, and leaving it
                    # set would make the next flight refuse to arm Offboard
                    # for a reason that stopped being true when the props did.
                    self._clear_pilot_override()
                self._emit(force=changed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Armed subscription error: {e}")

    async def _subscribe_in_air(self):
        try:
            async for in_air in self._drone.telemetry.in_air():
                if not self._running:
                    break
                changed = self._snapshot.flight_mode.is_in_air != in_air
                self._snapshot.flight_mode.is_in_air = in_air
                self._emit(force=changed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"In-air subscription error: {e}")

    async def _subscribe_status_text(self):
        """The autopilot's own words. Event-driven - there is no rate to set,
        and it costs nothing on the link until the FC has something to say."""
        try:
            async for st in self._drone.telemetry.status_text():
                if not self._running:
                    break
                import time as _time
                sev = str(getattr(st, "type", "")).replace("StatusTextType.", "")
                text = (getattr(st, "text", "") or "").strip()
                if not text:
                    continue
                self._status_text.append((_time.monotonic(), sev, text))
                del self._status_text[:-self._STATUS_TEXT_KEEP]
                # THE CALIBRATION PICTURE COMES FROM HERE, not from the
                # plugin's cooked progress - see telemetry/calibration.py for
                # why.
                #
                # Guarded for the same reason the message listener below is:
                # THIS LOOP CARRIES THE AUTOPILOT'S REFUSAL REASONS, and an
                # exception anywhere in it ends the subscription for the rest
                # of the flight. Every "arming denied because…" after that
                # point would degrade to "the drone refused the command",
                # sending the operator to check a radio that is working.
                # Nothing about drawing a calibration is worth that.
                try:
                    self._feed_calibration(text)
                except Exception as e:
                    logger.debug(f"Calibration feed raised: {e}")
                if self._status_event is not None:
                    self._status_event.set()
                if self._on_fc_message:
                    try:
                        self._on_fc_message({
                            "severity": sev,
                            "text": text,
                            "rank": self._severity_rank(sev),
                            "ts": _time.time(),
                        })
                    except Exception as e:
                        # A viewer must never be able to break the subscription
                        # that feeds the refusal reasons.
                        logger.debug(f"FC message listener raised: {e}")
                if self._severity_rank(sev) >= self._STATUS_MIN_SEVERITY:
                    logger.warning(f"FC: {sev}: {text}")
                else:
                    logger.info(f"FC: {text}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Status text subscription error: {e}")

    @staticmethod
    def _severity_rank(sev: str) -> int:
        """MAVSDK's StatusTextType ascends with severity, unlike MAVLink's own
        SEVERITY enum which descends - worth naming, because reading it the
        MAVLink way silently inverts the filter and keeps only the chatter."""
        order = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL",
                 "ALERT", "EMERGENCY"]
        try:
            return order.index(sev)
        except ValueError:
            return 0

    async def _fc_reason(self, since: float, fallback: str) -> str:
        """The FC's explanation for something that just failed.

        Waits a beat for it, because the refusal ACK and the STATUSTEXT that
        explains it are two different messages and arrive in that order.
        """
        import time as _time

        def _pick() -> Optional[str]:
            for ts, sev, text in reversed(self._status_text):
                if ts >= since and self._severity_rank(sev) >= self._STATUS_MIN_SEVERITY:
                    return text
            return None

        found = _pick()
        if found:
            return found
        if self._status_event is None:
            self._status_event = asyncio.Event()
        deadline = _time.monotonic() + self._STATUS_WAIT_S
        while _time.monotonic() < deadline:
            self._status_event.clear()
            try:
                await asyncio.wait_for(
                    self._status_event.wait(), timeout=deadline - _time.monotonic()
                )
            except asyncio.TimeoutError:
                break
            found = _pick()
            if found:
                return found
        return fallback

    async def _subscribe_wind(self):
        """
        Wind velocity estimated by PX4 EKF2 from GPS + IMU.
        No extra sensor needed - available on all PX4 multirotors.
        MAVLink: WIND_COV message. MAVSDK: telemetry.fixedwing_metrics()
        works for multirotors too (PX4 always runs EKF2 wind estimation).
        """
        try:
            async for metrics in self._drone.telemetry.fixedwing_metrics():
                if not self._running:
                    break
                # airspeed_m_s comes from EKF2 on multirotors when airspeed sensor absent
                # Use velocity NED vs groundspeed to infer wind - or use raw if available
                # MAVSDK doesn't expose WIND_COV directly; use best available
                # We approximate: wind = GPS groundspeed direction vs airspeed
                # For now store zeros - actual wind needs raw MAVLink WIND_COV
                # This subscription keeps the slot open for future raw MAVLink support
                self._snapshot.wind_north_m_s = 0.0
                self._snapshot.wind_east_m_s = 0.0
        except asyncio.CancelledError:
            pass
        except Exception:
            # Not all PX4 builds expose this - fail silently
            pass

    async def _subscribe_home(self):
        """
        Home position from HOME_POSITION MAVLink message.
        Set automatically by PX4 on first arm or can be set manually.
        MAVSDK: telemetry.home()
        """
        try:
            async for home in self._drone.telemetry.home():
                if not self._running:
                    break
                self._snapshot.home_lat = home.latitude_deg
                self._snapshot.home_lng = home.longitude_deg
                self._snapshot.home_alt = round(home.absolute_altitude_m, 2)
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Home position subscription error: {e}")

    async def _subscribe_health(self):
        """The autopilot's own per-sensor verdict - the same flags QGC shows.

        This is the ONLY honest source for "calibrated" vs "needs
        calibration" on the sensors page: PX4 keeps its calibration state in
        CAL_* parameters and reports the verdict here, so it survives
        reboots and does not depend on what the data happens to read.
        Event-driven on change, like flight mode.
        """
        try:
            async for h in self._drone.telemetry.health():
                if not self._running:
                    break
                new = SensorHealthData(
                    received=True,
                    gyro_cal_ok=h.is_gyrometer_calibration_ok,
                    accel_cal_ok=h.is_accelerometer_calibration_ok,
                    mag_cal_ok=h.is_magnetometer_calibration_ok,
                    local_position_ok=h.is_local_position_ok,
                    global_position_ok=h.is_global_position_ok,
                    home_position_ok=h.is_home_position_ok,
                    armable=h.is_armable,
                )
                changed = new != self._snapshot.health
                self._snapshot.health = new
                # Force on change: a calibration flag flipping is exactly the
                # moment the sensors page must repaint, and health messages
                # are rare enough that rate-limiting them away could delay
                # that repaint by seconds.
                self._emit(force=changed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Health subscription error: {e}")

    async def _subscribe_rc_status(self):
        """RC receiver state, from the autopilot's side of the link - the
        Radio page's "is the transmitter actually reaching the aircraft"
        light. Event-driven on change, like health."""
        try:
            async for rc in self._drone.telemetry.rc_status():
                if not self._running:
                    break
                # No receiver (every SITL run) reports signal strength as
                # NaN. Python json will happily serialise that as a literal
                # NaN - which no browser can parse, and a socket.io client
                # that cannot parse a packet closes the whole connection.
                pct = rc.signal_strength_percent
                new = RcStatusData(
                    was_available=rc.was_available_once,
                    available=rc.is_available,
                    signal_pct=round(pct, 1) if pct == pct else 0.0,
                )
                changed = new != self._snapshot.rc
                self._snapshot.rc = new
                self._emit(force=changed)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"RC status subscription error: {e}")

    async def _subscribe_mission_progress(self):
        """
        Active mission waypoint index from MISSION_CURRENT MAVLink message.
        Updates every time the drone advances to the next waypoint during a mission.
        Retries on error so a transient gRPC failure doesn't permanently kill tracking.
        """
        while self._running:
            try:
                async for progress in self._drone.mission.mission_progress():
                    if not self._running:
                        return
                    self._snapshot.mission_current_index = progress.current
                    self._emit()
            except asyncio.CancelledError:
                return
            except Exception as e:
                if not self._running:
                    return
                logger.debug(f"Mission progress subscription restarting in 2s: {e}")
                try:
                    await asyncio.sleep(2.0)
                except asyncio.CancelledError:
                    return

    async def _poll_mission_finished(self):
        """
        mission.is_mission_finished() is request/response, not a stream - MAVSDK
        has no push notification for mission completion, and MISSION_CURRENT
        freezes at the last index instead of signalling done. Poll it instead so
        the frontend can tell "still on last waypoint" apart from "actually done".
        """
        while self._running:
            try:
                finished = await asyncio.wait_for(
                    self._drone.mission.is_mission_finished(), timeout=2.0
                )
                if finished != self._snapshot.mission_finished:
                    self._snapshot.mission_finished = finished
                    self._emit()
            except asyncio.CancelledError:
                return
            except Exception:
                pass  # transient gRPC hiccup - just retry next tick
            try:
                await asyncio.sleep(1.0)
            except asyncio.CancelledError:
                return

    async def download_mission(self) -> list[dict]:
        """Download the current mission stored on the drone as a list of waypoint dicts."""
        from mavsdk.mission import MissionItem

        def _num(v, default=0.0):
            # PX4 stores NaN for "use default" on several MissionItem fields
            # (e.g. speed_m_s on a takeoff item). json.dumps happily emits a
            # bare NaN token, which is invalid JSON - the browser's
            # JSON.parse() throws on it and silently kills the websocket with
            # no error surfaced anywhere. Never let NaN reach the socket.
            return v if v == v else default

        try:
            result = await asyncio.wait_for(
                self._drone.mission.download_mission(), timeout=10.0
            )
            items = []
            for item in result.mission_items:
                cmd = 'waypoint'
                if item.vehicle_action == MissionItem.VehicleAction.TAKEOFF:
                    cmd = 'takeoff'
                elif item.vehicle_action == MissionItem.VehicleAction.LAND:
                    cmd = 'land'
                items.append({
                    'lat':      _num(item.latitude_deg),
                    'lng':      _num(item.longitude_deg),
                    'altitude': _num(item.relative_altitude_m),
                    'speed':    _num(item.speed_m_s),
                    'hold_time': _num(item.loiter_time_s, 0),
                    'type':     cmd,
                    'yaw':      item.yaw_deg if item.yaw_deg == item.yaw_deg else None,
                })
            logger.info(f"Downloaded {len(items)} waypoints from drone")
            return items
        except Exception as e:
            logger.warning(f"Mission download failed: {e}")
            return []

    async def _wait_for_mission_mode(self, timeout: float) -> bool:
        """Poll _snapshot.flight_mode until it reports MISSION, or timeout."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if self._snapshot.flight_mode.mode == "MISSION":
                return True
            await asyncio.sleep(0.1)
        return False

    async def _rewind_if_finished(self):
        """A finished mission won't restart via MISSION_START - PX4 leaves the
        current item parked at the end, so 'start' silently does nothing (the
        old 'must re-upload before every start' bug). Rewind to waypoint 0 so
        start always means 'fly the mission again'."""
        finished = self._snapshot.mission_finished
        if not finished and self._fleet_mode:
            # Fleet mode doesn't run the finished-poll task - ask once at
            # start time instead (single request/response, only when starting)
            try:
                finished = await asyncio.wait_for(
                    self._drone.mission.is_mission_finished(), timeout=2.0
                )
            except Exception:
                finished = False
        if not finished:
            return
        try:
            await asyncio.wait_for(
                self._drone.mission.set_current_mission_item(0), timeout=3.0
            )
            self._snapshot.mission_finished = False
            logger.info("Finished mission rewound to waypoint 0")
        except Exception as e:
            logger.warning(f"Mission rewind failed: {e} - starting anyway")

    @_claims_mode_change
    async def start_mission(self) -> bool:
        """
        Start the uploaded mission. Drone must be armed.

        PX4 occasionally needs a moment to finish digesting a just-completed
        mission upload before it will honour MISSION_START - the command can
        be ACKed but not actually switch flight mode. Retry once if the mode
        doesn't confirm MISSION within 2s, instead of leaving the user stuck
        on a silent failure.
        """
        try:
            await self._rewind_if_finished()
            for attempt in range(2):
                await self._drone.mission.start_mission()
                if await self._wait_for_mission_mode(timeout=2.0):
                    logger.info("✅ Mission started")
                    return True
                logger.warning(f"start_mission attempt {attempt + 1} didn't confirm MISSION mode")
            logger.error("Start mission failed: mode never switched to MISSION")
            return False
        except Exception as e:
            logger.error(f"Start mission failed: {e}")
            return False

    @_claims_mode_change
    async def arm_and_start_mission(self) -> tuple[bool, str]:
        """Arm the drone (if not already armed) then start the uploaded mission."""
        try:
            if not self._snapshot.flight_mode.is_armed:
                logger.info("Arming drone before mission start...")
                await asyncio.wait_for(self._drone.action.arm(), timeout=10.0)
                # Wait up to 5s for armed state to confirm via telemetry
                for _ in range(50):
                    await asyncio.sleep(0.1)
                    if self._snapshot.flight_mode.is_armed:
                        break
                if not self._snapshot.flight_mode.is_armed:
                    return False, "Arm command sent but drone did not confirm armed state"
                logger.info("✅ Armed")
            await self._rewind_if_finished()
            for attempt in range(2):
                await self._drone.mission.start_mission()
                if await self._wait_for_mission_mode(timeout=2.0):
                    logger.info("✅ Mission started (arm + start)")
                    return True, "Armed and mission started"
                logger.warning(f"arm_and_start_mission attempt {attempt + 1} didn't confirm MISSION mode")
            return False, "Armed, but mission never switched to MISSION mode"
        except asyncio.TimeoutError:
            return False, "Arm timed out - check safety switch and pre-arm checks"
        except Exception as e:
            logger.error(f"Arm+start failed: {e}")
            return False, str(e)

    async def _correct_altitude_after_takeoff(self, relative_altitude_m: float):
        """Wait until the drone actually leaves the ground, then goto the
        requested altitude. Belt-and-braces for the MIS_TAKEOFF_ALT race -
        harmless when takeoff already targets the right altitude."""
        try:
            for _ in range(30):  # up to 15 s to get airborne
                await asyncio.sleep(0.5)
                if self._snapshot.position.relative_altitude_m > 1.0:
                    break
            else:
                return  # never left the ground - nothing to correct
            await asyncio.sleep(1.0)
            pos = self._snapshot.position
            ground_amsl = self._snapshot.home_alt or (
                pos.absolute_altitude_m - pos.relative_altitude_m
            )
            await self._drone.action.goto_location(
                pos.latitude_deg, pos.longitude_deg,
                float(ground_amsl + float(relative_altitude_m)), float('nan'),
            )
            logger.info(f"Altitude locked to {relative_altitude_m} m after takeoff")
        except Exception as e:
            logger.warning(f"Post-takeoff altitude correction skipped: {e}")

    @_claims_mode_change
    async def goto_altitude(self, relative_altitude_m: float) -> bool:
        """
        Hold the current lat/lon and move to a new relative altitude.

        A landed drone silently ignores DO_REPOSITION (PX4 ACKs the command
        but stays on the ground), so grounded drones are armed if needed and
        sent a takeoff to the target altitude instead; only airborne drones
        get goto_location. Fleet mode doesn't subscribe to in_air, so
        "grounded" is judged from the relative altitude stream.
        Ground altitude is derived from the position stream (absolute − relative)
        because fleet mode doesn't subscribe to HOME_POSITION.
        """
        pos = self._snapshot.position
        if pos.latitude_deg == 0.0 and pos.longitude_deg == 0.0:
            logger.warning("Goto altitude refused - no position yet")
            return False
        in_air = self._snapshot.flight_mode.is_in_air or pos.relative_altitude_m > 1.0
        # A new command supersedes the last verdict. Leaving the old warning up
        # would have it describe an altitude nobody is flying to any more.
        self._snapshot.commanded_altitude_m = float(relative_altitude_m)
        self._snapshot.altitude_warning = None
        try:
            if not in_air:
                if not self._snapshot.flight_mode.is_armed:
                    await asyncio.wait_for(self._drone.action.arm(), timeout=10.0)
                ok = await self.takeoff(float(relative_altitude_m))
                if ok:
                    logger.info(f"✅ Goto altitude {relative_altitude_m} m - grounded, took off instead")
                    # set_takeoff_altitude occasionally doesn't reach PX4 before
                    # the takeoff command and the drone levels at the default
                    # ~2.5 m. Once airborne, reposition to the exact target so
                    # the final altitude never depends on that race.
                    asyncio.create_task(
                        self._correct_altitude_after_takeoff(float(relative_altitude_m))
                    )
                return ok
            ground_amsl = self._snapshot.home_alt or (
                pos.absolute_altitude_m - pos.relative_altitude_m
            )
            await self._drone.action.goto_location(
                pos.latitude_deg, pos.longitude_deg,
                float(ground_amsl + float(relative_altitude_m)), float('nan'),
            )
            logger.info(f"✅ Goto altitude {relative_altitude_m} m commanded")
            self._start_altitude_verify(float(relative_altitude_m))
            return True
        except asyncio.TimeoutError:
            logger.error("Goto altitude failed: arm timed out")
            return False
        except ActionError as e:
            logger.error(f"Goto altitude failed: {e}")
            return False

    @_claims_mode_change
    async def goto_custom_rtl(self, lat: float, lng: float, relative_altitude_m: float) -> bool:
        """
        Abort whatever the drone is doing and fly to a custom RTL point.

        Real PX4 RTL (MAV_CMD_NAV_RETURN_TO_LAUNCH, the 'return' action below)
        only supports the EKF home position - there's no parameter for a custom
        location. To honour a user-chosen RTL point we instead issue
        MAV_CMD_DO_REPOSITION via action.goto_location(), which PX4 accepts in
        any mode and which interrupts an active mission on its own.
        """
        try:
            absolute_altitude_m = (self._snapshot.home_alt or 0.0) + float(relative_altitude_m)
            await self._drone.action.goto_location(
                float(lat), float(lng), float(absolute_altitude_m), float('nan')
            )
            logger.info(f"✅ Custom RTL: repositioning to {lat},{lng} @ {relative_altitude_m}m AGL")
            return True
        except Exception as e:
            logger.error(f"Custom RTL failed: {e}")
            return False

    @_claims_mode_change
    async def goto_home(self, relative_altitude_m: Optional[float] = None) -> bool:
        """
        Fly to THIS drone's own home position (where it armed) and hover there.

        Group RTL uses this instead of goto_custom_rtl so one fleet command
        doesn't send every drone to a single shared point - each vehicle
        resolves its own home. Fleet mode doesn't subscribe to HOME_POSITION,
        so an unset snapshot home is fetched one-shot from the stream (and
        cached into the snapshot so the UI can track arrival).
        """
        home_lat = self._snapshot.home_lat
        home_lng = self._snapshot.home_lng
        home_alt = self._snapshot.home_alt
        if not home_lat and not home_lng:
            async def _first_home():
                async for h in self._drone.telemetry.home():
                    return h
            try:
                home = await asyncio.wait_for(_first_home(), timeout=3.0)
                home_lat = home.latitude_deg
                home_lng = home.longitude_deg
                home_alt = round(home.absolute_altitude_m, 2)
                self._snapshot.home_lat = home_lat
                self._snapshot.home_lng = home_lng
                self._snapshot.home_alt = home_alt
            except Exception as e:
                logger.error(f"RTL home failed - home position unavailable: {e}")
                return False
        pos = self._snapshot.position
        # No altitude given → keep the current altitude (min 5 m) so the
        # return leg never descends into obstacles on its own.
        rel = (float(relative_altitude_m) if relative_altitude_m is not None
               else max(pos.relative_altitude_m, 5.0))
        ground_amsl = home_alt or (pos.absolute_altitude_m - pos.relative_altitude_m)
        try:
            await self._drone.action.goto_location(
                float(home_lat), float(home_lng),
                float(ground_amsl + rel), float('nan'),
            )
            logger.info(f"✅ RTL home: repositioning to {home_lat:.6f},{home_lng:.6f} @ {rel:.0f}m AGL")
            return True
        except Exception as e:
            logger.error(f"RTL home failed: {e}")
            return False

    @_claims_mode_change
    async def restart_mission(self) -> bool:
        """
        Reset to waypoint 0 then start the mission.
        Use this for a fresh start - not for resume (which should call start_mission).
        """
        try:
            try:
                await asyncio.wait_for(
                    self._drone.mission.set_current_mission_item(0),
                    timeout=3.0,
                )
                logger.info("Mission sequence reset to waypoint 0")
            except Exception as e:
                logger.warning(f"set_current_mission_item(0) failed: {e}, proceeding anyway")

            for attempt in range(2):
                await self._drone.mission.start_mission()
                if await self._wait_for_mission_mode(timeout=2.0):
                    logger.info("✅ Mission restarted from waypoint 0")
                    return True
                logger.warning(f"restart_mission attempt {attempt + 1} didn't confirm MISSION mode")
            logger.error("Restart mission failed: mode never switched to MISSION")
            return False
        except Exception as e:
            logger.error(f"Restart mission failed: {e}")
            return False

    @_claims_mode_change
    async def arm_and_restart_mission(self) -> tuple[bool, str]:
        """Arm the drone (if not already armed), reset to waypoint 0, then start mission."""
        try:
            if not self._snapshot.flight_mode.is_armed:
                logger.info("Arming drone before mission restart...")
                await asyncio.wait_for(self._drone.action.arm(), timeout=10.0)
                for _ in range(50):
                    await asyncio.sleep(0.1)
                    if self._snapshot.flight_mode.is_armed:
                        break
                if not self._snapshot.flight_mode.is_armed:
                    return False, "Arm command sent but drone did not confirm armed state"
                logger.info("✅ Armed")

            try:
                await asyncio.wait_for(
                    self._drone.mission.set_current_mission_item(0),
                    timeout=3.0,
                )
                logger.info("Mission sequence reset to waypoint 0")
            except Exception as e:
                logger.warning(f"set_current_mission_item(0) failed: {e}, proceeding anyway")

            for attempt in range(2):
                await self._drone.mission.start_mission()
                if await self._wait_for_mission_mode(timeout=2.0):
                    logger.info("✅ Mission restarted (arm + reset + start)")
                    return True, "Armed and mission restarted from beginning"
                logger.warning(f"arm_and_restart_mission attempt {attempt + 1} didn't confirm MISSION mode")
            return False, "Armed, but mission never switched to MISSION mode"
        except asyncio.TimeoutError:
            return False, "Arm timed out - check safety switch and pre-arm checks"
        except Exception as e:
            logger.error(f"Arm+restart failed: {e}")
            return False, str(e)

    @_claims_mode_change
    async def pause_mission(self) -> bool:
        """Pause mission and enter HOLD mode."""
        try:
            await self._drone.mission.pause_mission()
            logger.info("✅ Mission paused")
            return True
        except Exception as e:
            logger.error(f"Pause mission failed: {e}")
            return False

    async def _set_takeoff_altitude_verified(self, altitude_m: float) -> bool:
        """
        Write MIS_TAKEOFF_ALT and READ IT BACK before trusting it.

        WHY THIS IS NOT PARANOIA. set_takeoff_altitude() is not a command, it
        is a PARAMETER WRITE, and a parameter write is a request/ack round trip
        over the same link the telemetry streams are saturating. On SITL that
        round trip is a local UDP socket and completes in microseconds, so the
        value is always in place by the time takeoff() is sent. Over a 3DR
        radio at 57600 baud, sharing the link with position, attitude, velocity,
        battery, GPS, home and in-air streams, it frequently is not.

        When it is not, PX4 takes off to whatever MIS_TAKEOFF_ALT ALREADY HELD
        - its default 2.5 m, or the value some earlier takeoff left there. The
        commanded number is silently ignored and the aircraft levels somewhere
        else entirely. That is the exact shape of "works in SITL, goes to 3-5 m
        on the real drone when I ask for 2".

        The read-back closes it: nothing is commanded until the vehicle has
        confirmed the value it will actually use, or the attempt has failed
        loudly enough for the operator to see.
        """
        # BOUNDED, because this sits between an operator pressing TAKEOFF and
        # the aircraft moving. Three attempts at two 5 s round trips is 30 s of
        # an armed drone sitting still with props spinning while the ground
        # station says nothing - indistinguishable from a command that was
        # never sent, and far more alarming than a takeoff that reports a
        # parameter it could not confirm.
        target = float(altitude_m)
        last: Optional[float] = None
        for attempt in range(2):
            try:
                await asyncio.wait_for(
                    self._drone.action.set_takeoff_altitude(target), timeout=2.5
                )
                last = float(await asyncio.wait_for(
                    self._drone.action.get_takeoff_altitude(), timeout=2.5
                ))
            except (asyncio.TimeoutError, ActionError, Exception) as e:
                logger.warning(
                    f"Takeoff altitude write attempt {attempt + 1} failed: {e}"
                )
                continue
            # 0.05 m, not equality: the parameter is a float32 and round-trips
            # through a MAVLink param message, so exact comparison would
            # occasionally reject a value that is in fact correct.
            if abs(last - target) <= 0.05:
                if attempt:
                    logger.info(
                        f"Takeoff altitude confirmed at {last:.2f} m on attempt "
                        f"{attempt + 1} - the first write had not landed"
                    )
                return True
            logger.warning(
                f"Takeoff altitude read back as {last:.2f} m, asked for "
                f"{target:.2f} m - retrying"
            )
        logger.error(
            f"❌ MIS_TAKEOFF_ALT would not accept {target:.2f} m "
            f"(vehicle still reports {last if last is not None else 'unknown'}). "
            f"The drone will NOT climb to the commanded altitude."
        )
        return False

    #: MAV_CMD_NAV_TAKEOFF.
    _MAV_CMD_NAV_TAKEOFF = 22

    async def _takeoff_with_altitude_in_the_command(self, relative_altitude_m: float) -> bool:
        """
        Send MAV_CMD_NAV_TAKEOFF the way QGroundControl does: with the altitude
        IN THE COMMAND.

        WHY THIS EXISTS - verified in both codebases, not inferred.

        PX4 takes the takeoff altitude straight off the command
        (navigator_main.cpp):

            rep->current.alt = cmd.param7;

        QGC therefore puts it there (PX4FirmwarePlugin.cc):

            double takeoffAltAMSL = takeoffAltRel + vehicleAltitudeAMSL;
            sendMavCommand(..., MAV_CMD_NAV_TAKEOFF, ..., takeoffAltAMSL);

        MAVSDK's PX4 path sends the SAME command with no params at all
        (action_impl.cpp, takeoff_async_px4) - note that its generic
        takeoff_async_standard DOES set param7, and the PX4 specialisation
        deliberately does not:

            command.command = MAV_CMD_NAV_TAKEOFF;
            command.target_component_id = ...;
            // no maybe_param7

        so param7 arrives as NaN and PX4 falls back to the MIS_TAKEOFF_ALT
        PARAMETER, which set_takeoff_altitude() writes in a separate round trip
        (set_takeoff_altitude_px4 -> set_param_float(TAKEOFF_ALT_PARAM)).

        That single difference is the whole of "it works in QGC". A parameter
        write is a request/ack exchange over a link the telemetry streams are
        already filling, and it carries a persistent side effect on the
        vehicle; a command parameter is neither. Putting the altitude in the
        command removes the parameter from the path entirely.

        NO NaN IS SENT. PX4 substitutes the current position when param5/param6
        are non-finite, so the drone's own latitude and longitude are passed
        instead - identical behaviour, and every field stays a finite float
        that survives the JSON encoding this goes out through. param1 (pitch)
        is fixed-wing only and param4 (yaw) is overwritten by the navigator on
        the line above, so neither is read on a multirotor.
        """
        pos = self._snapshot.position
        if pos.latitude_deg == 0.0 and pos.longitude_deg == 0.0:
            return False
        if not pos.absolute_altitude_m:
            # param7 is AMSL. Without an absolute altitude there is no correct
            # value to put in it, and guessing one would fly the aircraft to a
            # height nobody chose.
            return False
        target_amsl = float(pos.absolute_altitude_m) + float(relative_altitude_m)
        try:
            from mavsdk.mavlink_direct import MavlinkMessage
            fields = json.dumps({
                "target_system": 1,
                "target_component": 1,
                "command": self._MAV_CMD_NAV_TAKEOFF,
                "confirmation": 0,
                "param1": 0.0,          # pitch - fixed-wing only
                "param2": 0.0,          # unused
                "param3": 0.0,          # takeoff flags; QGC sends 0
                "param4": 0.0,          # yaw - navigator overwrites with NaN
                "param5": float(pos.latitude_deg),
                "param6": float(pos.longitude_deg),
                "param7": target_amsl,
            })
            await asyncio.wait_for(
                self._drone.mavlink_direct.send_message(
                    MavlinkMessage("COMMAND_LONG", 0, 0, 1, 1, fields)
                ),
                timeout=5.0,
            )
        except Exception as e:
            logger.warning(f"Direct takeoff command unavailable ({e})")
            return False

        # DID IT ACTUALLY LEAVE THE GROUND. The command is fire-and-forget, so
        # without this a malformed or rejected message would leave an armed
        # aircraft sitting on the ground with props spinning and the UI
        # reporting success.
        # 4 s, not 10. This window is pure DELAY on the fallback path: every
        # second spent here is a second the aircraft has not been told to take
        # off by any means. A multirotor that accepted the command is off the
        # ground well inside 4 s at the default 1.5 m/s climb; one that has not
        # moved by then did not accept it, and waiting longer only postpones
        # the retry. Ten seconds of nothing reads as a command that never went.
        for _ in range(8):                        # up to 4 s
            await asyncio.sleep(0.5)
            if (self._snapshot.position.relative_altitude_m > 0.5
                    or self._snapshot.flight_mode.is_in_air):
                logger.info(
                    f"✅ Takeoff to {relative_altitude_m:g} m commanded directly "
                    f"(param7 = {target_amsl:.1f} m AMSL) - no parameter involved"
                )
                return True
        logger.warning(
            "Direct takeoff command did not lift the aircraft - falling back "
            "to the MAVSDK takeoff path"
        )
        return False

    @_claims_mode_change
    async def takeoff(self, altitude_m: Optional[float] = None) -> bool:
        import time as _time
        sent = _time.monotonic()
        self.last_action_error = None
        # PREFERRED PATH: altitude in the command, exactly as QGC sends it.
        # Falls through to the MAVSDK parameter path below if it is unavailable
        # or the aircraft did not move, so this can only ever add a way for the
        # takeoff to succeed.
        if altitude_m is not None:
            self._snapshot.commanded_altitude_m = float(altitude_m)
            self._snapshot.altitude_warning = None
            if await self._takeoff_with_altitude_in_the_command(float(altitude_m)):
                self._start_altitude_verify(float(altitude_m))
                return True
        try:
            if altitude_m is not None:
                if not await self._set_takeoff_altitude_verified(altitude_m):
                    # Deliberately still takes off, and deliberately says so.
                    # Refusing would strand an armed drone on the ground with
                    # props spinning, which is worse than a takeoff to a known-
                    # wrong altitude the operator has been told about and can
                    # correct with SET ALT.
                    self._snapshot.altitude_warning = (
                        f"Takeoff altitude parameter did not take - the drone may "
                        f"climb to its own default rather than {altitude_m:g} m"
                    )
                self._snapshot.commanded_altitude_m = float(altitude_m)
            await self._drone.action.takeoff()
            logger.info(f"✅ Takeoff commanded (altitude={altitude_m}m)")
            if altitude_m is not None:
                self._start_altitude_verify(float(altitude_m))
            return True
        except ActionError as e:
            self.last_action_error = await self._failure_reason(e, sent, "the drone refused to take off")
            logger.error(f"Takeoff failed: {e} | FC said: {self.last_action_error}")
            return False

    #: How far the drone may settle from the commanded altitude before the
    #: operator is told. Generous: PX4's own acceptance radius is ~0.8 m and
    #: baro noise adds to it, so anything tighter would cry wolf on a healthy
    #: aircraft. 1.5 m still catches every case reported from the field -
    #: "asked for 2, got 5" and "asked for 5, got 10".
    _ALT_TOLERANCE_M = 1.5

    def _start_altitude_verify(self, target_m: float) -> None:
        """Begin verifying one altitude, cancelling any verifier already
        running - the newest command is the only one worth a verdict."""
        if self._alt_verify_task is not None and not self._alt_verify_task.done():
            self._alt_verify_task.cancel()
        self._alt_verify_task = asyncio.create_task(self._verify_altitude(target_m))

    async def _verify_altitude(self, target_m: float) -> None:
        """
        Once the climb has settled, say whether it actually went where it was
        told. Reports; never corrects.

        A GROUND STATION CANNOT FIX THIS CLASS OF ERROR, so it must not pretend
        to. If the vehicle levels 3 m above the commanded height the cause is on
        the aircraft - a parameter that did not take, a barometer pulled down by
        its own prop wash in ground effect, an EKF height estimate diverging from
        the rangefinder it does not have. Issuing a correction on top would fight
        whatever is already wrong and hide the symptom rather than the cause.

        What the operator needs is to KNOW, while there is still flight time to
        do something about it. The number they typed is on screen next to the
        number the drone believes, and the gap is named.
        """
        try:
            # Long enough for the climb plus PX4's settle. A 2 m hop takes a
            # couple of seconds; 30 m takes fifteen. Checked repeatedly rather
            # than once, so the verdict comes from a STABLE altitude and not
            # from a snapshot mid-climb.
            settled_for = 0.0
            last = None
            for _ in range(60):                       # up to 30 s
                await asyncio.sleep(0.5)
                alt = self._snapshot.position.relative_altitude_m
                if last is not None and abs(alt - last) < 0.15:
                    settled_for += 0.5
                else:
                    settled_for = 0.0
                last = alt
                if settled_for >= 3.0 and alt > 0.5:
                    break
            else:
                return                                # never settled - say nothing

            error = last - target_m
            if abs(error) <= self._ALT_TOLERANCE_M:
                self._snapshot.altitude_warning = None
                logger.info(
                    f"Altitude verified: commanded {target_m:.1f} m, "
                    f"holding {last:.1f} m"
                )
            else:
                self._snapshot.altitude_warning = (
                    f"Commanded {target_m:.1f} m, holding {last:.1f} m "
                    f"({error:+.1f} m). Check MIS_TAKEOFF_ALT and the barometer "
                    f"- nothing on the ground station can correct this."
                )
                logger.warning(f"⚠️  {self._snapshot.altitude_warning}")
            self._emit()
        except Exception as e:
            logger.debug(f"Altitude verification skipped: {e}")

    # ------------------------------------------------------------------ #
    # Emit                                                                 #
    # ------------------------------------------------------------------ #

    def _emit(self, force: bool = False):
        """Push latest snapshot to frontend, throttled to _EMIT_RATE_HZ (or
        _FLEET_EMIT_RATE_HZ).

        `force` bypasses the throttle for a DISCRETE STATE CHANGE - armed,
        flight mode, in-air. The throttle exists to stop a 10 Hz attitude
        stream flooding the socket, and for continuous values dropping a frame
        costs nothing: the next one carries a barely different number. A state
        transition is not like that. There is exactly one moment when armed
        goes false→true, and delaying it by up to a tenth of a second adds
        avoidable lag to the one update the operator is actually watching for
        after pressing a button.
        """
        if not self._on_update:
            return
        now = asyncio.get_event_loop().time()
        rate = self._FLEET_EMIT_RATE_HZ if self._fleet_mode else self._EMIT_RATE_HZ
        if not force and (now - self._last_emit) < (1.0 / rate):
            return
        self._last_emit = now
        try:
            self._on_update(self._snapshot.to_dict())
        except Exception as e:
            logger.error(f"Telemetry emit error: {e}")

    # ------------------------------------------------------------------ #
    # Command queue                                                        #
    # ------------------------------------------------------------------ #

    async def _command_loop(self):
        """
        Drains the command queue and sends to drone.
        The queue has maxsize=5 - if full, old commands are dropped.
        This prevents command buildup during network lag.
        """
        while self._running:
            try:
                cmd = await asyncio.wait_for(
                    self._command_queue.get(), timeout=1.0
                )
                await self._send_manual_control(cmd)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Command loop error: {e}")

    async def send_command(self, cmd: DroneCommand):
        """
        Non-blocking command submission.
        If queue is full, drops the oldest command first.
        """
        if self._command_queue.full():
            try:
                self._command_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self._command_queue.put_nowait(cmd)
        except asyncio.QueueFull:
            pass

    async def _send_manual_control(self, cmd: DroneCommand):
        """
        MAVSDK manual_control.set_manual_control_input expects:
          x, y, r: -1.0 to +1.0  (pitch, roll, yaw)
          z:        0.0 to +1.0  (throttle)
        DroneCommand already stores normalized values so pass directly.
        """
        try:
            await self._drone.manual_control.set_manual_control_input(
                x=cmd.pitch,     # forward/back
                y=cmd.roll,      # left/right
                z=cmd.throttle,  # 0.0 to 1.0
                r=cmd.yaw,
            )
        except Exception as e:
            logger.warning(f"Manual control send failed: {e}")

    # ------------------------------------------------------------------ #
    # Actions                                                              #
    # ------------------------------------------------------------------ #

    async def arm(self) -> bool:
        import time as _time
        sent = _time.monotonic()
        self.last_action_error = None
        try:
            await self._drone.action.arm()
            logger.info("✅ Armed")
            return True
        except ActionError as e:
            # COMMAND_DENIED IS AN ANSWER FROM THE AIRCRAFT, NOT A LOST COMMAND.
            # It means the command arrived, the FC understood it and said no -
            # so reporting a bare "arm failed" sends the operator to check the
            # radio, which is the one thing that is definitely working. Take
            # the FC's own line instead.
            self.last_action_error = await self._failure_reason(e, sent, "the drone refused to arm")
            logger.error(f"Arm failed: {e} | FC said: {self.last_action_error}")
            return False

    async def _failure_reason(self, err: Exception, sent: float, fallback: str) -> str:
        """Why a command failed, choosing the right question to ask.

        A TIMEOUT and a DENIAL are opposite diagnoses and must not be handled
        alike. Denied means the aircraft answered: the link works end to end
        and the cause is a pre-arm condition, which PX4 states in a STATUSTEXT
        worth waiting for. Timed out means nothing came back - so a STATUSTEXT
        arriving now is UNRELATED routine chatter that happens to have landed
        in the window, and quoting it as the reason would be confidently
        wrong. Worse, STATUSTEXT travels the downlink, which in this exact
        failure is the half that still works, so there is always something
        available to misquote.
        """
        if "TIMEOUT" in str(err):
            return self._plain(err, fallback) + self._link_note(err)
        return await self._fc_reason(sent, self._plain(err, fallback))

    def _link_note(self, err: Exception) -> str:
        """Appended to a TIMEOUT, and only to a TIMEOUT.

        A DENIED command and a TIMED-OUT command are opposite diagnoses and
        were reported the same way. Denied means the aircraft answered - the
        whole link works and the fault is a pre-arm condition. Timed out means
        nothing came back, and when telemetry is streaming in at the same
        moment that can only be the uplink. Six timeouts in a row (rates,
        mission, UID, arm, fence) is not six faults; it is one dead direction.
        """
        if "TIMEOUT" not in str(err):
            return ""
        bridge = self._bridge_for_diagnosis()
        if bridge is None:
            return ""
        return f" - {bridge.round_trip_verdict()}"

    def _bridge_for_diagnosis(self):
        """The relay bridge feeding this manager, if the link runs through
        one. Looked up by address rather than held, so nothing here keeps a
        closed bridge alive."""
        try:
            from app.telemetry import serial_bridge
            for bridge in serial_bridge._bridges.values():
                if bridge.address == self._address:
                    return bridge
        except Exception:
            pass
        return None

    @staticmethod
    def _plain(err: Exception, fallback: str) -> str:
        """MAVSDK's exception text is a C++ call trace with the enum embedded -
        useless in a status bar. Keep the enum, drop the trace."""
        raw = str(err)
        for code, said in (
            ("COMMAND_DENIED", "the drone refused the command (pre-arm check failed)"),
            ("UNSUPPORTED", "the drone does not support that command"),
            ("TIMEOUT", "no reply from the drone - the command may not have arrived"),
            ("FAILED", "the drone could not carry out the command"),
            ("BUSY", "the drone is busy - try again"),
            ("NO_SYSTEM", "no drone connected"),
        ):
            if code in raw:
                return said
        return fallback

    @_claims_mode_change
    async def disarm(self) -> bool:
        import time as _time
        sent = _time.monotonic()
        self.last_action_error = None
        try:
            await self._drone.action.disarm()
            logger.info("✅ Disarmed")
            return True
        except ActionError as e:
            self.last_action_error = await self._failure_reason(e, sent, "the drone refused to disarm")
            logger.error(f"Disarm failed: {e} | FC said: {self.last_action_error}")
            return False

    @_claims_mode_change
    async def emergency_stop(self) -> bool:
        """
        Kills motors immediately regardless of state.
        Only use in genuine emergency - drone will fall.
        """
        try:
            await self._drone.action.kill()
            logger.warning("🚨 EMERGENCY KILL SENT")
            return True
        except ActionError as e:
            logger.error(f"Emergency kill failed: {e}")
            return False

    async def reboot(self) -> bool:
        try:
            await self._drone.action.reboot()
            logger.info("🔄 FC reboot requested")
            return True
        except ActionError as e:
            logger.error(f"Reboot failed: {e}")
            return False

    # ── Who is flying: Offboard <-> pilot handover ────────────────────────
    #
    # THE APP'S BELIEF THAT IT IS FLYING WAS NEVER CHECKED AGAINST THE
    # AIRCRAFT. `_offboard_active` was set by start_offboard, cleared by
    # stop_offboard, and read by the watchdog - three places, all of them this
    # process. PX4 can end Offboard on its own at any moment, and does, every
    # time a pilot takes over: on the mode switch, or on the sticks when
    # COM_RC_OVERRIDE allows it. Nothing here noticed.
    #
    # What that cost, in order of how bad it is:
    #
    #   1. THE TRACKER KEPT RUNNING. A follow that is mid-chase stayed armed,
    #      still computing setpoints, still calling set_velocity_body. PX4
    #      discards those while a human is flying - but the app is then one
    #      re-entry away from resuming a chase the pilot took over to stop.
    #   2. THE WATCHDOG KEPT THE STREAM ALIVE. It re-sends a zero setpoint
    #      every 200 ms, deliberately, so Offboard never goes stale. After a
    #      takeover that means PX4's offboard-loss failsafe never fires and
    #      Offboard stays instantly re-enterable for the rest of the flight.
    #   3. THE UI STILL SAID "FOLLOWING". The one moment the operator most
    #      needs to know who has the aircraft is the moment it changed hands,
    #      and that was the moment the screen went stale.
    #
    # So the departure is now detected, latched, and announced.

    #: How long after WE ask for a mode change a departure from Offboard is
    #: still attributable to us. Generous against a 1 Hz HEARTBEAT: PX4 may
    #: take a beat to report, and the cost of being late is a false "the pilot
    #: took over" - which stops the tracker and tells the operator something
    #: that is not true. The cost of being early is nothing, because the pilot
    #: taking over inside our own two-second window still ends in the same
    #: place: the app is not flying and does not think it is.
    _OFFBOARD_RELEASE_WINDOW_S = 2.0

    def _claim_next_mode_change(self) -> None:
        """Call immediately BEFORE any action of ours that changes flight mode.

        BOTH DIRECTIONS NEED IT, which the first cut of this missed. Entering
        Offboard races the same way leaving it does: offboard.start() returns
        on PX4's ACK, but flight_mode is derived from a 1 Hz HEARTBEAT, so a
        heartbeat already in flight still carries the OLD mode. Arriving after
        _offboard_active went true, that stale report reads as a departure -
        the app would latch itself out of the Offboard session it had just
        successfully started, every time the previous mode's last heartbeat
        landed late.
        """
        self._offboard_release_until = time.monotonic() + self._OFFBOARD_RELEASE_WINDOW_S

    def _check_offboard_departure(self, mode_name: str) -> None:
        """Did the aircraft just leave Offboard, and was it us who asked?"""
        if not self._offboard_active or mode_name == "OFFBOARD":
            return
        if time.monotonic() < self._offboard_release_until:
            return  # our own stop/land/RTL, arriving as expected
        self._note_pilot_override(mode_name)

    def _note_pilot_override(self, mode_name: str) -> None:
        """The pilot has the aircraft. Stand down, loudly."""
        self._offboard_active = False
        self._offboard_hold_alt = None
        self._last_velocity_cmd_t = 0.0
        self._offboard_stale = False
        self._pilot_override_mode = mode_name
        self._snapshot.offboard_active = False
        self._snapshot.pilot_override = mode_name
        logger.warning(
            f"PILOT HAS CONTROL - the aircraft left Offboard for {mode_name} "
            f"without this app asking. Tracking stops; Offboard will not be "
            f"re-entered until control is taken back deliberately."
        )
        if self._on_pilot_override:
            try:
                self._on_pilot_override(mode_name)
            except Exception as e:
                logger.error(f"Pilot-override callback failed: {e}")

    def _clear_pilot_override(self) -> None:
        if self._pilot_override_mode is None:
            return
        logger.info(f"Pilot override cleared (was {self._pilot_override_mode})")
        self._pilot_override_mode = None
        self._snapshot.pilot_override = None

    @property
    def pilot_has_control(self) -> bool:
        return self._pilot_override_mode is not None

    #: Modes to hand the aircraft to, in order of preference. POSITION is what
    #: a pilot recovering an aircraft wants - it holds position when the sticks
    #: are centred, so letting go is safe. ALTITUDE needs no position estimate,
    #: and STABILIZED needs nothing at all: if the reason the pilot is taking
    #: over is that the position estimate died, POSITION is exactly the mode
    #: PX4 will refuse, and refusing to hand over at all would be the worst
    #: possible answer to "give me the aircraft".
    _HANDOVER_MODES = ("POSITION", "ALTITUDE", "STABILIZED")

    @_claims_mode_change
    async def handover_to_pilot(self) -> tuple[bool, str]:
        """Deliberately give the aircraft to the human, from the ground station.

        This is the OTHER half of the bridge. The pilot's own route out of
        Offboard is their mode switch or their sticks, and that depends on
        aircraft parameters this app does not own (see rc_takeover_readiness).
        This route depends on nothing but the link: it stops Offboard and puts
        PX4 into a stick-flown mode, so the transmitter is live the moment the
        operator presses it - including when the mode switch is already sitting
        in the slot they want, which PX4 acts on only when it CHANGES and so
        would otherwise require them to toggle away and back.
        """
        if self._offboard_active:
            await self.stop_offboard()
        tried: list[str] = []
        for mode in self._HANDOVER_MODES:
            if await self.set_flight_mode(mode):
                self._pilot_override_mode = mode
                self._snapshot.pilot_override = mode
                self._emit(force=True)
                logger.warning(f"HANDED OVER TO PILOT - aircraft is in {mode}")
                return True, mode
            tried.append(f"{mode} ({self.last_action_error or 'refused'})")
        # Every stick mode refused. Say so plainly rather than reporting a
        # handover that did not happen - the operator is about to let go.
        detail = "; ".join(tried)
        logger.error(f"Handover failed - the aircraft refused every manual mode: {detail}")
        return False, detail

    async def resume_from_pilot(self) -> bool:
        """Take control back, deliberately. Clears the latch only - it does not
        re-enter Offboard, because Offboard is entered by arming a tracking
        mode and that is a separate decision the operator makes on purpose."""
        if self._pilot_override_mode is None:
            return True
        self._clear_pilot_override()
        self._emit(force=True)
        return True

    #: The parameters that decide whether the transmitter can take the
    #: aircraft back, with what each value means for that one question.
    #: Read, never written: these belong to whoever set the airframe up, and a
    #: ground station that quietly rewrites RC behaviour mid-campaign is a
    #: worse problem than the one it solves.
    _RC_TAKEOVER_PARAMS = ("COM_RC_IN_MODE", "COM_RC_OVERRIDE",
                           "COM_RC_STICK_OV", "COM_RCL_EXCEPT", "RC_MAP_FLTMODE")

    async def rc_takeover_readiness(self) -> dict:
        """Can the pilot actually take this aircraft back? Answered before
        takeoff, from the aircraft's own parameters, instead of discovered at
        the moment it matters.

        Returns {"ok": bool, "findings": [{param, value, verdict, detail}],
                 "unreadable": [str]}.
        """
        params = await self.get_all_params()
        if not params:
            return {"ok": False, "findings": [],
                    "unreadable": list(self._RC_TAKEOVER_PARAMS),
                    "error": "Could not read parameters from the flight controller"}
        findings: list[dict] = []
        unreadable: list[str] = []
        for name in self._RC_TAKEOVER_PARAMS:
            entry = params.get(name)
            if entry is None:
                unreadable.append(name)
                continue
            verdict, detail = self._rc_param_verdict(name, entry["value"])
            findings.append({"param": name, "value": entry["value"],
                             "verdict": verdict, "detail": detail})
        ok = all(f["verdict"] == "ok" for f in findings) and not unreadable
        return {"ok": ok, "findings": findings, "unreadable": unreadable}

    @staticmethod
    def _rc_param_verdict(name: str, value) -> tuple[str, str]:
        """One parameter, judged against one question: can the pilot take over?

        Deliberately narrow. These parameters mean other things too, and this
        is not a general configuration audit - it is the answer to whether the
        transmitter is live, which is the question being asked.
        """
        v = int(value) if isinstance(value, (int, float)) and float(value).is_integer() else value
        if name == "COM_RC_IN_MODE":
            if v == 1:
                return "blocked", ("Joystick only - PX4 ignores the transmitter "
                                   "entirely, including its mode switch")
            if v == 4:
                return "blocked", "Stick input disabled - no stick or switch reaches PX4"
            if v == 3:
                return "warn", ("'RC and Joystick, keep first' - whichever manual "
                                "source PX4 hears FIRST owns the aircraft for the "
                                "rest of the session. If this ground station's "
                                "virtual joystick sends before the transmitter is "
                                "on, the transmitter is locked out until reboot")
            return "ok", "The transmitter reaches PX4"
        if name == "COM_RC_OVERRIDE":
            bits = int(v) if isinstance(v, int) else 0
            if not bits & 2:
                return "warn", ("Stick override is NOT enabled for Offboard (bit 1 "
                                "clear) - moving the sticks while the app is flying "
                                "does nothing. The mode switch still works; set 3 "
                                "if you want the sticks alone to take the aircraft")
            if not bits & 1:
                return "warn", ("Stick override is not enabled for auto modes "
                                "(bit 0 clear) - sticks do nothing in HOLD/RTL, "
                                "which is where the aircraft sits after takeoff")
            return "ok", "Sticks take the aircraft in both auto and Offboard"
        if name == "COM_RC_STICK_OV":
            try:
                pct = float(v)
            except (TypeError, ValueError):
                return "warn", "Unreadable threshold"
            if pct >= 50:
                return "warn", (f"{pct:g}% of full deflection needed to trigger "
                                f"override - a large, deliberate movement")
            if pct <= 5:
                return "warn", (f"{pct:g}% - low enough that stick noise or trim "
                                f"could take the aircraft off the app unasked")
            return "ok", f"{pct:g}% stick movement triggers override"
        if name == "COM_RCL_EXCEPT":
            bits = int(v) if isinstance(v, int) else 0
            if bits & 4:
                return "ok", "RC loss is not a failsafe while in Offboard"
            return "ok", ("RC loss triggers the failsafe in Offboard - correct "
                          "for a manned-recovery setup, and worth knowing if the "
                          "transmitter is ever off during an AI flight")
        if name == "RC_MAP_FLTMODE":
            channel = int(v) if isinstance(v, (int, float)) else 0
            if channel == 0:
                return "warn", ("No channel is mapped to the flight-mode switch - "
                                "the switch on the transmitter changes nothing. "
                                "Map it, and set COM_FLTMODE1..6")
            return "ok", f"Flight-mode switch is on RC channel {channel}"
        return "ok", ""

    @_claims_mode_change
    async def start_offboard(self) -> bool:
        """
        Starts Offboard mode.
        Must send at least one setpoint before calling this.
        """
        if self._pilot_override_mode is not None:
            # REFUSING HERE IS THE WHOLE POINT OF THE LATCH. The pilot took the
            # aircraft; every follow control in the UI is still on screen and
            # still tappable, and one tap must not put an autonomous chase back
            # on an aircraft somebody is hand-flying out of trouble.
            logger.warning(
                f"Offboard refused - the pilot has the aircraft "
                f"(took it in {self._pilot_override_mode})"
            )
            self.last_action_error = (
                f"The pilot has the aircraft - it was taken over in "
                f"{self._pilot_override_mode}. Take control back before flying it "
                f"from here."
            )
            return False
        try:
            # Send neutral setpoint first - required by PX4
            await self._drone.offboard.set_velocity_body(
                VelocityBodyYawspeed(0.0, 0.0, 0.0, 0.0)
            )
            await self._drone.offboard.start()
            self._offboard_active = True
            self._snapshot.offboard_active = True
            # Lock the altitude AI tracking should hold - callers (human/person
            # tracker) only ever send forward/right/yaw, never a vertical
            # component, so without this the drone has no active altitude
            # correction in Offboard mode and can sag over time.
            self._offboard_hold_alt = self._snapshot.position.relative_altitude_m
            logger.info(f"✅ Offboard mode started (holding altitude {self._offboard_hold_alt}m)")
            return True
        except Exception as e:
            logger.error(f"Offboard start failed: {e}")
            return False

    @_claims_mode_change
    async def stop_offboard(self) -> bool:
        """Stops Offboard mode and returns to HOLD."""
        try:
            # Send zero velocity before stopping
            await self._drone.offboard.set_velocity_body(
                VelocityBodyYawspeed(0.0, 0.0, 0.0, 0.0)
            )
            await asyncio.sleep(0.1)
            await self._drone.offboard.stop()
            self._offboard_active = False
            self._snapshot.offboard_active = False
            self._offboard_hold_alt = None
            # Cleared so the next Offboard session starts with no command
            # history rather than inheriting this one's last timestamp.
            self._last_velocity_cmd_t = 0.0
            self._offboard_stale = False
            logger.info("Offboard stopped - returning to HOLD")
            return True
        except Exception as e:
            logger.error(f"Offboard stop failed: {e}")
            return False

    # ── Offboard velocity watchdog ────────────────────────────────────────
    #
    # Every velocity setpoint reaching PX4 comes from a vision analysis result
    # (stream_track.recv -> send_velocity_command). So if the vision loop stops
    # producing results - the video source drops, the model hangs, the analyzer
    # thread dies, the session's WebRTC track ends - the last velocity that was
    # sent is simply the last one PX4 ever hears, and the aircraft keeps flying
    # it. Nothing in the vision layer can fix that, because the thing that has
    # failed IS the vision layer.
    #
    # This is the only stop that does not depend on the tracker still working.
    # It commands zero, not nothing: continuing to stream a zero setpoint holds
    # the aircraft in Offboard and under our control, whereas going silent hands
    # it to PX4's offboard-loss failsafe (COM_OBL_ACT, LAND on many airframes).
    _OFFBOARD_STALE_AFTER_S = 0.5
    _OFFBOARD_WATCHDOG_PERIOD_S = 0.2

    async def _offboard_watchdog(self):
        """Zeroes the velocity setpoint if the commanding loop goes quiet."""
        while True:
            try:
                await asyncio.sleep(self._OFFBOARD_WATCHDOG_PERIOD_S)
                if not (self._offboard_active and self._connected):
                    continue
                last = self._last_velocity_cmd_t
                if last <= 0.0:
                    continue
                idle = time.monotonic() - last
                if idle < self._OFFBOARD_STALE_AFTER_S:
                    continue
                if not self._offboard_stale:
                    self._offboard_stale = True
                    logger.warning(
                        f"No velocity setpoint for {idle:.1f}s while Offboard is "
                        f"active - holding the aircraft at zero velocity"
                    )
                # Re-sent every period, not once: PX4 needs the stream to
                # continue, and a single zero would itself become a gap.
                await self._send_velocity_body(0.0, 0.0, 0.0, 0.0)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Offboard watchdog: {e}")

    # Altitude-hold gain for the offboard vertical correction below -
    # tuned conservatively since it's fighting tracking-loop noise, not a setpoint.
    _ALT_HOLD_KP = 0.6
    _ALT_HOLD_MAX_MS = 1.0

    # ── Avoidance hooks ───────────────────────────────────────────────────
    def add_pose_listener(self, fn: Callable) -> None:
        if fn not in self._pose_listeners:
            self._pose_listeners.append(fn)

    def remove_pose_listener(self, fn: Callable) -> None:
        if fn in self._pose_listeners:
            self._pose_listeners.remove(fn)

    def _notify_pose(self) -> None:
        for fn in list(self._pose_listeners):
            try:
                fn(self._snapshot)
            except Exception as e:
                logger.debug(f"pose listener failed: {e}")

    async def boost_pose_rates(self, on: bool) -> None:
        """Avoidance needs pose at 10 Hz+ to place what the camera saw at the
        moment it saw it; the fleet profile runs position at 1 Hz and
        attitude at 2 Hz. Raised only while avoidance is enabled for this
        aircraft, and gentler on a radio link (half-duplex: downlink rate is
        taken from the command budget)."""
        if on == self._pose_rates_boosted or not self._drone:
            return
        self._pose_rates_boosted = on
        if not on:
            await self._set_rates()
            return
        radio = (self._link_kind == "radio" or self._address.startswith("serial://"))
        pos_hz, att_hz = (5.0, 10.0) if radio else (10.0, 20.0)
        for name, setter, hz in (("position", self._drone.telemetry.set_rate_position, pos_hz),
                                 ("attitude", self._drone.telemetry.set_rate_attitude_euler, att_hz)):
            try:
                await asyncio.wait_for(setter(hz), timeout=2.0)
            except Exception as e:
                logger.warning(f"Avoidance pose rate {name} {hz:g} Hz not applied: {e}")
        logger.info(f"Avoidance pose rates: position {pos_hz:g} Hz, attitude {att_hz:g} Hz"
                    + (" (radio)" if radio else ""))

    async def send_velocity_ned(self, north_m_s: float, east_m_s: float,
                                down_m_s: float, yaw_deg: float) -> None:
        """World-frame velocity + absolute heading setpoint (Offboard) - the
        avoidance local planner's command. Same pilot latch and watchdog
        bookkeeping as send_velocity_command."""
        if not self._connected or self._pilot_override_mode is not None:
            return
        self._last_velocity_cmd_t = time.monotonic()
        if self._offboard_stale:
            self._offboard_stale = False
        try:
            await self._drone.offboard.set_velocity_ned(
                VelocityNedYaw(float(north_m_s), float(east_m_s), float(down_m_s), float(yaw_deg)))
        except Exception as e:
            logger.warning(f"NED velocity command failed: {e}")

    def release_offboard_state(self) -> None:
        """Forget our Offboard session after leaving it by a mode change of our
        own (HOLD, MISSION, RTL) rather than stop_offboard()."""
        self._offboard_active = False
        self._snapshot.offboard_active = False
        self._offboard_hold_alt = None
        self._last_velocity_cmd_t = 0.0
        self._offboard_stale = False

    @_claims_mode_change
    async def resume_mission_from_offboard(self, item_index: int | None) -> bool:
        """Hand the aircraft back to its mission after an avoidance manoeuvre:
        point the mission at the waypoint it was flying to (not waypoint 0)
        and start it."""
        if self._pilot_override_mode is not None:
            return False
        try:
            if item_index is not None and item_index >= 0:
                await asyncio.wait_for(
                    self._drone.mission.set_current_mission_item(int(item_index)), timeout=3.0)
            self.release_offboard_state()
            await self._drone.mission.start_mission()
            ok = await self._wait_for_mission_mode(timeout=2.0)
            if ok:
                logger.info(f"Avoidance: mission resumed at item {item_index}")
            return bool(ok)
        except Exception as e:
            logger.error(f"Resume mission failed: {e}")
            return False

    async def send_velocity_command(
        self,
        forward_m_s: float = 0.0,
        right_m_s:   float = 0.0,
        down_m_s:    float = 0.0,
        yaw_deg_s:   float = 0.0,
    ):
        """
        Send velocity command in body frame via Offboard mode.
        forward_m_s: positive = forward
        right_m_s:   positive = right
        down_m_s:    positive = down (negative = up)
        yaw_deg_s:   positive = clockwise yaw

        If a hold altitude is set (see start_offboard), a P correction is
        added on top of the caller's down_m_s so AI tracking modes - which
        never command a vertical component themselves - actively maintain
        altitude instead of relying on it staying put by coincidence.
        """
        if not self._connected:
            return
        if self._pilot_override_mode is not None:
            # BELT AND BRACES. The trackers are stopped by the override
            # callback, but a vision result computed just before the takeover
            # can still be in flight, and the whole point of the latch is that
            # nothing this app does reaches the aircraft while a human is
            # flying it out of trouble.
            return
        # Before the send, not after: a send that raises still means the
        # commanding loop is alive, and the watchdog is there to catch a loop
        # that has gone silent, not one whose sends are failing.
        self._last_velocity_cmd_t = time.monotonic()
        if self._offboard_stale:
            self._offboard_stale = False
            logger.info("Velocity setpoints resumed")
        effective_down_m_s = float(down_m_s)
        if self._offboard_hold_alt is not None:
            if down_m_s != 0.0:
                # Caller is explicitly controlling altitude (nudge button or Auto PD).
                # Track the hold target to current altitude so that when the command
                # ends (velocity → 0) the drone holds the NEW height instead of
                # snapping back to wherever it was when offboard started.
                self._offboard_hold_alt = self._snapshot.position.relative_altitude_m
            else:
                # Fixed mode, no explicit altitude command - apply P-hold correction
                # to keep the drone at the altitude it was at when tracking started.
                alt_error_m = self._snapshot.position.relative_altitude_m - self._offboard_hold_alt
                correction = max(-self._ALT_HOLD_MAX_MS, min(self._ALT_HOLD_MAX_MS, self._ALT_HOLD_KP * alt_error_m))
                effective_down_m_s += correction
        await self._send_velocity_body(
            forward_m_s, right_m_s, effective_down_m_s, yaw_deg_s
        )

    async def _send_velocity_body(self, forward, right, down, yaw):
        """The raw MAVSDK send, with no altitude-hold correction and no
        watchdog bookkeeping - so the watchdog can use it without its own zero
        setpoints looking like a live commanding loop."""
        try:
            await self._drone.offboard.set_velocity_body(
                VelocityBodyYawspeed(
                    float(forward), float(right), float(down), float(yaw)
                )
            )
        except Exception as e:
            logger.warning(f"Velocity command failed: {e}")
            
    #: PX4 custom-mode numbers, from commander_state.h / px4_custom_mode.h.
    #: (main, sub) - sub is 0 for everything outside AUTO.
    _PX4_MAIN = {"MANUAL": 1, "ALTITUDE": 2, "POSITION": 3, "AUTO": 4,
                 "ACRO": 5, "OFFBOARD": 6, "STABILIZED": 7}
    _PX4_AUTO_SUB = {"READY": 1, "TAKEOFF": 2, "HOLD": 3, "MISSION": 4,
                     "RETURN": 5, "LAND": 6, "FOLLOW_TARGET": 8}
    _MAV_CMD_DO_SET_MODE = 176
    _MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1

    #: What telemetry.flight_mode() reports once each mode is actually running.
    #: Used to CONFIRM the switch rather than assume it, because DO_SET_MODE is
    #: fire-and-forget and PX4 silently refuses modes whose conditions are not
    #: met (POSITION without a position estimate, MISSION with no mission).
    _MODE_REPORTS_AS = {
        "HOLD": {"HOLD"}, "POSITION": {"POSCTL"}, "ALTITUDE": {"ALTCTL"},
        "STABILIZED": {"STABILIZED"}, "MISSION": {"MISSION"},
        "RETURN": {"RETURN_TO_LAUNCH"}, "LAND": {"LAND"},
        "OFFBOARD": {"OFFBOARD"}, "MANUAL": {"MANUAL"}, "ACRO": {"ACRO"},
        "TAKEOFF": {"TAKEOFF"},
    }

    async def set_speed(self, speed_m_s: float) -> bool:
        """Change the aircraft's cruise speed in flight (MAV_CMD_DO_CHANGE_SPEED).
        Used by the avoidance speed governor: slower in clutter, so a camera
        that only judges ~25 m has time to be acted on."""
        if not self._drone:
            return False
        try:
            await asyncio.wait_for(self._drone.action.set_current_speed(float(speed_m_s)), timeout=3.0)
            return True
        except Exception as e:
            logger.debug(f"set_speed({speed_m_s}) failed: {e}")
            return False

    @_claims_mode_change
    async def set_flight_mode(self, mode: str) -> bool:
        """Switch flight mode, for real, and confirm the aircraft agreed.

        THIS USED TO OFFER SEVEN MODES AND IMPLEMENT FOUR. STABILIZED, MISSION
        and OFFBOARD fell through to an "Unknown flight mode" warning and
        returned False - the dropdown listed them, selecting them did nothing,
        and nothing said why.

        POSITION WAS WORSE, because it silently did something else. It was
        aliased to HOLD on the reasoning that PX4's POSCTL is a manual-stick
        mode and HOLD gives the same hover with no RC needed. That reasoning is
        not wrong, but substituting one mode for another behind the operator's
        back is: the bar then reported HOLD, and the only way to discover the
        substitution was to notice the mode you did not ask for. If POSITION is
        the wrong choice for a rig, the operator has to be the one who decides
        that, and they cannot decide what they are not told.

        So every offered mode is now sent properly. MAVSDK's action plugin
        covers four of them and is kept for those - it is well proven and
        returns a real ACK. The rest have no plugin equivalent and go out as
        MAV_CMD_DO_SET_MODE with PX4's custom mode numbers, which is exactly
        what QGroundControl sends.

        Either way the result is CONFIRMED against telemetry before being
        reported, because DO_SET_MODE is fire-and-forget and PX4 refuses modes
        whose preconditions are not met without saying so.
        """
        mode = mode.upper()
        if mode not in self._MODE_REPORTS_AS:
            logger.warning(f"Unknown flight mode: {mode}")
            self.last_action_error = f"{mode} is not a mode this aircraft offers"
            return False

        import time as _time
        sent = _time.monotonic()
        self.last_action_error = None
        try:
            # Proven plugin paths first - these ACK, so a refusal is reported
            # by MAVSDK rather than having to be inferred from telemetry.
            if mode == "HOLD":
                await self._drone.action.hold()
            elif mode == "RETURN":
                await self._drone.action.return_to_launch()
            elif mode == "LAND":
                await self._drone.action.land()
            elif mode == "TAKEOFF":
                await self._drone.action.takeoff()
            elif mode == "MISSION":
                await self._drone.mission.start_mission()
            elif mode == "OFFBOARD":
                # Offboard cannot be entered by asking. PX4 requires setpoints
                # to ALREADY be streaming or it rejects the switch, and this
                # manager starts them itself when a tracking mode arms. Saying
                # so is more use than a refusal with no explanation.
                self.last_action_error = (
                    "Offboard is entered automatically when an AI tracking mode "
                    "starts flying the drone - it cannot be selected by hand, "
                    "because PX4 rejects it unless setpoints are already streaming"
                )
                logger.warning("Offboard requested from the mode menu - refused")
                return False
            else:
                if not await self._send_px4_mode(mode):
                    return False
        except ActionError as e:
            self.last_action_error = await self._failure_reason(
                e, sent, f"the drone refused to switch to {mode}"
            )
            logger.error(f"Set mode {mode} failed: {e} | {self.last_action_error}")
            return False

        if await self._mode_confirmed(mode):
            logger.info(f"✅ Flight mode {mode}")
            return True
        actual = self._snapshot.flight_mode.mode
        self.last_action_error = await self._fc_reason(
            sent,
            f"the drone stayed in {actual or 'its previous mode'} instead of "
            f"switching to {mode} - PX4 refuses a mode whose conditions are not "
            f"met (no position estimate, no mission loaded, not armed)",
        )
        logger.warning(f"Mode {mode} not confirmed - still {actual}")
        return False

    async def _send_px4_mode(self, mode: str) -> bool:
        """MAV_CMD_DO_SET_MODE with PX4's custom mode numbers - the same
        command QGroundControl sends, for the modes MAVSDK has no plugin for."""
        if mode in self._PX4_AUTO_SUB:
            main, sub = self._PX4_MAIN["AUTO"], self._PX4_AUTO_SUB[mode]
        elif mode in self._PX4_MAIN:
            main, sub = self._PX4_MAIN[mode], 0
        else:
            self.last_action_error = f"{mode} has no PX4 mode number"
            return False
        try:
            from mavsdk.mavlink_direct import MavlinkMessage
            fields = json.dumps({
                "target_system": 1, "target_component": 1,
                "command": self._MAV_CMD_DO_SET_MODE, "confirmation": 0,
                "param1": float(self._MAV_MODE_FLAG_CUSTOM_MODE_ENABLED),
                "param2": float(main), "param3": float(sub),
                "param4": 0.0, "param5": 0.0, "param6": 0.0, "param7": 0.0,
            })
            await asyncio.wait_for(
                self._drone.mavlink_direct.send_message(
                    MavlinkMessage("COMMAND_LONG", 0, 0, 1, 1, fields)
                ),
                timeout=5.0,
            )
            return True
        except Exception as e:
            self.last_action_error = (
                f"could not send the {mode} command to the drone ({e})"
            )
            logger.error(f"DO_SET_MODE {mode} failed: {e}")
            return False

    #: How long to wait for the aircraft to report the new mode. A mode switch
    #: is near-instant on the vehicle; this is the radio round trip plus one
    #: heartbeat, which is where the whole budget goes.
    _MODE_CONFIRM_S = 4.0

    async def _mode_confirmed(self, mode: str) -> bool:
        """Wait for telemetry to report the mode we asked for.

        Mode is decoded from HEARTBEAT at 1 Hz, so this cannot be quick - but
        assuming success is how a silently refused mode came to look like a
        working one.
        """
        expected = self._MODE_REPORTS_AS.get(mode, {mode})
        deadline = asyncio.get_event_loop().time() + self._MODE_CONFIRM_S
        while asyncio.get_event_loop().time() < deadline:
            if self._snapshot.flight_mode.mode in expected:
                return True
            await asyncio.sleep(0.2)
        return self._snapshot.flight_mode.mode in expected

    # MAVLink command codes used by mission_raw (terrain follow path)
    _MAV_CMD = {
        'takeoff':  22,   # MAV_CMD_NAV_TAKEOFF
        'land':     21,   # MAV_CMD_NAV_LAND
        'loiter':   17,   # MAV_CMD_NAV_LOITER_UNLIM
        'rtl':      20,   # MAV_CMD_NAV_RETURN_TO_LAUNCH
        'waypoint': 16,   # MAV_CMD_NAV_WAYPOINT
    }

    async def upload_mission(self, waypoints: list, terrain_follow: bool = False) -> tuple[bool, str]:
        """
        Upload a mission to the drone via MAVSDK.

        Returns (success, error_message). On success error_message is empty.

        - terrain_follow=False: uses mission.MissionItem (frame=3, altitude relative to home).
        - terrain_follow=True:  uses mission_raw.MissionItem (frame=10,
          MAV_FRAME_GLOBAL_TERRAIN_ALT).  Requires TERRAIN_ENABLE=1 on the drone.

        Telemetry tasks are intentionally left running during upload.
        Cancelling gRPC streaming tasks mid-flight stalls mavsdk_server's internal
        dispatcher, which delays MISSION_ACK - causing the upload to time out.
        With our already-lowered telemetry rates (4-10 Hz) the callback queue
        stays clear and the MISSION_ACK gets through immediately.
        """
        try:
            logger.info(
                f"Uploading mission: {len(waypoints)} waypoints, "
                f"terrain_follow={terrain_follow}"
            )
            if terrain_follow:
                await self._upload_terrain_mission(waypoints)
            else:
                await self._upload_standard_mission(waypoints)

            await self._align_takeoff_altitude_to_mission(waypoints)
            logger.info(f"✅ Mission uploaded: {len(waypoints)} waypoints")
            self._snapshot.mission_finished = False
            return True, ""

        except asyncio.TimeoutError:
            msg = "Upload timed out - check MAVLink link quality and drone connection"
            logger.error(f"❌ {msg}")
            return False, msg
        except Exception as e:
            msg = str(e)
            logger.error(f"❌ Mission upload failed: {e}", exc_info=True)
            return False, msg

    async def _align_takeoff_altitude_to_mission(self, waypoints: list) -> None:
        """
        Make PX4's auto-takeoff climb to the mission's own first altitude.

        THE TRAP THIS CLOSES, and it is a trap this application built itself.
        When a mission is started from the ground, PX4 does not fly straight to
        waypoint 1 - it inserts a takeoff to MIS_TAKEOFF_ALT first. That
        parameter is persistent on the vehicle, and set_takeoff_altitude()
        WRITES IT. So the last manual takeoff silently sets the height every
        later mission begins at:

            takeoff to 10 m in the morning   -> MIS_TAKEOFF_ALT = 10
            upload a 5 m survey that afternoon
            start it from the ground         -> the drone climbs to 10 m first

        which reads, entirely reasonably, as "I asked for a 5 m mission and it
        went to 10". Nothing in the mission is wrong; the vehicle is obeying a
        parameter left behind by an unrelated action hours earlier.

        Aligning it at upload makes the mission self-describing: the height it
        starts at is the height it says.
        """
        alt = None
        for wp in waypoints:
            # An explicit takeoff item states the intent directly; otherwise
            # the first waypoint carrying an altitude is what the mission
            # actually begins at.
            if wp.get('type') == 'takeoff' and wp.get('altitude'):
                alt = float(wp['altitude'])
                break
            if alt is None and wp.get('altitude'):
                alt = float(wp['altitude'])
        if alt is None or alt <= 0:
            return
        if await self._set_takeoff_altitude_verified(alt):
            logger.info(f"Mission auto-takeoff altitude aligned to {alt:g} m")
        else:
            logger.warning(
                f"Could not align the auto-takeoff altitude to {alt:g} m - if "
                f"this mission is started from the ground the drone will climb "
                f"to the vehicle's own MIS_TAKEOFF_ALT first"
            )

    async def _upload_standard_mission(self, waypoints: list) -> None:
        """Upload using mission.MissionItem (altitude relative to home, frame=3)."""
        from mavsdk.mission import MissionItem, MissionPlan

        _vehicle_action_map = {
            'takeoff': MissionItem.VehicleAction.TAKEOFF,
            'land':    MissionItem.VehicleAction.LAND,
        }

        items = []
        for wp in waypoints:
            cmd = wp.get('type', 'waypoint')
            yaw_val = wp.get('yaw')
            speed = float(wp.get('speed') or 5.0)  # guard against 0 / None
            turn_radius = float(wp.get('turn_radius') or 0)
            # acceptance_radius_m tells PX4 when to trigger the turn arc;
            # NaN means "use PX4 default (~1 m, stop-and-go)".
            acceptance_radius = turn_radius if turn_radius > 0 else float('nan')
            # fly_through=True + acceptance_radius > 0 → PX4 carves a smooth
            # arc at the corner using its jerk-limited trajectory generator.
            fly_through = cmd not in ('takeoff', 'land', 'loiter')
            items.append(MissionItem(
                latitude_deg=float(wp['lat']),
                longitude_deg=float(wp['lng']),
                relative_altitude_m=float(wp['altitude']),
                speed_m_s=max(0.5, speed),
                is_fly_through=fly_through,
                gimbal_pitch_deg=float('nan'),
                gimbal_yaw_deg=float('nan'),
                camera_action=MissionItem.CameraAction.NONE,
                loiter_time_s=float(wp.get('hold_time') or 0),
                camera_photo_interval_s=float('nan'),
                acceptance_radius_m=acceptance_radius,
                yaw_deg=float(yaw_val) if yaw_val is not None else float('nan'),
                camera_photo_distance_m=float('nan'),
                vehicle_action=_vehicle_action_map.get(cmd, MissionItem.VehicleAction.NONE),
            ))

        # NOTE: set_return_to_launch_after_mission is intentionally called AFTER
        # upload, not before. Calling it before the upload with asyncio.wait_for
        # cancels the Python coroutine on timeout but leaves the gRPC request
        # pending inside mavsdk_server. The subsequent UploadMission RPC then
        # queues behind that unresolved ACK and hangs until the 20 s timeout fires.
        # Calling it after guarantees the mission is safely uploaded first.
        logger.info(f"Uploading {len(items)} standard mission items...")
        await asyncio.wait_for(
            self._drone.mission.upload_mission(MissionPlan(items)),
            timeout=30.0,
        )

        # Best-effort: set RTL-after-mission. Any failure here is non-fatal -
        # the mission is already on the drone, we just won't auto-RTL at the end.
        try:
            await asyncio.wait_for(
                self._drone.mission.set_return_to_launch_after_mission(True),
                timeout=5.0,
            )
        except Exception as e:
            logger.warning(f"set_return_to_launch_after_mission skipped: {e}")

    async def _upload_terrain_mission(self, waypoints: list) -> None:
        """
        Upload using mission_raw.MissionItem with frame=10
        (MAV_FRAME_GLOBAL_TERRAIN_ALT) for terrain following.
        Requires PX4 parameter TERRAIN_ENABLE=1.
        x/y are latitude/longitude in 1e7 integer degrees (MAVLink MISSION_ITEM_INT).
        """
        from mavsdk.mission_raw import MissionItem as RawMissionItem

        items = []
        for i, wp in enumerate(waypoints):
            cmd = wp.get('type', 'waypoint')
            mavlink_cmd = self._MAV_CMD.get(cmd, 16)
            yaw_val = wp.get('yaw')
            items.append(RawMissionItem(
                seq=i,
                frame=10,       # MAV_FRAME_GLOBAL_TERRAIN_ALT
                command=mavlink_cmd,
                current=1 if i == 0 else 0,
                autocontinue=1,
                param1=float(wp.get('hold_time', 0) or 0),
                param2=0.0,     # acceptance radius (0 = default)
                param3=0.0,     # pass-through radius
                param4=float(yaw_val) if yaw_val is not None else float('nan'),
                x=int(float(wp['lat']) * 1e7),
                y=int(float(wp['lng']) * 1e7),
                z=float(wp['altitude']),
                mission_type=0,
            ))

        logger.info(f"Uploading {len(items)} terrain-follow mission items (frame=10)...")
        try:
            await asyncio.wait_for(
                self._drone.mission_raw.upload_mission(items),
                timeout=20.0,
            )
        except Exception as e:
            if 'UNSUPPORTED' in str(e).upper():
                # PX4 SITL (and some older firmware) reject mission_raw uploads.
                # Fall back to the high-level mission API which always works.
                logger.warning(
                    f"mission_raw.upload_mission UNSUPPORTED, "
                    f"falling back to standard mission API: {e}"
                )
                await self._upload_standard_mission(waypoints)
            else:
                raise

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def address(self) -> str:
        return self._address

    async def get_hardware_uid(self) -> Optional[str]:
        """
        The flight controller's factory-burned hardware UID (from MAVLink
        AUTOPILOT_VERSION via the MAVSDK Info plugin). Stable across reboots
        and reconnects - this is the drone's persistent identity.

        Info arrives shortly after the first heartbeat; retry briefly since
        we're called right after connect. Slow serial links get more slack.
        """
        if not self._drone:
            return None
        attempts = 6 if self._address.startswith("serial://") else 3
        for i in range(attempts):
            try:
                ident = await asyncio.wait_for(
                    self._drone.info.get_identification(), timeout=3.0
                )
                # PX4 pads the UID with a trailing NUL byte - Postgres (and
                # any sane consumer) rejects NULs, so keep printable chars only.
                uid = "".join(c for c in (ident.hardware_uid or "") if c.isprintable()).strip()
                if uid.strip("0"):
                    return uid
                # All-zero UID (some SITL builds) - fall back to legacy uid
                if ident.legacy_uid:
                    return f"legacy-{ident.legacy_uid:x}"
                return None
            except Exception:
                await asyncio.sleep(1.0 + i * 0.5)
        logger.warning("Could not read hardware UID - drone will be anonymous this session")
        return None

    @property
    def snapshot(self) -> TelemetrySnapshot:
        return self._snapshot

    # ------------------------------------------------------------------ #
    # Sensor calibration                                                   #
    # ------------------------------------------------------------------ #
    #
    # The plugin drives it and delivers the verdict; PX4's own STATUSTEXT
    # drives the picture. telemetry/calibration.py explains the split - the
    # short version is that a percentage does not tell an operator which way to
    # turn the aircraft, and the side-by-side state that does is only in the
    # raw lines.

    def set_calibration_listener(self, cb: Optional[Callable[[dict], None]]) -> None:
        self._on_calibration = cb

    @property
    def calibrating(self) -> Optional[str]:
        """The sensor being calibrated, or None."""
        return self._calibration.state.sensor if self._calibration else None

    def _feed_calibration(self, text: str) -> None:
        if self._calibration is None:
            return
        try:
            if self._calibration.feed(text):
                self._emit_calibration()
        except Exception as e:
            logger.debug(f"Calibration line ignored: {e}")

    def _emit_calibration(self) -> None:
        if self._calibration is None or self._on_calibration is None:
            return
        try:
            self._on_calibration(self._calibration.state.to_dict())
        except Exception as e:
            logger.debug(f"Calibration listener raised: {e}")

    def calibration_refusal(self, sensor: str) -> Optional[str]:
        """Why this calibration must not start, or None if it may.

        CHECKED HERE RATHER THAN LEFT TO PX4, even though PX4 refuses an armed
        calibration itself. Its refusal arrives as CalibrationResult.FAILED_ARMED
        several seconds later, by which time the operator has a spinning
        control and a vehicle they believe is calibrating. Saying no
        immediately, in a sentence, is the whole difference.
        """
        if sensor not in SENSORS:
            return f"{sensor} is not a sensor this aircraft can calibrate from here"
        if not self._connected:
            return "No drone connected"
        # RUNNING, not merely present. The session OUTLIVES its calibration on
        # purpose - the operator has to be able to read the verdict - so
        # testing for existence refused every start after the first. Cancel one
        # and the next attempt came back "already running, cancel it first",
        # which is the app telling you to do the thing you just did.
        if self._calibration is not None and self._calibration.state.phase in ("starting", "running"):
            return (
                f"A {SENSORS[self._calibration.state.sensor]['label']} calibration "
                f"is already running - cancel it first"
            )
        if self._snapshot.flight_mode.is_armed:
            return "Disarm before calibrating - the autopilot refuses to calibrate an armed vehicle"
        if self._snapshot.flight_mode.is_in_air:
            return "The aircraft is airborne"
        if self._offboard_active:
            return "Stop the tracking mode that is flying this aircraft first"
        if sensor == "level":
            # PX4 refuses a level calibration that starts off-level, and says
            # so as a FAILURE a long way down the line. The attitude is already
            # on the snapshot, so the answer is available before the attempt.
            att = self._snapshot.attitude
            tilt = max(abs(att.roll_deg), abs(att.pitch_deg))
            if tilt > LEVEL_MAX_TILT_DEG:
                return (
                    f"The aircraft is sitting {tilt:.1f}° off level "
                    f"(roll {att.roll_deg:+.1f}°, pitch {att.pitch_deg:+.1f}°). "
                    f"Level Horizon sets what level MEANS, so it has to start "
                    f"within {LEVEL_MAX_TILT_DEG:g}° - put it on something "
                    f"genuinely flat first."
                )
        return None

    async def start_calibration(self, sensor: str) -> tuple[bool, str]:
        """Begin one calibration. Returns (started, reason-if-not)."""
        refusal = self.calibration_refusal(sensor)
        if refusal:
            logger.warning(f"Calibration refused ({sensor}): {refusal}")
            return False, refusal

        # A LINGERING STREAM IS WHY THE NEXT CALIBRATION FAILED.
        #
        # Cancelling stopped the routine on the aircraft and marked the session
        # cancelled, but the previous run's gRPC stream could still be open -
        # MAVSDK's calibration plugin is single-flight, so every subsequent
        # calibrate_* came straight back BUSY and presented as "started, then
        # instantly failed", for the rest of the session. Reaped here rather
        # than only in cancel_calibration, so a stream left behind by ANY route
        # (a failure mid-run, a link drop, a cancel that timed out) cannot
        # poison the next attempt.
        await self._reap_calibration_task()

        # A finished or cancelled session is simply replaced - starting is the
        # operator's way of dismissing the last verdict.
        self._calibration = CalibrationSession(sensor)
        self._emit_calibration()
        self._calibration_task = asyncio.create_task(
            self._run_calibration(sensor), name=f"cal_{sensor}"
        )
        logger.info(f"🧭 Calibration started: {SENSORS[sensor]['label']}")
        return True, ""

    async def _reap_calibration_task(self) -> None:
        """Make sure no calibration stream is still open. Bounded: a gRPC read
        that will not wake up must not be able to block a new attempt."""
        task = self._calibration_task
        self._calibration_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception:
            pass

    async def _run_calibration(self, sensor: str) -> None:
        session = self._calibration
        method = getattr(self._drone.calibration, SENSORS[sensor]["method"])
        limit = float(SENSORS[sensor].get("timeout", 120.0))
        deadline = time.monotonic() + limit
        try:
            async for progress in method():
                if time.monotonic() > deadline:
                    # SAY SO RATHER THAN SPIN. A calibration that stops
                    # producing a verdict looks identical to one still working,
                    # and the operator holding the aircraft has no way to tell.
                    raise TimeoutError(
                        f"the aircraft stopped reporting after {limit:.0f}s - "
                        f"the calibration did not finish"
                    )
                if session is not self._calibration:
                    return                      # superseded or cancelled
                changed = False
                # The plugin's own percentage is a FALLBACK. On firmwares that
                # send progress STATUSTEXTs the two agree; on ones that do not,
                # this is the only number there is, and a bar frozen at zero
                # for forty seconds is indistinguishable from a hang.
                if getattr(progress, "has_progress", False):
                    p = int(round(float(progress.progress) * 100))
                    if p > session.state.progress:
                        session.state.progress = max(0, min(100, p))
                        changed = True
                if getattr(progress, "has_status_text", False):
                    if session.feed(progress.status_text or ""):
                        changed = True
                if changed:
                    self._emit_calibration()
            session.finish(True)
            logger.info(f"✅ Calibration complete: {SENSORS[sensor]['label']}")
        except asyncio.CancelledError:
            session.state.phase = "cancelled"
            session.state.instruction = "Calibration cancelled"
            raise
        except Exception as e:
            reason = self._calibration_reason(e)
            session.finish(False, reason)
            logger.error(f"Calibration failed ({sensor}): {e!r}")
        finally:
            if session is self._calibration:
                self._emit_calibration()
                # The session is kept, not cleared: the operator has to be able
                # to READ the verdict. It is replaced when the next calibration
                # starts, and cleared explicitly by dismiss_calibration.
                self._calibration_task = None

    async def cancel_calibration(self) -> bool:
        """Stop the running calibration, both ends.

        BOTH ENDS IS THE POINT. Cancelling only our task leaves PX4 still in
        its calibration routine, refusing arming and every subsequent
        calibration, with nothing on screen to say why - the aircraft looks
        bricked. The vehicle is told first, for that reason.
        """
        if self._calibration is None:
            return False
        # THE PANEL CHANGES FIRST. Cancelling used to wait on a 5 s ACK and then
        # on a gRPC read that may not wake up at all, so the button sat there
        # doing nothing for seconds - which reads as a cancel that did not land,
        # on the one control an operator presses because something is wrong.
        # The aircraft is still told, and told first among the awaits; the
        # operator is simply no longer made to watch.
        self._calibration.state.phase = "cancelled"
        self._calibration.state.instruction = "Calibration cancelled"
        self._emit_calibration()

        try:
            await asyncio.wait_for(self._drone.calibration.cancel(), timeout=2.0)
        except Exception as e:
            logger.warning(f"Calibration cancel not acknowledged: {e}")
        await self._reap_calibration_task()
        logger.info("Calibration cancelled")
        return True

    @staticmethod
    def _calibration_reason(err: Exception) -> str:
        """The autopilot's own verdict, when it gave one.

        MAVSDK wraps the result in a CalibrationError whose str() is a Python
        repr; BUSY, FAILED_ARMED and UNSUPPORTED are completely different
        problems with completely different fixes, and flattening all three to
        "the calibration did not complete" sent the operator looking in the
        wrong place every time.
        """
        result = getattr(getattr(err, "_result", None), "result", None)
        name = getattr(result, "name", None) or str(result or "")
        explain = {
            "BUSY": "the autopilot is already running a calibration - wait a moment and try again",
            "FAILED_ARMED": "the vehicle is armed",
            "COMMAND_DENIED": "the autopilot refused the command",
            "UNSUPPORTED": "this autopilot does not offer that calibration",
            "NO_SYSTEM": "no vehicle is connected",
            "CONNECTION_ERROR": "the link dropped during the calibration",
            "TIMEOUT": "the autopilot did not answer",
            "CANCELLED": "the calibration was cancelled",
        }.get(name)
        if explain:
            return explain
        if isinstance(err, TimeoutError):
            return str(err)
        detail = str(getattr(err, "_result", None) or err).strip()
        return detail or "the calibration did not complete"

    def dismiss_calibration(self) -> None:
        """Clear a FINISHED calibration so the panel returns to its resting
        state. Refuses to discard one that is still running, which would leave
        PX4 mid-routine with nothing on screen tracking it."""
        if self._calibration is None:
            return
        if self._calibration.state.phase in ("starting", "running"):
            return
        self._calibration = None
        if self._on_calibration is not None:
            with contextlib.suppress(Exception):
                self._on_calibration({"phase": "idle", "sensor": "", "sides": {}})

    # ------------------------------------------------------------------ #
    # Parameter read / write                                               #
    # ------------------------------------------------------------------ #

    async def get_all_params(self) -> dict:
        """Download every parameter from the flight controller.
        Takes 5-30 s depending on link quality (UDP SITL ≈ 5 s, serial ≈ 20-30 s).
        Returns {name: {value, type}} with 'type' being 'int' or 'float'.
        """
        if not self._drone or not self._connected:
            return {}
        try:
            all_params = await asyncio.wait_for(
                self._drone.param.get_all_params(),
                timeout=120.0,
            )
            result: dict = {}
            for p in all_params.int_params:
                result[p.name] = {"value": p.value, "type": "int"}
            for p in all_params.float_params:
                result[p.name] = {"value": round(p.value, 6), "type": "float"}
            logger.info(f"Downloaded {len(result)} parameters from drone")
            return result
        except asyncio.TimeoutError:
            logger.error("get_all_params: timed out after 120 s")
            return {}
        except Exception as e:
            logger.error(f"get_all_params failed: {e}")
            return {}

    async def get_param(self, name: str, param_type: str = "int"):
        """Read ONE parameter from the flight controller.

        Exists because the only alternative was fetch_params - a 5-30 s
        download of every parameter on the aircraft - which is the wrong
        price for the sensors page asking "which way is the compass
        mounted". Returns the value, or None when it cannot be read.
        """
        if not self._drone or not self._connected:
            return None
        try:
            if param_type == "int":
                return await asyncio.wait_for(
                    self._drone.param.get_param_int(name), timeout=8.0
                )
            return await asyncio.wait_for(
                self._drone.param.get_param_float(name), timeout=8.0
            )
        except asyncio.TimeoutError:
            logger.error(f"get_param {name}: timed out")
            return None
        except Exception as e:
            logger.error(f"get_param {name} failed: {e}")
            return None

    async def set_param(self, name: str, value: float, param_type: str = "float") -> bool:
        """Write a single parameter to the flight controller and wait for ACK."""
        if not self._drone or not self._connected:
            return False
        try:
            if param_type == "int":
                await asyncio.wait_for(
                    self._drone.param.set_param_int(name, int(value)),
                    timeout=8.0,
                )
            else:
                await asyncio.wait_for(
                    self._drone.param.set_param_float(name, float(value)),
                    timeout=8.0,
                )
            logger.info(f"Param set: {name} = {value} ({param_type})")
            return True
        except asyncio.TimeoutError:
            logger.error(f"set_param {name}: timed out waiting for ACK")
            return False
        except Exception as e:
            logger.error(f"set_param {name}={value} failed: {e}")
            return False
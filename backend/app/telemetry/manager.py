"""
Verocore Telemetry Manager
Uses MAVSDK-Python to talk to PX4 over MAVLink.

Key concepts:
- MAVSDK connects via UDP to PX4 SITL (default port 14540)
- All telemetry subscriptions are async generators — they yield forever
- We run each subscription as a separate asyncio Task
- Commands go through a queue — this makes it thread-safe
- One TelemetryManager instance per drone session
"""
import asyncio
import logging
import math
import socket
from typing import Callable, Optional
from mavsdk import System
from mavsdk.action import ActionError
from mavsdk.offboard import (
    OffboardError,
    AttitudeRate,
    VelocityBodyYawspeed,
)
from app.telemetry.schemas import (
    TelemetrySnapshot,
    AttitudeData,
    PositionData,
    VelocityData,
    BatteryData,
    GPSData,
    FlightModeData,
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
    _FLEET_EMIT_RATE_HZ = 3   # fleet drones — lower to avoid overwhelming mavsdk_server queue

    def __init__(self, on_update: Optional[Callable[[dict], None]] = None, fleet_mode: bool = False):
        self._drone: Optional[System] = None
        self._on_update = on_update
        self._fleet_mode = fleet_mode  # when True, use minimal subscriptions and slower rates
        self._snapshot = TelemetrySnapshot()
        self._tasks: list[asyncio.Task] = []
        self._command_queue: asyncio.Queue[DroneCommand] = asyncio.Queue(maxsize=5)
        self._running = False
        self._connected = False
        self._offboard_active = False
        self._offboard_hold_alt: Optional[float] = None  # relative altitude (m) to hold during AI/offboard tracking
        self._address: str = ""
        self._grpc_port: Optional[int] = None  # unique per drone — see connect()
        self._last_emit: float = 0.0  # monotonic time of last _emit() push

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
        import subprocess, signal
        try:
            result = subprocess.run(
                ["pgrep", "-f", pattern],
                capture_output=True, text=True
            )
            pids = [int(p) for p in result.stdout.strip().split() if p]
            for pid in pids:
                try:
                    import os
                    os.kill(pid, signal.SIGTERM)
                    logger.info(f"Killed stale mavsdk_server (PID {pid})")
                except ProcessLookupError:
                    pass
            if pids:
                import time
                time.sleep(0.5)  # allow OS to release the UDP port
        except Exception as e:
            logger.debug(f"mavsdk_server cleanup skipped: {e}")

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

        # Create a fresh System() — reusing a stale one causes gRPC channel errors.
        # CRITICAL: each System must own a UNIQUE gRPC port. MAVSDK-Python defaults
        # every instance to port 50051; with multiple drones, only the first
        # mavsdk_server binds it and every later System silently connects to that
        # SAME server — so all drones mirror one vehicle and every command routes
        # to it (the "arm one drone, all show armed" bug).
        self._grpc_port = _find_free_port()
        self._drone = System(port=self._grpc_port)
        logger.info(f"mavsdk_server gRPC port {self._grpc_port} for {address}")

        logger.info(f"Connecting to drone at {address} ...")
        try:
            await self._drone.connect(system_address=address)
            logger.info("Waiting for heartbeat...")
            async for state in self._drone.core.connection_state():
                if state.is_connected:
                    self._connected = True
                    logger.info(f"✅ Drone connected at {address}")
                    return True
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
        its nominal baud rate in practice, and half-duplex) — the UDP rates below
        can saturate it and cause exactly the kind of intermittent "Socket closed"
        disconnects that don't happen in QGroundControl, which is far more
        conservative over slow links. Use a lower profile for serial.
        """
        is_serial = self._address.startswith("serial://")

        if self._fleet_mode:
            # Fleet drones: only the two streams we actually control via rate commands.
            # armed() and flight_mode() derive from HEARTBEAT (PX4 sends at 1 Hz by default,
            # no separate rate command needed). Velocity and GPS are dropped entirely.
            rates = [
                ("position", self._drone.telemetry.set_rate_position, 1.0),
                ("battery",  self._drone.telemetry.set_rate_battery,  0.2),
            ]
        else:
            rates = [
                ("position",     self._drone.telemetry.set_rate_position,       2.0 if is_serial else 4.0),
                ("attitude",     self._drone.telemetry.set_rate_attitude_euler, 4.0 if is_serial else 10.0),
                ("velocity_ned", self._drone.telemetry.set_rate_velocity_ned,   2.0 if is_serial else 4.0),
                ("battery",      self._drone.telemetry.set_rate_battery,        1.0 if is_serial else 2.0),
                ("gps_info",     self._drone.telemetry.set_rate_gps_info,       1.0 if is_serial else 2.0),
                ("home",         self._drone.telemetry.set_rate_home,           0.5 if is_serial else 1.0),
                ("in_air",       self._drone.telemetry.set_rate_in_air,         1.0 if is_serial else 2.0),
            ]
        for name, setter, hz in rates:
            try:
                await asyncio.wait_for(setter(hz), timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                pass  # best-effort; not all PX4 builds support every rate setter
        logger.info("Telemetry rates configured")

    async def start(self):
        """Starts all telemetry subscription tasks."""
        if not self._connected:
            logger.error("Cannot start — not connected")
            return

        self._running = True

        # Lower MAVLink rates first to keep mavsdk_server callback queue healthy
        await self._set_rates()

        # Each subscription runs as an independent task.
        # If one crashes, the others keep running.
        # NOTE: groundspeed is computed inside _subscribe_velocity — no separate task.
        if self._fleet_mode:
            # Fleet drones: 4 gRPC streams only.
            # - position: 1 Hz for map markers
            # - armed + flight_mode: derived from HEARTBEAT (1 Hz), no extra overhead
            # - battery: 0.2 Hz for HUD indicator
            # Velocity and GPS are omitted — they add 2 more streams per drone
            # (6 total per drone × N drones) without adding essential fleet-control value.
            # This keeps N=3 drones at 12 total streams rather than 18.
            self._tasks = [
                asyncio.create_task(self._subscribe_position(),    name="fleet_position"),
                asyncio.create_task(self._subscribe_armed(),       name="fleet_armed"),
                asyncio.create_task(self._subscribe_flight_mode(), name="fleet_mode"),
                asyncio.create_task(self._subscribe_battery(),     name="fleet_battery"),
                # Mission progress is event-driven (only fires on waypoint
                # changes) — negligible cost, and fleet surveys need per-drone
                # WP progress in the UI.
                asyncio.create_task(self._subscribe_mission_progress(), name="fleet_mission"),
                asyncio.create_task(self._command_loop(),          name="fleet_cmd"),
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
                asyncio.create_task(self._subscribe_mission_progress(),name="tel_mission"),
                asyncio.create_task(self._poll_mission_finished(),     name="tel_mission_finished"),
                asyncio.create_task(self._command_loop(),              name="cmd_loop"),
            ]

        logger.info(f"Telemetry started — {len(self._tasks)} tasks ({'fleet' if self._fleet_mode else 'primary'})")

    async def stop(self, kill_stale: bool = True):
        """Cleanly cancels all tasks and closes connection."""
        self._running = False
        self._connected = False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        # Kill OUR OWN mavsdk_server, matched by its unique gRPC port — NOT by
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
                # Compass heading is yaw remapped from -180..180 to 0..360 —
                # avoids a separate heading() gRPC streaming subscription
                # (one less stream in mavsdk_server's shared callback queue).
                self._snapshot.heading_deg = round(att.yaw_deg % 360, 1)
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
                # Compute groundspeed here — avoids a duplicate velocity_ned() subscription
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
                self._snapshot.flight_mode.mode = str(mode).replace("FlightMode.", "")
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Flight mode subscription error: {e}")

    async def _subscribe_armed(self):
        try:
            async for armed in self._drone.telemetry.armed():
                if not self._running:
                    break
                self._snapshot.flight_mode.is_armed = armed
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Armed subscription error: {e}")

    async def _subscribe_in_air(self):
        try:
            async for in_air in self._drone.telemetry.in_air():
                if not self._running:
                    break
                self._snapshot.flight_mode.is_in_air = in_air
                self._emit()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"In-air subscription error: {e}")

    async def _subscribe_wind(self):
        """
        Wind velocity estimated by PX4 EKF2 from GPS + IMU.
        No extra sensor needed — available on all PX4 multirotors.
        MAVLink: WIND_COV message. MAVSDK: telemetry.fixedwing_metrics()
        works for multirotors too (PX4 always runs EKF2 wind estimation).
        """
        try:
            async for metrics in self._drone.telemetry.fixedwing_metrics():
                if not self._running:
                    break
                # airspeed_m_s comes from EKF2 on multirotors when airspeed sensor absent
                # Use velocity NED vs groundspeed to infer wind — or use raw if available
                # MAVSDK doesn't expose WIND_COV directly; use best available
                # We approximate: wind = GPS groundspeed direction vs airspeed
                # For now store zeros — actual wind needs raw MAVLink WIND_COV
                # This subscription keeps the slot open for future raw MAVLink support
                self._snapshot.wind_north_m_s = 0.0
                self._snapshot.wind_east_m_s = 0.0
        except asyncio.CancelledError:
            pass
        except Exception:
            # Not all PX4 builds expose this — fail silently
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
        mission.is_mission_finished() is request/response, not a stream — MAVSDK
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
                pass  # transient gRPC hiccup — just retry next tick
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
            # bare NaN token, which is invalid JSON — the browser's
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
        """A finished mission won't restart via MISSION_START — PX4 leaves the
        current item parked at the end, so 'start' silently does nothing (the
        old 'must re-upload before every start' bug). Rewind to waypoint 0 so
        start always means 'fly the mission again'."""
        finished = self._snapshot.mission_finished
        if not finished and self._fleet_mode:
            # Fleet mode doesn't run the finished-poll task — ask once at
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
            logger.warning(f"Mission rewind failed: {e} — starting anyway")

    async def start_mission(self) -> bool:
        """
        Start the uploaded mission. Drone must be armed.

        PX4 occasionally needs a moment to finish digesting a just-completed
        mission upload before it will honour MISSION_START — the command can
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
            return False, "Arm timed out — check safety switch and pre-arm checks"
        except Exception as e:
            logger.error(f"Arm+start failed: {e}")
            return False, str(e)

    async def _correct_altitude_after_takeoff(self, relative_altitude_m: float):
        """Wait until the drone actually leaves the ground, then goto the
        requested altitude. Belt-and-braces for the MIS_TAKEOFF_ALT race —
        harmless when takeoff already targets the right altitude."""
        try:
            for _ in range(30):  # up to 15 s to get airborne
                await asyncio.sleep(0.5)
                if self._snapshot.position.relative_altitude_m > 1.0:
                    break
            else:
                return  # never left the ground — nothing to correct
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
            logger.warning("Goto altitude refused — no position yet")
            return False
        in_air = self._snapshot.flight_mode.is_in_air or pos.relative_altitude_m > 1.0
        try:
            if not in_air:
                if not self._snapshot.flight_mode.is_armed:
                    await asyncio.wait_for(self._drone.action.arm(), timeout=10.0)
                ok = await self.takeoff(float(relative_altitude_m))
                if ok:
                    logger.info(f"✅ Goto altitude {relative_altitude_m} m — grounded, took off instead")
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
            return True
        except asyncio.TimeoutError:
            logger.error("Goto altitude failed: arm timed out")
            return False
        except ActionError as e:
            logger.error(f"Goto altitude failed: {e}")
            return False

    async def goto_custom_rtl(self, lat: float, lng: float, relative_altitude_m: float) -> bool:
        """
        Abort whatever the drone is doing and fly to a custom RTL point.

        Real PX4 RTL (MAV_CMD_NAV_RETURN_TO_LAUNCH, the 'return' action below)
        only supports the EKF home position — there's no parameter for a custom
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

    async def goto_home(self, relative_altitude_m: Optional[float] = None) -> bool:
        """
        Fly to THIS drone's own home position (where it armed) and hover there.

        Group RTL uses this instead of goto_custom_rtl so one fleet command
        doesn't send every drone to a single shared point — each vehicle
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
                logger.error(f"RTL home failed — home position unavailable: {e}")
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

    async def restart_mission(self) -> bool:
        """
        Reset to waypoint 0 then start the mission.
        Use this for a fresh start — not for resume (which should call start_mission).
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
            return False, "Arm timed out — check safety switch and pre-arm checks"
        except Exception as e:
            logger.error(f"Arm+restart failed: {e}")
            return False, str(e)

    async def pause_mission(self) -> bool:
        """Pause mission and enter HOLD mode."""
        try:
            await self._drone.mission.pause_mission()
            logger.info("✅ Mission paused")
            return True
        except Exception as e:
            logger.error(f"Pause mission failed: {e}")
            return False

    async def takeoff(self, altitude_m: Optional[float] = None) -> bool:
        try:
            if altitude_m is not None:
                await self._drone.action.set_takeoff_altitude(float(altitude_m))
            await self._drone.action.takeoff()
            logger.info(f"✅ Takeoff commanded (altitude={altitude_m}m)")
            return True
        except ActionError as e:
            logger.error(f"Takeoff failed: {e}")
            return False

    # ------------------------------------------------------------------ #
    # Emit                                                                 #
    # ------------------------------------------------------------------ #

    def _emit(self):
        """Push latest snapshot to frontend, throttled to _EMIT_RATE_HZ (or _FLEET_EMIT_RATE_HZ)."""
        if not self._on_update:
            return
        now = asyncio.get_event_loop().time()
        rate = self._FLEET_EMIT_RATE_HZ if self._fleet_mode else self._EMIT_RATE_HZ
        if (now - self._last_emit) < (1.0 / rate):
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
        The queue has maxsize=5 — if full, old commands are dropped.
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
        try:
            await self._drone.action.arm()
            logger.info("✅ Armed")
            return True
        except ActionError as e:
            logger.error(f"Arm failed: {e}")
            return False

    async def disarm(self) -> bool:
        try:
            await self._drone.action.disarm()
            logger.info("✅ Disarmed")
            return True
        except ActionError as e:
            logger.error(f"Disarm failed: {e}")
            return False

    async def emergency_stop(self) -> bool:
        """
        Kills motors immediately regardless of state.
        Only use in genuine emergency — drone will fall.
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

    async def start_offboard(self) -> bool:
        """
        Starts Offboard mode.
        Must send at least one setpoint before calling this.
        """
        try:
            # Send neutral setpoint first — required by PX4
            await self._drone.offboard.set_velocity_body(
                VelocityBodyYawspeed(0.0, 0.0, 0.0, 0.0)
            )
            await self._drone.offboard.start()
            self._offboard_active = True
            # Lock the altitude AI tracking should hold — callers (human/person
            # tracker) only ever send forward/right/yaw, never a vertical
            # component, so without this the drone has no active altitude
            # correction in Offboard mode and can sag over time.
            self._offboard_hold_alt = self._snapshot.position.relative_altitude_m
            logger.info(f"✅ Offboard mode started (holding altitude {self._offboard_hold_alt}m)")
            return True
        except Exception as e:
            logger.error(f"Offboard start failed: {e}")
            return False

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
            self._offboard_hold_alt = None
            logger.info("Offboard stopped — returning to HOLD")
            return True
        except Exception as e:
            logger.error(f"Offboard stop failed: {e}")
            return False

    # Altitude-hold gain for the offboard vertical correction below —
    # tuned conservatively since it's fighting tracking-loop noise, not a setpoint.
    _ALT_HOLD_KP = 0.6
    _ALT_HOLD_MAX_MS = 1.0

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
        added on top of the caller's down_m_s so AI tracking modes — which
        never command a vertical component themselves — actively maintain
        altitude instead of relying on it staying put by coincidence.
        """
        if not self._connected:
            return
        effective_down_m_s = float(down_m_s)
        if self._offboard_hold_alt is not None:
            if down_m_s != 0.0:
                # Caller is explicitly controlling altitude (nudge button or Auto PD).
                # Track the hold target to current altitude so that when the command
                # ends (velocity → 0) the drone holds the NEW height instead of
                # snapping back to wherever it was when offboard started.
                self._offboard_hold_alt = self._snapshot.position.relative_altitude_m
            else:
                # Fixed mode, no explicit altitude command — apply P-hold correction
                # to keep the drone at the altitude it was at when tracking started.
                alt_error_m = self._snapshot.position.relative_altitude_m - self._offboard_hold_alt
                correction = max(-self._ALT_HOLD_MAX_MS, min(self._ALT_HOLD_MAX_MS, self._ALT_HOLD_KP * alt_error_m))
                effective_down_m_s += correction
        try:
            await self._drone.offboard.set_velocity_body(
                VelocityBodyYawspeed(
                    float(forward_m_s),
                    float(right_m_s),
                    float(effective_down_m_s),
                    float(yaw_deg_s),
                )
            )
        except Exception as e:
            logger.warning(f"Velocity command failed: {e}")
            
    async def set_flight_mode(self, mode: str) -> bool:
        """
        Supported modes: HOLD, RETURN, LAND, TAKEOFF, MISSION, OFFBOARD
        Note: STABILIZE, LOITER etc are ArduPilot names — PX4 uses different names

        POSITION is aliased to HOLD: PX4's real Position mode (POSCTL) is a manual-
        stick mode that needs continuously streamed neutral RC input to stay in,
        whereas HOLD (AUTO_LOITER) gives the same "hover in place" result with no
        RC input required — which is what the UI option is actually used for.
        """
        mode = mode.upper()
        try:
            if mode == "HOLD" or mode == "POSITION":
                await self._drone.action.hold()
            elif mode == "RETURN":
                await self._drone.action.return_to_launch()
            elif mode == "LAND":
                await self._drone.action.land()
            elif mode == "TAKEOFF":
                await self._drone.action.takeoff()
            else:
                logger.warning(f"Unknown flight mode: {mode}")
                return False
            logger.info(f"Flight mode set to {mode}")
            return True
        except ActionError as e:
            logger.error(f"Set mode failed: {e}")
            return False

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
        dispatcher, which delays MISSION_ACK — causing the upload to time out.
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

            logger.info(f"✅ Mission uploaded: {len(waypoints)} waypoints")
            self._snapshot.mission_finished = False
            return True, ""

        except asyncio.TimeoutError:
            msg = "Upload timed out — check MAVLink link quality and drone connection"
            logger.error(f"❌ {msg}")
            return False, msg
        except Exception as e:
            msg = str(e)
            logger.error(f"❌ Mission upload failed: {e}", exc_info=True)
            return False, msg

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

        # Best-effort: set RTL-after-mission. Any failure here is non-fatal —
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

    async def get_hardware_uid(self) -> Optional[str]:
        """
        The flight controller's factory-burned hardware UID (from MAVLink
        AUTOPILOT_VERSION via the MAVSDK Info plugin). Stable across reboots
        and reconnects — this is the drone's persistent identity.

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
                # PX4 pads the UID with a trailing NUL byte — Postgres (and
                # any sane consumer) rejects NULs, so keep printable chars only.
                uid = "".join(c for c in (ident.hardware_uid or "") if c.isprintable()).strip()
                if uid.strip("0"):
                    return uid
                # All-zero UID (some SITL builds) — fall back to legacy uid
                if ident.legacy_uid:
                    return f"legacy-{ident.legacy_uid:x}"
                return None
            except Exception:
                await asyncio.sleep(1.0 + i * 0.5)
        logger.warning("Could not read hardware UID — drone will be anonymous this session")
        return None

    @property
    def snapshot(self) -> TelemetrySnapshot:
        return self._snapshot

    # ------------------------------------------------------------------ #
    # Parameter read / write                                               #
    # ------------------------------------------------------------------ #

    async def get_all_params(self) -> dict:
        """Download every parameter from the flight controller.
        Takes 5–30 s depending on link quality (UDP SITL ≈ 5 s, serial ≈ 20–30 s).
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
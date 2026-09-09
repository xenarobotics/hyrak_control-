"""
The DELIVERY fleet - drones owned by the SERVER, not by a browser session.

The swarm system connects fleets per client session and tears them down
when that browser leaves; that is right for a pilot flying their own
squad, and wrong for a delivery platform whose drones must exist whether
or not anyone has a dashboard open. This service holds its own
TelemetryManagers for the station fleet (SITL today, RF air units later),
keeps live snapshots for the dispatcher and the board, and can upload and
start missions - with the same zone gate the socket upload path enforces.
"""
import asyncio
import logging

from app.registry import drones as drone_registry

logger = logging.getLogger("verocore.fleet")

_managers: dict[int, object] = {}     # instance -> TelemetryManager
_db_ids: dict[int, str] = {}          # instance -> drones.id (uuid)
_names: dict[int, str] = {}
_state: dict[int, dict] = {}          # instance -> latest snapshot dict
_lock = asyncio.Lock()

# Where each drone's CURRENT mission ends - the deconfliction monitor
# guards this point while the drone is inbound.
_land_target: dict[int, tuple[float, float]] = {}
_paused: dict[int, bool] = {}
# Uploaded missions waiting for clear air overhead before arming.
_pending_start: dict[int, bool] = {}
_pending_tries: dict[int, int] = {}
# Instances whose DB has already been checked for a pre-restart held takeoff.
# Each connected drone is queried once (when it first appears), not every
# 2 s cycle; cleared on disconnect so a re-adopt re-checks.
_holds_checked: set[int] = set()
TAKEOFF_CLEAR_RADIUS_M = 15.0

_watchdog: asyncio.Task | None = None
_monitor: asyncio.Task | None = None

# The watchdog probes instances 1..MAX_SCAN for NEW adoptions, and heals
# every instance it has ever connected (see _adopted) even above that range.
# Fleet links must survive server restarts and drone respawns without anyone
# pressing a button - a delivery platform cannot depend on "restart the
# server". The old watchdog only scanned 1..8 while connect() accepts 1..20,
# so drones 9-20 were adopted once and then never healed after a link drop.
MAX_SCAN = 8

# Every instance ever connected this session. The watchdog heals this set in
# addition to probing 1..MAX_SCAN, so a drone on instance 9-20 is reconnected
# after a stale link just like the low instances. Cleared by disconnect_all.
_adopted: set[int] = set()
WATCHDOG_INTERVAL_S = 25.0
MONITOR_INTERVAL_S = 2.0
LAND_GUARD_RADIUS_M = 60.0    # start watching this close to the landing point
PAD_CLEAR_RADIUS_M = 12.0     # another drone inside this = pad occupied
# En-route vertical separation: each drone flies its cruise legs at its own
# altitude band so crossing paths never share a level.
ALT_SEPARATION_M = 4.0


def _dist_m(lat1, lng1, lat2, lng2) -> float:
    import math
    m_lng = math.cos(math.radians(lat1))
    return 111_320 * math.hypot(lat1 - lat2, (lng1 - lng2) * m_lng)


def _port_for(i: int) -> int:
    return 14541 + i if i > 9 else 14540 + i


_last_update: dict[int, float] = {}
# A link whose telemetry stops flowing for this long is DEAD no matter what
# its manager believes - mavsdk_server can be killed out from under us
# without is_connected ever going false. 30 s, not less: a lockstep SITL
# running below ~0.3x real time stretches telemetry gaps past 12 s, and a
# too-eager threshold made the watchdog tear down HEALTHY links mid-command
# (the operator saw "start failed: UNAVAILABLE").
STALE_AFTER_S = 30.0

# Operator pressed DISCONNECT: the watchdog must respect that instead of
# silently re-adopting everything 25 s later. Any explicit connect/adopt
# re-enables.
_disabled = False

# Battery reserve: a drone must land with this much left. Breaching it
# mid-flight triggers an automatic return (the monitor commands RETURN once
# per flight and marks the order returned).
RESERVE_PCT = 20.0
_reserve_triggered: set[int] = set()

# Consecutive adopt failures per instance - after a few, the watchdog only
# retries that port every 4th cycle instead of burning a 10 s connect
# timeout (and a zombie mavsdk_server) on an empty port every 25 s.
_fail_counts: dict[int, int] = {}
_scan_cycle = 0


def _snapshot_cb(i: int):
    def cb(snap: dict) -> None:
        import time
        _state[i] = snap
        _last_update[i] = time.monotonic()
    return cb


def _is_stale(i: int) -> bool:
    import time
    return (time.monotonic() - _last_update.get(i, 0.0)) > STALE_AFTER_S


async def connect_one(i: int, manual: bool = False) -> str:
    """Connect one instance (idempotent). Returns a status string.
    manual=True (an operator's connect/adopt) lifts a DISCONNECT."""
    global _disabled
    from app.telemetry.manager import TelemetryManager
    if manual:
        _disabled = False
    async with _lock:
        if i in _managers and _managers[i].is_connected:
            return "already connected"
        address = f"udpin://0.0.0.0:{_port_for(i)}"
        manager = TelemetryManager(on_update=_snapshot_cb(i), fleet_mode=True)
        ok = await manager.connect(address, kill_stale=True)
        if not ok:
            return f"no drone on {address}"
        await manager.start()
        _managers[i] = manager
        _names[i] = f"Station Drone {i}"
        _adopted.add(i)   # watchdog heals it from now on, whatever its index
        rec = await drone_registry.upsert_seen(
            f"sitl-station-fleet-{i}", is_simulated=True)
        if rec:
            _db_ids[i] = rec["id"]
        logger.info(f"Delivery fleet drone {i} connected ({address})")
        return "connected"


async def connect(count: int) -> dict:
    """Connect instances 1..count (idempotent per instance)."""
    return {i: await connect_one(i, manual=True) for i in range(1, count + 1)}


async def disconnect_all() -> int:
    """Take the fleet offline AND keep it offline: sets the disabled flag
    the watchdog honours - without it, disconnect was silently undone at
    the next 25 s scan. Clears every per-instance map so nothing stale
    answers instance_for()/position_of() for drones that are gone."""
    global _disabled
    _disabled = True
    async with _lock:
        managers = dict(_managers)
        _managers.clear()
        _state.clear()
        _db_ids.clear()
        _names.clear()
        _last_update.clear()
        _land_target.clear()
        _paused.clear()
        _pending_start.clear()
        _reserve_triggered.clear()
        _fail_counts.clear()
        _adopted.clear()   # stop healing everything the operator just took down
        _holds_checked.clear()
    await asyncio.gather(
        *[m.stop(kill_stale=True) for m in managers.values()],
        return_exceptions=True,
    )
    logger.info(f"Delivery fleet disconnected ({len(managers)} drones) - "
                "watchdog re-adoption disabled until the next CONNECT")
    return len(managers)


def status() -> list[dict]:
    """Live view for the board / dispatcher / sessions endpoint."""
    out = []
    for i, m in sorted(_managers.items()):
        snap = _state.get(i) or {}
        pos = snap.get("position", {})
        fm = snap.get("flight_mode", {})
        lat = pos.get("latitude_deg", 0.0)
        lng = pos.get("longitude_deg", 0.0)
        live = None
        if m.is_connected and (lat or lng) and not _is_stale(i):
            live = {
                "lat": lat, "lng": lng,
                "alt": pos.get("relative_altitude_m", 0.0),
                "heading": snap.get("heading_deg", 0.0),
                "armed": bool(fm.get("is_armed")),
                "in_air": bool(fm.get("is_in_air")),
                "mode": fm.get("mode", "UNKNOWN"),
                "battery": snap.get("battery", {}).get("remaining_percent", 0.0),
            }
        out.append({
            "instance": i,
            "db_id": _db_ids.get(i),
            "name": _names.get(i, f"Station Drone {i}"),
            "connected": m.is_connected,
            "live": live,
        })
    return out


def instance_for(db_id: str) -> int | None:
    for i, d in _db_ids.items():
        if d == db_id:
            return i
    return None


def position_of(db_id: str) -> tuple[float, float] | None:
    i = instance_for(db_id)
    if i is None:
        return None
    pos = (_state.get(i) or {}).get("position", {})
    lat, lng = pos.get("latitude_deg", 0.0), pos.get("longitude_deg", 0.0)
    return (lat, lng) if (lat or lng) else None


async def fly_mission(db_id: str, waypoints: list[dict],
                      ack_orange: bool = False) -> tuple[bool, dict]:
    """Upload + arm + start a mission on a fleet drone, behind the SAME
    zone gate as the socket upload path: red blocks (permit-aware),
    orange needs an explicit ack. Returns (ok, detail)."""
    i = instance_for(db_id)
    if i is None or i not in _managers:
        return False, {"msg": "Drone is not in the server fleet"}
    manager = _managers[i]
    if not manager.is_connected:
        return False, {"msg": "Fleet drone link is down"}
    if not waypoints:
        return False, {"msg": "No waypoints provided"}

    # Per-drone altitude band on cruise legs: two drones whose paths cross
    # must never share a level. Takeoff/land points keep their planned
    # altitudes - separation on the ground is the landing slots' job.
    # Applied BEFORE the zone/permit gate so the mission we validate is the
    # mission the aircraft actually flies - a permit frozen at 0.5 m alt
    # tolerance would otherwise never have seen the banded altitudes.
    band = ((i - 1) % 4) * ALT_SEPARATION_M
    flown = [
        {**w, "altitude": float(w["altitude"]) + band}
        if w.get("type") == "waypoint" else dict(w)
        for w in waypoints
    ]

    from app.zones import engine as zone_engine
    path_check = zone_engine.check_path(
        [(float(w["lat"]), float(w["lng"])) for w in flown])
    permit = None
    if path_check["zone_class"] == "red":
        from app.permits import service as permit_service
        # alt_slack: the permit froze the PLANNED altitudes; the flown
        # mission differs by exactly this drone's separation band.
        permit = await permit_service.find_approved(db_id, flown,
                                                    alt_slack=band)
        if permit is None:
            names = ", ".join(z["name"] for z in path_check["zones"])
            return False, {"blocked": "red", "zones": path_check["zones"],
                           "msg": f"Mission crosses NO-FLY (red) zone: {names}"}
    if (path_check["zone_class"] == "orange" and not ack_orange
            and permit is None):
        names = ", ".join(z["name"] for z in path_check["zones"])
        return False, {"needs_ack": True, "zones": path_check["zones"],
                       "msg": f"Mission passes through orange zone: {names}"}

    ok, err = await manager.upload_mission(flown, terrain_follow=False)
    if not ok and "UNAVAILABLE" in str(err):
        # The gRPC channel under this manager is dead (its mavsdk_server
        # was killed or crashed). Rebuild the link and retry once instead
        # of dumping a gRPC stack trace on the operator.
        logger.warning(f"Fleet drone {i}: dead link on upload - rebuilding")
        manager = await _rebuild(i)
        if manager is None:
            return False, {"msg": "Drone link is down - reconnecting, try again shortly"}
        ok, err = await manager.upload_mission(flown, terrain_follow=False)
    if not ok:
        return False, {"msg": f"Upload failed: {err}"}
    from app.planner import service as mission_service
    await mission_service.mark_uploaded_by_hash(waypoints, drone_id=db_id)

    last = flown[-1]
    _land_target[i] = (float(last["lat"]), float(last["lng"]))
    _paused.pop(i, None)

    # Takeoff deconfliction: another drone in the air directly overhead
    # means this one WAITS on the ground - the monitor arms it the moment
    # the column is clear.
    if _airspace_overhead_busy(i):
        _pending_start[i] = True
        # Persist the hold so a server restart in this window re-arms the
        # drone instead of stranding it with an uploaded mission.
        await mission_service.set_held_by_hash(waypoints, db_id, True)
        logger.info(f"Fleet drone {i}: takeoff held - airspace overhead busy")
        return True, {"msg": "Mission uploaded - holding takeoff until overhead airspace is clear",
                      "queued": True}

    ok2, msg2 = await manager.arm_and_start_mission()
    if not ok2 and "UNAVAILABLE" in str(msg2):
        logger.warning(f"Fleet drone {i}: dead link on start - rebuilding")
        manager = await _rebuild(i)
        if manager is not None:
            ok, err = await manager.upload_mission(flown, terrain_follow=False)
            if ok:
                ok2, msg2 = await manager.arm_and_start_mission()
    if not ok2:
        _land_target.pop(i, None)
        return False, {"msg": f"Uploaded, but start failed: {msg2}"}
    logger.info(f"Fleet drone {i} flying a {len(flown)}-wp mission (+{band:.0f} m band)")
    return True, {"msg": "Mission started"}


async def _rebuild(i: int):
    """Tear down instance i's manager and reconnect from scratch. Returns
    the fresh manager, or None if no drone answered."""
    async with _lock:
        old = _managers.pop(i, None)
        _state.pop(i, None)
    if old is not None:
        try:
            await old.stop(kill_stale=True)
        except Exception:
            pass
    if await connect_one(i) == "connected":
        return _managers.get(i)
    return None


def _airspace_overhead_busy(i: int) -> bool:
    """Is any OTHER drone airborne within TAKEOFF_CLEAR_RADIUS_M of this
    drone's position? (The reciprocal of the landing guard.)"""
    snap = status()
    me = next((d for d in snap if d["instance"] == i), None)
    lv = (me or {}).get("live")
    if not lv:
        return False
    return any(
        o["instance"] != i and o.get("live") and o["live"]["in_air"]
        and _dist_m(o["live"]["lat"], o["live"]["lng"], lv["lat"], lv["lng"])
        < TAKEOFF_CLEAR_RADIUS_M
        for o in snap
    )


def parking_slot(db_id: str, lat: float, lng: float) -> tuple[float, float]:
    """A drone's own parking spot at a station: a 4 m grid around the
    station point, indexed by instance. Five drones told to 'return to
    station' must not be five drones told to land on the same square
    metre - that is how the first fleet test ended in a pile."""
    import math
    i = instance_for(db_id)
    if i is None:
        return (lat, lng)
    col = (i - 1) % 3 - 1          # -1, 0, 1
    row = (i - 1) // 3             # 0, 1, ...
    dlat = (row * 4.0) / 111_320
    dlng = (col * 4.0) / (111_320 * math.cos(math.radians(lat)))
    return (lat + dlat, lng + dlng)


async def _recover_land_targets(snapshot: list[dict]) -> None:
    """The land-target map lives in memory and a server restart wipes it -
    the exact restart the watchdog is built to survive. Any airborne drone
    we are not guarding gets its target back from its latest uploaded
    mission in the database, so the landing guard NEVER silently lapses."""
    from sqlalchemy import select
    from app.db import db_available, get_session
    from app.db.models import Mission
    if not db_available():
        return
    for d in snapshot:
        i = d["instance"]
        lv = d.get("live")
        if not lv or not lv["in_air"] or i in _land_target or not d.get("db_id"):
            continue
        try:
            async with get_session() as db:
                m = (
                    await db.execute(
                        select(Mission)
                        .where(Mission.drone_id == d["db_id"],
                               Mission.status.in_(("uploaded", "flying")))
                        .order_by(Mission.created_at.desc()).limit(1)
                    )
                ).scalars().first()
            if m and m.waypoints:
                last = m.waypoints[-1]
                _land_target[i] = (float(last["lat"]), float(last["lng"]))
                logger.info(f"Fleet drone {i}: landing target recovered from DB")
        except Exception as e:
            logger.warning(f"Land-target recovery for drone {i} failed: {e}")


async def _recover_held_takeoffs(snapshot: list[dict]) -> None:
    """A takeoff held for overhead traffic lives in _pending_start, which a
    server restart wipes - the same restart the watchdog exists to survive.
    fly_mission persists the hold on the mission (held_takeoff), so any
    grounded fleet drone whose latest uploaded mission still carries the flag
    gets its hold restored here; the held-takeoff loop then arms it when the
    column clears. Each connected drone is checked exactly once."""
    from app.planner import service as mission_service
    for d in snapshot:
        i, lv = d["instance"], d.get("live")
        db_id = d.get("db_id")
        if not db_id or i in _holds_checked or i in _pending_start:
            continue
        if lv is None:
            continue  # not reporting yet - re-check on a later cycle
        _holds_checked.add(i)
        if lv["in_air"]:
            continue  # airborne: this is not a waiting takeoff
        m = await mission_service.held_takeoff_for_drone(db_id)
        if not m:
            continue
        _pending_start[i] = True
        wps = m.get("waypoints") or []
        if wps:
            last = wps[-1]
            _land_target[i] = (float(last["lat"]), float(last["lng"]))
        logger.warning(f"Fleet drone {i}: held takeoff RECOVERED from DB after "
                       f"a restart - will arm when overhead airspace is clear")


async def _monitor_cycle() -> None:
    """Landing deconfliction: a drone close to its landing point loiters
    (mission pause) while any other drone sits within PAD_CLEAR_RADIUS_M
    of that point, and resumes when the pad is clear. Also arms missions
    whose takeoff was held for overhead traffic."""
    snapshot = status()
    by_instance = {d["instance"]: d for d in snapshot}

    await _recover_land_targets(snapshot)
    await _recover_held_takeoffs(snapshot)

    # Held takeoffs: arm the moment the column overhead is clear. A failed
    # arm KEEPS the hold and retries next cycle (a one-shot attempt used to
    # strand the drone with an uploaded mission nothing would ever start);
    # after 10 failed attempts we give up loudly.
    from app.planner import service as mission_service
    for i in [k for k, v in _pending_start.items() if v]:
        if _airspace_overhead_busy(i):
            continue
        mgr = _managers.get(i)
        if mgr is None or not mgr.is_connected:
            continue  # link is being rebuilt - keep the hold, retry later
        ok, msg = await mgr.arm_and_start_mission()
        if ok:
            _pending_start.pop(i, None)
            _pending_tries.pop(i, None)
            if _db_ids.get(i):
                await mission_service.clear_held_for_drone(_db_ids[i])
            logger.info(f"Fleet drone {i}: held takeoff released - started")
        else:
            _pending_tries[i] = _pending_tries.get(i, 0) + 1
            if _pending_tries[i] >= 10:
                _pending_start.pop(i, None)
                _pending_tries.pop(i, None)
                _land_target.pop(i, None)
                if _db_ids.get(i):
                    await mission_service.clear_held_for_drone(_db_ids[i])
                logger.error(f"Fleet drone {i}: held takeoff ABANDONED "
                             f"after 10 failed starts: {msg}")
            else:
                logger.warning(f"Fleet drone {i}: held takeoff start failed "
                               f"(try {_pending_tries[i]}/10): {msg}")

    # Battery reserve guard: an airborne fleet drone that dips under the
    # reserve gets ONE automatic RETURN command, and its active order is
    # marked returned. The reserve exists so a delay or loiter can still
    # bring the aircraft home - it is not usable mission energy.
    for d in snapshot:
        i, lv = d["instance"], d.get("live")
        if not lv or not lv["in_air"]:
            _reserve_triggered.discard(i)
            continue
        if i in _reserve_triggered or lv["battery"] >= RESERVE_PCT:
            continue
        _reserve_triggered.add(i)
        mgr = _managers.get(i)
        logger.error(f"Fleet drone {i}: battery {lv['battery']:.0f}% under "
                     f"{RESERVE_PCT:.0f}% reserve - commanding RETURN")
        if mgr is not None:
            try:
                await mgr.set_flight_mode("RETURN")
            except Exception as e:
                logger.error(f"Fleet drone {i}: RETURN command failed: {e}")
        _land_target.pop(i, None)
        _pending_start.pop(i, None)
        if d.get("db_id"):
            await mission_service.clear_held_for_drone(d["db_id"])
            try:
                from app.tasks import service as task_service
                await task_service.mark_returned_for_drone(
                    d["db_id"],
                    note=f"Battery {lv['battery']:.0f}% breached the "
                         f"{RESERVE_PCT:.0f}% reserve - drone returned to launch")
            except Exception as e:
                logger.warning(f"Reserve return: task update failed: {e}")
    for i, target in list(_land_target.items()):
        d = by_instance.get(i)
        lv = (d or {}).get("live")
        if not d or not lv:
            continue
        if not lv["in_air"]:
            # On the ground - if we're at the target the mission is done.
            if _dist_m(lv["lat"], lv["lng"], target[0], target[1]) < 15.0:
                _land_target.pop(i, None)
                _paused.pop(i, None)
            continue
        if _dist_m(lv["lat"], lv["lng"], target[0], target[1]) > LAND_GUARD_RADIUS_M:
            continue
        occupied = any(
            o["instance"] != i and o.get("live")
            and _dist_m(o["live"]["lat"], o["live"]["lng"], target[0], target[1])
            < PAD_CLEAR_RADIUS_M
            for o in snapshot
        )
        mgr = _managers.get(i)
        if mgr is None:
            continue
        if occupied and not _paused.get(i):
            _paused[i] = True
            logger.info(f"Fleet drone {i}: landing point occupied - loitering")
            await mgr.pause_mission()
        elif not occupied and _paused.get(i):
            _paused[i] = False
            logger.info(f"Fleet drone {i}: landing point clear - resuming")
            await mgr.start_mission()


async def _watchdog_loop() -> None:
    global _scan_cycle
    sem = asyncio.Semaphore(2)

    async def try_adopt(i: int) -> None:
        async with sem:
            m = _managers.get(i)
            if m is not None and m.is_connected:
                if not _is_stale(i):
                    _fail_counts.pop(i, None)
                    return
                # Telemetry stopped flowing - the mavsdk_server under this
                # manager is gone (killed externally, sim restarted...).
                # Tear it down and rebuild the link from scratch.
                logger.warning(f"Fleet drone {i}: link stale - rebuilding")
                async with _lock:
                    _managers.pop(i, None)
                    _state.pop(i, None)
                try:
                    await m.stop(kill_stale=True)
                except Exception:
                    pass
            # An instance that keeps failing is probably an empty port -
            # retry it every 4th cycle, not every cycle (each attempt costs
            # a 10 s connect timeout and a throwaway mavsdk_server).
            if _fail_counts.get(i, 0) >= 3 and _scan_cycle % 4 != 0:
                return
            result = await connect_one(i)
            if result == "connected":
                _fail_counts.pop(i, None)
                logger.info(f"Watchdog adopted fleet drone {i}")
            elif result.startswith("no drone"):
                _fail_counts[i] = _fail_counts.get(i, 0) + 1

    while True:
        try:
            if not _disabled:
                _scan_cycle += 1
                # Probe 1..MAX_SCAN for new drones, and heal every instance
                # already adopted (including 9-20) so a dropped high-index
                # link is rebuilt instead of silently staying dead.
                scan = sorted(set(range(1, MAX_SCAN + 1)) | _adopted)
                await asyncio.gather(*[try_adopt(i) for i in scan])
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Fleet watchdog cycle failed: {e}")
        await asyncio.sleep(WATCHDOG_INTERVAL_S)


async def _monitor_loop() -> None:
    while True:
        try:
            await _monitor_cycle()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Fleet monitor cycle failed: {e}")
        await asyncio.sleep(MONITOR_INTERVAL_S)


def start_background() -> None:
    """Start the adopt/reconnect watchdog and the landing monitor."""
    global _watchdog, _monitor
    if _watchdog is None or _watchdog.done():
        _watchdog = asyncio.create_task(_watchdog_loop(), name="fleet_watchdog")
    if _monitor is None or _monitor.done():
        _monitor = asyncio.create_task(_monitor_loop(), name="fleet_monitor")
    logger.info("Fleet watchdog + landing monitor started")


def stop_background() -> None:
    global _watchdog, _monitor
    for t in (_watchdog, _monitor):
        if t is not None:
            t.cancel()
    _watchdog = _monitor = None

"""
What the aircraft does when it cannot see the target.

THE REPORT: "if the target is out of frame the drone kept moving."

It did, and by design — the wrong design. Every follow module answered a frame
with no visible target by re-issuing state["last_drone_command"] verbatim for
_PHASE_HOLD = 90 analysis frames. Two things made that much worse than the
constant suggests:

  1. THE FROZEN COMMAND WAS SYSTEMATICALLY THE LARGEST ONE. A subject leaves
     the frame because it is off-axis, or fast, or far — precisely the
     conditions under which the yaw PD is near its 55 deg/s clamp and the
     distance PD near its 2.5 m/s clamp. The command that got frozen and
     replayed was near full authority essentially every time, because the
     situations that end a lock and the situations that saturate the
     controllers are the same situations.

  2. THE WINDOW WAS COUNTED IN FRAMES. The analysis loop drops frames — base.py
     says so itself: "dt IS NOT 1/fps". So 90 frames is about 3 s on a fast GPU
     and about 18 s when the model is loaded or the source is slow, which at
     2.5 m/s is over 40 m of blind travel. The blind window stretched longest
     exactly when vision was least able to end it.

traffic_manager reached the same symptom from the opposite direction: it
returned None, which does not stop the aircraft. It stops US, and PX4 flies on
at the last velocity it was given until its offboard-loss failsafe fires.

And underneath both: every setpoint PX4 receives originates in a vision result,
so if the vision loop stops producing results at all, nothing in the vision
layer can command a stop, because the thing that failed IS the vision layer.
That is what _offboard_watchdog is for.

The invariant all of this is protecting: TRANSLATION IS THE DANGEROUS AXIS WHEN
BLIND. You cannot fly toward something you cannot see. Yaw is kept, because
turning after a subject that just left the frame edge is how it comes back, and
a yaw carries the aircraft nowhere.
"""
import asyncio
import importlib
import inspect

import pytest

from app.vision.pursuit import (
    BLIND_DECAY_UNTIL_S,
    BLIND_GIVE_UP_S,
    BLIND_HOLD_S,
    COAST_UNTIL_S,
    SWEEP_YAW_DEG_S,
    WIDEN_UNTIL_S,
    blind_command,
    blind_elapsed_s,
    hover_command,
    seconds_lost_for,
)

# The saturated command a real lost lock hands over: full forward, near-full
# yaw. Built once because every test about the defect is a test about what
# happens to THIS.
CHASING = {
    "type": "velocity",
    "forward_m_s": 2.5,
    "right_m_s": 0.0,
    "down_m_s": 0.0,
    "yaw_deg_s": 55.0,
}

FOLLOW_MODULES = [
    "human_tracker",
    "person_tracker",
    "crowd_manager",
    "plate_tracker",
    "traffic_manager",
]


def at(seconds, last_cmd=CHASING, yaw_dir=1.0):
    """The blind command at a given elapsed time, driven through the wall-clock
    input so the frame count is not what is under test."""
    return blind_command(
        last_cmd=last_cmd, frames_lost=0, seconds_lost=seconds, last_yaw_dir=yaw_dir
    )


# --------------------------------------------------------------------------- #
# The reported bug                                                            #
# --------------------------------------------------------------------------- #

def test_a_target_leaving_frame_no_longer_keeps_the_drone_flying_forward():
    """THE REPORT. The drone was chasing at full speed, the subject left the
    frame, and the drone carried on at full speed. Whatever else happens on the
    ladder, forward must not still be saturated a second later."""
    assert at(1.0)["forward_m_s"] < CHASING["forward_m_s"], (
        "the frozen full-speed command survived a full second of blindness"
    )
    assert at(BLIND_DECAY_UNTIL_S)["forward_m_s"] == 0.0


def test_translation_is_fully_stopped_before_the_operator_stops_reading_coasting():
    """The badge says "briefly hidden" until COAST_UNTIL_S. Translation has to
    be over by then, or the reassuring label is covering real ground track."""
    assert BLIND_DECAY_UNTIL_S < COAST_UNTIL_S
    cmd = at(COAST_UNTIL_S)
    assert cmd["forward_m_s"] == 0.0
    assert cmd["down_m_s"] == 0.0
    assert cmd["right_m_s"] == 0.0


@pytest.mark.parametrize("elapsed", [0.0, 0.2, 0.4, 0.5, 0.7, 0.9, 1.1, 1.2, 2.0, 8.0])
def test_forward_never_increases_while_blind(elapsed):
    """Monotonic non-increasing. A taper that ever rose would be a blind
    acceleration, which is the one thing this must never produce."""
    assert 0.0 <= at(elapsed)["forward_m_s"] <= CHASING["forward_m_s"]


def test_forward_is_strictly_decreasing_through_the_decay_window():
    xs = [at(t)["forward_m_s"] for t in (0.5, 0.7, 0.9, 1.1)]
    assert xs == sorted(xs, reverse=True)
    assert xs[0] > xs[-1] > 0.0, "the window neither faded nor was it a cliff"


def test_the_blind_ground_track_is_bounded_to_a_couple_of_metres():
    """The number that actually matters to the operator: how far does it travel
    without being able to see. Integrating the taper at the 2.5 m/s clamp — the
    worst case, since the clamp is the ceiling on the axis."""
    dt = 0.005
    travelled = 0.0
    t = 0.0
    while t < BLIND_GIVE_UP_S:
        travelled += at(t)["forward_m_s"] * dt
        t += dt
    assert travelled < 2.5, f"blind ground track was {travelled:.2f} m"
    # And for scale, what the frame-counted replay did at a plausible 15 fps:
    # 90 frames = 6 s of unfaded 2.5 m/s = 15 m.
    assert travelled < 15.0 / 5


def test_a_retreat_is_faded_out_too_not_just_a_forward_run():
    """The taper is on the axis, not on one sign of it. A subject that vanished
    while very close leaves a negative command behind, and riding that
    backwards indefinitely is the same defect mirrored."""
    backing = dict(CHASING, forward_m_s=-2.5)
    assert at(0.9, last_cmd=backing)["forward_m_s"] > -2.5
    assert at(BLIND_DECAY_UNTIL_S, last_cmd=backing)["forward_m_s"] == 0.0


def test_a_blind_climb_is_faded_out_as_well():
    """down_m_s can be a live auto-elevate climb when the lock is lost. It is
    bounded by limit_climb, but bounded is not the same as indefinite."""
    climbing = dict(CHASING, down_m_s=-1.2)
    assert -1.2 < at(0.9, last_cmd=climbing)["down_m_s"] <= 0.0
    assert at(BLIND_DECAY_UNTIL_S, last_cmd=climbing)["down_m_s"] == 0.0


# --------------------------------------------------------------------------- #
# What is deliberately KEPT                                                   #
# --------------------------------------------------------------------------- #

def test_a_single_missed_detection_holds_the_last_command_verbatim():
    """Most losses are one bad frame and resolve on their own. Reacting
    instantly would fight detector noise instead of riding it out — and this is
    returned bit-for-bit, so a held frame cannot introduce a step from
    re-rounding alone."""
    assert at(0.0) == CHASING
    assert at(BLIND_HOLD_S) == CHASING


def test_yaw_survives_the_window_because_yaw_is_how_the_target_comes_back():
    """The subject usually leaves sideways. Zeroing yaw along with translation
    would stop the one action that recovers the lock, and a yaw carries the
    aircraft nowhere."""
    for t in (0.5, 0.9, 1.3, 5.0, BLIND_GIVE_UP_S - 0.1):
        assert at(t)["yaw_deg_s"] > 0.0, f"yaw died at {t}s"


def test_yaw_settles_to_the_search_sweep_rather_than_holding_full_rate():
    """55 deg/s held blind would spin straight past the subject. It hands over
    to the sweep rate instead of stopping."""
    assert at(2.0)["yaw_deg_s"] == pytest.approx(SWEEP_YAW_DEG_S)
    assert at(0.9)["yaw_deg_s"] < CHASING["yaw_deg_s"]
    assert at(0.9)["yaw_deg_s"] > SWEEP_YAW_DEG_S


@pytest.mark.parametrize(
    "t", [0.4, 0.5, 0.7, 0.9, 1.1, 1.19, BLIND_DECAY_UNTIL_S, 3.0, 10.0]
)
def test_yaw_interpolates_down_to_the_sweep_rate_and_never_below_it(t):
    """The handover is an interpolation from the commanded rate to the search
    rate, not a fade to zero with the sweep bolted on afterwards.

    Tapering yaw toward ZERO instead would leave it near-motionless at the end
    of the decay window and then jump back up to the sweep rate — a step change
    in yaw at the moment the aircraft is meant to start looking, and a stretch
    of not looking at all just before it.
    """
    assert at(t)["yaw_deg_s"] >= SWEEP_YAW_DEG_S - 1e-6


def test_the_handover_to_the_sweep_has_no_step_in_it():
    """Continuity at the boundary. A discontinuity here is a yaw kick on an
    aircraft that is already unsure where it is pointing."""
    before = at(BLIND_DECAY_UNTIL_S - 0.01)["yaw_deg_s"]
    after = at(BLIND_DECAY_UNTIL_S + 0.01)["yaw_deg_s"]
    assert abs(before - after) < 1.0, f"{before} -> {after} deg/s across the rung"


def test_the_sweep_turns_the_way_the_target_went():
    """Sweeping away from the last known direction searches the half of the
    world the subject is not in."""
    assert at(3.0, yaw_dir=1.0)["yaw_deg_s"] == pytest.approx(SWEEP_YAW_DEG_S)
    assert at(3.0, yaw_dir=-1.0)["yaw_deg_s"] == pytest.approx(-SWEEP_YAW_DEG_S)


def test_the_sweep_carries_no_translation_at_all():
    cmd = at(5.0)
    assert cmd["forward_m_s"] == 0.0 and cmd["down_m_s"] == 0.0


def test_it_settles_to_a_hover_once_it_has_given_up():
    cmd = at(BLIND_GIVE_UP_S + 1.0)
    assert cmd == hover_command()
    assert cmd["yaw_deg_s"] == 0.0, "still wandering after giving up"


# --------------------------------------------------------------------------- #
# Never silence: the Offboard stream                                          #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("elapsed", [0.0, 0.4, 1.2, 5.0, 14.9, 15.0, 600.0])
@pytest.mark.parametrize("last", [None, {}, CHASING])
def test_a_command_is_always_produced_for_any_input(elapsed, last):
    """A gap in the Offboard setpoint stream hands the aircraft to PX4's own
    failsafe, whose default action on many airframes is LAND. There is no input
    for which the right answer is None."""
    cmd = blind_command(
        last_cmd=last, frames_lost=999, seconds_lost=elapsed, last_yaw_dir=1.0
    )
    assert cmd is not None and cmd["type"] == "velocity"
    for axis in ("forward_m_s", "right_m_s", "down_m_s", "yaw_deg_s"):
        assert isinstance(cmd[axis], float)


def test_with_no_command_history_it_searches_rather_than_guessing():
    """A lock lost before it ever produced a command has nothing to hold. That
    is a reason to sweep, not a reason to go silent."""
    cmd = blind_command(
        last_cmd=None, frames_lost=1, seconds_lost=0.0, last_yaw_dir=1.0
    )
    assert cmd["forward_m_s"] == 0.0
    assert cmd["yaw_deg_s"] == pytest.approx(SWEEP_YAW_DEG_S)


# --------------------------------------------------------------------------- #
# The two clocks                                                              #
# --------------------------------------------------------------------------- #

def test_a_slow_analysis_rate_cannot_stretch_the_blind_window():
    """DEFECT 2. Under a frame-counted window, 3 frames lost meant 3 frames of
    full-speed replay whether that took 0.1 s or 2 s. Wall time is consulted,
    so a slow pipeline gets the same seconds as a fast one — and it is the
    slow pipeline that most needs the aircraft to stop."""
    # Three frames lost, but two seconds have really passed: a 1.5 fps crawl.
    cmd = blind_command(
        last_cmd=CHASING, frames_lost=3, seconds_lost=2.0, last_yaw_dir=1.0
    )
    assert cmd["forward_m_s"] == 0.0, "a slow pipeline still got a blind full-speed run"


def test_a_stalled_frame_source_is_still_caught_by_the_frame_count():
    """The mirror image, and why both clocks are needed. If frames stop
    arriving the wall clock keeps running but nothing calls the module to read
    it, so the frame count is the only clock that advances."""
    cmd = blind_command(
        last_cmd=CHASING, frames_lost=400, seconds_lost=0.0, last_yaw_dir=1.0
    )
    assert cmd["forward_m_s"] == 0.0


def test_whichever_clock_reads_further_wins():
    assert blind_elapsed_s(0, 5.0) == pytest.approx(5.0)
    assert blind_elapsed_s(400, 0.0) > 5.0
    # Taking the max means an inaccurate nominal fps can only ever stop the
    # aircraft EARLY, never late.
    assert blind_elapsed_s(400, 5.0) == blind_elapsed_s(400, 0.0)
    assert blind_elapsed_s(0, 0.0) == 0.0


def test_negative_and_zero_inputs_do_not_read_as_a_long_absence():
    assert blind_elapsed_s(-5, -1.0) == 0.0


def test_a_target_never_seen_is_not_a_target_missing_since_the_epoch():
    """seconds_lost_for on a fresh state must not subtract from zero — that
    would read a lock made a moment ago as having been lost for decades, and
    the first blind frame would jump straight to hover."""
    assert seconds_lost_for({}) == 0.0
    assert seconds_lost_for({"last_seen_t": 0.0}) == 0.0
    assert seconds_lost_for({"last_seen_t": None}) == 0.0


# --------------------------------------------------------------------------- #
# The flown ladder and the displayed ladder are the same ladder               #
# --------------------------------------------------------------------------- #

def test_giving_up_in_the_air_coincides_with_giving_up_on_the_badge():
    """DEFECT 3. The lock badge ran on seconds and the flight ladder on frames,
    so the UI could read "lost 10s ago - holding position" while the module was
    still replaying a full-speed forward command."""
    assert BLIND_GIVE_UP_S == WIDEN_UNTIL_S


def test_the_ladder_rungs_are_in_order():
    assert 0 < BLIND_HOLD_S < BLIND_DECAY_UNTIL_S < BLIND_GIVE_UP_S


# --------------------------------------------------------------------------- #
# Every follow module, structurally                                           #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("name", FOLLOW_MODULES)
def test_no_module_replays_its_last_command_directly(name):
    """The defect was five separate copies of the same replay. It is shared now
    precisely so it cannot come back in one module and not the others — and so
    a fix has one place to be applied."""
    src = inspect.getsource(
        importlib.import_module(f"app.vision.modules.{name}")
    )
    assert "blind_command(" in src, f"{name} does not use the shared blind policy"
    for banned in (
        'return state["last_drone_command"]',
        'return state.get("last_drone_command")',
        'drone_command = state["last_drone_command"]',
        'drone_command = state.get("last_drone_command")',
    ):
        assert banned not in src, f"{name} still replays the last command: {banned}"


@pytest.mark.parametrize("name", FOLLOW_MODULES)
def test_no_module_keeps_a_frame_counted_blind_window(name):
    """_PHASE_HOLD/_PHASE_SWEEP were the frame-counted window. They are gone,
    and a reintroduction is a reintroduction of defect 2."""
    mod = importlib.import_module(f"app.vision.modules.{name}")
    assert not hasattr(mod, "_PHASE_HOLD")
    assert not hasattr(mod, "_PHASE_SWEEP")


@pytest.mark.parametrize("name", FOLLOW_MODULES)
def test_every_module_records_what_blind_command_needs(name):
    """blind_command reads last_drone_command and last_yaw_dir off state. A
    module that never writes them gets a permanent sweep instead of a hold —
    which is how traffic_manager's gap was found."""
    src = inspect.getsource(importlib.import_module(f"app.vision.modules.{name}"))
    # The ASSIGNMENT, not merely the key: declaring the field in the state dict
    # and never writing it is exactly the shape of traffic_manager's gap, and
    # leaves the module permanently sweeping instead of ever holding.
    assert 'state["last_drone_command"] = ' in src, f"{name} never records its command"
    assert 'state["last_yaw_dir"] = ' in src, f"{name} never records its yaw direction"


# --------------------------------------------------------------------------- #
# traffic_manager: the same symptom from the opposite direction               #
# --------------------------------------------------------------------------- #

def _traffic():
    return importlib.import_module("test_traffic_manager")


def test_traffic_no_longer_goes_silent_when_the_vehicle_drops_out():
    """It returned None. None does not stop the aircraft — it stops us, and PX4
    flies on at the last velocity it was given until its offboard-loss failsafe
    fires. Same "kept moving", arrived at by omission rather than by replay."""
    tt = _traffic()
    t = tt.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [tt.vehicle(7)], [], "s", 1920, 1080, None, None)

    cmd = t._follow(state, [], [], "s", 1920, 1080, None, None)
    assert cmd is not None, "the Offboard setpoint stream gapped"
    assert cmd["type"] == "velocity"


def test_traffic_still_returns_none_when_it_is_not_armed():
    """The keepalive obligation comes from being armed. An unarmed session must
    not be pushing setpoints at an aircraft nobody asked it to fly."""
    tt = _traffic()
    t = tt.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t._follow(state, [tt.vehicle(7)], [], "s", 1920, 1080, None, None)
    assert t._follow(state, [], [], "s", 1920, 1080, None, None) is None


def test_traffic_holds_the_last_command_on_a_single_missed_frame():
    """The behaviour it could not have before: it recorded no last command, so
    its only possible answer to a missing subject was a sweep from a standing
    start — reacting to every dropped detection instead of riding it out."""
    tt = _traffic()
    t = tt.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    for _ in range(4):
        last = t._follow(state, [tt.vehicle(7, 1500, 500, 1800, 700)], [],
                         "s", 1920, 1080, None, None)
    assert last is not None
    assert t._follow(state, [], [], "s", 1920, 1080, None, None) == last


def test_traffic_stops_translating_once_the_vehicle_has_been_gone_a_while():
    """End to end through the real _follow, not the helper: the sign could be
    right in pursuit.py and read backwards at the call site."""
    tt = _traffic()
    t = tt.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    t._follow(state, [tt.vehicle(7)], [], "s", 1920, 1080, None, None)
    # Backdate the sighting rather than sleeping: the ladder is in seconds.
    import time as _t
    state["last_seen_t"] = _t.monotonic() - (BLIND_DECAY_UNTIL_S + 0.1)
    cmd = t._follow(state, [], [], "s", 1920, 1080, None, None)
    assert cmd["forward_m_s"] == 0.0
    assert cmd["down_m_s"] == 0.0


# --------------------------------------------------------------------------- #
# End to end through a real follow loop                                       #
# --------------------------------------------------------------------------- #

def _plate():
    return importlib.import_module("test_plate_tracker")


def test_plate_follow_fades_a_chase_out_when_the_vehicle_leaves_frame():
    tp = _plate()
    t = tp.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    # Far up the frame in Fixed: a real forward command to fade.
    state["target_row"] = 0.85
    for _ in range(4):
        chasing = t._follow(state, [tp.vehicle(7, 900, 200, 1000, 300)],
                            "s", 1920, 1080, None, None)
    assert chasing["forward_m_s"] > 0.5, "setup did not produce a chase to fade"

    import time as _t
    state["last_seen_t"] = _t.monotonic() - (BLIND_DECAY_UNTIL_S + 0.1)
    lost = t._follow(state, [], "s", 1920, 1080, None, None)
    assert lost is not None
    assert lost["forward_m_s"] == 0.0, "the chase carried on with nothing in frame"


def test_plate_follow_holds_a_single_missed_frame():
    """The behaviour that had to survive the fix: one dropped detection is not
    an event, and reacting to it loses more locks than it saves."""
    tp = _plate()
    t = tp.bare_tracker()
    state = t._client_state["s"]
    t.request_follow("s", 7)
    t.set_tracking("s", True)
    for _ in range(6):
        last = t._follow(state, [tp.vehicle(7, 1500, 500, 1800, 700)],
                         "s", 1920, 1080, None, None)
    assert t._follow(state, [], "s", 1920, 1080, None, None) == last


# --------------------------------------------------------------------------- #
# The stop that does not depend on vision working at all                      #
# --------------------------------------------------------------------------- #

class _RecordingOffboard:
    def __init__(self):
        self.sent = []

    async def set_velocity_body(self, v):
        self.sent.append(
            (v.forward_m_s, v.right_m_s, v.down_m_s, v.yawspeed_deg_s)
        )


class _StubDrone:
    def __init__(self, offboard):
        self.offboard = offboard


def _wd_manager(offboard_active=True, connected=True):
    from app.telemetry.manager import TelemetryManager
    from app.telemetry.schemas import TelemetrySnapshot

    t = TelemetryManager.__new__(TelemetryManager)
    t._drone = _StubDrone(_RecordingOffboard())
    t._snapshot = TelemetrySnapshot()
    t._connected = connected
    t._offboard_active = offboard_active
    t._offboard_hold_alt = None
    t._last_velocity_cmd_t = 0.0
    t._offboard_stale = False
    # Nobody has taken the aircraft. send_velocity_command refuses outright
    # while a pilot has it (see test_pilot_handover), so the watchdog tests
    # have to say which case they are — these are all "the app still holds it".
    t._pilot_override_mode = None
    return t


async def _run_watchdog_for(t, seconds):
    task = asyncio.create_task(t._offboard_watchdog())
    try:
        await asyncio.sleep(seconds)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_the_aircraft_is_zeroed_when_the_commanding_loop_goes_quiet():
    """THE UNDERLYING HAZARD. Every setpoint PX4 gets comes from a vision
    result, so a stalled video source or a dead analyzer means the last
    velocity sent is the last one PX4 ever hears — and the aircraft flies it.
    Nothing in the vision layer can fix that; the vision layer is what broke."""
    t = _wd_manager()
    await t.send_velocity_command(forward_m_s=2.5, yaw_deg_s=40.0)
    assert t._drone.offboard.sent[-1][0] == 2.5

    # ...and then the loop stops calling. Nothing else happens.
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.5)

    assert t._offboard_stale is True
    assert t._drone.offboard.sent[-1] == (0.0, 0.0, 0.0, 0.0)


@pytest.mark.asyncio
async def test_the_zero_setpoint_keeps_being_sent_not_sent_once():
    """PX4 needs the stream to continue. A single zero would itself become the
    gap that triggers the offboard-loss failsafe."""
    t = _wd_manager()
    await t.send_velocity_command(forward_m_s=2.5)
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.7)
    zeros = [s for s in t._drone.offboard.sent if s == (0.0, 0.0, 0.0, 0.0)]
    assert len(zeros) >= 2, f"only {len(zeros)} zero setpoints sent"


@pytest.mark.asyncio
async def test_a_live_commanding_loop_is_left_alone():
    """The watchdog must not fight the tracker. While commands keep arriving it
    contributes nothing."""
    t = _wd_manager()
    task = asyncio.create_task(t._offboard_watchdog())
    try:
        for _ in range(8):
            await t.send_velocity_command(forward_m_s=1.5)
            await asyncio.sleep(0.1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert t._offboard_stale is False
    assert all(s[0] == 1.5 for s in t._drone.offboard.sent)


@pytest.mark.asyncio
async def test_the_watchdogs_own_zeros_do_not_look_like_a_live_loop():
    """The trap this design avoids: if the watchdog's send refreshed the
    last-command timestamp, it would clear its own staleness on the first tick
    and then go quiet — leaving exactly one zero in the stream."""
    t = _wd_manager()
    await t.send_velocity_command(forward_m_s=2.5)
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.7)
    assert t._offboard_stale is True, "the watchdog cleared its own alarm"


@pytest.mark.asyncio
async def test_nothing_is_sent_before_the_first_real_command():
    """An armed Offboard session that has never been given a velocity is not
    one that stopped being given them."""
    t = _wd_manager()
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.4)
    assert t._drone.offboard.sent == []
    assert t._offboard_stale is False


@pytest.mark.asyncio
async def test_nothing_is_sent_when_offboard_is_not_active():
    """Pushing velocity setpoints at an aircraft flying a mission or under
    manual control would be a far worse bug than the one being fixed."""
    t = _wd_manager(offboard_active=False)
    t._last_velocity_cmd_t = 1.0  # ancient, but irrelevant: not our aircraft
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.4)
    assert t._drone.offboard.sent == []


@pytest.mark.asyncio
async def test_a_resumed_loop_is_reported_and_takes_back_control():
    t = _wd_manager()
    await t.send_velocity_command(forward_m_s=2.5)
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.4)
    assert t._offboard_stale is True
    await t.send_velocity_command(forward_m_s=1.0)
    assert t._offboard_stale is False
    assert t._drone.offboard.sent[-1][0] == 1.0


@pytest.mark.asyncio
async def test_the_watchdog_survives_a_failing_send():
    """A link that is dropping sends is the situation in which the watchdog is
    most needed. An exception must not end the task."""
    t = _wd_manager()
    await t.send_velocity_command(forward_m_s=2.5)

    class _Failing:
        sent = []

        async def set_velocity_body(self, v):
            raise RuntimeError("link down")

    t._drone.offboard = _Failing()
    await _run_watchdog_for(t, t._OFFBOARD_STALE_AFTER_S + 0.7)
    # Still alive and still trying is the whole assertion.
    assert t._offboard_stale is True


@pytest.mark.asyncio
async def test_the_watchdog_fires_well_inside_px4s_own_failsafe_window():
    """It has to act before PX4's offboard-loss timeout does, or PX4's failsafe
    decides instead of us — and on many airframes that decision is LAND."""
    from app.telemetry.manager import TelemetryManager

    assert TelemetryManager._OFFBOARD_STALE_AFTER_S <= 0.6
    assert (
        TelemetryManager._OFFBOARD_WATCHDOG_PERIOD_S
        < TelemetryManager._OFFBOARD_STALE_AFTER_S
    ), "a period coarser than the timeout makes the timeout a suggestion"

"""
The yaw tuning is one setting, and it reaches every mode that can follow.

THE REPORT: the tracking settings — responsiveness, max speed, smoothing —
were visible in Human Tracking and nowhere else, and the operator wanted them
in the Settings tab so they apply to all the modes.

WHAT WAS ACTUALLY WRONG. All five follow modes built the same yaw PD from the
same literals, `kp=30, kd=4, max_output=55, deadband=0.05`. Two of them had
sliders wired to it:

    HumanTracker      set_pd_params  <- HumanTrackingPanel
    PersonTracker     set_pd_params  <- PersonTrackerPanel
    CrowdManager      -                     nothing
    PlateTracker      -                     nothing
    TrafficManager    -                     nothing

and the socket handler was gated on `isinstance(analyzer, (HumanTracker,
PersonTracker))`, so even a panel that sent the event would have been ignored.
The three unreachable modes flew on deploy-time defaults permanently.

The sharper cost was not the missing control, it was that TUNING DID NOT
TRANSFER. An operator who spent a flight discovering that this airframe wants
kp=22 to stop wagging had learned something they could not enter anywhere
except the one mode they happened to be in.

So the four gains are now a calibration group, `follow`, saved server-side like
the camera calibration and read by all five at session start. The two panels
that already had live sliders keep them, and those still win for the running
session — a slider dragged mid-flight is an experiment, not a decision — but
they now START from the saved values instead of from literals that contradicted
them.
"""
import importlib
import inspect
import re

import pytest

FOLLOW_MODULES = [
    "human_tracker",
    "person_tracker",
    "crowd_manager",
    "plate_tracker",
    "traffic_manager",
]

FOLLOW_KEYS = [
    "follow_yaw_kp",
    "follow_yaw_kd",
    "follow_yaw_max_deg_s",
    "follow_yaw_deadband",
]


def _make_state_for(name):
    """Each module's real per-session state. Two of the five take a session id
    (they key persisted captures on it); calling through inspect rather than
    branching on the module name keeps this working if a third one gains it."""
    mod = importlib.import_module(f"app.vision.modules.{name}")
    params = inspect.signature(mod._make_state).parameters
    return mod._make_state("t") if params else mod._make_state()


@pytest.fixture
def cal(tmp_path, monkeypatch):
    """Calibration pointed at a scratch file, so a test cannot read or write
    the operator's real tuning."""
    from app.vision import calibration
    monkeypatch.setattr(calibration, "CALIBRATION_PATH", str(tmp_path / "cal.json"))
    calibration._cache = None
    yield calibration
    calibration._cache = None


# --------------------------------------------------------------------------- #
# The setting exists, is reachable, and is validated                          #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("key", FOLLOW_KEYS)
def test_every_gain_is_an_editable_setting(cal, key):
    fields = {f["key"]: f for f in cal.schema()["fields"]}
    assert key in fields, f"{key} is not reachable from the Settings tab"
    assert fields[key]["group"] == "follow"
    assert fields[key]["help"]


def test_the_group_is_separate_from_the_camera_rig_and_the_mission_limits():
    """Different lifetimes and different editors. Mixing follow tuning into
    `camera` invites someone to "fix" oscillation by editing lens geometry,
    which is the calibration file's stated reason for splitting groups at all."""
    from app.vision import calibration
    groups = {f["key"]: f["group"] for f in calibration.FIELDS}
    assert groups["follow_yaw_kp"] == "follow"
    assert groups["camera_hfov_deg"] == "camera"
    assert groups["max_altitude_agl_m"] == "limits"


@pytest.mark.parametrize(
    "key,bad",
    [
        ("follow_yaw_kp", 1000.0),
        ("follow_yaw_kp", -5.0),
        ("follow_yaw_max_deg_s", 500.0),
        ("follow_yaw_deadband", 0.9),
        ("follow_yaw_kd", -1.0),
    ],
)
def test_an_out_of_range_gain_is_refused(cal, key, bad):
    """A gain of 1000 is an oscillation, not a preference."""
    with pytest.raises(ValueError):
        cal.save({key: bad})


def test_a_refused_value_does_not_land_half_saved(cal):
    """All-or-nothing, so a partially applied tuning can never be flying."""
    with pytest.raises(ValueError):
        cal.save({"follow_yaw_kp": 22.0, "follow_yaw_deadband": 99.0})
    assert cal.effective()["follow_yaw_kp"] != 22.0


def test_the_ranges_match_what_the_tracking_panels_offer(cal):
    """The panel sliders and the Settings inputs edit the same four numbers. A
    range the panel allows but Settings rejects — or the reverse — means one of
    the two surfaces is lying about what the aircraft will accept."""
    fields = {f["key"]: f for f in cal.schema()["fields"]}
    # Mirrors PD_PARAMS in HumanTrackingPanel.tsx / PersonTrackerPanel.tsx.
    assert (fields["follow_yaw_kp"]["min"], fields["follow_yaw_kp"]["max"]) == (10.0, 50.0)
    assert (fields["follow_yaw_kd"]["min"], fields["follow_yaw_kd"]["max"]) == (0.0, 10.0)
    assert (fields["follow_yaw_max_deg_s"]["min"],
            fields["follow_yaw_max_deg_s"]["max"]) == (15.0, 55.0)
    assert (fields["follow_yaw_deadband"]["min"],
            fields["follow_yaw_deadband"]["max"]) == (0.01, 0.15)


# --------------------------------------------------------------------------- #
# It reaches the PD                                                           #
# --------------------------------------------------------------------------- #

def test_the_saved_tuning_is_what_the_yaw_pd_is_built_from(cal):
    from app.vision.pursuit import new_yaw_pd

    cal.save({
        "follow_yaw_kp": 22.0,
        "follow_yaw_kd": 3.0,
        "follow_yaw_max_deg_s": 40.0,
        "follow_yaw_deadband": 0.08,
    })
    pd = new_yaw_pd()
    assert (pd.kp, pd.kd, pd.max_output, pd.deadband) == (22.0, 3.0, 40.0, 0.08)


def test_defaults_are_used_when_nothing_has_been_saved(cal):
    """An operator who has never opened the tab must get the same aircraft they
    got before this existed."""
    from app.vision.pursuit import new_yaw_pd

    pd = new_yaw_pd()
    assert (pd.kp, pd.kd, pd.max_output, pd.deadband) == (30.0, 4.0, 55.0, 0.05)


def test_the_flight_controllers_yaw_limit_is_not_negotiable(cal, monkeypatch):
    """PX4's stock MPC_YAWRAUTO_MAX is 60 deg/s and setpoints above it are
    silently rate-limited by the FC — which from the ground is indistinguishable
    from bad tuning. The field range caps at 55, but a value stored by an older
    build bypasses that range entirely, so the clamp is enforced again here."""
    from app.vision import calibration
    from app.vision.pursuit import new_yaw_pd

    real = calibration.effective()
    monkeypatch.setattr(
        calibration, "effective",
        lambda: {**real, "follow_yaw_max_deg_s": 300.0},
    )
    assert new_yaw_pd().max_output == 55.0


@pytest.mark.parametrize("name", FOLLOW_MODULES)
def test_every_follow_mode_takes_its_yaw_pd_from_the_shared_factory(cal, name):
    """The whole point. Three of these five had no route to the setting at all,
    and a literal left behind in any one of them is that mode silently opting
    out of the operator's tuning."""
    src = inspect.getsource(importlib.import_module(f"app.vision.modules.{name}"))
    assert "new_yaw_pd()" in src, f"{name} does not use the shared yaw PD"
    # No mode may still construct its yaw PD from literals.
    inline = re.findall(r'"yaw_pd":\s*PDController\(', src)
    assert not inline, f"{name} still builds its yaw PD from hardcoded gains"


@pytest.mark.parametrize("name", FOLLOW_MODULES)
def test_a_new_session_in_any_mode_picks_up_the_saved_tuning(cal, name):
    """Through each module's real state constructor, not the factory — the
    factory can be right while a module never calls it."""
    cal.save({"follow_yaw_kp": 18.0, "follow_yaw_deadband": 0.11})
    state = _make_state_for(name)
    assert state["yaw_pd"].kp == 18.0, f"{name} ignored the saved responsiveness"
    assert state["yaw_pd"].deadband == 0.11, f"{name} ignored the saved dead zone"


def test_all_five_modes_agree_on_the_yaw_pd_they_start_with(cal):
    """Before this, they agreed only by coincidence — five copies of the same
    literals, which is exactly the arrangement that had already let the follow
    modules drift apart elsewhere in this stack."""
    cal.save({"follow_yaw_kp": 27.0, "follow_yaw_kd": 3.6})
    gains = set()
    for name in FOLLOW_MODULES:
        pd = _make_state_for(name)["yaw_pd"]
        gains.add((pd.kp, pd.kd, pd.max_output, pd.deadband))
    assert len(gains) == 1, f"modes disagree on their starting yaw PD: {gains}"


# --------------------------------------------------------------------------- #
# The two panels that already had live sliders                                #
# --------------------------------------------------------------------------- #

def test_the_live_sliders_still_override_the_saved_tuning(cal):
    """Human Tracking keeps working exactly as it does now — that was the
    explicit requirement. The saved value is where the session STARTS."""
    from app.vision.modules.human_tracker import HumanTracker

    cal.save({"follow_yaw_kp": 20.0})
    t = HumanTracker.__new__(HumanTracker)
    t._client_state = {"s": _make_state_for("human_tracker")}
    assert t._client_state["s"]["yaw_pd"].kp == 20.0

    t.set_pd_params("s", kp=45.0, kd=6.0, max_output=50.0, deadband=0.03)
    assert t._client_state["s"]["yaw_pd"].kp == 45.0


def test_a_live_slider_override_is_not_persisted(cal):
    """A slider dragged mid-flight is an experiment. Writing it to the saved
    tuning would silently redefine every other mode's starting point from a
    control whose own panel calls it a per-session adjustment."""
    from app.vision.modules.human_tracker import HumanTracker

    before = cal.effective()["follow_yaw_kp"]
    t = HumanTracker.__new__(HumanTracker)
    t._client_state = {"s": _make_state_for("human_tracker")}
    t.set_pd_params("s", kp=45.0, kd=6.0, max_output=50.0, deadband=0.03)
    assert cal.effective()["follow_yaw_kp"] == before


def test_the_live_override_still_respects_the_yaw_rate_ceiling(cal):
    """The pre-existing clamp in set_pd_params, pinned because the Settings path
    now has its own and the two must not disagree."""
    from app.vision.modules.human_tracker import HumanTracker

    t = HumanTracker.__new__(HumanTracker)
    t._client_state = {"s": _make_state_for("human_tracker")}
    t.set_pd_params("s", kp=30.0, kd=4.0, max_output=300.0, deadband=0.05)
    assert t._client_state["s"]["yaw_pd"].max_output == 55.0

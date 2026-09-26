from app.telemetry.failsafe_check import evaluate, mission_max_alt

SAFE = {"NAV_DLL_ACT": 2, "COM_DL_LOSS_T": 10, "COM_OBL_RC_ACT": 5, "COM_OF_LOSS_T": 1.0, "RTL_RETURN_ALT": 30.0}


def test_sane_settings_pass_clean():
    assert evaluate(SAFE, 20.0) == ([], [])


def test_no_action_on_link_loss_blocks():
    block, _ = evaluate({**SAFE, "NAV_DLL_ACT": 0})
    assert block and "NAV_DLL_ACT = 0" in block[0]


def test_terminate_or_disarm_on_loss_blocks():
    assert evaluate({**SAFE, "NAV_DLL_ACT": 5})[0]
    assert evaluate({**SAFE, "COM_OBL_RC_ACT": 7})[0]


def test_weak_settings_warn_but_do_not_block():
    block, warn = evaluate({**SAFE, "COM_OF_LOSS_T": 0.2, "COM_DL_LOSS_T": 60, "RTL_RETURN_ALT": 10.0}, 25.0)
    assert not block and len(warn) == 3


def test_unreadable_params_warn_never_block():
    block, warn = evaluate({})
    assert not block and warn


def test_mission_max_alt():
    assert mission_max_alt([{"altitude": 10}, {"alt": 25.5}, {"lat": 1}]) == 25.5
    assert mission_max_alt(None) is None

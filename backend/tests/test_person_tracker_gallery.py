"""
PersonTracker gallery mode.

Structured around the distinction that a previous version of this module got
wrong: IDENTIFYING and FOLLOWING are separate jobs.

    _identify_all()   names every gallery member in frame. No lock involved.
    _choose_target()  picks which one to follow. The no-switching rule lives
                      here and ONLY here.

Applying the follow rule to identification meant that once one person was
locked, a second enrolled person standing beside them was never evaluated and
never named. test_identifies_two_people_simultaneously is the regression.

PersonTracker is built with __new__ to skip loading YOLO and InsightFace — the
logic under test is vector comparison and bookkeeping.
"""
import time

import numpy as np
import pytest

from app.vision.face_gallery import (
    DEFAULT_RELOCK_THRESHOLD, EMBED_DIM, EMBED_MODEL_NAME, FaceGallery, pack,
)
from app.vision.modules.person_tracker import (
    _ID_CONFIRM_NOW, _ID_MAX_VOTES, _ID_MEMORY_S, _ID_MIN_VOTES,
    _ID_VOTE_THRESHOLD, _SIGHTING_COOLDOWN_S,
    PersonTracker, _make_state,
)


def vec(*components: float) -> np.ndarray:
    v = np.zeros(EMBED_DIM, dtype=np.float32)
    v[: len(components)] = components
    n = np.linalg.norm(v)
    return v / n if n else v


class Face:
    """Stand-in for an InsightFace detection."""
    def __init__(self, embedding, bbox):
        self.embedding = embedding
        self.bbox = bbox


ALICE, BOB, CAROL = vec(1, 0), vec(0, 1), vec(0, 0, 1)

# Two well-separated body boxes, each with a face box inside it.
BODY_A = {"id": 1, "box": [100, 100, 300, 500], "cx_n": 0.2, "cy_n": 0.3}
BODY_B = {"id": 2, "box": [700, 100, 900, 500], "cx_n": 0.7, "cy_n": 0.3}
FACE_IN_A = [150, 120, 250, 220]
FACE_IN_B = [750, 120, 850, 220]
FACE_NOWHERE = [1500, 900, 1600, 1000]


def row(fid, pid, name, v):
    return (fid, pid, name, pack(v), EMBED_MODEL_NAME)


ROWS = (
    row("f1", "p-alice", "Alice", ALICE),
    row("f2", "p-bob", "Bob", BOB),
    row("f3", "p-carol", "Carol", CAROL),
)


_DEFAULT = object()


def tracker(*rows) -> PersonTracker:
    """No arguments uses the standard three-person gallery. Pass rows to
    override — including nothing at all via tracker(*[]) for an EMPTY gallery,
    which `rows or ROWS` previously turned back into the full one because an
    empty tuple is falsy."""
    t = PersonTracker.__new__(PersonTracker)
    chosen = ROWS if rows == () and rows is not _DEFAULT else rows
    t._gallery = FaceGallery().build(chosen)
    return t


def empty_tracker() -> PersonTracker:
    t = PersonTracker.__new__(PersonTracker)
    t._gallery = FaceGallery()          # built from nothing
    return t


def as_pairs(faces, owner=None):
    """Detection now yields (face, owner) pairs — the owning body box comes
    back with the face because faces are found by cropping each body.

    owner=None exercises the whole-frame FALLBACK path, where the body has to
    be located by containment. Tests that want the cropped path pass an owner
    explicitly."""
    return [(f, owner) for f in faces]


def identify_until_confirmed(t, faces, persons, state, rounds=_ID_MIN_VOTES):
    """Run enough face checks for votes to accumulate past the naming bar."""
    out = {}
    for _ in range(rounds):
        out = t._identify_all(as_pairs(faces), persons, state)
    return out


# --------------------------------------------------------------------------- #
# THE REGRESSION                                                                #
# --------------------------------------------------------------------------- #

def test_identifies_two_people_simultaneously():
    """
    The bug this replaces: with Alice locked, Bob was never evaluated and never
    named, because the follow rule was being applied to identification.
    """
    t = tracker()
    state = _make_state()
    state["locked_person_id"] = "p-alice"        # already committed to Alice

    ids = identify_until_confirmed(
        t, [Face(ALICE, FACE_IN_A), Face(BOB, FACE_IN_B)], [BODY_A, BODY_B], state
    )
    assert set(ids) == {1, 2}, "second enrolled person was not identified"
    assert ids[1]["name"] == "Alice"
    assert ids[2]["name"] == "Bob"


def test_three_people_all_named():
    t = tracker()
    state = _make_state()
    body_c = {"id": 3, "box": [1000, 100, 1200, 500], "cx_n": 0.9, "cy_n": 0.3}
    face_c = [1050, 120, 1150, 220]
    ids = identify_until_confirmed(
        t,
        [Face(ALICE, FACE_IN_A), Face(BOB, FACE_IN_B), Face(CAROL, face_c)],
        [BODY_A, BODY_B, body_c], state,
    )
    assert {e["name"] for e in ids.values()} == {"Alice", "Bob", "Carol"}


def test_identification_does_not_require_a_lock():
    """Naming must work with nothing committed at all."""
    t = tracker()
    state = _make_state()
    assert state["locked_person_id"] is None
    ids = identify_until_confirmed(t, [Face(BOB, FACE_IN_B)], [BODY_B], state)
    assert ids[2]["name"] == "Bob"


# --------------------------------------------------------------------------- #
# Reliability: voting                                                           #
# --------------------------------------------------------------------------- #

def test_a_marginal_match_needs_a_second_opinion():
    """A weak face check can misfire on a blurred or half-turned face, and a
    wrong name shown for one frame looks exactly like a real one — so marginal
    evidence must be corroborated before it is published."""
    t = tracker()
    state = _make_state()
    # The excess magnitude goes in a FOURTH dimension that no enrolled person
    # occupies. Putting it in dimension 2 or 3 would make the probe match Bob
    # or Carol instead of being a weak Alice — a mistake made twice already, so
    # the probe is verified below rather than assumed.
    weak = vec(1, 0, 0, 1.35)        # ~0.60 against Alice, ~0 against the rest
    top = t._gallery.match_all(weak, threshold=0.0, limit=3)
    assert top[0].name == "Alice", f"probe does not resemble Alice: {top}"
    assert _ID_VOTE_THRESHOLD <= top[0].similarity < _ID_CONFIRM_NOW, (
        f"probe must be above the vote bar but below instant confirmation, "
        f"got {top[0].similarity:.3f}"
    )

    first = t._identify_all(as_pairs([Face(weak, FACE_IN_A)]), [BODY_A], state)
    assert first == {}, "named on the strength of one marginal frame"
    second = t._identify_all(as_pairs([Face(weak, FACE_IN_A)]), [BODY_A], state)
    assert 1 in second and second[1]["name"] == "Alice"


def test_a_strong_unambiguous_match_confirms_immediately():
    """Latency matters: making a confident identification wait for a second
    frame is pure delay. Evidence far clear of any impostor does not need the
    guard the vote provides."""
    t = tracker()
    state = _make_state()
    ids = t._identify_all(as_pairs([Face(ALICE, FACE_IN_A)]), [BODY_A], state)
    assert 1 in ids, "a perfect match still waited for corroboration"
    assert ids[1]["name"] == "Alice"
    assert ids[1]["last_sim"] >= _ID_CONFIRM_NOW


def test_a_strong_match_with_a_thin_margin_still_waits():
    """The one case where fast confirmation would be wrong: a high score that
    two enrolled people both nearly produce."""
    t = tracker(
        row("f1", "p1", "Twin A", vec(1, 0.02)),
        row("f2", "p2", "Twin B", vec(1, -0.02)),
    )
    state = _make_state()
    assert t._identify_all(as_pairs([Face(vec(1, 0), FACE_IN_A)]), [BODY_A], state) == {}


def test_votes_accumulate_and_are_capped():
    """Uncapped votes make a long-visible person impossible to correct in
    reasonable time when the tracker swaps two IDs."""
    t = tracker()
    state = _make_state()
    for _ in range(_ID_MAX_VOTES + 6):
        t._identify_all(as_pairs([Face(ALICE, FACE_IN_A)]), [BODY_A], state)
    assert state["track_identities"][1]["votes"] == _ID_MAX_VOTES


def test_a_confirmed_identity_is_argued_down_not_overwritten():
    """One dissenting frame must not rename a confirmed person — it should cost
    a vote and require sustained disagreement to flip."""
    t = tracker()
    state = _make_state()
    for _ in range(_ID_MIN_VOTES + 2):
        t._identify_all(as_pairs([Face(ALICE, FACE_IN_A)]), [BODY_A], state)
    assert state["track_identities"][1]["name"] == "Alice"

    # A single frame claiming this track is Bob.
    t._identify_all(as_pairs([Face(BOB, FACE_IN_A)]), [BODY_A], state)
    assert state["track_identities"][1]["name"] == "Alice", "flipped on one frame"

    # Sustained disagreement eventually does flip it.
    for _ in range(_ID_MAX_VOTES + _ID_MIN_VOTES + 2):
        t._identify_all(as_pairs([Face(BOB, FACE_IN_A)]), [BODY_A], state)
    assert state["track_identities"][1]["name"] == "Bob"


def test_best_and_last_similarity_are_both_kept():
    """best_sim shows how good the identification ever got; last_sim is what
    the current frame supports. Reporting only one of them hides either a
    degrading view or a lucky single frame."""
    t = tracker()
    state = _make_state()
    t._identify_all(as_pairs([Face(ALICE, FACE_IN_A)]), [BODY_A], state)
    t._identify_all(as_pairs([Face(vec(1, 0.5), FACE_IN_A)]), [BODY_A], state)   # weaker
    e = state["track_identities"][1]
    assert e["best_sim"] > e["last_sim"]


# --------------------------------------------------------------------------- #
# Redundancy: persistence                                                       #
# --------------------------------------------------------------------------- #

def test_name_survives_frames_with_no_face_visible():
    """At any realistic drone standoff most frames have no usable face. Without
    this the label flickers on and off several times a second."""
    t = tracker()
    state = _make_state()
    identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)

    for _ in range(30):                       # face turned away
        ids = t._identify_all(as_pairs([]), [BODY_A], state)
    assert ids[1]["name"] == "Alice"


def test_name_survives_a_brief_disappearance():
    """Someone stepping behind a pillar and back out keeps their identity."""
    t = tracker()
    state = _make_state()
    identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)

    t._identify_all(as_pairs([]), [], state)            # gone from frame
    assert 1 in state["track_identities"], "identity dropped immediately"

    ids = t._identify_all(as_pairs([]), [BODY_A], state)   # back, no face visible
    assert ids[1]["name"] == "Alice"


def test_stale_identities_are_eventually_forgotten():
    """Otherwise the registry grows for the life of the session."""
    t = tracker()
    state = _make_state()
    identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)
    state["track_identities"][1]["last_seen"] -= _ID_MEMORY_S + 1
    t._identify_all(as_pairs([]), [], state)
    assert 1 not in state["track_identities"]


def test_only_confirmed_and_present_tracks_are_returned():
    t = tracker()
    state = _make_state()
    identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)
    # Present in the registry but not in frame this call.
    assert t._identify_all(as_pairs([]), [], state) == {}


# --------------------------------------------------------------------------- #
# Face-to-body association                                                      #
# --------------------------------------------------------------------------- #

def test_face_outside_every_body_box_is_ignored():
    """Without a containing body box there is no track to carry the identity,
    so the match cannot be followed or persisted."""
    t = tracker()
    state = _make_state()
    for _ in range(4):
        ids = t._identify_all(as_pairs([Face(ALICE, FACE_NOWHERE)]), [BODY_A], state)
    assert ids == {}


def test_each_face_attaches_to_its_own_body():
    """Two people must not both be labelled with whichever face was processed
    first."""
    t = tracker()
    state = _make_state()
    ids = identify_until_confirmed(
        t, [Face(BOB, FACE_IN_B), Face(ALICE, FACE_IN_A)], [BODY_A, BODY_B], state
    )
    assert ids[1]["name"] == "Alice"
    assert ids[2]["name"] == "Bob"


def test_unnormalised_embeddings_are_handled():
    """InsightFace returns un-normalised vectors; a raw dot product would scale
    similarity by magnitude and sail past any threshold."""
    t = tracker()
    state = _make_state()
    ids = identify_until_confirmed(
        t, [Face(ALICE * 47.0, FACE_IN_A)], [BODY_A], state
    )
    assert ids[1]["name"] == "Alice"
    assert ids[1]["last_sim"] == pytest.approx(1.0, abs=1e-5)


def test_empty_or_absent_gallery_identifies_nobody():
    absent = PersonTracker.__new__(PersonTracker)
    absent._gallery = None
    for t in (empty_tracker(), absent):
        state = _make_state()
        assert t._identify_all(as_pairs([Face(ALICE, FACE_IN_A)]), [BODY_A], state) == {}


# --------------------------------------------------------------------------- #
# Following: where the safety rules live                                        #
# --------------------------------------------------------------------------- #

def test_target_is_the_strongest_identification_when_uncommitted():
    t = tracker()
    state = _make_state()
    ids = identify_until_confirmed(
        t, [Face(vec(1, 0.4), FACE_IN_A), Face(BOB, FACE_IN_B)],
        [BODY_A, BODY_B], state,
    )
    tid, ident = t._choose_target(ids, [BODY_A, BODY_B], state)
    assert ident["name"] == "Bob"          # exact match beats the weaker one
    assert tid == 2


def test_a_different_person_cannot_steal_the_lock():
    """The rule that must survive: a drone silently switching which human it
    follows is the worst failure available. Bob is still NAMED — he just does
    not take the lock."""
    t = tracker()
    state = _make_state()
    state["locked_person_id"] = "p-alice"
    ids = identify_until_confirmed(
        t, [Face(ALICE, FACE_IN_A), Face(BOB, FACE_IN_B)], [BODY_A, BODY_B], state
    )
    tid, ident = t._choose_target(ids, [BODY_A, BODY_B], state)
    assert ident["person_id"] == "p-alice"
    assert 2 in ids, "Bob should still be identified even though he cannot be followed"


def test_locked_person_absent_yields_no_target_even_with_others_present():
    t = tracker()
    state = _make_state()
    state["locked_person_id"] = "p-carol"          # not in frame
    ids = identify_until_confirmed(
        t, [Face(ALICE, FACE_IN_A), Face(BOB, FACE_IN_B)], [BODY_A, BODY_B], state
    )
    tid, ident = t._choose_target(ids, [BODY_A, BODY_B], state)
    assert (tid, ident) == (None, None)
    assert len(ids) == 2, "the others are still named"


def test_reacquisition_after_a_loss_needs_the_stricter_bar():
    """A held lock does not re-prove itself every frame, but re-acquiring after
    a loss is unsupervised and must clear the higher threshold."""
    t = tracker(row("f1", "p-alice", "Alice", ALICE))
    state = _make_state()
    state["locked_person_id"] = "p-alice"

    # A mediocre view: above the vote threshold, below the relock bar.
    weakish = vec(float(np.cos(np.arccos(0.52))), float(np.sin(np.arccos(0.52))))
    ids = identify_until_confirmed(t, [Face(weakish, FACE_IN_A)], [BODY_A], state)
    assert ids[1]["name"] == "Alice", "should still be NAMED"
    assert ids[1]["last_sim"] < DEFAULT_RELOCK_THRESHOLD

    state["frames_lost"] = 0
    assert t._choose_target(ids, [BODY_A], state)[1] is not None   # held lock

    state["frames_lost"] = 40
    assert t._choose_target(ids, [BODY_A], state)[1] is None       # re-acquiring


def test_no_identities_means_no_target():
    t = tracker()
    assert t._choose_target({}, [], _make_state()) == (None, None)


# --------------------------------------------------------------------------- #
# Sighting log                                                                  #
# --------------------------------------------------------------------------- #

class _Match:
    person_id, name, similarity = "p-alice", "Alice", 0.87


def test_sighting_is_rate_limited():
    """The face check runs every few frames; unthrottled this would write
    several rows a second and bury the interesting transitions."""
    t = tracker()
    state = _make_state()
    pending: list = []

    t._queue_sighting(state, "s", _Match(), BODY_A, pending)
    assert len(pending) == 1
    assert pending[0]["table"] == "person_sighting"
    assert pending[0]["person_name"] == "Alice"
    assert pending[0]["track_id"] == 1

    t._queue_sighting(state, "s", _Match(), BODY_A, pending)
    assert len(pending) == 1

    state["last_sighting_t"] -= _SIGHTING_COOLDOWN_S + 1
    t._queue_sighting(state, "s", _Match(), BODY_A, pending)
    assert len(pending) == 2


def test_sighting_row_carries_no_position_of_its_own():
    """lat/lng/alt are attached downstream in stream_track, where the telemetry
    manager is reachable — the same split plate_event rows use."""
    t = tracker()
    pending: list = []
    t._queue_sighting(_make_state(), "s", _Match(), BODY_A, pending)
    assert "lat" not in pending[0]
    assert "session_id" not in pending[0]


# --------------------------------------------------------------------------- #
# Defaults                                                                      #
# --------------------------------------------------------------------------- #

def test_gallery_mode_is_off_by_default():
    """With it off this module behaves exactly as it did before — the existing
    reference-photo workflow is untouched."""
    state = _make_state()
    assert state["gallery_mode"] is False
    assert state["locked_person_id"] is None
    assert state["track_identities"] == {}


# --------------------------------------------------------------------------- #
# Lock release — the second regression                                          #
# --------------------------------------------------------------------------- #
#
# An earlier version held the lock forever: once one person was acquired, the
# tracker followed nobody else for the rest of the session, even after the
# original walked out of frame. A lock with no release is not a safety
# feature — the aircraft ends up committed to somebody who is not there.

from app.vision.modules.person_tracker import _LOCK_RELEASE_S, _MANUAL_LOCK_HOLD_S


def _lock_onto(t, state, faces, bodies, person_id):
    identify_until_confirmed(t, faces, bodies, state)
    state["locked_person_id"] = person_id
    state["locked_last_seen_t"] = time.monotonic()


def test_lock_releases_once_the_locked_person_is_gone():
    """THE REGRESSION. japesh locked, japesh leaves, Madhu present — the drone
    must end up following Madhu rather than nobody, forever."""
    t = tracker()
    state = _make_state()
    _lock_onto(t, state, [Face(ALICE, FACE_IN_A)], [BODY_A], "p-alice")

    # Alice gone, Bob now in frame.
    ids = identify_until_confirmed(t, [Face(BOB, FACE_IN_B)], [BODY_B], state)
    state["locked_last_seen_t"] -= _LOCK_RELEASE_S + 0.5      # absent long enough

    tid, ident = t._choose_target(ids, [BODY_B], state)
    assert ident is not None, "lock never released — stuck on an absent person"
    assert ident["name"] == "Bob"
    assert state["locked_person_id"] is None or state["lock_manual"] is False


def test_lock_is_held_briefly_before_releasing():
    """A missed face check or a one-second occlusion must not hand the drone to
    whoever else happens to be visible."""
    t = tracker()
    state = _make_state()
    _lock_onto(t, state, [Face(ALICE, FACE_IN_A)], [BODY_A], "p-alice")

    ids = identify_until_confirmed(t, [Face(BOB, FACE_IN_B)], [BODY_B], state)
    state["locked_last_seen_t"] -= 1.0                        # well inside the window

    tid, ident = t._choose_target(ids, [BODY_B], state)
    assert ident is None, "switched away during a brief absence"
    assert state["locked_person_id"] == "p-alice", "lock dropped too early"


def test_present_locked_person_still_cannot_be_displaced():
    """Release-on-absence must not weaken the rule that matters: while the
    locked person IS there, nobody else takes the lock."""
    t = tracker()
    state = _make_state()
    _lock_onto(t, state, [Face(ALICE, FACE_IN_A)], [BODY_A], "p-alice")

    ids = identify_until_confirmed(
        t, [Face(ALICE, FACE_IN_A), Face(BOB, FACE_IN_B)], [BODY_A, BODY_B], state
    )
    state["locked_last_seen_t"] -= _LOCK_RELEASE_S + 5        # irrelevant: present
    tid, ident = t._choose_target(ids, [BODY_A, BODY_B], state)
    assert ident["person_id"] == "p-alice"


def test_seeing_the_locked_person_refreshes_the_hold():
    t = tracker()
    state = _make_state()
    _lock_onto(t, state, [Face(ALICE, FACE_IN_A)], [BODY_A], "p-alice")
    state["locked_last_seen_t"] -= 2.0

    ids = identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)
    before = state["locked_last_seen_t"]
    t._choose_target(ids, [BODY_A], state)
    assert state["locked_last_seen_t"] > before, "hold window not refreshed"


def test_camera_pans_across_several_people_in_turn():
    """The operational case: people entering and leaving frame as the drone
    moves. Each should be picked up in turn without a session restart."""
    t = tracker()
    state = _make_state()
    seen = []
    for emb, face_box, body in (
        (ALICE, FACE_IN_A, BODY_A),
        (BOB, FACE_IN_B, BODY_B),
        (CAROL, FACE_IN_A, {**BODY_A, "id": 5}),
    ):
        ids = identify_until_confirmed(t, [Face(emb, face_box)], [body], state)
        # Whoever was locked before has now been off-screen a while.
        if state.get("locked_last_seen_t"):
            state["locked_last_seen_t"] -= _LOCK_RELEASE_S + 0.5
        tid, ident = t._choose_target(ids, [body], state)
        if ident:
            state["locked_person_id"] = ident["person_id"]
            state["locked_person_name"] = ident["name"]
            seen.append(ident["name"])
    assert seen == ["Alice", "Bob", "Carol"], f"did not follow each in turn: {seen}"


# --------------------------------------------------------------------------- #
# Operator selection                                                            #
# --------------------------------------------------------------------------- #

def test_operator_request_wins_over_the_strongest_match():
    """A deliberate human choice outranks the tracker's own preference."""
    t = tracker()
    state = _make_state()
    t._client_state = {"s": state}
    t.request_follow("s", "p-alice")

    # Bob scores higher, but Alice was asked for.
    ids = identify_until_confirmed(
        t, [Face(vec(1, 0.4), FACE_IN_A), Face(BOB, FACE_IN_B)],
        [BODY_A, BODY_B], state,
    )
    tid, ident = t._choose_target(ids, [BODY_A, BODY_B], state)
    assert ident["person_id"] == "p-alice"
    assert state["lock_manual"] is True


def test_manual_lock_is_held_far_longer_than_an_automatic_one():
    """The system quietly overriding a deliberate choice is not an
    improvement."""
    assert _MANUAL_LOCK_HOLD_S > _LOCK_RELEASE_S

    t = tracker()
    state = _make_state()
    t._client_state = {"s": state}
    t.request_follow("s", "p-alice")
    ids = identify_until_confirmed(t, [Face(ALICE, FACE_IN_A)], [BODY_A], state)
    t._choose_target(ids, [BODY_A], state)
    state["locked_person_id"] = "p-alice"

    # Absent for longer than an automatic lock would tolerate.
    ids2 = identify_until_confirmed(t, [Face(BOB, FACE_IN_B)], [BODY_B], state)
    state["locked_last_seen_t"] -= _LOCK_RELEASE_S + 2
    assert t._choose_target(ids2, [BODY_B], state)[1] is None, "manual lock gave way early"

    # ...but not forever.
    state["locked_last_seen_t"] -= _MANUAL_LOCK_HOLD_S
    assert t._choose_target(ids2, [BODY_B], state)[1] is not None


def test_releasing_restores_automatic_selection():
    t = tracker()
    state = _make_state()
    t._client_state = {"s": state}
    state["locked_person_id"] = "p-alice"
    state["lock_manual"] = True

    t.request_follow("s", None)
    assert state["locked_person_id"] is None
    assert state["lock_manual"] is False

    ids = identify_until_confirmed(t, [Face(BOB, FACE_IN_B)], [BODY_B], state)
    assert t._choose_target(ids, [BODY_B], state)[1]["name"] == "Bob"


def test_requesting_a_person_drops_the_current_lock_immediately():
    """Otherwise rule 1 would block the request while the old target is still
    on screen."""
    t = tracker()
    state = _make_state()
    t._client_state = {"s": state}
    state["locked_person_id"] = "p-bob"
    t.request_follow("s", "p-alice")
    assert state["locked_person_id"] is None
    assert state["follow_request_person_id"] == "p-alice"


# --------------------------------------------------------------------------- #
# Crop-based face detection                                                     #
# --------------------------------------------------------------------------- #
#
# Faces are found by cropping each body box at native resolution instead of
# shrinking the whole frame. Doubles effective face pixels (recognition is
# resolution-starved at any real standoff) and hands back the owning body, so
# no containment search is needed.

class _FakeFace:
    def __init__(self, bbox):
        self.bbox = np.array(bbox, dtype=np.float32)
        self.embedding = ALICE.copy()
        self.det_score = 0.9


def _crop_tracker(found_per_crop):
    """A tracker whose face_app records the crops it was handed."""
    t = tracker()
    t.calls = []

    class _App:
        def get(self, crop):
            t.calls.append(crop.shape)
            # A face 10px in from the crop's own origin.
            return [_FakeFace([10, 10, 60, 60])] if found_per_crop else []

    t.face_app = _App()
    t._FACE_DET_WIDTH = 960
    return t


def test_crops_each_body_and_returns_its_owner():
    t = _crop_tracker(True)
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    pairs = t._detect_faces_on_bodies(frame, [BODY_A, BODY_B])

    assert len(pairs) == 2
    assert len(t.calls) == 2, "should crop once per body"
    owners = {owner["id"] for _f, owner in pairs}
    assert owners == {1, 2}, "owner must come back with the face, not be searched for"


def test_face_boxes_are_returned_in_full_frame_coordinates():
    """Everything downstream — overlay, association, logging — speaks
    full-frame coordinates. A crop-relative box would draw in the wrong place
    and match against the wrong body."""
    t = _crop_tracker(True)
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    (face, owner), = t._detect_faces_on_bodies(frame, [BODY_B])

    x1, y1, x2, y2 = BODY_B["box"]
    # The crop starts left/above the body box because of the padding, so the
    # face must land inside the padded region and well right of frame origin.
    assert face.bbox[0] > 500, f"box not offset back to full frame: {face.bbox}"
    assert face.bbox[0] < x2 and face.bbox[1] < y2


def test_crop_count_is_capped():
    """Cost is ~3.8ms per crop, so the worst case has to be bounded."""
    from app.vision.modules.person_tracker import _FACE_CROP_MAX_BODIES
    t = _crop_tracker(True)
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    many = [{"id": i, "box": [i * 60, 100, i * 60 + 200, 600],
             "cx_n": 0.1, "cy_n": 0.3} for i in range(1, 12)]
    t._detect_faces_on_bodies(frame, many)
    assert len(t.calls) == _FACE_CROP_MAX_BODIES


def test_bodies_too_small_to_hold_a_face_are_skipped():
    """No point paying for a crop that cannot contain a recognisable face."""
    t = _crop_tracker(True)
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    tiny = {"id": 9, "box": [100, 100, 115, 130], "cx_n": 0.1, "cy_n": 0.1}
    assert t._detect_faces_on_bodies(frame, [tiny]) == []
    assert t.calls == []


def test_no_bodies_falls_back_to_the_whole_frame():
    """Before the body tracker settles there are no boxes to crop, and
    recognition must not be blocked waiting for them."""
    t = _crop_tracker(True)
    called = {"whole": False}

    def fake_whole(frame):
        called["whole"] = True
        return [_FakeFace([10, 10, 60, 60])]

    t._detect_faces = fake_whole
    pairs = t._detect_faces_on_bodies(np.zeros((1080, 1920, 3), np.uint8), [])
    assert called["whole"] is True
    assert pairs and pairs[0][1] is None, "fallback has no owner to attach"


def test_a_crop_with_no_face_contributes_nothing():
    t = _crop_tracker(False)
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    assert t._detect_faces_on_bodies(frame, [BODY_A, BODY_B]) == []
    assert len(t.calls) == 2, "still attempted both crops"


def test_a_failing_crop_does_not_abort_the_others():
    """One bad crop must not cost the whole frame's recognition."""
    t = tracker()
    seen = []

    class _App:
        def get(self, crop):
            seen.append(crop.shape)
            if len(seen) == 1:
                raise RuntimeError("simulated ONNX failure")
            return [_FakeFace([10, 10, 60, 60])]

    t.face_app = _App()
    pairs = t._detect_faces_on_bodies(
        np.zeros((1080, 1920, 3), np.uint8), [BODY_A, BODY_B]
    )
    assert len(seen) == 2
    assert len(pairs) == 1


def test_identify_all_uses_the_supplied_owner_without_searching():
    """The cropped path gives the owner directly. A face whose box falls
    OUTSIDE its owner still associates correctly, which the containment search
    could never do — and happens whenever a body box clips a leaning head."""
    t = tracker()
    state = _make_state()
    outside_face = Face(ALICE, FACE_NOWHERE)     # nowhere near BODY_A
    for _ in range(_ID_MIN_VOTES):
        ids = t._identify_all([(outside_face, BODY_A)], [BODY_A], state)
    assert ids[1]["name"] == "Alice"


# --------------------------------------------------------------------------- #
# A manual pick outranks auto-identification                                    #
# --------------------------------------------------------------------------- #

def test_follow_track_marks_the_lock_manual_and_clears_the_identity():
    """Tapping somebody is a deliberate choice about WHO, so it must not leave
    an identity lock behind that a later face match could resurrect."""
    from app.vision.modules.person_tracker import PersonTracker, _make_state
    t = PersonTracker.__new__(PersonTracker)
    t._client_state = {"s": _make_state()}
    st = t._client_state["s"]
    st["locked_person_id"] = "someone-else"
    t.follow_track("s", 7)
    assert st["target_track_id"] == 7
    assert st["lock_manual"] is True
    assert st["locked_person_id"] is None


def test_turning_on_identify_does_not_steal_a_manual_target():
    """
    THE BUG: enabling auto-identify handed the aircraft to whoever scored best
    in the gallery, abandoning the person the operator had tapped. The drone
    silently switching which human it chases is the worst failure this module
    can produce.

    Checked structurally — the real path needs YOLO and InsightFace — but the
    precedence is what matters: identify still runs, it just no longer picks.
    """
    import inspect
    from app.vision.modules.person_tracker import PersonTracker
    src = inspect.getsource(PersonTracker._analyze_frame_blocking)
    assert "manual_held" in src, "manual-lock precedence is gone"
    i_manual = src.index("manual_held")
    i_choose = src.index("self._choose_target(")
    assert i_manual < i_choose, (
        "_choose_target runs before the manual hold is checked — it will "
        "overwrite the operator's target again"
    )

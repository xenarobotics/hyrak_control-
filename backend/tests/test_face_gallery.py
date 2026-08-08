"""
Face gallery matcher.

Pure vector logic — no InsightFace, no database — so these run in
milliseconds and cover the decisions that would otherwise only show up as a
drone following the wrong person.
"""
import math
import os

import numpy as np
import pytest

from app.vision.face_gallery import (
    DEFAULT_MATCH_THRESHOLD, DEFAULT_RELOCK_THRESHOLD, EMBED_DIM, EMBED_MODEL_NAME,
    FaceGallery, discover_folder, pack, unpack,
)

SAMPLES = "/home/japesh/hyrak_control/sample human faces/photos"


def vec(*components: float) -> np.ndarray:
    """A unit vector in the first few dimensions, zero-padded to 512."""
    v = np.zeros(EMBED_DIM, dtype=np.float32)
    v[: len(components)] = components
    n = np.linalg.norm(v)
    return v / n if n else v


def row(face_id, person_id, name, v, model=EMBED_MODEL_NAME):
    return (face_id, person_id, name, pack(v), model)


# --------------------------------------------------------------------------- #
# Packing                                                                       #
# --------------------------------------------------------------------------- #

def test_embedding_round_trips_exactly():
    """float32 bytes, not JSON — the vector must come back bit-identical."""
    v = vec(0.3, -0.5, 0.81, 0.02)
    assert np.array_equal(unpack(pack(v)), v)
    assert len(pack(v)) == EMBED_DIM * 4 == 2048


# --------------------------------------------------------------------------- #
# Index construction                                                            #
# --------------------------------------------------------------------------- #

def test_empty_gallery_matches_nobody_without_raising():
    g = FaceGallery()
    assert g.is_empty()
    assert g.size == 0
    assert g.match(vec(1, 0)) is None
    assert g.match_all(vec(1, 0)) == []
    assert g.margin(vec(1, 0)) is None


def test_embeddings_from_another_model_are_excluded_not_compared():
    """buffalo_sc and buffalo_l are both 512-dim, so mixing them raises
    nothing and produces confident nonsense. Dropping is the safe direction."""
    g = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0)),
        row("f2", "p2", "Bob", vec(0, 1), model="buffalo_l"),
    ])
    assert g.size == 1
    assert g.person_count == 1
    assert g.skipped_wrong_model == 1
    assert g.match(vec(0, 1), threshold=0.9) is None   # Bob is simply absent


def test_malformed_rows_are_skipped():
    short = np.ones(64, dtype=np.float32)
    zero = np.zeros(EMBED_DIM, dtype=np.float32)
    g = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0)),
        ("f2", "p2", "Bob", pack(short), EMBED_MODEL_NAME),
        ("f3", "p3", "Carol", pack(zero), EMBED_MODEL_NAME),
    ])
    assert g.size == 1
    assert g.skipped_wrong_model == 2


def test_unnormalised_stored_vectors_are_renormalised():
    """A vector stored before normalisation was enforced would otherwise
    scale every similarity it participates in."""
    g = FaceGallery().build([("f1", "p1", "Alice",
                              pack(vec(1, 0) * 7.0), EMBED_MODEL_NAME)])
    m = g.match(vec(1, 0), threshold=0.0)
    assert m.similarity == pytest.approx(1.0, abs=1e-5)


# --------------------------------------------------------------------------- #
# Matching                                                                      #
# --------------------------------------------------------------------------- #

def test_identical_vector_scores_one_orthogonal_scores_zero():
    g = FaceGallery().build([row("f1", "p1", "Alice", vec(1, 0))])
    assert g.match(vec(1, 0), threshold=0.0).similarity == pytest.approx(1.0, abs=1e-5)
    assert g.match(vec(0, 1), threshold=0.0).similarity == pytest.approx(0.0, abs=1e-5)


def test_threshold_withholds_a_weak_match():
    g = FaceGallery().build([row("f1", "p1", "Alice", vec(1, 0))])
    probe = vec(1, 1)                       # 45 deg away -> cos = 0.707
    assert g.match(probe, threshold=0.6).name == "Alice"
    assert g.match(probe, threshold=0.8) is None


def test_best_face_per_person_never_the_mean():
    """
    The central design claim. Alice is enrolled from two genuinely different
    appearances 90 deg apart. Their MEAN sits at 45 deg from each, so a
    centroid would score a perfect probe of either pose at only ~0.707 —
    losing to a rival who happens to sit closer to the centroid. Taking the
    best face keeps the real 1.0.
    """
    g = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0)),
        row("f2", "p1", "Alice", vec(0, 1)),
        row("f3", "p2", "Bob", vec(1, 1)),      # exactly Alice's centroid
    ])
    m = g.match(vec(1, 0), threshold=0.0)
    assert m.name == "Alice"
    assert m.similarity == pytest.approx(1.0, abs=1e-5)

    # One entry per person even though Alice has two faces.
    everyone = g.match_all(vec(1, 0), threshold=0.0, limit=10)
    assert [x.name for x in everyone].count("Alice") == 1
    # A centroid-based gallery would have ranked Bob (0.707) above Alice.
    assert everyone[0].name == "Alice"


def test_match_all_is_sorted_and_limited():
    g = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0)),
        row("f2", "p2", "Bob", vec(0.9, 0.1)),
        row("f3", "p3", "Carol", vec(0.5, 0.5)),
    ])
    out = g.match_all(vec(1, 0), threshold=0.0, limit=2)
    assert len(out) == 2
    assert out[0].similarity >= out[1].similarity
    assert out[0].name == "Alice"


def test_margin_exposes_two_people_the_gallery_cannot_separate():
    """A high top score with a thin margin means the match should not be
    trusted — invisible to a caller that only sees the winner."""
    near = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0.02)),
        row("f2", "p2", "Bob", vec(1, -0.02)),
    ])
    assert near.margin(vec(1, 0)) < 0.01

    far = FaceGallery().build([
        row("f1", "p1", "Alice", vec(1, 0)),
        row("f2", "p2", "Bob", vec(0, 1)),
    ])
    assert far.margin(vec(1, 0)) > 0.9

    # Only one person enrolled -> no margin to report, not a fabricated one.
    solo = FaceGallery().build([row("f1", "p1", "Alice", vec(1, 0))])
    assert solo.margin(vec(1, 0)) is None


def test_relock_bar_is_stricter_than_first_match():
    """Re-acquisition is unsupervised and its failure mode is a drone
    following a stranger, so it must demand more than the initial lock."""
    assert DEFAULT_RELOCK_THRESHOLD > DEFAULT_MATCH_THRESHOLD

    g = FaceGallery().build([row("f1", "p1", "Alice", vec(1, 0))])
    probe = vec(math.cos(math.radians(56)), math.sin(math.radians(56)))  # ~0.559
    assert g.match(probe, threshold=DEFAULT_MATCH_THRESHOLD) is not None
    assert g.match(probe, threshold=DEFAULT_RELOCK_THRESHOLD) is None


def test_garbage_probes_return_nothing():
    g = FaceGallery().build([row("f1", "p1", "Alice", vec(1, 0))])
    assert g.match(None) is None
    assert g.match(np.zeros(EMBED_DIM, dtype=np.float32)) is None
    assert g.match(np.ones(10, dtype=np.float32)) is None


# --------------------------------------------------------------------------- #
# Folder discovery                                                              #
# --------------------------------------------------------------------------- #

def test_missing_folder_is_empty_not_an_error():
    assert discover_folder("/nonexistent/path/xyz") == {}


@pytest.mark.skipif(not os.path.isdir(SAMPLES), reason="sample faces not present")
def test_reads_the_provided_sample_layout_unchanged():
    """photos/<name>/*.jpg needs no reshuffling — the directory name is the
    person's name."""
    found = discover_folder(SAMPLES)
    assert set(found) == {"srikar", "Madhu", "japesh"}
    assert sum(len(v) for v in found.values()) == 9
    for name, paths in found.items():
        assert paths, f"{name} has no images"
        for p in paths:
            assert os.path.isfile(p)

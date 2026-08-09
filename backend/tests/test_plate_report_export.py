"""
The exported vehicle log.

A session's rows are only useful if a reviewer can separate the plate three
frames agreed on at 210px from the one a single frame guessed at 40px. Both
are legitimate rows — refusing the weak one loses data that is often the only
look a passing vehicle ever gave — so the separation has to live in a column
rather than in whether the row exists.
"""
import pytest

from app.api.routes import _plate_grade


def row(**kw) -> dict:
    base = {
        "plate_text": "TS09EA0001", "plate_px_w": 120,
        "ocr_confidence": 0.85, "plate_votes": 2,
    }
    base.update(kw)
    return base


def test_a_big_confident_agreed_read_is_strong():
    assert _plate_grade(row(plate_px_w=210, ocr_confidence=0.88, plate_votes=3)) == "strong"


def test_a_single_frame_read_is_never_strong():
    """Agreement is the one thing a model cannot fake by being confident."""
    assert _plate_grade(row(plate_px_w=300, ocr_confidence=0.99, plate_votes=1)) == "weak"


def test_confidence_alone_does_not_carry_a_small_crop():
    """A model can be certain about characters that are not in the crop."""
    assert _plate_grade(row(plate_px_w=42, ocr_confidence=0.99, plate_votes=3)) == "weak"


def test_a_decent_agreed_read_grades_good():
    assert _plate_grade(row(plate_px_w=80, ocr_confidence=0.55, plate_votes=2)) == "good"


def test_a_row_with_no_plate_has_no_grade():
    """Blank, not "weak". Most vehicles never turn a readable plate toward an
    aircraft, and their rows are still worth having for type, colour, speed
    and position — grading them as bad readings would misrepresent that."""
    assert _plate_grade(row(plate_text="", plate_px_w=0, plate_votes=0)) == ""
    assert _plate_grade(row(plate_text="   ")) == ""


def test_rows_written_before_the_columns_existed_do_not_crash():
    """Older rows predate plate_votes entirely, so the field is absent rather
    than zero. An export that raised on them would refuse to produce a report
    for every session flown before this change."""
    assert _plate_grade({"plate_text": "TS09EA0001"}) == "weak"
    assert _plate_grade({"plate_text": "AB01CD2345", "plate_px_w": None,
                         "ocr_confidence": None, "plate_votes": None}) == "weak"


@pytest.mark.parametrize("grade", ["strong", "good", "weak"])
def test_every_grade_is_one_sortable_word(grade):
    """The whole point is a column a reviewer can filter a few hundred rows
    on, so it must never become a sentence."""
    assert " " not in grade and grade.islower()

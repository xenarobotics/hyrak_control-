"""Audit B20: the probe's file I/O stays off the loop and stats() reads a
bounded tail of the log, never the whole file."""
import json

from app import latency_probe as lp


def _write(path, n, extra=""):
    with open(path, "w") as fh:
        for i in range(n):
            fh.write(json.dumps({"path": "tracker", "frame_to_motion_ms": float(i)}) + extra + "\n")


def test_tail_read_is_capped_and_drops_the_partial_first_line(tmp_path):
    f = tmp_path / "probe.jsonl"
    _write(f, 2000)
    size = f.stat().st_size
    rows = lp._read_tail_rows(f, max_bytes=size // 4)
    assert 0 < len(rows) < 2000
    # Every row parsed: no half record from the seek landing mid-line.
    assert all("path" in r for r in rows)
    # Newest records are the ones kept.
    assert rows[-1]["frame_to_motion_ms"] == 1999.0
    assert lp._read_tail_rows(f, max_bytes=size * 2) == lp._read_tail_rows(f, max_bytes=size)


def test_tail_read_missing_file(tmp_path):
    assert lp._read_tail_rows(tmp_path / "nope.jsonl") == []


async def test_stats_async_summarises_the_tail(tmp_path, monkeypatch):
    f = tmp_path / "probe.jsonl"
    _write(f, 10)
    monkeypatch.setattr(lp, "_LOG_PATH", f)
    out = await lp.stats_async()
    assert out["records"] == 10
    assert out["paths"]["tracker"]["frame_to_motion_ms"]["max"] == 9.0
    assert lp.stats()["records"] == 10


def test_append_record_creates_the_directory(tmp_path, monkeypatch):
    f = tmp_path / "deep" / "probe.jsonl"
    monkeypatch.setattr(lp, "_LOG_PATH", f)
    lp._append_record({"path": "avoidance"})
    assert json.loads(f.read_text().strip())["path"] == "avoidance"

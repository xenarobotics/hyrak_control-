"""
Shared ByteTrack config used by HumanTracker and PersonTracker.
"""
import os
import tempfile


def make_bytetrack_cfg(prefix: str) -> str:
    """
    Write a ByteTrack config with track_buffer=90 (~3s at 30fps) to a
    cross-platform temp file. Using a temp file avoids Windows path issues
    that arise with package-relative paths.
    """
    yaml = (
        "tracker_type: bytetrack\n"
        "track_high_thresh: 0.5\n"
        "track_low_thresh: 0.1\n"
        "new_track_thresh: 0.6\n"
        "track_buffer: 90\n"
        "match_thresh: 0.8\n"
        "fuse_score: false\n"
    )
    fd, path = tempfile.mkstemp(suffix=".yaml", prefix=prefix)
    with os.fdopen(fd, "w") as f:
        f.write(yaml)
    return path

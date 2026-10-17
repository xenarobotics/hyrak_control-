"""A bounded "ids seen this session" set with an exact unique count.

plate_tracker and traffic_manager counted unique vehicles and people with a
plain set of ByteTrack ids. ByteTrack ids are never reused within a session,
so over a long flight at a busy junction the set only ever grows (audit
V19). What the modules need from it is two things: "is this id new?" (for
the unique count and the per-type tally) and "how many unique so far?".
Both survive forgetting OLD ids: a track id that aged out of the window
cannot come back, so forgetting it cannot double-count it.

`len()` is the TOTAL number of distinct ids ever added, not the number
currently remembered, so the existing `len(state["ids_seen"])` readouts keep
their meaning.
"""
from __future__ import annotations

from collections import deque
from typing import Hashable, Iterable


class RecentIds:
    __slots__ = ("_recent", "_set", "_total")

    def __init__(self, maxlen: int = 4096, items: Iterable[Hashable] = ()):
        self._recent: deque = deque(maxlen=max(1, int(maxlen)))
        self._set: set = set()
        self._total = 0
        for x in items:
            self.add(x)

    def add(self, item: Hashable) -> bool:
        """Remember `item`; True when it was not already remembered."""
        if item in self._set:
            return False
        if len(self._recent) == self._recent.maxlen:
            self._set.discard(self._recent[0])
        self._recent.append(item)
        self._set.add(item)
        self._total += 1
        return True

    def __contains__(self, item: Hashable) -> bool:
        return item in self._set

    def __len__(self) -> int:
        """Unique ids ever added (the session total), not the window size."""
        return self._total

    @property
    def remembered(self) -> int:
        return len(self._set)

    @property
    def maxlen(self) -> int:
        return self._recent.maxlen or 0

    def __repr__(self) -> str:
        return f"RecentIds(total={self._total}, remembered={len(self._set)}, maxlen={self.maxlen})"

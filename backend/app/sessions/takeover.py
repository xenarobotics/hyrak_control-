"""
Staff takeover of a customer's flight (docs/ACCESS_MODEL.md 8b "Takeover").

HYRAK operations can take control of a session's drone when something looks
wrong. Two levels, both from the console's watch view and both needing the
`sessions.takeover` permission on the watched session's workspace (founders,
and managers of that workspace):

  * Quick actions: hold, return and land, sent straight to the session's
    drone through the session's own drone_action path (red-zone checks,
    action_result), without taking control.
  * Full takeover: `takeover_session` puts the session in TAKEOVER mode.
    The customer's command events are refused with `taken_over` (their
    hold / return / land too: staff own the decision while they hold
    control) and the session's AI follow stops steering. Staff command
    events that name `target_session` are routed to that drone.
    `release_session` hands control back. If the staff socket drops, the
    takeover is released after RELEASE_GRACE_S unless that staff session
    comes back in time; the drone keeps whatever mode it is in (no
    auto-land).

This module only keeps the state (dependency-free, like observer.py, so the
guard, the vision pipeline and the routes can all read it). The socket
handlers in app/events/admin_events.py do the checks, the audit rows and
the notifications.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

# How long a takeover outlives its staff socket. Long enough for a browser
# reconnect (the socket ping timeout is ~5 s), short enough that a customer
# is not locked out for long by a staff member who closed the tab.
RELEASE_GRACE_S = 15.0


@dataclass
class Takeover:
    target_session_id: str
    staff_session_id: str
    user_id: str
    username: str
    workspace_id: Optional[str]
    since: float = field(default_factory=time.time)
    release_task: Optional[asyncio.Task] = field(default=None, repr=False, compare=False)

    def public(self) -> dict:
        return {"by": self.username, "user_id": self.user_id,
                "staff_session_id": self.staff_session_id, "since": self.since}


# target session id -> its takeover
_by_target: dict[str, Takeover] = {}


def holder(target_session_id: Optional[str]) -> Optional[Takeover]:
    if not target_session_id:
        return None
    return _by_target.get(target_session_id)


def is_taken_over(target_session_id: Optional[str]) -> bool:
    return holder(target_session_id) is not None


def held_by(staff_session_id: str) -> list[Takeover]:
    return [t for t in _by_target.values() if t.staff_session_id == staff_session_id]


def start(target_session_id: str, staff_session_id: str, *, user_id: str, username: str,
          workspace_id: Optional[str]) -> Takeover:
    """Take control (or keep it: the same staff session asking again just
    cancels a pending release). The caller has checked the permission and
    that no OTHER staff session holds it."""
    current = _by_target.get(target_session_id)
    if current is not None and current.staff_session_id == staff_session_id:
        cancel_release(current)
        return current
    t = Takeover(target_session_id, staff_session_id, user_id, username, workspace_id)
    _by_target[target_session_id] = t
    return t


def release(target_session_id: str) -> Optional[Takeover]:
    t = _by_target.pop(target_session_id, None)
    if t is not None:
        cancel_release(t)
    return t


def cancel_release(t: Takeover) -> None:
    task = t.release_task
    t.release_task = None
    if task is not None and not task.done() and task is not asyncio.current_task():
        task.cancel()


def schedule_release(staff_session_id: str,
                     on_release: Callable[[Takeover], Awaitable[None]],
                     grace_s: Optional[float] = None) -> list[Takeover]:
    """The staff socket dropped: release each takeover it holds after the
    grace period, unless the staff session comes back (cancel_pending)."""
    delay = RELEASE_GRACE_S if grace_s is None else grace_s
    out = []
    for t in held_by(staff_session_id):
        if t.release_task is not None and not t.release_task.done():
            continue

        async def _later(t=t):
            await asyncio.sleep(delay)
            if _by_target.get(t.target_session_id) is t:
                t.release_task = None
                release(t.target_session_id)
                await on_release(t)
        t.release_task = asyncio.ensure_future(_later())
        out.append(t)
    return out


def cancel_pending(staff_session_id: str) -> int:
    """The staff session is back: keep its takeovers."""
    n = 0
    for t in held_by(staff_session_id):
        if t.release_task is not None:
            cancel_release(t)
            n += 1
    return n


def reset_for_tests() -> None:
    for t in list(_by_target.values()):
        cancel_release(t)
    _by_target.clear()

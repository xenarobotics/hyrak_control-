"""
Sensor calibration, driven by what the autopilot actually says.

WHY THIS IS A PARSER AND NOT A PROGRESS BAR.

MAVSDK's calibration plugin returns a stream of ProgressData - a percentage and
a cooked status line - and stopping there gets you a bar that fills up while the
operator has no idea which way to turn the aircraft. QGroundControl does not do
that, and the reason is that the useful information is not the percentage. It is
WHICH SIDE PX4 IS STILL WAITING FOR, which side it has just recognised, and
which are finished. All three are in PX4's own STATUSTEXT stream, as stable
strings this ground station is already subscribed to for the message log.

So the plugin DRIVES the calibration and delivers the verdict, and these raw
lines drive the picture. That split matters: the verdict must come from the
plugin because a STATUSTEXT can be dropped by a lossy radio and a calibration
reported as finished when it was not is worse than no report at all - while a
dropped side-transition only makes the animation late, and the next line
re-states the whole pending set anyway.

PX4 emits these from calibration_messages.h / calibration_routines.cpp. Matched
loosely - lowercased, prefix-tested, tolerant of extra words - because the exact
wording has changed between PX4 releases more than once and a parser that only
works on the version it was written against is a parser that will silently stop
animating one firmware update from now. Anything unrecognised still reaches the
operator as the autopilot's own words rather than being swallowed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

#: The six accelerometer orientations, in the order PX4's own
#: detect_orientation_str lists them. The UI shows them in this order, so a
#: rebuild that re-sorts them would silently renumber the operator's
#: instructions.
SIDES = ("down", "up", "left", "right", "front", "back")

#: What each side means to somebody holding an aircraft, since "back" and
#: "front" describe which face points DOWN and read backwards to most people
#: the first time. These are the words on screen.
SIDE_INSTRUCTIONS = {
    "down": "Set the aircraft down level, the way it sits on the ground",
    "up":   "Turn it upside down and hold it steady",
    "left": "Rest it on its LEFT side",
    "right": "Rest it on its RIGHT side",
    "front": "Stand it on its NOSE, tail up",
    "back":  "Stand it on its TAIL, nose up",
}

#: MAVSDK plugin method per sensor, and whether the sensor has six sides to
#: work through. One table, so the socket layer, the manager and the UI cannot
#: disagree about which sensors exist.
#: `timeout` is a CEILING, not an expectation - the whole point is that a
#: calibration which never ends is REPORTED rather than left spinning. PX4 can
#: stop streaming without a verdict (a routine that aborted internally, a
#: dropped final STATUSTEXT), and the operator has no way to tell that apart
#: from one still working. The operator-paced ones get minutes because the
#: aircraft spends most of that time in a human's hands.
SENSORS = {
    "gyro":  {"method": "calibrate_gyro",        "label": "Gyroscope",       "oriented": False, "timeout": 90.0},
    "accel": {"method": "calibrate_accelerometer", "label": "Accelerometer", "oriented": True,  "timeout": 420.0},
    "mag":   {"method": "calibrate_magnetometer", "label": "Compass",        "oriented": True,  "timeout": 420.0},
    "level": {"method": "calibrate_level_horizon", "label": "Level Horizon", "oriented": False, "timeout": 90.0},
    "gimbal": {"method": "calibrate_gimbal_accelerometer", "label": "Gimbal Accel", "oriented": False, "timeout": 90.0},
}

#: PX4 refuses a level-horizon calibration whose starting attitude is already
#: off by more than this, and says so only as a failure minutes later. Checked
#: up front instead, because "put it on something actually flat" is advice the
#: operator can act on before they have wasted the attempt.
LEVEL_MAX_TILT_DEG = 5.0

#: How PX4 names each sensor inside its own messages, mapped back to our key.
#: "calibration started: 2 mag" has to land on the same session the operator
#: started, or the UI animates the wrong sensor.
_PX4_SENSOR_NAMES = {
    "gyro": "gyro", "accel": "accel", "mag": "mag", "level": "level",
    "baro": "baro", "airspeed": "airspeed",
}

_PREFIX = "[cal]"
_PROGRESS_RE = re.compile(r"progress\s*<\s*(\d+)\s*>")
_STARTED_RE = re.compile(r"calibration started:\s*\d*\s*(\w+)")
_DONE_RE = re.compile(r"calibration done:?\s*(\w+)?")
_FAILED_RE = re.compile(r"calibration failed:?\s*(.*)")
_PENDING_RE = re.compile(r"pending:\s*(.+)")
_ORIENTATION_RE = re.compile(r"(\w+)\s+orientation detected")
_SIDE_DONE_RE = re.compile(r"(\w+)\s+side done")


@dataclass
class CalEvent:
    """One recognised line. `kind` is what happened; the rest is its payload."""
    kind: str                      # started|progress|pending|orientation|side_done
                                   # |done|failed|cancelled|instruction
    sensor: Optional[str] = None
    side: Optional[str] = None
    sides: tuple = ()
    progress: Optional[int] = None
    text: str = ""


def parse_cal_line(raw: str) -> Optional[CalEvent]:
    """One STATUSTEXT line to an event, or None if it is not calibration."""
    if not raw:
        return None
    text = raw.strip()
    low = text.lower()
    if not low.startswith(_PREFIX):
        return None
    body = low[len(_PREFIX):].strip()
    said = text[len(_PREFIX):].strip() if text[:len(_PREFIX)].lower() == _PREFIX else text

    # ORDER MATTERS. "calibration done" and "side done" both contain "done",
    # and "calibration failed: mag" would match the started pattern's \w+ if
    # tested loosely, so the specific forms are tested before the general ones.
    m = _STARTED_RE.search(body)
    if m:
        return CalEvent("started", sensor=_PX4_SENSOR_NAMES.get(m.group(1)), text=said)

    m = _FAILED_RE.search(body)
    if m:
        return CalEvent("failed", text=m.group(1).strip() or said)

    if "calibration cancelled" in body or "calibration canceled" in body:
        return CalEvent("cancelled", text=said)

    m = _DONE_RE.search(body)
    if m:
        return CalEvent("done", sensor=_PX4_SENSOR_NAMES.get(m.group(1) or ""), text=said)

    m = _PROGRESS_RE.search(body)
    if m:
        return CalEvent("progress", progress=max(0, min(100, int(m.group(1)))), text=said)

    m = _PENDING_RE.search(body)
    if m:
        sides = tuple(s for s in m.group(1).replace(",", " ").split() if s in SIDES)
        return CalEvent("pending", sides=sides, text=said)

    m = _ORIENTATION_RE.search(body)
    if m and m.group(1) in SIDES:
        return CalEvent("orientation", side=m.group(1), text=said)

    m = _SIDE_DONE_RE.search(body)
    if m and m.group(1) in SIDES:
        return CalEvent("side_done", side=m.group(1), text=said)

    # Recognised as calibration, not as anything specific. Passed through
    # rather than dropped: "hold vehicle still on a pending side" and "rotate
    # vehicle around the detected orientation" are the two most useful
    # sentences PX4 says, and neither has a structured form.
    return CalEvent("instruction", text=said)


#: Side states, and what each means on screen.
PENDING, ACTIVE, DONE = "pending", "active", "done"


@dataclass
class CalState:
    """Everything the operator's screen needs, in one object.

    Sent whole on every change rather than as deltas. A calibration is a
    handful of events over half a minute - there is nothing to save by
    diffing, and a UI rebuilt from a full state cannot drift out of step with
    the aircraft the way one accumulating patches can.
    """
    sensor: str = ""
    phase: str = "idle"       # idle|starting|running|done|failed|cancelled
    progress: int = 0
    #: side -> pending|active|done. Empty for sensors with no orientations.
    sides: dict = field(default_factory=dict)
    #: What to do NOW, in words an operator can act on without knowing PX4.
    instruction: str = ""
    #: The autopilot's own last line, kept beside our translation of it so a
    #: wording change we failed to parse is still visible rather than hidden.
    detail: str = ""
    #: Set only once the plugin returns. None while running.
    ok: Optional[bool] = None
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "sensor": self.sensor,
            "label": SENSORS.get(self.sensor, {}).get("label", self.sensor),
            "phase": self.phase,
            "progress": self.progress,
            "sides": dict(self.sides),
            "side_order": list(SIDES),
            "instruction": self.instruction,
            "detail": self.detail,
            "ok": self.ok,
            "error": self.error,
            "active_side": next(
                (s for s, v in self.sides.items() if v == ACTIVE), None
            ),
        }


class CalibrationSession:
    """One calibration, from Start to a verdict.

    Holds no aircraft handles and does no I/O - it is fed lines and asked for
    state, which is what makes the whole of PX4's calibration protocol testable
    without a vehicle.
    """

    def __init__(self, sensor: str):
        self.state = CalState(sensor=sensor, phase="starting")
        oriented = SENSORS.get(sensor, {}).get("oriented", False)
        if oriented:
            # Every side starts pending. PX4 will send its own pending list on
            # the first message, but until then the screen has to show
            # something true, and "all six still to do" is true.
            self.state.sides = {s: PENDING for s in SIDES}
        self.state.instruction = self._opening_instruction(sensor)

    @staticmethod
    def _opening_instruction(sensor: str) -> str:
        if sensor == "gyro":
            return "Set the aircraft down and leave it completely still"
        if sensor == "level":
            return "Place the aircraft exactly level - this sets what 'level' means to the autopilot"
        if sensor == "accel":
            return "You will be asked for six positions in turn. Hold each one still until it is marked done"
        if sensor == "mag":
            return "You will rotate the aircraft around each position PX4 asks for"
        if sensor == "gimbal":
            return "Hold the gimbal still and level"
        return "Follow the instructions from the autopilot"

    def feed(self, raw: str) -> bool:
        """Apply one STATUSTEXT line. Returns True if the state changed."""
        ev = parse_cal_line(raw)
        if ev is None:
            return False
        s = self.state
        s.detail = ev.text

        if ev.kind == "started":
            s.phase = "running"
            # A sensor name from PX4 supersedes ours only when we have none -
            # the operator pressed a specific button and the screen must not
            # start animating a different sensor because a message was
            # mis-parsed.
            if ev.sensor and not s.sensor:
                s.sensor = ev.sensor
            return True

        if ev.kind == "progress":
            s.phase = "running"
            # NEVER GOES BACKWARDS. PX4 restarts its count per side on some
            # firmwares, and a bar that jumps back to 12% reads as a failure
            # the operator then interrupts.
            s.progress = max(s.progress, ev.progress or 0)
            return True

        if ev.kind == "pending":
            s.phase = "running"
            for side in SIDES:
                if side in ev.sides:
                    # Only demote a side that is not already finished: the
                    # pending list is re-sent during a side, and treating it as
                    # authoritative would un-complete work already done.
                    if s.sides.get(side) != DONE:
                        s.sides[side] = PENDING
                elif side in s.sides and s.sides[side] != ACTIVE:
                    s.sides[side] = DONE
            s.instruction = self._pending_instruction()
            return True

        if ev.kind == "orientation":
            s.phase = "running"
            for side in list(s.sides):
                if s.sides[side] == ACTIVE:
                    s.sides[side] = PENDING
            s.sides[ev.side] = ACTIVE
            s.instruction = (
                f"Holding {ev.side.upper()} - keep it still"
                if s.sensor != "mag"
                else f"Rotate the aircraft around the {ev.side.upper()} axis"
            )
            return True

        if ev.kind == "side_done":
            s.phase = "running"
            s.sides[ev.side] = DONE
            s.instruction = self._pending_instruction()
            return True

        if ev.kind == "done":
            s.phase = "done"
            s.progress = 100
            for side in list(s.sides):
                s.sides[side] = DONE
            s.instruction = "Calibration complete"
            return True

        if ev.kind == "failed":
            s.phase = "failed"
            s.error = ev.text
            s.instruction = "Calibration failed - see the autopilot's reason below"
            return True

        if ev.kind == "cancelled":
            s.phase = "cancelled"
            s.instruction = "Calibration cancelled"
            return True

        # instruction
        s.instruction = ev.text
        return True

    def _pending_instruction(self) -> str:
        remaining = [s for s in SIDES if self.state.sides.get(s) == PENDING]
        if not remaining:
            return "Finishing…"
        nxt = remaining[0]
        more = f" ({len(remaining)} left)" if len(remaining) > 1 else " (last one)"
        return SIDE_INSTRUCTIONS.get(nxt, f"Rotate to {nxt}") + more

    def finish(self, ok: bool, error: str = "") -> None:
        """The plugin's verdict, which is the one that counts.

        A calibration can end without a `calibration done` STATUSTEXT ever
        arriving - the radio drops it, or the firmware simply does not send one
        for that sensor. Left to the text alone the screen would sit at 90%
        forever on a calibration that had actually succeeded.
        """
        self.state.ok = ok
        if ok:
            self.state.phase = "done"
            self.state.progress = 100
            for side in list(self.state.sides):
                self.state.sides[side] = DONE
            self.state.instruction = "Calibration complete"
        elif self.state.phase not in ("failed", "cancelled"):
            self.state.phase = "failed"
            self.state.error = error or self.state.error
            self.state.instruction = "Calibration failed"

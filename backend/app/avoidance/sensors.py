"""Declared sensor inventory + live "is it actually sending data" check.

A checkbox that a ToF is fitted is worthless if the ToF is not publishing -
that is worse than knowing you have nothing. So each declared sensor carries a
last-data timestamp that the telemetry layer stamps when a reading for that
source arrives; status() reports OK only while data is fresh.

In-memory for now (per running server); persistence moves to the DB with the
Settings UI. Monocular is implicit and always present - it is the video feed.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

# Sensor kinds and their default trust. Monocular is assist-grade on purpose:
# scale-ambiguous, blind to thin obstacles - it must never outvote a real
# range sensor.
SENSOR_KINDS = ("monocular", "depth", "tof", "rangefinder", "lidar")
DEFAULT_CONFIDENCE = {
    "monocular": 0.4, "depth": 0.9, "tof": 0.85, "rangefinder": 0.8, "lidar": 0.9,
}
FRESH_S = 3.0  # a sensor silent longer than this reads as NO DATA


@dataclass
class SensorSpec:
    kind: str
    mount: str = "forward"        # forward | down | 360 | ...
    max_range_m: float = 12.0
    fov_deg: float = 60.0
    enabled: bool = True
    last_data_t: float = 0.0

    def confidence(self) -> float:
        return DEFAULT_CONFIDENCE.get(self.kind, 0.5)


@dataclass
class _DroneSensors:
    specs: dict[str, SensorSpec] = field(default_factory=dict)


_by_drone: dict[str, _DroneSensors] = {}


def set_inventory(drone_id: str, specs: list[dict]) -> list[dict]:
    """Replace a drone's declared sensor set. Unknown kinds are dropped."""
    ds = _by_drone.setdefault(drone_id, _DroneSensors())
    keep = {}
    for s in specs:
        kind = str(s.get("kind", "")).lower()
        if kind not in SENSOR_KINDS:
            continue
        prev = ds.specs.get(kind)
        keep[kind] = SensorSpec(
            kind=kind,
            mount=str(s.get("mount", "forward")),
            max_range_m=float(s.get("max_range_m", 12.0)),
            fov_deg=float(s.get("fov_deg", 60.0)),
            enabled=bool(s.get("enabled", True)),
            last_data_t=prev.last_data_t if prev else 0.0,
        )
    ds.specs = keep
    return inventory(drone_id)


def mark_data(drone_id: str, source: str) -> None:
    """Stamp that a reading from `source` arrived - called by whatever ingests
    the sensor stream (telemetry parser, the /observe route). Auto-registers a
    source not explicitly declared, so a plugged-in sensor shows up live."""
    ds = _by_drone.setdefault(drone_id, _DroneSensors())
    spec = ds.specs.get(source)
    if spec is None and source in SENSOR_KINDS:
        spec = ds.specs[source] = SensorSpec(kind=source)
    if spec is not None:
        spec.last_data_t = time.monotonic()


def confidence_for(drone_id: str, source: str) -> float:
    ds = _by_drone.get(drone_id)
    if ds and source in ds.specs:
        return ds.specs[source].confidence()
    return DEFAULT_CONFIDENCE.get(source, 0.5)


def inventory(drone_id: str, now: float | None = None) -> list[dict]:
    """Declared sensors with a live OK / NO_DATA status."""
    now = now if now is not None else time.monotonic()
    ds = _by_drone.get(drone_id)
    if not ds:
        return []
    out = []
    for spec in ds.specs.values():
        has_data = spec.last_data_t > 0 and (now - spec.last_data_t) <= FRESH_S
        out.append({
            "kind": spec.kind, "mount": spec.mount,
            "max_range_m": spec.max_range_m, "fov_deg": spec.fov_deg,
            "enabled": spec.enabled, "confidence": spec.confidence(),
            "status": "ok" if has_data else "no_data",
        })
    return out


def reset(drone_id: str | None = None) -> None:
    if drone_id is None:
        _by_drone.clear()
    else:
        _by_drone.pop(drone_id, None)

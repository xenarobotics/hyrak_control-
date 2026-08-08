# Module: backend-telemetry

Paths: `backend/app/telemetry/`, `backend/app/events/telemetry_events.py`

## Purpose

Make a drone attached to a **remote client's** machine look local to MAVSDK, and
expose its telemetry and commands over socket.io.

## Responsibilities

- Bridge relayed MAVLink bytes into a loopback UDP socket `mavsdk_server` reads.
- Manage one `TelemetryManager` (and one `mavsdk_server`) per session.
- Hand off cleanly when two sessions contend for the same drone address.
- Publish telemetry snapshots and drive the flight recorder, zone monitor, and
  admin observers.
- **Guarantee a terminal status on every connect failure** (ADR-007).

## Files

| File | Role |
|---|---|
| `manager.py` | `TelemetryManager` — MAVSDK `System`, connect, rates, missions, actions |
| `serial_bridge.py` | `SerialBridge` — relayed bytes ⇄ loopback UDP for mavsdk |
| `rf_bridge.py` | wfb-ng RF link on fixed split ports (14550 down / 14551 up) where `udpin://`'s reply-to-sender trick can't reach |
| `gs_relay.py` | Ground-station relay helper |
| `../events/telemetry_events.py` | All socket.io handlers |

## Dependencies

`mavsdk` (spawns `mavsdk_server`), `pyserial`, `asyncio` datagram transports,
`app.flights.recorder`, `app.zones.monitor`, `app.sessions.observer`.

## Configuration

`config.py`: `mavsdk_server_host` (`localhost`), `mavsdk_server_port` (50051 —
**a default, not what is used**; see below), `default_baud_rate` (57600).

## Load-bearing details — do not change casually

- **Every `System()` must own a unique gRPC port.** MAVSDK-Python defaults all
  instances to 50051; with multiple drones only the first `mavsdk_server` binds
  it and every later `System` silently connects to that *same* server — the
  "arm one drone, all show armed" bug. `_find_free_port()` exists for this.
- **Connect timeouts**: 10s around `self._drone.connect(...)` and 15s around the
  heartbeat wait. Both were added after real infinite hangs — the gRPC handshake
  had no timeout at all, and a listening-but-silent link hung the heartbeat wait
  forever.
- **Serial rate profile**: a 57600-baud half-duplex radio cannot take the
  UDP/SITL telemetry rates; saturating it caused intermittent "Socket closed"
  disconnects that QGroundControl never shows. `_set_rates()` branches on
  `serial://`.
- **Stale-server kill is scoped to the endpoint**, so connecting one drone does
  not blow away another session's live telemetry.
- **Graceful takeover**: `find_other_telemetry_session` stops the other session,
  detaches, closes its bridge, ends its flight, and tells that client why.

## Known issues

- Remaining `sio.emit("error", ...)` sites elsewhere are unaudited for the
  ADR-007 defect class.
- One `mavsdk_server` process per session — memory/PID pressure scales with
  concurrent operators. **Unmeasured.**
- `connect_browser_serial` serves both the Web Serial radio **and** the SITL
  relay, so its name understates its role.

## Future improvements

- Audit and normalise all failure emissions to `telemetry_status`.
- Measure and document concurrent-session limits.

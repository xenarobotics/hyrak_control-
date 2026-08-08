# backend-telemetry — API

## socket.io events consumed

| Event | Payload | Notes |
|---|---|---|
| `connect_telemetry` | `{address}` | Default `udp://:14540`; `udp://:N` is auto-rewritten to `udpin://0.0.0.0:N` |
| `connect_browser_serial` | `{}` | Web Serial radio **and** the SITL relay both use this |
| `connect_rf_bridge` | `{downlinkPort=14550, uplinkPort=14551}` | wfb-ng split ports; delegates to `connect_telemetry` |
| `serial_uplink` | `bytes` | Relayed MAVLink from the client. Silently dropped if no session or no bridge |
| `disconnect_telemetry` | — | Stops telemetry, closes bridge, ends flight, drops zone monitor |
| `drone_command` | `{...}` | Ignored unless `session.mode == MANUAL_CONTROL` |
| `drone_action`, `swarm_group_action` | `{action, ...}` | Command routing |

## socket.io events emitted

| Event | Payload |
|---|---|
| `telemetry_status` | `{status: 'connected'\|'disconnected'\|'error', message?}` |
| `telemetry_update` | Snapshot dict |
| `serial_downlink` | `bytes` — mavsdk → client → radio/SITL |
| `drone_mission_loaded` | `{waypoints}` |
| `admin_telemetry` | Mirrored to `/admin` observers watching the session |

**Contract (ADR-007):** the client sets `connecting` on request and **only
`telemetry_status` can exit that state.** Every failure path must emit one —
including wrapped exceptions. Emitting the generic `error` event alone is not a
valid way to end a connect attempt.

## `SerialBridge` (`serial_bridge.py`)

```python
class SerialBridge(asyncio.DatagramProtocol):
    @classmethod
    async def create(cls, sio, socket_id: str) -> "SerialBridge"
    @property
    def address(self) -> str          # "udpin://127.0.0.1:{mavsdk_port}"
    def uplink(self, data: bytes) -> None
    def datagram_received(self, data: bytes, addr) -> None
    def close(self) -> None

# module-level registry, keyed by session_id
register_bridge(session_id, bridge)
get_bridge(session_id) -> Optional[SerialBridge]
close_bridge(session_id)
```

Mechanics: the bridge binds its own ephemeral loopback socket; `mavsdk_server`
listens on `mavsdk_port` (a separate free port). `uplink()` sends to
`mavsdk_port`; mavsdk's replies come back to the bridge's socket and
`datagram_received` emits them as `serial_downlink`. One bridge per session.

## `TelemetryManager` (`manager.py`)

```python
TelemetryManager(on_update: Callable[[dict], None])

async def connect(self, address: str = "udpin://0.0.0.0:14540",
                  kill_stale: bool = True) -> bool
```

Sequence: rewrite legacy `udp://:N`; kill stale `mavsdk_server`s **scoped to
this endpoint**; allocate a **unique** gRPC port via `_find_free_port()`;
`System(port=...)`; `await asyncio.wait_for(connect(...), timeout=10.0)`;
`await asyncio.wait_for(_wait_for_heartbeat(), timeout=15.0)`. Returns `False`
on `asyncio.TimeoutError` or any exception — it does not raise.

Other members: `_set_rates()` (per-call 2s timeouts; lower profile for
`serial://`), mission download (10s), `_wait_for_mission_mode`, arm (10s).

## Connect flow convergence

```
connect_telemetry ─────────────┐
connect_browser_serial ─────────┼──► on_connect_telemetry(sid, {address})
connect_rf_bridge ─────────────┘         │
                                          ├─ close own bridge if address changed
                                          ├─ graceful takeover of another session
                                          ├─ TelemetryManager.connect(address)
                                          └─ emit telemetry_status
```

`on_connect_browser_serial` then verifies `session.drone_address == bridge.address`
and closes the bridge if the connect failed.

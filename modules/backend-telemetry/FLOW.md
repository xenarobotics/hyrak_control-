# backend-telemetry — data flow

## The relay chain (this is the whole module in one diagram)

```
CLIENT MACHINE                          │  SERVER
                                        │
 radio (Web Serial)                     │
   or SITL :14540 (udp bridge)          │
   or wfb-ng RF                         │
        │                               │
        │  raw MAVLink bytes            │
        ▼                               │
  socket.io 'serial_uplink' ────────────┼──► on_serial_uplink(sid, data)
                                        │        │ get_bridge(session_id)
                                        │        ▼
                                        │   SerialBridge.uplink(bytes)
                                        │        │ sendto 127.0.0.1:mavsdk_port
                                        │        ▼
                                        │   mavsdk_server  ◄── unique gRPC port!
                                        │        │
                                        │        ▼
                                        │   TelemetryManager (System)
                                        │        │ on_update(snapshot)
                                        │        ├──► 'telemetry_update' → client
                                        │        ├──► flights.recorder.on_snapshot
                                        │        ├──► zones.monitor.on_snapshot
                                        │        └──► 'admin_telemetry' → observers
                                        │
  bridge.send(...) ◄── 'serial_downlink'┼──◄ SerialBridge.datagram_received
        │                               │      (mavsdk's commands/mission/params)
        ▼                               │
 radio / SITL / RF                      │
```

`SerialBridge` is the trick that makes the cloud model work: MAVSDK believes it
has a local UDP link, while the actual hardware is on someone else's machine.

## Connect sequence and where it can stall

```
client: setTelemetryStatus('connecting')      ◄── ONLY telemetry_status exits this
   │
   ├─ (SITL) bridge.start('udp', ...) binds 14540
   │     └─ bind succeeds even if SITL sends nothing  ◄── the silent-success trap
   ├─ subscribe to bridge events → 'serial_uplink'
   ├─ socket.on('serial_downlink')
   └─ emit 'connect_browser_serial'
         │
         ▼ SERVER
      session lookup ─── none ──► emit telemetry_status ERROR   (was: `error`, unhandled → HUNG)
         │
      SerialBridge.create() ─── raises ──► emit telemetry_status ERROR  (was: swallowed → HUNG)
         │
      register_bridge()   ◄── before the await, so concurrent serial_uplink works
         │                     (python-socketio async_handlers=True → handlers run concurrently)
         │
      on_connect_telemetry(address)
         ├─ mavsdk gRPC handshake ....... wait_for 10s
         ├─ first heartbeat ............. wait_for 15s
         └─ emit telemetry_status connected | error
```

Client-side, a **specific** 8s silence diagnostic fires first if the port bound
but no SITL bytes arrived, naming WSL2/Docker/VM as the likely cause — it is
cancelled by the udp bridge's `receiving:true` event. That beats waiting ~25s
for a generic mavsdk timeout.

## Session teardown

```
disconnect_telemetry  /  socket disconnect
   ├─ TelemetryManager.stop()
   ├─ serial_bridge.close_bridge(session_id)
   ├─ flights.recorder.end_flight(session_id)
   ├─ zones.monitor.drop(session_id)
   ├─ clear zone_lock, hardware_uid, drone, telemetry_connected
   └─ emit telemetry_status disconnected
```

## Graceful takeover (two sessions, one drone address)

```
find_other_telemetry_session(session_id, address)
   ├─ other_tel.stop()
   ├─ detach_telemetry(other_session_id)
   ├─ close_bridge(other_session_id)
   ├─ recorder.end_flight(other_session_id)
   └─ emit telemetry_status disconnected
        "Disconnected — another client connected to this drone"
```

Without this, the new connect's stale-`mavsdk_server` kill would blow away the
other session's live telemetry, which surfaced as random gRPC "Socket closed"
errors.

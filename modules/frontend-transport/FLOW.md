# frontend-transport — data flow

## Link selection (`DeviceSelector.tsx` → `useDrone`)

```
source string in DeviceSelector
   ├─ 'radio-N'      ──► connectBrowserSerial(port)   Web Serial
   ├─ 'local-relay'  ──► connectLocalRelay(url)       wfb-ng via loopback WS agent
   └─ 'sitl'         ──► connectRemoteSitl()          native udp bridge
                          └─ desktop only: sitlNeedsDesktop gates the button
```

All three converge server-side on `on_connect_telemetry`.

## SITL connect state machine

```
connectRemoteSitl()
   │ setTelemetryStatus('connecting')      ◄── exits ONLY on telemetry_status
   │ setSitlSilenceHandler(...)
   ▼
startRemoteSitlRelay(14540)
   │
   ├─ bridge.start('udp', 'remote-sitl', {ports:[{tag:0, port:14540}]})
   │     ├─ !ok && EADDRINUSE ──► throw "close QGroundControl / other GCS"
   │     └─ !ok               ──► throw bind error
   │                                  └─► caught → error + 'disconnected'
   │
   ├─ setTimeout(8s) ──► onSilence(...)  "bound but SITL sent nothing;
   │                        │              WSL/Docker/VM? firewall?"
   │                        └─► error + 'error' + stopRemoteSitlRelay()
   │
   ├─ bridge.onEvent:
   │     status{receiving:true} ──► clearTimeout(silenceTimer)   ◄── the cancel
   │     data                   ──► socket.emit('serial_uplink', event.data)
   │
   ├─ socket.on('serial_downlink') ──► bridge.send('udp', id, bytes, {tag:0})
   │
   └─ socket.emit('connect_browser_serial', {})
            │
            ▼ (server: bridge, mavsdk, 10s + 15s timeouts)
      'telemetry_status' connected | error ──► onTelStatus ──► store
      'error' (generic) ─────────────────────► onServerError ──► store  ◄── added
```

Two independent safety nets now exist: the **specific** 8s client-side silence
message, and the **guaranteed** server-side terminal status. Before, neither
existed and the UI could hang indefinitely.

## Video source selection

```
Settings → VideoGroup ChipGroup ──► setVideoSource() ──► localStorage
                                          │
        ┌─────────────────────────────────┴─────────────────────────┐
        ▼                                                           ▼
VideoStream.tsx (after mount, never in initial state)        useWebRTC offer
  isServerSourced = src in (air_unit_udp, siyi_rtsp)           videoSource: src
  isRaw = mode==='manual-control' && !isServerSourced           clientOverlay: ...
        │                                                           │
  srcObject = isRaw ? localStream : remoteStream                    ▼
                                                            server branches
```

`isRaw` is the existing local-preview fast path: for `manual-control` the
browser renders its own `getUserMedia` stream directly, bypassing the
encode→server→decode round trip that was causing jitter versus a native camera
app. **This is the branch the planned `air_unit_srt` canvas preview extends.**

## Air-unit video bridge (current, Linux only)

```
Fly device panel  ─┐
                   ├─► useAirUnitVideoBridge (shared AIR_UNIT_BRIDGE_ID)
Settings → Video  ─┘        │
                            ├─ start() → bridge.start('air-unit-video', {port, device, mode:'auto'})
                            └─ onEvent → status
                                  connected      → msg = meta.note
                                  !connected+log → meta.error ?? "ffmpeg exited (code N)"

then: /dev/video10 appears as a webcam ──► getUserMedia ──► WebRTC uplink
```

Planned replacement (ADR-004): encoded H.265 over IPC → `VideoDecoder` →
`VideoFrame` → canvas, with SRT carrying the upstream copy. No virtual camera,
no browser encode.

## Hydration rule

```
❌ useState(() => getVideoSource())   // server render has no localStorage → mismatch
✅ useState(false); useEffect(() => setX(getVideoSource()), [])
```

Applies to every `localStorage`-backed preference rendered on first paint.

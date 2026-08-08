# desktop-bridges — data flow

## Process boundary

```
┌──────────── MAIN (Node.js, NOT sandboxed) ────────────┐
│  dgram sockets · serialport · ffmpeg child processes   │
│  bridges/registry.ts ← kind string                    │
└───────────────────────┬───────────────────────────────┘
                        │ ipcMain.handle / webContents.send
                        │   'hyrak-bridge-start|stop|send|list'
                        │   'hyrak-bridge-event'
┌───────────────────────▼───────────────────────────────┐
│  PRELOAD  contextBridge → window.hyrakNative           │
└───────────────────────┬───────────────────────────────┘
┌───────────────────────▼───────────────────────────────┐
│  RENDERER (Chromium — a browser tab's restrictions)    │
│  frontend/src/lib/nativeBridge.ts → relays/hooks       │
└───────────────────────────────────────────────────────┘
```

**This split is the whole point.** "The browser can't do UDP" and "the desktop
app reads UDP" are both true: the socket is in main, and only bytes or frames
cross IPC.

## `udp` bridge — SITL telemetry

```
PX4 SITL (mavlink -u 14580 -m onboard -o 14540)
   │  UDP → :14540
   ▼
udpBridge socket bound 0.0.0.0:14540
   │  remembers rinfo as `peer` (the reply target)
   ├─ first packet only ──► status {receiving:true, from}
   └─ every packet ──────► data {tag, port}
        │ IPC
        ▼
remoteSitlRelay.ts ──► socket.io 'serial_uplink' ──► SERVER SerialBridge
                                                        │ loopback UDP
                                                        ▼
                                                   mavsdk_server
```

Reverse: server `serial_downlink` → `onNativeDownlink` →
`bridge.send('udp', id, bytes, {tag:0})` → `socket.send(..., peer.port,
peer.address)` → PX4.

**Failure mode fixed in 0.1.4:** binding `127.0.0.1` silently dropped every
packet not sent to loopback, so SITL in WSL2/Docker/VM produced a successful
bind and zero bytes, forever. Verified:

```
bind 127.0.0.1 received: [via-loopback]
bind 0.0.0.0   received: [via-loopback, via-lan]
```

The swarm path is identical with 10 tagged ports (14541+).

## `air-unit-video` bridge — video

```
air unit ──RTP/H.265──► wfb_rx ──► 127.0.0.1:5600
                                      │
                        SDP file in os.tmpdir() tells ffmpeg the payload type
                                      ▼
                        vaapiRenderNode() probes /dev/dri/renderD*
                                      │
                    ┌─────────────────┴─────────────────┐
                    │ node found → launch(node)         │
                    │   exits <4s? → launch(null) ──────┼─► software
                    └─────────────────┬─────────────────┘
                                      ▼
                    ffmpeg decode ──► /dev/video10 (v4l2loopback)
                                      │
                    RENDERER getUserMedia sees a "webcam"
                                      │
                    browser ENCODES ──► WebRTC uplink ──► server
```

The two boxed transcodes (decode + encode) on the client are what the
`air_unit_srt` rearchitecture removes. Target flow:

```
wfb_rx ──► ffmpeg -c copy ──┬─► -f mpegts srt://server   (no transcode)
                            └─► -f hevc pipe:1 ─IPC─► WebCodecs → canvas
```

## Lifecycle invariants

- `start()` calls `await this.stop(id)` first — one connection per id.
- `stop()` deletes the conn entry **before** killing, so the exit handler sees
  `conns.get(id)?.proc !== proc` and neither falls back nor emits a status the
  caller has already handled.
- The renderer's `onEvent` returns an unsubscribe function; relays must call it
  in their own stop path or events leak across reconnects.

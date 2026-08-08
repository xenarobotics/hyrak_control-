# Module: frontend-transport

Paths: `frontend/src/lib/` (relays, socket, nativeBridge, videoSource),
`frontend/src/hooks/useDrone.ts`, `frontend/src/hooks/useAirUnitVideoBridge.ts`

## Purpose

Everything on the client that gets bytes to and from the server: the socket.io
connection, the native-bridge feature detection, the per-link relays, and the
connect-state machine the UI renders.

## Responsibilities

- Own the socket.io singleton (`socket.ts`, pinned to the `websocket` transport).
- Detect the desktop app (`nativeBridge.ts` — the mere presence of
  `window.hyrakNative` is the signal) and prefer native paths over browser ones.
- Relay each link type between a native bridge and socket.io.
- Hold telemetry connect state and translate server events into UI status.
- Persist transport/video preferences in `localStorage`.

## Files

| File | Role |
|---|---|
| `socket.ts` | socket.io singleton, `transports: ['websocket']` |
| `nativeBridge.ts` | Desktop detection + typed wrapper over `window.hyrakNative` |
| `remoteSitlRelay.ts` | Client's own SITL on 14540 ⇄ `serial_uplink`/`serial_downlink` |
| `localSwarmRelay.ts` | 10-drone SITL fleet (14541+), tag-multiplexed |
| `localRfRelay.ts` | wfb-ng telemetry via a loopback WebSocket agent |
| `rfBridge.ts` | RF bridge signaling |
| `browserSerial.ts` | Web Serial radio |
| `rtspCameraStream.ts` | RTSP → loopback fMP4 → `<video>.captureStream()` → MediaStream, so an RTSP camera rides the ordinary webcam/WebRTC path (`rtsp_camera`). Needs no reachable server address — the NAT-proof fallback to `rtsp_relay`. Takes `previewUrl` from `start()`'s return `meta`, never only from the event (see desktop-bridges). Falls back to MJPEG via `rtspBridge` when the browser can't decode the camera's codec |
| `formatBytes.ts` | `formatBytes` / `formatRate` / `formatEta` — shared by the update prompt and Settings → About so download figures can't drift |
| `videoSource.ts` | `VideoSource` enum, `isServerSourced()`, `needsCameraSelection()`, persisted port/URL/relay prefs |
| `videoSettings.ts` | Resolution/fps/feed-mode/`OVERLAY_CAPABLE` |
| `hooks/useDrone.ts` | Connect flows, socket handlers, command routing |
| `hooks/useAirUnitVideoBridge.ts` | Start/stop/status for the air-unit video bridge (shared by Fly and Settings) |
| `hooks/useRtspRelayBridge.ts` | `allocateRelay`/`releaseRelay` socket acks + relay bridge status and local preview URL |

## Dependencies

`socket.io-client`, `zustand` (`store/drone.ts`, `store/swarm.ts`),
`window.hyrakNative` when running in Electron.

## Configuration

`localStorage`, all `hyrak-*` prefixed: `hyrak-video-source`,
`hyrak-air-unit-video-port`, `hyrak-siyi-rtsp-url`, `hyrak-relay-transport`,
`hyrak-relay-latency-ms`, `hyrak-video-res`,
`hyrak-video-fps`, `hyrak-feed-mode`, plus units/map/status-bar prefs.

## Load-bearing details

- **Desktop-only paths have no browser fallback** on purpose. A browser tab
  cannot open UDP; the old workaround (a separate `single_relay.py` the user ran)
  was removed as confusing. Browser users are pointed at the desktop download
  (`DeviceSelector.tsx`).
- **Read `localStorage` after mount, never in initial state.** Doing it inline
  makes server and client first renders disagree — a hydration mismatch. See
  `VideoStream.tsx`'s `isServerSourced`.
- **`socket.emit('serial_uplink', event.data)` passes the `Uint8Array`, not
  `.buffer`** — `.buffer` can include bytes outside the view when it isn't
  exactly sized. socket.io-client serializes a TypedArray correctly on its own.
- **Only a `telemetry_status` event exits the `connecting` UI state** (ADR-007).
  `useDrone.ts` now also handles the generic `error` event for that reason.
- **`AIR_UNIT_BRIDGE_ID` is shared** by the Fly device panel and Settings →
  Video, so starting it in one place is immediately reflected in the other.
  There is only ever one such bridge running.

## Known issues

- The Settings video-source `ChipGroup` is at five modes and will overflow at six.
- **`rtsp_camera` is not server-sourced but still has no device to pick.**
  That is why `needsCameraSelection()` exists separately from
  `isServerSourced()` — gating Start on a camera selection left the button
  permanently disabled.
- Relay mode's ordering is load-bearing and implicit: **allocate → start the
  bridge → send the offer.** `on_offer` attaches to an already-arriving stream,
  so an offer sent first is guaranteed to fail. `useWebRTC.startStream` is the
  only place that sequences this correctly.
- `air_unit_udp` is offered as a peer mode but only works when the backend is
  co-located with the RF link — needs relabelling.
- Recording in overlay mode captures raw video without annotations.
- `localStorage`-only config means the server has no view of a client's
  settings, which makes remote diagnosis harder.

## Future improvements

Add `air_unit_srt` (ADR-002/003/004): a WebCodecs canvas preview, an SRT
config row, and eventually an auto-probe with a visible "which path is live"
status.

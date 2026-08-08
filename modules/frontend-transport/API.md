# frontend-transport — API

## `nativeBridge.ts`

```ts
isDesktopApp(): boolean          // presence of window.hyrakNative
nativeBridge(): NativeBridgeApi | null
// .start(kind, id, config) .stop(kind, id) .send(kind, id, data, meta?)
// .list(kind) .onEvent(cb) → unsubscribe
type BridgeEvent = { bridge, id, type, data?: Uint8Array, meta?: Record<string, unknown> }
```

## `remoteSitlRelay.ts`

```ts
const NATIVE_UDP_ID = 'remote-sitl'
const SILENCE_TIMEOUT_MS = 8000

isRemoteSitlRelayActive(): boolean
startRemoteSitlRelay(port = 14540): Promise<void>   // throws on bind failure
stopRemoteSitlRelay(): Promise<void>

type SitlSilenceHandler = (message: string) => void
setSitlSilenceHandler(h: SitlSilenceHandler | null): void
```

`startRemoteSitlRelay` sequence: `bridge.start('udp', id, {ports:[{tag:0, port}]})`
→ arm the silence timer → subscribe to bridge events → `socket.on('serial_downlink')`
→ `socket.emit('connect_browser_serial', {})`.

Throws with a specific message on `EADDRINUSE` (naming QGroundControl and other
ground-station software as likely culprits).

**The silence timer** fires after 8s if no packet arrived, because a successful
bind proves nothing about whether SITL is sending. It is cancelled by the udp
bridge's `{type:'status', meta:{receiving:true}}` event. `useDrone.ts` registers
a handler that sets the error, moves status to `'error'`, and stops the relay.

## `videoSource.ts`

```ts
type VideoSource = 'camera' | 'air_unit_udp' | 'siyi_rtsp'
// planned: | 'air_unit_srt' | 'air_unit_rtp_relay'

getVideoSource(): VideoSource            setVideoSource(v): void
getSiyiRtspUrl(): string                 setSiyiRtspUrl(url): void
getAirUnitVideoPort(): number            setAirUnitVideoPort(port): void

DEFAULT_SIYI_RTSP_URL = 'rtsp://192.168.144.25:8554/video1'
DEFAULT_AIR_UNIT_VIDEO_PORT = 5600
```

All getters are SSR-safe (`typeof window === 'undefined'` → default) and
validate against the allowlist. **Each enum value is a preset fixing source ×
transport × preview × downlink — do not split into orthogonal settings**
(ADR-003).

## `useAirUnitVideoBridge.ts`

```ts
const AIR_UNIT_BRIDGE_ID = 'air-unit-video-bridge'   // shared across tabs

useAirUnitVideoBridge(): {
    supported: boolean          // mounted && isDesktopApp()
    running: boolean
    busy: boolean
    status: { msg: string; error?: boolean; log?: string } | null
    start(config?: {port?, device?}): Promise<boolean>
    stop(): Promise<void>
}
```

`start()` posts `{port ?? 5600, device ?? '/dev/video10', mode: 'auto'}`.
Status mapping: `meta.connected` → `{msg: meta.note}`; otherwise prefer
`meta.error` (a recognised, actionable cause) over
`ffmpeg exited (code N)`, and carry `meta.log` for the detail view.

## `useDrone.ts` — connect surface

```ts
{ telemetryStatus, telemetryError,
  connectBrowserSerial(port), connectLocalRelay(url?), connectRemoteSitl(port?),
  sendAction(action, payload?) }
```

Each connect sets `telemetryStatus = 'connecting'` and relies on a server
`telemetry_status` to leave it.

**Socket events handled:** `connect`, `disconnect`, `connect_error`,
`session_ready`, **`error`** (added — treats a pending connect as failed),
`telemetry_status`, `telemetry_update`, `cv_results`, `mode_changed`,
`model_status`, `tracking_status`, `mission_upload_result`,
`swarm_mission_upload_result`, `action_result`, `drone_mission_loaded`,
`drone_telemetry`, `fleet_telemetry`, `swarm_drone_status`.

**Command routing:** in swarm mode the ticked checkboxes are the only targets
(`swarm_group_action` to every ticked, connected drone); the CTRL-highlighted
drone only selects whose telemetry is displayed. With nothing ticked, commands
are inert. Swarm off → `drone_action` to the primary.

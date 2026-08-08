# desktop-bridges — API

## The contract (`types.ts`)

```ts
export interface BridgeEvent {
    bridge: string   // 'udp' | 'tcp' | 'serial' | 'rtsp' | 'air-unit-video'
    id: string       // caller-assigned handle
    type: string     // 'data' | 'status' | 'error' | ...
    data?: Uint8Array
    meta?: Record<string, unknown>
}

export interface NativeBridge {
    readonly kind: string
    start(id, config, emit: EmitFn): Promise<{ok: boolean; error?: string}>
    stop(id): Promise<void>
    send(id, data: Uint8Array, meta?): void
    list?(): Promise<unknown[]>
}
```

## Renderer surface (`preload.ts` → `window.hyrakNative`)

```ts
hyrakNative.isElectron           // presence IS the feature-detection signal
hyrakNative.bridge.start(kind, id, config) : Promise<{ok, error?}>
hyrakNative.bridge.stop(kind, id)
hyrakNative.bridge.send(kind, id, data: Uint8Array, meta?)
hyrakNative.bridge.list(kind)
hyrakNative.bridge.onEvent(cb) : () => void   // returns unsubscribe
hyrakNative.updater.{appVersion, checkNow, authorizeDownload, install, onEvent}
```

Generic by design: adding a bridge never changes this surface, `main.ts`, or
`preload.ts`.

## `udp` bridge

**Config**
```ts
{ ports: [{ tag: number, port: number }], bindAddress?: string /* default '0.0.0.0' */ }
```

**Events emitted**
```ts
{ type:'status', meta:{ connected:true, ports, bindAddress } }        // on start
{ type:'status', meta:{ tag, port, receiving:true, from:'ip:port' } } // FIRST packet per port
{ type:'data',   data:Uint8Array, meta:{ tag, port } }                // every packet
{ type:'error',  meta:{ tag, port, message } }
```

The `receiving` event exists because a successful bind and a dead source were
otherwise indistinguishable. Consumers should use it to detect
"bound but nothing arriving".

**`send(id, data, {tag})`** replies to the **last sender seen on that port**.
If no packet has ever arrived, it is a no-op — there is nothing to reply to.

**Internal state**
```ts
interface UdpSocketEntry {
    socket: dgram.Socket
    peer: {address, port} | null   // last sender; the reply target
    sawTraffic: boolean            // gates the one-time `receiving` event
}
```

## `air-unit-video` bridge

**Config**
```ts
{ port?: number /* 5600 */, device?: string /* '/dev/video10' */, mode?: 'auto'|'hw'|'sw' }
```

**Events emitted**
```ts
{ type:'status', meta:{ connected:true, device, port, usingHw, note } }
{ type:'status', meta:{ connected:false, code, log /* stderr tail, 2000B */, usingHw, error? } }
```

`error` is set only for recognised, actionable causes: port already in use, or
hardware decode setup failure. Otherwise the consumer shows
`ffmpeg exited (code N)` with the log.

**Internal API**

- `vaapiRenderNode(): string | null` — checks `ffmpeg -hwaccels` for
  compile-time support, then **probes each `/dev/dri/renderD*`** with
  `-init_hw_device vaapi=va:<node> -f lavfi -i nullsrc -frames:v 1 -f null -`,
  returning the first that initialises. Cached per process. **A compile-time
  flag is not a capability — do not shortcut this** (ADR-005).
- `HW_SETUP_WINDOW_MS = 4000` — a hardware attempt exiting sooner is treated as
  unusable hardware and retried in software; exiting later is a real stream
  ending and surfaces as an error.
- `launch(hwNode: string | null)` — recursive; `launch(null)` is the software
  fallback. Guards with `this.conns.get(id)?.proc !== proc` so a deliberate
  `stop()` neither falls back nor emits.
- `stop(id)` is **awaited** and waits for real process exit (SIGTERM, SIGKILL
  at 1.5s, give up at 2.5s) so a Stop→Start sequence doesn't race the OS into
  "address already in use".

**ffmpeg arguments** — the low-latency input block is mirrored verbatim from
`backend/app/webrtc/udp_video_source.py` and fixes a real ~1s lag bug:

```
-protocol_whitelist file,udp,rtp -fflags nobuffer -flags low_delay
-max_delay 100000 -reorder_queue_size 0
```

Hardware path adds `-vaapi_device <node> -hwaccel vaapi
-hwaccel_output_format vaapi` and `-vf hwdownload,format=nv12`. Both paths end
`-pix_fmt yuyv422 -f v4l2 <device>`.

`send()` is a documented no-op — this bridge is video-in only; MAVLink
telemetry uses the `udp` bridge.

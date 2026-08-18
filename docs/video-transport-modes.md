# Video transport modes

Reference for HYRAK's selectable video paths — what each one does, what it
costs, and which network/hardware conditions each is the right answer for.
User-facing selection lives in **Settings → Video → Video source**
(`frontend/src/app/(platform)/settings/page.tsx`, `VideoGroup`), persisted
by `frontend/src/lib/videoSource.ts`.

Companion implementation plan for the unbuilt modes:
`~/.claude/plans/hyrak-srt-video-rearchitecture.md`.

## Why more than one mode is required, not optional

The tempting conclusion from the latency/CPU analysis is "SRT wins, ship
only that." It doesn't, for one hard reason already hit in the field:

> **Japesh's college WiFi blocks all outbound UDP.** This is documented in
> `app/webrtc/signaling.py` (`_sort_relay_urls`, commit `a0dc785`) — the
> signature was `socket.send() raised exception` spam and peer connections
> stuck at "connecting". The fix was forcing Cloudflare's `turns:443`
> TCP/TLS relay to the front of the ICE list, because that is the *only*
> thing that traverses such a network.

**SRT is pure UDP with no TCP fallback.** On any network that blocks
outbound UDP, an SRT-based mode cannot connect at all, while WebRTC
survives via TURN over TLS/443. Conversely, on a normal network SRT is
dramatically better on client CPU and video quality. Neither dominates.

So the mode selector is load-bearing infrastructure: it is what lets one
build serve a client on a locked-down campus network *and* a client on
home broadband with a weak PC, without either being crippled by the
other's constraints.

## Two axes, one user-facing choice

Internally each mode is a tuple of four decisions:

| Axis | Options |
|---|---|
| **Source** — where frames originate | browser camera / air-unit RF (UDP RTP H.265) / networked RTSP camera |
| **Uplink transport** — how they reach the server | WebRTC (client encodes) / SRT push (no transcode) / plain RTP relay / server-side pull |
| **Pilot preview** — what the operator watches | local (zero network hops) / server round trip |
| **Downlink** — what comes back | re-encoded video / `cv_results` JSON only |

Those are orthogonal in principle, but exposing four dropdowns would be a
usability disaster for a traffic-police operator. **Users pick one named
profile; the profile fixes all four.** The existing `VideoSource` enum
already works exactly this way — its three current values are three
(source, transport, preview, downlink) tuples, not three "sources".

Keep it that way. Do not refactor into orthogonal knobs.

## The modes

Latency figures are pilot glass-to-glass (what the operator sees), which is
the number that matters for flying. Server-side inference latency is a
separate budget and never gated on the pilot's view except where noted.

### 1. `camera` — Browser camera → WebRTC — **shipped**

Browser captures with `getUserMedia`, encodes, uploads over WebRTC. The
air-unit variant of this uses the v4l2loopback fake-webcam hack
(`desktop/src/bridges/airUnitVideoBridge.ts` decodes H.265 to
`/dev/video10`, the browser re-captures it as a camera).

| | |
|---|---|
| Pilot latency | ~150ms measured; local-preview fast path for `manual-control` (`VideoStream.tsx` `isRaw`) |
| Client CPU | **Highest** — decode *and* re-encode when fed from the air unit |
| Server-received quality | Generation-loss (re-encoded once on the client) |
| Uplink / downlink | 3-12 Mbps re-encoded / JSON if overlay mode, else re-encoded video |
| Platforms | Webcam: all. Air-unit via loopback: **Linux only** (`sudo modprobe v4l2loopback`) |
| Loss resilience | Best in class — adaptive bitrate, NACK/FEC, **works over TURN TLS:443** |

**Use when:** the network blocks UDP (campus/corporate/hotel), or the
source genuinely *is* a webcam. This is the compatibility floor — it
should always remain available.

### 2. `air_unit_udp` — Server binds local UDP — **shipped, co-located only**

`backend/app/webrtc/udp_video_source.py` binds `127.0.0.1:5600` **on the
server**. Only works when the ground station is the same machine as the
backend — which today is true only for Japesh's own laptop. `signaling.py`
already names this failure in its error string: *"is the source actually
sending to this server (not just to its own machine's localhost)?"*

| | |
|---|---|
| Pilot latency | Full client→server→client round trip (server re-encodes the view back) |
| Client CPU | Zero |
| Server-received quality | **Pristine** — no client transcode |
| Platforms | Any, but requires co-location |

**Use when:** developing/testing with the backend on the same machine as
the RF link. **Must be labelled "co-located only"** in Settings so no
remote client picks it and gets a connected-but-black stream.

### 3. `siyi_rtsp` — Server pulls RTSP — **shipped**

`backend/app/webrtc/rtsp_video_source.py` pulls from a networked camera,
e.g. a SIYI transmission module gimbal at
`rtsp://192.168.144.25:8554/video1`.

**Use when:** the camera is reachable from the server on the network.
Same co-location caveat as mode 2 unless the camera is internet-reachable.
**In practice that means dev only** — a SIYI ground unit's 192.168.144.x is
link-local to its own hotspot, so no remote server can ever pull it. Use
`rtsp_relay` (mode 3b) for real deployments. See ADR-008.

### 3b. `rtsp_relay` — Client pulls RTSP, pushes `-c copy` — **shipped (0.1.7)**

The same camera as mode 3, opened from the machine that can actually reach
it. `desktop/src/bridges/rtspRelayBridge.ts` runs one ffmpeg with `-c copy`
and two tee outputs: MPEG-TS over SRT to the backend, and a fragmented-MP4
local preview on loopback HTTP.

| | |
|---|---|
| Client cost | **1 decode (preview, in Chromium), 0 encodes** — ~2% CPU for the relay itself |
| Quality | Bit-exact; nothing is re-compressed |
| Latency | Removes a ~30-60 ms transcode, adds the SRT latency window (default 60 ms) — roughly a wash. The real win is the preview skipping the round trip |
| Server cost | One `-c copy` remux hop (PyAV has no `srt://`), then normal decode for AI |
| Network | **Does not traverse the cloudflared tunnel** — needs `relay_public_host` + forwarded UDP 3478-3578. Dead where UDP is blocked |
| Platforms | Any the desktop app runs on — no v4l2loopback, unlike `air_unit_udp` |

**Use when:** a networked camera is reachable from the client. This is the
default choice for SIYI setups off a developer's desk.

### 3c. `rtsp_camera` — Client pulls RTSP, sends it as a webcam — **shipped (0.1.9-0.1.14)**

The NAT-proof sibling of 3b, and in practice the mode that works. Mode 3b
needs a routable server address; when both ends are behind NAT — the norm,
and the case that blocked the SIYI bring-up — there is no address to push
to. So instead of inventing a transport, reuse the one that already solves
NAT: the client decodes the RTSP feed locally and hands the result to
`startStream()` as an ordinary `MediaStream`. The backend cannot tell it from
a webcam, which is the entire point.

```
RTSP --ffmpeg--> loopback fMP4 --<video>--> captureStream() --> WebRTC
```

Deliberately **not** `isServerSourced()`. See
`frontend/src/lib/rtspCameraStream.ts`, which descends a three-rung ladder on
failure: `-c copy` → H.264 transcode → MJPEG. An H.265 camera lands on rung
2, because Chromium ships no *software* HEVC decoder.

| | |
|---|---|
| Client cost | 1 decode + 1 encode (rung 2; rung 1 is decode-only), plus WebRTC's own encode |
| Quality | One generation of loss on rung 2 |
| Network | **Traverses anything** — STUN/TURN, including TURN over TLS:443. Needs no server port, no `relay_public_host`, no tunnel change |
| Platforms | Desktop app only — a browser tab cannot open RTSP |

**Use when:** the camera is reachable from the client but the server is not
reachable from the client. That is most real networks.

#### Latency budget

> **The ~1 s measured on 2026-07-27 was not a pipeline problem — it was CPU
> starvation from a process leak, fixed in desktop 0.1.16.** Four app instances
> had stranded nine orphaned ffmpeg processes on one camera, pinning a 24-core
> machine at ~98%. The link was measured at the same time as `-33 dBm` /
> 390 Mbit/s carrying 2 Mbit/s — the network was never implicated. See the
> 0.1.16 CHANGELOG entry.
>
> The lesson worth keeping: **check `load average` and `pgrep -x ffmpeg` before
> attributing latency to transport.** Range, signal, TCP head-of-line blocking
> and SIYI's RTSP server were each theorised here and each wrong, at the cost
> of two build cycles.

The terms below are the real budget once the machine is not saturated. **No
latency figure recorded before 0.1.16 is trustworthy**; treat the "before"
column as a hypothesis except where marked operator-measured.

| Term | Before | After | Notes |
|---|---|---|---|
| SIYI camera → ground unit | 50-100 ms | unchanged | SIYI's own link; not ours to fix |
| **Ground unit → laptop (RTSP over WiFi)** | **~400 ms, operator-measured** | switchable in 0.1.15 | The prime suspect. TCP converts link loss into *accumulating* delay via head-of-line blocking; `Camera transport: UDP` converts it into artifacts instead |
| RTSP pull + ffmpeg decode/encode | 50-150 ms | unchanged | Rung 2 only; free on rung 1 |
| fMP4 fragmentation | up to 100 ms | **~0** | `frag_duration` 100 ms → 20 ms, i.e. one fragment per frame |
| ffmpeg AVIO output buffering | batched (32 KB) | **~0** | `-flush_packets 1`; required for the row above to matter |
| Chromium `<video>` standing buffer | **200-400 ms** | ~100 ms | `clampToLiveEdge()` drains it via `playbackRate` |
| WebRTC round trip | 50-150 ms | unchanged | Bypassed entirely in `manual-control` (`isRaw` renders the local stream) |

The two large removable terms were both pure buffering. What remains is the
transcode (deletable by switching the SIYI camera to H.264) and the
`<video>`/`captureStream()` hop itself (deletable via WebCodecs — ADR-004).
`getLiveEdgeDriftMs()` in `frontend/src/lib/liveEdge.ts` reports the browser's
live contribution, which is what to watch when tuning further.

### 4. `air_unit_srt` — Client pushes SRT, local preview — **planned**

The rearchitecture. One client-side ffmpeg with `-c copy` (no transcode at
all) and two outputs: MPEG-TS over SRT to the server, and the H.265
elementary stream to the renderer, which decodes it with WebCodecs and
paints to a canvas.

| | |
|---|---|
| Pilot latency | **~20-60ms** — frames never leave the machine |
| Client CPU | **Lowest** — one decode, zero encodes |
| Server-received quality | **Pristine** — original air-unit bitstream |
| Uplink / downlink | Native bitrate once (bounded by `?bandwidth=`) / **JSON only** |
| Platforms | **Linux, Windows, macOS** — no kernel module |
| Loss resilience | Bounded retransmission inside a configurable window (`latency=120`) — glitches instead of freezing |
| **Hard limitation** | **Pure UDP. Cannot connect on a UDP-blocking network.** |

**Use when:** the client is on a normal network (home/mobile broadband) —
which is most clients. This should become the **default for RF air-unit
users** once shipped.

Also unlocks the existing client-overlay path: with a local preview,
`signaling.py`'s `client_overlay = ... and not server_sourced` restriction
no longer applies, so `return_video=False` drops the downlink video leg
entirely.

### 5. `air_unit_rtp_relay` — Plain RTP/UDP forward — **planned, optional**

Forward the air unit's RTP packets to the server verbatim, no SRT layer.

| | |
|---|---|
| Added transport latency | **~0** — no recovery window at all |
| Loss behaviour | None. Any packet loss = visible artifacts |
| Requires | Low-loss path — LAN, VPN, or private link |

**Use when:** client and server are on the same LAN or a dedicated link and
you want the absolute floor on latency. Not appropriate over the open
internet.

### 6. `hyrak_receiver` — Ground decoder over Ethernet — **shipped (0.1.50)**

The odd one out, because the hardware is different. Every `air_unit_*` mode
assumes `wfb_rx` runs on **this** machine, which drags the RTL8812EU driver,
a wfb-ng build and the RF keys onto every client — Linux-only, and a support
burden per install. The ground decoder is a separate box that owns all of
that and hands the PC plain compressed H.265 over Ethernet.

| | |
|---|---|
| Pilot latency | **~40-80ms** plus the chosen buffer — decoded locally, never leaves the machine |
| Client CPU | **Lowest available.** Default path decodes nowhere but the GPU: ffmpeg demuxes with `-c copy`, WebCodecs decodes |
| Server-received quality | **Pristine** — the uplink branch copies the original H.265 |
| Platforms | **Windows, Linux, ARM64 — one installer, nothing else installed.** The only air-unit mode where that is true |
| Transports | `rtsp` (default), `srt`, `udp` — see `HYRAK_RECEIVER.md` |
| Requires | The ground decoder reachable on the network. No driver, no keys, no GStreamer |

**Use when:** the client has the ground decoder rather than a locally attached
RF adapter. This is the mode that makes a non-Linux client possible at all.

Full design, the transport trade-offs, the decode ladder and what is actually
verified: **`docs/HYRAK_RECEIVER.md`**.

## Choosing a mode — recommended defaults

| Scenario | Mode |
|---|---|
| Client has the HYRAK ground decoder (Windows/Linux/ARM64) | **`hyrak_receiver`** |
| RF air unit, normal broadband, weak PC (the common client) | **`air_unit_srt`** |
| RF air unit, network blocks UDP (campus/corporate/hotel WiFi) | **`camera`** (loopback on Linux) — the only option that traverses TURN TLS:443 |
| Client and server on the same LAN / VPN | `air_unit_rtp_relay` |
| Backend running on the same machine as the RF link (dev) | `air_unit_udp` |
| Networked gimbal camera (SIYI etc.), real deployment | **`rtsp_relay`** |
| Networked gimbal camera reachable from the server (dev) | `siyi_rtsp` |
| Networked gimbal camera, network blocks UDP | `camera` via `rtspBridge` MJPEG — WebRTC/TURN is the only path |
| Plain webcam, no drone video | `camera` |

**Auto-selection is worth considering later, not first.** A probe could try
SRT and fall back to `camera`/WebRTC on failure — the same probe-then-
fallback shape already used for VAAPI in `airUnitVideoBridge.ts` (0.1.3).
But it needs the manual selector to exist and be trusted first, and a
"detected: UDP blocked, using WebRTC" status line so the operator is never
guessing which path is live.

## Settings UX

Extends the existing `VideoGroup` `ChipGroup` — no new patterns:

- Add `air_unit_srt` (and optionally `air_unit_rtp_relay`) to
  `VideoSource` in `frontend/src/lib/videoSource.ts` and to the
  `options` array in `VideoGroup`.
- Per-mode conditional `PrefRow`s, exactly like today's
  `{source === 'air_unit_udp' && ...}` port row:
  - `air_unit_srt`: local RTP port (default 5600), SRT latency window ms
    (default 120), optional uplink bandwidth ceiling.
  - `air_unit_rtp_relay`: local RTP port, server host/port.
- Relabel `air_unit_udp` to **"Air unit (server-local)"** with a `sub`
  making the co-location requirement explicit.
- Keep the existing "Can't switch mid-stream — stop and restart to apply"
  `sub`. Mode changes what goes in the WebRTC offer, so it is a
  per-stream decision, consistent with how feed-mode is already locked
  while streaming.
- The `tip` text on each chip is where the "use when" guidance from the
  table above belongs — operators are non-technical and will not read this
  document.

Four chips ship today (`camera`, `air_unit_udp`, `siyi_rtsp`, `rtsp_relay`). Six in one row will overflow. Either group them (Camera / Air unit /
Network camera with a sub-choice) or switch that row to a select. Worth
deciding when the fourth mode actually lands, not before.

## Status

| Mode | State |
|---|---|
| `camera` | Shipped |
| `air_unit_udp` | Shipped; needs relabelling as co-located-only |
| `siyi_rtsp` | Shipped; dev-only by nature — needs relabelling |
| `rtsp_relay` | **Shipped (desktop 0.1.7)** — untested against real SIYI hardware |
| `air_unit_srt` | Planned — Phase 1/2 of the rearchitecture plan |
| `air_unit_rtp_relay` | Planned, optional — cheap once SRT ingest exists |

## Open decisions

1. **SRT port handshake.** How the client learns its server-side listener
   port. Cleanest is a signaling round trip (client offers → server
   allocates → returns `{srtHost, srtPort}` → client starts ffmpeg), but
   that reorders today's "start bridge, then start stream" flow.
2. **WebCodecs HEVC availability** on client hardware (Electron 32 /
   Chromium 128) — gates the `air_unit_srt` local preview. Fallback is
   ffmpeg software decode to rawvideo at 720p preview; still zero encodes.
3. **Whether `air_unit_rtp_relay` ships at all**, or SRT with
   `latency=20` covers the LAN case well enough to not add a fifth mode.

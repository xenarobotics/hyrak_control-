# ARCHITECTURE

## Components

```
┌─── CLIENT MACHINE ────────────────────────────┐      ┌─── SERVER ──────────────┐
│                                               │      │                         │
│  drone ⇄ RF air unit / USB radio / SITL       │      │  FastAPI :8001          │
│              │                                │      │   ├─ socket.io (WS/TCP) │
│  ┌───────────▼─── Electron MAIN (Node) ─────┐ │      │   ├─ aiortc peer        │
│  │ bridges/: udp tcp serial rtsp airUnitVid │ │      │   ├─ vision worker pool │
│  │ raw sockets, ffmpeg, native modules      │ │      │   ├─ mavsdk_server(s)   │
│  └───────────┬──────────────────────────────┘ │      │   └─ /releases static   │
│              │ Electron IPC                   │      │                         │
│  ┌───────────▼─── RENDERER (Chromium) ───────┐│ ◄──► │  PostgreSQL             │
│  │ Next.js UI — sandboxed exactly like a tab ││      │  Cloudflare TURN (ext)  │
│  └──────────────────────────────────────────┘│      │                         │
└───────────────────────────────────────────────┘      └─────────────────────────┘
        socket.io (TCP)  +  WebRTC SRTP (UDP, TURN TLS:443 fallback)
```

`main` is full Node.js and unsandboxed; the renderer has a plain browser's
restrictions. This split is the architecture's central lever — see ADR-004.

## Backend layout

| Package | Responsibility |
|---|---|
| `server.py` | `create_app()` factory: FastAPI, CORS, socket.io `AsyncServer`, static `/releases`, shared `SessionManager` + `PeerRegistry` |
| `main.py` | uvicorn entry. `reload_dirs=["app"]` — watching the whole CWD was killing live WebSockets on every connect cycle |
| `config.py` | pydantic-settings. host `0.0.0.0`, port `8001`, Postgres DSN, `lan_origins` |
| `webrtc/` | `signaling.py` (offer/answer, source selection), `stream_track.py` (`MultiModeVideoStreamTrack`), `peer_registry.py`, `turn.py`, `udp_video_source.py`, `rtsp_video_source.py`, `__init__.py` (bitrate ceiling overrides) |
| `vision/` | `base.py` (`BaseAnalyzer`, latest-frame-drop), `drawing.py`, `persistence.py`, `worker_pool.py`, `modules/` |
| `telemetry/` | `manager.py` (`TelemetryManager` over MAVSDK), `serial_bridge.py`, `rf_bridge.py`, `gs_relay.py` |
| `events/` | socket.io handlers: telemetry, swarm, admin, vision |
| `sessions/` | `SessionManager`, `AnalysisMode` enum (11 values) |
| `db/`, `flights/`, `zones/`, `permits/`, `api/`, `registry/`, `sandbox/`, `utils/` | Persistence and domain features |

## Reference model (layering)

The model to argue against when adding transports, so the layering questions
don't get re-litigated per feature.

```
┌─ Applications ─────────────────────────────────────────┐
│ UI · AI modes · Maps · Mission · Recording/Export      │
├─ Session & Control plane ──────────────────────────────┤
│ signalling (SDP · WHIP · socket.io) · auth · zones     │
│ NAT traversal:  ICE / STUN / TURN                      │
├─ Message & Media planes ───────────────────────────────┤
│ control: MAVLink · gRPC       (small, ordered, lossless)│
│ media:   RTP/SRTP · MPEG-TS   (bulk, loss-tolerant)     │
├─ Secure transport ─────────────────────────────────────┤
│ DTLS-SRTP · SCTP · SRT · QUIC                          │
│   └─ HYRAK Media Bridge (RTP over WebRTC DataChannel)  │
├─ Transport ────────────────────────────────────────────┤
│ UDP · TCP                                              │
├─ Network ── IP ────────────────────────────────────────┤
├─ Link / Physical ──────────────────────────────────────┤
│ custom RF · Wi-Fi · Ethernet · 5G                      │
└────────────────────────────────────────────────────────┘

Orthogonal — properties, NOT layers:
  Codec       H.264 · H.265 · AV1  — constrained by per-device capability
  Adaptation  congestion control · FEC/ARQ · bitrate ladder
  Time        RTP timestamps · NTP — telemetry↔frame correlation
```

### Why these are not layers

**Codec is not a layer.** Data does not flow *through* a codec en route to a
transport; the codec produces the payload everything else wraps. Ordered by
encapsulation it sits **above** RTP, not below: codec → elementary stream →
RTP payload format (RFC 6184 H.264, RFC 7798 H.265) → SRTP → UDP. Drawing it
beneath the streaming layer inverts the relationship.

Codec also carries a second dimension that a layer diagram cannot express:
**per-device capability**. Chromium ships no *software* HEVC decoder; the
bundled ffmpeg has no VAAPI (only `vdpau`); aiortc cannot negotiate H.265 at
all. Codec selection is a negotiation against what each endpoint can actually
do — see ADR-005.

**RTP is not a peer of WebRTC.** WebRTC is a bundle — ICE + DTLS + SRTP +
SCTP + congestion control. Choosing WebRTC has already chosen RTP. SRT is a
transport with ARQ that normally carries MPEG-TS, not RTP. Listing the three as
siblings hides the containment.

**QUIC runs on top of UDP**, not beside it.

**MAVLink and gRPC are not transports.** MAVLink is a message format over
UDP/TCP/serial; gRPC is RPC over HTTP/2. They belong to the control plane.

### The layer that dominates this project

**NAT traversal**, and it is worth stating why it gets its own row. Nearly
every hard failure in the video work was this layer: `siyi_rtsp` breaks
whenever the server is not on the camera's network; `rtsp_relay` dies when both
ends are behind NAT (the normal case); `relay_public_host` exists only because
of it. It is not a footnote — it decides whether a transport works anywhere
other than a developer's desk.

### Contribution ≠ distribution

The single most useful split, and the one that dissolves "WebRTC reduces
quality":

- **Contribution** (client → server): one consumer, must be maximum quality.
  Bit-exact, no transcode. The server holds the original.
- **Distribution** (server → viewers): many consumers, browser-constrained,
  transcoded per tier.

The H.264-only limitation is a property of *browser distribution*. It never
constrains what the server receives or stores, so a premium tier can be served
the original while a regular tier gets a modest rendition.

## Secure transport comparison

Measurements were taken 2026-07-27 against the live SIYI camera (HEVC Main,
1920x1080, 30 fps, ~2 Mbit/s) over a phone-hotspot Wi-Fi link measured at
-33 dBm / 390 Mbit/s, 33 ms RTT. **Numbers marked *(est.)* are not measured**
— the distinction matters, because assuming unmeasured numbers is what cost
this project four releases.

### Per-transport

| Transport | Encryption | Added latency | Overhead | Quality | Loss behaviour | NAT traversal | Codec limit |
|---|---|---|---|---|---|---|---|
| **WebRTC media track** (SRTP) | DTLS-SRTP, mandatory | 50–150 ms *(est.)*; GCC actively minimises | ~2% (RTP 12 B + auth tag) | Transcode forced → generation loss, **1.5–2× bitrate** for H.265-equivalent quality | NACK/RTX + PLI keyframe recovery; degrades gracefully | **Full** — ICE/STUN/TURN, incl. TURN over TLS:443 | **VP8 / H.264 only** (aiortc) |
| **WebRTC DataChannel** (SCTP/DTLS) | DTLS, mandatory | **0.2–0.7 ms p50 measured** to 50 Mbit/s, trend flat (see below) | ~3–4% (SCTP 12–28 B + DTLS) | **Bit-exact, any codec** — payload is opaque | Configurable: `ordered:false, maxRetransmits:0` gives UDP semantics | **Full** — inherits WebRTC | **None** |
| **SRT** | AES-128/256 (passphrase) | = configured `latency` window; a **floor**, not a budget (default 120 ms, we used 60 ms) | ~1% + MPEG-TS packing (~7% if repacketised) | Bit-exact with `-c copy` | ARQ inside the window; beyond it, lost | **None** — needs a reachable listener. This is what killed `rtsp_relay` | None |
| **Raw RTP/UDP** (`air_unit_udp`) | **None** | Lowest achievable, ~0 | ~1% (RTP 12 B) | Bit-exact | **No recovery at all** — loss becomes artifacts | None | None |
| **RTSP over TCP** (camera leg) | None (unless RTSPS) | Head-of-line blocking: loss converts to **accumulating** delay | TCP + retransmits | Lossless | Perfect delivery, paid for in latency | n/a (inbound, local) | None |
| **RTSP over UDP** | None | Reorder queue (default `-1` = auto, buffers to wait); we pin `0` | ~1% | Lossless if no loss | Loss → artifacts, cannot accumulate | n/a | None |
| **QUIC datagrams** (RFC 9221) — *future* | TLS 1.3, mandatory | Low; no HOL blocking for datagrams; modern CC (BBR/CUBIC) — **better suited than SCTP** | ~2–3% | Bit-exact, any codec | Datagrams unreliable by design | Needs a reachable server or relay; connection migration, but **no hole punching** | None |
| **HLS / DASH over HTTPS** — *distribution only* | TLS | 2–10 s (LL-HLS ~2 s) | Segment + manifest | Excellent, multi-bitrate ladder | Perfect (TCP) | Trivial (HTTP) | None |

### Measured end-to-end paths

| Path | Codec steps | Measured latency | Notes |
|---|---|---|---|
| `siyi_rtsp` — server opens camera | 3 | **~300 ms** | Fastest available, but only works while the server shares a network with the camera. Not deployable. |
| `rtsp_camera` — via `<video>` + `captureStream()` | 7 | **1–1.5 s** | Video is laundered through Chromium to get a MediaStream back out. Structural, not tunable. |
| `webrtc-sender` (werift → aiortc) | 2–3 | **not yet measured in-app**; PoC sustained ~30 fps, ICE completed, 419 frames/15 s | The structural fix. |

Component measurements, same session:

| Component | Measured |
|---|---|
| RTT to camera (via phone hotspot) | 33 ms avg, 60 ms max |
| SIYI RTSP server pre-buffer on connect | **+0.14 s** |
| RTSP delivery rate, steady state | 0.996× realtime (no drift) |
| libx264 transcode, software | 1.04× realtime, **0.41 cores** |
| VAAPI transcode, AMD iGPU `renderD129` | 1.05× realtime, **0.03 cores** (~15× less CPU) |
| fMP4 fragmentation, 20 ms setting | 89 `moof` per 90 frames (one per frame) |
| Chromium `<video>` standing buffer | 200–400 ms *(est.)*; clamp targets 100 ms |

### How to choose

The four axes trade against each other in a fixed way, and only two
combinations are actually sensible for this product:

- **Latency vs reliability** is a single dial, not two: every recovery
  mechanism (TCP retransmit, SRT ARQ, SCTP retransmit) buys delivery with
  delay. On a pilot's view, late is worse than missing — prefer loss.
- **Bandwidth vs quality** is set by the codec, and the codec is constrained by
  the endpoint. H.265 → H.264 transcode costs 1.5–2× bitrate at equal quality.
- **Quality vs reachability** is the real tension: the bit-exact transports
  (raw RTP, SRT) have no NAT traversal, and the transport with universal NAT
  traversal (WebRTC media) forces a transcode.

**The DataChannel profile is interesting precisely because it is the only entry
that is both bit-exact and NAT-traversing.**

### DataChannel measurements (2026-07-27)

werift sender → aiortc receiver, `ordered:false, maxRetransmits:0`,
1200-byte payloads, 12 s per step, one-way delay (both ends share a clock):

| Target | Goodput | Loss | p50 | p95 | max | Latency trend (1st→last third) | max `bufferedAmount` |
|---|---|---|---|---|---|---|---|
| 2 Mbit/s | 1.97 | 0.0% | 0.24 ms | 0.53 ms | 17.5 ms | 0.25 → **0.22** | 2.4 KB |
| 8 Mbit/s | 7.90 | 0.0% | 0.26 ms | 0.62 ms | 5.8 ms | 0.28 → **0.24** | 6.0 KB |
| 20 Mbit/s | 19.71 | 0.0% | 0.41 ms | 0.77 ms | 2.7 ms | 0.45 → **0.39** | 13.2 KB |
| 50 Mbit/s | 49.34 | 0.0% | 0.71 ms | 1.43 ms | 6.6 ms | 0.76 → **0.69** | 32.4 KB |

The trend column is the one that matters: it is **flat or improving at every
rate**, so SCTP is not buffering. `bufferedAmount` stays bounded (~27 packets
at 50 Mbit/s) rather than growing. Goodput equals the offered rate exactly, to
25× the SIYI camera's bitrate.

**Limit of this test:** loopback. No RTT, no loss, no rate cap, no competing
traffic — so it does *not* test the original concern, which was congestion
behaviour. Proven: SCTP is not a throughput bottleneck and adds sub-ms latency
on an unconstrained path. Unproven: a lossy, rate-limited WAN link. That needs
`tc netem` in an isolated network namespace (do **not** apply netem to `lo` —
the backend and frontend talk over it) or a real remote peer.

**Mitigation that the measurement makes possible.** `maxRetransmits:0` already
removes retransmission. The remaining route to latency growth is SCTP's
congestion window shrinking on loss, which would pile packets into
`bufferedAmount` instead of sending them. But `bufferedAmount` is observable at
runtime and we now know its healthy range — so the bridge can shed for itself:
above a threshold, drop incoming RTP rather than queue it. That converts SCTP
buffering into loss, which is the correct trade for a pilot's view, and bounds
a risk that was otherwise open-ended.

**Recommended target:**

| Purpose | Transport | Why |
|---|---|---|
| Contribution (client → server) | DataChannel profile if it measures well, else WebRTC media track | Bit-exact and NAT-proof, or transcoded and NAT-proof — reachability is non-negotiable |
| Pilot preview (local) | loopback fMP4, later WebCodecs (ADR-004) | Never leaves the machine; no network term at all |
| AI overlay return | socket.io JSON, not video | Already built; strictly lower latency than a video round trip |
| Regular distribution | WebRTC media track | Browser-native, no plugin |
| Premium distribution | original H.265 over fMP4/HLS, or SRT | A paying customer will install a real player |

## Video data flow

Source selection is client-side (`lib/videoSource.ts`), sent in the WebRTC
offer as `videoSource`. `signaling.py` splits on it:

```python
server_sourced = video_source in ("air_unit_udp", "siyi_rtsp", "rtsp_relay")
client_overlay = bool(data.get("clientOverlay")) and not server_sourced
```

- **Client-sourced** (`camera`, `rtsp_camera`, and the planned
  `webrtc-sender`): the CLIENT produces the track, `pc.on("track")` receives,
  `relay.subscribe(track, buffered=False)`. `rtsp_camera` is deliberately not
  server-sourced — the backend cannot tell it from a webcam, which is exactly
  what lets it traverse NAT.
- **Server-sourced**: no incoming track (offer declares a recvonly video
  transceiver); the server opens the feed itself via `MediaPlayer`. A
  mandatory `recv()` with a 5s timeout guards against the
  "connected but permanently black" case, because an SDP-declared format
  "succeeds" instantly whether or not packets arrive.

Then in every case: `MultiModeVideoStreamTrack.recv()` → vision analyzer
(pixel work on a single-worker `ThreadPoolExecutor`, off the event loop) →
either an annotated frame re-encoded downlink, or `return_video=False` with
`cv_results` JSON only.

Full per-mode comparison: `docs/video-transport-modes.md`.

## Telemetry data flow

```
radio / SITL ─► client ─► socket.io "serial_uplink" ─► SerialBridge
                                                          │ loopback UDP
                                                          ▼
                                                     mavsdk_server
                                                          │ gRPC (unique port!)
                                                          ▼
                                            TelemetryManager ─► "telemetry_update"
```

Reverse: `SerialBridge.datagram_received` → `serial_downlink` → client writes
to the radio / UDP socket.

`SerialBridge` binds an ephemeral loopback UDP port and makes a *remote*
radio look local to MAVSDK. One per session, keyed by `session_id`.

Connect entry points (all converge on `on_connect_telemetry`):
`connect_telemetry`, `connect_browser_serial` (Web Serial radio **and** the
SITL relay), `connect_rf_bridge` (wfb-ng split ports).

Timeouts: 10s for the mavsdk gRPC handshake, 15s for the first heartbeat.
Both were added after real infinite hangs.

## Client relays (`frontend/src/lib/`)

| File | Purpose | Bridge used |
|---|---|---|
| `remoteSitlRelay.ts` | client's own SITL on 14540 | `udp` |
| `localSwarmRelay.ts` | 10-drone SITL fleet, 14541+ | `udp` (tag-multiplexed) |
| `localRfRelay.ts` | wfb-ng telemetry via a loopback WebSocket agent | — |
| `rfBridge.ts` | RF bridge signaling | — |
| `browserSerial.ts` | Web Serial radio | — |

All desktop-only paths deliberately have **no browser fallback**; browser
users are pointed at the desktop download.

## Desktop bridge contract

```ts
interface NativeBridge {
    readonly kind: string
    start(id, config, emit): Promise<{ok: boolean; error?: string}>
    stop(id): Promise<void>
    send(id, data, meta?): void
    list?(): Promise<unknown[]>
}
```

IPC is generic (`kind + id + config`), so a new bridge needs one file plus one
line in `registry.ts` — nothing in `main.ts`, `preload.ts`, or the renderer
API changes. Events flow back as `BridgeEvent {bridge, id, type, data?, meta?}`.

## Architecture review

### Strengths

- **The generic bridge abstraction.** Genuinely extensible; five bridges
  share one IPC surface with zero per-protocol plumbing.
- **Correct identification of the real bottleneck.** The system optimises
  transcode count, not protocol overhead — the right variable for weak
  clients.
- **Client-side overlays.** Sending JSON instead of re-encoded video halves
  bandwidth and improves sharpness. Well-executed and reused.
- **Defensive timeouts and probes everywhere**, each traceable to a real
  incident via its comment.
- **Latency decoupling** as an explicit, documented invariant.

### Weaknesses

- **Untracked surface is enormous.** `desktop/`, `docs/`, `communication/`,
  `releases/`, `sitl_relay/`, and the crowd/plate modules are all untracked
  in git. A machine failure loses the desktop app entirely. **Highest-risk
  item in the project.**
- **Duplicated ffmpeg tuning** in `udp_video_source.py` and
  `airUnitVideoBridge.ts`, kept in sync by comment convention only.
- **`air_unit_udp` is structurally misleading** — it cannot work for a remote
  client, but the UI presents it as a peer of the other modes.
- **Error reporting was inconsistent** — some paths emitted `error`, others
  `telemetry_status`. Partly fixed (ADR-007); an audit of remaining `error`
  emits is still open.
- **`localStorage` as the config store** means no server-side view of a
  client's settings, which makes remote diagnosis harder.

### Unnecessary complexity

- The v4l2loopback fake-webcam path exists only to work around browser codec
  limits. It is being replaced, but must be *retained* as the UDP-blocked
  fallback (ADR-003) — so the complexity is justified, not accidental.
- `sitl_relay/single_relay.py` is on disk and unreferenced. Dead code.

### Scalability

- **One `mavsdk_server` process per session** — memory and PID pressure
  scales linearly with concurrent operators. Unmeasured. **Needs verification.**
- **One re-encode per browser spectator.** No fan-out/SFU. Fine for single
  operators, will not scale to many viewers per drone.
- Vision inference is GPU-bound and serialized per session by the worker
  pool. Concurrent-session capacity is **unmeasured**.

### Coupling

- `signaling.py` knows every video source by string literal. Adding a mode
  touches it, `videoSource.ts`, the settings page, and `VideoStream.tsx` —
  four coordinated edits. Acceptable at this size; worth a registry if modes
  keep growing.
- Vision modules are well decoupled behind `BaseAnalyzer` + `__registry__.py`.

### Security

- **No authentication.** A login/auth system is on the roadmap and not built.
  Export endpoints (`/flights/{id}/download`) are unauthenticated.
- Shared socket.io secret token in `.env` files — never to be printed.
- TURN credentials are minted server-side with a 24h TTL and cached. Good.
- The `udp` bridge now binds `0.0.0.0`, exposing bound ports to the client's
  LAN. Deliberate (ADR-006), overridable via `bindAddress`.
- Registration/owner lookup in `plate_tracker.py` is a documented no-op hook,
  intentionally never wired — a legal boundary. Keep it that way.

### Performance

- Client-side double transcode is the dominant cost, and the whole point of
  the SRT rearchitecture.
- Pixel work is correctly off the event loop.
- `buffered=False` and the zero playout buffer are load-bearing.
- Software HEVC decode measured at ~10ms on client-class hardware.

## Recommendations

1. **Commit everything, now.** Nothing else matters if the desktop app only
   exists on one disk.
2. Extract the shared ffmpeg low-latency option list into one place, or add a
   test asserting the two copies match.
3. Finish the error-reporting audit: grep every `sio.emit("error"` and decide
   whether it should be a `telemetry_status`.
4. Add auth before any external client uses this in earnest.
5. Delete `sitl_relay/single_relay.py`.
6. Measure concurrent-session capacity before onboarding multiple clients.

# CHANGELOG

Newest first. Append only — never overwrite previous entries.

Versions refer to `desktop/package.json` where a desktop build was produced;
backend/frontend changes ship continuously and are dated.

---

## 2026-08-05 (backend — the relay host is now chosen per client)

`allocate_video_relay` returned one fixed address to every client,
`cfg.relay_public_host`. That is the right answer for exactly one kind of
client — a genuinely remote one, which can only reach us via the VPS and its
DNAT down the WireGuard tunnel. For every other client it sent video out to the
internet and straight back to the same host, costing ~40ms and, worse, making
the uplink depend on the client's network permitting outbound UDP on an
arbitrary high port.

That dependency is not theoretical. Measured on a university network: UDP egress
permitted **only on 53 and 123**, while TCP was allowed on a whitelist of web
ports (80, 443, 3478, 8000, 8080-8090, 8443, 8888…) — note 8000 passes but 8001
does not, so no contiguous range exists and no choice of `_PUBLIC_PORT_BASE`
could have helped. SRT is UDP with no ICE/STUN/TURN fallback, so the uplink died
while the LAN video path was untouched: the ground decoder previewed perfectly
and the AI modules received nothing. WebRTC survives the same network only
because TURN relays it over TCP 443.

Now `_relay_host_for` picks per client, and the diagnosis that led there is
worth keeping because two of the four cases were found only by measurement:

- **Loopback, or any of this host's own addresses** → `127.0.0.1`. The second
  half matters more than it sounds: the reference laptop's own UI connects over
  the machine's **public IPv6**, so the peer address looks remote and is not.
  Detected by trying to `bind()` it — the kernel only permits that for a locally
  assigned address, which beats enumerating interfaces and needs no new
  dependency. Both answer IPv4 loopback, never `::1`, because the listener binds
  `0.0.0.0` and accepts IPv4 only.
- **An on-link IPv4 network** (LAN, WireGuard, the decoder's segment) → our
  address on it, from the source address the kernel would pick. A private
  address is *not* on its own evidence of a shared network: with the host on
  10.183.197.7, a client claiming 192.168.0.55 resolved to 10.183.197.7 —
  plausible and unreachable. So on-link networks are read from
  `/proc/net/route`, gateway-less and non-default routes only.
- **Everything else** → `relay_public_host`, unchanged.

`hostConfigured` now tracks the host actually chosen, since a local client has a
reachable address even with `relay_public_host` unset. `relay_prefer_local_host`
(default on) switches the whole thing off: `client_ip` comes from
CF-Connecting-IP/X-Forwarded-For, so a proxy setting neither would make a remote
client look local and be handed an address it cannot reach.

Two sessions were lost before this to a misdiagnosis worth naming: the VPS and
its NAT rules were blamed and were fine. Port 3478 is the standard STUN port and
is scanned constantly from the internet, so `tcpdump` counts on it read as "3478
is forwarded, 3480 is not" when the packets were strangers. Filter captures by
source, and settle direction-of-drop with a third-party prober — nine hosts
worldwide reached the VPS on TCP 3480 while the laptop beside it timed out.

---

## 2026-08-05 (desktop 0.1.54-0.1.55 — no video at the server: the AI modes' missing uplink)

Symptom: overlays and the processed feed never appeared. Backend logged
`Relay ingest … listening srt:3478` and then nothing — no `Relay video
opened`, no `Video track attached`. The pilot's local picture and the server's
AI feed are separate legs, and only the uplink was broken.

### The uplink ignored the negotiated transport (0.1.54)
`allocate_video_relay` tells the client which listener the backend opened, and
`rtspRelayBridge` has always honoured it (`transport: alloc.transport`).
`receiverBridge` never received that field and pushed **SRT unconditionally** —
while the field logs show sessions where the server was `listening udp:3478`.
Silent on both sides: the caller reports a healthy pipeline, the listener waits
out its window and reports no video. Now carried through and honoured on both
backends (`srtsink`/`tcpclientsink`/`udpsink`, and the ffmpeg equivalents).

### Presence is not capability, again (0.1.55)
The transport fix was not enough, and the reason turned out to be the decode
ladder eating the uplink.

The pipeline shape was never wrong — run by hand it pushed 9.5 MB to a local
SRT listener without complaint. What broke it was `nvh264enc`: it registers on
this machine and fails on the first real frame. Two doomed launches plus their
backoff, each tearing down and re-establishing the SRT caller, and the server's
listener — which accepts exactly one caller inside a bounded window — was gone
before the working rung ever started. **A broken encoder presenting as a broken
server connection.**

`probeCapabilities` now VERIFIES each candidate encoder by actually running two
frames through it, rather than asking whether it exists. Straight out of
ADR-005, which reached the same conclusion for VAAPI two months ago; the
lesson simply had not been applied to this bridge.

Verification also caught a second bug immediately: `vah264enc` is a rewrite of
`vaapih264enc`, not a rename, and its properties differ (`qpi`/`qpp`/
`key-int-max`/`target-usage` against `init-qp`/`keyframe-period`/
`quality-level`). The wrong set is a fatal parse error that kills preview and
uplink together. So elements are verified **with the exact properties they will
be given**, not bare.

### Result
Rung 0 on the reference laptop now runs first time, no restarts:

```
nvh265dec -> cudadownload -> videoconvert -> vah264enc   (verified, hardware)
uplink: 9.1 MB of MPEG-TS over SRT in 16s, no errors
```

Previously: two failed launches, ~6s of churn, and an uplink that never
connected.

---

## 2026-08-05 (desktop 0.1.53 — the black screen was a flag I added in 0.1.50)

### Enabling VA-API in Chromium broke decoding outright
0.1.50 added `--enable-features=PlatformHEVCDecoderSupport,VaapiVideoDecoder,
VaapiVideoDecodeLinuxGL --ignore-gpu-blocklist` on the reasoning that Chromium
disables Linux hardware video decode by default, so turning it on must be an
improvement. It was the opposite. Measured by feeding 180 real access units
from the ground decoder to a `VideoDecoder`:

| flags | frames decoded |
|---|---|
| (none) | **180 / 180** |
| `PlatformHEVCDecoderSupport` | **180 / 180** |
| `+ VaapiVideoDecoder(+LinuxGL)` | 1 / 180, then `Decoding error` |
| `+ VaapiVideoDecoder + ignore-gpu-blocklist` | 2 / 180, then `Decoding error` |

Same trap ADR-005 documents one layer down, at the browser instead of ffmpeg:
this laptop's first DRM render node is a firmware-disabled NVIDIA that cannot
service VA-API, and Chromium reaches for it exactly as ffmpeg did. The
`isConfigSupported` "yes" that made HEVC passthrough look viable in 0.1.50 came
from the same broken decoder.

Now only `PlatformHEVCDecoderSupport` ships — it exposes a codec where the OS
has one and forces nothing. Chromium's own default (software unless confident)
turns out to be the policy ADR-005 argues for, already implemented;
`--ignore-gpu-blocklist` exists to defeat it.

### The renderer now degrades instead of failing
`WebCodecsVideo` rebuilds its decoder once with
`hardwareAcceleration: 'prefer-software'` when a decoder that claimed to work
then errors, resuming at the next keyframe. ADR-005's rule applied to the
browser's decoder: attempt, degrade, never fail outright. Protects any client
whose GPU/driver combination is broken in a way no capability query reveals.

### Stale keyframe replay
Separately real, and found on the way. New viewers were sent a cached copy of
the session's FIRST keyframe, borrowed from the fMP4 path where the cached
bytes are a static ftyp+moov header. Here they are a picture, and the live
frames that follow reference whatever keyframe is current — so a decoder got
one stale frame and then deltas depending on a different one. Viewers now wait
for the next real keyframe (bounded by the GOP, which the transcode sets to
~1s), and are re-gated across a pipeline restart.

### Result
`PlatformHEVCDecoderSupport` alone, real decoder stream: **180 / 180 frames
decoded, zero errors.**

---

## 2026-08-05 (desktop 0.1.52 — the black screen: keyframe flags, slices, and a wrong default)

The picture was black on every path. Three bugs in the framing layer, and one
design decision reversed.

### Every delta frame was labelled a keyframe
`h264IsKey` counted SPS (7), and the AU-boundary rule counted the access-unit
delimiter (9), as keyframe markers. Harmless against x264/vaapih264enc, which
emit no AUD — and catastrophic against `openh264enc`, which emits one before
every frame. Measured on the real stream: **180 of 180 access units flagged
key, against 4 actual IDRs.** WebCodecs is then handed delta frames declared
`type: 'key'`, answers `Decoding error`, and shows nothing. That is the error
in the field logs.

A keyframe is now an AU containing an IDR (H.264) or IRAP (H.265) **slice**.
Parameter sets and delimiters describe the picture that follows; they do not
make it a random-access point. Verified against the real capture: 4 flagged, 4
real.

### Multi-slice pictures were cut into one AU per slice
The H.264 splitter inferred a new picture from "a VCL NAL when we already have
one", which is only valid for single-slice frames. `openh264enc slice-mode=auto`
means one slice per thread, so an 8-thread encode produced 8 "access units" per
frame — **2897 AUs and 227 keyframes in 6 seconds from a 24 fps source**, with
ffmpeg reporting `decode_slice_header error`. Now gated on
`first_mb_in_slice == 0`, the H.264 twin of the `first_slice_segment_in_pic_flag`
rule already used for H.265.

Belt and braces: the encoder is set to `slice-mode=n-slices num-slices=1`.
Slices buy parallelism and loss resilience, neither of which applies over a
loopback pipe.

### H.265 passthrough is no longer the default
It was the default on the theory that skipping a transcode must be better. On
real hardware Chromium answered `isConfigSupported` with **true** and then
failed the decode outright — the `fallbackFromHevc` path added in 0.1.50 fired
exactly as designed, which is the right behaviour and the wrong default.

H.264 has none of that ambiguity, which is why `air_unit_srt` transcodes its
preview to H.264 with libx264 and has always simply worked. The receiver now
does the same thing, but on the GPU where one exists — measured 4.4% of a core
against 79% for the software equivalent — and paints via WebCodecs rather than
a buffering `<video>`. Passthrough survives as a Settings toggle, worth trying
on Windows with a modern NVIDIA GPU where the platform decoder is solid.

### Result
Two consecutive runs against the real ground decoder, default settings:

```
codec=h264 backend=gstreamer accel=hardware
H.265 decoded on the GPU (nvh265dec), re-encoded in software (openh264enc)
181 access units, 4 keyframes / 6s     <- 30fps, gop-size=60. Correct.
```

ffprobe decodes the resulting stream cleanly: 1920x1080, frame count matching
the AU count exactly, no errors. Previously 2897 AUs of unusable fragments.

### Note on how much of this mode is actually new
Worth stating plainly, since it came up: on the UDP transport this mode is
nearly identical to `air_unit_srt` — same `udp:5600`, same SDP, same `-c copy`
uplink. The genuine additions are the RTSP and SRT input transports (which are
what let a PC without the RF dongle be the ground station), hardware transcode
where GStreamer exists, and the robustness layer. The preview codec is now the
same H.264 that mode always used.

---

## 2026-08-04 (desktop 0.1.51 — receiver fixes found against the real ground decoder)

First run against real hardware. The mode failed on every transport and walked
its entire decode ladder each time. Five distinct bugs, none of them in the
decoding:

### `air_unit_srt` never released udp:5600
`useWebRTC`'s cleanup listed only `rtsp_relay`, though **both** modes drive the
`rtsp-relay` bridge. Stopping an `air_unit_srt` stream therefore left its
ffmpeg alive holding the port forever — confirmed live, pid 53263 on
`/tmp/hyrak-air-unit-5600.sdp`, still bound minutes after the stream stopped.

Nothing surfaced it until a second mode wanted that port, and then it was
invisible: both binders use `SO_REUSEADDR`, so the newcomer binds
*successfully* and simply never receives a unicast datagram. Indistinguishable
from the radio being off.

Three fixes: `air_unit_srt` added to the cleanup branch; `startStream` now
stops **every** local video producer unconditionally (cleanup can only tidy the
source selected *now*, and the operator changes that in Settings between
sessions); and the receiver preflights the UDP port with an `exclusive: true`
bind, which fails loudly instead of succeeding uselessly.

### `-rw_timeout` is not an RTSP option — RTSP never worked at all
`Option rw_timeout not found` → `Error opening input files: Option not found`,
before it ever dialled the decoder. The correct spelling for the RTSP demuxer
is `-timeout`; `-stimeout` is rejected outright by this build. RTSP appeared to
work only because the ladder was stepping down to GStreamer and succeeding
there — silently costing the passthrough path.

### The probe window was shorter than the keyframe interval
The nastiest one, because it *flapped*. Measured on the air unit's real stream:
**24 fps, 60-frame GOP, keyframe every ~2.5 s**. With `-analyzeduration
1000000` ffmpeg only found VPS/SPS/PPS when the stream happened to be opened
within 1 s of an IDR — so roughly half of all starts died with `dimensions not
set` / `Could not write header`, demoted, and made the decode path look
unreliable when decoding was never involved. Now 5 s (2× measured), with
`STARVATION_MS` and `READY_TIMEOUT_MS` raised to 12 s so neither the watchdog
nor the readiness check shoots a process still waiting for its first keyframe.

### Starvation was being misdiagnosed as a decode failure
The ladder exists for "this element registered but this machine cannot run it".
An empty input fails identically on every rung, so walking all five changed
nothing, took ~30 seconds, and ended by blaming the codec. The watchdog now
flags its own kills, and `isInputFailure()` catches network/404/timeout exits,
both of which retry the same rung instead of stepping down.

One trap worth recording: `isInputFailure` first used a bare `/timeout/`, which
matched ffmpeg's own complaint about the *option name* `rw_timeout` — turning a
fatal bad-arguments exit into an infinite retry. Match phrases, not words. That
retry path is now bounded by `MAX_CONSECUTIVE_RESTARTS` too.

### `start()` reported the plan it began with
After a mid-startup demotion the returned meta still described rung 0, so the
renderer would configure a decoder for a codec no longer being produced. Now
re-read after the readiness wait.

### Result
Five consecutive runs against the real decoder, both transports, all on the
**best** rung with zero demotions:

```
udp  x3  codec=hevc backend=ffmpeg receiving=true  ~3.18 MB / 5 s
rtsp x2  codec=hevc backend=ffmpeg receiving=true  ~3.19 MB / 5 s
```

H.265 passthrough — nothing transcodes, Chromium decodes on the GPU. SRT still
untested; port 8890 on the decoder is closed until MediaMTX gets `srt: yes`.

### Also
`SOURCE_GROUPS` in Settings is now derived from the source catalogue instead of
a hand-written list of three group names — adding the 'Ground decoder' group
had silently dropped it from the dropdown, so the mode existed, worked, and
could not be selected.

---

## 2026-08-04 (desktop 0.1.50 — HYRAK Receiver: the ground decoder's PC-side consumer)

New video source `hyrak_receiver`, new bridge `desktop/src/bridges/receiverBridge.ts`.
Additive: every existing mode is untouched. Spec it implements:
`docs/PC_VIDEO_TELEMETRY_INTEGRATION.md`. Design notes: `docs/HYRAK_RECEIVER.md`.

### The requirement, and what it eliminated
One installer, Windows + Linux + ARM64, nothing else installed, on any client's
hardware. That kills requiring system GStreamer (an install step, Linux-only in
practice) and it kills bundling it (on Linux `libgstvaapi.so` links the *host's*
libva/libdrm/EGL, so a bundled copy initialises into software — 41.3% of a core
against 4.4%). It also kills decoding with the bundled ffmpeg, which cannot
reach a GPU at all (ADR-005).

So the default path decodes in the one place every client already has —
Chromium — and ffmpeg is demoted to a demuxer:

```
decoder --H.265--> ffmpeg -c copy --Annex-B--> WebCodecs --> GPU
```

`ffmpeg-static`'s lack of GPU access stops being a constraint rather than
something to route around, and the same code path serves all three targets.

### Three transports, RTSP by default
UDP (lowest latency, no retransmission), RTSP (we connect outward, TCP keeps
the picture clean but head-of-line blocking is unbounded), and **SRT** — which
the integration doc's trade-off table is missing and which is the one that is
both clean and bounded. On the decoder it is one MediaMTX flag (`srt: yes`) on
the process already serving RTSP, *not* a second `wfb_rx` — which matters
because that board is already at ~40% of its single core.

RTSP is the default despite not being the fastest: UDP is the only transport
needing both the decoder configured with this PC's address and an inbound
firewall exception, and both fail as a black screen rather than a message.

### RTSP latency: one jitter buffer, not two
The integration doc's pipeline sets `latency=50` on `rtspsrc` *and* adds an
explicit `rtpjitterbuffer latency=50` after it. `rtspsrc` contains an
`rtpjitterbuffer` and that property configures it, so the two are in series and
the real budget is 100 ms. Halved for free by dropping the second element.
(`rtspsrc`'s own default is 2000 ms — that number, not TCP, is most of why a
generic client sits a second behind.)

On the ffmpeg backend, `-probesize`/`-analyzeduration` are deliberately **not**
minimised. Driving them to `32`/`0` — the usual low-latency advice — makes
ffmpeg give up before seeing VPS/SPS/PPS and exit with `Could not write header
(incorrect codec parameters ?)`. Found by testing. They bound the startup probe
only and do not affect steady-state latency.

### A ladder, because element presence proves nothing
Measured on the reference laptop: `nvh265dec` decodes correctly while
`nvh264enc` returns `Could not configure supporting library`. NVDEC alive,
NVENC not. Pairing them and giving up shows no video; demoting straight to
all-software discards a working hardware decoder. So the bridge builds an
ordered ladder (passthrough → hw/hw → hw-decode+sw-encode → sw/sw → bundled
ffmpeg) and steps down a rung when one dies on arrival. Verified: rung 0 fails
on that laptop, rungs 1-5 all produce correct output.

Also fixed in passing: a hardware decoder outputs a GPU surface that
`videoconvert` cannot consume, and the resulting `not-negotiated` is reported
by gst-launch against the **source** element — so it reads as "the network
stopped". Each decoder now gets its matching converter, existence-checked
first.

### Robustness, from the integration doc's open items
- **Starvation watchdog** (open item 1, the RF dongle dropping off USB): a live
  process parked on a dead socket shows a frozen frame and reports success. Six
  seconds without bytes forces a reconnect.
- **Exponential backoff, capped at 15 s, 8 attempts** (open item 4: a stuck
  client drove MediaMTX to 44% CPU through reconnect churn alone, which starved
  `wfb_rx` and looked exactly like RF loss).
- **`start()` waits to see video** before returning ok. The bridge this
  parallels returns `ok:true` on spawn, so a pipeline that died in 80 ms
  surfaced as a mystery 25 s later.

### Supporting changes
- `desktop/src/bridges/annexb.ts` (new) — Annex-B splitting extracted from
  `gstreamerBridge` and taught H.265. Not a wider NAL mask: H.265 carries
  `first_slice_segment_in_pic_flag`, and 1080p H.265 is routinely multi-slice,
  so inferring boundaries the H.264 way would cut one picture into several
  "access units" and the decoder would emit nothing. H.264 behaviour unchanged.
- `frontend/src/lib/codecString.ts` (new) — derives `avc1.*` / `hvc1.*` from
  the stream's own SPS, and `canDecodeHevc()`. Verified against `ffprobe`.
- `WebCodecsVideo` takes a `codec` prop, read from the bridge's status rather
  than from what was requested — the bridge can step down mid-session, and
  configuring the wrong codec is a black pane with no error.

### Chromium had no HEVC decoder at all on Linux — fixed with two switches
Measured with `VideoDecoder.isConfigSupported` on Electron 32.3.3 / Chromium
128 rather than assumed, because this decides the whole mode:

| | default | with switches |
|---|---|---|
| HEVC Main L3.1, prefer-hardware | false | **true** |
| HEVC Main L3.1, no-preference | false | **true** |
| H.264 High, prefer-hardware | false | **true** |

Off by default there is **no HEVC decoder whatsoever** — not even software — so
every Linux client would have transcoded (≈a core at 1080p30, or a system
GStreamer to avoid it). `app-main.ts` now sets
`--enable-features=PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL`
plus `--ignore-gpu-blocklist`. (`--use-gl=egl` was tried too and must NOT be
added — it turns every result back to false.) These can only widen what is
available: if the GPU cannot deliver, `isConfigSupported` reports false and the
receiver transcodes as before.

Two related fixes: `canDecodeHevc()` now probes `no-preference` as well as
`prefer-hardware` (the table above shows even H.264 reporting false for the
strict form), and `fallbackFromHevc()` restarts once on the transcode path when
the renderer's decoder actually *errors* — `isConfigSupported` is a claim, and
the bridge's ladder cannot see a failure happening one process away in the GPU.

### Packaging: three targets, and a trap that shipped the wrong binary
- `linux.artifactName` had no `${arch}`, so an x64 and an arm64 AppImage would
  have overwritten each other. Now `HYRAK-${version}-${arch}.AppImage`.
- **`ffmpeg-static`'s installer no-ops when the file already exists**, and
  linux-x64 and linux-arm64 write to the *same* filename. The first arm64 build
  therefore packaged an **x86-64 ffmpeg** — it reported "ffmpeg is installed
  already" and looked like a clean build. New `ffmpeg:clean` runs before each
  arch, and the arm64 scripts restore the x64 binary afterwards. (Windows was
  never affected: `ffmpeg.exe` is a different filename.)
- Added `dist:linux:arm64` / `release:linux:arm64` and `release:win`.

Built and verified per artifact: linux-x64 → x86-64 ffmpeg, linux-arm64 → ARM
aarch64 ffmpeg + aarch64 Electron, win-x64 → PE32+ ffmpeg.exe.

### Verified / not verified
UDP and SRT end to end on both backends; splitter, codec strings and the ladder
all checked against real bitstreams; HEVC support measured on Linux; all three
installers built, binary-checked and launched. **Not** run: RTSP (no local
MediaMTX), the real decoder, and Chromium HEVC on Windows or ARM64.

**Not signed.** Windows will show SmartScreen on first run — `CSC_*` is still
unconfigured, and that is procurement rather than code.

---

## 2026-08-01 (frontend/backend — telemetry disconnect, real perf stats, settings rework)

### Telemetry could be connected but never released
The backend has handled `disconnect_telemetry` all along (ends flight
recording, drops zone monitoring, clears the session drone) — nothing in the
UI ever emitted it, and `TelemetryConnect` hid its whole control block once
connected. Added `disconnectTelemetry`, which stops the LOCAL relay first
(Web Serial / native serial / native RF) before telling the server: a relay
still pumping would immediately re-establish the link from its own traffic.

### AI module stats were reporting on the wrong transport
The panels read `pc.getStats()`. In client-overlay mode **no video crosses the
PeerConnection in either direction** — the picture is local, the server pulls
its own copy over SRT, and only detection JSON is on the socket. So there is
no inbound-rtp and no outbound-rtp, every field sat at 0 permanently, and the
readout described a transport the video does not use.

New `ModulePerformance`, shared by all seven panels, sourcing each figure from
where the video actually is: inference and pipeline cost + `delivered_fps` /
`source_fps` (new, server-measured — the browser cannot derive them), local
paint rate counted in the WebCodecs renderer, and decode path. A metric that
does not apply to the active transport now says so instead of showing a zero
that reads as a fault.

### Settings
* Video source: 9 chips -> grouped dropdown, with a one-line explanation of
  what the selected source does and a warning when it needs the SERVER (not
  this laptop) to reach the source.
* Sources now declare which rows they need (`VIDEO_SOURCES[].needs`). The
  hand-written per-row gates are how `air_unit_gst` came to be missing from
  one and present in another — the SRT dial did not render on the mode that
  needs it most. Air-unit modes also no longer show an RTSP camera URL field,
  and capture resolution/fps are hidden for backend-sourced modes.
* Added the GStreamer jitter buffer and decode-path rows, which had **no UI at
  all** — that is how a stale jitter value could sit in localStorage silently
  overriding a fix with no way to see it.
* New **Comm links** tab: link status + disconnect, and persisted defaults for
  MAVLink address and radio baud, which were literals at their point of use
  and retyped on every connect.

---

## 2026-08-01 (frontend — duplicate boxes, panel jitter, dishonest Start button)

### Duplicate box for the same person (regression in the smoother)
IoU-only association could not re-acquire a subject who moved further than
their own width during a detection gap: overlap hits 0, no match is found, a
second track spawns — and because the first is still inside its 320ms hold,
the SAME person is boxed twice, in two places. Introduced by the smoothing
added earlier today.

Fixed with velocity-predicted, globally-best-first matching:
* each track keeps a smoothed centre velocity (association only — never used
  to move what is drawn, which would slide boxes on no evidence);
* if IoU fails, a track still matches when the new centre is within 1.6x its
  own size of where it was predicted to be — scaled by size, so it is
  resolution- and distance-independent;
* pairs are scored globally and consumed best-first, instead of each item
  taking the first acceptable track in payload order.

Verified: 3 skipped intervals with the subject moving 30px each -> 1 track,
not 2. Two distinct people stay 2. A new detection far away still spawns its
own track rather than stealing one.

### Results panels updated 12x/second
`lib/panelSmoothing.ts` — counts ease, timings use a rolling median (an
outlier is noise, and a mean drags the readout), and list membership is held
900ms so cards and rows dim instead of popping out. The overlay itself keeps
full frame rate; only figures a human READS are settled.

### "Start Analysis" looked like a dropped click
`setIsStreaming(true)` fires from `pc.ontrack` / `oniceconnectionstatechange`,
seconds after `startWebRTC()` resolves — but `isLoading` cleared in the
`finally` as soon as signaling finished. In between, both were false and the
button reverted to its idle label while work was plainly in flight, then
jumped to "Stop". Added a `pending` state spanning click -> stream actually
live (35s backstop), and the label now names the phase: "Loading model..." /
"Connecting...".

---

## 2026-08-01 (frontend — overlay annotations no longer strobe)

Reported as "packets or frames dropping when server is receiving, annotations
missing mid-stream for a split second". It is not loss. `CvOverlayCanvas`
redrew only when `cvResults` changed and cleared the canvas first, so:

* a single payload where a detection fell under `conf=0.4` — a person turning,
  a plate glaring, a partial occlusion — erased the box for a whole interval;
* boxes teleported between results, because nothing rendered in between.

Inference is a ~12Hz **sampled** signal being drawn as if continuous.

**`lib/overlaySmoothing.ts`** keeps a short-lived track per object and the
canvas now renders on `requestAnimationFrame`, decoupled from socket arrivals:

| behaviour | value |
|---|---|
| hold before fading | 320 ms (~4 inference intervals) |
| fade out / in | 260 / 110 ms |
| position smoothing | `1-exp(-dt/55ms)`, frame-rate independent |
| identity | tracker id when present, else IoU ≥ 0.3 within the same class |

Verified: one dropped payload holds the box at `a=1.00`; a genuine departure
reaches `a=0.76` at 300ms and is removed by 700ms; a payload with items
reordered yields 2 tracks, not 4 ghosts.

Constrained on purpose — it may hold and move a detection the server produced,
never invent one it did not. The server keeps emitting raw, unsmoothed truth.

---

## 2026-08-01 (latency — SRT window 300 -> 150, demuxer reorder 100ms -> 0)

Measured: relay is Vultr **Bengaluru**, ICMP RTT from the server **41.8ms avg**
(34.5 min / 49.9 max, 0% loss). SRT wants 2.5-4x RTT, so the useful band is
105-170ms. 300 was ~7x — an over-correction made to explain corruption that
actually came from the desktop shedding compressed frames (fixed in 0.1.49).

Also removed `max_delay=100000` on the relay's MediaPlayer. It is an RTP
reorder window, and the comment beside it already said SRT delivers in order —
so it was 100ms of insurance against something that cannot happen on this
transport, paid on every frame the AI sees.

| stage | before | after |
|---|---|---|
| GStreamer jitter buffer | 60 | 60 |
| SRT TSBPD window | 300 | **150** |
| demuxer reorder | 100 | **0** |
| **before processing starts** | **~460ms** | **~220ms** |

Recorded because it is not obvious: SRT's latency is a **fixed** delay, not a
ceiling. TSBPD releases every packet at a constant offset from its send
timestamp, so a healthy, stable link never converges to something lower. The
number set here is paid for the whole session.

---

## 2026-08-01 (backend — measure the live-edge stall instead of blaming it)

0.1.49 fixed the corruption (`Could not find ref with POC` is gone, ~29 fps
now arrives intact) but delivery is still pinned at 1.0 fps.

**Two hypotheses tested and rejected**, recorded so they are not re-tried:

- *Compute.* The real `recv()` path with real YOLO on CUDA sustains
  **28.5 fps** at 1080p in a harness. Component costs: `to_ndarray` 0.8ms,
  `_compose` 1.6ms, libx264 encode 8.9ms — ~100 fps of headroom.
- *aiortc's `_throttle_playback`.* It IS wrongly enabled on our UDP paths
  (`mpegts` and `sdp` are absent from `REAL_TIME_FORMATS`; `rtsp` is present,
  which is why SIYI never showed this). But it cannot cause the collapse:
  `asyncio.sleep()` returns immediately on a negative wait, so it only ever
  throttles a consumer running *ahead* of realtime. Reproduced at 30 fps with
  the throttle both on and off, including after a forced 3s stall.
  `as_live()` still added — a live source must never be PTS-paced — but it is
  **not** the fix for this.

**Changed:** the live-edge warning no longer asserts a culprit. It named
"analysis + the outbound H.264 encode" without measuring either, and that
assertion sent the investigation at a pipeline with 100× the headroom it
needed. It now reports per-stage timing, including `outside` — the wall time
between returning a frame and being called again, which covers aiortc's
encode and any event-loop starvation. The previous line could only blame code
it could see; the bottleneck is not in that code.

---

## 2026-08-01 (desktop 0.1.49 — AI modes: the uplink was being corrupted, not overloaded)

### Symptom
AI modes unusable. Server log: continuous `Could not find ref with POC N`,
`cu_qp_delta … outside the valid range`, `CABAC_MAX_BIN : 7`, alongside
`dropped ~90 stale frame(s) in 5s … (1.0 fps delivered downstream)`.

### It was not compute
Measured on the reference machine (RTX 4070 laptop, 24 cores), per frame at
1080p through the server round trip:

| stage | cost |
|---|---|
| `to_ndarray(bgr24)` (recv path) | 0.8 ms |
| `from_ndarray` (`_compose`) | 1.6 ms |
| libx264 encode + packetise | 8.9 ms |
| **total** | **~10 ms → ~100 fps of capacity** |

YOLO runs on CUDA with `half=True` and is decoupled from `recv()` anyway
(`BaseAnalyzer.submit_frame` is non-blocking). Delivering 1.0 fps against
100 fps of headroom is a factor of 100 — so the frames were not arriving
decodable. The decoder could only emit around keyframes, which is what
produces "90 skipped + 1.0 delivered": the source stream was broken.

### Root cause — three places that discard compressed video
The `tee` splits the H.265 elementary stream *before* any decoder, so
anywhere in this path "drop a buffer" means "break every frame until the
next IDR". All three were configured to drop aggressively:

1. **`rtpjitterbuffer latency=10 drop-on-latency=true`.** The frontend
   default was 10ms, the bridge's 20ms. `drop-on-latency=true` does not
   delay a late packet, it discards it — and ordinary Wi-Fi jitter exceeds
   10ms, so this destroyed packets on links that had lost none. For scale,
   GStreamer's own defaults are `latency=200` and `drop-on-latency=false`;
   we were 20× tighter with dropping forced on. Now 60ms, floor 30ms.
2. **`queue leaky=downstream max-size-time=500ms` on the uplink branch.**
   One Wi-Fi retransmit burst or SRT congestion window was enough to shed
   compressed access units. Split into `previewQ` (1s, loopback) and
   `uplinkQ` (3s — it crosses Wi-Fi, WireGuard and the public internet, and
   SRT recovers transient loss within its own window if allowed to).
3. **`srtLatencyMs ?? 120`** while frontend `DEFAULT_RELAY_LATENCY_MS` and
   backend `DEFAULT_LATENCY_MS` were both 300. Any path not passing the
   value explicitly asked for a window under 3× the measured 41ms RTT — too
   short for SRT to NAK and get a resend. Now a named constant, 300.

### Also
`getGstJitterMs` floor raised 0 → 30. A value stored while 10 was the
default would otherwise keep overriding the fix indefinitely — the same
failure mode that pinned relay latency at 20ms.

### Trade accepted
The jitter buffer adds real latency to the local preview. 60ms of delay is
worth less than a stream the AI modes cannot decode.

---

## 2026-07-31 (desktop 0.1.43 — GStreamer air-unit pipeline: one owner of udp:5600)

### Why
The DataChannel path reads video in JavaScript, and the bundled ffmpeg cannot
touch a GPU (`-hwaccels` reports only `vdpau` — no VAAPI/QSV/NVENC). Both
limits are structural, and `gst-decode.sh` on the client's own machine shows a
flawless ~10ms picture using `vaapih265dec`. So: a new bridge, not a rewrite —
every shipped mode is untouched.

### Measured (1080p20 H.265, reference machine)
| path | CPU |
|---|---|
| current ffmpeg preview (software only) | ~79% of a core |
| GStreamer software | **41.3%** |
| GStreamer hardware (VAAPI) | **4.4%** |

~18x cheaper on hardware; even the software path halves ffmpeg's cost.

### `gstreamerBridge.ts`
One pipeline owns udp:5600 and serves both consumers:

```
udpsrc :5600 ! rtpjitterbuffer ! rtph265depay ! h265parse config-interval=-1 ! tee
   ├── queue ! vaapih265dec ! vaapih264enc ! mp4mux  -> loopback HTTP preview
   └── queue ! mpegtsmux alignment=7 ! srtsink       -> server AI, bit-exact H.265
```

- **No JS in the packet path.** GStreamer binds the socket directly, so the
  single Electron event loop — which silently dropped datagrams once its
  buffer overflowed (0.1.42) — is out of the picture entirely.
- **Adaptable, as required**: probes VAAPI, falls back to
  `avdec_h265`/`x264enc`, and **auto-demotes to software** if a hardware
  pipeline dies twice quickly (the "element exists but this GPU can't service
  it" trap). The ACTIVE path is always reported, never assumed.
- `config-interval=-1` repeats SPS/PPS/VPS with every keyframe — the fix for
  the `PPS id out of range` the server logged when attaching mid-stream.
- Uplink is remuxed, never transcoded; passphrase + pbkeylen 16 match the
  backend listener. Both secrets redacted in status and logs.

### Three bugs found by testing, not review
1. **`mpegtsmux alignment=7` is mandatory.** Without it the muxer emits
   arbitrary buffer sizes, srtsink sends them verbatim, and the receiver
   parses nothing: connection establishes, GStreamer reports no error, and the
   listener writes **zero bytes forever**. Measured 0 B without, 1.79 MB with.
2. **srtsink takes properties, not URI query params.** The ffmpeg form
   (`?mode=caller&latency=…`) fails silently.
3. **Units differ**: GStreamer `latency` is milliseconds, ffmpeg's is
   microseconds — passing the ffmpeg value asks for a two-minute buffer.

### Relay ports 9000-9100 -> 3478-3578
Measured on the operator's network: UDP to 9000 and 443 was dropped before
leaving the network while 3478 (STUN) and 8801 (Zoom) passed. 3478 is
permitted by any network allowing video calls. Backend constants, VPS DNAT,
manifest and srt-deployment.md changed together; verified end to end.

### Not yet wired
The bridge is registered and tested but has no frontend entry point yet — no
video source, no settings. Nothing uses it until that lands.

---

## 2026-07-31 (desktop 0.1.42 — the socket WE bind never got the buffer we give ffmpeg)

### Correction to 0.1.41's diagnosis
0.1.41 capped the preview at 720p on the theory that the client's i5 could not
sustain the 1080p x264 encode. Field result with client-overlay **confirmed
engaged**: no improvement. The test changed the wrong variable — the preview
encode is a SEPARATE ffmpeg process, while the suspected bottleneck is the
Electron **main process**. The cap only cost resolution and is reverted
(`previewMaxHeight`, now a frontend setting so the next value needs a page
reload, not a reinstall on a remote operator's machine).

### The actual mechanism
`air_unit_datachannel` is the only transport that reads video **in
JavaScript**: ~332 datagrams/s each go through the main process — read, copy to
two fan-outs, then werift's userspace SCTP + DTLS encrypt — all on ONE event
loop shared with the whole app. While that loop is busy, nothing drains the
socket, and Node's default receive buffer is **212992 bytes = 0.43s** of a
4 Mbps stream (measured). Past that the KERNEL discards datagrams — before any
copy is made, so the preview and the server corrupt identically, and the app's
own `received` counter never sees the loss.

This is why gst-decode.sh stays perfect on the same machine (separate process,
does nothing but read), and why the SIYI/RTSP paths were never affected:
there, ffmpeg owns the socket end to end and Node never touches a video packet.

`rtspRelayBridge` has always passed ffmpeg `-buffer_size 425984` for exactly
this reason. The socket the sender binds itself never got the same treatment.

### Fixed
- `bindExclusive` now requests 4 MB SO_RCVBUF (constructor option *and*
  `setRecvBufferSize`, since platforms differ on which is honoured).
- Measured: default **212992 (0.43s)** → **425984 (0.85s)**. A real doubling,
  but Linux silently clamps to `net.core.rmem_max`, so the 4 MB request is NOT
  granted on a stock system. To go further the client needs
  `sudo sysctl -w net.core.rmem_max=8388608` (persist in
  /etc/sysctl.d/). Documented rather than assumed.
- The GRANTED size is now reported in sender status (`recvBuffer`), because a
  silent clamp is invisible and looks exactly like a bad radio link.

### Still open
A buffer only buys time against a stall; it does not stop the stall. If loss
persists at 0.85s of headroom, the fix is to stop routing video through the JS
event loop at all (ffmpeg owning the socket, as every other transport does) —
which is also what the SRT path does by construction.

---

## 2026-07-31 (desktop 0.1.41 — the preview survives weak CPUs, busy ports, and its own event stream)

### First: 0.1.40's architecture was confirmed live
`Client-overlay pipeline for session 664dda24` — the local-view path engaged
in the field, after two frontend fixes (no rebuild, hot-reloaded):

- **The event-filter bug that hid the preview.** The relay bridge emits an
  informational `{codec, streamInfo}` status ~1s after ffmpeg reads the
  stream. Both frontend listeners (`airUnitPreview.ts` and
  `useRtspRelayBridge`) treated any non-connected, non-reconnecting event as
  a shutdown and wiped `previewUrl` — so every field run computed
  `clientOverlay` with `preview=none` and silently fell back to the 500ms
  round trip. Never seen locally because the repro drove the bridge without
  the listener. Lifecycle events are now recognized by the presence of a
  `connected` field; informational ones are ignored.
- Preview failures now log loudly with ffmpeg's stderr tail (`console.error`
  → Next's [browser] forwarder → frontend.log), because the client is remote
  and server-side logs are all there is.

### 0.1.41
- **Preview transcode capped at 720p** (`previewMaxHeight`, 0 = native).
  Field failure on an i5-8350U: the 1080p20 libx264 encode can't sustain
  realtime, ffmpeg stops draining udp:5602, the kernel buffer overflows, and
  each dropped packet is up to 3s of white noise — appearing "after a few
  seconds", once the buffer first fills. gst-decode on the same machine is
  clean because it only decodes. 720p halves the encode (0.79 → 0.56 core
  measured); display-only — the AI uplink stays bit-exact 1080p, and overlay
  geometry is CSS-scaled so boxes are unaffected.
- **`udpPortAutoPick`**: the preview's source port is a preference; the
  bridge probe-binds (exclusively — SO_REUSEADDR steals packets silently)
  and steps past busy ports, reporting the choice in `meta.udpPort`. The
  frontend aims the sender's fan-out copy at the reported port.
- **ffmpeg spawn 'error' handled** in rtspRelayBridge — was an uncaught
  exception in the main process on ENOENT-class failures.

---

## 2026-07-31 (desktop 0.1.40 — local-view architecture: the pilot's video no longer round-trips)

### Why
Even with every transport fix in place, `air_unit_datachannel` showed 500ms+
latency and accumulating white noise, drastically worse in Modules than Fly.
Root cause is architectural, not a bug: the operator's picture traveled
uplink → server H.265 decode → (analysis) → server H.264 re-encode (0.79
core/session, the thing that capped delivery at 8.3fps of a 20fps source) →
downlink → jitter buffer — while gst-decode reading the same udp:5600 shows a
10ms picture. No transport can fix a path that long; the fix is to stop
watching through the cloud.

### The architecture now
- **Watch locally**: the rtsp-relay bridge gains a second life as a
  preview-only instance (`frontend/src/lib/airUnitPreview.ts`, bridge id
  `air-unit-preview`): `uplink: false`, `source: 'udp'`, H.264-transcoded
  preview (Chromium has no software HEVC decoder) served as fMP4 over
  loopback HTTP. Fly and Modules both render it.
- **Upload for AI unchanged**: the DataChannel still carries the original
  H.265 to the server. Its latency and occasional loss now cost a few frames
  of *analysis*, not the pilot's eyes.
- **Overlay results client-side**: `clientOverlay` is no longer forced off
  for server-sourced feeds (backend `signaling.py` now trusts the client's
  flag; the client only sends it when the preview is actually running).
  Server skips the return encode entirely; `CvOverlayCanvas` draws
  `cv_results` JSON over the local preview in Modules.
- Feed-mode setting still applies: 'processed' (and depth/enhance, which
  transform the frame) keep the old server-composited return path.

### Desktop 0.1.40
- `webrtcSenderBridge`: new `previewFanoutPort` — a second verbatim UDP copy
  (default 5602) for the preview ffmpeg, alongside the operator's external
  fan-out (5601). One port, one listener — each consumer needs its own copy.
- **Single-instance policy revisited** (third iteration, new evidence each
  time): `reapOutdatedInstances()` kills running instances of an OLDER
  version even when their AppImage mount is still healthy — the case
  reapStaleInstances couldn't see, where a leftover old version silently
  holds udp:5600 after a reinstall. Then `requestSingleInstanceLock()`
  arbitrates same-version duplicates (second launch raises the first's
  window and exits). `HYRAK_MULTI=1` skips both for side-by-side builds.

### Expected numbers
Pilot's glass-to-glass: local decode class (gst-decode measured ~10ms; the
fMP4/`<video>` path adds the preview transcode + fragment latency — tens of
ms, clamped to live edge). Overlay boxes lag by uplink + inference, which is
fine — they move over live video. Server cost per overlay session drops by
the whole 1080p re-encode (0.79 → ~0.10 core).

---

## 2026-07-31 (desktop 0.1.39 — air_unit_srt was rejected by its own bridge)

### Confirmed working first
0.1.38's timeout change fixed the DataChannel handshake:

```
00:49:43  PC for d8377ada: connecting
00:49:44  PC for d8377ada: connected
00:49:44  DataChannel open for d8377ada (label=media)
```

Connected in **1s** where the old 10s deadline had been firing. It then stopped
at `Nothing arriving on udp:5600` — the air unit is not transmitting, which is
the reported hardware issue, not a fault in this path.

### Fixed
`Relay start failed: RTSP url required` — a defect introduced with
`air_unit_srt` in 0.1.36. `rtspRelayBridge.start()` opened with an
unconditional `if (!cfg.url)`, written when RTSP was the only source. The air
unit's input is a local UDP port described by a generated SDP, so it correctly
passes `url: ''` and was rejected before doing anything.

The server side was already fine — `Relay ingest for session 90fe653d listening
srt:9000` in the same log — so this was purely the client refusing to start.

- Validation is now per-source: a url is required only for `source: 'rtsp'`,
  and a UDP port only for `source: 'udp'`.
- `describeFailure()` also assumed a camera: on a connection failure it said
  "Can't reach the camera at  — is the laptop on the SIYI hotspot?", with an
  empty url and advice aimed at the wrong device. The air unit now gets its own
  message naming `udp:5600` and the ground station.

---

## 2026-07-31 (desktop 0.1.38 — the handshake deadline was shorter than the handshake)

### Why
`DataChannel did not open within 10000ms (state: connecting)` again, on 0.1.37 —
so the 0.1.35 URL-ordering fix was not the whole story. Both halves were then
checked directly, and **both are healthy**:

| side | library | result |
|---|---|---|
| client | werift | `{host:4, srflx:2, relay:1}` in 0.5s |
| server | aiortc | `{host:4, relay:1}` in **5.0s** |

aiortc parses `turns:` correctly (`turn_ssl = scheme == "turns"`) and aioice
supports TLS TURN, so the relay path exists on both ends. Nothing was broken —
it was **too slow for the deadline**.

`CHANNEL_OPEN_TIMEOUT_MS` covered the entire ICE + DTLS + SCTP handshake in 10s.
On a UDP-blocked network every candidate on both sides is a TURN relay reached
over TLS/TCP, and server-side gathering alone measured **5.0s** — half the
budget spent before the client had done anything. Corroborated in the backend
log: `DataChannel ingest` at `00:42:55`, `PC ... connecting` at `00:43:00`.

The timeout was firing on a connection that was still legitimately progressing,
and reporting it as a hard failure.

### Changed
- `CHANNEL_OPEN_TIMEOUT_MS` **10s → 30s**. Costs nothing on a fast path (the
  channel opens and it never fires); the difference between working and not on a
  relayed one.
- Failure message now reports **ICE state alongside channel state**. `connecting`
  alone cannot distinguish "still negotiating" from "no route exists", and those
  call for opposite responses. `ICE: failed` now says the relay was unreachable;
  anything else says the path was still being established.

### Note on diagnosis
Two earlier readings of this symptom were incomplete. 0.1.33 called the missing
`srflx` a NAT characteristic (it was a UDP-blocking firewall); 0.1.35 fixed a
real bug — the sender did commit to UDP TURN — but treated it as the whole
cause. It was necessary, not sufficient. The deadline was the rest.

---

## 2026-07-31 (0.1.37 — the SRT listener accepted anyone)

### Why
Raised by the deployment question: the client is remote and the server is
hosted, so the SRT listener has to sit on a **raw public UDP port**. It cannot
go behind the cloudflared tunnel, which carries no arbitrary UDP.

Reviewing that exposure found the listener was **unauthenticated**. The client
sent `streamid=<token>` and the server generated one — but `_listen_url` never
inspected it, so ffmpeg's SRT listener accepted **any** caller reaching the
port. `streamid` authenticated nothing. Anyone who found an open port in
9000-9100 could have pushed their own video into an operator's session.

### Fixed
- **SRT `passphrase` + `pbkeylen=16` + `enforced_encryption=1`**, using the
  per-session token that already existed. One mechanism doing two jobs: the
  handshake fails without the secret (admission control) and the media is
  AES-encrypted in transit. `enforced_encryption` stops a caller falling back to
  plaintext.
- Log redaction extended to `passphrase=` — it is the same value as `streamid`
  and is now the actual credential, so leaking it into a status event or log
  would hand over the ability to push into the session.

### Verified
Three callers against a live listener:

```
wrong passphrase                 REJECTED
no passphrase                    REJECTED
correct passphrase               ACCEPTED
```

(The first attempt showed all three rejected — the third was failing on
`first pts and dts value must be set`, a raw-elementary-stream artefact of the
test source, not authentication. Re-run against a properly timestamped MPEG-TS
clip to isolate it.)

### Still blocking a remote SRT deployment
`relay_public_host` is currently **`10.183.197.7`** — an RFC1918 private
address, while the machine's egress is `27.59.61.160`. SRT therefore works only
when client and server share a LAN. A remote client needs the backend on a host
with a real inbound-reachable address and UDP 9000-9100 open. This is a
deployment constraint, not a code one, and it is the reason the DataChannel
transport exists.

---

## 2026-07-30 (0.1.36 — air_unit_srt, and a latent freeze in the existing relay)

### Fixed first: the relay would hang on any long session
Found while re-reviewing the existing SRT code. `RelayIngest` spawned ffmpeg with
`stderr=subprocess.PIPE` and **never drained it while the process was alive** —
`stderr_tail()` only read once `poll() is not None`, i.e. after exit.

stderr is a pipe with a ~64KB kernel buffer. Once full, ffmpeg **blocks on
write() and stops relaying video**, silently and permanently. A live feed emits
warnings steadily ("Non-monotonous DTS", PES errors), so any relay left running
long enough would freeze with no error anywhere. Demonstrated:

```
no drain (old code)    *** BLOCKED — pipe full, child never finished ***
drained (new code)     exited=0  stdout='FINISHED'  ringlines=60
```

The desktop side never had this bug — `rtspRelayBridge.ts` attaches
`proc.stderr.on('data')` with a 4000-char tail. The backend now does the
equivalent: a daemon thread draining into a bounded 60-line ring, and a
`stderr_tail()` that works **while running**, which is when a stalled relay
actually needs explaining. It proved itself immediately during testing — a
listener failure that would have printed `(nothing)` reported ffmpeg's real
error instead.

### Also corrected: the SRT latency default was self-defeating
`60ms` is ~1.7x the measured RTT (ICMP 1.1.1.1 avg **35.7ms**, TCP connect to
Cloudflare **29ms**). SRT needs 2.5–4x RTT for a NAK plus resend to complete, so
60ms was too tight to recover anything while still adding its full 60ms to the
delay — the worst of both. Now **120ms** (~3.4x), in `DEFAULT_LATENCY_MS` and
matched in `videoSource.ts`.

### Added: `air_unit_srt`
The air unit over SRT, as an additional source. Deliberately **reuses the entire
relay path** rather than adding a parallel one — only ffmpeg's input leg
differs, so it is a `source: 'rtsp' | 'udp'` flag on `rtspRelayBridge`, not a
second bridge. Duplicating it would have meant two copies of the tee, uplink and
reconnect logic to keep in step.

- **`writeAirUnitSdp()`** — RTP on a bare UDP port is self-describing only up to
  the payload *type*; nothing says "H.265". The SDP supplies it, byte-identical
  to the server's in `udp_video_source.py` and the caps in `gst-decode.sh`. All
  three must agree or the payload is parsed as the wrong codec.
- **Backend: three lines.** `air_unit_srt` joins `server_sourced` and the two
  `rtsp_relay` branches. The relay is defined by how video *arrives*, not by
  what the client pointed ffmpeg at — by the listener both are MPEG-TS carrying
  untouched frames.
- **No preview branch** for the air unit: it is H.265, Chromium has no software
  HEVC decoder, and the operator already has a zero-cost local view via the
  fan-out port. A second encode would be pure waste.

### Verified end to end
Full production chain with a simulated air unit — RTP/H.265 on a UDP port →
bridge ffmpeg (`-c copy`, real args) → SRT → `RelayIngest` → loopback → PyAV:

```
listener srt:9000 -> loopback udp:5700  latency=120ms
track opened in 12.2s
first frame 1920x1080 yuv420p
decoded 40 frames end-to-end
```

**Note the 12.2s open.** That is the `open_track` retry loop waiting out ffmpeg's
MPEG-TS probe, well inside the 25s timeout but slow enough that a user would
notice. Not tuned here — worth revisiting if it behaves the same on a real link.

### Not verified
No aircraft — SRT was exercised against a generated 1080p H.265 clip, not the
real RF link. Untested on hardware: actual latency, behaviour under RF loss, and
whether the server's `relay_public_host` is reachable from the client's network.
SRT is **UDP-only**, so on the UDP-blocking network from 0.1.35 it will not
connect at all — that is expected, and the reason DataChannel remains.

---

## 2026-07-30 (desktop 0.1.35 — the sender committed to UDP TURN on a UDP-blocked network)

### Why
Every DataChannel attempt died as `did not open within 10000ms (state:
connecting)`, with the server logging `connecting -> failed` and
`0 packets, 0.0 MB`. ICE never completed, which is *below* the SCTP change in
0.1.34 — that was not the cause.

The network had changed to `172.18.142.115/22` (institutional). A raw STUN
binding request from this machine:

```
stun.cloudflare.com:3478   TIMEOUT (UDP blocked or filtered)
stun.l.google.com:19302    TIMEOUT (UDP blocked or filtered)
```

Outbound UDP is blocked, so UDP TURN cannot allocate and there are no `srflx`
candidates at all.

Cloudflare returns TURN urls with `turn:...:3478?transport=udp` **first**, and
werift's `parseIceServers()` takes the FIRST `turn:` url and reads the transport
straight off it:

```js
if (!options.turnServer && parsed.kind === "turn") {
    options.turnServer = parsed.address;
    options.turnTransport = parsed.transport;
```

So the sender committed to UDP TURN on a network where UDP cannot work.

Two things that look like they should have saved it, and don't:
- werift's **UDP→TCP fallback** only fires when the UDP allocation *rejects*. A
  silently-dropped datagram just times out, and the 10s DataChannel deadline
  fires first.
- **`forceTurnTCP`** is ignored here — `resolveTurnTransport()` returns the
  url-parsed transport *before* consulting it.

Url ordering is the only lever that decides this.

### Fixed
- **`sortRelayUrls()`** in `useDataChannelSender.ts`, mirroring
  `_sort_relay_urls()` in `signaling.py` — which had done exactly this for
  aiortc since it was written, for the same first-url-wins reason. The backend
  protected itself; the sender was left on the raw provider order.
- Verified by feeding the **live** `/api/webrtc/ice-servers` response through
  werift's own `parseIceServers()`:

  | | turnServer | turnTransport |
  |---|---|---|
  | before | `turn.cloudflare.com:3478` | **udp** |
  | after | `turn.cloudflare.com:443` | **tls** |

  `tls` routes to `TlsTransport.init()` in werift's `createTurnClient` — a fully
  supported path, and TURN over TLS on **:443** traverses essentially any
  firewall, including ones that block 5349.

### Note
This also revises the "no srflx on this network" remark from 0.1.33. That was
read as a NAT characteristic; it is a **UDP-blocking firewall**, which is why
relay was the only candidate type — and why relay over UDP failed outright here.

---

## 2026-07-30 (desktop 0.1.34 — the DataChannel was lossy by design; it shouldn't be)

### Why
The decisive report: `gst-decode.sh` on the SAME `udp:5600` shows a **perfect
10ms picture**, while HYRAK shows heavy white noise. Same bytes. So the
corruption is ours, not the link's.

The cause was a deliberate choice, made on a wrong assumption. The channel was
`{ ordered: true, maxRetransmits: 0 }` — PR-SCTP, abandon rather than
retransmit — justified by "for video, late is worse than missing". That reasoning
assumes a dropped packet costs **one frame**. It does not: the air unit encodes
H.265 `NORMALP` IPPP, GOP 60 at ~20fps, with no intra-refresh, so one abandoned
packet corrupts every frame until the next keyframe — **up to 3 seconds**
(measured IDR interval 3012–3623ms).

Trading corruption for latency only pays when loss is rare and cheap. Here it is
neither. We inserted a deliberately lossy transport in front of a
loss-intolerant codec; gst is clean precisely because it has no transport at all
between it and `wfb_rx`.

### Changed
- **Reliable by default.** `maxRetransmits: 0` is now opt-in via a new
  `unreliable` flag, kept so the old behaviour is one config change away for
  comparison. `ordered: true` already paid the head-of-line cost regardless, so
  this is a smaller change than it appears: retransmission costs an RTT *when
  loss occurs* and nothing when it doesn't.
- **`MAX_BUFFERED_BYTES_RELIABLE` (4 MB)** replaces the 256 KB shed threshold on
  a reliable channel. The threshold means something different there: a climbing
  `bufferedAmount` is mostly the normal cost of recovery (a retransmitted chunk
  holds everything behind it until acknowledged), so shedding at 256 KB would
  discard packets the transport was about to deliver — reintroducing the exact
  corruption reliability exists to prevent, at the app layer where SCTP cannot
  recover it. 4 MB is ~10s of this 3 Mbit/s stream: unreachable in normal
  operation, still bounding memory if the receiver stops draining.

### Unverified
Not confirmed against the aircraft — it was powered down. The reasoning is
sound and the symptom matches exactly, but whether white noise disappears is
Japesh's test to run.

---

## 2026-07-30 (backend — video froze seconds after starting AI analysis)

### Why
"Freezes a couple of seconds after starting analysis" was the clue that
relocated this entirely. It is not the transport — it is unbounded queue growth
on the server, and the earlier ~45% client-side loss is a *symptom* of it, not
the cause.

`aiortc`'s `PlayerStreamTrack` pushes decoded frames into an **unbounded**
`asyncio.Queue` from its decode thread, and its `_throttle_playback` rate limiter
applies **only to file sources** (verified in the installed
`aiortc/contrib/media.py`). For a live RTP feed it decodes as fast as it can. So
if `recv()` is slower than the frame interval, the queue grows without bound and
the delay grows with it, monotonically — video that plays briefly and then
appears frozen while falling further behind every frame.

AI modes are precisely that case. Manual control is a pure relay and never hit
this; an analysis mode pays **two round trips through a single-worker
executor** (`to_ndarray`, then `_compose`) at ~6–10ms each at 1080p, plus overlay
drawing — against a 33ms budget at 30fps. Nothing recovers on its own once the
total crosses the interval.

This also explains the client-side loss measured earlier: a saturated server
drains the DataChannel slowly → SCTP flow control → the sender's `bufferedAmount`
climbs → `MAX_BUFFERED_BYTES` sheds. The 45% was backpressure from this,
propagated back to the client. The TURN/`srflx` suspicion in 0.1.33 looks like a
red herring.

### Fixed
- **`_skip_to_live_edge()`** in `stream_track.py` — before processing, drains any
  frames queued behind the one just received and keeps the newest. A stale frame
  has no value on a pilot view, and the alternative is unbounded latency. This is
  the server-side counterpart of the client's `liveEdge.ts` clamp.
- Rate-limited warning (once per 5s) naming the real condition — "analysis is
  slower than the incoming frame rate" — with the delivered fps, so this is
  visible next time instead of being inferred.

### Verified
Unit-tested against a stand-in with aiortc's exact queue semantics:
- backlog of 10 → keeps `frame9`, queue drained to 0
- no backlog → returns the same frame untouched
- **end-of-stream `None` behind live frames → sentinel is put BACK**, so the next
  `recv()` still runs aiortc's own `stop()` + `MediaStreamError` teardown rather
  than this method inventing its own
- a browser track with no `_queue` → passes through unharmed

### Still open
This bounds the *latency*; it does not make analysis faster. The single-worker
`_px_executor` and the two conversions per frame are still the cost driver, so at
1080p the delivered frame rate in AI modes will drop rather than the video
freezing. If the fps is too low, the next levers are decoding at a lower
resolution for analysis, or reusing one conversion instead of two.

---

## 2026-07-30 (desktop 0.1.33 — QGC alongside HYRAK, and visible video loss)

### Why — QGC and HYRAK were fighting over udp:14550
Confirmed live: `QGroundControl (pid 27882)` held `0.0.0.0:14550`, and the
native RF relay's bind failed with `EADDRINUSE`. Only one process can receive a
unicast UDP port, so pointing QGC at `127.0.0.1:14550` to load parameters and
upload a mission takes the link away from HYRAK entirely — the same collision
class as `gst-decode.sh` on 5600.

### Added
- **`fanoutPort` on `udpBridge`** — verbatim copy of the MAVLink **downlink** to
  another local port. HYRAK keeps 14550; QGC listens on the fan-out instead.
  Exposed as **Telemetry → Air unit (UDP, direct) → QGC PORT** (0 = off).
- **Downlink only, deliberately.** The uplink stays exclusively HYRAK's:
  forwarding QGC's outbound frames into `wfb_tx` would put two ground stations
  in command of one aircraft. QGC gets telemetry, parameters and mission
  download; it cannot command through this path.
- Verified against the real bridge with a simulated ground station: 200/200
  downlink frames to both consumers, **byte-identical**, uplink 10/10 to
  `wfb_tx` and **0/10** leaking to the learned ephemeral peer.

### Added — video loss is now measurable
The freeze was diagnosed by measuring the source *outside* the app (332 pkt/s on
5600) and comparing it to the server's ingest count (183 pkt/s) — a ~45% gap that
the app itself reported as **zero drops**, because only the `bufferedAmount`
branch incremented `dropped`.

- **`droppedNotOpen`** — datagrams arriving while the DataChannel is not open
  were `return`ed silently. That is the one branch that fires when the channel is
  slow to open or closes mid-flight, i.e. exactly when loss happens.
- **`received`** — the denominator. Without it "packets sent" compares to
  nothing, and confirming shedding required measuring the source outside the app.
- **`deliveredPct`** = sent/received, surfaced on the sender status. This is the
  number that explains a freezing picture: the air unit's IDR interval is ~3s
  (measured 3012–3623 ms), so every lost RTP packet costs up to 3 seconds of
  video and even a few percent is very visible.

### Not fixed — why the packets are lost
Instrumented, not solved. Candidates remain SCTP send-side backpressure in
werift and a TURN-relayed path (`CHANNEL_BIND` / `STUN 401` errors were logged,
and gathering shows `host` + `relay` with **no `srflx`**). Both peers are on the
same machine here, so a host-to-host pair should win on ICE priority — which is
why relay is a suspicion, not a conclusion. `deliveredPct` plus the selected
candidate pair will settle it on the next run instead of being guessed at again.

---

## 2026-07-30 (desktop 0.1.32 — updates no longer leave the old version running)

### Why
After "Update & restart", a **0.1.30 main process was still alive** while 0.1.31
was the installed version. Observed signature: ppid `systemd --user`
(reparented), executable `/tmp/.mount_HYRAK-AEal2b/hyrak-desktop.bin` — a
squashfs mount that no longer appeared in `/proc/mounts` at all.

That is not cosmetic. The ghost still held `udp:5600`, so the freshly installed
version could not read the air unit. `bindExclusive` (0.1.31) turned that from a
silent hijack into a clear refusal, but a refusal is still a broken feed.

Cause: `quitAndInstall()` spawns the replacement and calls `app.quit()`, and
`app.quit()` is **cancellable** — a pending `before-quit`, a modal, or an
unresponsive renderer leaves the old main process running while the new one
starts.

### Added
- **`reapStaleInstances()`** in `processGuard.ts` — at startup, kills app
  instances whose AppImage mount has already been unmounted. An AppImage's
  Electron binary exists *only* inside its per-run mount, so a vanished path
  proves the wrapper exited: the process cannot be anything but a leftover, and
  can never be the version just installed.
  - **Not a single-instance lock.** Two instances of the *current* version stay
    allowed, as requested — a live mount is never stale, so siblings are
    untouched. Only ghosts of superseded versions are removed.
  - Helper processes (`--type=zygote`, GPU, renderers) are skipped; they share
    the binary and die with their parent.
  - Verified both branches with a stand-in binary: path present →
    `stale:false`, left alone; path removed → `stale:true`, killed. Live
    processes are never candidates.
- **Install hardening** in `updater.ts` — bridges are torn down *before*
  `quitAndInstall()` so the replacement isn't racing this process for
  `udp:5600`, and a 4s watchdog calls `app.exit(0)` if `quitAndInstall()` did not
  end us. `reapStaleInstances()` alone would not be enough: it runs at the *next*
  launch, and the next launch is exactly the run that needs the port.
- `setInstallTeardown()` keeps `updater.ts` from importing the bridge registry.

### Needs a rebuild?
Yes — shipped in **0.1.32** (Linux + Windows).

---

## 2026-07-30 (backend — air_unit_datachannel was never server-sourced)

### Why
`air_unit_datachannel` connected perfectly and showed nothing. The DataChannel
opened, the server logged **2013 packets / 2.3 MB** ingested, the PeerConnection
reported `connected`, and no error appeared anywhere — the feed was simply black.

Root cause: `signaling.py`'s `server_sourced` tuple listed `rtsp_datachannel`
but **not** `air_unit_datachannel`, while the frontend's `isServerSourced()`
listed both. That disagreement is silent and total:

- browser (its list says server-sourced) → sends a **recvonly** transceiver, no track
- server (its list says otherwise) → waits on `pc.on("track")`, forever

Neither side fails, so nothing is logged. `open_air_unit_video` was never called
once — `grep -c "Air-unit video opened"` returned **0** across the whole log,
which is what identified it. Introduced when the two DataChannel modes were
added; `rtsp_datachannel` was wired into all three call sites and its sibling
into none.

### Fixed
- `air_unit_datachannel` added to `server_sourced`, to the source-open branch,
  and to the error-reporting branch. Both DataChannel modes are genuinely
  identical from the server's side — whatever produced the RTP, what lands on the
  loopback socket is RTP/H.265 — so all three sites now test for both together
  rather than naming one.
- Comment at the tuple recording that it must track `isServerSourced()` in
  `frontend/src/lib/videoSource.ts`, and what breaks when it doesn't.

### Verified along the way
Measured on the live ground station via the new fan-out port, which is what made
this diagnosable without disturbing the running stream:

- **5397 RTP packets / 15s**, ~2.7 Mbit/s, payload type 96
- NAL types present: `VPS 10, SPS 10, PPS 10, IDR_W_RADL 5, TRAIL_R 291` — so
  parameter sets **are** in-band and repeat with every IDR (~1.5s), meaning a
  late joiner can always decode
- decoding the fan-out with the server's exact SDP and options produced
  **20/20 frames** under all four `max_delay`/`reorder_queue_size` combinations

That ruled out the stream, the parameter sets, the payload type, and the
low-latency flags — leaving the signaling mismatch.

---

## 2026-07-30 (desktop 0.1.31 — native air-unit telemetry, no relay agent)

### Why
`localRfRelay.ts` reads a wfb-ng ground station's MAVLink through
`telemetry_relay.py`, a separate process the operator has to start. That agent
exists for exactly one reason: a browser tab cannot open a raw UDP socket. The
desktop app can, so on desktop the agent is pure overhead — and one more thing
that can be "not running" when telemetry silently fails.

### Added
- **`frontend/src/lib/nativeRfRelay.ts`** — binds the ground station's ports
  directly through the native UDP bridge. Reads `udp:14550` (wfb_rx downlink),
  sends to `udp:14551` (wfb_tx uplink), relays on the existing
  `serial_uplink`/`serial_downlink`. Backend unchanged. 8s silence watchdog
  naming the real causes (ground station not started, dongle not in monitor
  mode, channel/key mismatch, aircraft powered down).
- **Telemetry → "Air unit (UDP, direct)"** in the flight panel, desktop only.
  The old relay-agent option stays, unchanged.

### Fixed
- **`udpBridge.ts` gained `pinRemote`** — required for this path and wrong
  without it. The bridge's usual rule is "learn the peer, reply to it", which
  assumes one endpoint that both sends and receives (true of a SIYI ground unit
  and of MAVSDK). A wfb-ng ground station is **two processes on two fixed
  ports**, and wfb_rx sends from an *ephemeral* source port. Measured against
  the real bridge with a simulated ground station:

  | | uplink → wfb_tx:14551 | uplink → ephemeral (wrong) |
  |---|---|---|
  | without `pinRemote` | 1/10 | **10/10** |
  | with `pinRemote` | **10/10** | 0/10 |

  The single packet wfb_tx received in the first row was the opening punch byte
  — which `pinRemote` also suppresses, since wfb_tx is a fixed local listener
  with nothing to learn and the byte would just be injected over the RF uplink
  to the aircraft.

---

## 2026-07-30 (desktop 0.1.31 — air-unit UDP port collision, and a local fan-out)

### Why
Consuming a client's `wfb-gs` ground station (`start-gs.sh` + `gst-decode.sh`)
exposed a silent bug. `start-gs.sh`'s `wfb_rx` delivers RTP/H.265 to
`udp:127.0.0.1:5600`; `gst-decode.sh`'s `udpsrc port=5600` reads it. The
`air_unit_datachannel` sender binds the same port — and bound it with
`SO_REUSEADDR`, which does **not** share a unicast UDP port. Measured: the
second binder took **200 of 200** packets, the first got **zero**.

So the collision never reported itself, and broke differently by start order:

| order | symptom |
|---|---|
| HYRAK after `gst-decode.sh` | HYRAK silently **steals** the video; the operator's local window freezes with no error anywhere |
| HYRAK before `gst-decode.sh` | gst steals it back; HYRAK reports only "nothing arriving on udp:5600" — blaming the ground station or the RF link |

One of those corrupts a working setup, and neither names the real cause.

### Fixed
- **`bindExclusive()`** replaces the `reuseAddr: true` bind for `source: 'udp'`.
  RTP on a shared port cannot be shared, so `SO_REUSEADDR` bought nothing here
  except an unclear failure. `EADDRINUSE` now becomes a refusal that names the
  likely holder (`gst-decode.sh`, a second HYRAK window, QGroundControl) and
  says what to do. Verified a non-reuse bind is refused even when the holder set
  `SO_REUSEADDR` — which GStreamer's `udpsrc` does by default (`reuse=true`).

### Added
- **Local fan-out** (`udpFanoutPort`) — re-sends every datagram verbatim to
  `127.0.0.1:<port>`, so owning 5600 no longer costs the operator their own
  picture. One capture, two consumers. Sent **before** the DataChannel branch
  and never gated on its state: the local view must not depend on the cloud leg,
  since that is exactly when it is most needed. Send errors are ignored (nothing
  may be listening yet). Verified byte-identical over 500 mixed-size datagrams.
- **Settings → Video → "Local fan-out port"**, shown for
  `air_unit_datachannel`. Default `0` (off) — it costs a `send()` per packet and
  most setups have no second viewer. The tip carries the ready-made
  `gst-launch-1.0` line for the fan-out port.

### Client-side changes required
**None.** `start-gs.sh` and `gst-decode.sh` are untouched. The ground station is
already delivering to 5600, which is what the app reads.

### Needs a rebuild?
Yes — shipped in **0.1.31** (Linux + Windows).

---

## 2026-07-29 (frontend — native serial telemetry in the desktop app)

### Why
In the desktop app, "+" next to TELEMETRY did nothing. Electron ships
`navigator.serial`, so `browserSerialSupported()` returned true and the button
rendered — but Electron has **no built-in serial port chooser**. Unless the main
process handles the session's `select-serial-port` event, `requestPort()` never
resolves with a port, and it doesn't (`desktop/src/app-main.ts` has no such
handler). So no grant could ever be made, `listGrantedPorts()` stayed empty
forever, and there was no way to use a 3DR/SiK radio from the desktop build.

The `SerialBridge` needed to fix this has been registered and exposing `list()`
since it was written — it had simply never been wired to the UI.

### Added
- **`frontend/src/lib/nativeSerialRelay.ts`** — desktop counterpart of
  `browserSerial.ts`. Enumerates ports via the native bridge's
  `list('serial')` (no grant, no picker — every port visible immediately,
  QGroundControl-style), opens one via `start('serial', …)`, and relays raw
  MAVLink on the **existing** `serial_uplink`/`serial_downlink` events. Backend
  unchanged — `serial_bridge.py` still can't tell where the bytes came from,
  the same property that let `localRfRelay` and `siyiTelemetryRelay` land with
  zero server changes.
- **8s silence watchdog**, matching `remoteSitlRelay.ts`. Opening a serial port
  succeeds whether or not anything is on the other end — an unpaired radio, a
  baud mismatch, or a powered-down aircraft all open perfectly and deliver zero
  bytes. Names those causes instead of waiting out mavsdk's generic timeout.
- **Baud selector** (57600 default, 115200/921600/38400/9600) — shown only when
  a serial radio is the selected source. Applies to the browser path too.

### Changed
- `DeviceSelector.tsx` — in the desktop app the `+` is a **refresh** (re-scan
  ports) rather than a grant picker; native ports list above Web Serial ones.
  Legacy `/dev/ttyS*` UARTs with no `vendorId` are filtered out.
- `useDrone()` gained `connectNativeSerial(path, baud)`.

### Unchanged by design
Video and telemetry sources remain **fully independent** — video is chosen in
Settings (`videoSource.ts`), telemetry in the flight panel. SIYI RTSP or HYRAK
air-unit video alongside a 3DR radio for telemetry was always a supported
combination; this only fills in the missing telemetry option.

### Needs a rebuild?
**No.** Frontend only — hot-reloads. The `serial` bridge it calls already ships
in desktop 0.1.30.

---

## 2026-07-27 (desktop 0.1.30 — hardware reachability pre-check)

### Why
The laptop roamed across **seven WiFi networks in one evening** (`realme`,
`IITH`, `AndroidAP_4706`, and back, repeatedly). Every time it left the ground
unit's network, video and telemetry both failed — and every failure surfaced as
a symptom ("no frames arrived", "no MAVLink came back") rather than the cause
("you are not on the camera's network"). Each round cost a measurement cycle to
rediscover the same thing.

### Added
- **`desktop/src/netProbe.ts`** — TCP connect / UDP round-trip probes plus the
  machine's own IPv4 addresses. Only the main process can open a raw socket, so
  this cannot live in the renderer; exposed via a new `hyrak-net-probe` IPC
  handler and `bridge.probeNetwork()`.
- **Settings → Video → "Hardware reachability"** — runs on mount and on demand,
  colour-coded:
  - **green** reachable *and on your own subnet* — direct, the reliable case
  - **amber** reachable but **routed** via a gateway — depends on another device
    forwarding, which is exactly what kept breaking
  - **red** unreachable, with what to do about it
- `__hyrakNetCheck()` in the console, alongside `__hyrakLiveEdge()` and
  `__hyrakRtspPath()`.

### The on-link distinction is the point
Reporting reachable/unreachable alone would have been nearly useless — we had
that already. The useful signal is **whether the target shares a subnet with
this machine**:

| | Reached by | Depends on |
|---|---|---|
| on-link | ARP, directly | nothing else |
| routed | asking a gateway | every hop choosing to forward |

`192.168.144.20` answering ping with no ARP entry and no open TCP port was the
tell for hours, and it was read as "the ground unit is up". It wasn't — something
upstream was ICMP-replying for an address it could not deliver to.

### Deliberately reports the SUBNET, not the SSID
The SSID was **actively misleading** all evening. A ground unit bridged to a
phone hands out the *phone's* addresses, so "connected to SIYI" was true while
the camera sat on a different subnet; and a bridge can rebroadcast the upstream
SSID, so the same name can mean two different first hops. The subnet is what
determines reachability, so that is what is measured and shown.

### Verified
```
my addresses: wlp99s0 10.183.197.7/24
  Camera (RTSP)    ok=false onLink=false  2514ms timed out
  Ground (telem)   ok=false onLink=false  2512ms no reply
  My gateway       ok=false onLink=true   2510ms no reply   <- on-link detected
  Localhost 8001   ok=true  onLink=false     3ms
```

---

## 2026-07-27 (desktop 0.1.28 — regression: my latency change broke rtsp_datachannel)

### Reverted
0.1.26 added a blanket `-max_delay 0` to the sender's ffmpeg input args as a
latency measure. It **broke `rtsp_datachannel` outright** — ffmpeg read the
camera and emitted no RTP, so the server reported *"DataChannel forwarded 0
packets. Nothing arrived from the client at all."*

The option should never have been there:
- These args only ever reach the **RTSP** leg. A `'udp'` source runs no ffmpeg
  at all, so the "air unit needs it too" justification was false.
- Over RTSP/**TCP** nothing can arrive out of order, so there was no reorder
  wait to remove — it bought nothing even in theory.

It survives only for `rtspUdp`, where reordering is real and dropping beats
waiting. **The measured 100 ms was always server-side** (`udp_video_source`'s
`max_delay`, passed 0 for this path) and that change stands.

### Added — silent-source watchdog
The worse problem was diagnostic. The only error the operator saw came from the
**server**; the client had nothing to say, because the bridge reported solely on
ffmpeg **exit** and ffmpeg was still running happily. A source that is alive but
producing nothing was not a reportable state.

`armSilenceWatchdog()` now fires 6 s after negotiation if no packet has been
sent, and quotes ffmpeg's own stderr tail:

- RTSP source → *"The source opened but produced no RTP in 6s. ffmpeg is still
  running, so this is not a crash — it read the input and emitted nothing. Last
  ffmpeg output: …"*
- UDP source → *"Nothing arriving on udp:5600 after 6s. Is the ground station
  running (wfb_rx), and is it delivering to this machine?"*

`stderrTail` moved onto the connection so the watchdog can read it. Costs
nothing on a healthy stream — the timer returns immediately once `packets > 0`.

### Note
Not reproduced locally: the dev machine had moved to a different network and the
camera at `192.168.144.25` was unreachable, so this was diagnosed by elimination
rather than measurement. The watchdog exists precisely so the next occurrence of
this class reports itself instead of needing that.

---

## 2026-07-27 (desktop 0.1.26 — DataChannel latency; SIYI UDP telemetry)

`rtsp_datachannel` confirmed working on real hardware. Operator-measured:
**~300 ms round trip**, against 30–50 ms for the SIYI ground unit's own screen
and roughly ground-unit parity for `siyi_rtsp`. Not the 1–2 s of `rtsp_camera`,
but not yet as fast as the server-side RTSP pull.

### Fixed — 100 ms of that gap was one parameter
`udp_video_source.open_air_unit_video()` hardcoded `max_delay: 100000` — a
100 ms RTP **reorder window**, which is a floor on latency because the demuxer
holds each packet that long in case an earlier one is still in flight. That is
correct for the air unit's RF link, where reordering is real. It is pure cost on
the DataChannel path, where SCTP delivers in order (`ordered: true`) over a
loopback socket. The pointer was that `rtsp_video_source` — the *faster* reader —
sets no `max_delay` at all.

Now a parameter: `max_delay_us`, still defaulting to 100 ms for `air_unit_udp`,
passed as **0** for `rtsp_datachannel`. The client's ffmpeg gets `-max_delay 0`
too, for the same reason on its own RTSP leg.

### Added — SIYI ground unit telemetry over UDP
New telemetry source in the device selector: **`SIYI ground unit (UDP)`**, with a
configurable port (default 14550).

**Zero backend changes.** It uses the desktop's already-shipped `udp` bridge and
relays on the EXISTING `serial_uplink`/`serial_downlink` events —
`app/telemetry/serial_bridge.py` has never cared where a client's MAVLink came
from, the same property `localRfRelay.ts` relies on.

Uplink (arm/takeoff/mission) needs no configured destination: `udpBridge.send()`
replies to the last peer seen on that port, which is standard MAVLink-over-UDP
behaviour. Telemetry must be flowing before commands can go out, which is the
right dependency regardless.

Port is a setting rather than a constant because SIYI firmware varies — 14550 is
the MAVLink convention, 19856 is common for SIYI's own app. To find it on a
machine that is on the hotspot:
`sudo tcpdump -i any -n udp and not port 8554 -c 20`

### Still open on latency
After this, the remaining gap to `siyi_rtsp` is structural: `rtsp_datachannel`
demuxes twice (client ffmpeg, then server PyAV) and pulls RTSP from the client
rather than the server. Also unmeasured: whether the media path is using a TURN
**relay** candidate rather than a direct one — no `srflx` candidate was observed
on this network, and a relayed path costs latency. That is the next thing to
measure, not another buffer to tune.

---

## 2026-07-27 (desktop 0.1.25 — packaged app crashed on launch)

0.1.24 died instantly on every platform, before showing a window:

```
Error: Cannot find module 'lib/binary-stream'
Require stack:
- app.asar/node_modules/@shinyoshiaki/binary-data/src/index.js
- app.asar/node_modules/werift/lib/dtls/src/context/cipher.js
```

`@shinyoshiaki/binary-data` (a werift DTLS dependency) resolves
`require('lib/binary-stream')` — a NON-relative path — through a nested
`src/node_modules/` directory. That is legal Node resolution, and it works in
development. But electron-builder collects `node_modules` by walking the
**dependency tree**, and `src/node_modules/{lib,types,internal}` contain no
`package.json`, so the walker does not recognise them as packages and drops
them. `src/index.js` shipped; the modules it requires did not.

Fixed with an explicit `from`/`to` copy in `build.files`. **Plain globs do not
work** — `"node_modules/@shinyoshiaki/binary-data/src/node_modules/**/*"` was
tried first and produced 0 entries, because the pattern is filtered by the same
tree walk. The mapping form bypasses it:

```json
{ "from": "node_modules/@shinyoshiaki/binary-data/src/node_modules",
  "to":   "node_modules/@shinyoshiaki/binary-data/src/node_modules",
  "filter": ["**/*"] }
```

Verified: 25 entries present in **both** the Linux and Windows asar, including
`lib/binary-stream.js`, and the AppImage now runs for 20 s with no module error
where 0.1.24 exited immediately.

`HYRAK-0.1.24.AppImage` and `HYRAK-Setup-0.1.24.exe` are deleted from
`/releases` — they cannot start, so serving them is worse than serving nothing.

### Third instance of the same class of bug
This is the third packaging failure today from a dependency whose files are not
plain, hoisted JavaScript: a Linux `bindings.node` in a Windows package
(0.1.21), a Linux `ffmpeg` in a Windows package (0.1.22), and now a pruned
nested `node_modules` (0.1.25). **A packaged build is not verified by the fact
that it built.** Worth a launch smoke test in the release script, and a real
argument for per-platform CI runners.

---

## 2026-07-27 (desktop 0.1.24 — two new DataChannel video sources, wired end to end)

**Additive. Nothing about `camera` / `air_unit_udp` / `siyi_rtsp` /
`rtsp_relay` / `rtsp_camera` changes** — the intent is to have every transport
available for comparison and prune later.

### Added — Settings → Video → Video source
- **`RTSP → DataChannel`** (`rtsp_datachannel`). ffmpeg speaks RTSP and remuxes
  to RTP with `-c copy`. One process, no re-encode.
- **`Air unit → DataChannel`** (`air_unit_datachannel`). **No ffmpeg at all.**
  `communication/luckfox_pico_airunit`'s `air_video_udp` already hardware-encodes
  on the Rockchip VENC and packetises to RTP itself (`venc_to_rtp_thread`, 1200-byte
  payload MTU), and `wfb_rx` delivers it to udp:5600. The bridge only forwards
  datagrams — no decode, no encode, no remux. The cheapest path in the app, and
  the bytes the server decodes are the bytes the drone's encoder produced.

Both are `isServerSourced()` from the browser's point of view: the desktop
pushes RTP on a **separate** PeerConnection, the server writes it to a loopback
UDP port, and the browser's own offer is recvonly. Contrast `rtsp_camera`, which
genuinely does send a camera-like track.

### Wiring
- `hyrak-webrtc-sender-answer` IPC channel — the one non-generic handler, because
  an SDP answer must be *awaited* and must report failure (a codec/fmtp mismatch
  is otherwise invisible). `hyrak-bridge-send` is fire-and-forget.
- `hooks/useDataChannelSender.ts` sequences the two negotiations. Order is
  load-bearing: `bridge.start()` → socket `datachannel_video_offer` →
  `acceptAnswer()` (which is what opens the channel and starts ffmpeg) → **then**
  the browser's offer. The server probes the loopback port synchronously and
  fails on a silent one.
- `useWebRTC.cleanup()` stops the sender — it owns its own PeerConnection plus
  either an ffmpeg or a bound UDP port, none of which the browser's pc teardown
  touches.

### Fixed before it could bite
The sender PeerConnection was created with **no ICE servers**, so it would have
gathered host candidates only — working on a LAN and failing everywhere else,
i.e. the exact NAT problem this transport exists to solve. It now fetches the
same short-lived Cloudflare TURN credentials the browser uses.

Verified against the live endpoint rather than assumed. `/api/webrtc/ice-servers`
returns 2 entries whose `urls` are arrays (2 and 6 URLs, including
`turns:...:443?transport=tcp` for UDP-blocked networks), and werift gathers
`{host: 1, relay: 1}` from them — TURN allocation succeeds.

**Correction:** an interim version flattened those arrays to one URL per entry,
justified by a claim that werift silently ignores an array. That claim was
tested and is **false** — raw and flattened forms gather identical candidates.
The flattening was removed rather than kept with a wrong rationale.

Worth watching: there is **no `srflx` candidate** on this network, only host and
relay, so the media path will use the TURN relay rather than a direct
hole-punched one. It works, but costs latency and relay bandwidth — the first
thing to check if field latency disappoints.

### On the air unit SDK — sufficient as-is
No additional build needed. Two things to confirm/tune on the drone side:
1. **In-band VPS/SPS/PPS is mandatory.** `udp_video_source.py`'s SDP carries no
   `sprop-*` fmtp, so the stream must supply parameter sets itself. Could not be
   confirmed from the stripped binary; Rockchip MPP normally emits them before
   each IDR. If decode never starts, this is the first thing to check.
2. **`-g 60` (default) is a 2 s IDR interval** at 30 fps — that is the recovery
   and join latency. `-g 30` halves it for a little more bitrate.
   `-m 1200` is already ideal: comfortably inside one SCTP chunk.

No new keys. `drone.key`/`gs.key` are wfb-ng RF-link keys and are unrelated to
this path; TURN credentials are minted server-side per session.

### Deploy
Linux `HYRAK-0.1.24.AppImage` + Windows `HYRAK-Setup-0.1.24.exe`.
**The backend must be restarted** — `datachannel_video_source.py` and the new
`signaling.py` handlers are server-side.

---

## 2026-07-27 (H.265 over WebRTC DataChannel — working end to end)

**Bit-exact H.265 to the server with no transcode, over a NAT-traversing
transport.** The one combination the transport comparison had no entry for.

### Verified against the real modules
`WebrtcSenderBridge` -> `datachannel_video_source` -> `udp_video_source`:

```
frames_decoded: 296     sizes: ["1280x720"]     ~30fps sustained
NAL parse errors: 8     (only the initial mid-stream join)
bytes: 203875           (98311 while broken — the large FU/AP packets were missing)
```

### Added
- `backend/app/webrtc/datachannel_video_source.py` — datagram->loopback-UDP
  shim. Deliberately holds no decoder: it writes RTP straight to a loopback port
  and the **existing** `udp_video_source.open_air_unit_video()` decodes it. That
  reuse is why this works at all — aiortc's video codec table is VP8/H.264 only,
  so H.265 cannot ride a media track, but a DataChannel negotiates no codec.
- `datachannel_video_offer` / `datachannel_video_stats` socket handlers, and a
  `rtsp_datachannel` server-sourced branch in `signaling.py`.
- `mode: 'datachannel'` in `webrtcSenderBridge.ts`, with `bufferedAmount`-based
  shedding (drop rather than queue — for video, late is worse than missing).

### Channel configuration
`ordered: true, maxRetransmits: 0` (PR-SCTP: ordered, unreliable). No
retransmission keeps head-of-line blocking bounded; ordering is **required**
because `ordered: false` reorders even on loopback (observed
`218,219,220,222,223,224,221,...`) while the server decoder runs
`reorder_queue_size=0`, turning reordered RTP into NAL parse errors.

### Fixed along the way
- **`-bsf:v dump_extra` on a copy-to-RTP path is harmful and was the actual
  cause.** It replaces the `hevc_mp4toannexb` filter ffmpeg inserts
  automatically, so HEVC stays length-prefixed, the RTP payloader cannot find
  NAL boundaries, and it emits **no FU/AP packets** — the ones carrying
  keyframes and parameter sets. Symptom was `Error parsing NAL unit #0` forever
  with healthy-looking packet counters.
- **ffmpeg must not start before the transport is up.** It was launched right
  after the offer, but the DataChannel is not `open` until the answer returns,
  and everything sent in that window is silently discarded. Now launched from
  `acceptAnswer()` after waiting for `open`.
- **RTSP demuxer options must be conditional on the URL scheme** — ffmpeg
  rejects `-rtsp_transport` for a non-RTSP input ("Option not found").
- **`-re` for non-live inputs.** A file read flat-out measured 8340x realtime
  and simply overran the transport.

### Requirement this exposes
`udp_video_source.py`'s SDP carries no `sprop-vps/sps/pps` fmtp, so **the source
must emit parameter sets in-band** (`repeat-headers` on the encoder). Real
cameras and air units do; an MP4 with them only in extradata decodes nothing.

### Note on method
Three hypotheses — SCTP fragmentation, packet size, reliability policy — were
all wrong, and all disproved by one observation: byte-for-byte identical results
(527 packets / 98311 bytes) across *every* channel configuration, which could
only mean the variable was upstream of the channel. Same lesson as the fMP4 bug:
check what the consumer receives, and distrust a hypothesis that predicts a
difference the measurements do not show.

### Still not reachable from the UI
No IPC for `acceptAnswer()`, no video-source entry, no frontend wiring. The
transport and both ends are proven; the plumbing to the operator is next.

---

## 2026-07-27 (WebRTC media sender — proven and landed, not yet reachable)

Groundwork for the structural fix to `rtsp_camera`'s latency. **Additive: no
existing mode is touched.** See `docs/ADR/ADR-009` for the full argument,
including the swarm/multi-feed transport decision.

### Proven first
Rather than assume the approach works, it was tested against **aiortc** — the
actual server library, not a werift-to-werift loopback which would have proven
nothing about interop:

```
[aiortc] TRACK received: kind=video
[aiortc] FIRST FRAME DECODED: 640x360
[aiortc] t=15s ice=completed frames_decoded=419      (~30fps sustained)
[werift] t=15s ice=connected  rtp_written=863
```

Full chain: ffmpeg -> RTP/UDP -> `werift` `MediaStreamTrack.writeRtp()` ->
ICE/DTLS-SRTP -> aiortc decode. Two findings that would otherwise have been
opaque production failures:

1. **aiortc rejects an offer with no H.264 fmtp.** `is_codec_compatible()`
   compares `packetization-mode` *and* the parsed H.264 profile. aiortc
   advertises `packetization-mode=1`; werift with no `parameters` defaults to
   `0`, so there is no common codec and `setRemoteDescription` raises "Failed to
   set remote video description send parameters". The sender must declare
   `packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42e01f`.
2. **The encoder must repeat SPS/PPS** or the receiver logs `non-existing PPS 0
   referenced` and shows garbage until the first keyframe. Handled with
   `-x264-params repeat-headers=1` (and `-bsf:v dump_extra` on the copy path).

### Added
- `desktop/src/bridges/webrtcSenderBridge.ts`, registered as `webrtc-sender`.
  `RTSP -> ffmpeg -> RTP -> werift -> server`: **2-3 codec steps instead of
  `rtsp_camera`'s 7**, and the browser is removed from the upload path. Unlike
  `rtsp_relay`'s SRT uplink it traverses NAT, because it is ordinary WebRTC —
  ICE/STUN/TURN, including TURN over TLS:443. No `relay_public_host`, no
  forwarded ports, no VPN.
- `werift` 0.24.1. Chosen over `node-datachannel`/`wrtc` specifically because it
  is **pure TypeScript**: today produced two release-breaking bugs from
  cross-compiled native binaries (0.1.21, 0.1.22), and a third instance of that
  bug class is not worth the performance parity.

### Not done yet — deliberately
The bridge compiles and is registered but **nothing can reach it**: no IPC for
`acceptAnswer()`, no video-source entry, no frontend wiring. One design question
must be settled first, and I would rather raise it than build past it:
`signaling.py`'s `_attach_video_track` calls `pc.addTrack()` to send the
processed feed *back*. That is right for a browser, but the desktop sender
offers `sendonly` and has no use for a return track. Either the server skips
the return track for this source, or the sender negotiates `sendrecv` and
discards it. For overlay-capable AI modes the return video is not needed at all
— local preview plus the existing client-side overlays is strictly lower latency
— which argues for the former.

---

## 2026-07-27 (desktop 0.1.22 — Windows gets a real ffmpeg; Start button unblocked)

### Fixed — `rtsp_camera`'s Start button was permanently disabled
`VideoStream.tsx` gated Start on `!serverSourced && !selectedCameraId`.
`rtsp_camera` is deliberately **not** server-sourced, so on any machine with no
webcam selected — the normal state on a dedicated ground-station PC — Start
could never be clicked. The dev laptop has a webcam, which is the entire reason
this looked like "works on Linux, broken on Windows".

`needsCameraSelection()` exists for exactly this and was already used correctly
for the hint 55 lines above; this call site was missed. `modules/page.tsx` was
already correct, so `VideoStream.tsx` was the only stale one.

### Fixed — the Windows build shipped a Linux ffmpeg
Same root cause as 0.1.21's serialport bug, different package. `ffmpeg-static`
downloads a **platform-specific** binary at install time, so a Linux dev machine
only ever has the Linux one, and cross-building packaged that:

```
before:  .../ffmpeg-static/ffmpeg       ELF 64-bit LSB executable   <- unusable on Windows
after:   .../ffmpeg-static/ffmpeg.exe   PE32+ executable (console)
```

Every RTSP mode would have failed instantly on Windows. Caught by inspecting
the package rather than by waiting for the crash report.

`ffmpeg-static` honours `npm_config_platform`/`npm_config_arch` in both its
installer *and* its runtime resolution (`index.js` appends `.exe` when
`os.platform() === 'win32'`), so the fix is to fetch the Windows binary at build
time and let each platform pick its own:

- new script **`ffmpeg:win`** fetches `ffmpeg.exe`
- new script **`dist:win`** = `build` + `ffmpeg:win` + `electron-builder --win`,
  so this can't be forgotten
- `build.win.files` excludes the extensionless Linux `ffmpeg`
- `build.linux.files` excludes `ffmpeg.exe`, which would otherwise ride along in
  the AppImage as ~82 MB of dead weight

Verified in the built package: `ffmpeg.exe` PE32+, serialport
`prebuilds/win32-x64/node.napi.node` PE32+, zero wrong-platform executables on
the load path. (Seven Linux `.node` files remain under
`prebuilds/linux-*`/`android-*`; `node-gyp-build` resolves strictly by
`${platform}-${arch}` so they are never loaded — dead weight only.)

### Note on `siyi_rtsp` "working here but not there"
Not a Windows issue and not a regression. `siyi_rtsp` has the **backend** open
the RTSP URL, and the backend machine had moved to a different hotspot (SSID
`realme`), so `192.168.144.25` was being routed out through the campus gateway:
100% packet loss, port 8554 unreachable. `[Errno 1414092869] Immediate exit
requested` is PyAV's open timeout.

This is the sharpest demonstration yet of why `siyi_rtsp` cannot be the
deployment mode: it worked only while the server happened to share a network
with the camera, and broke the moment that stopped being true. It stays a
testing convenience.

### Removed
`HYRAK-Setup-0.1.21.exe` deleted from `/releases` — it launched, but every video
mode would have failed on the Linux ffmpeg. 0.1.22 is the first Windows build
that is actually usable.

---

## 2026-07-27 (desktop 0.1.21 — Windows build actually launches)

### Fixed
0.1.20's Windows installer crashed at startup:

```
Error: ...\@serialport\bindings-cpp\build\Release\bindings.node
       is not a valid Win32 application
```

Cause: cross-building Windows on Linux. `@electron/rebuild` had already
compiled `@serialport/bindings-cpp` for **linux-x64** during the AppImage
build, leaving a Linux ELF at `build/Release/bindings.node` in `node_modules`.
electron-builder then packaged that directory into the Windows app.
`node-gyp-build` resolves `build/Release/` **before** `prebuilds/`, so on
Windows it found the Linux ELF and tried to `dlopen` it.

The correct binary was in the package the whole time — the package ships N-API
prebuilds for every platform, and N-API is ABI-stable across Node and Electron
versions, so no rebuild is needed for Windows at all:

```
prebuilds/win32-x64/node.napi.node   PE32+ executable (DLL) x86-64   <- correct
build/Release/bindings.node          ELF 64-bit LSB, x86-64          <- shadowed it
```

Fix is one exclusion in `build.win.files`:
`"!node_modules/@serialport/bindings-cpp/build/**"` — keeping the host-compiled
artifact out of the Windows package so `node-gyp-build` falls through to the
correct prebuild. Linux is untouched (the exclusion is win-only), and verified
after rebuilding: the Windows package now contains the PE32+ DLL and **zero**
Linux ELFs.

**Any future native dependency needs the same treatment when cross-building.**
The general rule: a locally compiled `build/Release/*.node` is always wrong for
a cross-target, and silently shadows the right prebuild.

### Removed
`HYRAK-Setup-0.1.19.exe` and `HYRAK-Setup-0.1.20.exe` deleted from `/releases`
— both crash on launch for the reason above, and serving a crashing installer
is worse than serving none.

---

## 2026-07-27 (desktop 0.1.20 — Windows build; instance lock reverted)

### Added
- **Windows installer.** `HYRAK-Setup-0.1.20.exe` (NSIS, x64), cross-built on
  Linux via wine and served from `/releases` alongside the AppImage. Both
  update feeds now sit at the same version — `latest-linux.yml` for Linux,
  `latest.yml` for Windows. **Unsigned**: no code-signing certificate exists
  yet, so Windows SmartScreen will warn on first run. Signing is a separate
  purchase-and-CI task.

### Reverted
- **The single-instance lock (0.1.16/0.1.19) is removed.** Operator's call, and
  the reasoning is sound: the orphaned-ffmpeg leak was the actual defect and it
  is fixed in `processGuard.ts`; on a 24-core workstation several instances are
  merely CPU, and running two BUILDS side by side is genuinely useful for
  comparing versions — which the lock prevented. `reapOrphans()` already spares
  a live sibling's children, so multiple instances stay safe from the leak.
  The remaining hazard is shared exclusive hardware (two instances opening the
  same telemetry serial port); that belongs to the serial bridge, not to a
  window guard.

---

## 2026-07-27 (desktop 0.1.19 — single-instance lock actually works now)

0.1.16's lock was decorative. `app.quit()` does not stop the module from
continuing to execute, so the `whenReady` handler still registered and still
built a window — 0.1.16 and 0.1.18 were observed running side by side with the
lock supposedly in place. The result is captured in `gotSingleInstanceLock` and
the `whenReady` handler now returns early, so a duplicate instance creates no
window and does not run `reapOrphans()` on its way out.

This also matters for testing integrity: with two builds live, a latency
measurement can silently be taken against the older one.

---

## 2026-07-27 (desktop 0.1.18 — THE fMP4 preview bug: one missing write)

### The bug

`rtspRelayBridge` served the fMP4 preview **without its init segment**, so the
`<video>` element received a stream with no `ftyp` and no `moov`. Every
`rtsp_camera` start therefore failed both fMP4 rungs and landed on MJPEG.
This had been true since the mode was introduced — **the good path never once
worked.**

One missing write, in the stdout handler:

```ts
const live = conn.initSegment.subarray(boundary)
conn.initSegment = conn.initSegment.subarray(0, boundary)
for (const res of conn.clients) res.write(live)   // <-- init segment omitted
```

The init segment was cached for *late* joiners, and the HTTP handler sends it
on connect — but the `<video>` element connects while ffmpeg is still doing its
~1 s RTSP handshake, so it is **always** attached before the first `moof`
arrives. It got `live` and nothing else. Fixed by writing
`initSegment + live` to already-connected clients.

Proven at the bridge level rather than by inspection — driving the real
`RtspRelayBridge` and probing the bytes it actually serves:

| rung | before | after |
|---|---|---|
| `-c copy` | `trun track id unknown, no tfhd was found` | `hevc, Main, 1920x1080` |
| H.264 transcode | `trun track id unknown, no tfhd was found` | **`h264, Constrained Baseline, 1920x1080`** |

Raw ffmpeg output was always fine (valid `moov`, `avcC` with SPS+PPS,
`avc1.42C028`), which is why testing ffmpeg in isolation never caught it. The
corruption was introduced by *our* HTTP layer, between ffmpeg and the browser.

### Why it hid for four releases

Chromium reports a truncated container as `MEDIA_ERR_SRC_NOT_SUPPORTED`
(code 4) — indistinguishable from "this machine can't decode H.265". Our error
text then asserted the H.265 explanation **unconditionally**, including on the
transcode rung whose output is H.264. So the message advised switching the
camera to H.264 for a stream that already was H.264, and every subsequent
investigation went hunting for codec and network causes. The message is now
rung-aware and never blames the input codec on a rung that re-encodes.

Two lessons written into the code comments:
- Verify what the **consumer receives**, not what the producer emits. ffmpeg
  was innocent for four releases while our socket layer corrupted the stream.
- A cached-for-late-joiners buffer needs a matching write for the
  already-attached case; "cache it and send on connect" silently omits the
  client that connected first.

### Impact
`rtsp_camera` should now run on the H.264 transcode (amber in Settings →
Video → "Active video path") instead of MJPEG (red). MJPEG was 20 fps with no
inter-frame compression through `<img>` → canvas → rAF → `captureStream()`;
the transcode is 30 fps H.264 straight into `<video>`. Every latency figure
recorded before this release was measured on MJPEG.

---

## 2026-07-27 (desktop 0.1.17 — the fallback ladder stops hiding)

### Why
Measured the whole RTSP chain against the live camera. Everything upstream is
fine: 33 ms RTT, SIYI's RTSP server pre-buffers only **+0.14 s**, delivery is
**0.996× realtime** (no drift), stream is HEVC Main 1080p30 with no B-frames,
and our transcode keeps up at **1.04× realtime using 0.41 cores**.

The ~1.5 s came from somewhere else entirely: the app had silently fallen to
**rung 3, MJPEG** (`-f mjpeg -q:v 5 -r 20`) — 20 fps, no inter-frame
compression, through `<img>` → canvas → rAF → `captureStream()`. At 0.1.13 the
same setup ran on rung 2 (H.264 transcode) at ~500 ms.

Three rounds of latency tuning were spent on a pipeline that was not in use,
because when a fallback rung succeeded the ladder **discarded the reasons the
better rungs failed**. That is the defect fixed here.

Ruled out by measurement rather than argument: `frag_duration=20000` is *not*
the cause. Both 20 ms and 100 ms output was verified byte-for-byte
well-formed in pipe mode (`ftyp, moov, moof/mdat…`, valid H.264 1080p) — and
the pipe was tested specifically because the mp4 muxer behaves differently on
a non-seekable output than on the file my first test used.

### Added
- **Settings → Video → "Active video path"** — on-screen readout of the live
  rung, camera codec, browser buffer in ms, and every skipped rung with its
  reason. Colour-coded: green direct, amber transcode, **red MJPEG**, so the
  fallback can never quietly become the norm again. The end users are traffic
  operators; a console incantation was never an acceptable diagnostic.
- `__hyrakRtspPath()` in the console for the same data.
- Each rung failure is now logged as it happens, and a successful fallback
  logs `FELL BACK to "<rung>"` with the full list of what failed first.
- **DevTools bound explicitly to F12 and Ctrl/Cmd+Shift+I.** It previously
  relied on Electron's default application menu supplying the accelerator,
  which did not reach the operator on this Linux build — and "open DevTools"
  is the instruction that unblocks most video diagnosis.

### Found, not yet acted on
- **The bundled ffmpeg has no VAAPI at all** — `-hwaccels` lists only `vdpau`,
  and there are zero `*_vaapi` encoders. This is the real reason
  `-vaapi_device` was rejected back in 0.1.13; it is not a syntax problem, the
  feature is not compiled in. The **system** ffmpeg 6.1.1 does have it, and
  `h264_vaapi` on `/dev/dri/renderD129` (the AMD iGPU) was verified working:
  full VAAPI decode+encode ran at 1.05× realtime on **0.03 cores vs 0.41** —
  a ~15× CPU reduction. Worth adopting via the system-ffmpeg-with-fallback
  pattern `airUnitVideoBridge` already uses, once we know why rung 2 fails.

---

## 2026-07-27 (desktop 0.1.16 — ffmpeg process leak; ROOT CAUSE of the "1s latency")

### The actual diagnosis

The ~1 s RTSP latency was **not** a video-pipeline problem. It was CPU
starvation caused by a process leak in this app.

Measured on the dev machine while the operator reported the latency:

```
logical cores:   24  (Ryzen AI 9 HX 370)
load average:    21.68  19.58  17.71     ← climbing
leaked ffmpeg:   1127%  (≈11 cores, 8 processes on ONE camera)
Electron:        1219%  (≈12 cores, 4 app instances)
                 ─────
                 ~2350% of 2400%  → ~98% CPU
```

Four HYRAK instances were running at once (0.1.13, two copies of 0.1.14,
0.1.15). Between them they had stranded **nine orphaned ffmpeg processes**,
four of which were libx264 transcodes holding ~260% CPU each with over an
hour of accumulated CPU time apiece.

A saturated CPU cannot be tuned away downstream: libx264 stops encoding in
realtime so frames queue at the encoder, Chromium's decoder is starved so
`<video>` buffers more, and 0.1.14's live-edge clamp cannot drain a backlog
when playback itself is starved. Every symptom follows from this one cause.

**The network was innocent throughout.** Measured: `-33 dBm`, 390 Mbit/s link
rate, carrying **2.01 Mbit/s** of video. Not range, not signal, not TCP
head-of-line blocking, not SIYI's RTSP server — all of which were theorised
here at various points, and all of which were wrong. 0.1.15's UDP toggle is
still worth having but was never the cause.

### Fixed — `bridges/processGuard.ts` (new)

Three independent defences, because three independent failures produced those
orphans:

1. **`app.on('before-quit')` → `killAllTracked()`.** Nothing stopped the
   bridges on quit; there was no handler at all, so every launch stranded its
   children. Backed by `process.on('exit')` and SIGINT/SIGTERM handlers that
   go straight to SIGKILL, since those run synchronously and cannot await.
2. **`killChild()` escalates SIGTERM → SIGKILL** after 1.5 s. Bare
   `proc.kill('SIGTERM')` was assumed sufficient; two of the nine orphans sat
   at 0% CPU having ignored it. `rtspBridge` and `rtspRelayBridge` both used
   the bare form — `airUnitVideoBridge` already escalated, and that logic is
   preserved (it also waits for the UDP port to be released).
3. **`reapOrphans()` at startup.** The only defence that survives the app
   being SIGKILLed or crashing, which is the case that actually happened.
   Scoped narrowly: only processes whose exe is the ffmpeg *we* bundle, and
   only those whose parent is dead or is not another HYRAK/Electron process.
   A user's own ffmpeg is never touched, and a sibling instance's children are
   left alone.

Verified both directions against real processes:
- orphan whose parent is `systemd --user` → **reaped**
- ffmpeg owned by a live `HYRAK`-named parent → **spared**

That first test also killed the obvious implementation: an orphan is reparented
to **`systemd --user`, not to pid 1**, so the usual `ppid === 1` check would
have silently never fired on this machine. `isOrphaned()` inspects what the
parent *is* instead of guessing its pid.

Why the children never died on their own: ffmpeg writes to `pipe:1`, so a
closed read end should raise EPIPE — but Electron's helper processes (zygote,
GPU, renderers) inherit open descriptors, so the read end stays open after the
main process is gone. Linux's `PR_SET_PDEATHSIG` would fix this at the source
but needs a native addon.

### Added — single-instance lock
`app.requestSingleInstanceLock()`; a second launch focuses the existing window
instead of starting a rival. Four concurrent instances is *how* the leak
compounded. It is also a safety property in its own right: two instances would
both open the same telemetry serial port and both believe they were commanding
the aircraft. Note this is keyed on app identity, not version, so running two
BUILDS side by side is now deliberately prevented — reverting to an older
version means quitting the current one first.

### Note on the earlier latency work
0.1.14 and 0.1.15 remain correct and worth keeping — ~100 ms of real buffering
removed, and every dial made revertible. But they were measured on a machine at
98% CPU, so **no latency figure recorded before this release means anything.**
Re-measure from scratch on 0.1.16.

---

## 2026-07-27 (desktop 0.1.15 — every latency dial made switchable)

Re-measured with proper tooling, the RTSP latency is **~1 s, not ~500 ms**.
That reframes 0.1.14: its two changes removed roughly 100 ms of a ~1000 ms
budget, which is correctly invisible to the eye. ~1 s is also the signature of
a *fixed buffer* rather than accumulating queue delay, and the largest
un-probed candidate is the camera leg itself.

So rather than guess at another fix, this release makes each candidate an
independent, revertible setting. A failed experiment must never cost the
working configuration.

### Added — three independent lists under Settings → Video

Shown for both `rtsp_relay` and `rtsp_camera`.

- **Camera transport — `TCP` (default) / `UDP`.** New; the point of this
  release. `-rtsp_transport` was hardcoded to TCP on the theory that this is
  a short local link where reliability is cheap. "Short local link" is wrong
  for a SIYI hotspot at range: over TCP a retransmission stalls everything
  queued behind it, so a marginal link spends its loss budget on **delay that
  accumulates** rather than on artifacts. UDP mode also pins
  `-reorder_queue_size 0` and `-max_delay 0` — `reorder_queue_size` defaults
  to `-1` (auto), i.e. a packet buffer whose only function is to wait — and
  raises `-buffer_size` to 416 KB so kernel-level drops don't masquerade as a
  bad radio link. Verified against bundled ffmpeg 7.0.2: the full arg set is
  accepted, no "Unrecognized option" (the trap `-vaapi_device` fell into).
- **Preview fragmenting — `Low latency (20 ms)` (default) / `Compatible
  (100 ms)`.** Makes 0.1.14's `frag_duration` change revertible without a
  rebuild.
- **Live-edge clamp — on (default) / off.** Makes 0.1.14's `playbackRate`
  drain revertible.

### Added — diagnostics
- **`__hyrakLiveEdge()`** in the DevTools console reports the browser's
  current playback backlog in ms. 0.1.14 shipped `getLiveEdgeDriftMs()` with
  no way to call it, which made it not a diagnostic at all. A low number here
  alongside a high glass-to-glass delay proves the remaining delay is *not*
  ours — look upstream of the browser.
- The bridge status event now echoes `rtspTransport` and `fragDurationUs`, so
  a latency measurement can never be attributed to the wrong configuration.

### Note
`rtsp_camera` has no bridge of its own — it calls the same `rtsp-relay`
bridge with `uplink: false`. Every change here therefore applies to both
modes; there is no separate code path to keep in sync.

---

## 2026-07-27 (desktop 0.1.14 — RTSP preview latency)

Attacks the ~500 ms glass-to-glass delay measured on the working
`rtsp_camera` path. Two independent terms, both removed. Nothing about the
transport, the codec fallback ladder, or WebRTC changes — this is purely
buffering that was being paid for no benefit.

### Changed
- **fMP4 fragment duration 100 ms → 20 ms** (`PREVIEW_FRAG_DURATION_US` in
  `rtspRelayBridge.ts`), on both the `-c copy` tee preview and the H.264
  transcode. A fragment is only written once complete, so the old value was
  added to the delay in full. Verified against the bundled ffmpeg 7.0.2:
  3 s of 30 fps output now contains **89 `moof` boxes for 90 frames** — one
  fragment per frame, so the fragment boundary is no longer a term at all.
- **`-flush_packets 1`** on both output pipelines. Required for the above to
  do anything: ffmpeg otherwise holds finished fragments in its 32 KB AVIO
  buffer until it fills, so they left in batches regardless of size. The two
  changes only work as a pair.
- **New `frontend/src/lib/liveEdge.ts` — live-edge clamp.** Chromium settles
  a few hundred ms behind its own newest buffered frame when it starts a
  progressive stream, and never drains: frames arrive at exactly the rate
  they are consumed, so the startup backlog is permanent. This was the
  **largest single term** in the budget. `clampToLiveEdge()` nudges
  `playbackRate` above 1.0 until the backlog is spent, then snaps back.
  Applied to both preview paths — `rtsp_camera` (where it matters most,
  since `captureStream()` lifts frames at the element's playback position,
  handing the backlog to WebRTC as well) and the `rtsp_relay` preview in
  `VideoStream.tsx`.

### Note
The clamp deliberately does **not** seek to `buffered.end()`, which is the
obvious fix and the wrong one: a seek on a progressive live stream makes
Chromium issue a Range request, and the loopback preview server serves one
endless response with no `Content-Length` and no Range support — the seek
kills the stream. Draining via playback rate needs no cooperation from the
server. `getLiveEdgeDriftMs()` exposes the measured drift, which isolates
the browser's contribution from ffmpeg's and the camera's.

Not touched, and still the next candidates if this isn't enough: switching
the SIYI camera to H.264 (removes the transcode entirely), and replacing
`<video>` + `captureStream()` with WebCodecs (ADR-004).

---

## 2026-07-26 (desktop 0.1.13 — H.264 transcode path)

### Fixed
- **`rtsp_camera` now works with an H.265 camera.** Confirmed by the new
  diagnostics: the SIYI camera reports `hevc`, and Chromium fails it with
  `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) because it ships no SOFTWARE H.265
  decoder. The fix is to convert rather than to ask the user to reconfigure
  hardware: ffmpeg transcodes H.265 → **H.264**, which every browser decodes.
  Verified locally: hevc in → `codec_name=h264` 1280x720 fragmented MP4 out.
- **CORS headers on both loopback servers.** The MJPEG fallback set
  `img.crossOrigin = 'anonymous'` — mandatory, or the canvas is tainted and
  cannot be `captureStream()`d — but neither local server sent
  `Access-Control-Allow-Origin`, so the load was rejected outright. That, not
  the codec, is why the MJPEG safety net failed too.
- Fallback is now three rungs, best first: `-c copy` → H.264 transcode →
  MJPEG. Every failure is collected, so the final error explains each rung.

### Note
The transcode uses **libx264** (`ultrafast`/`zerolatency`), not VAAPI. Caught
in testing: the BUNDLED ffmpeg rejects `-vaapi_device` outright
("Unrecognized option") — `airUnitVideoBridge` only gets away with it by
shelling out to the SYSTEM ffmpeg, which clients may not have. Hardware
encode is a future optimisation via `-init_hw_device`, not a prerequisite.

---

## 2026-07-26 (desktop 0.1.11 / 0.1.12 — `rtsp_camera` diagnostics + MJPEG fallback)

### Fixed
- **`rtsp_camera` now falls back to MJPEG automatically** instead of failing
  when the browser can't play the camera's codec. ffmpeg's decoder is not
  subject to Chromium's missing *software* H.265 support, so having ffmpeg
  decode and serve MJPEG (via the existing `rtspBridge`) removes the browser
  codec dependency entirely. Costs a JPEG encode/decode — strictly worse than
  the `-c copy` path — which is why it runs only after the efficient path
  fails. Both failures are reported together, so a fallback failure never
  hides the original cause.
- **`MediaError.code` is now surfaced.** The previous message asserted "if the
  camera is H.265..." while *discarding* the error object that says which of
  NETWORK (2), DECODE (3) or SRC_NOT_SUPPORTED (4) actually occurred — three
  causes with entirely different fixes, presented as one guess.
- **The camera's real codec is reported.** The relay ffmpeg now runs at
  `-loglevel info` and its input stream line ("Stream #0:0: Video: hevc ...")
  is parsed and emitted, so failures name the actual codec instead of
  speculating. Captured on a dedicated permanent subscription, since ffmpeg
  prints it only after connecting — *after* the preview URL, by which point
  the short-lived listener is gone.
- `rtspBridge.start()` also returns `streamUrl` in `meta`, closing the same
  listen-after-emit hazard fixed in the relay bridge.

---

## 2026-07-26 (desktop 0.1.10)

### Fixed
- **`rtsp_camera` failed with "Relay did not report a preview URL in time"
  while the same URL played fine in VLC.** A listen-after-emit race, not a
  camera or network fault: `rtspRelayBridge.start()` emits its status event
  (carrying `previewUrl`) *before* the start promise resolves, and
  `rtspCameraStream` subscribed only after awaiting that promise — so it
  missed an event that had already fired, then waited out the full 15s
  timeout for it.
- `NativeBridge.start()` may now return `meta`, and the relay bridge returns
  `previewUrl` there. An awaited return value cannot be missed the way an
  event can. The event subscription is kept as a fallback for desktop builds
  older than 0.1.10, and is now registered *before* `start()` regardless.
- The fallback promise is marked handled up front, so when the returned value
  is used its later rejection doesn't surface as an unhandled rejection.

### Note for future bridges
Any bridge emitting an opening status event has this hazard. Values the
caller needs immediately belong in `start()`'s return `meta`, not only in an
event — see the contract comment in `desktop/src/bridges/types.ts`.

---

## 2026-07-26 (desktop 0.1.9 — `rtsp_camera`)

### Added
- **`rtsp_camera` — the RTSP feed as an ordinary webcam.** Answers the NAT
  problem that blocks `rtsp_relay` in the common case where *both* ends are
  behind NAT: this mode needs no reachable server address at all, because the
  video leaves as a normal WebRTC camera track and therefore traverses
  STUN/TURN like any webcam — including TURN over TLS:443 on UDP-blocking
  networks.
  - `rtspRelayBridge` gained `uplink: false` — preview-only, reusing the
    already-tested fMP4 loopback path rather than a second implementation.
  - `frontend/src/lib/rtspCameraStream.ts` — `<video src=loopback fMP4>` →
    `captureStream()` → MediaStream → the existing `startStream(cameraStream)`.
  - **Zero backend changes.** The offer is indistinguishable from a webcam's,
    which is the whole point.
- `needsCameraSelection()` — `rtsp_camera` is not server-sourced but still has
  no device to pick, so gating Start on a camera selection would have left the
  button permanently disabled.

### Design note
ffmpeg still does `-c copy` here; the decode happens in Chromium (hardware
where available) and the only encode is the one WebRTC performs for any
camera. So versus the old MJPEG `rtspBridge` approach this avoids a JPEG
encode/decode round trip entirely.

**Cost vs `rtsp_relay`:** one encode, and quality bounded by the WebRTC
uplink rather than bit-exact. **Benefit:** works essentially anywhere. Both
ship; see ADR-003.

---

## 2026-07-26 (relay reliability + diagnostics)

### Fixed
- **`allocate()` is now idempotent.** It used to release-then-recreate
  unconditionally, so every ordinary retry (mode switch, reconnect, second
  Start) killed the ffmpeg an in-flight `open_track` was reading — and moved
  the public port, stranding a laptop that had already begun pushing.
  Observed live as ports walking `5701 → 5700 → 5702` with three peer
  connections on one session.
- **`open_track()` waits instead of checking once.** PyAV fails *fast* on a
  silent UDP port rather than waiting out its timeout, so a single attempt
  raced the laptop's SRT connect + first keyframe — a race the laptop cannot
  win. Now retries to a deadline. Verified: a push starting **6s late** now
  connects (10.9s, 5 frames), where it previously failed instantly.
- **`cleanup(keepRelay)`** distinguishes restart from stop, so the frontend
  no longer releases the relay immediately before re-allocating it.
- **Client-side relay failures now surface instead of the server's timeout.**
  The laptop's ffmpeg knows in ~1s that it can't reach the host; the server
  only learns at 25s. The specific message now wins over the vague one.

### Known constraint (not a bug)
- **Both ends are typically behind NAT.** A private `10.x`/`192.168.x`
  `relay_public_host` only works when client and server share a LAN. For a
  laptop on the drone's hotspot with its own internet path, there is no
  routable address without a mesh VPN (Tailscale/WireGuard) or a public-IP
  relay. Documented in ADR-008; the cloudflared tunnel cannot help, being
  HTTP-only.

---

## 2026-07-26 (backend — /releases Range support)

### Fixed
- **`/releases` now honours HTTP Range, breaking the updater bootstrap
  deadlock.** desktop 0.1.6's `disableDifferentialDownload` fixed stalled
  downloads only for clients *already running* 0.1.6+. Every client on
  <=0.1.5 still has the differential downloader enabled, so its update
  stalls on the unsupported Range request, so it can never reach a build
  containing the flag — a deadlock no client-side change can break. Serving
  Range properly fixes every already-deployed version at once, and makes
  interrupted downloads resumable.
- Replaced the `StaticFiles` mount with `app/api/releases.py`. Starlette
  0.38.6's `StaticFiles` ignores Range entirely (returns 200 + full body,
  no `Accept-Ranges`).
- **`HEAD` is served as well as `GET`** — FastAPI's `@get` does not imply
  `HEAD`, and electron-updater issues one to size the artifact before
  downloading; a 405 there aborts the update before any byte is fetched.
  This was caught in testing, not in review.

### Verified
Against the real 143 MB AppImage: suffix range `bytes=-149791` → 206 with
exactly 149791 bytes and a correct `Content-Range` (the precise request the
embedded block map needs); mid-range byte-for-byte identical to the file;
open-ended range correct; past-EOF → 416; `HEAD` → 200 with
`Accept-Ranges: bytes`; `latest-linux.yml` unchanged; and path traversal
(`../`, `....//`, absolute) all refused with 404.

### Also
- `server.py`'s `disconnect` now releases any video relay. A listener holds
  a port and its own ffmpeg, neither tied to the peer connection, so a
  client vanishing without a pc state change leaked both.

---

## 2026-07-26 (desktop 0.1.8)

### Fixed
- **The desktop app rendered stale UI that surviving a restart couldn't
  clear.** Chromium's HTTP cache lives in the user-data dir, not memory, so
  a cached JS chunk persisted across quit/relaunch — the app kept showing a
  previous version of the Settings page while the identical URL in a browser
  showed the current one. Confirmed twice: once on the Settings
  reorganisation, once on the `rtsp_relay` chip, where `grep -rl "RTSP
  relay" .next/` proved the dev server had compiled it correctly and only
  the client was behind.

  This app is a shell around a *continuously deployed* site — loading
  `SITE_URL` live is the whole point — so a persistent cache works directly
  against its design, for the sake of re-fetching a small bundle over a
  local tunnel once per launch. `createWindow` now calls
  `session.clearCache()` before `loadURL` and sends `pragma: no-cache`.
- Added **Ctrl/Cmd+Shift+R → `reloadIgnoringCache()`** for mid-session
  updates; the frontend hot-reloads far more often than this app relaunches.

---

## 2026-07-26 (desktop 0.1.7)

### Added
- **`rtsp_relay` — zero-transcode video source.** The desktop app pulls a
  networked RTSP camera (SIYI ground unit on its hotspot) from the machine
  that can actually reach it, and forwards the camera's **original bytes**
  to the backend with `ffmpeg -c copy` — no decode, no encode, no generation
  loss, ~2% CPU on an i5. The same ffmpeg tees a **local preview** over
  loopback HTTP, so the operator's own picture never makes the server round
  trip. See ADR-008.
  - `desktop/src/bridges/rtspRelayBridge.ts` — the relay, with automatic
    reconnect and per-slave `onfail=ignore` so a dropped uplink doesn't take
    the preview down with it (or vice versa).
  - `backend/app/webrtc/relay_video_source.py` — per-session ingest.
  - `allocate_video_relay` / `release_video_relay` socket events; an
    additive `elif` in `signaling.py`. No existing branch was modified.
  - Settings → Video: RTSP relay chip, uplink transport (SRT/TCP/UDP) and
    the SRT latency window.
- `isServerSourced()` in `videoSource.ts` — five call sites previously spelled
  this list out inline, so adding a fourth source meant finding all of them.
- Config: `relay_public_host`, `relay_default_transport`, `relay_latency_ms`.

### Fixed
- Nothing — this release is purely additive. `camera`, `air_unit_udp`,
  `siyi_rtsp`, `rtspBridge.ts`, WebRTC signalling and TURN are untouched.

### Known limitation (not a bug)
- **The relay uplink does not pass through the cloudflared tunnel** — the
  tunnel proxies HTTP, SRT is raw UDP. `relay_public_host` must name a
  directly reachable address with the relay ports forwarded, and is empty by
  default; until it's set the UI refuses to start the mode rather than
  leaving the operator with a silent connect timeout.

### Verified facts recorded
- **PyAV cannot open `srt://`** (`ProtocolNotFoundError`; no `libsrt` in its
  `av.libs`) — the reason the server runs an ffmpeg remux hop instead of
  handing the URL to `MediaPlayer`.
- SRT's ffmpeg `latency` option is **microseconds**, default 120000.
- The mp4 movflag is `default_base_moof`, not `default_base_is_moof`.
- `ffmpeg-static` segfaults as an SRT **listener**; system ffmpeg 6.1.1 is
  clean. The client only ever acts as caller, the server as listener.

---

## 2026-07-26 (desktop 0.1.5 / 0.1.6)

### Fixed
- **Update downloads hung at 0% with no status — root cause found.**
  electron-builder embeds the AppImage block map at the *tail* of the
  `.AppImage` (hence `blockMapSize` in `latest-linux.yml`, with no separate
  `.blockmap` file), and electron-updater's differential downloader fetches
  those trailing bytes with an HTTP **Range** request before downloading
  anything. `/releases` is served by Starlette `StaticFiles` (pinned 0.38.6),
  which does **not** honour Range — verified: a ranged request for the last
  150 KB returns `HTTP 200` with `content-length: 143165795` and no
  `accept-ranges` header, i.e. the entire 143 MB file. The updater sat
  consuming a 143 MB body it believed was a small blockmap range, and
  `download-progress` never fires during that phase. Fixed with
  `autoUpdater.disableDifferentialDownload = true` (desktop 0.1.6) — a plain
  full download needs no Range support and emits progress normally.
  Differential updates were never actually working, so nothing is lost.
- **`UpdatePrompt` swallowed `error` events**, so a failed download left the
  panel on "Downloading… 0%" forever with no way to tell it had died — the same
  defect class as ADR-007. It now surfaces the failure with the message and a
  "Try again" button, plus a 20s no-progress watchdog for the case where the
  updater never responds at all.

### Added
- Richer download telemetry: `transferred`, `total`, and `bytesPerSecond` now
  travel with `percent` from `desktop/src/updater.ts`, so progress can be shown
  as bytes and rate. Matters when a percentage sits on one integer for a long
  time, or when no `Content-Length` means there is no percentage at all.
- `frontend/src/lib/formatBytes.ts` — shared `formatBytes` / `formatRate` /
  `formatEta` so the prompt and the Settings row cannot drift.
- **Settings → About now shows the whole update lifecycle.** It previously
  handled only check results and dropped `download-progress` / `downloaded`
  entirely, going silent for the whole download. It now has a progress bar with
  percent, bytes, rate and ETA, an indeterminate pulse before the first
  progress event, an inline error, and one action button that follows the stage
  (Check → Download vX → Downloading… → Restart & install).
- Clear up-front error when self-update is attempted from an unpacked Linux
  build (no `APPIMAGE` env var), instead of failing obscurely inside
  electron-updater.

---

## 2026-07-26 (later)

### Changed
- **Settings page restructured into categories.** Eleven groups that each
  printed their own heading into one long flat scroll are now organised behind
  a sidebar nav: General (appearance / status bar / units), Video, AI Modules,
  Map, Mission, Alerts, Data & Logs, Shortcuts, About. Section headings moved
  out of the group components into a declarative `CATEGORIES` table, so adding
  a setting means adding a line to that table and it lands in a deliberate
  category. Active tab persists in `localStorage` under `hyrak-settings-tab`.
  The nav collapses to a horizontally scrollable row on narrow panes. A lone
  section whose name merely repeats its category heading suppresses its own
  divider. No preference keys, group internals, or behaviour changed.

---

## 2026-07-26

### Added
- `docs/` knowledge base: `AI_CONTEXT.md`, `PROJECT_OVERVIEW.md`,
  `ARCHITECTURE.md`, `CURRENT_STATE.md`, `SESSION_HANDOVER.md`,
  `KNOWN_ISSUES.md`, `ROADMAP.md`, `GLOSSARY.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, `PROJECT_MANIFEST.yaml`, `ADR/ADR-001`–`ADR-007`,
  `SESSION_LOGS/2026-07-26.md`.
- `docs/video-transport-modes.md` — selectable video transport mode matrix
  with per-scenario defaults.
- `modules/` per-module documentation.
- `scripts/sync-docs.sh` — documentation drift checker.
- `udp` bridge: optional `bindAddress` config field.
- `udp` bridge: one-time `receiving: true` status event with the sender's
  address on the first packet per port, so "bound but silent" is detectable.
- SITL relay: 8s silence diagnostic naming WSL/Docker/VM as likely causes,
  plus `setSitlSilenceHandler()`.

### Fixed
- **desktop 0.1.3 — air-unit video Start failure.** `systemFfmpegWithVaapi()`
  used `ffmpeg -hwaccels` (compile-time support only) to decide hardware was
  available, and the hardware branch passed no `-vaapi_device`, so ffmpeg
  auto-initialised the first DRM render node — a firmware-disabled RTX 4070 on
  the dev laptop — and died instantly with `Failed to initialise VAAPI
  connection`. Replaced with a real per-node runtime probe
  (`-init_hw_device vaapi=va:<node>`), an explicit `-vaapi_device`, and an
  automatic software fallback when a hardware attempt exits inside 4s.
  Hardware-setup failures now report a cause instead of `ffmpeg exited
  (code 1)`. See ADR-005.
- **desktop 0.1.4 — UDP bridge bound loopback only.** `socket.bind(port,
  '127.0.0.1')` silently dropped every packet not sent to loopback, breaking
  PX4 SITL running in WSL2, Docker, or a VM (WSL2 localhost forwarding is
  TCP-only). Now binds `0.0.0.0`. Also benefits the swarm relay. See ADR-006.
- **Permanent "connecting" state.** The backend's generic `error` socket event
  had no frontend listener at all, and exceptions inside
  `on_connect_browser_serial` were swallowed by socket.io — either left the UI
  stuck on "connecting" forever, since only `telemetry_status` can exit that
  state. `useDrone.ts` now handles `error`; `telemetry_events.py` emits
  `telemetry_status` on every failure path. See ADR-007.

### Changed
- Corrected the SRT rearchitecture plan: Phase 3 no longer deletes the
  v4l2loopback path, which is the only mode that works on UDP-blocking
  networks. See ADR-003.

### Decided (not yet implemented)
- ADR-001: keep WebRTC; the target is eliminating transcode passes.
- ADR-002: SRT for the client→server uplink.
- ADR-003: video transport is user-selectable and multi-mode by necessity.
- ADR-004: local WebCodecs canvas preview replaces the v4l2loopback hack for
  the new mode; `MediaStreamTrackGenerator` is not needed.

### Verified facts recorded
- QUIC/HTTP3 is used nowhere in the stack.
- Chromium refuses H.265 in WebRTC SDP negotiation — the reason the double
  transcode existed.
- `/dev/dri/renderD128` = NVIDIA RTX 4070 (VAAPI fails),
  `renderD129` = AMD iGPU (works) on the dev laptop.
- Crowd management (268 lines) and plate tracking (410 lines) are implemented
  and registered, contradicting the stale plan file.

---

## Earlier work (reconstructed from git history — pre-dates this changelog)

- `2007044` telemetry: fix Web Serial buffer overruns dropping the radio link.
- `7c58411` video: client-side overlays — direct feed + canvas-drawn AI
  results; `return_video=False`, roughly halves bandwidth.
- `a0dc785` webrtc: prefer TLS/TCP TURN urls for aiortc relay (aiortc uses
  only the FIRST turn url; UDP-blocking networks need TLS:443 first).
- `08c44e0` webrtc: Cloudflare TURN relay for UDP-blocking networks.
- `6e8e124` video: move pixel work off the event loop, zero browser playout
  buffer.
- `d10345d` GPU-era vision tuning. `1a901c1` person-tracking fixes.
- `aae7d0c` latency/bitrate fixes: `buffered=False`, raised aiortc encoder
  ceilings, settings-page video resolution/fps group.
- `d9b9fde` overlay refactor: `BaseAnalyzer.draw_overlay(frame, meta)`.

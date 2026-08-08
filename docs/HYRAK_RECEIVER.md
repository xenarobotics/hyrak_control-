# HYRAK Receiver — the ground decoder's PC-side consumer

**Status: implemented, desktop 0.1.50.** UDP and SRT verified end to end against
a synthetic H.265 RTP source on both backends; RTSP is built and
argument-verified but has not been run against a real MediaMTX. Nothing here
has been tested against the decoder itself yet — see "What is verified".

The consumer half of `docs/PC_VIDEO_TELEMETRY_INTEGRATION.md`. That document
specifies what the ground unit emits; this one covers what the app does with
it and why.

Video source: **`hyrak_receiver`**, Settings → Video → HYRAK Receiver.

---

## The requirement that shaped this

> The application should be the only thing clients download and install, on
> Windows, Linux and ARM64, and it must run on any PC, not just the one it was
> written on.

That single sentence rules out most of the obvious designs, so it is worth
being explicit about what it eliminates:

| Approach | Why it fails the requirement |
|---|---|
| Require system GStreamer (what `air_unit_gst` does) | An install step, and Linux-only in practice. |
| Bundle GStreamer | Works on Windows. On Linux `libgstvaapi.so` links the **host's** libva/libdrm/EGL, so a bundled copy initialises into software — 41.3% of a core versus 4.4%, measured. |
| Bundle ffmpeg and decode with it | `ffmpeg-static` cannot reach a GPU at all: `-hwaccels` reports `vdpau` and nothing else (ADR-005). Ships everywhere, ~a core at 1080p30 everywhere. |

What is left is the one decoder every client already has, because the app *is*
Chromium:

```
decoder --H.265--> ffmpeg -c copy (demux only) --Annex-B--> WebCodecs --> GPU
```

ffmpeg never touches a pixel, so its lack of GPU access stops being a
constraint rather than something to work around. The GPU is reached through
Chromium's platform decoder — D3D11/Media Foundation on Windows, VA-API on
Linux, V4L2 on ARM SoCs. Zero installer bytes, same code path on all three
targets.

---

## The three transports

All three carry the identical bitstream. They differ in who connects to whom
and in what happens to a lost packet.

| | **RTSP** (default) | **SRT** | **UDP** |
|---|---|---|---|
| Who connects | PC → decoder | PC → decoder | decoder → PC |
| Decoder needs this PC's address | no | no | **yes** |
| Inbound firewall rule | no | no | **yes** |
| Loss handling | retransmit (TCP) | retransmit inside a window | none |
| Delay under loss | **can accumulate, unbounded** | bounded by the window | none — artifacts instead |
| Default buffer | 60 ms | 80 ms | 40 ms |
| Board cost | MediaMTX (already running) | same MediaMTX process | second `wfb_rx` |

**RTSP is the default**, and not because it is fastest — it is not. UDP is the
only one of the three that needs *both* the decoder configured with this PC's
address *and* an inbound firewall exception, and both of those fail as a black
screen rather than as a message. That is the wrong default for an operator who
should never see a network-engineering decision.

**SRT is the interesting one** and is what the integration doc's trade-off
table is missing. Its framing is that you choose between UDP's artifacts and
TCP's latency. SRT is neither: loss is retransmitted only within an explicit
window and dropped outside it, so the picture stays clean *and* delay cannot
grow the way TCP's head-of-line blocking allows. On a LAN the RTT is well under
a millisecond, so 80 ms is already a generous budget — unlike the 150 ms the
public-internet uplink to the HYRAK server needs.

### Enabling SRT on the decoder

One MediaMTX setting. It is the **same process** already serving RTSP
re-publishing the **same path** — not a second `wfb_rx`, which matters because
`PC_VIDEO_TELEMETRY_INTEGRATION.md` open item 3 measures that board at ~40% of
its single Cortex-A7 core with two video paths already running.

```yaml
# mediamtx.yml on the decoder
srt: yes
srtAddress: :8890
```

The app then reads `srt://<decoder>:8890` with `streamid=read:video`. MediaMTX
serves SRT as MPEG-TS rather than RTP, which the app already handles —
`tsdemux` on the GStreamer backend, ffmpeg's own demuxer otherwise.

### RTSP latency

The integration doc's pipeline is right about the flags and wrong about one
structural detail. It sets `latency=50` on `rtspsrc` **and** adds an explicit
`rtpjitterbuffer latency=50` after it — but `rtspsrc` *contains* an
`rtpjitterbuffer` and that property configures it. The two are in series, so
the real budget is 100 ms. The app uses one:

```
rtspsrc protocols=tcp latency=60 drop-on-latency=true
        do-retransmission=false ntp-sync=false teardown-timeout=0
  ! rtph265depay ! h265parse config-interval=-1
```

`rtspsrc`'s own default is `latency=2000`. That number, not the TCP transport,
is most of why a generic client sits a second behind — which is what the doc
observed with VLC.

On the ffmpeg backend the equivalent is `-fflags nobuffer -flags low_delay
-max_delay 0 -reorder_queue_size 0`. Note that `-probesize` and
`-analyzeduration` are deliberately **not** minimised, contrary to the usual
low-latency advice: driving them to `32`/`0` makes ffmpeg give up before it has
seen VPS/SPS/PPS and exit with `Could not write header (incorrect codec
parameters ?)`. They are limits on the startup probe, not fixed waits, and
they do not affect steady-state latency at all.

---

## Decoding on an unknown machine

Element *presence* does not imply the GPU can service it, and the two ends fail
independently. Measured on the reference laptop: `nvh265dec` decodes correctly
while `nvh264enc` returns `Could not configure supporting library` — NVDEC
alive, NVENC not. A design that pairs them and gives up shows no video on that
machine; one that demotes straight to all-software throws away a working
hardware decoder.

So the bridge builds a **ladder** and walks down it when a rung dies on
arrival. On that laptop:

```
0. [ffmpeg/hevc]        H.265 passthrough — Chromium decodes it, nothing transcodes
1. [gstreamer/hevc]     H.265 passthrough via GStreamer
2. [gstreamer/hardware] H.265 to H.264 on the GPU (nvh265dec to nvh264enc)      <- dies here
3. [gstreamer/hardware] H.265 decoded on the GPU, re-encoded in software
4. [gstreamer/software] H.265 to H.264 in software
5. [ffmpeg/software]    H.265 to H.264 with the bundled ffmpeg — the slow path
```

Rungs 0-1 exist only when Chromium here can decode HEVC, which the renderer
measures with `VideoDecoder.isConfigSupported` at start and hands down. It is
never inferred from the platform and never defaulted to true: a wrong `true`
produces a black pane with no error, the worst thing to debug on a client's
machine.

The live rung is reported in the video pane's Decode tile and in every status
event, so "which of these am I on" is never a guess.

One trap worth naming: a hardware decoder hands downstream a GPU surface
(`memory:CUDAMemory`, `memory:VAMemory`, `memory:D3D11Memory`) and
`videoconvert` only understands system memory. Linking them yields
`not-negotiated`, which gst-launch reports as a fatal error **on the source
element** — so it reads as "the network stopped". Each decoder gets its matching
converter (`cudadownload`, `vapostproc`, `d3d11convert`, `mppconvert`),
existence-checked first, because naming an absent element is itself a fatal
parse error that kills the whole pipeline.

---

## Robustness

Three behaviours exist specifically because of the integration doc's open
items.

**Starvation watchdog.** Open item 1 records the RF dongle dropping off the
decoder's USB bus mid-session. That leaves the receiving process alive and
contentedly parked on a socket that will never deliver again — a frozen frame
and a success report. Six seconds without bytes forces a reconnect.

**Exponential backoff, capped, finite.** Open item 4 records a stuck client
driving MediaMTX to 44% CPU through reconnect churn alone, starving `wfb_rx`
enough to look like RF packet loss. Retries start at 1 s, double to a 15 s
ceiling, and stop after 8. This is a courtesy to the hardware, not just to the
app.

**`start()` waits to see video.** The bridge this replaces returned `ok:true`
the instant it spawned, so a pipeline that failed to parse and died in 80 ms
still reported success, still published a preview URL, and surfaced as an
unexplained failure 25 seconds later. This one waits up to 6 s for first bytes
and reports `receiving: false` with an actionable message otherwise — including
naming the UDP-specific causes (the decoder needs this PC's address; the
firewall needs the port) when that is the transport in use.

---

## Telemetry

Unchanged and not a problem: MAVLink arrives as raw UDP on 14550 and
`desktop/src/bridges/udpBridge.ts` already binds all interfaces (ADR-006), so
it does not care whether the sender is a local `wfb_rx` or the decoder one
Ethernet hop away. Point the telemetry address at the decoder in Settings →
Link.

Still unverified end to end, per the integration doc: no Pixhawk was attached
during the decoder's bench test.

---

## What is verified

| | |
|---|---|
| Annex-B splitting, H.265 | **Verified** — 60/60 access units, 4 keyframes, byte-exact reassembly from randomly-sized chunks |
| Annex-B splitting, H.264 | **Verified** — unchanged from the shipped implementation |
| Codec strings | **Verified** against `ffprobe` — profile and level match for both codecs |
| UDP transport, both backends | **Verified** end to end against a synthetic RTP source |
| SRT transport, both backends | **Verified** end to end against an SRT listener |
| Transcode ladder rungs 1-5 | **Verified** — each produces correct framed output |
| Transcode ladder rung 0 | **Fails on the reference laptop** (NVENC), which is what the ladder is for |
| RTSP transport | **Not run** — no MediaMTX available locally. Arguments are built and typechecked only |
| Against the real decoder | **Not run** |
| Windows / ARM64 | **Not run.** No platform-specific code paths, but that is an argument, not a test |
| HEVC in Chromium, **Linux** | **Measured.** Off by default — no HEVC decoder at all, not even software. **On** with the switches below |
| HEVC in Chromium, Windows / ARM64 | **Not measured** — needs running the app on those boxes |

### Chromium platform decoders (measured, Electron 32.3.3 / Chromium 128, Linux)

`VideoDecoder.isConfigSupported`:

| | default | with switches |
|---|---|---|
| HEVC Main L3.1, prefer-hardware | false | **true** |
| HEVC Main L3.1, no-preference | false | **true** |
| H.264 High, prefer-hardware | false | **true** |

Without them Chromium on Linux offers **no HEVC decoder whatsoever**, so every
Linux client would fall back to transcoding — about a core at 1080p30, and
needing a system GStreamer to avoid it. `desktop/src/app-main.ts` now sets:

```
--enable-features=PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL
--ignore-gpu-blocklist
```

`--use-gl=egl` was also tried and must **not** be added — it turns every result
above back to false.

Two consequences worth knowing:

- **WebCodecs needs a secure context.** It is absent entirely on `data:` URLs.
  The app loads `https://dev.xenarobotics.com`, so this is fine, but it does
  mean a quick local test page must be served over `file://` or `https://`.
- **`isConfigSupported` is a claim, not a guarantee.** A driver can advertise
  HEVC and then fault on a real stream, and the bridge's ladder cannot see that
  — its pipeline is healthy and the failure is one process away in the GPU. So
  `fallbackFromHevc()` restarts once with the transcode path when the renderer's
  decoder actually errors.

The first real test is the one the integration doc already describes: point
Settings → Video at HYRAK Receiver, set the decoder address, press Start.

---

## Related

- `PC_VIDEO_TELEMETRY_INTEGRATION.md` — what the ground unit emits
- `GROUND_DECODER.md` — the decoder hardware and its design
- `video-transport-modes.md` — how this compares to the other nine modes
- `ADR/ADR-005` — probe at run time, always degrade, never fail

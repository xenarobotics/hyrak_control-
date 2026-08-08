# PC-side video + telemetry integration — spec for HYRAK Control

**Status:** ground unit side is built, deployed, and tested live against a real
transmitting air unit (see below). This doc specifies what the PC application
needs to implement to consume it. Nothing here requires further ground-unit
changes.

---

## Quick reference

| What | Value |
|---|---|
| Video (direct, lowest latency) | UDP port `5600` on the ground unit's IP, RTP/H.265 PT 96 |
| Video (RTSP, generic/clean) | `rtsp://<ground-unit-ip>:8554/video`, use `protocols=tcp` |
| Telemetry | UDP port `14550` on the ground unit's IP, raw MAVLink |
| Ground unit IP (tested link) | `192.168.50.12` |
| WebRTC | **Disabled on the server.** Don't build against it — see below. |

Two ready-to-run reference scripts exist at the repo root
(`watch-video-udp.sh`, `watch-video-rtsp.sh`) that play the feed standalone
via `gst-launch-1.0` — useful to sanity-check the stream independently of
whatever the app is doing, if video ever looks wrong during app development.

---

## What the ground unit sends

Two independent UDP streams, both from the Luckfox's IP on the Ethernet link:

| Stream | Protocol | Port | Format |
|---|---|---|---|
| Video | RTP | 5600 | H.265, dynamic payload type 96, clock-rate 90000 |
| Telemetry | raw UDP | 14550 | MAVLink, unmodified bytes off the Pixhawk UART |

Both are already **decrypted** — the RF layer's ChaCha20 decryption and Reed-Solomon
FEC recovery happen entirely on the Luckfox before either stream leaves it. The
PC needs no keys, no wfb-ng, no RTL8812EU driver.

The ground unit's Ethernet address is currently static (`192.168.50.12` on the
tested link, `192.168.50.0/24` subnet) — see "Open items" below re: making this
non-hardcoded for a general release.

---

## Video: what the application must do

**Do not decode on the ground unit.** Raw 1080p30 video is ~746 Mbps; the
Luckfox's Ethernet is 10/100 Mbps. Decode must happen on the PC, where there's
a real GPU. The ground unit's only job is decrypting and forwarding compressed
H.265 — confirmed working, real 1080p30 stream, packet loss near-zero under
good RF conditions.

### Validated pipeline (GStreamer)

This exact pipeline was tested live against a real transmitting air unit and
confirmed both correct (real decoded 1920x1080@30fps H.265) and low-latency
(subjectively "smooth, no perceptible latency" per live testing, vs. ~10s
latency with default/untuned RTSP or WebRTC playback):

```
udpsrc port=5600 caps="application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96" !
rtpjitterbuffer latency=50 drop-on-latency=true !
rtph265depay ! h265parse ! <decoder> ! videoconvert ! <sink>
```

Every flag here matters and was empirically required — this is not arbitrary tuning:

- **`udpsrc` direct from the ground unit, no relay hop.** We tested RTSP (via a
  MediaMTX server on the board) as an "any PC on the network, no setup"
  alternative — it works (see the RTSP section below), but adds latency
  versus this direct path, because generic clients (`ffplay`, VLC) apply
  their own buffering defaults tuned for smooth playback, not minimum
  latency. For a single PC on a direct/known link, skip the relay entirely.
  **WebRTC is not viable for this stream**: mainstream browsers (Chrome,
  Firefox) don't support H.265/HEVC decode in WebRTC at all — this is a
  browser codec limitation, not a config issue, and would require an extra
  H.265→H.264 transcode stage to work around (not worth the CPU/latency cost
  it would add). Don't invest in a WebRTC path unless the air-side codec
  changes.
- **`rtpjitterbuffer latency=50`** — caps the jitter buffer at 50ms instead of
  the much larger defaults generic players use.
- **`drop-on-latency=true`** — without this, `latency=` only sets a *target*;
  the buffer can still silently grow past it over a session (clock drift,
  momentary decode hiccups) with nothing forcing it back to the live edge.
  This was the actual fix for latency creeping back up during testing — not
  optional.
- **No `sync=true` / clock-paced sink** — push frames to display as soon as
  they're decoded, don't pace to a presentation clock.

**Tuning `latency=`:** 50ms was the first validated value; 20ms was also
tested live on the direct-UDP path and ran cleanly (no pipeline errors,
`drop-on-latency` didn't need to intervene under normal conditions). Lower
values shrink the buffer's tolerance for jitter — on a stable direct link
20-25ms is a reasonable target, but there's no universally correct number;
if you see micro-stutter (visual, not something logs will show), back off
toward 30-50ms. Treat this as a dial to tune against your actual link
conditions, not a fixed constant.

### RTSP delivery (for "any player, no app" access)

The ground unit also runs a MediaMTX RTSP server at `rtsp://<ground-unit-ip>:8554/video`,
serving the exact same H.265 RTP stream — this does **not** decode anything
on the ground unit, it only re-wraps the same compressed stream in RTSP
session framing. Decode still happens entirely on the PC, same as the direct
path above. Useful for handing a URL to a generic player without any app
integration.

Two transport options, a real trade-off between them (both are enabled on
the server):

- **`protocols=udp`** — same latency profile as the direct path, but UDP
  doesn't retransmit: any RF-level packet loss shows up as visible decode
  artifacts (macroblock corruption) in the picture.
- **`protocols=tcp`** — lost packets are retransmitted before reaching the
  decoder, so the picture stays clean, at the cost of added and less
  predictable latency (retransmission wait, head-of-line blocking). This is
  what VLC uses by default over RTSP, and is why VLC looks clean but has
  noticeably more latency (~0.5s observed) than the direct pipeline.

If your app implements its own RTSP client (rather than spawning VLC as a
subprocess), a tuned pipeline over TCP gets meaningfully lower latency than
VLC while keeping the clean, loss-tolerant picture — VLC's extra internal
buffering/AV-sync overhead is the main gap, not the TCP transport itself:

```
rtspsrc location=rtsp://<ground-unit-ip>:8554/video protocols=tcp latency=50 !
rtpjitterbuffer latency=50 drop-on-latency=true !
rtph265depay ! h265parse ! <decoder> ! videoconvert ! <sink>
```

Validated live: connects cleanly, decodes correctly, visibly snappier than
VLC on the same stream. Recommendation: use this (TCP) for a generic/robust
RTSP path in the app; use the direct-UDP pipeline above when you specifically
want the lowest possible latency and can tolerate occasional artifacts under
real RF loss.

### Decoder element — pick per platform for hardware acceleration

Software decode (`avdec_h265`) works and was used for all testing (confirmed
correct output, moderate CPU use on a modern x86 desktop). For production,
prefer hardware decode:

- **Windows + NVIDIA GPU:** `nvh265dec` (gst-plugins-bad `nvcodec` plugin) —
  talks to `nvcuvid.dll`, already present with any NVIDIA driver, no extra
  bundling. Alternative: `mfh265dec` (Media Foundation) — goes through
  Windows' own hardware video acceleration generically.
- **Linux ARM64:** depends on the specific SoC (VAAPI / V4L2 stateless codecs /
  NVDEC on Jetson). Confirm what's actually available on the target hardware;
  `avdec_h265` is the safe fallback if nothing else is confirmed working.

### Sink — must render into the app's own window, not a standalone one

`autovideosink` was used for testing (pops up its own window) — for embedding,
use a sink that draws into a window handle you own:
`d3d11videosink` (Windows) / `glimagesink` (Linux), driven via GStreamer's
video overlay API (`gst_video_overlay_set_window_handle`).

Note: `vaapisink` was tried during testing and produced no visible window (it
renders to a DRM plane, not an X11 window) — avoid it for an embedded UI;
`vaapih265dec` for decode is fine, just pair it with a normal windowed sink
rather than `vaapisink`.

### Getting GStreamer onto each target

- **Windows:** official redistributable runtime from gstreamer.freedesktop.org
  — copy its DLLs/plugins alongside the app executable, no system-wide install
  needed for the end user.
- **Linux (x86_64 or ARM64):** distro packages (`apt install gstreamer1.0-*`
  or equivalent) — same effort on either architecture.
- **Windows ARM64 (if actually a target):** no official prebuilt GStreamer
  binaries as of now. Would require building via GStreamer's Cerbero tool.
  Confirm whether this is a real target before committing engineering time to it.

### Integration approach

Depends on the app's language/framework (not yet specified to me — get this
from whoever's implementing):
1. **Subprocess + window handle**: spawn a bundled GStreamer pipeline (via
   `gst-launch`-equivalent invocation or a small wrapper binary) with the
   pipeline above, hand it a window handle to render into. Fastest to wire up.
2. **Native library binding**: link GStreamer directly (C/C++ native API,
   `gstreamer-rs` for Rust, `gst-sharp` for C#, PyGObject for Python) and
   construct the pipeline programmatically. More control, no subprocess to manage.

---

## Telemetry: UDP MAVLink

**Not fully verified end-to-end** — worth being precise about this rather than
overstating it. What's confirmed:

- The ground unit's `wfb_rx` for the MAVLink radio port is running, correctly
  configured, and forwarding to UDP port 14550 on the PC — mechanically
  identical to the video path, which we did fully verify with real data.
- Port 14550 is QGroundControl's own conventional default MAVLink UDP port —
  the format is already exactly what QGC expects, no translation needed.
- UDP delivery end-to-end (ground unit → PC, arbitrary payload) was confirmed
  clean with a synthetic test packet — no firewall blocking.

What's **not** confirmed: real MAVLink traffic actually flowing, because no
Pixhawk was connected to the air unit's UART during this session (bench test,
video-only). The mechanism should work identically to video the moment a
flight controller is connected on the air side — same `wfb_rx` pattern, same
proven RF link — but "should work" isn't "confirmed working" and this needs a
real test with a Pixhawk attached before considering it done.

**For your application:** if you want telemetry inside your own UI (not just
handing it to QGroundControl separately), same deal as video — a UDP socket
listening on 14550, parsing MAVLink frames. No decode/codec concerns here,
it's just structured binary data, much simpler than the video side.

---

## Open items the app team should know about

1. **RTL8812EU USB connection stability.** During testing, the RF dongle
   dropped off the ground unit's USB bus multiple times over a session
   (unrelated to RF conditions) and needed physical reseating. Root cause
   traced to power delivery on the ground unit's specific hardware setup, not
   fixed in software. Your app should handle "video stream stops arriving"
   gracefully (reconnect/retry logic on the UDP receive side) rather than
   assuming the link is always up once established.
2. **Ground unit's IP is currently hardcoded/static**, not auto-discovered.
   Fine for a single direct-cable setup; if the product needs to handle
   "whichever PC connects, whatever IP it gets," that's unsolved — either a
   fixed convention (documented static IP scheme, current approach) or a
   discovery mechanism (mDNS, etc.) needs deciding.
3. **CPU headroom on the ground unit, measured under real load:** with both
   video paths (direct-UDP + RTSP) and MediaMTX running simultaneously,
   sustained usage is roughly `wfb_rx` (direct) ~9% + `wfb_rx` (RTSP feed) ~9%
   + MediaMTX ~20% ≈ **40%+ of the single Cortex-A7 core**, at a modest ~4-5
   Mbps test stream — not the ~11% figure quoted earlier, which only covered
   one video path. The design doc's target range for real 1080p is 8-20 Mbps;
   this should scale roughly linearly and hasn't been measured at that rate.
   Running two independent `wfb_rx` decrypt paths for the same RF stream is
   the main cost here — if CPU ever becomes a real constraint, the RTSP path
   could be made on-demand (only spin up its `wfb_rx` + MediaMTX when a
   client actually connects) instead of always-on, but that's not implemented.
4. **A stuck/retrying client can silently overload the ground unit.** We hit
   this directly during testing: an open browser tab endlessly retrying a
   failed WebRTC connection drove MediaMTX to 44% CPU through repeated
   SDP/ICE negotiation churn alone, which was enough to visibly degrade video
   quality (the CPU contention causes `wfb_rx` to occasionally miss its
   scheduling slot, which looks identical to real RF packet loss). WebRTC is
   now disabled server-side specifically to close off this failure mode. The
   general lesson for the app: don't leave idle/failed connections retrying
   against the ground unit indefinitely — this box has very little CPU
   headroom to absorb that kind of accidental load.
5. **RF link quality is sensitive to distance in ways that aren't purely
   "closer is better."** At very close range (a few feet) the receiver can
   saturate and lose packets despite a strong RSSI reading — this isn't a
   software issue, it's the drone's default TX power (30 dBm / 1W, tuned for
   real flight range) overloading the receiver at point-blank range. Not
   something the PC app needs to handle, but worth the whole team knowing so
   "it got worse when we moved closer" doesn't get mistaken for a bug.
6. **Occasional decode artifacts (macroblock corruption / "white patches")
   should be expected, not treated as an app bug.** Under real RF conditions
   (item 5) and the CPU headroom noted in items 3-4, some packet loss is
   normal even after FEC recovery — this shows up as brief visual corruption,
   not a crash or a frozen stream. The app doesn't need special handling
   beyond what's already recommended in item 1 (tolerate stream hiccups,
   don't treat a lossy moment as a fatal error); most H.265 decoders already
   do reasonable error concealment on their own.

# Video pipeline audit - mesh air units in the HYRAK app (2026-09-21)

What was verified, how, and what each stage does to the picture. Numbers are
measurements from this laptop (ground station + server + viewer), unit 2 on
udp:5602 unless stated.

## 1. The source (verified)

Probed 3 s of the raw stream taken from the backend's bit-exact endpoint
(`ffprobe` on `/api/video/feeds/5602/hevc`), independently confirmed by the
mesh session with a capture at its fan-out:

| property | value |
|---|---|
| codec | HEVC Main, level 4.0, 1920x1080, 30 fps, GOP 30 (keyframe every 1 s) |
| bitrate | 3 Mbit/s ceiling, measured 2.8-2.9 Mbit/s |
| pixel format | `yuvj420p` - **full range (0-255)**, `color_range=pc` |
| colour | primaries / transfer / matrix all **BT.709**, written in the SPS VUI |
| range honesty | luma min 3, max 255, 3.55 % of pixels above 235: the sensor really delivers 0-255 |
| transport | RTP PT 96, per-unit SSRC (node id in the second byte), random start sequence, packets paced, DSCP CS5 |
| arrival | 0 loss; lateness vs RTP timestamp median 5 ms, 99.9th 44 ms, worst 44.5 ms (direct hop) |

Earlier symptoms explained: "feels 720p" was a real 720p (unit left at 720p
after relay tests, now pinned 1080p); green blocks were the sender restarting
its sequence numbers from zero under a fixed SSRC (fixed, RFC 3550 now).
"PT=60" in ffmpeg's log is 96 in hex, not a second stream.

## 2. The three ways the app can carry it

```
unit --RTP/H.265--> udp:5600+id --> feeds.py SharedReader (ONE per port, demux once)
                                     |-- raw H.265 AUs  --> /api/video/feeds/<port>/hevc  (A)
                                     |-- raw H.265 AUs  --> ffmpeg NVENC H.264 --> /feeds/<port>/h264 (B)
                                     '-- decoded frames --> MediaRelay --> WebRTC VP8/H.264 sender (C)
                                                                        '--> AI / avoidance / camera wall
```

| path | encode stages | colour signalling | decode in browser | latency added | when used |
|---|---|---|---|---|---|
| A bit-exact HEVC | none | VUI intact | WebCodecs, hardware only | ~0 (no buffer) | Chromium reports an HEVC decoder |
| B GPU H.264 | one (NVENC, 10 Mbit/s CBR, GOP 30) | **VUI rewritten explicitly**: full range, BT.709 x3 | WebCodecs, hardware | ~1 frame + NVENC (few ms) | no HEVC decoder (this laptop: NVIDIA on Linux, no VAAPI) |
| C WebRTC | one (libvpx VP8 realtime, up to 12 Mbit/s) | **none** - VP8 carries no VUI; browsers assume BT.601 limited | Chromium VP8, software | RTP + jitter + decode, ~100-300 ms | fallback, and the camera-wall tiles |

Measured on path C before the change: encode+packetise 12 ms/frame, 30 fps
delivered, 1-3 frames dropped per 5 s window, sender at 12 Mbit/s, ICE path
`host->host` (direct, no TURN).

## 3. Where the washed-out colours came from

The stream is full-range BT.709 and says so. On path C the frame is decoded
by ffmpeg (correct), converted by swscale to limited-range yuv420p for VP8
(correct compression), and encoded as VP8 - which has **no way to say
"BT.709"**. Chromium renders WebRTC VP8 as **BT.601 limited**. Decoding
BT.709-matrixed data through the BT.601 matrix desaturates reds and greens
and shifts skin tones - exactly "washed out, less vivid" next to a gst
window that reads the VUI (`colorimetry=1:3:5:1`) and displays it right.
It is not a display filter: nothing in the app draws over or filters the
pane (checked: no CSS filter/opacity on the video element or canvas).

Path B fixes it at the source of the error: NVENC is told
`-color_range pc -colorspace bt709 -color_primaries bt709 -color_trc bt709`,
verified with ffprobe on the lane's output (`yuvj420p(pc, bt709)`), and
WebCodecs honours the H.264 VUI. The pane now logs the decoded frame's
`colorSpace` (`[webcodecs] frame ... colorSpace {...}`) on the first frame -
`fullRange: true, matrix: bt709` is the proof on the viewer side.

## 4. Latency budget (path A/B)

| stage | cost |
|---|---|
| unit encode + WiFi | not measured here (mesh session: sub-frame pacing) |
| RTP demux in the reader | 0 buffer (`reorder_queue_size 0`, `max_delay 0`) - a reorder is a drop, acceptable at 0 % loss |
| B only: NVENC transcode | 1 frame (33 ms) + a few ms |
| HTTP chunk to browser | loopback, < 1 ms |
| WebCodecs decode + canvas | 1 frame, `optimizeForLatency` |

The gst window uses an 80 ms jitter buffer; the app path uses none, so the
app should now lead the window slightly, not trail it.

## 5. Robustness rules now in force

- One reader per port, shared by every consumer (single view, wall, AI,
  raw endpoints); refcounted; the port is released when the last consumer
  leaves. Nothing else may bind 5600+id while the app shows that unit.
- The reader reopens its socket on any I/O timeout (3 s) and logs once a
  minute while silent; it never dies on a quiet source (mesh re-parenting).
- A dead reader is stopped before a port is reopened; the bind is retried.
- Transcoders start at a keyframe and stop when their last subscriber leaves.
- The unit probe (`/api/video/mesh-units`) never binds ports our readers hold.
- Sessions release their feed on socket disconnect, not only on pc close.

## 6. Still open

- Confirm in the desktop console which path is active (`GET .../hevc` or
  `.../h264` in the backend log; `[webcodecs] frame ... colorSpace` in the
  console). On this laptop B is expected.
- Camera-wall tiles still use path C (VP8): fine for thumbnails, not for
  judging colour. Move them to B when a wall is used for inspection.
- Path A on a machine with a hardware HEVC decoder has not been exercised.

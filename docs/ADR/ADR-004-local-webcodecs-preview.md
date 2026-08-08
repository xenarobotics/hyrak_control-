# ADR-004 — Local WebCodecs canvas preview replaces the fake-webcam hack

Date: 2026-07-26 · Status: **Accepted (planned, not implemented)**

## Problem

To show the air unit's feed in the UI today, `airUnitVideoBridge.ts` decodes
H.265 into a **v4l2loopback** virtual webcam (`/dev/video10`), which the
renderer re-captures with `getUserMedia`. Costs:

- A device write/read round trip (~20-60ms of pure overhead).
- Requires a kernel module and `sudo modprobe` — **Linux only**, while
  `desktop/package.json` already declares Windows NSIS and macOS DMG targets.
- Feeds a browser re-encode for the WebRTC uplink.

## Decision

Decode in the client and paint frames **straight to a canvas** using
**WebCodecs `VideoDecoder`** in the renderer, fed encoded H.265 access units
over Electron IPC from the main process. No virtual camera, no
`MediaStreamTrack`.

## Reason

- No kernel module; cross-platform for free.
- Removes the device round trip.
- **`MediaStreamTrackGenerator` / Insertable Streams is not needed.** It was
  floated as the replacement, but it is only required to feed a
  `MediaStreamTrack` into WebRTC from the client. Since SRT owns the uplink
  (ADR-002), the preview only ever needs to reach a canvas. This removes a
  deprecated, Chromium-version-sensitive API from the design entirely.
- **Resolves the apparent contradiction** ("you said UDP isn't possible in a
  browser, now you're proposing it"): the renderer restriction is untouched.
  UDP and demuxing stay in the Electron **main** process (full Node.js, not
  sandboxed); only frames cross to the renderer over Electron IPC.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Keep v4l2loopback | Retained for the `camera` mode only (ADR-003), not for `air_unit_srt`. |
| Windows DirectShow virtual camera / macOS CMIO plugin | **Rejected** — the same hack re-implemented per OS, not a better alternative. |
| Native `@roamhq/wrtc` `RTCVideoSource` | Rejected — viable, and better than pure-JS `werift`, but unnecessary once the client no longer feeds WebRTC at all. |
| ffmpeg decode to rawvideo on stdout → canvas | **Kept as the fallback** if WebCodecs HEVC is unavailable. Downscale the preview to 720p; raw 1080p yuv420 @30fps is ~93 MB/s over IPC, which must be avoided. |

## Trade-offs

- Depends on Chromium HEVC decode support, which is hardware-dependent and may
  need `enable-features=PlatformHEVCDecoderSupport`. **Unverified — this gates
  the phase.** Check `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})`.
- Requires a binary IPC channel for frame data; the existing
  `hyrak-bridge-event` carries JSON-ish meta. Encoded access units are small
  (KB), so this is tractable — **raw decoded frames must never cross IPC.**

## Consequences

- Pilot-facing latency drops to ~20-60ms because frames never leave the
  machine, versus the current measured <150ms.
- **Unlocks an existing feature for free.** `signaling.py:152` reads
  `client_overlay = bool(data.get("clientOverlay")) and not server_sourced`,
  disabled because *"there's no local camera preview to draw an overlay canvas
  on top of."* A local preview makes that false, so `air_unit_srt` qualifies
  for the client-overlay path (commit `7c58411`), which already sets
  `return_video=False`. **The entire downlink video leg disappears with no new
  code.**
- Windows/macOS air-unit support becomes possible for the first time.
- Architecture choice settled: keep the local preview (hybrid) rather than
  round-tripping the pilot's view through the server. Routing the pilot's view
  via the server would add WAN twice (~300-800ms) and is only defensible for
  AI-vision-only Modules use, never for flying by eye.

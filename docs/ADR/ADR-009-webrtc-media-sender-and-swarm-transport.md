# ADR-009: A WebRTC media sender in the desktop app, and the transport for many feeds

Status: accepted (sender proven; swarm layer planned)
Date: 2026-07-27

## Context

Two problems, one answer.

### Problem 1 — `rtsp_camera` is slow for structural reasons

Measured on the live SIYI camera (2026-07-27), everything upstream of the
browser is fine: 33 ms RTT, SIYI's RTSP server pre-buffers only +0.14 s,
delivery is 0.996x realtime, our transcode keeps up at 1.04x on 0.41 cores.
And `siyi_rtsp` — where the *backend* opens the camera — measured ~300 ms
glass-to-glass on the same hardware and camera, while `rtsp_camera` measured
1–1.5 s.

The difference is not buffering. It is the number of codec steps:

```
siyi_rtsp     RTSP -> [server decode+encode] -> WebRTC -> [browser decode]
              = 3

rtsp_camera   RTSP -> [ffmpeg decode+encode] -> fMP4 -> [Chromium decode]
              -> captureStream -> [browser WebRTC encode] -> [server decode]
              -> [server encode] -> WebRTC -> [browser decode]
              = 7, and the video passes through a browser to get back out again
```

Four releases of fragment/buffer tuning could not fix that, and did not. The
`<video>` + `captureStream()` hop exists only because the *browser* was the
only thing in the client that could speak WebRTC.

`siyi_rtsp` cannot be the answer either: it requires the server to sit on the
camera's network. That was briefly true on the dev machine and stopped being
true the moment it joined a different hotspot — `[Errno 1414092869] Immediate
exit requested` is PyAV's open timeout on an unroutable address. It is a
testing convenience, permanently.

### Problem 2 — many feeds, from anywhere

A swarm client will have several sources at once: multiple RTSP cameras,
multiple RTP/UDP air-unit feeds on different ports, possibly several webcams.
The instinct is to build a multiplexer: forward N UDP ports to the server over
some wrapper protocol. That instinct should be resisted (see below).

## Decision

**Give the desktop app its own WebRTC sender, in the Electron main process,
using `werift`.** Add it as a NEW video source alongside the existing ones —
nothing already working changes.

```
RTSP -> ffmpeg (-c copy, or one transcode for HEVC) -> RTP/UDP on loopback
     -> werift MediaStreamTrack.writeRtp() -> ICE/DTLS-SRTP -> server (aiortc)
```

3 codec steps instead of 7, and the browser is removed from the *upload* path
entirely. The pilot's own view stays the loopback fMP4 preview (fixed in
0.1.18), so it never leaves the machine at all.

### Why this also solves NAT

This is the part that makes it strictly better than `rtsp_relay`. Sending over
WebRTC means ICE + STUN + TURN, so it traverses NAT exactly like a webcam
does today — including networks that block UDP outright, via TURN over TLS:443.
No `relay_public_host`, no forwarded UDP 9000-9100, no VPN, no Tailscale. The
TURN infrastructure already in use for the browser path serves this unchanged.

`rtsp_relay`'s SRT uplink needed a routable server address and died behind
NAT, which is the normal case. That is why it never worked off a desk.

### Why `werift`, not `node-datachannel` or `wrtc`

`werift` is **pure TypeScript**. `node-datachannel` and `wrtc` ship native
binaries. Today produced two separate release-breaking bugs from exactly that
(a Linux `bindings.node` and a Linux `ffmpeg` inside a Windows package, see
CHANGELOG 0.1.21 / 0.1.22). Adding another cross-compiled native dependency
would be adding a third instance of a bug class we have just paid for twice.
Pure JS cross-builds correctly by construction.

### Verified before committing

Proof of concept run against **aiortc**, the actual server library — not a
werift-to-werift loopback, which would have proven nothing about interop:

```
[aiortc] TRACK received: kind=video
[aiortc] FIRST FRAME DECODED: 640x360
[aiortc] t=15s ice=completed frames_decoded=419     (~30fps sustained)
[werift] t=15s ice=connected  rtp_written=863
```

Two things that test surfaced, both of which would otherwise have been
mysterious failures in production:

1. **aiortc rejects the offer outright without matching fmtp.**
   `is_codec_compatible()` (rtcpeerconnection.py) compares
   `packetization-mode` *and* the parsed H.264 **profile**, not just the mime
   type. aiortc advertises `packetization-mode=1`; werift with no `parameters`
   defaults to `0`, so there is no common codec and
   `setRemoteDescription` raises *"Failed to set remote video description send
   parameters"*. The sender must declare:
   `packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42e01f`
   (only the profile is compared, not the level, so `42e01f` is safe with
   libx264's Constrained Baseline output.)

2. **The encoder must repeat SPS/PPS.** The first second of the receiver's log
   was `non-existing PPS 0 referenced` — the receiver attached mid-stream and
   had no parameter sets. It self-heals at the first keyframe, but a real
   operator would see a second of garbage on every start. `repeat-headers=1`
   on libx264 (or `-bsf:v dump_extra`) puts SPS/PPS before every keyframe.

### Server-side changes: none required

`signaling.py`'s `else` branch already handles an inbound track via
`@pc.on("track")` and `relay.subscribe(track, buffered=False)` — that is the
existing browser-camera path. A desktop-originated offer carrying a sendonly
video track lands there unchanged. The new source must therefore NOT be listed
in `isServerSourced()`, for the same reason `rtsp_camera` is not.

## The swarm / many-feeds question

**Do not build a UDP multiplexer.** WebRTC already is one, and this is the
single most useful fact for the swarm design:

- **BUNDLE (RFC 8843)** puts every track of a PeerConnection onto **one** UDP
  flow, one ICE session, one DTLS handshake, demultiplexed by SSRC/mid. Ten
  drone cameras do not need ten ports, ten NAT holes or ten TURN allocations —
  they need one PeerConnection with ten tracks.
- That collapses "multiple UDP ports and channels" from a networking problem
  into an application-level naming problem, which is the whole point.

For many publishers and many subscribers over the internet, the established
architecture is an **SFU** (Selective Forwarding Unit). A swarm ground station
is structurally identical to a video conference: N publishers, M subscribers,
selective subscription, adaptive bitrate, everyone behind NAT.

Realistic components, with what each is actually for:

| Tool | Language / licence | Role |
|---|---|---|
| **LiveKit** | Go, Apache-2.0, self-host or cloud | Full SFU with rooms/participants/tracks, built-in TURN, simulcast, adaptive subscription, recording (egress), and a **Python server SDK** — matches this backend. Strongest fit for a swarm. |
| **mediasoup** | Node + C++ core | Lower-level SFU *library*. More control, more work; you build the room model. |
| **Janus** | C | Plugin gateway. Its RTP-forward plugin is useful for teeing media into an AI pipeline. |
| **MediaMTX** | Go, single binary | Protocol *converter*: ingests RTSP/RTMP/SRT/WebRTC/WHIP and republishes as any of them. Closest thing to the "networking wrapper" idea, best as an edge/client component. |
| **Pion** | Go | Build-your-own WebRTC. What LiveKit is built on. |
| **GStreamer** | C | `rtspsrc`/`webrtcbin`/`whipsink`/`srtsink`. The most flexible pipeline glue. |

**Signalling should standardise on WHIP/WHEP** (WHIP is **RFC 9725**) rather
than growing more bespoke socket.io events. It is plain HTTP — POST an SDP
offer, get an answer — which means it works through the existing cloudflared
tunnel, and any tool can publish to it (ffmpeg 7.1+ has a native `whip` muxer;
our bundled 7.0.2 does **not** — checked). Media still rides ICE/TURN.

Relevant specs: ICE **RFC 8445**, TURN **RFC 8656**, BUNDLE **RFC 8843**,
WHIP **RFC 9725**, SRTP **RFC 3711**.

### The DataChannel path: measured and working

**H.265 end-to-end, bit-exact, no transcode**, verified against the real
modules (`WebrtcSenderBridge` -> `datachannel_video_source` ->
`udp_video_source`):

```
frames_decoded: 296     sizes: ["1280x720"]     ~30fps sustained
NAL parse errors: 8     (only the initial mid-stream join)
```

Throughput, measured separately with paced synthetic traffic:

| Target | Goodput | Loss | p50 | Latency trend |
|---|---|---|---|---|
| 2 Mbit/s | 1.97 | 0.0% | 0.24 ms | flat |
| 8 Mbit/s | 7.90 | 0.0% | 0.26 ms | flat |
| 20 Mbit/s | 19.71 | 0.0% | 0.41 ms | flat |
| 50 Mbit/s | 49.34 | 0.0% | 0.71 ms | flat |

Channel configuration is `ordered: true, maxRetransmits: 0` — PR-SCTP, ordered
but unreliable. Both halves matter: no retransmission keeps head-of-line
blocking bounded, and ordering is required because `ordered: false` reorders
even on loopback (observed `218,219,220,222,223,224,221,...`) while the
server's decoder runs `reorder_queue_size=0`.

### Four bugs this cost, all worth remembering

1. **`-bsf:v dump_extra` on a copy-to-RTP path is actively harmful.** It
   *replaces* the `hevc_mp4toannexb` filter ffmpeg inserts automatically, so
   the HEVC stays length-prefixed, the RTP payloader cannot find NAL
   boundaries, and it emits **no FU/AP packets at all**. Symptom: `Error
   parsing NAL unit #0` forever, 0 frames, while packet counters look healthy.
   This was the real cause and it was an unvalidated speculative addition.
2. **ffmpeg must not start until the transport is up.** `start()` originally
   launched it right after creating the offer, but the DataChannel is not
   `open` until the answer returns — every packet in that window is silently
   discarded. Now launched from `acceptAnswer()`, after waiting for `open`.
3. **RTSP demuxer options must be conditional on the URL scheme.** ffmpeg
   rejects `-rtsp_transport` for a non-RTSP input with "Option not found".
4. **Parameter sets must be in-band.** `udp_video_source.py`'s SDP has no
   `sprop-vps/sps/pps` fmtp, so the stream must carry VPS/SPS/PPS itself
   (`repeat-headers` on the encoder). A real camera does; an MP4 with them only
   in extradata does not, and decodes nothing.

The methodological lesson, repeated from the fMP4 bug: **three hypotheses
(fragmentation, packet size, reliability policy) were all wrong, and each was
disproved by the same observation** — byte-for-byte identical results across
every channel configuration, which could only mean the variable was upstream of
the channel entirely.

### Staging

1. **Now** — one werift sender for one RTSP source, as an additional mode.
   Proves the path in production.
2. **Next** — N tracks on that one PeerConnection (BUNDLE), one per
   camera/air-unit. No new ports, no new NAT work.
3. **Later** — if operator-count grows past a handful, move the fan-out to an
   SFU (LiveKit) and keep the desktop sender as-is; it is already a standard
   WebRTC publisher, so an SFU can ingest it without client changes.

## Consequences

- `rtsp_camera` and `rtsp_relay` stay exactly as they are. This is additive.
- One new pure-JS dependency (`werift`), no native build surface.
- The upload path no longer depends on Chromium's `captureStream()`, so the
  `<video>`-element buffering that dominated the latency budget is gone from it.
- For overlay-capable AI modes the browser needs no return video at all: the
  local fMP4 preview plus client-side overlays (already built) is the lowest
  latency arrangement available, and this makes it reachable.
- Bespoke transports (`air_unit_udp`'s raw UDP, `rtsp_relay`'s SRT) become
  legacy: both exist to solve reachability that ICE/TURN solves generally.
  Neither is removed here.

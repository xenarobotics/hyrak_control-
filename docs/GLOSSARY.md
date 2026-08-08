# GLOSSARY

## Project terms

| Term | Meaning |
|---|---|
| **HYRAK** | Product name. Internal backend package is `verocore-backend`; both appear in code. |
| **Air unit** | The custom RF video/telemetry link on the drone (wfb-ng based). Delivers RTP/H.265 over UDP to the ground station. |
| **Ground unit / ground station** | The client-side RF receiver. `communication/start-gs.sh` runs `wfb_rx`. |
| **Analysis mode** | One AI vision mode. `AnalysisMode` enum in `sessions/models.py`; analyzers registered in `vision/modules/__registry__.py`. |
| **Video source** | Where a stream's frames originate *and* how they reach the server. `VideoSource` enum in `frontend/src/lib/videoSource.ts`. Each value is a preset fixing four internal axes. |
| **Server-sourced** | A video source the *server* opens itself (`air_unit_udp`, `siyi_rtsp`). The offer declares a recvonly video transceiver; there is no incoming browser track. |
| **Client overlay / overlay mode** | Browser shows its own feed and draws AI results on `CvOverlayCanvas` from `cv_results` JSON. Server sets `return_video=False` — no downlink video at all. |
| **Processed feed** | The opposite: the server composes annotations into pixels and re-encodes them back down. |
| **Bridge** | A desktop native capability behind the `NativeBridge` contract (`udp`, `tcp`, `serial`, `rtsp`, `air-unit-video`). |
| **Session** | One operator connection. Owns a `pc_id`, an analysis mode, a telemetry link, and optionally a `SerialBridge`. Ephemeral and in-memory. |
| **Swarm** | Multi-drone SITL fleet (10 instances, ports 14541+), tag-multiplexed over one `udp` bridge. |

## Transport and codec terms

| Term | Meaning |
|---|---|
| **WebRTC** | Real-time media stack. Media is **SRTP over UDP** with DTLS keying and ICE. Browser-native. ~100-300ms. |
| **SRTP** | Encrypted RTP — WebRTC's media wire format. A lossless envelope: it does not degrade quality. |
| **ICE / STUN / TURN** | NAT traversal. **TURN** relays media when direct paths fail; Cloudflare TURN over **TLS:443** is the only path that works on UDP-blocking networks. |
| **RTP** | Real-time packet format. WebRTC *is* RTP, but only RTP that came through ICE+DTLS — you cannot point `RTCPeerConnection` at a raw UDP socket. |
| **RTSP** | A *session-control* protocol (DESCRIBE/SETUP/PLAY), not a transport or codec. Never a candidate here — nothing in the chain runs an RTSP server. |
| **SDP** | Text description of a stream's format. `udp_video_source.py` writes one so ffmpeg knows the RTP payload is H.265. Because the format is pre-declared, opening "succeeds" instantly even with zero packets arriving — hence the 5s no-frames guard. |
| **SRT** | Secure Reliable Transport. UDP-based, Linux Foundation governed. Carries MPEG-TS. **Bounded retransmission** within a configurable latency window: recovers what it can in budget, drops the rest so the stream keeps moving. Built-in AES; caller/listener/rendezvous NAT modes. **No browser support, no TCP fallback.** |
| **RIST** | SRT competitor. Comparable, thinner tooling. |
| **MPEG-TS** | Container SRT typically carries; wraps H.264/H.265. |
| **H.265 / HEVC** | The air unit's codec. **Chromium refuses it in WebRTC SDP negotiation** (Safari accepts it) — the root reason a transcode was unavoidable. |
| **Annex-B** | H.265 bitstream framing with start codes. RTP depayload already produces it, so `-c copy` into MPEG-TS needs no bitstream filter. |
| **VPS/SPS/PPS** | H.265 parameter sets. WebCodecs `VideoDecoder.configure()` needs them; in-band with `annexb` mode is simplest. |
| **MSE** | `MediaSource` + `<video>`. A **playback sink only** — cannot be a WebRTC send source. Buffers for stall-free playback, so higher latency than WebRTC. |
| **WebCodecs** | Browser API for raw encoded access units. `VideoDecoder` → `VideoFrame` → canvas. Lowest-latency browser decode path. HEVC support is hardware-dependent. |
| **MediaStreamTrackGenerator** | Insertable-Streams API for building a `MediaStreamTrack` from frames. Deprecated in favour of `VideoTrackGenerator`. **Not needed here** once SRT owns the uplink. |
| **WebTransport / QUIC / HTTP3** | Not used anywhere in this stack. QUIC streams are reliable+ordered (head-of-line blocking); datagrams avoid that but require hand-building everything WebRTC provides. |
| **MoQ (Media over QUIC)** | IETF draft. The plausible long-term successor; not production-ready. |
| **Generation loss** | Quality lost by decoding and re-encoding. The actual cause of the "WebRTC reduces quality" impression. |
| **Transcode pass** | One decode or encode. **The metric that matters on weak clients** — the design optimises for fewest passes. |

## Platform terms

| Term | Meaning |
|---|---|
| **Electron main process** | Full Node.js, **not sandboxed**. Raw UDP (`dgram`), child processes, native modules. All bridges run here. |
| **Electron renderer** | Chromium with **exactly a browser tab's restrictions**. No raw UDP, ever. |
| **v4l2loopback** | Linux kernel module creating a virtual webcam (`/dev/video10`). Lets ffmpeg-decoded frames be re-captured by `getUserMedia`. Requires `sudo modprobe`; **Linux only**. |
| **VAAPI** | Linux hardware video acceleration API. Needs a working DRM render node **and** a driver. |
| **DRM render node** | `/dev/dri/renderD12x`. **Ordering matters**: ffmpeg auto-picks the first. On the dev laptop `renderD128` = dead NVIDIA, `renderD129` = working AMD iGPU. |
| **Quick Sync** | Intel's hardware codec engine. HEVC decode since Skylake — makes Intel iGPUs the *best* case for VAAPI, not the worst. |
| **wfb-ng / `wfb_rx`** | Long-range WiFi broadcast link software. `-c 127.0.0.1 -u 5600` designates a send target; it does **not** bind 5600. |
| **MAVLink** | Drone telemetry/command protocol. |
| **MAVSDK / `mavsdk_server`** | MAVLink SDK; a helper process per link, driven over gRPC. **Each `System()` needs a unique gRPC port** — sharing 50051 makes all drones mirror one vehicle. |
| **SITL** | Software In The Loop — PX4 simulated in software. Its API link is `mavlink start -x -u 14580 -m onboard -o 14540`: PX4 pushes to remote port **14540** unprompted. |
| **WSL2** | Windows Subsystem for Linux. Separate network namespace; **localhost forwarding is TCP-only**, so a host-side `127.0.0.1` UDP bind cannot receive from SITL inside WSL. |
| **ANPR** | Automatic Number Plate Recognition. `plate_tracker.py`, via `fast-alpr`. |
| **Glass-to-glass** | Total latency from camera sensor to operator's screen. The number that matters for flying. |

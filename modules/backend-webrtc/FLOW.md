# backend-webrtc — data flow

## Offer handling

```
client offer (sdp, videoSource, clientOverlay, ...)
        │
        ├─ fetch/reorder ICE servers  ──► _sort_relay_urls puts turns:443 FIRST
        │                                  (aiortc uses only the first turn url)
        ├─ RTCPeerConnection + PeerEntry registered
        │
        ├─ server_sourced? ─── YES ─► open_air_unit_video / open_rtsp_video
        │                             (run_in_executor — blocking!)
        │                             └─► await recv() timeout=5s  ── liveness guard
        │                                   fail → emit 'error', remove peer, return
        │
        └────────────────── NO ────► pc.on("track") → relay.subscribe(buffered=False)
                                     │
                                     ▼
                            _attach_video_track(...)
```

## Frame pipeline

```
source track
    │  recv()
    ▼
MultiModeVideoStreamTrack.recv()
    │
    ├─► vision_pool  ──► BaseAnalyzer (latest-frame-drop) ──► meta
    │                                                          │
    │                                              emit 'cv_results' (inference rate)
    │
    ├─ return_video=False? ──► YES ──► no output composition, no encode. DONE.
    │                                  Browser draws overlays on CvOverlayCanvas.
    │
    └─ NO ──► _px_executor (1 worker, order-preserving)
                 draw_overlay(frame, meta)  /  cached-frame path for depth+enhance
                    │
                    ▼
              VideoFrame ──► aiortc encoder (ceilings raised in __init__.py)
                    │
                    ▼
              downlink SRTP ──► browser
```

Detector/tracker modes pass **every** frame through and draw the latest results
on it (fly-tab smoothness). Depth and enhance keep the cached-frame path because
their output *is* the frame.

## Why each guard exists

| Guard | Prevents |
|---|---|
| `buffered=False` | Unbounded frame queue → latency creep 300ms → 1s+ |
| 5s `recv()` liveness check | Connected-but-permanently-black session with no error, when an SDP-declared source has no packets arriving |
| `run_in_executor` around source open | A blocking ffmpeg probe freezing every other session for up to 5s |
| Single-worker executor | Out-of-order frames, and pixel work blocking commands/telemetry |
| `_sort_relay_urls` | UDP-only TURN url chosen first, dead on UDP-blocking networks |
| Raised bitrate ceilings | Heavily smeared 1080p that REMB could never push past |

## Planned SRT ingest

```
CLIENT ffmpeg -c copy ──MPEG-TS/H.265 over SRT──► srt://0.0.0.0:PORT?mode=listener
                                                        │
                                              MediaPlayer (same low-latency opts)
                                                        │
                                              MultiModeVideoStreamTrack  ← unchanged
                                                        │
                                              vision analyzers  ← unchanged
                                                        │
                                              cv_results JSON only (return_video=False)
```

Everything downstream of the source factory is untouched — that is what makes
this a small change (ADR-002).

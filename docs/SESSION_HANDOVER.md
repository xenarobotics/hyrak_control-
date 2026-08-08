# SESSION_HANDOVER

Written 2026-07-26. Read after `AI_CONTEXT.md` and `CURRENT_STATE.md`.

## Current objective

Two threads, both open:

1. **Confirm the SITL connect failure root cause.** Fixes are shipped
   (desktop 0.1.4) but the cause is **not proven**.
2. **Implement `air_unit_srt`** — scoped and documented, not started, waiting
   on two decisions.

## Current branch

`main`. **Working tree is dirty with a large untracked surface** — see
"Warnings". Nothing from this session is committed.

## Implementation status

### Finished this session

- **Desktop 0.1.3 — air-unit video Start failure fixed and verified.**
  Root cause: `systemFfmpegWithVaapi()` checked `ffmpeg -hwaccels`, which
  reports *compile-time* support only, so `mode:'auto'` always took the
  hardware branch with no `-vaapi_device`. ffmpeg's VAAPI auto-init defaults
  to the first DRM render node, which on the dev laptop is a
  firmware-disabled RTX 4070. Reproduced against a synthetic H.265 RTP
  stream; ffmpeg died instantly with `Failed to initialise VAAPI connection`
  / `No device available for decoder: device type vaapi needed for codec
  hevc`. Fixed by probing each `/dev/dri/renderD*` with
  `-init_hw_device vaapi=va:<node> -f lavfi -i nullsrc`, passing the winner
  as `-vaapi_device`, and auto-falling back to software if a hardware attempt
  exits within 4s. `renderD128` = dead NVIDIA, `renderD129` = working AMD
  iGPU — verified.
- **Desktop 0.1.4 + backend + frontend — SITL connect fixes.**
  - `udpBridge.ts` bound `127.0.0.1`, which silently drops any packet not
    sent to loopback. Verified experimentally. Now binds `0.0.0.0`
    (overridable via `bindAddress`).
  - Emits a one-time `receiving: true` status with the sender address on the
    first packet per port, so "bound but silent" is finally distinguishable
    from "flowing".
  - `remoteSitlRelay.ts` arms an 8s silence timer with a specific,
    actionable message naming the WSL/Docker/VM cause.
  - `useDrone.ts` now listens for the generic `error` socket event, which
    previously had **no listener at all** — the defect that produced the
    literal "stuck on connecting forever" symptom.
  - `telemetry_events.py` `on_connect_browser_serial` now emits
    `telemetry_status` on every failure path, including wrapped exceptions.
- **Documentation knowledge base** under `docs/` and `modules/`.
- **`docs/video-transport-modes.md`** — the mode matrix and per-scenario
  guidance.

### Remains

- Backend restart (fix is on disk, not live).
- SITL root-cause confirmation.
- `air_unit_srt` Phases 1-3.
- Commit everything.

## Important files

| File | Why |
|---|---|
| `desktop/src/bridges/udpBridge.ts` | SITL/swarm transport; the 0.1.4 bind fix |
| `desktop/src/bridges/airUnitVideoBridge.ts` | Air-unit video; the 0.1.3 VAAPI fix; where the SRT output gets added |
| `frontend/src/lib/remoteSitlRelay.ts` | SITL relay + new silence diagnostic |
| `frontend/src/hooks/useDrone.ts` | Connect flows, socket event handlers, status state |
| `backend/app/events/telemetry_events.py` | All telemetry connect entry points |
| `backend/app/webrtc/signaling.py` | Video source selection; `client_overlay` gate at ~line 152 |
| `backend/app/webrtc/udp_video_source.py` | Template for `srt_video_source.py` |
| `backend/app/telemetry/serial_bridge.py` | Remote-radio-looks-local bridge |
| `frontend/src/lib/videoSource.ts` | The mode enum users select |

## Important classes / functions

- `AirUnitVideoBridge` — `vaapiRenderNode()`, `HW_SETUP_WINDOW_MS`, the
  recursive `launch(hwNode)` with software fallback.
- `UdpBridge` — per-port `UdpSocketEntry {socket, peer, sawTraffic}`,
  reply-to-last-sender in `send()`.
- `MultiModeVideoStreamTrack` (`stream_track.py`) — the single funnel every
  video source passes through.
- `SerialBridge` — `create()`, `address` (`udpin://127.0.0.1:{port}`),
  `uplink()`, `datagram_received()`.
- `TelemetryManager.connect()` — 10s gRPC + 15s heartbeat timeouts.

## Known blockers

1. **SITL root cause unproven.** Cannot reproduce the client's environment.
2. **WebCodecs HEVC support unverified** — gates `air_unit_srt` Phase 2.
3. **SRT port handshake undecided** — gates Phase 1.

## Recommended next steps

1. Ask Japesh to restart the backend.
2. Get the answer: is the client's SITL native, or in WSL2/Docker/a VM? If
   WSL/VM, the 0.1.4 bind fix is very likely the whole answer. If native on
   the same OS, the loopback bind already worked and the cause is elsewhere —
   the new 8s message plus whether `receiving` ever appeared will pin it down.
3. Commit. Consider `.gitignore` entries for `releases/`.
4. Settle the SRT handshake, then implement Phase 1 (server
   `srt_video_source.py` + an *additional* client ffmpeg output, leaving the
   v4l2loopback preview untouched so nothing can regress).

## Recommended files to read first

1. `docs/AI_CONTEXT.md`
2. `docs/CURRENT_STATE.md`
3. this file
4. `docs/video-transport-modes.md` (video work) or
   `modules/desktop-bridges/README.md` (transport work)
5. `docs/ADR/` for rationale

## Warnings

- **Do not modify `communication/`.** Read-only reference for the wfb-ng
  ground station.
- **Never print the socket.io shared secret**
  (`NEXT_PUBLIC_SECRET_TOKEN` / `secret_token`).
- **Japesh runs all flight tests himself.** Do not launch autonomous test
  flights or write throwaway test scripts. Local diagnostic shell commands
  are fine and were used productively this session.
- **Desktop changes need a `desktop/package.json` version bump before
  `npm run deploy:local`**, or electron-updater tells clients they're current.
- **Backend has no useful auto-reload** — ask for a restart.
- **Do not delete the v4l2loopback path.** It is the only mode that works on
  UDP-blocking networks (ADR-003). An earlier version of the SRT plan said to
  delete it; that was corrected.
- Do not strip the dense "why" comments. Several encode findings that cost
  days.

## Open questions

1. Client's SITL environment (native vs WSL/Docker/VM)?
2. WebCodecs HEVC availability on client hardware?
3. SRT port handshake shape?
4. Does `air_unit_rtp_relay` ship at all, or does `latency=20` SRT cover LAN?
5. Is the crowd/plate session-end ZIP-export-and-purge flow implemented?
   `vision/persistence.py` exists — **needs verification** against the plan
   in `~/.claude/plans/happy-mapping-quokka.md`.
6. Delete `sitl_relay/single_relay.py`?

# ROADMAP

Updated 2026-10-18. The July "Now / Next" items (backend restart, SITL root
cause, committing the untracked surface, `air_unit_srt` phases 1-3, the SRT
port handshake, the Windows installer, `rtspBridge` as a source) are all
done. So is the 2026-10-17 audit's fix pass: auth, the model cache, WebRTC
ownership, fleet `in_air`, Electron 44, dependency upgrades. Open defects
with IDs live in `docs/AUDIT_2026-10-17.md`.

## Now - finish the security pass

1. **Owner setup**: `alembic upgrade head`, first admin via
   `app.auth.cli create-user`, remove `NEXT_PUBLIC_SECRET_TOKEN` from
   `frontend/.env.local` (`SECURITY.md`).
2. **Cloudflare Access** in front of `dev.` and `api.xenarobotics.com` as a
   second layer (owner decision).
3. **Close the unauthenticated read GETs** (fleet, drones, missions, tasks,
   flight downloads, crowd / plate reports and history, face gallery,
   avoidance status, reconstruction proxies) with `require_viewer`.
4. **Role checks on video signaling** (`offer`, `allocate_video_relay`,
   `datachannel_video_offer`, `wall_offer`), so a viewer cannot start a
   stream; admission control for the TCP / UDP relay transports.
5. **Ground-station relay agent** to a bearer token; keep
   `AUTH_LEGACY_TOKEN_ENABLED` off.

## Next - flight validation and avoidance

- Owner's SITL flights for the grid + Offboard local planner; record
  closed-loop results (only the kinematic harness is recorded today).
- Capture-time latency compensation: stamp frames at capture and pass
  `captured_at` / `source_latency_s` to `submit_frame` on the SRT path.
- Depth-vs-mono agreement check; mono stays advisory until calibrated error
  is below 15 %.
- PX4 offboard-loss and position-loss params in the failsafe pre-check;
  `health.local_position_ok` cross-check.
- First real-flight capture-to-motion latency number (latency probe).
- Indoor: EKF origin is set manually; optical-flow sim blocked by the PX4 gz
  plugin ABI mismatch; five firmware-interface questions in
  `INDOOR_NAV_CAPABILITY.md`.

## Next - custom models

Design in `docs/custom_models/DESIGN.md`: sandboxed sidecar runner over
shared memory, an action catalogue instead of raw MAVLink, open decisions
pending the owner. Prerequisite: torch past 2.4.1 or uploaded weights
loaded only inside the sandbox (`torch.load` advisory).

## Later

- **Transport auto-probe with fallback**, with a visible "UDP blocked, using
  WebRTC" status. Same probe-then-fallback shape as ADR-005.
- `air_unit_rtp_relay` LAN mode: undecided.
- De-duplicate the ffmpeg low-latency option block (seven files) and add a
  drift test.
- Camera-wall tiles off VP8; exercise the hardware HEVC decode path; measure
  `webrtc-sender` latency in-app; macOS DMG build.
- Desktop: `bindAddress` in Settings, stalled-traffic signal from the UDP
  bridge, VAAPI re-probe on demand.
- Collapse the duplicated mode-switch logic (`modules/page.tsx`,
  `command/AiPanel.tsx`), which the Custom tab work will do anyway.
- **Zones / identity / multi-tenant** expansion.
- **Code signing** (CSC secrets) for Windows and macOS.
- **CI deploy secrets** (`DEPLOY_*`).
- **Measure concurrent-session capacity** (KNOWN_ISSUES).
- Ground decoder: `GROUND_DECODER.md` risks 1-5, decoder IP discovery,
  telemetry via the decoder verified with a Pixhawk.
- Housekeeping: `prune-releases.sh --apply`, move vendored upstream trees out
  of the repo root, delete `.env.bak.*` / `air_unit_relay.zip` /
  `frontend/home` / `logs/`.
- **`.deb` packaging**: deliberately on hold.

## Explicitly out of scope

- Changing the air unit's codec to H.264. Would dissolve the WebRTC
  codec-negotiation problem and enable true passthrough, at ~30-40% more RF
  bandwidth. A real option, deliberately not taken now.
- QUIC / WebTransport / MoQ. Evaluated and rejected (ADR-001).
- Remote-spectator fan-out / SFU. The server keeps one re-encode for browser
  viewers; scaling that is a later problem.
- Moving control onboard or making the cloud advisory-only. The cloud is the
  companion computer.

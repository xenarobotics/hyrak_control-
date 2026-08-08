# CURRENT_STATE

Last updated: **2026-07-26**. Branch: `main`.
Desktop version: **0.1.4**. Backend version: `0.1.0`.

## Completed

- Three video sources shipped: `camera`, `air_unit_udp`, `siyi_rtsp`.
- Client-side overlay pipeline (`clientOverlay` → `return_video=False` →
  `cv_results` JSON → `CvOverlayCanvas`). Halves bandwidth.
- Cloudflare TURN relay with TLS/TCP-first ordering for UDP-blocking networks.
- WebRTC latency/bitrate fixes: `buffered=False`, raised aiortc encoder
  ceilings, per-resolution uplink bitrate, zero playout buffer.
- **7 vision modules registered** in `__registry__.py`: object detection,
  human tracking, depth mapping, person tracking, enhance, **crowd
  management (268 lines)**, **vehicle/plate tracking (410 lines)**.
  `vision/persistence.py` (202 lines) exists.
- Postgres layer: zones, permits, flights, flight samples, alembic migrations.
- Swarm SITL: 10-drone fleet, tag-multiplexed UDP bridge, group commands.
- Desktop app: 5 native bridges, electron-updater with consent gating,
  AppImage build + `/releases` publishing.
- **Desktop 0.1.3** — VAAPI runtime device probe + explicit `-vaapi_device` +
  automatic software fallback (fixes air-unit video Start failure).
- **Desktop 0.1.4** — `udp` bridge binds `0.0.0.0`; first-packet `receiving`
  status; SITL 8s silence diagnostic; guaranteed `telemetry_status` on every
  telemetry connect failure path.
- Documentation knowledge base under `docs/` (this session).

## In Progress

- **SITL connect failure diagnosis.** Fixes shipped in 0.1.4; root cause
  **not confirmed**. Awaiting one fact from the client: is SITL running
  natively, or inside WSL2 / Docker / a VM?
- **Backend restart pending** — the `telemetry_events.py` change is on disk
  but not live until `./start.sh` is restarted.

## Blocked

| Item | Blocker |
|---|---|
| `air_unit_srt` Phase 2 | WebCodecs HEVC support on client hardware unverified |
| `air_unit_srt` Phase 1 | SRT port-handshake design decision not made |
| Windows / macOS installers | v4l2loopback in the video path (resolved by `air_unit_srt`) |
| Code signing | CSC secrets not configured |
| CI deploy | `DEPLOY_*` secrets + `DEPLOY_CONFIGURED` not set |
| `.deb` packaging | On hold (deliberate) |
| Login / auth | Not started |

## Known Bugs

See `KNOWN_ISSUES.md` for detail. Summary:

1. **SITL "connecting" forever** — mitigated in 0.1.4, root cause unconfirmed.
2. `air_unit_udp` silently unusable for remote clients (works, but only
   co-located). Needs relabelling in Settings.
3. Recording in overlay mode captures raw video without boxes (known nuance,
   pre-existing).
4. Six video-source chips will overflow the Settings row once `air_unit_srt`
   lands.

## Technical Debt

- **Large untracked surface in git**: `desktop/`, `docs/`, `communication/`,
  `releases/`, `sitl_relay/`, `crowd_manager.py`, `plate_tracker.py`,
  `persistence.py`, `udp_video_source.py`, `rtsp_video_source.py`, and ~10
  frontend `lib/` files. **Single biggest risk in the project.**
- Duplicated ffmpeg low-latency option block (backend + desktop), synced by
  comment convention only.
- `sitl_relay/single_relay.py` — dead, unreferenced. Safe to delete.
- Remaining `sio.emit("error", ...)` paths not audited for whether they leave
  the UI in a non-terminal state.
- A stray `gz sim` process was left running on the server at some point.
- `happy-mapping-quokka.md` plan says crowd/plate are "not started"; the code
  says otherwise. Plan is stale — **code is source of truth.**

## Immediate Next Tasks

1. **Restart the backend** so the telemetry error-reporting fix goes live.
2. Get the client's SITL environment answer; confirm or continue the diagnosis.
3. `git add` + commit the untracked surface.
4. Decide the SRT port handshake (signaling round trip recommended).
5. Probe `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})` on a
   representative client machine.

## Long-term Goals

- `air_unit_srt` end to end: pristine server-side video, one client decode,
  zero client encodes, sub-60ms pilot view, Windows/macOS support.
- User-selectable transport modes with per-scenario guidance in Settings.
- Optional `air_unit_rtp_relay` for LAN/VPN clients.
- Auto-probe with graceful fallback and a visible "which path is live" status.
- Auth/login, multi-tenant zones and identity.
- Session-end ZIP export + purge for crowd/plate data (**verify against
  `persistence.py` — may already be implemented**).

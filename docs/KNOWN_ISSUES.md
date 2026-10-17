# KNOWN_ISSUES

Updated 2026-10-18. Status key: **OPEN** · **MITIGATED** (fix shipped, cause
unproven or partly fixed) · **FIXED** · **CLOSED** (no longer applies).

Audit IDs (B, V, F, I) refer to `docs/AUDIT_2026-10-17.md`, which has the
full defect list. This file keeps the long-running issues and the open
security items.

---

## 1. Client's SITL connect hangs on "connecting" - CLOSED

July 2026. Three defects were found and fixed (desktop 0.1.4 `udpBridge`
binds `0.0.0.0`; a generic `error` listener in the frontend; terminal
`telemetry_status` on every connect failure, ADR-006 / ADR-007). No report
since. The 2026-10-17 audit closed the remaining "stuck on connecting"
paths: `connect_telemetry` with no payload or a raising `connect()` (B10),
SDP / malformed offers (B17), and a bare `socket.off('error')` that removed
the frontend's un-stick listener (F1).

---

## 2. `air_unit_udp` only works co-located - FIXED (relabelled)

`udp_video_source.py` binds the port on the server, so it only works when
the ground station and the backend are the same machine. The source is now
labelled "Air unit (UDP, server reads)" in Settings with that requirement in
its blurb. Remote clients use `air_unit_srt`, `air_unit_gst`,
`air_unit_datachannel` or `hyrak_receiver`.

---

## 3. Air-unit video Start failure - FIXED (desktop 0.1.3)

Compile-time `-hwaccels` check plus no `-vaapi_device` made ffmpeg
auto-initialise a firmware-disabled GPU. See ADR-005. Verified fixed:
hardware decode works on `renderD129`, software fallback works.

---

## 4. Recording in overlay mode captures raw video without boxes - OPEN

Known nuance of the client-side-overlay design: the browser records its own
feed, which has no annotations burned in. Since 2026-10-17 (F10) the record
controls are hidden where there is nothing to capture (WebCodecs canvas,
`src=` preview), and filenames are `hyrak-*`.

---

## 5. Settings video-source row overflow - FIXED

Ten sources now render from one grouped catalogue (`VIDEO_SOURCES` in
`frontend/src/lib/videoSource.ts`: Ground decoder / Browser / RTSP camera /
Air unit (RF)), not a single chip row.

---

## 6. Authentication - FIXED (2026-10-17), gaps below

Per-user login with roles viewer / operator / admin, bearer tokens, socket
auth, resume bound to user + secret. See `docs/AUTH.md`, `SECURITY.md`.
Needs the owner's one-time setup (migration, first admin, remove
`NEXT_PUBLIC_SECRET_TOKEN` from `frontend/.env.local`). Remaining gaps are
#13-#16.

---

## 7. Large untracked surface in git - FIXED

Everything that was untracked in July (desktop, docs, crowd / plate modules,
video sources, frontend lib files) is committed. `releases/` is kept present
but empty in git.

---

## 8. `sio.emit("error", ...)` sites leaving the UI non-terminal - MITIGATED

ADR-007 fixed the connect paths; the audit fixed the telemetry connect
(B10), offer / SDP failures (B17), `wall_offer` validation (B28), client
overlay drive loop (B19), and swarm scans (B26). Not every `error` emit has
been re-audited.

---

## 9. Duplicated ffmpeg low-latency options - OPEN (tech debt)

The `-fflags nobuffer -flags low_delay -max_delay ... -reorder_queue_size 0`
block now appears in seven files across backend and desktop, synced by
comment convention only. They fix a real ~1 s lag bug; drift would silently
regress latency. No drift test.

---

## 10. Dead code: `sitl_relay/single_relay.py` - FIXED

Deleted with its `.spec` (commit `bfec1e6`).

---

## 11. Scaling characteristics unmeasured - OPEN

One `mavsdk_server` per session and one re-encode per browser spectator, no
SFU fan-out. Model weights are now shared across sessions
(`vision/model_cache.py`), which removed the per-session YOLO / DA3 /
InsightFace copies (V4), but concurrent-session capacity is still
**unmeasured**.

---

## 12. Stray `gz sim` processes - CLOSED

`swarm.sh stop`, `simulation/hyrak_sim.sh` and `start.sh` now stop only the
PIDs they recorded (I2, I6, I7). Rule: never pattern-kill `gz sim`.

---

## 13. Read-only GET routes are unauthenticated - OPEN (security)

Mutating routes need a role, but many GETs answer without a token: fleet,
drones, zones, missions, tasks, pads, permits, flights and flight download,
crowd / plate report downloads, plate history and images, face gallery and
sightings, avoidance status / events / obstacles, reconstruction proxies,
mesh-unit and feed status, latency probe stats. Some is personal data.
Fix: `require_viewer` on each. Cloudflare Access in front of the tunnel
covers it meanwhile.

---

## 14. A viewer can start a video stream - OPEN (security)

The WebRTC signaling events (`offer`, `ice_candidate`, `stop_stream`,
`allocate_video_relay`, `release_video_relay`, `datachannel_video_offer`)
and the camera wall (`wall_offer`, `wall_close`) have no role check. No
drone command is reachable this way, but a viewer can use GPU and relay
ports. Also unguarded (read-only): `fetch_params`, `get_param`,
`start_rc_monitor`.

---

## 15. TCP / UDP relay transports have no admission control - OPEN (security)

SRT relay listeners require a per-allocation passphrase. The `tcp` and
`udp` relay transports accept whoever connects to the allocated public port
first.

---

## 16. Ground-station relay agent uses the legacy token - OPEN

`gs_relay_agent.py` (runs on the ground-station laptop; not in this repo)
sends the shared `SECRET_TOKEN`. The `/gs-relay` namespace accepts it only
with `AUTH_LEGACY_TOKEN_ENABLED=true`. Move it to an operator bearer token
(`HYRAK_TOKEN`).

---

## 17. torch 2.4.1 `torch.load` advisory - OPEN (deliberate)

torch is held at 2.4.1 for DA3 / ultralytics / aiortc compatibility
(CVE-2025-32434). Harmless while every checkpoint is ours; must be resolved
(upgrade or sandboxed loading) before user-uploaded models ship.

---

## 18. Unsigned installers - OPEN

Windows / macOS builds are unsigned and electron-updater trusts a sha512
from the same host as the installer. Keep `releases/` write-restricted.

---

## 19. Repo-root clutter - OPEN (housekeeping)

`releases/` holds 13 GB of old installers (`scripts/prune-releases.sh
--apply` keeps the current and previous version); `.env.bak.20260805-*`
with old TURN credentials; vendored upstream trees, `frontend/home`,
`air_unit_relay.zip`, `logs/`. All untracked.

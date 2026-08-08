# KNOWN_ISSUES

Status key: **OPEN** · **MITIGATED** (fix shipped, cause unproven) · **FIXED**

---

## 1. Client's SITL connect hangs on "connecting" — MITIGATED

**Symptom:** operator selects SITL, presses connect, UI shows "connecting" and
never progresses.

**Three defects found, all fixed:**

| Defect | Status |
|---|---|
| `udpBridge.ts` bound `127.0.0.1`, dropping all non-loopback packets (breaks SITL in WSL2/Docker/VM) | Fixed, desktop 0.1.4 (ADR-006) |
| Generic `error` socket event had no frontend listener; only `telemetry_status` can exit "connecting" | Fixed (ADR-007) |
| Exceptions in `on_connect_browser_serial` swallowed by socket.io | Fixed (ADR-007) |

**Why still MITIGATED:** the client's environment could not be reproduced, so
it is unproven which defect caused their failure.

**To confirm:** is the client's SITL running **natively** on the same OS as the
desktop app, or inside **WSL2 / Docker / a VM**?
- WSL/Docker/VM → the bind fix is very likely the whole answer.
- Native on the same OS → the loopback bind already worked; the new 8s silence
  message plus whether the `receiving` status ever appeared will pin it down.

**Blocked on:** backend restart (the `telemetry_events.py` fix is on disk but
not live) and the client's answer.

---

## 2. `air_unit_udp` is unusable for remote clients but presented as a peer mode — OPEN

`udp_video_source.py` binds `127.0.0.1:5600` **on the server**, so it only
works when the backend is on the same machine as the RF link. `signaling.py`
already documents this in its own error string. A remote client gets a
connected-but-black stream (guarded by the 5s no-frames check, so it errors
rather than hanging).

**Fix:** relabel to "Air unit (server-local)" in Settings with the requirement
in its `sub`. Planned in `air_unit_srt` Phase 3.

---

## 3. Air-unit video Start failure — FIXED (desktop 0.1.3)

Compile-time `-hwaccels` check plus no `-vaapi_device` made ffmpeg
auto-initialise a firmware-disabled GPU. See ADR-005. Verified fixed:
hardware decode works on `renderD129`, software fallback works.

Note the 0.1.2 "stale port 5600 race" fix did **not** address this — that
theory was wrong. Kept in the code as a genuine (if rarer) failure mode.

---

## 4. Recording in overlay mode captures raw video without boxes — OPEN

Pre-existing, known nuance of the client-side-overlay design (commit
`7c58411`): the browser records its own feed, which has no annotations burned
in. Annotations exist only on the canvas layer.

---

## 5. Settings video-source row will overflow — OPEN (cosmetic)

Six `ChipGroup` chips will not fit once `air_unit_srt` and possibly
`air_unit_rtp_relay` are added. Group them or switch to a select. Decide when
the fourth mode lands.

---

## 6. No authentication — OPEN

There is no login/auth system. Export endpoints such as
`/api/flights/{id}/download` are unauthenticated. Acceptable for
single-operator dev use; **must be addressed before external clients rely on
this.**

---

## 7. Large untracked surface in git — OPEN (highest risk)

`desktop/`, `docs/`, `communication/`, `releases/`, `sitl_relay/`, the crowd
and plate analyzers, `vision/persistence.py`, both video-source modules, and
roughly ten `frontend/src/lib/` files are untracked. **A disk failure loses the
entire desktop app.** Commit, and consider `.gitignore` for `releases/`.

---

## 8. Remaining `sio.emit("error", ...)` sites unaudited — OPEN

ADR-007 fixed the connect paths. Other `error` emits have not been checked for
whether they leave the UI in a non-terminal state.

---

## 9. Duplicated ffmpeg low-latency options — OPEN (tech debt)

The `-fflags nobuffer -flags low_delay -max_delay 100000
-reorder_queue_size 0` block exists in both `udp_video_source.py` and
`airUnitVideoBridge.ts`, synced by comment convention only. They fix a real
~1s lag bug; drift would silently regress latency.

---

## 10. Dead code: `sitl_relay/single_relay.py` — OPEN

On disk, unreferenced, superseded by `remoteSitlRelay.ts`. Safe to delete
(offered previously, no decision recorded).

---

## 11. Scaling characteristics unmeasured — OPEN

One `mavsdk_server` process per session and one re-encode per browser
spectator, with no SFU fan-out. Concurrent-session capacity is **unmeasured**.
**Needs verification** before onboarding multiple simultaneous clients.

---

## 12. Stray `gz sim` process — OPEN (housekeeping)

A Gazebo process was reported left running on the server. Verify and clean up.

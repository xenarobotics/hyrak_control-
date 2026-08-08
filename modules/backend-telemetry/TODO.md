# backend-telemetry — TODO

## Immediate

- [ ] **Restart the backend.** The ADR-007 fix in `telemetry_events.py` is on
      disk but not live (`./start.sh` has no useful auto-reload).
- [ ] Confirm the SITL root cause once the client answers whether their SITL is
      native or in WSL2/Docker/VM. See `docs/KNOWN_ISSUES.md` #1.

## Tech debt

- [ ] **Audit every `sio.emit("error", ...)`** in the project for the ADR-007
      defect class: does it leave the UI in a non-terminal state? Only the
      telemetry connect paths were fixed.
- [ ] Rename or document `connect_browser_serial` — it serves the Web Serial
      radio **and** the SITL relay, which its name hides.
- [ ] **Needs verification:** memory/PID cost of one `mavsdk_server` per
      session, and the concurrent-session ceiling.

## Robustness

- [ ] No mid-session liveness signal. If MAVLink stops arriving after a
      successful connect, nothing detects it — the session looks healthy.
      Consider a heartbeat-staleness watchdog emitting
      `telemetry_status: error`.
- [ ] `on_serial_uplink` silently drops bytes when no bridge is registered
      (normal during startup, but indistinguishable from a real bug). Consider a
      counter or a one-time log.

## Nice to have

- [ ] Surface which connect path a session used (`browser_serial` / `sitl` /
      `rf_bridge` / direct) in the session info, so admin observers and logs can
      tell them apart.
- [ ] Delete `sitl_relay/single_relay.py` — dead code superseded by
      `remoteSitlRelay.ts`.

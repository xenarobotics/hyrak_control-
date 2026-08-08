# ADR-007 — Every connect failure must emit a terminal `telemetry_status`

Date: 2026-07-26 · Status: **Accepted and implemented**

## Problem

The frontend sets `telemetryStatus = 'connecting'` the moment a connect is
requested, and **only a `telemetry_status` event can move it off that state**.

Two paths violated that contract:

1. `on_connect_browser_serial` (`backend/app/events/telemetry_events.py`) —
   used by both the Web Serial radio **and** the SITL relay — reported "No
   session found" by emitting the generic `error` event. **`grep` confirmed
   the frontend had no `socket.on('error')` listener at all.**
2. An exception inside `serial_bridge.SerialBridge.create(...)` or
   `on_connect_telemetry(...)` would propagate out of the socket.io handler,
   where python-socketio swallows it silently, emitting nothing.

Either one leaves the operator staring at "connecting" forever — the exact
reported symptom.

## Decision

1. **Backend:** every exit path in `on_connect_browser_serial` emits
   `telemetry_status`, including wrapped `try/except` around bridge creation
   and the telemetry connect, with the exception text in the message.
2. **Frontend:** `useDrone.ts` listens for the generic `error` event and, when
   a connect is pending, treats it as a failed connect (sets the error, moves
   to `'error'`, releases the local radio).
3. **Convention going forward:** a non-terminal UI state may only be exited by
   an event the UI actually handles. Emitting `error` alone is not a valid way
   to end a connect attempt.

## Reason

Timeouts already existed (10s mavsdk gRPC, 15s heartbeat — both added after
earlier real infinite hangs), so the *normal* no-traffic case did eventually
error out. But any path that returned *before* reaching those timeouts had no
terminal event at all, and no timeout could rescue it.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Frontend-side watchdog timer on `connecting` | **Rejected as the primary fix** — hides the real defect and produces a generic message naming no cause. Used as a targeted, *specific* diagnostic instead (the 8s SITL silence timer, which names WSL/Docker/VM). |
| Handle `error` on the frontend only | Insufficient — the swallowed-exception path emits nothing at all. |
| Convert all `error` emits to `telemetry_status` project-wide | Deferred — `error` is used for non-connect failures too. An audit is listed as technical debt. |

## Trade-offs

Slightly more verbose backend handlers. Worth it: a UI that can hang forever on
a silent failure is worse than any amount of error plumbing.

## Consequences

- The literal "stuck on connecting forever" symptom cannot recur from these
  paths, whatever the underlying cause.
- Complements ADR-006: that fixes the likely cause, this guarantees the
  failure is *visible* if the cause was something else.
- Also added: an 8s SITL silence diagnostic in `remoteSitlRelay.ts` that fires
  when the port binds but nothing arrives, naming the concrete likely causes
  and cancelled by the new `receiving: true` bridge status.
- **Open technical debt:** remaining `sio.emit("error", ...)` call sites have
  not been audited for the same class of defect.

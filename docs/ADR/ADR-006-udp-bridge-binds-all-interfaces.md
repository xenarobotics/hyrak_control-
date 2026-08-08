# ADR-006 — The UDP bridge binds 0.0.0.0, not 127.0.0.1

Date: 2026-07-26 · Status: **Accepted and implemented (desktop 0.1.4)**

## Problem

A client running PX4 SITL on their own machine could not connect: the UI showed
"connecting" and never progressed.

`desktop/src/bridges/udpBridge.ts` bound `socket.bind(port, '127.0.0.1')`.
Verified experimentally what that means:

```
bind 127.0.0.1 received: [via-loopback]
bind 0.0.0.0   received: [via-loopback, via-lan]
```

A loopback-scoped bind **silently drops every packet that did not arrive on
loopback**. The port binds successfully, no error surfaces anywhere, and not
one byte ever arrives.

That breaks the common case of **SITL inside WSL2, Docker, or a VM**: those
send from a separate network namespace, so packets land on a
vEthernet/bridge interface a loopback bind cannot see. "Just use 127.0.0.1"
genuinely cannot work there — **WSL2's localhost forwarding is TCP-only.**

Port and direction were confirmed correct from
`PX4-Autopilot-main/ROMFS/px4fmu_common/init.d-posix/px4-rc.mavlink`:
`mavlink start -x -u 14580 -r 4000000 -f -m onboard -o 14540`, i.e. PX4 pushes
to remote port 14540 unprompted.

## Decision

Bind `0.0.0.0` by default. Add an optional `bindAddress` config field for
anyone who wants the port kept off their LAN.

Additionally: **emit a one-time `receiving: true` status** (with the sender's
address) on the first packet per port, because binding successfully and
receiving nothing were previously indistinguishable to the renderer.

## Reason

Strictly more permissive, and matches what ground-station software such as
QGroundControl effectively does. It is the only way a host-side app can receive
from SITL in another network namespace.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Document "run SITL natively" | **Rejected** — clients are on Windows; WSL2 is the normal way to run PX4 SITL there. |
| Bind both `127.0.0.1` and a discovered LAN address | Rejected — two sockets per port, more complexity, no benefit over `0.0.0.0`. |
| Keep `127.0.0.1`, require port forwarding | Rejected — cannot work for UDP under WSL2. |

## Trade-offs

**Security:** exposes bound ports (14540, swarm 14541+) to the client's LAN.
Accepted for a ground-station app on an operator's own machine; mitigated by
the `bindAddress` override. Not a server-side exposure — this is client-local.

## Consequences

- Also benefits `localSwarmRelay.ts`, which shares the same bridge.
- **Root cause not proven.** The client's environment could not be
  reproduced, so it is unknown whether this bind was *the* cause. The
  diagnostic added alongside it (ADR-007) makes the next occurrence
  self-reporting. **Open question: is the client's SITL native or in
  WSL2/Docker/a VM?**
- Unrelated but noted: `airUnitVideoBridge.ts`'s SDP also declares
  `c=IN IP4 127.0.0.1`, correct for the local `wfb_rx` case and left alone.

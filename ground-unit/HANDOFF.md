# Ground unit — handoff

Distilled from the cloud-app session on 2026-08-01. Everything here was
measured or decided in that session; nothing is speculation unless labelled.

## Why this device exists

Today the operator's laptop does all of it: RTL8812EU dongle → out-of-tree
kernel driver → monitor mode → `wfb_rx` → `udp:5600` → GStreamer preview + SRT
uplink. That works, but it cannot be a product:

- **Windows is impossible.** Monitor mode + packet injection + `PF_PACKET` raw
  sockets are Linux kernel APIs. wfb-ng has no Windows port and no installer
  fixes that.
- **Linux is fragile.** The RTL8812EU driver is out-of-tree, so it needs DKMS,
  kernel headers, and Secure Boot disabled or the module signed — and it
  rebuilds (and breaks) on every kernel update. `start-gs.sh` also needs
  `sudo`, `iw`, and NetworkManager told to leave the interface alone.
- **The laptop is CPU-contended.** `wfb_rx` does Reed–Solomon FEC on every
  packet, alongside GStreamer decode/encode, Electron and Chromium. Contention
  on that machine caused an entire class of bugs — most memorably the JS event
  loop stalling until the *kernel* dropped UDP datagrams, with no error
  anywhere.

Moving the RF leg onto a dedicated SBC removes all three at once.

## Target architecture

    RTL8812EU  →  SBC (driver, monitor mode, wfb_rx)  →  USB Ethernet gadget
                                                      →  laptop udp:5600

The laptop then needs **only** the HYRAK app with GStreamer bundled — no RF
driver, no root, no DKMS — and Windows works, because CDC-NCM/RNDIS gadgets use
inbox drivers on Windows 10/11, macOS and Linux.

This is how Herelink and Skydroid solve the same problem.

## Latency — already analysed, do not re-litigate

The SBC does **not add a pipeline stage**; it relocates one. The only
substitution is "UDP loopback write" → "USB Ethernet link".

| link | added |
|---|---|
| USB 2.0 microframe | 125 µs |
| CDC-NCM (aggregating, tunable via `tx_timer_usecs`) | ~1–2 ms |
| RNDIS / CDC-ECM (less batching) | ~0.3–0.5 ms |
| Gigabit Ethernet instead of USB gadget | ~0.1–0.3 ms |

Against the current budget — 60 ms jitter buffer + 150 ms SRT window + ~10 ms
decode — this is under 1%. It is below the noise floor.

**The real risk is jitter, not latency.** An undersized SBC that cannot sustain
FEC at the link bitrate would be worse than the status quo. Measure `wfb_rx`
throughput and packet-loss on the actual board before committing.

## Known hardware constraints

1. **Shared USB controller.** A board with a single OTG port (Pi Zero 2W) has
   the dongle and the gadget on one bus, needing a hub. Prefer separate OTG +
   host ports.
2. **Power.** The RTL8812EU draws more than a laptop bus can reliably supply
   through the SBC. It needs its own supply.
3. **NCM aggregation** batches for throughput by default; tune it down or pay
   the full ~2 ms unnecessarily.

## What `start-gs.sh` currently does (the behaviour to port)

Read `/home/japesh/hyrak_control/communication/start-gs.sh` for the real thing.
Summary: sets regulatory domain, takes the NIC out of NetworkManager, puts it
into `monitor otherbss` on a fixed channel, then runs four wfb-ng streams:

| radio_port | direction | endpoint |
|---|---|---|
| 0 | video down | `wfb_rx` → `udp 127.0.0.1:5600` |
| 1 | mavlink down | `wfb_rx` → `udp 127.0.0.1:14550` |
| 2 | mavlink up | `wfb_tx -u 14551` |
| 3 | RC up | `wfb_tx -u $RC_PORT` (default 14570) |

Keys live in `~/.wfb`. Channel 165, HT20, region BO by default.

On the SBC all four need to survive reboots and dongle re-plugs — so systemd
units with restart policy, not a shell script run by hand. The UDP endpoints
change from `127.0.0.1` to the laptop's address across the gadget link.

## Asks for the cloud side

Anything the desktop/backend must change goes here. The other session owns
those files; do not edit them from this worktree.

- *(none yet)*

## Open questions for the operator

1. **Which board, and what state is it in?** They said they have already
   configured an SBC and want to reuse it. Driver build, gadget module and
   device-tree overlays are all board-specific.
2. **USB gadget or Ethernet?** Ethernet is lower latency and avoids the
   aggregation and shared-bus issues, at the cost of a cable instead of one USB
   lead. USB gadget is the better product experience.
3. **Telemetry too, or video first?** Ports 1–3 above carry MAVLink and RC. The
   laptop currently reaches the radio over USB serial; if the SBC takes those
   over as well, the desktop's serial path changes and that becomes an ask for
   the cloud side.

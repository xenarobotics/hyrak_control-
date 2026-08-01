# HYRAK ground unit — worktree

This worktree exists to build the **RF ground unit**: a small Linux SBC that
owns the RTL8812EU dongle, runs wfb-ng, and presents the video/telemetry to a
laptop over a plug-and-play interface.

It is a git worktree of `hyrak_control` on branch `ground-unit`. The main
worktree at `/home/japesh/hyrak_control` is a **separate, active session**
working on the cloud application — do not edit files there, and do not switch
that branch.

## Scope

**In scope:** everything that runs on the SBC — wfb-ng config, the RTL8812EU
driver, USB gadget / network config, systemd units, a provisioning script, and
an image-build path.

**Out of scope:** the cloud app (backend/, frontend/, desktop/). Those are
being actively changed in the other session. If a change there turns out to be
needed, write it down in `ground-unit/HANDOFF.md` under "Asks for the cloud
side" rather than editing it here — otherwise the two sessions will conflict.

## The one hard contract

The SBC must deliver **RTP/H.265 to UDP port 5600** on the laptop, with these
caps (byte-for-byte — four other places in the codebase agree on this string,
and they must all match or the payload is parsed as the wrong codec):

    application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96

If that holds, the existing desktop app works unchanged. Everything else about
the ground unit is free to change.

## Reference material (read-only, outside this worktree)

`communication/` is **untracked** in git, so it is not in this worktree. It
lives only in the main checkout and must be treated as read-only reference —
never modify it:

- `/home/japesh/hyrak_control/communication/start-gs.sh` — the current
  ground-station launcher. This is the behaviour being moved onto the SBC.
- `/home/japesh/hyrak_control/communication/wfb-ng/` — vendored wfb-ng source.
- `/home/japesh/hyrak_control/communication/luckfox_pico_airunit/` — the air
  unit side, for protocol/keying symmetry.

Read `ground-unit/HANDOFF.md` first — it carries the decisions and measurements
from the session that produced this worktree.

## Before writing anything

The operator has **already configured an SBC** and wants to reuse it. Ask what
board it is and what state it is in before proposing a provisioning script —
the driver build, USB gadget module and device-tree overlays are all
board-specific, and guessing wastes their time.

## Testing

The operator flies and tests all of this themselves on real hardware. Do not
write throwaway test scripts or claim a hardware path works without their
confirmation.

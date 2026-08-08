# ADR-005 — Probe hardware capability at runtime; always degrade, never fail

Date: 2026-07-26 · Status: **Accepted and implemented (desktop 0.1.3)**

## Problem

Pressing Start on the air-unit video bridge failed immediately with an
unhelpful `ffmpeg exited (code 1)`. An earlier fix had assumed a stale-port
race on UDP 5600 and shipped as 0.1.2; **it did not resolve the failure** —
the port theory was wrong.

Real cause, reproduced against a synthetic H.265 RTP stream using the bridge's
exact arguments:

```
[AVHWDeviceContext] Failed to initialise VAAPI connection: -1 (unknown libva error).
No device available for decoder: device type vaapi needed for codec hevc.
[vist#0:0/hevc] Hardware device setup failed for decoder: Input/output error
Error opening output file /dev/video10.
```

Two compounding mistakes:

1. `systemFfmpegWithVaapi()` decided hardware was available by grepping
   `ffmpeg -hwaccels`, which reports **compile-time** support. Every distro
   ffmpeg lists `vaapi` regardless of whether the GPU can use it.
2. The hardware branch passed no `-vaapi_device`, so ffmpeg auto-initialised
   the **first** DRM render node. On the dev laptop:
   `renderD128` = firmware-disabled NVIDIA RTX 4070 (**VAAPI init fails**),
   `renderD129` = AMD iGPU (**works**). ffmpeg picked the dead one.

Everything else was fine: v4l2loopback loaded, `/dev/video10` present with a
`user:japesh:rw-` ACL, `exclusive_caps=Y`, nothing on port 5600.

## Decision

1. **Probe each render node for real** — `-init_hw_device vaapi=va:<node>
   -f lavfi -i nullsrc -frames:v 1 -f null -` — and take the first that
   initialises. Cache per process.
2. **Pass the winner explicitly as `-vaapi_device`.** Never trust ffmpeg's
   default node selection.
3. **Auto-fall-back to software** if a hardware attempt exits within
   `HW_SETUP_WINDOW_MS` (4s). A process that ran longer and then exits is a
   real stream ending (air unit off, RF link lost) and still surfaces as an
   error.
4. Report hardware-setup failures with a message naming the cause and the
   `sw` mode escape hatch, not a raw ffmpeg banner.

## Reason

Probing proves VAAPI *initialises*; it does not prove the driver exposes an
HEVC decode profile or that it won't fault on a particular stream. Both
manifest as an immediate exit, so the fallback is the robust mechanism and the
probe is an optimisation on top of it.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Keep the `-hwaccels` check, add `-vaapi_device renderD129` | **Rejected** — hardcodes one machine's topology. |
| Default to software always | Rejected — Intel iGPUs (the actual client hardware) have excellent Quick Sync HEVC decode; throwing it away wastes the scarcest resource. |
| Require the user to choose hw/sw | Rejected — the `mode: 'auto'` contract exists so operators never face this. |

## Trade-offs

Adds a one-time probe cost (a few short ffmpeg spawns) on first Start. Caching
means a driver installed later needs an app restart to be noticed — acceptable,
and consistent with the project's other one-time-setup idioms.

## Consequences

- Air-unit video Start works; verified hardware decode on `renderD129` and
  clean software decode as fallback.
- **Generalises well to real clients**: on a machine with no discrete GPU,
  `renderD128` *is* the iGPU, so most Intel i5 clients will get hardware
  decode automatically. The dead-node problem was specific to the dev laptop.
- The probe-then-fallback shape is now the project's template for capability
  detection — explicitly reused as the model for future SRT/WebRTC
  auto-selection (ADR-003).

## Lesson recorded

**A capability flag is not a capability.** `-hwaccels`, and any similar
compile-time report, must never be used as a runtime availability check.

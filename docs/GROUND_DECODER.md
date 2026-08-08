# HYRAK Ground Decoder — Luckfox Pico Ultra W

**Status: design. Nothing built yet.**

A dedicated ground-side receiver that owns the RF link, the driver and the
decryption keys, and hands HYRAK Control a clean compressed video stream plus
MAVLink over Ethernet.

The target experience: plug the ground unit into the PC, open HYRAK Control,
get video and telemetry. No RTL8812EU driver on the PC, no wfb-ng, no keys, no
GStreamer install, no terminal.

---

## Scope

This is **not** the Orange Pi 5 ground unit (`hyrak-ground-unit/`, airframe
work, `desktop-arm64/`). That box runs the whole stack on one board and drives
its own screen. This one is a *dongle*: it terminates RF and nothing else, and
the PC does all the presentation and AI.

Everything below concerns `hyrak_control` — the Electron desktop app and its
bridges — plus a new firmware image for the Luckfox.

---

## Topology

The Luckfox Pico Ultra W has USB-A and USB-C, but they share a **switched USB
data path** and cannot both act as independent USB data interfaces. That kills
the obvious layout:

```text
RTL8812EU → USB-A → Luckfox → USB-C → PC        ✗ not possible
```

The RTL8812EU is a USB device and needs a real host controller, so it cannot
move to GPIO. USB-A is therefore spoken for, and the PC link has to be
Ethernet — which is on an independent path.

```text
        DRONE                                    GROUND

  Camera → H.264/H.265 ─┐
                        ├─→ Realtek RF ~~~~~~~→  RTL8812EU
  Pixhawk → MAVLink ────┘                            │ USB-A
                                                     ▼
                                          Luckfox Pico Ultra W
                                          ├── 8812eu.ko
                                          ├── wfb_rx (FEC + decrypt)
                                          ├── RF keys  ← never leave here
                                          └── forward video + MAVLink
                                                     │ Ethernet
                                                     ▼
                                                Windows PC
                                                     │
                                             HYRAK Control
                                             ├── hardware decode (RTX 4070)
                                             ├── display + AI
                                             └── telemetry + controls
```

## Forward compressed, never raw

Decided, and worth stating plainly because the alternative is tempting:

```text
Luckfox decrypts → forwards compressed H.264/H.265 → PC hardware-decodes
```

Not `Luckfox decode → re-encode → PC decode`. That chain costs latency, costs
quality, and puts a transcode on a single-core Cortex-A7 that has no business
doing one.

Raw is not an option either — the arithmetic settles it:

| stream | bitrate |
|---|---|
| 1080p30 H.265 | 8–20 Mbps |
| 1080p60 H.265 | 20–40 Mbps |
| MAVLink | < 1 Mbps |
| **1080p30 raw NV12** | **~746 Mbps** |

100 Mbps Ethernet carries compressed video comfortably and raw video not at
all. The Luckfox's only video job is to move bytes it has already decrypted.

## Keys stay on the Luckfox

The RF stream is encrypted and the keys are needed to receive it. They live in
the Luckfox rootfs and are never copied to the PC:

```text
encrypted RF → [Luckfox: wfb_rx decrypts] → plaintext H.265 → Ethernet → PC
```

One consequence to be deliberate about: the Ethernet segment carries the
decrypted stream **in the clear**. On a direct cable between the ground unit
and the PC that is fine. It stops being fine the moment that link crosses a
shared switch or a venue network, and at that point the answer is SRT with a
passphrase on the Ethernet hop — the same mechanism `relay_video_source.py`
already uses for the public-internet hop — not a change to the RF layer.

---

## What already exists

Most of the risky groundwork is done. Checked in the tree, not assumed:

**The RTL8812EU driver is already built for a Luckfox.**
`communication/luckfox_pico_airunit/rtl8812eu/` contains a built `8812eu.ko`
(plus `8812eu.stripped.ko`, `dkms.conf` and `build-luckfox.sh`). The air unit
is an RV1106 board using the same adapter, so the cross-compile against the
Luckfox SDK kernel is a solved problem, not a research task.

**wfb-ng is already cross-built and there is a native ground-station bundle.**
`communication/luckfox_pico_airunit/build/gs-native/` holds `bin/`,
`start-gs.sh` and `gst-decode.sh`, and `wfb-ng/` is the full source tree.
`start-gs.sh` already does exactly the receive side that is wanted here:

```bash
wfb_rx -K gs.key -c 127.0.0.1 -u 5600 -p 0 $WLAN   # video
```

**The PC-side video path already exists and already does what is wanted.**
The desktop app's `air_unit_gst` mode is, precisely, *"receive RTP/H.265 on a
UDP port, hardware-decode it, show it in HYRAK Control"*
(`desktop/src/bridges/gstreamerBridge.ts`). Its source is `udpsrc port=5600`,
which does not care whether `wfb_rx` is running on the same machine or one
Ethernet hop away.

So the minimum viable version of this whole project is a **configuration**
change, not a new transport:

```bash
wfb_rx -K gs.key -c <PC-IP> -u 5600 -p 0 $WLAN
```

Point the Luckfox's `wfb_rx` at the PC instead of its own loopback and the
existing mode receives it unchanged. That should be the first thing tried —
it converts steps 4, 6 and 7 of the original plan into an afternoon, and it
gives a working baseline to measure everything else against.

---

## The decode decision on Windows

The original plan says "bundle FFmpeg so the user doesn't install GStreamer".
That gets the packaging right and the **performance wrong**, and the reason is
already documented for the Linux side in `docs/CHANGELOG.md` (desktop 0.1.43)
and `ADR/ADR-005`:

> the bundled ffmpeg cannot touch a GPU — `-hwaccels` reports only `vdpau`, no
> VAAPI, no QSV, no NVENC.

That is a property of the `ffmpeg-static` build, not a flag. Bundling it gives
**software** decode on the PC — on a machine with an RTX 4070, which is the
opposite of the goal.

Three candidates, in the order I would try them:

**1. WebCodecs in the renderer — no bundling at all.** Chromium's
`VideoDecoder` with `hardwareAcceleration: 'prefer-hardware'` reaches the 4070
through D3D11 / Media Foundation. Nothing ships in the installer, nothing
touches a GPU from Node, and the plumbing already exists: the bridge's
`webcodecs: true` path already emits framed Annex-B access units over loopback
HTTP and the renderer already parses them. On this path the Luckfox's stream
could go to WebCodecs *as H.265*, skipping the H.265→H.264 transcode the Linux
preview performs — that transcode exists only because Chromium has no
*software* HEVC decoder, and a 4070 makes it unnecessary.
**Must be verified on the actual box**: HEVC hardware decode in Chromium on
Windows is platform-gated, and if it is unavailable the transcode comes back.

**2. GStreamer with the NVCODEC plugin.** `nvh264dec` / `nvh265dec` bind
`nvcuvid.dll` from the NVIDIA driver, which is already installed on any machine
with a 4070. This is genuinely more bundle-able on Windows than the VAAPI
equivalent is on Linux, where `libgstvaapi.so` links the system's
libva/libdrm/EGL stack and a bundled copy would not initialise. Still a plugin
framework with a registry to ship.

**3. A custom ffmpeg build with NVDEC.** Full control, and a build to own
forever. Last resort.

Start at 1. It is the only option that costs zero installer bytes, and it is
the one most likely to just work.

---

## Telemetry

`start-gs.sh` already splits MAVLink onto its own radio port and its own UDP
port (down `udp:14550`, plus an uplink). Forwarding is the same one-flag change
as video — point it at the PC.

UDP is sufficient; MAVLink is designed for a lossy link and is well under
1 Mbps. `desktop/src/bridges/udpBridge.ts` already exists on the PC side.

A virtual COM port for QGroundControl / Mission Planner is explicitly **not**
in v1.

---

## Not in v1: the Windows virtual camera

The original goal was for the feed to appear as "HYRAK Air Unit Camera" in
Windows Camera, OBS, Teams. A USB webcam device is impossible here — UVC needs
the USB-C data path, which the hardware cannot provide while USB-A holds the
RTL8812EU. Ethernet does not present as a camera.

It remains achievable with a PC-side virtual camera driver
(`Luckfox → Ethernet → HYRAK receiver → Windows virtual camera`), but it is a
separate component with its own driver-signing story, and it is not needed for
video to appear *inside* HYRAK Control. Deferred, not cancelled.

---

## Open risks

Ranked. The first one can invalidate the board choice, so it should be
answered before anything else is built.

**1. Can an RV1106 Cortex-A7 sustain `wfb_rx` at 1080p bitrates?** This is the
real unknown. The existing Luckfox work is an *air* unit running `wfb_tx` —
encrypt and transmit. Receive is the harder direction: Reed-Solomon FEC
*decode*, packet reordering, and ChaCha20-Poly1305 over every packet, on one
1.2 GHz A7 core. If it cannot hold 20 Mbps the architecture is sound but the
board is wrong, and the answer is a board with more CPU — not a redesign.
Measure `wfb_rx` CPU under a real link before writing any integration code.

**2. Does the Ultra W's Ethernet exist and perform?** The plan assumes
10/100. Confirm the port, confirm the PHY comes up under the Luckfox SDK
kernel, and measure actual throughput with `iperf3` — a 100 Mbps PHY that
tops out at 40 Mbps because of a weak SoC MAC would still be fine for 1080p30
and marginal for 1080p60.

**3. Zero-configuration networking.** "Plug in and it works" is not automatic
over Ethernet. A direct cable to a PC with no DHCP server leaves both ends on
IPv4 link-local, and `wfb_rx -c <PC-IP>` needs a *known* address. Options: a
static pair on a private subnet with the PC side auto-configured by HYRAK; a
tiny DHCP server on the Luckfox; or mDNS discovery. This is small but it is
the difference between the stated user experience and "ask the user to set an
IP address", and it is currently unspecified.

**4. HEVC hardware decode in Chromium on Windows.** See the decode section.
Determines whether the transcode is needed.

**5. Boot time and robustness.** The unit must come up on power alone, with
no login and no terminal, and recover when the adapter is hot-plugged or the
link drops. The Orange Pi's provisioning scripts are a useful reference for
what "appliance" means in practice.

---

## Revised development order

The original order is right; what changes is that several steps are already
paid for, and the riskiest item moves to the front.

| # | step | state |
|---|---|---|
| 0 | **Measure `wfb_rx` CPU on the RV1106 under a real 1080p link** | **do this first — gates the board choice** |
| 1 | RTL8812EU driver on the Luckfox | `8812eu.ko` already built (`rtl8812eu/build-luckfox.sh`) |
| 2 | Build wfb-ng for the Luckfox | already cross-built (`build/gs-native/`) |
| 3 | Receive + decrypt with existing keys | `start-gs.sh` already does this |
| 4 | Forward video over Ethernet | one flag: `wfb_rx -c <PC-IP>` |
| 5 | Forward MAVLink over Ethernet | same, on `udp:14550` |
| 6 | PC receiver displays video | `air_unit_gst` already does this |
| 7 | Integrate into Electron | bridge already exists |
| 8 | **NVIDIA hardware decode** | **the real work — WebCodecs first** |
| 9 | Package native binaries in the installer | may be *nothing* if step 8 lands on WebCodecs |
| 10 | Zero-config networking + appliance boot | unspecified, needed for the stated UX |
| 11 | Windows virtual camera | deferred |

Steps 1–7 are a plumbing exercise over work that already exists. The project
is really steps 0, 8 and 10.

---

## First verification

One command changes on the Luckfox, nothing changes on the PC:

```bash
# on the Luckfox, replacing 127.0.0.1 with the PC's address
wfb_rx -K gs.key -c 192.168.50.10 -u 5600 -p 0 $WLAN
```

Then on the PC, in HYRAK Control, select the `air_unit_gst` video source and
Start. If video appears, the entire transport chain is proven and what remains
is hardware decode, packaging and polish.

Windows Firewall will block inbound UDP 5600 on first run. That is the first
thing to check if it stays black.

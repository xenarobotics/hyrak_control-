#!/bin/bash
# One-time setup for the air-unit relay bridges (video_webcam.sh,
# telemetry_relay.py). Run this once; from then on just use run_all.sh.
# Needs sudo for: apt install, the v4l2loopback module.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== [1/3] v4l2loopback (virtual webcam device for video_webcam.sh) =="
sudo apt update
# DKMS builds the module for EVERY installed kernel, not just the one
# actually running — a HWE box often has a second, newer kernel installed
# but not yet booted into, and this package's install script (bundled
# source, not something we control) currently fails to build against
# certain very new kernels' changed v4l2 API. apt then reports the whole
# package as broken even though the module built fine for the kernel we
# actually care about. Don't treat that as fatal here; verify what we
# actually need (the module for the RUNNING kernel) explicitly instead.
sudo apt -y install v4l2loopback-dkms python3-pip || true
# Hardware H.265 decode (Intel iGPU VAAPI) — critical for latency on
# laptops with weak CPUs: software decode falling behind real time is the
# main cause of a multi-second-laggy feed. Non-fatal if some package isn't
# available on this distro; video_webcam.sh falls back to software decode.
sudo apt -y install gstreamer1.0-vaapi intel-media-va-driver-non-free || \
	sudo apt -y install gstreamer1.0-vaapi intel-media-va-driver || true

if ! find "/lib/modules/$(uname -r)" -iname 'v4l2loopback.ko*' 2>/dev/null | grep -q .; then
	echo "error: v4l2loopback didn't build for the kernel you're actually running ($(uname -r))" >&2
	echo "       check: sudo dkms status v4l2loopback" >&2
	exit 1
fi
echo "v4l2loopback module present for $(uname -r)"

if ! lsmod | grep -q '^v4l2loopback'; then
	sudo modprobe v4l2loopback video_nr=10 card_label="HyrakAirUnit" exclusive_caps=1
else
	echo "v4l2loopback already loaded, skipping modprobe"
fi

# Load with the same params on every future boot, so this step is truly
# one-time — otherwise the modprobe above only lasts until reboot.
echo "options v4l2loopback video_nr=10 card_label=\"HyrakAirUnit\" exclusive_caps=1" | sudo tee /etc/modprobe.d/hyrak-v4l2loopback.conf > /dev/null
if ! grep -qx "v4l2loopback" /etc/modules 2>/dev/null; then
	echo "v4l2loopback" | sudo tee -a /etc/modules > /dev/null
fi

echo "== [2/3] project tools (rc_test_sender, wfb_rssi_inject) =="
# start-gs.sh pipes the mavlink-downlink wfb_rx's output into a FIFO that
# only wfb_rssi_inject reads — opening a FIFO for writing blocks until a
# reader shows up, so if this binary is missing, that wfb_rx never even
# starts and MAVLink downlink telemetry silently never runs. Not cosmetic.
mkdir -p "$SCRIPT_DIR/bin"
if [ ! -x "$SCRIPT_DIR/bin/wfb_rssi_inject" ] && [ -f "$SCRIPT_DIR/wfb_rssi_inject.c" ]; then
	gcc -O2 -Wall -o "$SCRIPT_DIR/bin/wfb_rssi_inject" "$SCRIPT_DIR/wfb_rssi_inject.c"
fi
if [ ! -x "$SCRIPT_DIR/bin/rc_test_sender" ] && [ -f "$SCRIPT_DIR/rc_test_sender.c" ]; then
	# Optional (only used for testing the RC channel, not video or
	# telemetry) and its #include of luckfox-pico/.../rc_packet.h reaches
	# into the 19GB SoC SDK tree that gs-bundle.tar.gz deliberately doesn't
	# ship — so it won't compile from just this bundle. Don't let that take
	# the rest of setup down with it.
	gcc -O2 -Wall -o "$SCRIPT_DIR/bin/rc_test_sender" "$SCRIPT_DIR/rc_test_sender.c" \
		|| echo "note: rc_test_sender didn't build (needs the full luckfox-pico tree) — harmless, it's not used by video or telemetry"
fi
if [ ! -x "$SCRIPT_DIR/bin/wfb_rssi_inject" ]; then
	echo "warning: wfb_rssi_inject still missing (wfb_rssi_inject.c not found next to this script) —" >&2
	echo "         MAVLink downlink will hang at startup until this is built, see setup.sh" >&2
fi

echo "== [3/3] telemetry_relay.py's dependency =="
# Ubuntu 24.04+ blocks unmanaged system-wide pip installs (PEP 668) — this
# is a single, small, vetted package on a dedicated ground-station box, not
# a shared production server, so the override is the pragmatic call here
# over adding a venv's worth of extra steps to what's meant to be simple.
pip install --user --break-system-packages websockets

cat <<'EOF'

Done. From now on:
  ./run_all.sh
(brings up the RF link + both bridges together — see run_all.sh --help for
options if your ground-station bundle isn't at the default path.)
EOF

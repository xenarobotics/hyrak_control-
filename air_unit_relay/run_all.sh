#!/bin/bash
# One-step launcher: brings up the RF link (start-gs.sh) and both bridges
# the site needs (video_webcam.sh's virtual webcam, telemetry_relay.py's
# WebSocket) together in a single terminal. Run ./setup.sh once before the
# first use. Ctrl+C stops everything cleanly.
#
# Expects to live in the SAME folder as start-gs.sh — i.e. copy this
# script (and video_webcam.sh, telemetry_relay.py, setup.sh) straight into
# your extracted gs-bundle's build/gs-native/ folder, alongside the
# start-gs.sh/gst-decode.sh/bin/ that are already there. Pass --gs-dir if
# you'd rather keep it somewhere else.
#
# usage: ./run_all.sh [--gs-dir PATH] [--video-mode auto|hw|sw] [--device /dev/videoN]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GS_DIR="$SCRIPT_DIR"
VIDEO_MODE="auto"
DEVICE="/dev/video10"

while [ $# -gt 0 ]; do
	case "$1" in
		--gs-dir)     GS_DIR="$2"; shift 2 ;;
		--video-mode) VIDEO_MODE="$2"; shift 2 ;;
		--device)     DEVICE="$2"; shift 2 ;;
		--help|-h)
			sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
			exit 0 ;;
		*) echo "unknown arg: $1 (see --help)" >&2; exit 1 ;;
	esac
done

if [ ! -x "$GS_DIR/start-gs.sh" ]; then
	echo "error: start-gs.sh not found at $GS_DIR" >&2
	echo "       pass --gs-dir /path/to/build/gs-native" >&2
	exit 1
fi
if [ ! -e "$DEVICE" ]; then
	echo "error: $DEVICE doesn't exist — run ./setup.sh first" >&2
	exit 1
fi

# start-gs.sh needs sudo internally for several commands (iw, ip link,
# wfb_rx/wfb_tx) — grab it up front so those don't stall waiting for a
# password prompt once this is running in the background.
sudo -v

PIDS=()
cleanup() {
	echo ""
	echo "stopping everything..."
	for pid in "${PIDS[@]}"; do
		kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== [1/3] RF link (start-gs.sh) =="
(cd "$GS_DIR" && ./start-gs.sh) &
PIDS+=($!)
sleep 3  # let the interface come up and wfb_rx/wfb_tx bind before the bridges start reading from them

echo "== [2/3] video bridge -> $DEVICE =="
"$SCRIPT_DIR/video_webcam.sh" "$VIDEO_MODE" "$DEVICE" &
PIDS+=($!)

echo "== [3/3] telemetry bridge -> ws://127.0.0.1:8765 =="
python3 "$SCRIPT_DIR/telemetry_relay.py" &
PIDS+=($!)

cat <<'EOF'

Everything's running. On the site:
  Settings -> Video source -> Camera -> pick "HyrakAirUnit"
  Devices panel -> Telemetry -> "Local RF relay (air unit)" -> Connect

Ctrl+C here stops everything.
EOF
wait

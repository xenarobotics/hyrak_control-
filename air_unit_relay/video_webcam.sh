#!/bin/bash
# Feeds wfb_rx's video UDP output (127.0.0.1:5600, see start-gs.sh) into a
# v4l2loopback virtual webcam device instead of a preview window — so the
# site's EXISTING camera pipeline (getUserMedia, already built, no new
# frontend/backend code needed) picks it up exactly like a real USB camera.
# Same decode front-end as gst-decode.sh, just a different final sink — only
# one of the two can run at a time, both bind the same UDP port.
#
# Latency notes (why this looks the way it does):
#  - "auto" tries HARDWARE decode first (Intel iGPU VAAPI/VA — present on
#    most laptops even without a dedicated GPU) and only falls back to
#    software. Software H.265 decode on a weak CPU can't keep up in real
#    time, and that is the #1 cause of multi-second lag.
#  - drop-on-latency=true on the jitterbuffer: without it, a decoder that
#    falls even slightly behind makes frames QUEUE instead of drop, so
#    latency grows without bound (seconds). With it, late frames are
#    discarded and the feed stays live.
#  - a 1-frame leaky queue before the sink: same idea at the output end —
#    always show the newest frame, never build a backlog.
#  - I420 output instead of YUY2: it's what the decoders already produce
#    (videoconvert becomes a near-no-op), it's 25% less data per frame,
#    and it's Chrome's native internal format, so the browser does zero
#    conversion when capturing it.
#
# One-time setup: ./setup.sh (v4l2loopback module + VAAPI packages)
# Then in the site: Settings -> Video source -> Camera -> pick "HyrakAirUnit"
#
# usage: ./video_webcam.sh [auto|hw|sw] [/dev/videoN]
set -euo pipefail

MODE="${1:-auto}"
DEVICE="${2:-/dev/video10}"
CAPS="application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96"

if [ ! -e "$DEVICE" ]; then
	echo "error: $DEVICE doesn't exist — run ./setup.sh first" >&2
	exit 1
fi

have() { gst-inspect-1.0 "$1" >/dev/null 2>&1; }

# Pick the decoder. Two hardware plugin generations exist: "vaapih265dec"
# (gstreamer1.0-vaapi, what gst-decode.sh uses) and its replacement
# "vah265dec" (gstreamer1.0-plugins-bad, newer distros). Try both.
DEC=""
if [ "$MODE" = "hw" ] || [ "$MODE" = "auto" ]; then
	if have vaapih265dec; then DEC="vaapih265dec"
	elif have vah265dec;  then DEC="vah265dec"
	elif [ "$MODE" = "hw" ]; then
		echo "error: no VAAPI/VA H.265 decoder found (install gstreamer1.0-vaapi) — try 'sw'" >&2
		exit 1
	fi
fi
if [ -z "$DEC" ]; then
	DEC="avdec_h265"
	echo "warning: using SOFTWARE decode — on a weak CPU this may lag." >&2
	echo "         install VAAPI for hardware decode: sudo apt install gstreamer1.0-vaapi intel-media-va-driver-non-free" >&2
fi

echo "decoding with $DEC -> $DEVICE ..."
exec gst-launch-1.0 -v \
	udpsrc port=5600 caps="$CAPS" ! \
	rtpjitterbuffer latency=50 drop-on-latency=true ! \
	rtph265depay ! h265parse ! \
	"$DEC" ! videoconvert ! video/x-raw,format=I420 ! \
	queue max-size-buffers=1 leaky=downstream ! \
	v4l2sink device="$DEVICE" sync=false

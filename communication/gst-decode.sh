#!/bin/bash
# H.265/RTP low-latency decode+display, receiving from wfb_rx's video UDP
# output (127.0.0.1:5600, see start-gs.sh). Two paths - try hardware (vaapi)
# first since software HEVC decode can struggle to keep up at low latency;
# fall back to software (avdec_h265) if vaapi isn't available on this GPU.
#
# usage: ./gst-decode.sh [sw|hw]
set -euo pipefail

MODE="${1:-hw}"
CAPS="application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96"

if [ "$MODE" = "hw" ]; then
	echo "trying VAAPI hardware decode..."
	exec gst-launch-1.0 -v \
		udpsrc port=5600 caps="$CAPS" ! \
		rtpjitterbuffer latency=50 ! \
		rtph265depay ! h265parse ! \
		vaapih265dec ! vaapisink sync=false
else
	echo "software decode..."
	exec gst-launch-1.0 -v \
		udpsrc port=5600 caps="$CAPS" ! \
		rtpjitterbuffer latency=50 ! \
		rtph265depay ! h265parse ! \
		avdec_h265 ! videoconvert ! autovideosink sync=false
fi

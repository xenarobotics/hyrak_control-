#!/bin/bash
# Ground station launcher: puts the RTL8812EU into monitor mode on a fixed
# channel and starts the four wfb-ng streams that mirror the drone side:
#   radio_port 0: video      (drone wfb_tx -> here wfb_rx -> udp 127.0.0.1:5600)
#   radio_port 1: mavlink dn (drone wfb_tx -> here wfb_rx -> udp 127.0.0.1:14550)
#   radio_port 2: mavlink up (here wfb_tx -u 14551 -> drone wfb_rx)
#   radio_port 3: RC (sbus/crsf) (here wfb_tx -u $RC_PORT -> drone wfb_rx -> sbus_uart_bridge)
#     RC_PORT here is just this ground station's own local port for whatever
#     sends RC data (rc_test_sender.c for now, eventually the Orange Pi
#     5/STM32 rig) - independent of the drone's own local RC_PORT choice,
#     same as video/mavlink already are.
#
# Sequence for putting the NIC into monitor mode mirrors wfb-ng's own
# wfb_ng/server.py init_wlans() (iw reg / down / monitor otherbss / up / channel).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/bin"
KEYS_DIR="$HOME/.wfb"
WFB_NG_SRC="$(cd "$SCRIPT_DIR/../../wfb-ng" && pwd)"

WLAN="${WLAN:-}"
CHANNEL="${CHANNEL:-165}"
HT_MODE="${HT_MODE:-HT20}"
REGION="${REGION:-BO}"
BANDWIDTH="${BANDWIDTH:-20}"
RC_PORT="${RC_PORT:-14570}"

if [ -z "$WLAN" ]; then
	WLAN="$("$WFB_NG_SRC/scripts/wfb-nics")"
fi
if [ -z "$WLAN" ]; then
	echo "error: no rtl88x2eu/rtl88xxau_wfb interface found - is the dongle plugged in and the driver loaded?" >&2
	exit 1
fi
echo "using interface: $WLAN"

sudo iw reg set "$REGION"
if command -v nmcli >/dev/null && nmcli device show "$WLAN" 2>/dev/null | grep -qv '(unmanaged)'; then
	sudo nmcli device set "$WLAN" managed no || true
fi
sudo ip link set "$WLAN" down
sudo iw dev "$WLAN" set monitor otherbss
sudo ip link set "$WLAN" up
sudo iw dev "$WLAN" set channel "$CHANNEL" "$HT_MODE"

echo "interface $WLAN is now in monitor mode on channel $CHANNEL $HT_MODE"

RSSI_FIFO="$(mktemp -u)"
mkfifo "$RSSI_FIFO"

PIDS=()
cleanup() {
	echo "stopping..."
	for pid in "${PIDS[@]}"; do
		sudo kill "$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
	done
	kill $(jobs -p) 2>/dev/null || true
	rm -f "$RSSI_FIFO"
}
trap cleanup EXIT INT TERM

# wfb_rx has no -B (bandwidth) option - that's a tx-side injection PHY
# parameter; rx just listens on the monitor interface. Raw PF_PACKET sockets
# need CAP_NET_RAW, hence sudo here too (not just for the iw/ip setup above).
sudo "$BIN/wfb_rx" -K "$KEYS_DIR/gs.key" -c 127.0.0.1 -u 5600  -p 0 "$WLAN" &
PIDS+=($!)

# mavlink downlink: wfb_rx's stdout carries its once-a-second RX_ANT/PKT
# stats lines (Aggregator::dump_stats() in wfb-ng/src/rx.cpp). Route them
# through a named FIFO (not a shell pipe - a `cmd1 | cmd2 &` backgrounds as
# a single job, so $! only gives cmd2's pid and we'd lose track of cmd1 for
# cleanup) into wfb_rssi_inject, which turns them into synthetic MAVLink
# RADIO_STATUS messages sent to the same UDP port QGC listens on. Without
# this, QGC never shows its telemetry RSSI indicator - our raw wfb_tx/wfb_rx
# pipe (unlike wfb-ng's own Python gs_mavlink profile) has nothing else that
# generates RADIO_STATUS.
sudo "$BIN/wfb_rx" -K "$KEYS_DIR/gs.key" -c 127.0.0.1 -u 14550 -p 1 "$WLAN" > "$RSSI_FIFO" &
PIDS+=($!)
"$BIN/wfb_rssi_inject" 127.0.0.1 14550 < "$RSSI_FIFO" &
PIDS+=($!)

sudo "$BIN/wfb_tx" -K "$KEYS_DIR/gs.key" -u 14551 -p 2 -B "$BANDWIDTH" -M 1 "$WLAN" &
PIDS+=($!)

sudo "$BIN/wfb_tx" -K "$KEYS_DIR/gs.key" -u "$RC_PORT" -p 3 -B "$BANDWIDTH" -M 1 "$WLAN" &
PIDS+=($!)

echo "video  -> udp 127.0.0.1:5600  (RTP H265, see gst-decode.sh)"
echo "mavlink drone->gs on udp 127.0.0.1:14550 (point QGC/MAVProxy here)"
echo "mavlink gs->drone: send udp to 127.0.0.1:14551"
echo "radio_status (rssi) injected into udp 127.0.0.1:14550 from wfb_rx stats"
echo "RC: send rc_packet datagrams (see sbus_bridge/rc_packet.h) to udp 127.0.0.1:$RC_PORT - try ./bin/rc_test_sender"
wait

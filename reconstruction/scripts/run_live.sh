#!/usr/bin/env bash
# Live capture from a network stream (or the local webcam for a smoke test).
#
#   scripts/run_live.sh rtsp://192.168.1.10:8554/live
#   scripts/run_live.sh udp://0.0.0.0:5600
#   scripts/run_live.sh /dev/video0
#   MAVLINK=udp:0.0.0.0:14550 scripts/run_live.sh rtsp://...
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .venv/bin/activate

URI="${1:-}"
[ -n "$URI" ] || { echo "usage: $0 <uri>   (rtsp:// udp:// tcp:// /dev/videoN)" >&2; exit 2; }
CONFIG="${CONFIG:-configs/drone_1080p30.yaml}"
SESSION="${SESSION:-flight_$(date +%Y%m%d_%H%M%S)}"

ARGS=(run -c "$CONFIG" --uri "$URI" --session "$SESSION")
[ -n "${MAVLINK:-}" ] && ARGS+=(--mavlink "$MAVLINK")
[ -n "${NOVIZ:-}" ]   && ARGS+=(--no-viz)

echo "session : $SESSION"
echo "config  : $CONFIG"
echo "control : http://127.0.0.1:8088/status   (POST /stop to finish and export)"
exec dronemap "${ARGS[@]}"

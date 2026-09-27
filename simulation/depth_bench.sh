#!/usr/bin/env bash
# Capture a monocular-depth benchmark set (see depth_bench_capture.py) on a
# PRIVATE gz server: its own partition, no PX4, no GUI. A running hyrak_sim
# (partition hyrak_demo) is untouched. The server is stopped on exit.
#
#   ./depth_bench.sh [out_dir]      default ../backend/.data/depth_bench/frames
#   N_FRAMES=200 ./depth_bench.sh
# Then score models:  cd ../backend && .venv/bin/python tools/depth_bench_eval.py
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PX4="${PX4_DIR:-$HOME/PX4-Autopilot}"
ROOTFS="$PX4/build/px4_sitl_default/rootfs"
WORLD="${WORLD:-hyrak_obstacles}"
OUT="${1:-$HERE/../backend/.data/depth_bench/frames}"

: "${GZ_SIM_RESOURCE_PATH:=}" "${GZ_SIM_SYSTEM_PLUGIN_PATH:=}"
cd "$ROOTFS" && { . ./gz_env.sh 2>/dev/null || . ../gz_env.sh; }
export GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_bench WORLD PX4_GZ_WORLDS
export GZ_SIM_SERVER_CONFIG_PATH="$HERE/hyrak_server.config"

gz sim --render-engine ogre2 --verbose=1 -s "$PX4_GZ_WORLDS/$WORLD.sdf" > /tmp/hyrak_depth_bench_gz.log 2>&1 &
SERVER=$!
# gz sim ignores SIGTERM: interrupt it like Ctrl-C, then make sure.
_stop() { kill -INT $SERVER 2>/dev/null; for _ in 1 2 3 4 5 6 7 8; do kill -0 $SERVER 2>/dev/null || return; sleep 1; done; kill -KILL $SERVER 2>/dev/null; }
trap _stop EXIT
sleep 8
python3 "$HERE/depth_bench_capture.py" "$OUT"

#!/usr/bin/env bash
# Capture a monocular-depth benchmark set (see depth_bench_capture.py) on a
# PRIVATE gz server: its own partition, no PX4, no GUI. A running hyrak_sim
# (partition hyrak_demo) is untouched. The server is stopped on exit.
#
#   ./depth_bench.sh [out_dir]      default ../backend/.data/depth_bench/frames
#   N_FRAMES=200 ./depth_bench.sh
#   WORLD=hyrak_indoor ./depth_bench.sh    any world in simulation/worlds or
#                                          PX4's worlds folder
#   PX4_DIR=/path/to/PX4-Autopilot          PX4 checkout (default ~/PX4-Autopilot)
# Then score models:  cd ../backend && .venv/bin/python tools/depth_bench_eval.py
#
# The server log is simulation/.logs/depth_bench_gz.log (next to hyrak_sim's).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PX4="${PX4_DIR:-$HOME/PX4-Autopilot}"
ROOTFS="$PX4/build/px4_sitl_default/rootfs"
WORLD="${WORLD:-hyrak_obstacles}"
OUT="${1:-$HERE/../backend/.data/depth_bench/frames}"
LOGS="$HERE/.logs"
mkdir -p "$LOGS"

: "${GZ_SIM_RESOURCE_PATH:=}" "${GZ_SIM_SYSTEM_PLUGIN_PATH:=}" "${PX4_GZ_WORLDS:=}"
if [ ! -d "$ROOTFS" ]; then
    echo "PX4 SITL build not found: $ROOTFS (set PX4_DIR; build with make px4_sitl_default)" >&2
    exit 1
fi
cd "$ROOTFS" && { . ./gz_env.sh 2>/dev/null || . ../gz_env.sh; }
# Our own models/worlds first (hyrak_indoor and its assets live in
# simulation/worlds and simulation/models); PX4's stay on the path.
export GZ_SIM_RESOURCE_PATH="$HERE/models:$HERE/worlds:$GZ_SIM_RESOURCE_PATH"
export GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_bench WORLD PX4_GZ_WORLDS
export GZ_SIM_SERVER_CONFIG_PATH="$HERE/hyrak_server.config"

# A world in simulation/worlds wins over PX4's of the same name (as in
# hyrak_sim.sh), so hyrak_indoor can be benched too.
if [ -f "$HERE/worlds/$WORLD.sdf" ]; then WORLD_FILE="$HERE/worlds/$WORLD.sdf"
elif [ -n "$PX4_GZ_WORLDS" ] && [ -f "$PX4_GZ_WORLDS/$WORLD.sdf" ]; then WORLD_FILE="$PX4_GZ_WORLDS/$WORLD.sdf"
else
    echo "world not found: $WORLD.sdf (looked in $HERE/worlds and ${PX4_GZ_WORLDS:-<PX4_GZ_WORLDS unset>})" >&2
    exit 1
fi

gz sim --render-engine ogre2 --verbose=1 -s "$WORLD_FILE" > "$LOGS/depth_bench_gz.log" 2>&1 &
SERVER=$!
# gz sim ignores SIGTERM: interrupt it like Ctrl-C, then make sure.
_stop() { kill -INT $SERVER 2>/dev/null; for _ in 1 2 3 4 5 6 7 8; do kill -0 $SERVER 2>/dev/null || return; sleep 1; done; kill -KILL $SERVER 2>/dev/null; }
trap _stop EXIT
# Wait for the WORLD, not a fixed 8 s: the indoor world's textures load
# slowly and the outdoor one is up in 2 s. Same probe as hyrak_sim.sh, on
# our own partition (GZ_PARTITION is exported above, so gz topic sees it).
for _ in $(seq 1 60); do
    gz topic -l 2>/dev/null | grep -q "^/world/$WORLD/clock" && break
    kill -0 $SERVER 2>/dev/null || break
    sleep 1
done
if ! gz topic -l 2>/dev/null | grep -q "^/world/$WORLD/clock"; then
    echo "gz world $WORLD did not come up (see $LOGS/depth_bench_gz.log)" >&2
    exit 1
fi
# depth_bench_capture.py reads the world's sdf from $PX4_GZ_WORLDS/$WORLD.sdf
# (to place the camera at the spawn points it lists), so hand it the folder
# the world was actually found in.
PX4_GZ_WORLDS="$(dirname "$WORLD_FILE")" python3 "$HERE/depth_bench_capture.py" "$OUT"

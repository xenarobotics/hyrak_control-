#!/usr/bin/env bash
# HYRAK cloud SITL - ONE headless PX4 + Gazebo instance for one customer
# session (docs/ACCESS_MODEL.md 8c). Started and stopped by the backend
# (backend/app/sim/), which owns the process group this script leads.
#
#   cloud_sim.sh --instance N --partition NAME --mav-port P --px4-port Q \
#                --dds-port D --model gz_x500 --autostart 4001 \
#                --world default --home LAT,LON --workdir DIR
#
# Runs in the foreground until PX4 exits or it is signalled. Everything it
# starts inherits HYRAK_CLOUD_SIM_ID from the backend, the marker the
# backend's sweep matches on; nothing here kills by pattern.
#
# Derived from hyrak_sim.sh, with the same pinned lessons:
#  - GZ_IP=127.0.0.1 and a GZ_PARTITION unique to this instance: it cannot
#    discover, or be discovered by, any other gz on the machine.
#  - hyrak_server.config (PX4's server.config minus GstCameraSystem, the
#    ~9 MB/s camera-frame leak). The gz server is started first with it and
#    PX4 adopts the running world, so no PX4_GZ_STANDALONE.
#  - PX4_HOME_ALT=0: the gz barometer reads sea level.
#  - NAV_DLL_ACT=2 (return on link loss) and RTL_RETURN_ALT=10, as the demo.
# Different from hyrak_sim.sh:
#  - No GUI ever, no camera bridge (a camera feed is a follow-up), and
#    DISPLAY is not used.
#  - PX4 runs in a fresh working directory (WORKDIR), so parameters,
#    mission and logs start clean and vanish with the instance.
#  - PX4's stock MAVLink links are replaced (cloud_sim_rc/px4-rc.mavlink):
#    one link, PX4 udp:<px4-port> -> 127.0.0.1:<mav-port>. Nothing goes to
#    udp:14550 or 1454x.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PX4="${PX4_DIR:-$HOME/PX4-Autopilot}"
BUILD="$PX4/build/px4_sitl_default"
ROOTFS="$BUILD/rootfs"

INSTANCE="" PARTITION="" MAV_PORT="" PX4_PORT="" DDS_PORT="" MODEL="gz_x500"
AUTOSTART="4001" WORLD="default" HOME_LL="" WORKDIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --instance)  INSTANCE="$2"; shift 2 ;;
        --partition) PARTITION="$2"; shift 2 ;;
        --mav-port)  MAV_PORT="$2"; shift 2 ;;
        --px4-port)  PX4_PORT="$2"; shift 2 ;;
        --dds-port)  DDS_PORT="$2"; shift 2 ;;
        --model)     MODEL="$2"; shift 2 ;;
        --autostart) AUTOSTART="$2"; shift 2 ;;
        --world)     WORLD="$2"; shift 2 ;;
        --home)      HOME_LL="$2"; shift 2 ;;
        --workdir)   WORKDIR="$2"; shift 2 ;;
        *) echo "cloud_sim: unknown argument $1" >&2; exit 2 ;;
    esac
done

_int() { [[ "$1" =~ ^[0-9]{1,5}$ ]]; }
_num() { [[ "$1" =~ ^-?[0-9]{1,3}(\.[0-9]{1,9})?$ ]]; }
for v in "$INSTANCE" "$MAV_PORT" "$PX4_PORT" "$DDS_PORT" "$AUTOSTART"; do
    _int "$v" || { echo "cloud_sim: bad number '$v'" >&2; exit 2; }
done
[[ "$PARTITION" =~ ^[A-Za-z0-9_]{4,64}$ ]] || { echo "cloud_sim: bad partition" >&2; exit 2; }
[[ "$MODEL" =~ ^gz_[a-z0-9_]{1,40}$ ]] || { echo "cloud_sim: bad model" >&2; exit 2; }
[[ "$WORLD" =~ ^[a-z0-9_]{1,40}$ ]] || { echo "cloud_sim: bad world" >&2; exit 2; }
HOME_LAT="${HOME_LL%%,*}"; HOME_LON="${HOME_LL##*,}"
_num "$HOME_LAT" && _num "$HOME_LON" || { echo "cloud_sim: bad --home" >&2; exit 2; }
[ -n "$WORKDIR" ] && mkdir -p "$WORKDIR" || { echo "cloud_sim: no --workdir" >&2; exit 2; }
if [ "$INSTANCE" -lt 100 ] || [ "$INSTANCE" -gt 199 ]; then
    echo "cloud_sim: instance must be 100-199 (0-99 belong to the owner's sims)" >&2; exit 2
fi
if [ ! -x "$BUILD/bin/px4" ] || [ ! -f "$ROOTFS/gz_env.sh" ]; then
    echo "cloud_sim: PX4 SITL build not found under $PX4 (make px4_sitl_default)" >&2; exit 1
fi

export GZ_IP=127.0.0.1 GZ_PARTITION="$PARTITION" HEADLESS=1
export GZ_SIM_SERVER_CONFIG_PATH="$HERE/hyrak_server.config"
unset DISPLAY WAYLAND_DISPLAY
# PX4's gz_env.sh appends to these, so they must exist under set -u.
: "${GZ_SIM_RESOURCE_PATH:=}" "${GZ_SIM_SYSTEM_PLUGIN_PATH:=}" "${PX4_GZ_WORLDS:=}" "${PX4_GZ_MODELS:=}"
# shellcheck disable=SC1091
. "$ROOTFS/gz_env.sh"
WORLD_FILE="$PX4_GZ_WORLDS/$WORLD.sdf"
[ -f "$WORLD_FILE" ] || { echo "cloud_sim: world not found: $WORLD_FILE" >&2; exit 1; }

GZ_PID="" PX4_PID=""
_stop() {
    # Our own two children by pid, INT first (gz ignores TERM). The backend
    # also signals the whole group and sweeps by marker.
    for p in $PX4_PID $GZ_PID; do kill -INT "$p" 2>/dev/null; done
    for _ in 1 2 3 4 5 6; do
        alive=""
        for p in $PX4_PID $GZ_PID; do kill -0 "$p" 2>/dev/null && alive=1; done
        [ -z "$alive" ] && break
        sleep 1
    done
    for p in $PX4_PID $GZ_PID; do kill -KILL "$p" 2>/dev/null; done
}
trap '_stop; exit 0' INT TERM
trap '_stop' EXIT

echo "cloud_sim: gz server, world $WORLD, partition $PARTITION"
gz sim --verbose=1 -r -s --headless-rendering "$WORLD_FILE" &
GZ_PID=$!
for _ in $(seq 1 60); do
    gz topic -l 2>/dev/null | grep -q "^/world/$WORLD/clock" && break
    kill -0 "$GZ_PID" 2>/dev/null || { echo "cloud_sim: gz server exited" >&2; exit 1; }
    sleep 1
done
gz topic -l 2>/dev/null | grep -q "^/world/$WORLD/clock" \
    || { echo "cloud_sim: gz world $WORLD did not come up" >&2; exit 1; }
echo "cloud_sim: world ready, starting PX4 instance $INSTANCE"

cd "$WORKDIR" || exit 1
# cloud_sim_rc first on PATH: rcS sources px4-rc.mavlink through PATH, and
# ours replaces PX4's links with the single backend link.
PATH="$HERE/cloud_sim_rc:$PATH" \
HYRAK_MAV_LOCAL="$PX4_PORT" HYRAK_MAV_REMOTE="$MAV_PORT" \
PX4_UXRCE_DDS_PORT="$DDS_PORT" \
PX4_SYS_AUTOSTART="$AUTOSTART" PX4_SIM_MODEL="$MODEL" PX4_GZ_WORLD="$WORLD" \
PX4_GZ_NO_FOLLOW=1 \
PX4_HOME_LAT="$HOME_LAT" PX4_HOME_LON="$HOME_LON" PX4_HOME_ALT=0 \
PX4_PARAM_RTL_RETURN_ALT=10 PX4_PARAM_NAV_DLL_ACT=2 PX4_PARAM_SDLOG_BACKEND=0 \
    "$BUILD/bin/px4" -i "$INSTANCE" -d "$BUILD/etc" &
PX4_PID=$!
wait "$PX4_PID"
echo "cloud_sim: PX4 exited ($?)"

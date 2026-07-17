#!/usr/bin/env bash
# Multi-drone PX4 SITL launcher — spawns N x500 quads in ONE Gazebo world.
#
# Usage:
#   ./swarm.sh start [N]     start N drones (default 10)
#   ./swarm.sh stop          kill all SITL instances + Gazebo
#   ./swarm.sh status        show which instances are running
#
#   HEADLESS=1 ./swarm.sh start 10    run Gazebo without the GUI (recommended for 6+)
#
# Port map (matches the platform's fleet scanner):
#   instance i  →  MAVLink offboard UDP 14540+i   (i = 1..9)
#   instance i  →  MAVLink offboard UDP 14541+i   (i ≥ 10, skips 14550 = QGC)
#   So drone 1..9 → 14541..14549, drone 10 → 14551.
#   Requires the px4-rc.mavlink patch (already applied to ~/PX4-Autopilot).

set -uo pipefail

PX4_DIR="${PX4_DIR:-$HOME/PX4-Autopilot}"
PX4_BIN="$PX4_DIR/build/px4_sitl_default/bin/px4"
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.logs"
MODEL="${PX4_SWARM_MODEL:-gz_x500}"

# Home position — IIT Hyderabad
HOME_LAT=17.596569
HOME_LON=78.125203
HOME_ALT=500

# Spawn grid: 5 drones per row
GRID_COLS=5
SPACING=3

mkdir -p "$LOG_DIR"

pose_for() {
    local idx=$(( $1 - 1 ))                # 0-based
    local x=$(( (idx % GRID_COLS) * SPACING ))
    local y=$(( (idx / GRID_COLS) * SPACING ))
    echo "$x,$y,0,0,0,0"
}

port_for() {
    local i="$1"
    if [ "$i" -gt 9 ]; then echo $((14541 + i)); else echo $((14540 + i)); fi
}

start_instance() {
    local i="$1" standalone="$2"
    local pose; pose="$(pose_for "$i")"
    local log="$LOG_DIR/px4_$i.log"

    # PX4's init checks whether these vars are SET, not their value —
    # PX4_GZ_STANDALONE=0 still triggers standalone mode, so only pass
    # them when they should be active.
    local extra_env=()
    [ "$standalone" = "1" ] && extra_env+=(PX4_GZ_STANDALONE=1)
    [ "${HEADLESS:-0}" = "1" ] && extra_env+=(HEADLESS=1)

    env \
        PX4_SYS_AUTOSTART=4001 \
        PX4_SIM_MODEL="$MODEL" \
        PX4_GZ_MODEL_POSE="$pose" \
        PX4_HOME_LAT="$HOME_LAT" PX4_HOME_LON="$HOME_LON" PX4_HOME_ALT="$HOME_ALT" \
        "${extra_env[@]}" \
        "$PX4_BIN" -i "$i" -d > "$log" 2>&1 &

    echo "  drone $i  pose=($pose)  udp=$(port_for "$i")  pid=$!  log=$log"
    # Drop the job from bash's table so a later heal-kill of this instance
    # doesn't print a scary "line NN: PID Killed  env PX4_..." message.
    disown
}

wait_for_ready() {
    # Wait until this instance's PX4 finishes its startup script (model spawned
    # in Gazebo, EKF starting). Spawning the next model before this races the
    # gz world-creation service and can drop models.
    local i="$1"
    local log="$LOG_DIR/px4_$i.log"
    local tries=0
    while [ $tries -lt 60 ]; do
        # Success prints "returned successfully"; failure prints "with return value: N"
        if grep -qE "Startup script returned successfully|Ready for takeoff" "$log" 2>/dev/null; then
            return 0
        fi
        if grep -qE "Startup script returned with return value|gz_bridge failed" "$log" 2>/dev/null; then
            echo "  ERROR: drone $i failed to start — check $log"
            return 1
        fi
        sleep 0.5
        tries=$((tries + 1))
    done
    echo "  WARNING: drone $i not ready after 30 s — check $log"
    return 1
}

is_healthy() {
    grep -q "Ready for takeoff" "$LOG_DIR/px4_$1.log" 2>/dev/null
}

has_sensor_fault() {
    grep -qE "(Gyro|Accel) Sensor 0 missing|ekf2 missing data|barometer 0 missing" \
        "$LOG_DIR/px4_$1.log" 2>/dev/null
}

restart_instance() {
    # Kill this PX4 instance, remove its model from the world, relaunch as a
    # joiner. Fixes the gz_bridge race where PX4 subscribes to sensor topics
    # before the model publishes them — all sensors report "missing" until
    # the instance restarts and re-subscribes.
    local i="$1"
    pkill -9 -f "$PX4_BIN -i $i" 2>/dev/null
    sleep 1
    gz service -s /world/default/remove \
        --reqtype gz.msgs.Entity --reptype gz.msgs.Boolean \
        --timeout 5000 --req "name: \"x500_${i}\", type: MODEL" >/dev/null 2>&1
    sleep 2
    rm -rf "$PX4_DIR/build/px4_sitl_default/rootfs/$i"
    cd "$PX4_DIR"
    start_instance "$i" 1
    wait_for_ready "$i"
}

health_pass() {
    # REPORT-only during start: SIGKILL-restarting instances mid-boot leaves
    # stale subscriber registrations in gz-transport that degrade the sensor
    # streams of every OTHER drone (drifting EKF height, accel bias). A drone
    # that boots dirty gets restarted only when the user runs `heal` manually.
    local n="$1" mode="${2:-report}"
    local i tries
    for i in $(seq 1 "$n"); do
        tries=0
        while ! is_healthy "$i" && ! has_sensor_fault "$i" && [ $tries -lt 45 ]; do
            sleep 1
            tries=$((tries + 1))
        done
        if is_healthy "$i"; then
            continue
        fi
        if has_sensor_fault "$i" && [ "$mode" = "restart" ]; then
            echo "  drone $i: sensors missing (gz_bridge race) — restarting it"
            restart_instance "$i"
            tries=0
            while ! is_healthy "$i" && [ $tries -lt 45 ]; do
                sleep 1
                tries=$((tries + 1))
            done
        fi
        if is_healthy "$i"; then
            echo "  drone $i: healthy"
        elif has_sensor_fault "$i"; then
            echo "  WARNING: drone $i has a sensor fault — fix with: ./swarm.sh heal $n"
        else
            echo "  WARNING: drone $i still not ready — give it a moment or: ./swarm.sh heal $n"
        fi
    done
}

cmd_stop() {
    echo "Stopping swarm..."
    pkill -9 -f "$PX4_BIN" 2>/dev/null
    pkill -9 -f "gz sim" 2>/dev/null
    pkill -9 -f "gz-sim" 2>/dev/null
    pkill -9 -f mavsdk_server 2>/dev/null
    # Wait until Gazebo is truly gone — a half-dead gz server confuses the
    # next instance 1 into attaching to a world that vanishes mid-handshake.
    local tries=0
    while pgrep -f "gz sim|gz-sim" >/dev/null 2>&1 && [ $tries -lt 20 ]; do
        sleep 0.5
        tries=$((tries + 1))
    done
    sleep 1
    echo "Stopped."
}

cmd_status() {
    echo "PX4 instances:"
    pgrep -af "$PX4_BIN" | sed 's/^/  /' || echo "  none"
    echo "Gazebo:"
    pgrep -af "gz sim" | head -3 | sed 's/^/  /' || echo "  none"
}

wait_for_gz_transport() {
    # Extra guard before spawning joiners: confirm the gz transport answers
    local tries=0
    while [ $tries -lt 30 ]; do
        if gz service -l >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        tries=$((tries + 1))
    done
    echo "  WARNING: gz transport not answering"
    return 1
}

cmd_start() {
    local n="${1:-10}"

    if [ ! -x "$PX4_BIN" ]; then
        echo "ERROR: $PX4_BIN not found — build first: cd $PX4_DIR && make px4_sitl"
        exit 1
    fi

    cmd_stop

    # Fresh vehicle state each start: PX4 persists missions (dataman) and
    # params (eeprom, parameters.bson) per instance under build/…/rootfs/<i>.
    # Stale files resurrect old missions and home positions from previous
    # tests. Set KEEP_STATE=1 to preserve them across restarts.
    if [ "${KEEP_STATE:-0}" != "1" ]; then
        local i
        for i in $(seq 1 "$n"); do
            rm -rf "$PX4_DIR/build/px4_sitl_default/rootfs/$i"
        done
        echo "Cleared stored missions/params for instances 1–$n (KEEP_STATE=1 to keep)"
    fi
    echo ""
    echo "Launching $n-drone swarm ($MODEL, home $HOME_LAT,$HOME_LON)"
    [ "${HEADLESS:-0}" = "1" ] && echo "Headless mode — no Gazebo GUI"
    echo ""

    cd "$PX4_DIR"

    # Instance 1 boots the Gazebo world itself. If it fails (usually a stale
    # half-dead gz server from a previous run), clean up and retry once.
    start_instance 1 0
    echo "  waiting for Gazebo world..."
    if ! wait_for_ready 1; then
        echo "  retrying drone 1..."
        cmd_stop
        start_instance 1 0
        if ! wait_for_ready 1; then
            echo "ERROR: Gazebo world failed to start twice — aborting."
            exit 1
        fi
    fi

    wait_for_gz_transport

    # Remaining instances join the running world
    for i in $(seq 2 "$n"); do
        start_instance "$i" 1
        wait_for_ready "$i"
    done

    echo ""
    echo "Health check (report only — heal manually if a drone shows a fault)..."
    health_pass "$n" report

    echo ""
    echo "Swarm up: $n drones on UDP ports $(port_for 1)–$(port_for "$n")"
    echo "Open the platform, enable Swarm mode, and hit re-scan."
    echo "Stop with: ./swarm.sh stop"
}

case "${1:-start}" in
    start)  cmd_start "${2:-10}" ;;
    stop)   cmd_stop ;;
    status) cmd_status ;;
    heal)   cd "$PX4_DIR"; health_pass "${2:-10}" restart ;;
    *) echo "Usage: $0 {start [N]|stop|status|heal [N]}"; exit 1 ;;
esac

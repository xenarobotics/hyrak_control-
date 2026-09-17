#!/usr/bin/env bash
# HYRAK obstacle-avoidance demo sim - ONE isolated PX4 + Gazebo instance.
#
#   ./hyrak_sim.sh start      gz server + gz GUI + PX4 (instance 1) + camera bridge
#   ./hyrak_sim.sh stop       stops ONLY what this script started (PID files)
#   ./hyrak_sim.sh status
#
# Everything that bit us is pinned here, in one place:
#  - GZ_IP=127.0.0.1: gz-transport discovery on loopback, so a WiFi IP change
#    can no longer break the sim ("Network is unreachable" freeze).
#  - GZ_PARTITION=hyrak_demo + PX4 instance 1: never touches another session's
#    default gz/PX4 (instance 0, udp 14540). Fleet adopts this one on 14541.
#  - The gz server runs with hyrak_server.config = PX4's server.config minus
#    libGstCameraSystem.so: that PX4 system subscribes to the camera INSIDE the
#    server and hoards one raw frame per tick (~9 MB/s, OOM-killed at 22 GB
#    after ~40 min, on NVIDIA, Mesa and llvmpipe alike; PX4-Autopilot#27296).
#  - PX4 adopts an already-running world on its partition, so the server can
#    be started with our env and PX4 still applies its own server.config
#    (sensors). PX4_HOME_ALT=0 because the gz barometer is sea level.
#  - PX4_PARAM_RTL_RETURN_ALT=10: SITL params reset on every launch; this is
#    PX4's env override hook, so RTL stays at mission altitude.
#  - Camera -> H.265 RTP on 127.0.0.1:5600 and MAVLink -> udp:14550 (uplink
#    on 14551): the same ports and wire formats as the real air unit, so the
#    desktop app's "Air unit (UDP, direct)" telemetry and "Air unit (UDP)"
#    video sources work unchanged. No v4l2loopback, no browser capture.
#  - NEVER pattern-kills gz/px4: stop uses the PIDs it recorded.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PX4="${PX4_DIR:-$HOME/PX4-Autopilot}"
ROOTFS="$PX4/build/px4_sitl_default/rootfs"
LOGS="$HERE/.logs"; PIDS="$HERE/.pids"
WORLD="${WORLD:-hyrak_obstacles}"
MODEL="${MODEL:-gz_x500_mono_cam}"
HOME_LAT="${HOME_LAT:-17.596569}"; HOME_LON="${HOME_LON:-78.125203}"
CAM_TOPIC="/world/$WORLD/model/x500_mono_cam_1/link/camera_link/sensor/camera/image"

export GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_demo DISPLAY="${DISPLAY:-:1}"

_env() {  # PX4's gz_env.sh appends to these, so they must exist under set -u
    : "${GZ_SIM_RESOURCE_PATH:=}" "${GZ_SIM_SYSTEM_PLUGIN_PATH:=}"
    cd "$ROOTFS" && { . ./gz_env.sh 2>/dev/null || . ../gz_env.sh; }
}
_alive() { [ -f "$PIDS/$1" ] && kill -0 "$(cat "$PIDS/$1")" 2>/dev/null; }
_spawn() {  # name, then command
    local name=$1; shift
    nohup "$@" > "$LOGS/$name.log" 2>&1 &
    echo $! > "$PIDS/$name"
}

start() {
    mkdir -p "$LOGS" "$PIDS"; _env
    # PX4's server.config minus its GstCameraSystem: that system subscribes to
    # the camera inside the server and hoards every frame (see header).
    export GZ_SIM_SERVER_CONFIG_PATH="$HERE/hyrak_server.config"
    if _alive gz_server; then echo "already running (./hyrak_sim.sh status)"; return 0; fi
    _spawn gz_server gz sim --render-engine ogre2 --verbose=1 -r -s "$PX4_GZ_WORLDS/$WORLD.sdf"
    sleep 6
    [ -z "${HEADLESS:-}" ] && _spawn gz_gui gz sim --render-engine ogre2 -g
    _spawn px4 env PX4_SYS_AUTOSTART=4001 PX4_SIM_MODEL="$MODEL" PX4_GZ_WORLD="$WORLD" \
        PX4_HOME_LAT="$HOME_LAT" PX4_HOME_LON="$HOME_LON" PX4_HOME_ALT=0 \
        PX4_PARAM_RTL_RETURN_ALT=10 ../bin/px4 -i 1 -d
    for _ in $(seq 1 40); do grep -q "Ready for takeoff" "$LOGS/px4.log" 2>/dev/null && break; sleep 1; done
    # Look like the real air unit to the desktop app: MAVLink down to
    # udp:14550 (what "Air unit (UDP, direct)" binds), uplink accepted on
    # 14551 (where the desktop pins it, mirroring wfb_tx). The fleet link on
    # 14541 keeps working alongside - MAVLink is fine with two ground stations.
    ../bin/px4-mavlink --instance 1 start -x -u 14551 -o 14550 -t 127.0.0.1 -r 4000000 -f \
        > "$LOGS/px4_mavlink_airunit.log" 2>&1
    _spawn cam_bridge python3 "$HERE/gz_cam_bridge.py" "$CAM_TOPIC" 640x480 10 rtp://127.0.0.1:5600
    status
}

stop() {
    for n in cam_bridge px4 gz_gui gz_server; do
        if _alive "$n"; then kill "$(cat "$PIDS/$n")" 2>/dev/null; echo "stopped $n"; fi
        rm -f "$PIDS/$n"
    done
    sleep 2
    pkill -TERM -f "ffmpeg .* rtp://127.0.0.1:5600" 2>/dev/null || true   # the bridge's own encoder
}

status() {
    for n in gz_server gz_gui px4 cam_bridge; do
        if _alive "$n"; then
            printf "%-10s up   pid %s  rss %s MB\n" "$n" "$(cat "$PIDS/$n")" "$(( $(ps -o rss= -p "$(cat "$PIDS/$n")") / 1024 ))"
        else printf "%-10s down\n" "$n"; fi
    done
    grep -q "Ready for takeoff" "$LOGS/px4.log" 2>/dev/null && echo "PX4: Ready for takeoff (instance 1, fleet adopts udp:14541)"
    echo "video:     H.265 RTP -> 127.0.0.1:5600  (CAMERA -> 'Air unit (UDP) - set in Settings', port 5600)"
    echo "telemetry: MAVLink  -> 127.0.0.1:14550, uplink 14551  (TELEMETRY -> 'Air unit (UDP, direct)')"
}

case "${1:-}" in
    start) start ;; stop) stop ;; status) status ;;
    *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac

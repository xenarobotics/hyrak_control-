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
#  - PX4_PARAM_NAV_DLL_ACT=2: return when the ground-station link is lost. The
#    firmware default is 0 (do nothing), which the app's pre-flight failsafe
#    check refuses for cloud-flown aircraft (backend/app/telemetry/failsafe_check.py).
#  - Camera -> H.265 RTP on 127.0.0.1:5600, the real air unit's wire format,
#    read by the "Air unit (UDP)" video source. MAVLink -> udp:14540 for the
#    desktop's plain "SITL" source (reply-to-sender, QGC style) and udp:14600
#    for "Gazebo sim on server". No v4l2loopback, no browser capture.
#  - NEVER pattern-kills gz/px4: stop uses the PIDs it recorded.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PX4="${PX4_DIR:-$HOME/PX4-Autopilot}"
ROOTFS="$PX4/build/px4_sitl_default/rootfs"
LOGS="$HERE/.logs"; PIDS="$HERE/.pids"
MODEL="${MODEL:-gz_x500_mono_cam}"
# The indoor vehicle flies the indoor world unless told otherwise.
if [ "$MODEL" = "gz_x500_indoor" ]; then WORLD="${WORLD:-hyrak_indoor}"; else WORLD="${WORLD:-hyrak_obstacles}"; fi
HOME_LAT="${HOME_LAT:-17.596569}"; HOME_LON="${HOME_LON:-78.125203}"
# MODEL=gz_x500_depth (step A of docs/avoidance/ARCHITECTURE_REVIEW.md): PX4's
# x500 with an OAK-D Lite - a TRUE depth camera (73 deg, 19 m) that
# gz_depth_sensor.py feeds to avoidance as a range sensor, plus its 1080p RGB
# camera streamed (scaled to 640x360) as the video feed.
#
# MODEL=gz_x500_indoor: GPS-DENIED indoor flight, the way a real indoor PX4
# drone flies - on VISUAL ODOMETRY. Our model simulation/models/x500_indoor =
# x500 + gz OdometryPublisher (the VIO stand-in PX4's x500_vision uses) + a
# downward LW20 rangefinder + the same OAK-D Lite as x500_depth (so video,
# depth sensor and avoidance are identical). Airframe 4005 (gz_x500_vision)
# plus INDOOR_PARAMS below: GPS off, EKF2 on external vision (position,
# velocity, yaw, height), rangefinder aiding, magnetometer off (vision gives
# yaw), link loss -> Land (Return needs GPS). World:
# simulation/worlds/hyrak_indoor.sdf (rooms, corridor, ceiling).
# Not optical flow: PX4's libOpticalFlowSystem.so segfaults the gz server on
# this machine (it links sdformat14 AND sdformat15 - two Gazebo generations).
SERVER_CONFIG=hyrak_server.config
PX4_MODELS_DIR=""                      # empty: PX4's own models folder
INDOOR_PARAMS=()
if [ "$MODEL" = "gz_x500_depth" ]; then
    AUTOSTART=4002
    CAM_TOPIC="/world/$WORLD/model/x500_depth_1/link/camera_link/sensor/IMX214/image"
    CAM_IN=1920x1080; CAM_OUT=640x360
elif [ "$MODEL" = "gz_x500_indoor" ]; then
    AUTOSTART=4005
    CAM_TOPIC="/world/$WORLD/model/x500_indoor_1/link/camera_link/sensor/IMX214/image"
    CAM_IN=1920x1080; CAM_OUT=640x360
    # PX4 spawns file://$PX4_GZ_MODELS/<model>/model.sdf (px4-rc.gzsim) -
    # point it at our models for this one; its includes (x500, LW20,
    # OakD-Lite) resolve through GZ_SIM_RESOURCE_PATH as usual.
    PX4_MODELS_DIR="$HERE/models"
    # EKF2_EV_CTRL 15 = horizontal + vertical position, velocity, yaw;
    # EKF2_HGT_REF 3 = vision; EKF2_MAG_TYPE 5 = none; NAV_DLL_ACT 3 = Land.
    INDOOR_PARAMS=(PX4_PARAM_SYS_HAS_GPS=0 PX4_PARAM_SIM_GPS_USED=0 PX4_PARAM_EKF2_GPS_CTRL=0
                   PX4_PARAM_EKF2_EV_CTRL=15 PX4_PARAM_EKF2_HGT_REF=3 PX4_PARAM_EKF2_EV_DELAY=0
                   PX4_PARAM_EKF2_RNG_CTRL=1 PX4_PARAM_EKF2_MAG_TYPE=5 PX4_PARAM_SIM_GZ_EN_LIDAR=1
                   PX4_PARAM_NAV_DLL_ACT=3)
else
    AUTOSTART=4001
    CAM_TOPIC="/world/$WORLD/model/x500_mono_cam_1/link/camera_link/sensor/camera/image"
    CAM_IN=640x480; CAM_OUT=""
fi

export GZ_IP=127.0.0.1 GZ_PARTITION=hyrak_demo DISPLAY="${DISPLAY:-:1}"

_env() {  # PX4's gz_env.sh appends to these, so they must exist under set -u
    : "${GZ_SIM_RESOURCE_PATH:=}" "${GZ_SIM_SYSTEM_PLUGIN_PATH:=}"
    cd "$ROOTFS" && { . ./gz_env.sh 2>/dev/null || . ../gz_env.sh; }
    # Our own models/worlds first (x500_indoor, hyrak_indoor_assets); PX4's
    # stay on the path for everything else.
    export GZ_SIM_RESOURCE_PATH="$HERE/models:$HERE/worlds:$GZ_SIM_RESOURCE_PATH"
    # A world in simulation/worlds wins over PX4's of the same name.
    if [ -f "$HERE/worlds/$WORLD.sdf" ]; then WORLD_FILE="$HERE/worlds/$WORLD.sdf"; else WORLD_FILE="$PX4_GZ_WORLDS/$WORLD.sdf"; fi
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
    export GZ_SIM_SERVER_CONFIG_PATH="$HERE/$SERVER_CONFIG"
    if _alive gz_server; then echo "already running (./hyrak_sim.sh status)"; return 0; fi
    # Not running (or its server died): clear anything the last run left
    # behind BEFORE starting, or its bridges keep sending next to the new ones.
    _sweep
    _spawn gz_server gz sim --render-engine ogre2 --verbose=1 -r -s "$WORLD_FILE"
    sleep 6
    [ -z "${HEADLESS:-}" ] && _spawn gz_gui gz sim --render-engine ogre2 -g
    _spawn px4 env PX4_SYS_AUTOSTART="$AUTOSTART" PX4_SIM_MODEL="$MODEL" PX4_GZ_WORLD="$WORLD" \
        PX4_GZ_MODELS="${PX4_MODELS_DIR:-$PX4_GZ_MODELS}" \
        PX4_HOME_LAT="$HOME_LAT" PX4_HOME_LON="$HOME_LON" PX4_HOME_ALT=0 \
        PX4_PARAM_RTL_RETURN_ALT=10 PX4_PARAM_NAV_DLL_ACT=2 "${INDOOR_PARAMS[@]}" ../bin/px4 -i 1 -d
    for _ in $(seq 1 40); do grep -q "Ready for takeoff" "$LOGS/px4.log" 2>/dev/null && break; sleep 1; done
    # (PX4 SITL has 6 MAVLink channels; 0-4 are its own. The air-unit
    # emulation link (-u 14551 -o 14550) is therefore not started by default -
    # the desktop's plain "SITL" and "Gazebo sim on server" cover the sim.)
    # Plain "SITL" in the desktop app: its bridge binds udp:14540 (PX4
    # instance 0's port) and replies to whoever sends, QGC-style. Give this
    # instance-1 sim a link there too, so "SITL" just works.
    ../bin/px4-mavlink --instance 1 start -x -u 14590 -o 14540 -t 127.0.0.1 -r 4000000 -f \
        > "$LOGS/px4_mavlink_sitl14540.log" 2>&1
    # Server-side session link: the HYRAK "Gazebo sim on server" telemetry
    # source. 14600 on purpose: the fleet/swarm scanners probe 14541..14561
    # and adopted 14560 as a phantom "Drone 19".
    # binds udp:14600 IN THE BACKEND and talks to PX4 directly - no desktop
    # relay, no learned/pinned peer questions. PX4 sends here, MAVSDK replies
    # to the sender (14601).
    ../bin/px4-mavlink --instance 1 start -x -u 14601 -o 14600 -t 127.0.0.1 -r 4000000 -f \
        > "$LOGS/px4_mavlink_session.log" 2>&1
    _spawn cam_bridge python3 "$HERE/gz_cam_bridge.py" "$CAM_TOPIC" "$CAM_IN" 10 rtp://127.0.0.1:5600 $CAM_OUT
    if [ "$MODEL" = "gz_x500_depth" ] || [ "$MODEL" = "gz_x500_indoor" ]; then
        _spawn depth_sensor env WORLD="$WORLD" python3 "$HERE/gz_depth_sensor.py" auto
    fi
    status
}

stop() {
    for n in depth_sensor cam_bridge px4 gz_gui gz_server; do
        if _alive "$n"; then kill "$(cat "$PIDS/$n")" 2>/dev/null; echo "stopped $n"; fi
        rm -f "$PIDS/$n"
    done
    sleep 2
    _sweep
}

_sweep() {
    pkill -TERM -f "ffmpeg .* rtp://127.0.0.1:5600" 2>/dev/null || true   # the bridge's own encoder
    # Sweep OUR leftovers only: gz servers running our world file, PX4
    # instance 1, our bridges. A restart once left the previous gz server
    # alive (stale PID file) and PX4 saw sim time jump backwards; another left
    # the previous camera bridge running, so two streams shared udp:5600 and
    # the app decoded neither (2026-09-26 21:23).
    for pid in $(ps -eo pid,args | awk -v w="$WORLD.sdf" '!/bash|awk/ && (index($0, w) && /gz sim/ || /bin\/px4 -i 1 -d/ || /gz_cam_bridge/ || /gz_depth_sensor/) {print $1}'); do
        kill -9 "$pid" 2>/dev/null && echo "swept leftover $pid"
    done
}

status() {
    for n in gz_server gz_gui px4 cam_bridge depth_sensor; do
        if _alive "$n"; then
            printf "%-10s up   pid %s  rss %s MB\n" "$n" "$(cat "$PIDS/$n")" "$(( $(ps -o rss= -p "$(cat "$PIDS/$n")") / 1024 ))"
        else printf "%-10s down\n" "$n"; fi
    done
    grep -q "Ready for takeoff" "$LOGS/px4.log" 2>/dev/null && echo "PX4: Ready for takeoff (instance 1, fleet adopts udp:14541)"
    echo "video:     H.265 RTP -> 127.0.0.1:5600  (CAMERA -> 'Air unit (UDP) - set in Settings', port 5600)"
    echo "telemetry: TELEMETRY -> 'SITL' (desktop binds udp:14540)  or  'Gazebo sim on server' (udp:14600)"
    [ -f "$PIDS/depth_sensor" ] && echo "depth:     gz depth camera -> /api/avoidance/auto/depth_scan (log: $LOGS/depth_sensor.log)"
}

case "${1:-}" in
    start) start ;; stop) stop ;; status) status ;;
    *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac

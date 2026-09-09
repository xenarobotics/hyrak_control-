#!/usr/bin/env bash
# Headless swarm launcher - same as swarm.sh but WITHOUT the Gazebo GUI.
#
# Why: the GUI window costs a full CPU core and drags the simulation's
# real-time factor down (we measured RTF 0.05 with 3 drones + GUI). Low
# RTF makes drones look broken: EKF convergence takes minutes, MAVSDK
# logs endless "heartbeats timed out", drones crawl. Headless runs keep
# RTF near 1.0. Watch the drones on the platform map or QGC instead.
#
#   ./swarm_headless.sh          start 5 drones, no GUI
#   ./swarm_headless.sh 10       start 10 drones, no GUI
#   ./swarm.sh stop|status|rtf|heal    same as always
#
# To attach the GUI to an already-running headless world: gz sim -g

HEADLESS=1 exec "$(dirname "$0")/swarm.sh" start "${1:-5}"

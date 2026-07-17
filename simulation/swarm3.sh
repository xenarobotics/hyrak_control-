#!/usr/bin/env bash
# Launch a 3-drone swarm. Thin wrapper over swarm.sh — same stop/status/heal:
#   ./swarm3.sh            → start 3 drones
#   ./swarm.sh stop        → stop
exec "$(dirname "$0")/swarm.sh" start 3

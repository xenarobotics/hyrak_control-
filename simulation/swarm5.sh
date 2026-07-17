#!/usr/bin/env bash
# Launch a 5-drone swarm. Thin wrapper over swarm.sh — same stop/status/heal:
#   ./swarm5.sh            → start 5 drones
#   ./swarm.sh stop        → stop
exec "$(dirname "$0")/swarm.sh" start 5

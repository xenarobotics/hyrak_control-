#!/usr/bin/env bash
# Launch a 20-drone swarm. Thin wrapper over swarm.sh — same stop/status/heal:
#   ./swarm20.sh           → start 20 drones
#   ./swarm.sh stop        → stop
exec "$(dirname "$0")/swarm.sh" start 20

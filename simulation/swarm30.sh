#!/usr/bin/env bash
# Launch a 30-drone swarm. Thin wrapper over swarm.sh — same stop/status/heal:
#   ./swarm30.sh           → start 30 drones
#   ./swarm.sh stop        → stop
exec "$(dirname "$0")/swarm.sh" start 30

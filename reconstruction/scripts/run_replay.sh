#!/usr/bin/env bash
# Offline replay of a recording or image folder, in deterministic sequential mode.
#
#   scripts/run_replay.sh flight.mp4
#   scripts/run_replay.sh /path/to/frames/
#   VOXEL=0.02 SPLAT=1 scripts/run_replay.sh flight.mp4
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source .venv/bin/activate

SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: $0 <file.mp4|folder/>" >&2; exit 2; }
[ -e "$SRC" ] || { echo "not found: $SRC" >&2; exit 2; }

ARGS=(run -c configs/replay.yaml --uri "$SRC"
      --session "replay_$(basename "${SRC%.*}")" --save-keyframes)
[ -n "${VOXEL:-}" ] && ARGS+=(--voxel "$VOXEL")
[ -n "${SPLAT:-}" ] && ARGS+=(--splat)
[ -n "${TEXTURED:-}" ] && ARGS+=(--textured)

exec dronemap "${ARGS[@]}"

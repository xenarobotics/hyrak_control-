#!/usr/bin/env bash
# HYRAK 3D reconstruction engine (vendored dronemap) - environment bootstrap.
#
# This folder is the CANONICAL copy of the reconstruction engine; the ~/slam
# folder it was developed in is disposable scratch. The engine runs as a
# sidecar process per scan session, supervised by the platform backend
# (backend/app/reconstruction/service.py), never imported into the backend
# venv - its dependency stack is deliberately isolated here.
#
# Installs from requirements.lock: the EXACT versions of the proven working
# environment. Do not "pip install depth-anything-3" by hand into this venv -
# its conservative pins downgrade numpy and pull a duplicate opencv, breaking
# cupy and rerun (the lockfile already encodes the repaired, working state).
#
# Usage:  ./install.sh          creates .venv here and verifies the GPU stack
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${VENV:-$ROOT/.venv}"
PY="${PY:-python3}"

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v nvidia-smi >/dev/null || die "nvidia-smi not found; NVIDIA driver required."
command -v ffmpeg     >/dev/null || die "ffmpeg not found: sudo apt install ffmpeg"

log "Creating venv at $VENV"
[ -d "$VENV" ] || "$PY" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -q --upgrade pip wheel setuptools

log "Installing locked dependencies (torch wheels come from the cu128 index)"
# depth-anything-3 is installed separately with --no-deps: its published pins
# (numpy<2, plain opencv-python) contradict the WORKING environment this lock
# captures, and letting the resolver see them makes the whole install
# unsolvable. Its real runtime deps (torch/transformers/safetensors/...) are
# all in the lock already.
grep -v "^depth-anything-3" "$ROOT/requirements.lock" > /tmp/recon-req-$$.txt
pip install --extra-index-url https://download.pytorch.org/whl/cu128 \
    -r /tmp/recon-req-$$.txt
rm -f /tmp/recon-req-$$.txt

log "Installing depth-anything-3 (no-deps: see comment above)"
DA3_VER="$(grep '^depth-anything-3' "$ROOT/requirements.lock" || echo depth-anything-3)"
pip install --no-deps "${DA3_VER%%;*}"

log "Installing the engine itself (editable, no deps - the lock has them all)"
pip install -q --no-deps -e "$ROOT"

log "Verifying GPU stack"
python - <<'PYEOF'
import sys
ok = True
import torch
print(f"  torch      {torch.__version__}  cuda={torch.cuda.is_available()}")
if not torch.cuda.is_available():
    ok = False; print("  !! torch cannot see the GPU")
try:
    import cupy
    k = cupy.RawKernel(r'extern "C" __global__ void t(float* o){o[0]=1.0f;}', "t")
    o = cupy.zeros(1, cupy.float32); k((1,), (1,), (o,))
    assert float(o[0]) == 1.0
    print(f"  cupy       {cupy.__version__}  NVRTC ok")
except Exception as e:
    ok = False; print(f"  !! cupy/NVRTC unavailable -> TSDF falls back to CPU: {e}")
import numpy, scipy, cv2
print(f"  numpy      {numpy.__version__} (lock expects 2.5.x - a downgrade means")
print(f"             something reintroduced depth-anything-3's pins)")
sys.exit(0 if ok else 1)
PYEOF

log "Done. Engine venv ready at $VENV"

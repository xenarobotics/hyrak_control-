#!/usr/bin/env bash
# dronemap bootstrap. Ubuntu 24.04 / Python 3.12 / CUDA 12.x runtime.
# Ubuntu 24.04 is PEP-668 externally-managed, so a venv is mandatory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
PY="${PY:-python3}"

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v nvidia-smi >/dev/null || die "nvidia-smi not found; NVIDIA driver required."
command -v ffmpeg     >/dev/null || die "ffmpeg not found: sudo apt install ffmpeg"
ffmpeg -hide_banner -decoders 2>/dev/null | grep -q h264_cuvid \
  || log "WARNING: ffmpeg lacks h264_cuvid; ingest falls back to CPU decode."

log "Creating venv at $VENV"
[ -d "$VENV" ] || "$PY" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -q --upgrade pip wheel setuptools

log "Installing PyTorch (CUDA 12.8 wheels)"
pip install --index-url https://download.pytorch.org/whl/cu128 torch torchvision

log "Installing runtime dependencies"
pip install -e "$ROOT[all]"

log "Verifying GPU stack"
python - <<'PYEOF'
import sys
ok = True
import torch
print(f"  torch      {torch.__version__}  cuda={torch.cuda.is_available()}")
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    print(f"  gpu        {p.name}  {p.total_memory/2**30:.1f} GiB  sm_{p.major}{p.minor}")
else:
    ok = False; print("  !! torch cannot see the GPU")
try:
    import cupy, cupy.cuda.compiler as cc
    k = cupy.RawKernel(r'extern "C" __global__ void t(float* o){o[0]=1.0f;}', "t")
    o = cupy.zeros(1, cupy.float32); k((1,), (1,), (o,))
    assert float(o[0]) == 1.0
    print(f"  cupy       {cupy.__version__}  NVRTC ok (runtime kernel compile works)")
except Exception as e:
    ok = False; print(f"  !! cupy/NVRTC unavailable -> TSDF falls back to Open3D CPU: {e}")
for m in ("cv2", "open3d", "rerun", "trimesh", "scipy"):
    try:
        mod = __import__(m)
        print(f"  {m:<10} {getattr(mod,'__version__','?')}")
    except Exception as e:
        ok = False; print(f"  !! {m} import failed: {e}")
sys.exit(0 if ok else 1)
PYEOF

log "Done. Activate with:  source $VENV/bin/activate"

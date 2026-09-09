"""Optional lingbot-map backend.

lingbot-map (https://github.com/Robbyant/lingbot-map) is a feed-forward 3D
foundation model: it consumes a stream of images and emits per-frame pointmaps
and camera poses in one pass, with no iterative optimization. Where the classical
front-end in this repo estimates pose from tracked features and depth from a
separate network, lingbot-map produces both jointly, and its trajectory memory
handles long-range drift internally.

**It is deliberately optional and isolated.** Two reasons:

1. *Memory.* It is a large transformer with a paged KV cache over a long
   context. Its published ~20 FPS is on datacenter hardware; an RTX 4070 Laptop
   has 8 GB shared with the desktop, and this backend may need ``offload_to_cpu``
   and a reduced context, or may not fit at all. Nothing about the main pipeline
   should depend on that gamble.
2. *Dependencies.* It pins torch 2.8 + CUDA 12.8 and wants Kaolin and FlashInfer,
   which conflict with a general environment. Running it in its own virtualenv
   and talking to it over a socket is usually the sane deployment.

This adapter therefore implements the same `Tracker`/`DepthEstimator` interfaces
the rest of the pipeline uses, so it can be swapped in for benchmarking without
touching anything else, and its absence costs nothing.

Usage::

    pip install -e /path/to/lingbot-map          # in a separate venv, ideally
    dronemap run --uri clip.mp4 \\
        --set depth.backend=lingbot \\
        --set backends.lingbot.model_path=/path/to/lingbot-map.pt
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Optional

import numpy as np

from ...depth.base import DepthEstimator
from ...types import CameraIntrinsics, se3_inv

log = logging.getLogger(__name__)


class LingbotUnavailable(RuntimeError):
    """Raised when the backend cannot be initialised, with actionable detail."""


class LingbotBackend(DepthEstimator):
    """Runs lingbot-map as a joint depth + pose source."""

    metric = False   # pointmap models are scale-ambiguous without an anchor

    def __init__(self, cfg, model_path: Optional[str] = None,
                 offload_to_cpu: bool = True, num_scale_frames: int = 2) -> None:
        self.cfg = cfg
        self.model_path = model_path or getattr(cfg.depth, "lingbot_model_path", None)
        self.offload_to_cpu = offload_to_cpu
        self.num_scale_frames = num_scale_frames
        self._lock = threading.Lock()
        self._model = None
        self._state: Any = None
        self._frames_seen = 0
        self.last_pose: Optional[np.ndarray] = None
        self._load()

    def _load(self) -> None:
        try:
            import torch
        except ImportError as exc:
            raise LingbotUnavailable("torch is required") from exc
        try:
            import lingbot_map  # noqa: F401
        except ImportError as exc:
            raise LingbotUnavailable(
                "lingbot_map is not installed. Clone "
                "https://github.com/Robbyant/lingbot-map and `pip install -e .` "
                "into this environment (torch 2.8 + cu128), then retry."
            ) from exc

        if not self.model_path or not Path(self.model_path).exists():
            raise LingbotUnavailable(
                f"checkpoint not found: {self.model_path!r}. Download "
                "lingbot-map.pt (or lingbot-map-long.pt) from the project's "
                "HuggingFace/ModelScope release and pass its path."
            )

        free_gb = _free_vram_gb()
        if free_gb < 6.0:
            log.warning(
                "only %.1f GB of VRAM free. lingbot-map is a large transformer with "
                "a paged KV cache; expect to need offload_to_cpu and a reduced "
                "context, and expect OOM to remain possible.", free_gb,
            )

        from lingbot_map import load_model  # type: ignore[attr-defined]

        log.info("loading lingbot-map from %s (offload_to_cpu=%s)",
                 self.model_path, self.offload_to_cpu)
        self._model = load_model(self.model_path, offload_to_cpu=self.offload_to_cpu)
        log.info("lingbot-map ready")

    # -- DepthEstimator -----------------------------------------------------

    def predict(self, image: np.ndarray, intrinsics: Optional[CameraIntrinsics] = None,
                frame_index: Optional[int] = None) -> np.ndarray:
        """Depth for one frame, from the model's pointmap.

        The pose recovered alongside it is cached in ``last_pose`` so a caller
        acting as a tracker can pick it up without a second forward pass.
        """
        if self._model is None:
            raise LingbotUnavailable("model not loaded")
        with self._lock:
            out = self._step(image)
            self._frames_seen += 1

        pointmap = _as_numpy(out["pointmap"])          # (H, W, 3), camera frame
        depth = np.ascontiguousarray(pointmap[..., 2]).astype(np.float32)
        if "pose" in out:
            self.last_pose = _as_numpy(out["pose"]).reshape(4, 4).astype(np.float64)
        if "conf" in out:
            self.last_confidence = _as_numpy(out["conf"]).astype(np.float32)

        depth[~np.isfinite(depth)] = 0.0
        return np.clip(depth, 0.0, self.cfg.depth.max_depth_m * 4.0)

    def _step(self, image: np.ndarray) -> dict:
        """One streaming inference step, carrying the model's KV-cache state."""
        import torch

        with torch.inference_mode():
            tensor = torch.from_numpy(np.ascontiguousarray(image)).permute(2, 0, 1)
            tensor = tensor.unsqueeze(0).float().div_(255.0).cuda()
            result = self._model.step(tensor, state=self._state)
        if isinstance(result, tuple):
            out, self._state = result
        else:
            out, self._state = result, getattr(result, "state", self._state)
        return out if isinstance(out, dict) else {"pointmap": out}

    def warmup(self) -> None:
        dummy = np.zeros((self.cfg.source.track_height,
                          self.cfg.source.track_width, 3), np.uint8)
        try:
            self.predict(dummy)
        except Exception as exc:  # noqa: BLE001
            log.warning("lingbot-map warmup failed: %s", exc)

    def reset(self) -> None:
        """Clear streaming state, e.g. at the start of a new session."""
        self._state = None
        self._frames_seen = 0

    @property
    def vram_mb(self) -> float:
        try:
            import torch

            return torch.cuda.memory_allocated() / (1024**2)
        except Exception:  # noqa: BLE001
            return 0.0

    def close(self) -> None:
        self._model = None
        self._state = None
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass


def _as_numpy(x) -> np.ndarray:
    if hasattr(x, "detach"):
        return x.detach().float().cpu().numpy().squeeze()
    return np.asarray(x).squeeze()


def _free_vram_gb() -> float:
    try:
        import torch

        free, _total = torch.cuda.mem_get_info()
        return free / (1 << 30)
    except Exception:  # noqa: BLE001
        return 0.0


def try_build(cfg, **kwargs) -> Optional[LingbotBackend]:
    """Construct the backend, returning None (with a clear log) if unavailable.

    Callers use this rather than the constructor so an absent optional backend
    degrades to the default pipeline instead of aborting a flight.
    """
    try:
        return LingbotBackend(cfg, **kwargs)
    except LingbotUnavailable as exc:
        log.warning("lingbot-map backend unavailable: %s", exc)
        return None

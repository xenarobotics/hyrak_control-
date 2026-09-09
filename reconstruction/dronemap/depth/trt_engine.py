"""TensorRT depth backend: ONNX export, FP16 engine build, and inference.

Optional. The PyTorch path already runs Depth Anything V2 Small in about 8-10 ms
on this GPU, which fits comfortably at keyframe rate; TensorRT roughly halves
that and, more importantly, cuts the memory footprint, which matters when the
TSDF volume wants every megabyte it can get.

The engine is built once and cached, because building takes minutes. It is also
**hardware- and version-specific** -- a cached plan is not portable across GPUs
or TensorRT versions -- so the cache key records both and rebuilds on a mismatch
rather than failing at load time with an opaque deserialization error.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import Optional

import numpy as np

from ..types import CameraIntrinsics
from .base import DepthEstimator

log = logging.getLogger(__name__)


class TensorRTDepthEstimator(DepthEstimator):
    metric = True

    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self.dcfg = cfg.depth
        self.size = int(self.dcfg.input_size)
        self._lock = threading.Lock()
        self.metric = "metric" in self.dcfg.model.lower()

        import tensorrt as trt

        self.trt = trt
        self.logger = trt.Logger(trt.Logger.WARNING)
        engine_path = Path(self.dcfg.trt_engine_path)
        key = self._cache_key()
        if not self._engine_matches(engine_path, key):
            self._build(engine_path, key)
        self._load(engine_path)

    # -- cache identity -----------------------------------------------------

    def _cache_key(self) -> dict:
        import tensorrt as trt
        import torch

        return {
            "model": self.dcfg.model,
            "input_size": self.size,
            "fp16": bool(self.dcfg.fp16),
            "tensorrt": trt.__version__,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        }

    @staticmethod
    def _meta_path(engine_path: Path) -> Path:
        return engine_path.with_suffix(engine_path.suffix + ".json")

    def _engine_matches(self, engine_path: Path, key: dict) -> bool:
        meta = self._meta_path(engine_path)
        if not engine_path.exists() or not meta.exists():
            return False
        try:
            cached = json.loads(meta.read_text())
        except (OSError, json.JSONDecodeError):
            return False
        if cached != key:
            log.info("cached TensorRT engine does not match this configuration "
                     "(%s); rebuilding", _diff(cached, key))
            return False
        return True

    # -- build --------------------------------------------------------------

    def _build(self, engine_path: Path, key: dict) -> None:
        import torch
        from transformers import AutoModelForDepthEstimation

        engine_path.parent.mkdir(parents=True, exist_ok=True)
        onnx_path = engine_path.with_suffix(".onnx")

        log.info("exporting %s to ONNX (%dx%d)...", self.dcfg.model, self.size, self.size)
        model = AutoModelForDepthEstimation.from_pretrained(self.dcfg.model).eval().cuda()

        class Wrapper(torch.nn.Module):
            """Strips the HF output object down to a bare tensor for ONNX."""

            def __init__(self, m):
                super().__init__()
                self.m = m

            def forward(self, x):
                out = self.m(pixel_values=x).predicted_depth
                return out.unsqueeze(1) if out.ndim == 3 else out

        dummy = torch.zeros(1, 3, self.size, self.size, device="cuda")
        torch.onnx.export(
            Wrapper(model), dummy, str(onnx_path),
            input_names=["input"], output_names=["depth"],
            opset_version=17, do_constant_folding=True,
        )
        del model
        torch.cuda.empty_cache()

        log.info("building TensorRT engine (this takes a few minutes)...")
        trt = self.trt
        builder = trt.Builder(self.logger)
        network = builder.create_network(
            1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
        )
        parser = trt.OnnxParser(network, self.logger)
        if not parser.parse(onnx_path.read_bytes()):
            errors = "; ".join(str(parser.get_error(i)) for i in range(parser.num_errors))
            raise RuntimeError(f"ONNX parse failed: {errors}")

        config = builder.create_builder_config()
        config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE,
                                     self.dcfg.trt_workspace_mb * 1024 * 1024)
        if self.dcfg.fp16 and builder.platform_has_fast_fp16:
            config.set_flag(trt.BuilderFlag.FP16)

        plan = builder.build_serialized_network(network, config)
        if plan is None:
            raise RuntimeError("TensorRT engine build failed")
        engine_path.write_bytes(plan)
        self._meta_path(engine_path).write_text(json.dumps(key, indent=2))
        log.info("engine written to %s (%.1f MB)", engine_path,
                 engine_path.stat().st_size / 1e6)

    # -- runtime ------------------------------------------------------------

    def _load(self, engine_path: Path) -> None:
        import cupy as cp

        trt = self.trt
        runtime = trt.Runtime(self.logger)
        self.engine = runtime.deserialize_cuda_engine(engine_path.read_bytes())
        if self.engine is None:
            raise RuntimeError(f"could not deserialize {engine_path}")
        self.context = self.engine.create_execution_context()
        self.cp = cp

        self._in_name = self.engine.get_tensor_name(0)
        self._out_name = self.engine.get_tensor_name(1)
        out_shape = tuple(self.context.get_tensor_shape(self._out_name))
        self._d_in = cp.zeros((1, 3, self.size, self.size), cp.float32)
        self._d_out = cp.zeros(out_shape, cp.float32)
        self._stream = cp.cuda.Stream(non_blocking=True)
        self._mean = np.array([0.485, 0.456, 0.406], np.float32)
        self._std = np.array([0.229, 0.224, 0.225], np.float32)
        log.info("TensorRT depth engine ready (output %s)", out_shape)

    def predict(self, image: np.ndarray, intrinsics: Optional[CameraIntrinsics] = None,
                frame_index: Optional[int] = None) -> np.ndarray:
        import cv2

        cp = self.cp
        h, w = image.shape[:2]
        with self._lock:
            resized = cv2.resize(image, (self.size, self.size),
                                 interpolation=cv2.INTER_AREA)
            x = (resized.astype(np.float32) / 255.0 - self._mean) / self._std
            self._d_in.set(np.ascontiguousarray(x.transpose(2, 0, 1)[None]))

            self.context.set_tensor_address(self._in_name, int(self._d_in.data.ptr))
            self.context.set_tensor_address(self._out_name, int(self._d_out.data.ptr))
            self.context.execute_async_v3(self._stream.ptr)
            self._stream.synchronize()
            pred = cp.asnumpy(self._d_out).squeeze()

        depth = cv2.resize(pred.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
        if not self.metric:
            inv = depth - depth.min()
            inv /= max(float(inv.max()), 1e-6)
            depth = 1.0 / np.maximum(inv, 1e-3)
        depth[~np.isfinite(depth)] = 0.0
        return np.clip(depth, 0.0, self.dcfg.max_depth_m * 4.0)

    def warmup(self) -> None:
        dummy = np.zeros((self.size, self.size, 3), np.uint8)
        for _ in range(3):
            self.predict(dummy)

    @property
    def vram_mb(self) -> float:
        return (self._d_in.nbytes + self._d_out.nbytes) / (1024**2)

    def close(self) -> None:
        for attr in ("context", "engine", "_d_in", "_d_out"):
            if hasattr(self, attr):
                delattr(self, attr)


def _diff(a: dict, b: dict) -> str:
    return ", ".join(f"{k}: {a.get(k)!r} -> {b.get(k)!r}"
                     for k in set(a) | set(b) if a.get(k) != b.get(k))

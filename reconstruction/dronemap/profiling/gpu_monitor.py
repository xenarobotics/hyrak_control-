"""GPU and process telemetry via NVML.

Reports the numbers that matter on an 8 GB card: total VRAM in use across the
whole device (not just this process -- the compositor's share is what makes the
budget tight), this process's own usage, utilisation, temperature and the power
cap, which on a laptop GPU is usually the real throughput limit.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)


@dataclass
class GpuSample:
    t: float
    used_mb: float
    total_mb: float
    process_mb: float
    util_pct: float
    temp_c: float
    power_w: float
    power_limit_w: float

    @property
    def free_mb(self) -> float:
        return self.total_mb - self.used_mb


class GpuMonitor:
    def __init__(self, interval_s: float = 1.0, history: int = 3600) -> None:
        self.interval = interval_s
        self.samples: deque[GpuSample] = deque(maxlen=history)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._handle = None
        self._nvml = None
        self.available = False
        self.peak_used_mb = 0.0
        self.peak_process_mb = 0.0
        self._init_nvml()

    def _init_nvml(self) -> None:
        try:
            import pynvml
        except ImportError:
            try:
                from nvidia import ml as pynvml  # nvidia-ml-py exposes this name
            except ImportError:
                log.info("NVML unavailable; GPU profiling disabled")
                return
        try:
            pynvml.nvmlInit()
            self._nvml = pynvml
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(
                int(os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",")[0])
            )
            self.available = True
        except Exception as exc:  # noqa: BLE001
            log.info("NVML init failed (%s); GPU profiling disabled", exc)

    def sample(self) -> Optional[GpuSample]:
        if not self.available:
            return None
        p = self._nvml
        try:
            mem = p.nvmlDeviceGetMemoryInfo(self._handle)
            util = p.nvmlDeviceGetUtilizationRates(self._handle)
            try:
                temp = p.nvmlDeviceGetTemperature(self._handle, p.NVML_TEMPERATURE_GPU)
            except Exception:  # noqa: BLE001
                temp = 0.0
            try:
                power = p.nvmlDeviceGetPowerUsage(self._handle) / 1000.0
                limit = p.nvmlDeviceGetEnforcedPowerLimit(self._handle) / 1000.0
            except Exception:  # noqa: BLE001
                power = limit = 0.0

            proc_mb = 0.0
            try:
                pid = os.getpid()
                for pr in p.nvmlDeviceGetComputeRunningProcesses(self._handle):
                    if pr.pid == pid and pr.usedGpuMemory:
                        proc_mb = pr.usedGpuMemory / (1024**2)
            except Exception:  # noqa: BLE001
                pass

            s = GpuSample(
                t=time.monotonic(),
                used_mb=mem.used / (1024**2),
                total_mb=mem.total / (1024**2),
                process_mb=proc_mb,
                util_pct=float(util.gpu),
                temp_c=float(temp),
                power_w=power,
                power_limit_w=limit,
            )
            self.samples.append(s)
            self.peak_used_mb = max(self.peak_used_mb, s.used_mb)
            self.peak_process_mb = max(self.peak_process_mb, s.process_mb)
            return s
        except Exception as exc:  # noqa: BLE001
            log.debug("NVML sample failed: %s", exc)
            return None

    def start(self) -> None:
        if not self.available or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="gpu-monitor", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            self.sample()

    def stop(self) -> None:
        self._stop.set()

    @property
    def latest(self) -> Optional[GpuSample]:
        return self.samples[-1] if self.samples else None

    def summary(self) -> dict:
        s = self.latest
        if s is None:
            return {"available": False}
        return {
            "available": True,
            "used_mb": round(s.used_mb, 1),
            "free_mb": round(s.free_mb, 1),
            "total_mb": round(s.total_mb, 1),
            "process_mb": round(s.process_mb, 1),
            "peak_used_mb": round(self.peak_used_mb, 1),
            "peak_process_mb": round(self.peak_process_mb, 1),
            "util_pct": s.util_pct,
            "temp_c": s.temp_c,
            "power_w": round(s.power_w, 1),
            "power_limit_w": round(s.power_limit_w, 1),
        }

    def torch_summary(self) -> dict:
        """PyTorch allocator view -- distinguishes real use from cached blocks."""
        try:
            import torch

            if not torch.cuda.is_available():
                return {}
            return {
                "torch_allocated_mb": round(torch.cuda.memory_allocated() / 2**20, 1),
                "torch_reserved_mb": round(torch.cuda.memory_reserved() / 2**20, 1),
                "torch_max_allocated_mb": round(torch.cuda.max_memory_allocated() / 2**20, 1),
            }
        except Exception:  # noqa: BLE001
            return {}

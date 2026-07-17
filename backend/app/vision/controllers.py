"""Shared tracking controllers: PD, Kalman position filter, velocity smoother."""
import numpy as np
from typing import Dict, Optional, Tuple


class PDController:
    """
    Pure PD controller — no integral term.

    For drone tracking, integral causes windup: when the drone overshoots its target
    position and the error flips sign, the accumulated integral opposes the correction
    and the drone oscillates or never settles. PD is sufficient for visual tracking
    because the camera provides high-frequency feedback (30fps).
    """

    def __init__(self, kp: float, kd: float, max_output: float, deadband: float):
        self.kp = kp
        self.kd = kd
        self.max_output = max_output
        self.deadband = deadband
        self._prev_error = 0.0

    def compute(self, error: float) -> float:
        if abs(error) < self.deadband:
            # Inside deadband — zero both error and derivative to prevent
            # the derivative term from pulling the output while error is small
            self._prev_error = 0.0
            return 0.0
        derivative = error - self._prev_error
        output = self.kp * error + self.kd * derivative
        self._prev_error = error
        return float(np.clip(output, -self.max_output, self.max_output))

    def reset(self):
        self._prev_error = 0.0


# Keep the old name as an alias so nothing breaks if it's imported directly
PIDController = PDController


class KalmanXY:
    """
    Constant-velocity 2D Kalman filter for smoothing noisy bbox-center measurements.
    State vector: [x, y, vx, vy]
    """

    def __init__(
        self,
        process_noise: float = 4e-3,
        measurement_noise: float = 8e-3,
    ):
        self.F = np.eye(4, dtype=np.float64)
        self.F[0, 2] = 1.0
        self.F[1, 3] = 1.0
        self.H = np.zeros((2, 4), dtype=np.float64)
        self.H[0, 0] = 1.0
        self.H[1, 1] = 1.0
        self.Q = np.eye(4, dtype=np.float64) * process_noise
        self.R = np.eye(2, dtype=np.float64) * measurement_noise
        self.P = np.eye(4, dtype=np.float64) * 0.5
        self.x = np.zeros(4, dtype=np.float64)
        self._initialized = False

    def update(self, mx: float, my: float) -> Tuple[float, float]:
        if not self._initialized:
            self.x[:] = [mx, my, 0.0, 0.0]
            self._initialized = True
            return mx, my
        # Predict
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        # Update
        z = np.array([mx, my], dtype=np.float64)
        innov = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x += K @ innov
        self.P = (np.eye(4, dtype=np.float64) - K @ self.H) @ self.P
        return float(self.x[0]), float(self.x[1])

    def reset(self):
        self.P = np.eye(4, dtype=np.float64) * 0.5
        self.x = np.zeros(4, dtype=np.float64)
        self._initialized = False


class VelocitySmoother:
    """
    Exponential moving average over float fields of a velocity command dict.
    alpha=1.0 → no smoothing; alpha→0 → very smooth but laggy.
    """

    def __init__(self, alpha: float = 0.4):
        self.alpha = alpha
        self._prev: Optional[Dict] = None

    def smooth(self, cmd: Dict) -> Dict:
        if self._prev is None:
            self._prev = {k: v for k, v in cmd.items()}
            return cmd
        out: Dict = {}
        for k, v in cmd.items():
            if isinstance(v, float):
                out[k] = self.alpha * v + (1.0 - self.alpha) * self._prev.get(k, v)
            else:
                out[k] = v
        self._prev = out
        return out

    def reset(self):
        self._prev = None

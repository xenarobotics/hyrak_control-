"""Shared tracking controllers: PD, Kalman position filter, velocity smoother."""
import numpy as np
from typing import Dict, Optional, Tuple


class PDController:
    """
    Pure PD controller - no integral term.

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
            # Inside deadband - zero both error and derivative to prevent
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


# --------------------------------------------------------------------------- #
# Distance error                                                                #
# --------------------------------------------------------------------------- #

def range_error_ratio(target_size_ratio: float, actual_size_ratio: float) -> float:
    """
    Distance error as a FRACTION OF THE TARGET RANGE, from apparent size alone.

    Returns >0 when the subject is further away than wanted (close in), <0 when
    it is nearer than wanted (back off) - the same sign convention as the raw
    size difference it replaces.

    WHY NOT JUST (target - actual), WHICH IS WHAT THIS REPLACED
        Apparent size is proportional to 1/range, so a fixed difference in
        FILL FRACTION is a wildly different distance depending on how far away
        the subject already is. Measured on a 1.7m person, 70deg lens, with the
        0.04 deadband that difference was paired with:

            slant 8.6m  (25% fill)  ->  subject can move  1.4m before any reaction
            slant  25m  (8.6% fill) ->  subject can move 11.6m before any reaction
            slant  50m  (4.3% fill) ->  subject can move 46.3m before any reaction

        The dead zone grows as range SQUARED, so the controller is progressively
        blinder the further out it works - and at close range the same coarseness
        means a subject walking a metre toward the drone produces no response at
        all. Both were reported from real flights before this existed.

        The gain had the identical defect, plus an asymmetry nobody chose: with
        a 0.25 target, "too far" could never produce an error above 0.25 (fill
        cannot go below zero), capping forward pursuit at kp*0.25 while backward
        stayed unbounded. The drone backed off hard and chased weakly.

    THE FIX NEEDS NO CALIBRATION
        range is proportional to 1/size, so

            (range_now - range_target) / range_target  ==  (target - actual) / actual

        The unknown scale factor - subject height, focal length - cancels
        completely. A deadband on this is a PERCENTAGE of range, which means
        the same tolerance at every distance, and it works without anyone
        having measured the lens.
    """
    if actual_size_ratio <= 1e-6:
        # Subject has no measurable size - no range information at all. 0.0
        # rather than a huge number: withholding a command is correct here,
        # and dividing by a near-zero size would fabricate a violent one.
        return 0.0
    return (target_size_ratio - actual_size_ratio) / actual_size_ratio

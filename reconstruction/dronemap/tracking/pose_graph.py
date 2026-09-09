"""SE(3) pose-graph optimization for loop closure.

Given relative-pose constraints -- sequential odometry edges plus the loop edges
found by place recognition -- redistribute accumulated drift over the whole
trajectory so the loop actually closes.

Gauss-Newton on the manifold with a right perturbation ``T <- T exp(d)``. For an
edge (i, j) with measurement ``Z``::

    A = T_i^-1 T_j          (what the current estimate says)
    e = log(Z^-1 A)         (6-vector residual)
    de/dd_j = I
    de/dd_i = -Adj(A^-1)

The right-Jacobian ``J_r^-1(e)`` is approximated by the identity, which is the
standard practical choice: it is exact in the limit and the iteration converges
to the same minimum, since the residual -- not the Jacobian -- defines it.

The system is sparse (each edge touches two nodes), so it is assembled in COO
form and solved with a sparse Cholesky-style factorisation. A trajectory with
thousands of keyframes stays well inside interactive time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

from ..types import se3_exp, se3_inv, se3_log, skew

log = logging.getLogger(__name__)


def adjoint(T: np.ndarray) -> np.ndarray:
    """SE(3) adjoint for twist ordering [rho, phi] -> 6x6."""
    R, t = T[:3, :3], T[:3, 3]
    A = np.zeros((6, 6))
    A[:3, :3] = R
    A[:3, 3:] = skew(t) @ R
    A[3:, 3:] = R
    return A


@dataclass
class PoseGraphEdge:
    i: int
    j: int
    #: Measured relative transform T_i^-1 T_j.
    T_ij: np.ndarray
    #: 6x6 information matrix. Loop edges are usually weighted below odometry
    #: edges, because a wrong loop closure is far more destructive than drift.
    information: np.ndarray = field(default_factory=lambda: np.eye(6))
    is_loop: bool = False


@dataclass
class PoseGraphResult:
    poses: dict[int, np.ndarray]
    initial_error: float
    final_error: float
    iterations: int
    converged: bool


class PoseGraph:
    def __init__(self) -> None:
        self.nodes: dict[int, np.ndarray] = {}  # kf_id -> T_wc
        self.edges: list[PoseGraphEdge] = []

    def add_node(self, kf_id: int, T_wc: np.ndarray) -> None:
        self.nodes[int(kf_id)] = np.asarray(T_wc, dtype=np.float64)

    def add_edge(
        self, i: int, j: int, T_ij: np.ndarray,
        information: Optional[np.ndarray] = None, is_loop: bool = False,
    ) -> None:
        self.edges.append(
            PoseGraphEdge(int(i), int(j), np.asarray(T_ij, float),
                          np.eye(6) if information is None else information, is_loop)
        )

    def add_odometry_chain(self, kf_ids: list[int], poses: dict[int, np.ndarray],
                           information: Optional[np.ndarray] = None) -> None:
        """Add sequential edges from the current (drifted) pose estimates."""
        for a, b in zip(kf_ids[:-1], kf_ids[1:]):
            if a in poses and b in poses:
                self.add_edge(a, b, se3_inv(poses[a]) @ poses[b], information)

    def optimize(
        self, iterations: int = 25, fixed: Optional[set[int]] = None,
        tolerance: float = 1e-9, huber_delta: float = 0.0,
    ) -> PoseGraphResult:
        ids = sorted(self.nodes)
        if len(ids) < 2 or not self.edges:
            return PoseGraphResult(dict(self.nodes), 0.0, 0.0, 0, True)

        index = {kf: k for k, kf in enumerate(ids)}
        n = len(ids)
        poses = {kf: self.nodes[kf].copy() for kf in ids}
        # Anchor the gauge: without a fixed node the whole trajectory can drift
        # rigidly and the normal equations are singular.
        fixed = {ids[0]} if not fixed else set(fixed)
        fixed_dofs = np.zeros(6 * n, bool)
        for kf in fixed:
            if kf in index:
                fixed_dofs[6 * index[kf]: 6 * index[kf] + 6] = True

        initial_error = self._total_error(poses)
        prev_error = initial_error
        converged = False
        it = 0

        for it in range(iterations):
            rows, cols, vals = [], [], []
            b = np.zeros(6 * n)

            for e in self.edges:
                if e.i not in index or e.j not in index:
                    continue
                ii, jj = index[e.i], index[e.j]
                A = se3_inv(poses[e.i]) @ poses[e.j]
                err = se3_log(se3_inv(e.T_ij) @ A)

                J_i = -adjoint(se3_inv(A))
                J_j = np.eye(6)

                omega = e.information
                if huber_delta > 0:
                    # Robustify: a single bad loop closure would otherwise drag
                    # the entire trajectory with it.
                    norm = float(np.sqrt(err @ omega @ err))
                    if norm > huber_delta:
                        omega = omega * (huber_delta / norm)

                blocks = ((J_i, ii), (J_j, jj))
                for Ja, ia in blocks:
                    b[6 * ia: 6 * ia + 6] += Ja.T @ omega @ err
                    for Jb, ib in blocks:
                        H_blk = Ja.T @ omega @ Jb
                        r_idx = np.repeat(np.arange(6 * ia, 6 * ia + 6), 6)
                        c_idx = np.tile(np.arange(6 * ib, 6 * ib + 6), 6)
                        rows.append(r_idx)
                        cols.append(c_idx)
                        vals.append(H_blk.reshape(-1))

            r = np.concatenate(rows)
            c = np.concatenate(cols)
            v = np.concatenate(vals)

            # Apply the gauge fix by dropping every entry in a fixed row or
            # column and putting 1 on those diagonals. Doing it at assembly time
            # keeps H symmetric and avoids an expensive LIL round-trip.
            keep = ~(fixed_dofs[r] | fixed_dofs[c])
            r, c, v = r[keep], c[keep], v[keep]
            diag = np.arange(6 * n)
            # Levenberg damping stabilises weakly-connected graphs; fixed DOFs
            # get a unit diagonal so their equation reads dx = 0.
            damp = np.where(fixed_dofs, 1.0, 1e-6)
            H = sp.coo_matrix(
                (np.concatenate([v, damp]), (np.concatenate([r, diag]),
                                             np.concatenate([c, diag]))),
                shape=(6 * n, 6 * n),
            ).tocsc()
            b[fixed_dofs] = 0.0

            try:
                dx = spla.spsolve(H, -b)
            except Exception as exc:  # noqa: BLE001
                log.warning("pose graph solve failed at iter %d: %s", it, exc)
                break
            if not np.all(np.isfinite(dx)):
                log.warning("pose graph produced a non-finite step")
                break

            for kf in ids:
                if kf in fixed:
                    continue
                k = index[kf]
                poses[kf] = poses[kf] @ se3_exp(dx[6 * k: 6 * k + 6])

            err_now = self._total_error(poses)
            if abs(prev_error - err_now) < tolerance * max(prev_error, 1.0):
                prev_error = err_now
                converged = True
                break
            prev_error = err_now

        self.nodes = poses
        return PoseGraphResult(poses, initial_error, prev_error, it + 1, converged)

    def _total_error(self, poses: dict[int, np.ndarray]) -> float:
        total = 0.0
        for e in self.edges:
            if e.i in poses and e.j in poses:
                err = se3_log(se3_inv(e.T_ij) @ se3_inv(poses[e.i]) @ poses[e.j])
                total += float(err @ e.information @ err)
        return 0.5 * total

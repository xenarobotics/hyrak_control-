"""Loop closure: place recognition, geometric verification, relocalization.

Detection is a bag-of-binary-words model over ORB descriptors with an
**online-built vocabulary**. Shipping a pre-trained vocabulary file (the DBoW2
approach) would mean a large binary blob and a domain mismatch the first time
this flies somewhere that does not look like the training set. Instead the
vocabulary is sampled from the session's own early keyframes, which adapts to
whatever the drone is actually looking at.

Detection alone is never trusted. A false loop closure is far more destructive
than uncorrected drift -- it folds unrelated parts of the map onto each other
irreversibly -- so every candidate must pass:

1. bag-of-words similarity above threshold, normalised against the score of
   neighbouring keyframes (a revisit should look more like the old place than
   the current place looks like its own neighbours),
2. temporal separation (no closing against a keyframe from two seconds ago),
3. descriptor matching with Lowe's ratio test,
4. geometric verification by RANSAC PnP using the candidate's depth,
5. a bounded relative-pose correction.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from ..config import Config
from ..types import Keyframe, se3_inv, pose_distance

log = logging.getLogger(__name__)


@dataclass
class LoopCandidate:
    query_kf: int
    match_kf: int
    score: float
    n_matches: int = 0
    n_inliers: int = 0
    T_ij: Optional[np.ndarray] = None  # verified relative pose T_match^-1 T_query
    verified: bool = False


class BagOfWords:
    """Online binary bag-of-words index over ORB descriptors."""

    def __init__(self, vocab_size: int = 512, seed: int = 0) -> None:
        self.vocab_size = vocab_size
        self._rng = np.random.default_rng(seed)
        self._vocab: Optional[np.ndarray] = None  # (V,32) uint8
        self._vocab_bits: Optional[np.ndarray] = None  # (V,256) uint8 unpacked
        self._vocab_bits_f: Optional[np.ndarray] = None  # float32, for BLAS
        self._vocab_rowsum: Optional[np.ndarray] = None
        self._pool: list[np.ndarray] = []
        #: Keyframes that arrived before the vocabulary existed. They must be
        #: indexed retroactively -- these are the *earliest* keyframes, and they
        #: are precisely what a loop closure needs to match against. Dropping
        #: them makes the start of every trajectory permanently unrecognisable,
        #: so loops silently never close.
        self._pending: list[tuple[int, np.ndarray]] = []
        self._hists: dict[int, np.ndarray] = {}
        self._doc_freq: Optional[np.ndarray] = None
        self._n_docs = 0

    @property
    def ready(self) -> bool:
        return self._vocab is not None

    def add_training(self, descriptors: np.ndarray) -> None:
        """Pool descriptors until there are enough to seed a vocabulary."""
        if self._vocab is not None or descriptors is None or not len(descriptors):
            return
        take = min(len(descriptors), 200)
        idx = self._rng.choice(len(descriptors), take, replace=False)
        self._pool.append(descriptors[idx])
        total = sum(len(p) for p in self._pool)
        if total >= self.vocab_size * 4:
            self._build_vocab()

    def _build_vocab(self) -> None:
        """Pick vocabulary words by farthest-point sampling in Hamming space.

        Proper k-medoids would be better but costs far more; farthest-point
        sampling gives well-separated words in one pass, which is what matters
        for discriminative histograms.
        """
        pool = np.concatenate(self._pool)
        if len(pool) > 20000:
            pool = pool[self._rng.choice(len(pool), 20000, replace=False)]
        bits = np.unpackbits(pool, axis=1).astype(np.int16)

        n_words = min(self.vocab_size, len(pool))
        chosen = [int(self._rng.integers(len(pool)))]
        min_dist = _hamming_to(bits, bits[chosen[0]])
        for _ in range(1, n_words):
            nxt = int(np.argmax(min_dist))
            chosen.append(nxt)
            np.minimum(min_dist, _hamming_to(bits, bits[nxt]), out=min_dist)

        self._vocab = pool[chosen]
        self._vocab_bits = np.unpackbits(self._vocab, axis=1).astype(np.int16)
        # Float copy for describe(): integer matmuls bypass BLAS entirely and
        # cost ~96 ms per call (profiled -- the single largest mapper expense,
        # bigger than bundle adjustment). The float32 sgemm form is ~1 ms.
        self._vocab_bits_f = self._vocab_bits.astype(np.float32)
        self._vocab_rowsum = self._vocab_bits_f.sum(axis=1)
        self._doc_freq = np.zeros(len(self._vocab), np.float64)
        self._pool.clear()
        log.info("bag-of-words vocabulary built: %d words", len(self._vocab))

        backlog, self._pending = self._pending, []
        for kf_id, desc in backlog:
            self.add(kf_id, desc)
        if backlog:
            log.info("indexed %d keyframes retroactively", len(backlog))

    def describe(self, descriptors: np.ndarray) -> Optional[np.ndarray]:
        """L2-normalised word histogram for one image."""
        if self._vocab_bits is None or descriptors is None or not len(descriptors):
            return None
        bits = np.unpackbits(descriptors, axis=1).astype(np.float32)
        # Hamming distance via one BLAS sgemm: ||a-b||_H = sum(a) + sum(b)
        # - 2 a.b for binary vectors. The old int16 matmul computed the same
        # thing without BLAS at ~100x the cost.
        dist = (self._vocab_rowsum[None, :] + bits.sum(axis=1, keepdims=True)
                - 2.0 * (bits @ self._vocab_bits_f.T))
        words = np.argmin(dist, axis=1)
        hist = np.bincount(words, minlength=len(self._vocab)).astype(np.float64)
        n = np.linalg.norm(hist)
        return hist / n if n > 0 else hist

    def add(self, kf_id: int, descriptors: np.ndarray) -> None:
        if not self.ready:
            if descriptors is not None and len(descriptors):
                self._pending.append((int(kf_id), descriptors))
            return
        hist = self.describe(descriptors)
        if hist is None:
            return
        self._hists[int(kf_id)] = hist
        self._doc_freq += (hist > 0).astype(np.float64)
        self._n_docs += 1

    def query(self, kf_id: int, exclude_after: int, top_k: int = 5
              ) -> list[tuple[int, float]]:
        """Most similar earlier keyframes, tf-idf weighted cosine similarity."""
        q = self._hists.get(int(kf_id))
        if q is None or self._n_docs < 2:
            return []
        idf = np.log(self._n_docs / np.maximum(self._doc_freq, 1.0)) + 1e-6
        qw = q * idf
        qn = np.linalg.norm(qw)
        if qn < 1e-12:
            return []
        qw = qw / qn
        scored = []
        for other, h in self._hists.items():
            if other >= exclude_after:
                continue
            hw = h * idf
            hn = np.linalg.norm(hw)
            if hn < 1e-12:
                continue
            scored.append((other, float(qw @ (hw / hn))))
        scored.sort(key=lambda kv: -kv[1])
        return scored[:top_k]

    def neighbour_score(self, kf_id: int, window: int = 3) -> float:
        """Similarity to temporally adjacent keyframes.

        Used as a normaliser: a genuine revisit should score at least as high as
        consecutive frames of the same scene do, and this baseline shifts a lot
        between a textureless corridor and a cluttered room.
        """
        q = self._hists.get(int(kf_id))
        if q is None:
            return 1.0
        scores = [
            float(q @ self._hists[n])
            for n in range(int(kf_id) - window, int(kf_id))
            if n in self._hists
        ]
        return max(float(np.mean(scores)), 1e-6) if scores else 1.0


def _hamming_to(bits: np.ndarray, word_bits: np.ndarray) -> np.ndarray:
    return np.abs(bits - word_bits[None, :]).sum(axis=1).astype(np.int32)


class LoopCloser:
    """Detects and verifies revisits; also serves as the relocalizer."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.lc = cfg.loop
        self.bow = BagOfWords(self.lc.vocab_size, seed=cfg.seed)
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
        self.accepted: list[LoopCandidate] = []
        self.rejected = 0
        self.relocs = 0
        #: add_keyframe runs on the mapper thread; relocalize on the tracker
        #: thread. The lock covers the BoW index (vocab build + histogram
        #: writes vs. the relocalizer's read of the same structures).
        self._bow_lock = threading.Lock()

    def add_keyframe(self, kf: Keyframe) -> None:
        if kf.descriptors is None or not len(kf.descriptors):
            return
        with self._bow_lock:
            self.bow.add_training(kf.descriptors)
            # Always call add(): before the vocabulary exists it queues the
            # keyframe, and building the vocabulary flushes the queue.
            self.bow.add(kf.kf_id, kf.descriptors)

    def detect(self, kf: Keyframe, keyframes: dict[int, Keyframe]) -> Optional[LoopCandidate]:
        """Find and verify a loop closure for this keyframe, if one exists."""
        if not self.lc.enabled or not self.bow.ready:
            return None
        cutoff = kf.kf_id - self.lc.min_kf_gap
        if cutoff <= 0:
            return None

        baseline = self.bow.neighbour_score(kf.kf_id)
        for match_id, score in self.bow.query(kf.kf_id, exclude_after=cutoff, top_k=5):
            # Normalising against the local baseline is what makes one threshold
            # work in both a bland corridor and a cluttered room.
            if score < self.lc.match_threshold or score < self.lc.baseline_ratio * baseline:
                continue
            other = keyframes.get(match_id)
            if other is None:
                continue
            cand = self._verify(kf, other, score)
            if cand.verified:
                self.accepted.append(cand)
                log.info("loop closure %d -> %d (score %.3f, %d inliers)",
                         kf.kf_id, match_id, score, cand.n_inliers)
                return cand
            self.rejected += 1
        return None

    def _verify(self, query: Keyframe, match: Keyframe, score: float) -> LoopCandidate:
        """Geometric verification by PnP against the matched keyframe's depth."""
        cand = LoopCandidate(query.kf_id, match.kf_id, score)
        # Loop closures deliberately target OLD keyframes, which are exactly
        # the ones whose payloads spill to disk; reload for the check.
        was_spilled = match.image is None and match.spill_path is not None
        if was_spilled:
            match.load_payload()
        try:
            return self._verify_loaded(query, match, cand)
        finally:
            if was_spilled:
                match.drop_payload()

    def _verify_loaded(self, query: Keyframe, match: Keyframe,
                       cand: LoopCandidate) -> LoopCandidate:
        if (query.descriptors is None or match.descriptors is None
                or match.depth is None or query.keypoints is None
                or match.keypoints is None):
            return cand

        pairs = self._match_descriptors(query.descriptors, match.descriptors)
        cand.n_matches = len(pairs)
        if len(pairs) < self.lc.min_inliers:
            return cand

        qi, mi = pairs[:, 0], pairs[:, 1]
        n_q, n_m = len(query.keypoints), len(match.keypoints)
        ok = (qi < n_q) & (mi < n_m)
        qi, mi = qi[ok], mi[ok]
        if len(qi) < self.lc.min_inliers:
            return cand

        # 3D points from the *matched* keyframe, observed in the query image.
        K = match.intrinsics
        px_m = match.keypoints[mi]
        h, w = match.depth.shape[:2]
        xs = np.clip(np.round(px_m[:, 0]).astype(int), 0, w - 1)
        ys = np.clip(np.round(px_m[:, 1]).astype(int), 0, h - 1)
        d = match.depth[ys, xs]
        valid = (d > self.cfg.depth.min_depth_m) & (d < self.cfg.depth.max_depth_m)
        if valid.sum() < self.lc.min_inliers:
            return cand

        x = (px_m[valid, 0] - K.cx) / K.fx * d[valid]
        y = (px_m[valid, 1] - K.cy) / K.fy * d[valid]
        pts_match_cam = np.stack([x, y, d[valid]], axis=1).astype(np.float64)
        px_q = query.keypoints[qi[valid]].astype(np.float64)

        try:
            ok_pnp, rvec, tvec, inl = cv2.solvePnPRansac(
                pts_match_cam, px_q, query.intrinsics.K, None,
                iterationsCount=300, reprojectionError=self.lc.ransac_threshold_px,
                confidence=0.995, flags=cv2.SOLVEPNP_ITERATIVE,
            )
        except cv2.error:
            return cand
        if not ok_pnp or inl is None:
            return cand

        cand.n_inliers = len(inl)
        if len(inl) < self.lc.min_inliers:
            return cand

        # PnP returns the query camera's pose in the matched camera's frame,
        # which is exactly the relative constraint the pose graph wants.
        T_query_from_match = np.eye(4)
        T_query_from_match[:3, :3], _ = cv2.Rodrigues(rvec)
        T_query_from_match[:3, 3] = tvec.reshape(3)
        cand.T_ij = se3_inv(T_query_from_match)

        # Sanity bound: a "loop closure" implying a 100 m jump is a mismatch.
        implied = se3_inv(match.T_wc) @ query.T_wc
        trans_now, rot_now = pose_distance(implied, cand.T_ij)
        scene = max(match.median_depth(), 1.0)
        if trans_now > 3.0 * scene or rot_now > 60.0:
            log.debug("loop %d->%d rejected: implausible correction (%.1f m, %.1f deg)",
                      query.kf_id, match.kf_id, trans_now, rot_now)
            return cand

        cand.verified = True
        return cand

    def _match_descriptors(self, da: np.ndarray, db: np.ndarray) -> np.ndarray:
        """Lowe ratio test over kNN Hamming matches -> Nx2 index pairs."""
        if da is None or db is None or len(da) < 2 or len(db) < 2:
            return np.empty((0, 2), np.int32)
        knn = self.matcher.knnMatch(da, db, k=2)
        pairs = [
            (m.queryIdx, m.trainIdx)
            for pair in knn
            if len(pair) == 2
            for m, n in [pair]
            if m.distance < 0.75 * n.distance
        ]
        return np.array(pairs, np.int32) if pairs else np.empty((0, 2), np.int32)

    # -- relocalization -----------------------------------------------------

    def relocalize(
        self, descriptors: np.ndarray, keypoints: np.ndarray,
        keyframes: dict[int, Keyframe], intrinsics,
        T_pred: Optional[np.ndarray] = None,
        T_loss: Optional[np.ndarray] = None,
        max_jump_m: Optional[float] = None,
        max_rot_deg: Optional[float] = None,
    ) -> Optional[tuple[np.ndarray, int, np.ndarray, np.ndarray]]:
        """Recover a world pose for a lost frame.

        Returns ``(T_wc, kf_id, matched_pixels, world_points)`` or None, where
        ``matched_pixels`` (N,2) are PnP-inlier pixel observations in the lost
        frame and ``world_points`` (N,3) their 3D positions lifted from the
        anchor keyframe's depth. The caller seeds these as landmarks so the
        tracker has something to track against on the very next frame --
        adopting the pose alone leaves it with zero landmarks and it re-loses
        immediately.

        Relocalization is NOT the kidnapped-robot problem: the camera was
        tracking moments ago, so physics bounds where it can be now. ``T_pred``
        (the dead-reckoned pose) orders candidates nearest-first; ``T_loss``
        (the last PnP-locked pose) anchors the plausibility gate: a solution
        further than ``max_jump_m`` from where tracking was lost is rejected.
        The translation gate anchors at the loss pose rather than the
        prediction because the frozen-velocity extrapolation wanders
        arbitrarily far on curved motion, while actual travel from the loss
        point is bounded by real camera speed. The ROTATION gate
        (``max_rot_deg``, against ``T_pred``) is the decisive one: appearance
        + PnP alone will confidently relocalize onto the wrong wall of a
        self-similar scene, and the wrong mode can even sit CLOSE to the loss
        point -- but it always demands an implausible orientation. Measured on
        the synthetic room: correct relocs land within ~14 deg of the
        constant-angular-velocity prediction, wrong-wall modes at ~124 deg.
        A falsely rejected true recovery just retries a few frames later, so
        the gates fail safe.

        Called from the tracker thread while the mapper thread may be indexing
        new keyframes; the BoW read happens under the lock.
        """
        if descriptors is None or not len(descriptors):
            return None
        with self._bow_lock:
            ready = self.bow.ready
            hist = self.bow.describe(descriptors) if ready else None
            hists = list(self.bow._hists.items()) if hist is not None else []

        if hists:
            scored = sorted(
                ((kid, float(hist @ h)) for kid, h in hists),
                key=lambda kv: -kv[1],
            )[:8]
        else:
            # No vocabulary yet -- a short session, or loss before enough
            # keyframes accumulated to build one. That is exactly when the map
            # is small enough to brute-force: try the most recent keyframes
            # directly. Geometric PnP verification below still gates matches,
            # so this loses ranking quality, not safety.
            scored = [(kid, 0.0) for kid in sorted(keyframes)[:-9:-1]]

        if T_pred is not None:
            # Appearance shortlists; the motion prior ranks. Anchors near the
            # predicted pose get tried first, which picks the right mode of a
            # self-similar scene before the wrong one gets a chance to pass PnP.
            p = np.asarray(T_pred)[:3, 3]

            def _anchor_dist(kv):
                kf = keyframes.get(kv[0])
                return (np.linalg.norm(kf.T_wc[:3, 3] - p)
                        if kf is not None else np.inf)

            scored = sorted(scored, key=_anchor_dist)

        for kf_id, score in scored:
            kf = keyframes.get(kf_id)
            if kf is None or kf.descriptors is None:
                continue
            was_spilled = kf.image is None and kf.spill_path is not None
            if was_spilled:
                kf.load_payload()
            try:
                result = self._try_anchor(kf, kf_id, score, descriptors,
                                          keypoints, intrinsics,
                                          T_pred, T_loss, max_jump_m, max_rot_deg)
            finally:
                if was_spilled:
                    kf.drop_payload()
            if result is not None:
                return result
        return None

    def _try_anchor(
        self, kf: Keyframe, kf_id: int, score: float,
        descriptors: np.ndarray, keypoints: np.ndarray, intrinsics,
        T_pred, T_loss, max_jump_m, max_rot_deg,
    ) -> Optional[tuple[np.ndarray, int, np.ndarray, np.ndarray]]:
        """PnP + plausibility gates against one candidate anchor keyframe."""
        if kf.depth is None:
            return None
        pairs = self._match_descriptors(descriptors, kf.descriptors)
        if len(pairs) < self.lc.min_inliers:
            return None
        qi, mi = pairs[:, 0], pairs[:, 1]
        ok = (qi < len(keypoints)) & (mi < len(kf.keypoints))
        qi, mi = qi[ok], mi[ok]
        if len(qi) < self.lc.min_inliers:
            return None

        K = kf.intrinsics
        px = kf.keypoints[mi]
        h, w = kf.depth.shape[:2]
        xs = np.clip(np.round(px[:, 0]).astype(int), 0, w - 1)
        ys = np.clip(np.round(px[:, 1]).astype(int), 0, h - 1)
        d = kf.depth[ys, xs]
        valid = (d > self.cfg.depth.min_depth_m) & (d < self.cfg.depth.max_depth_m)
        if valid.sum() < self.lc.min_inliers:
            return None
        cam = np.stack([
            (px[valid, 0] - K.cx) / K.fx * d[valid],
            (px[valid, 1] - K.cy) / K.fy * d[valid],
            d[valid],
        ], axis=1)
        world = cam @ kf.T_wc[:3, :3].T + kf.T_wc[:3, 3]
        obs = keypoints[qi[valid]].astype(np.float64)
        try:
            ok_pnp, rvec, tvec, inl = cv2.solvePnPRansac(
                world.astype(np.float64), obs, intrinsics.K, None,
                iterationsCount=400, reprojectionError=self.lc.ransac_threshold_px,
                confidence=0.995, flags=cv2.SOLVEPNP_ITERATIVE,
            )
        except cv2.error:
            return None
        if not ok_pnp or inl is None or len(inl) < self.lc.min_inliers:
            return None
        T_cw = np.eye(4)
        T_cw[:3, :3], _ = cv2.Rodrigues(rvec)
        T_cw[:3, 3] = tvec.reshape(3)
        T_wc = se3_inv(T_cw)
        anchor = T_loss if T_loss is not None else T_pred
        jump = (float(np.linalg.norm(T_wc[:3, 3] - np.asarray(anchor)[:3, 3]))
                if anchor is not None else 0.0)
        rot_pred = (pose_distance(np.asarray(T_pred), T_wc)[1]
                    if T_pred is not None else 0.0)
        if max_jump_m is not None and anchor is not None and jump > max_jump_m:
            log.warning(
                "relocalization against kf %d rejected: implies a "
                "%.2f m jump from the loss point (bound %.2f m)",
                kf_id, jump, max_jump_m)
            return None
        if max_rot_deg is not None and T_pred is not None and rot_pred > max_rot_deg:
            log.warning(
                "relocalization against kf %d rejected: %.1f deg from the "
                "predicted orientation (bound %.1f deg)",
                kf_id, rot_pred, max_rot_deg)
            return None
        log.info("relocalized against kf %d (score %.3f, %d inliers, "
                 "%.2f m from loss point, %.1f deg from prediction)",
                 kf_id, score, len(inl), jump, rot_pred)
        self.relocs += 1
        keep = inl.reshape(-1)
        return T_wc, kf_id, obs[keep], world[keep]

    @property
    def stats(self) -> dict:
        return {
            "vocab_ready": self.bow.ready,
            "loops_accepted": len(self.accepted),
            "candidates_rejected": self.rejected,
            "relocalizations": self.relocs,
        }

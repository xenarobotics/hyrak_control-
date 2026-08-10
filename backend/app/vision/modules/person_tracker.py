"""
Target Person Tracker
=====================
Tracks a specific person identified by a reference photo.

Pipeline:
  1. User uploads reference photo → InsightFace extracts 512-dim ArcFace embedding
  2. Every frame: YOLO ByteTrack finds all persons
  3. Every N frames: InsightFace detects faces, compares embeddings (cosine similarity)
  4. When match exceeds threshold, lock that ByteTrack ID as the target
  5. Between face checks: track by ByteTrack ID (smooth, even when face not visible)
  6. Three-axis PD controller generates drone velocity commands.
     See human_tracker.py for full control design rationale.

Model: InsightFace buffalo_sc (ArcFace backbone, ~80MB, CPU/GPU)
  - buffalo_sc: lightweight, good for real-time (~30ms GPU, ~150ms CPU per frame)
  - buffalo_l: higher accuracy but heavier (~1.2GB)
  - Similarity threshold: 0.45 cosine similarity (0=unrelated, 1=identical)
"""
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.vision.base import BaseAnalyzer
from app.vision.drawing import draw_brackets
from app.vision.tracker_config import make_bytetrack_cfg
from app.vision.controllers import (
    PDController, KalmanXY, VelocitySmoother, range_error_ratio,
)
from app.vision.geometry import (
    camera_from_settings, deforeshorten_size, pose_from_telemetry,
)
from app.vision.pursuit import (
    PursuitLimits, ROW_NUDGE_STEP, clamp_row_target, decide_elevation,
    distance_axis, foot_row, is_outpaced, limit_climb, limit_descent,
    lock_state_for, new_row_pd, row_reference_is_stale, scale_forward,
)
from app.config import ROOT_DIR, get_settings

logger = logging.getLogger("verocore.vision.person_tracker")

_TRACKER_CFG = make_bytetrack_cfg("verocore_pt_")

# Face checks are paced in SECONDS, not frames. Counting frames couples
# identification latency to the source frame rate, which is exactly backwards:
# when video arrives slowly a name should still appear promptly, and "every 5th
# frame" becomes every 2.5 seconds at 2 fps. Combined with the vote requirement
# that turned into ~10s before a name showed up, while the analyzer itself
# benchmarks at 124 fps — the delay was cadence, never compute.
#
# 0.07s caps face checks at ~14/s. Each check crops up to 4 bodies at ~3.8ms,
# so the worst case is ~15ms per check and ~21% of one core sustained — cheap
# against a measured 124fps analysis ceiling, and it buys the shortest
# identification latency the pipeline can support.
#
# Below the frame interval this simply becomes "check every frame", which is
# the right behaviour on a slow source: a name should not wait on video that
# is already arriving slowly.
_FACE_CHECK_INTERVAL_S  = 0.07
# 1, not 2: the time gate above is the real limiter now, and a frame-count
# floor only re-introduces the frame-rate coupling this was meant to remove.
_FACE_CHECK_EVERY_N     = 1
# One sighting row per person per this many seconds. The face check runs
# every 5 frames, so writing every match would be ~6 rows/second.
_SIGHTING_COOLDOWN_S    = 5.0

# ── Identity voting ─────────────────────────────────────────────────────────
# Consistent matches a track needs before its name is shown. 2 is enough to
# reject a one-frame misfire while still naming someone within ~1/3 second at
# the default face-check cadence; 3+ delays the label past the point where it
# is useful on a moving subject.
_ID_MIN_VOTES = 2
# A match this strong confirms on the FIRST sighting, with no second vote.
# The vote requirement exists to guard against marginal misfires; evidence
# well clear of any impostor does not need the guard, and making a confident
# identification wait for corroboration is pure added latency. Measured on the
# enrolled sample set the worst impostor scored 0.405, so 0.62 sits far above
# anything a wrong person produced.
_ID_CONFIRM_NOW = 0.62
# ...but only when the runner-up is not close behind. A high score with a thin
# margin is the one case where fast confirmation would be wrong.
_ID_CONFIRM_NOW_MIN_MARGIN = 0.12
# Vote ceiling. Without a cap a person visible for a minute accumulates
# hundreds of votes and then cannot be corrected in reasonable time when the
# tracker swaps two people's IDs.
_ID_MAX_VOTES = 6
# Slightly below the naming threshold: a vote is evidence, not a verdict, and
# requiring the full bar on every single frame throws away usable evidence
# from partially-turned faces.
_ID_VOTE_THRESHOLD = 0.45
# How long a name survives after its body track disappears, so someone who
# steps behind a pillar and out again keeps their identity.
_ID_MEMORY_S = 4.0

# Bodies cropped per face check. Each costs ~3.8ms, so 4 is ~15ms of a 33ms
# budget at 30fps. Sorted largest-first, which is nearest-first, which is where
# faces actually have the pixels to be recognised.
_FACE_CROP_MAX_BODIES = 4

# ── Enrolment capture ────────────────────────────────────────────────────────
# Frames grabbed per enrolment, and the gap between them.
#
# Several shots spread over a couple of seconds, NOT one good one: a gallery
# built from a single pose matches that pose and little else, and the whole
# failure mode of face recognition at drone standoff is the subject being
# turned slightly differently than when they were enrolled. The gap is what
# buys pose variety — five consecutive frames are five copies of one image.
_CAPTURE_SHOTS = 5
_CAPTURE_INTERVAL_S = 0.45
# Below this the crop has too few pixels to carry a usable embedding, and
# enrolling it actively poisons the gallery — a blurry template matches
# everyone a little.
_CAPTURE_MIN_BODY_PX = 90
_CAPTURE_ROOT = os.path.join(str(ROOT_DIR), ".data", "enrol_captures")

# ── Lock release ────────────────────────────────────────────────────────────
# How long the locked person can be absent before the lock frees up.
#
# Lowered from 3.0s once face checks became time-paced: at one check per 0.12s
# this is still ~12 independent looks confirming the person is really gone,
# which is ample evidence. The old 3.0s was chosen when a check could take
# 2.5s at a low frame rate, so it represented barely one look — and it added
# most of the delay before the tracker would switch to somebody else.
_LOCK_RELEASE_S = 1.5
# An operator's explicit choice is held much longer — the system quietly
# overriding a deliberate human decision is not an improvement.
_MANUAL_LOCK_HOLD_S = 20.0
_SIMILARITY_THRESHOLD   = 0.45
_DEFAULT_DISTANCE_RATIO = 0.25
_YAW_PRIORITY_THRESHOLD = 0.30
# Forward authority never drops below this fraction, however far off
# boresight the subject sits. A hard zero stalls the chase exactly when
# it matters, and the gap that opens then makes the yaw error worse.
_YAW_PRIORITY_FLOOR = 0.35
# Standing adult, the ruler position-based ranging needs.
_SUBJECT_HEIGHT_M = 1.7
_HEIGHT_EMA_ALPHA       = 0.12

# The airframe speed the distance PD is already clamped to
# (dist_pd max_output). Auto-elevate compares against this, so the
# two must stay in step.
MAX_PURSUIT_SPEED_M_S = 2.5

_PHASE_HOLD  = 90
_PHASE_SWEEP = 180


def _draw_pill(img, text, x1, y1, color_bgr, alpha: float = 0.82):
    font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)
    px, py = 10, 5
    bx1 = x1
    by2 = max(th + py * 2, y1 - 2)
    bx2 = bx1 + tw + px * 2
    by1 = by2 - th - py * 2 - baseline
    H, W = img.shape[:2]
    bx1, bx2 = max(0, bx1), min(W, bx2)
    by1, by2 = max(0, by1), min(H, by2)
    # Blend only the pill's own rectangle. Copying the whole 1080p frame per
    # label cost ~4ms each — see draw_tint_rect in vision/drawing.py for the
    # same fix and why it mattered (draw_overlay runs on EVERY camera frame,
    # not only analysed ones).
    roi = img[by1:by2, bx1:bx2]
    if roi.size:
        block = np.empty_like(roi)
        block[:] = color_bgr
        cv2.addWeighted(block, alpha, roi, 1 - alpha, 0, roi)
    b, g, r = color_bgr
    brightness = 0.299 * r + 0.587 * g + 0.114 * b
    txt_color = (20, 20, 20) if brightness > 140 else (240, 240, 240)
    cv2.putText(img, text, (bx1 + px, by2 - py - baseline), font, scale, txt_color, thick, cv2.LINE_AA)


def _draw_corner_status(img, text, color_bgr, alpha: float = 0.75):
    H, W = img.shape[:2]
    font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)
    margin = 12
    px, py = 10, 6
    bx2 = W - margin
    by2 = H - margin
    bx1 = bx2 - tw - px * 2
    by1 = by2 - th - py * 2 - baseline
    # Blend only the pill's own rectangle. Copying the whole 1080p frame per
    # label cost ~4ms each — see draw_tint_rect in vision/drawing.py for the
    # same fix and why it mattered (draw_overlay runs on EVERY camera frame,
    # not only analysed ones).
    roi = img[by1:by2, bx1:bx2]
    if roi.size:
        block = np.empty_like(roi)
        block[:] = color_bgr
        cv2.addWeighted(block, alpha, roi, 1 - alpha, 0, roi)
    b, g, r = color_bgr
    brightness = 0.299 * r + 0.587 * g + 0.114 * b
    txt_color = (20, 20, 20) if brightness > 140 else (240, 240, 240)
    cv2.putText(img, text, (bx1 + px, by2 - py - baseline), font, scale, txt_color, thick, cv2.LINE_AA)


class _Identified:
    """Minimal GalleryMatch-shaped record so the lock/sighting code below is
    shared between the reference-photo and gallery paths."""
    __slots__ = ("person_id", "name", "similarity")

    def __init__(self, person_id: str, name: str, similarity: float):
        self.person_id = person_id
        self.name = name
        self.similarity = similarity


def _make_state() -> Dict[str, Any]:
    return {
        # Face recognition
        "reference_embedding": None,
        "face_confirmed":      False,
        # ── Gallery mode ──────────────────────────────────────────────────
        # Off by default: with it off this module behaves exactly as before,
        # driven by an operator-supplied reference photo. Turning it on lets
        # the tracker name and lock onto anyone enrolled in the database
        # without a target being picked first.
        "gallery_mode":        False,
        # Which enrolled person we committed to. Once set, a re-lock must
        # match THIS person at the stricter relock bar — not merely whoever
        # in the gallery scores best right now.
        "locked_person_id":    None,
        "locked_person_name":  "",
        "gallery_margin":      None,
        # track_id -> {person_id, name, votes, best_sim, confirmed, ...}
        # Names live on the TRACK so they persist through the many frames
        # where a face is turned away or too small to match.
        "track_identities":    {},
        "identities":          {},
        # When the locked person was last actually identified, and whether
        # an operator chose them. Together these decide when the lock frees.
        "locked_last_seen_t":  0.0,
        "lock_manual":         False,
        "follow_request_person_id": None,
        # ── Enrolment from the live feed ──────────────────────────────────
        # {"track_id", "name", "paths", "last_t"} while capturing, else None.
        "capture": None,
        "last_sighting_t":     0.0,
        "last_face_check_t":   0.0,
        # Body tracking
        "target_track_id":     None,
        "last_known_center":   None,   # normalised (fx/W, fy/H)
        "frames_lost":         0,
        # Monotonic time the target was last actually SEEN. The
        # reacquisition ladder is keyed on seconds, not frames,
        # deliberately: the state an operator sees must not shift
        # with how many frames the machine managed to process.
        "last_seen_t":         0.0,
        "frame_counter":       0,
        "last_similarity":     0.0,
        # PD controllers — no integral; see human_tracker.py for design rationale.
        # Caps match human_tracker.py: yaw stays under PX4's 60deg/s
        # MPC_YAWRAUTO_MAX, dist raised from 0.8 (below walking pace) to 2.5m/s.
        "yaw_pd":  PDController(kp=30.0, kd=4.0, max_output=55.0, deadband=0.05),
        "alt_pd":  PDController(kp=1.5,  kd=0.3, max_output=1.0,  deadband=0.10),
        # Units are FRACTION OF RANGE, not fill difference — see
        # controllers.range_error_ratio for why, and for the measured
        # dead zone this replaced (1.4m at 8.6m, 46m at 50m).
        "dist_pd": PDController(kp=4.0, kd=1.0, max_output=2.5, deadband=0.08),
        # The Fixed-altitude distance axis — see pursuit.new_row_pd.
        "row_pd":  new_row_pd(),
        # Smoothing
        "kalman":     KalmanXY(),
        "smoother":   VelocitySmoother(alpha=0.4),
        "height_ema": None,
        # Drone control
        "tracking":             False,
        "last_drone_command":   None,
        "last_yaw_dir":         1.0,
        # User-configurable
        "altitude_mode":         "fixed",   # 'fixed' or 'auto'
        "altitude_nudge_v":      0.0,       # m/s NED (−=up, +=down), hold-button control
        "target_distance_ratio": _DEFAULT_DISTANCE_RATIO,
        # Frame row Fixed mode holds the feet on; None = take it from the
        # subject on the next frame. See human_tracker for why it is seeded from
        # an observation rather than fixed at frame centre.
        "target_row":            None,
    }


class PersonTracker(BaseAnalyzer):
    """
    Tracks one specific person using face recognition + body tracking.
    No reference photo → shows all persons (no tracking).
    """

    MODE = "person-tracking"

    def __init__(self, **kwargs):
        super().__init__(executor_workers=2, **kwargs)
        settings = get_settings()
        self.device = settings.device

        self.model = YOLO(settings.default_yolo_model)
        self.model.to(self.device)
        self.half = self.device == "cuda"
        # Warm-up so CUDA kernel init doesn't stall the first live frames
        self.model(
            np.zeros((360, 640, 3), dtype=np.uint8),
            device=self.device, half=self.half, verbose=False,
        )

        import insightface
        providers = (
            # HEURISTIC instead of the ORT default EXHAUSTIVE: exhaustive
            # cuDNN algo search benchmarks every conv algorithm on the first
            # inference, freezing the pipeline for seconds mid-stream.
            [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
             "CPUExecutionProvider"]
            if torch.cuda.is_available()
            else ["CPUExecutionProvider"]
        )
        self.face_app = insightface.app.FaceAnalysis(name="buffalo_sc", providers=providers)
        ctx_id = 0 if torch.cuda.is_available() else -1
        self.face_app.prepare(ctx_id=ctx_id, det_size=(640, 640))
        # Warm up both face models at load so first-inference CUDA/cuDNN
        # init doesn't stall the live stream at the first face check.
        self.face_app.get(np.zeros((360, 640, 3), dtype=np.uint8))
        try:
            rec = self.face_app.models.get("recognition")
            if rec is not None:
                rec.get_feat(np.zeros((112, 112, 3), dtype=np.uint8))
        except Exception:
            pass

        self._client_state: Dict[str, Dict[str, Any]] = {}
        # Installed by set_gallery() once a session starts; None until then,
        # which simply means gallery mode matches nobody.
        self._gallery = None
        logger.info(f"✅ PersonTracker ready on {self.device.upper()} (InsightFace buffalo_sc)")

    # ── Client lifecycle ──────────────────────────────────────────────────────

    def register_client(self, client_id: str):
        super().register_client(client_id)
        self._client_state[client_id] = _make_state()

    async def unregister_client(self, client_id: str):
        await super().unregister_client(client_id)
        self._client_state.pop(client_id, None)

    # ── Reference photo ───────────────────────────────────────────────────────

    def extract_reference_embedding(
        self, img_bgr: np.ndarray
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
        faces = self.face_app.get(img_bgr)
        if not faces:
            return None, None
        face = max(
            faces,
            key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
        )
        emb = face.embedding.copy()
        norm = np.linalg.norm(emb)
        if norm > 0:
            emb = emb / norm
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        pad = max(10, int((x2 - x1) * 0.25))
        H, W = img_bgr.shape[:2]
        face_crop = img_bgr[max(0, y1 - pad):min(H, y2 + pad),
                            max(0, x1 - pad):min(W, x2 + pad)]
        return emb, face_crop

    # ── Gallery mode ──────────────────────────────────────────────────────────

    def set_gallery(self, gallery) -> None:
        """
        Install an in-memory FaceGallery snapshot (persistence.load_face_gallery).

        Shared across this analyzer's clients and replaced wholesale rather
        than mutated, so the worker thread never reads a half-built index.
        """
        self._gallery = gallery
        if gallery is not None:
            logger.info(
                f"PersonTracker: gallery installed — {gallery.size} face(s), "
                f"{gallery.person_count} person(s)"
            )

    def set_gallery_mode(self, client_id: str, enabled: bool) -> None:
        """
        Turn database matching on or off for one session.

        Independent of the reference-photo flow: an uploaded photo always
        wins, so enabling this cannot disturb a target the operator chose.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        state["gallery_mode"] = bool(enabled)
        if not enabled:
            state["locked_person_id"] = None
            state["locked_person_name"] = ""
            state["gallery_margin"] = None
        logger.info(
            f"Session {client_id[:8]}: gallery mode "
            f"{'ENABLED' if enabled else 'disabled'}"
            + (f" ({self._gallery.person_count} enrolled)"
               if enabled and self._gallery else "")
        )

    # ── Gallery identification ────────────────────────────────────────────
    #
    # IDENTIFYING and FOLLOWING are separate jobs, and conflating them was a
    # real bug: the follow rule ("never switch targets mid-flight") was applied
    # to naming too, so once one person was locked a second enrolled person
    # standing right next to them was never even evaluated.
    #
    #   _identify_all()  names EVERY gallery member in frame. No lock involved.
    #   _choose_target() picks which of them to follow, and that is where the
    #                    no-switching rule belongs.

    def _identify_all(self, faces, persons, state) -> Dict[int, dict]:
        """
        Match every detected face against the gallery and attach names to body
        tracks. Returns {track_id: identity} for tracks named with enough
        confidence.

        RELIABILITY comes from voting rather than from one frame's score. A
        single face check can misfire on a blurred or half-turned face, and a
        wrong name that appears for one frame is indistinguishable to an
        operator from a wrong name that is real. So a track must agree with
        itself _ID_MIN_VOTES times before its name is published.

        REDUNDANCY comes from the name living on the TRACK, not on the frame.
        Once a track is named, ByteTrack carries that name through every frame
        where the face is turned away, too small, or occluded — which at any
        realistic drone standoff is most of them. Without this the label
        flickers on and off several times a second.
        """
        gallery = self._gallery
        registry: Dict[int, dict] = state["track_identities"]
        if gallery is None or gallery.is_empty():
            return {}

        now = time.monotonic()

        if faces:
            # `faces` is a list of (face, owner) pairs. When detection cropped
            # each body the owner is already known; when it fell back to a
            # whole-frame pass the owner is None and has to be found.
            for face, owner in faces:
                emb = np.asarray(face.embedding, dtype=np.float32).copy()
                n = float(np.linalg.norm(emb))
                if n <= 0:
                    continue
                emb /= n

                match = gallery.match(emb, threshold=_ID_VOTE_THRESHOLD)
                if match is None:
                    continue

                if owner is None:
                    # Tie the face to the body box containing it, so the
                    # identity can ride the body track between face checks.
                    fcx = (face.bbox[0] + face.bbox[2]) / 2
                    fcy = (face.bbox[1] + face.bbox[3]) / 2
                    for pp in persons:
                        x1, y1, x2, y2 = pp["box"]
                        if x1 <= fcx <= x2 and y1 <= fcy <= y2:
                            owner = pp
                            break
                if owner is None:
                    continue

                tid = owner["id"]
                entry = registry.get(tid)
                if entry is None or entry["person_id"] != match.person_id:
                    if entry is not None and entry.get("votes", 0) >= _ID_MIN_VOTES:
                        # An established identity is not overwritten by one
                        # dissenting frame — it is argued down. Otherwise a
                        # single bad match renames a confirmed person.
                        entry["votes"] -= 1
                        if entry["votes"] > 0:
                            continue
                    marg = gallery.margin(emb)
                    # Strong AND unambiguous evidence needs no second opinion.
                    instant = (
                        match.similarity >= _ID_CONFIRM_NOW
                        and (marg is None or marg >= _ID_CONFIRM_NOW_MIN_MARGIN)
                    )
                    registry[tid] = {
                        "person_id": match.person_id,
                        "name": match.name,
                        "votes": _ID_MIN_VOTES if instant else 1,
                        "best_sim": float(match.similarity),
                        "last_sim": float(match.similarity),
                        "margin": marg,
                        "last_seen": now,
                        "confirmed": instant,
                    }
                    if instant:
                        logger.info(
                            f"Identified track #{tid} as {match.name} "
                            f"(sim={match.similarity:.3f}, margin={marg}) "
                            f"— confirmed immediately"
                        )
                else:
                    entry["votes"] = min(entry["votes"] + 1, _ID_MAX_VOTES)
                    entry["best_sim"] = max(entry["best_sim"], float(match.similarity))
                    entry["last_sim"] = float(match.similarity)
                    entry["margin"] = gallery.margin(emb)
                    entry["last_seen"] = now
                    if entry["votes"] >= _ID_MIN_VOTES and not entry["confirmed"]:
                        entry["confirmed"] = True
                        logger.info(
                            f"Identified track #{tid} as {entry['name']} "
                            f"(sim={entry['best_sim']:.3f}, "
                            f"{entry['votes']} consistent votes)"
                        )

        # Drop identities whose body track is gone, or which have gone stale.
        # Kept for _ID_MEMORY_S past the last sighting so a person who walks
        # behind a pillar and back out keeps their name.
        live = {pp["id"] for pp in persons}
        for tid in list(registry):
            entry = registry[tid]
            if tid not in live and (now - entry["last_seen"]) > _ID_MEMORY_S:
                registry.pop(tid, None)

        return {
            tid: e for tid, e in registry.items()
            if e["confirmed"] and tid in live
        }

    def _choose_target(self, identities: Dict[int, dict], persons, state, client_id=""):
        """
        Which identified person to FOLLOW. Returns (track_id, identity) or
        (None, None).

        Three rules, and the tension between them is the whole design:

        1. WHILE THE LOCKED PERSON IS PRESENT, NOBODY ELSE TAKES THE LOCK.
           A drone that switches which human it is chasing while both are in
           frame is the worst failure this system can produce.

        2. WHEN THE LOCKED PERSON IS GONE, THE LOCK RELEASES.
           This is what an earlier version got wrong: it held the lock forever,
           so once one person was acquired the drone would follow nobody else
           for the rest of the session even after the original walked out of
           frame. A lock with no release is not a safety feature, it is a
           dead end — the aircraft ends up committed to somebody who is not
           there. Released after _LOCK_RELEASE_S of absence, then whoever is
           actually present can be acquired.

        3. AN OPERATOR'S CHOICE OUTRANKS BOTH.
           A manually selected target is held far longer (_MANUAL_LOCK_HOLD_S),
           because the system guessing differently from a deliberate human
           decision is not an improvement.
        """
        from app.vision.face_gallery import DEFAULT_RELOCK_THRESHOLD

        now = time.monotonic()
        locked_pid = state.get("locked_person_id")
        manual = state.get("lock_manual", False)

        if locked_pid:
            for tid, e in identities.items():
                if e["person_id"] != locked_pid:
                    continue
                # Re-appearing after a loss must clear the higher bar; a
                # continuously held lock does not re-prove itself every frame.
                if state.get("frames_lost", 0) > 0 \
                        and e["last_sim"] < DEFAULT_RELOCK_THRESHOLD:
                    continue
                state["locked_last_seen_t"] = now
                return tid, e

            # Locked person is not in frame.
            last_seen = state.get("locked_last_seen_t") or now
            gone_for = now - last_seen
            hold = _MANUAL_LOCK_HOLD_S if manual else _LOCK_RELEASE_S
            if gone_for < hold:
                # Still within the hold window — wait for them rather than
                # grabbing whoever else happens to be visible. Prevents the
                # lock flickering between people every time a face check misses.
                return None, None

            logger.info(
                f"Session {client_id[:8]}: releasing lock on "
                f"{state.get('locked_person_name') or locked_pid} — not seen for "
                f"{gone_for:.1f}s{' (manual)' if manual else ''}; "
                f"free to acquire someone else"
            )
            state["locked_person_id"] = None
            state["locked_person_name"] = ""
            state["lock_manual"] = False
            state["gallery_margin"] = None

        if not identities:
            return None, None

        # Nothing committed: prefer an operator's pending request if that person
        # is present, otherwise the strongest identification.
        wanted = state.get("follow_request_person_id")
        if wanted:
            for tid, e in identities.items():
                if e["person_id"] == wanted:
                    state["lock_manual"] = True
                    state["follow_request_person_id"] = None
                    state["locked_last_seen_t"] = now
                    logger.info(
                        f"Session {client_id[:8]}: following {e['name']} "
                        f"(operator selected)"
                    )
                    return tid, e

        tid = max(identities, key=lambda t: identities[t]["best_sim"])
        state["locked_last_seen_t"] = now
        return tid, identities[tid]

    # ── Operator target selection ─────────────────────────────────────────────

    def begin_capture(self, client_id: str, track_id: int, name: str) -> bool:
        """
        Start grabbing enrolment shots of a person already being tracked.

        Enrolling from the live feed rather than uploaded photos is the point:
        the gallery then contains this camera, this lens, this angle and this
        lighting — which is what the recogniser will actually be asked to match
        against. An uploaded passport photo is a different imaging problem.
        """
        state = self._client_state.get(client_id)
        if state is None or not str(name).strip():
            return False
        os.makedirs(_CAPTURE_ROOT, exist_ok=True)
        state["capture"] = {
            "track_id": int(track_id),
            "name": str(name).strip()[:64],
            "paths": [],
            "last_t": 0.0,
        }
        logger.info(
            f"Session {client_id[:8]}: enrolling track #{track_id} as "
            f"{name!r} — capturing {_CAPTURE_SHOTS} shots"
        )
        return True

    def cancel_capture(self, client_id: str) -> None:
        state = self._client_state.get(client_id)
        if state is not None:
            state["capture"] = None

    def _run_capture(self, frame_bgr, persons, state) -> Optional[dict]:
        """
        Grab one shot per interval; returns the finished job when complete.

        Nothing is written to the database from here — this runs in the worker
        thread. The finished job is handed up through meta for the event loop
        to enrol, the same way plate rows and crowd alerts already travel.
        """
        cap = state.get("capture")
        if not cap:
            return None
        now = time.monotonic()
        if now - cap["last_t"] < _CAPTURE_INTERVAL_S:
            return None

        target = next((p for p in persons if p["id"] == cap["track_id"]), None)
        if target is None:
            return None                      # wait for them to come back
        x1, y1, x2, y2 = target["box"]
        if (y2 - y1) < _CAPTURE_MIN_BODY_PX:
            return None                      # too small to be worth enrolling

        # Head and shoulders, padded — the face is what carries the embedding,
        # and a full-body crop spends most of its pixels on legs.
        h, w = frame_bgr.shape[:2]
        bw, bh = x2 - x1, y2 - y1
        px = int(bw * 0.25)
        cy2 = y1 + int(bh * 0.45)
        crop = frame_bgr[max(0, y1 - int(bh * 0.10)):min(h, cy2),
                         max(0, x1 - px):min(w, x2 + px)]
        if crop.size == 0 or crop.shape[0] < 40 or crop.shape[1] < 40:
            return None

        cap["last_t"] = now
        path = os.path.join(
            _CAPTURE_ROOT,
            f"{cap['name'].replace(' ', '_')}_{int(now * 1000)}.jpg",
        )
        cv2.imwrite(path, crop)
        cap["paths"].append(path)

        if len(cap["paths"]) >= _CAPTURE_SHOTS:
            state["capture"] = None
            logger.info(
                f"Captured {len(cap['paths'])} shot(s) for {cap['name']!r} — "
                f"handing to enrolment"
            )
            return {"name": cap["name"], "paths": cap["paths"]}
        return None

    def follow_track(self, client_id: str, track_id) -> None:
        """
        Follow a person the operator pointed at who is NOT in the face gallery.

        This module's normal lock is an enrolled IDENTITY, because that is what
        survives a track id changing when somebody leaves and returns. But an
        operator tapping an unrecognised person plainly means "follow them",
        and doing nothing there is indistinguishable from a broken control —
        which is how it behaved. So the track is locked directly, with the
        identity lock cleared so a later face match cannot silently steal the
        aircraft away from the person actually being pointed at.

        The trade-off is real and worth stating: a track-based lock does NOT
        survive the person being occluded long enough for ByteTrack to reissue
        an id. It is the weaker lock, chosen because the alternative is none.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        if track_id is None:
            state["target_track_id"] = None
            state["lock_manual"] = False
            return
        state["target_track_id"] = int(track_id)
        state["locked_person_id"] = None
        state["locked_person_name"] = ""
        state["follow_request_person_id"] = None
        state["lock_manual"] = True
        state["locked_last_seen_t"] = time.monotonic()
        state["frames_lost"] = 0
        state["kalman"].reset()
        state["height_ema"] = None
        logger.info(
            f"Session {client_id[:8]}: following unenrolled track #{track_id} "
            f"(operator selected)"
        )

    def request_follow(self, client_id: str, person_id: Optional[str]) -> None:
        """
        Ask to follow a specific enrolled person, or None to release and let
        the tracker pick automatically again.

        Applied on the next face check rather than immediately, because the
        person has to actually be identified in frame before there is a body
        track to follow — setting the lock here would commit to somebody who
        may not be visible.
        """
        state = self._client_state.get(client_id)
        if state is None:
            return
        if person_id is None:
            state["follow_request_person_id"] = None
            state["locked_person_id"] = None
            state["locked_person_name"] = ""
            state["lock_manual"] = False
            state["target_track_id"] = None
            logger.info(f"Session {client_id[:8]}: lock released — auto-select resumed")
            return
        state["follow_request_person_id"] = person_id
        # Drop the current lock so the request is not blocked by rule 1.
        state["locked_person_id"] = None
        state["locked_person_name"] = ""
        state["lock_manual"] = False
        logger.info(f"Session {client_id[:8]}: follow requested for {person_id[:8]}")

    def _queue_sighting(self, state, client_id, match, person, pending_db) -> None:
        """
        Queue an audit row for a gallery match — the record behind "the drone
        said this was Madhu at 14:32".

        Rate-limited to one row per _SIGHTING_COOLDOWN_S. The face check runs
        every few frames, so an unthrottled version would write several rows a
        second for a stationary subject and bury the interesting transitions.

        Queued rather than written: this runs in a worker thread. The drone's
        own position is attached downstream in stream_track, the same way
        plate_event rows get theirs.
        """
        now = time.time()
        if now - state.get("last_sighting_t", 0.0) < _SIGHTING_COOLDOWN_S:
            return
        state["last_sighting_t"] = now
        pending_db.append({
            "table":       "person_sighting",
            "person_id":   match.person_id,
            "person_name": match.name,
            "similarity":  float(match.similarity),
            "track_id":    int(person["id"]),
        })

    def set_reference_embedding(self, client_id: str, embedding: np.ndarray):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["reference_embedding"] = embedding
        state["face_confirmed"]      = True
        state["target_track_id"]     = None
        state["frames_lost"]         = 0
        state["last_known_center"]   = None
        state["last_similarity"]     = 0.0
        state["frame_counter"]       = 0
        state["height_ema"]          = None
        state["kalman"].reset()
        logger.info(f"Session {client_id[:8]}: reference embedding stored")

    def clear_reference(self, client_id: str):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["reference_embedding"] = None
        state["face_confirmed"]      = False
        state["target_track_id"]     = None
        state["last_known_center"]   = None
        state["frames_lost"]         = 0
        state["last_similarity"]     = 0.0
        state["frame_counter"]       = 0
        state["tracking"]            = False
        state["last_drone_command"]  = None
        state["height_ema"]          = None
        state["kalman"].reset()
        state["smoother"].reset()
        state["yaw_pd"].reset()
        state["alt_pd"].reset()
        state["dist_pd"].reset()
        logger.info(f"Session {client_id[:8]}: reference cleared")

    def set_tracking(self, client_id: str, active: bool):
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        state["tracking"] = active
        if not active:
            state["yaw_pd"].reset()
            state["alt_pd"].reset()
            state["dist_pd"].reset()
            state["row_pd"].reset()
            state["smoother"].reset()
            state["height_ema"]         = None
            state["last_drone_command"] = None
            state["frames_lost"]        = 0
            state["altitude_nudge_v"]   = 0.0
        # Taken fresh at every lock: the framing on screen when the operator
        # presses start is the framing they asked for.
        state["target_row"] = None
        logger.info(f"Session {client_id[:8]}: tracking {'STARTED' if active else 'STOPPED'}")

    def set_pd_params(self, client_id: str, kp: float, kd: float,
                      max_output: float, deadband: float):
        """Backward-compatible hook: updates yaw PD gains only."""
        if client_id not in self._client_state:
            return
        pd = self._client_state[client_id]["yaw_pd"]
        pd.kp = kp
        pd.kd = kd
        pd.max_output = min(max_output, 55.0)
        pd.deadband = deadband

    def set_altitude_mode(self, client_id: str, mode: str):
        """'fixed' = hold current altitude (down_m_s=0). 'auto' = altitude PD active."""
        if client_id not in self._client_state or mode not in ("fixed", "auto"):
            return
        state = self._client_state[client_id]
        state["altitude_mode"] = mode
        # Each mode hands the forward axis to a different sensor; reset the
        # incoming PD and re-take the row reference at the height we are at now.
        if mode == "fixed":
            state["alt_pd"].reset()
            state["row_pd"].reset()
            state["target_row"] = None
        else:
            state["dist_pd"].reset()
        logger.info(f"Session {client_id[:8]}: altitude mode → {mode}")

    def set_tracking_params(self, client_id: str, target_distance_ratio: float):
        """Adjust target follow distance.
        0.15 → far (~8–10 m), 0.25 → default (~5–6 m), 0.40 → close (~2–3 m).

        In Fixed altitude the forward axis reads the frame row, so the ratio
        alone would not reach it — the DIRECTION of change is applied to the
        target row as well, keeping CLOSER / FURTHER working in both modes."""
        if client_id not in self._client_state:
            return
        state = self._client_state[client_id]
        previous = state.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO)
        ratio = float(np.clip(target_distance_ratio, 0.10, 0.60))
        state["target_distance_ratio"] = ratio
        state["height_ema"] = None

        if state.get("altitude_mode") != "auto" and state.get("target_row") is not None:
            # Closer means the feet sit lower in frame, i.e. a larger row.
            if ratio > previous:
                state["target_row"] = clamp_row_target(state["target_row"] + ROW_NUDGE_STEP)
            elif ratio < previous:
                state["target_row"] = clamp_row_target(state["target_row"] - ROW_NUDGE_STEP)
            state["row_pd"].reset()
        logger.info(f"Session {client_id[:8]}: distance ratio → {ratio:.2f}")

    def set_altitude_nudge(self, client_id: str, velocity: float):
        """Set manual altitude velocity for Fixed mode.
        -ve = ascend, +ve = descend (NED). 0 = stop. Cleared on tracking stop."""
        if client_id not in self._client_state:
            return
        v = float(np.clip(velocity, -1.0, 1.0))
        self._client_state[client_id]["altitude_nudge_v"] = v

    # ── Frame analysis ────────────────────────────────────────────────────────

    # Face detection internally letterboxes to det_size (640x640) anyway;
    # pre-downscaling 1080p to 960 wide with cv2 (GIL-released) cuts the
    # Python-side preprocessing cost without hurting detection.
    _FACE_DET_WIDTH = 960

    def _detect_faces(self, frame_bgr: np.ndarray):
        H, W = frame_bgr.shape[:2]
        if W <= self._FACE_DET_WIDTH:
            return self.face_app.get(frame_bgr)
        scale = self._FACE_DET_WIDTH / W
        small = cv2.resize(frame_bgr, (self._FACE_DET_WIDTH, int(H * scale)))
        faces = self.face_app.get(small)
        for face in faces:
            face.bbox = face.bbox / scale
        return faces

    def _detect_faces_on_bodies(self, frame_bgr, persons):
        """
        Detect faces by CROPPING each person's box at native resolution, rather
        than shrinking the whole frame to _FACE_DET_WIDTH and searching it.

        Two things this buys, both measured:

        RESOLUTION. Whole-frame detection resizes 1920 -> 960, halving every
        face. A crop keeps native pixels, so the same person yields ~2x the
        face width — and recognition is resolution-starved at any real drone
        standoff (a 230mm face needs ~70px even for a 3-person gallery, which
        is only a few metres at 70deg HFOV). Doubling effective face size
        roughly doubles the range at which anyone can be recognised, and raises
        similarity on faces already in range. That last part is a LATENCY win
        as well as a quality one: a stronger match clears _ID_CONFIRM_NOW and
        is named on its first sighting instead of waiting for a second vote.

        ASSOCIATION FOR FREE. The face is found inside a known body box, so
        there is no "which person owns this face" search, and no failure mode
        where a face falls between two boxes and is discarded.

        Cost: 3.8ms per crop against 3.6ms for one whole-frame pass, so it is
        capped at _FACE_CROP_MAX_BODIES (~15ms worst case). Largest bodies
        first — those are the nearest people, and the only ones whose faces
        carry enough pixels to recognise at all.
        """
        if not persons:
            # No bodies yet (tracker still settling). Fall back to the whole
            # frame so recognition is not blocked on body detection.
            return [(face, None) for face in self._detect_faces(frame_bgr)]

        pairs = []
        H, W = frame_bgr.shape[:2]
        for person in persons[:_FACE_CROP_MAX_BODIES]:
            x1, y1, x2, y2 = person["box"]
            bw, bh = x2 - x1, y2 - y1
            if bw < 24 or bh < 48:
                continue                      # too small to hold a face
            # Pad outward: a body box clips shoulders and often the top of the
            # head, and a face touching the crop edge detects poorly.
            px, py = int(bw * 0.18), int(bh * 0.12)
            cx1, cy1 = max(0, x1 - px), max(0, y1 - py)
            cx2, cy2 = min(W, x2 + px), min(H, y2 + py)
            crop = frame_bgr[cy1:cy2, cx1:cx2]
            if crop.size == 0 or crop.shape[0] < 32 or crop.shape[1] < 32:
                continue
            try:
                found = self.face_app.get(crop)
            except Exception:
                continue
            for face in found:
                # Back to full-frame coordinates so overlay, association and
                # logging all speak one coordinate system.
                face.bbox = np.asarray(face.bbox, dtype=np.float32) + np.array(
                    [cx1, cy1, cx1, cy1], dtype=np.float32
                )
                pairs.append((face, person))
        return pairs

    @torch.inference_mode()
    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        H, W = frame_bgr.shape[:2]

        # Pre-resizing with cv2 skips the Python-side cost of letterboxing at
        # 1080p every frame. imgsz must be passed alongside it — see the note
        # in crowd_manager: without it ultralytics rescales back to 640 and
        # any width above 640 buys nothing.
        #
        # NOTE this is the BODY detector. Face detection runs separately at
        # _FACE_DET_WIDTH (960) because recognition needs far more pixels on
        # target than detection does.
        frame_proc, sx, sy = self.resize_for_inference(frame_bgr)

        results = self.model.track(
            frame_proc, classes=[0], imgsz=self.imgsz_for(frame_proc),
            device=self.device, half=self.half, verbose=False, conf=0.5,
            persist=True, tracker=_TRACKER_CFG,
        )

        persons = []
        if results and results[0].boxes is not None and len(results[0].boxes):
            boxes     = results[0].boxes
            xyxy      = boxes.xyxy.cpu().numpy()
            confs     = boxes.conf.cpu().numpy()
            track_ids = (
                boxes.id.int().cpu().numpy()
                if boxes.id is not None else range(len(xyxy))
            )
            min_area = 0.002 * W * H
            for track_id, box, conf in zip(track_ids, xyxy, confs):
                # Scale box coordinates back to the original frame resolution
                x1, y1 = int(box[0] * sx), int(box[1] * sy)
                x2, y2 = int(box[2] * sx), int(box[3] * sy)
                if (x2 - x1) * (y2 - y1) < min_area:
                    continue
                persons.append({
                    "id":           int(track_id),
                    "box":          [x1, y1, x2, y2],
                    "area":         (x2 - x1) * (y2 - y1),
                    "conf":         round(float(conf), 2),
                    "cx_n":         (x1 + x2) / (2 * W),
                    "cy_n":         (y1 + y2) / (2 * H),
                    "height_ratio": (y2 - y1) / H,
                })
        persons.sort(key=lambda p: p["area"], reverse=True)

        drone_command  = None
        target_id      = None
        tracking       = False
        searching      = False
        face_confirmed = False
        similarity     = 0.0
        state          = {}
        # Gallery sightings are queued here and written by stream_track's
        # recv() — this method runs in a worker thread, not the event loop.
        pending_db: list = []

        for client_id, state in self._client_state.items():
            tracking       = state.get("tracking", False)
            face_confirmed = state.get("face_confirmed", False)
            ref_emb        = state.get("reference_embedding")
            target_id      = state.get("target_track_id")
            yaw_pd         = state["yaw_pd"]
            alt_pd         = state["alt_pd"]
            # dist_pd / row_pd are reached through state, in distance_axis —
            # which of the two runs depends on the altitude mode.
            kalman         = state["kalman"]
            smoother       = state["smoother"]
            dist_target    = state.get("target_distance_ratio", _DEFAULT_DISTANCE_RATIO)

            state["frame_counter"] = state.get("frame_counter", 0) + 1

            # ── Face recognition check (every N frames) ───────────────────
            # Two ways in. A reference photo is checked first and wins
            # outright: the operator explicitly chose that person, and gallery
            # mode must never override a deliberate selection. Only with no
            # reference photo does database matching get a turn.
            gallery_on = (
                state.get("gallery_mode")
                and self._gallery is not None
                and not self._gallery.is_empty()
            )
            # Paced on elapsed TIME so identification latency does not scale
            # with a slow source — see _FACE_CHECK_INTERVAL_S.
            _now_m = time.monotonic()
            due = (
                (_now_m - state.get("last_face_check_t", 0.0)) >= _FACE_CHECK_INTERVAL_S
                and state["frame_counter"] % _FACE_CHECK_EVERY_N == 0
            )
            if (ref_emb is not None or gallery_on) and due:
                state["last_face_check_t"] = _now_m
                # Per-body crops at native resolution rather than one shrunken
                # whole-frame pass: ~2x the face pixels, and the owning body is
                # known without searching. See _detect_faces_on_bodies.
                faces = self._detect_faces_on_bodies(frame_bgr, persons)
                best_sim    = 0.0
                best_person = None
                gallery_hit = None
                # A reference photo uses the operator-supervised bar; a
                # gallery match brings its own, stricter one.
                threshold   = _SIMILARITY_THRESHOLD

                if ref_emb is not None:
                    for face, owner in faces:
                        fe = face.embedding.copy()
                        fn = np.linalg.norm(fe)
                        if fn > 0:
                            fe = fe / fn
                        sim = float(np.dot(ref_emb, fe))
                        if sim > best_sim:
                            best_sim = sim
                            if owner is not None:
                                best_person = owner
                            else:
                                # Whole-frame fallback: no owner came with the
                                # face, so find the body box containing it.
                                fcx = (face.bbox[0] + face.bbox[2]) / 2
                                fcy = (face.bbox[1] + face.bbox[3]) / 2
                                for p in persons:
                                    x1, y1, x2, y2 = p["box"]
                                    if x1 <= fcx <= x2 and y1 <= fcy <= y2:
                                        best_person = p
                                        break
                else:
                    # Identify EVERYONE, then decide who to follow. These are
                    # separate steps on purpose — see _identify_all.
                    identities = self._identify_all(faces, persons, state)
                    state["identities"] = identities

                    # AN OPERATOR'S PICK OUTRANKS AUTO-IDENTIFICATION.
                    #
                    # Turning on auto-identify used to hand the aircraft to
                    # whoever scored best in the gallery, abandoning the person
                    # the operator had deliberately tapped. That is the worst
                    # failure this module can produce: the drone silently
                    # switches which human it is chasing, and the operator has
                    # no reason to expect it. Naming everyone in frame and
                    # choosing whom to follow are separate jobs — identify
                    # still runs, it just no longer steals the target.
                    manual_tid = state.get("target_track_id")
                    manual_held = (
                        state.get("lock_manual")
                        and manual_tid is not None
                        and any(pp["id"] == manual_tid for pp in persons)
                    )
                    if manual_held:
                        state["locked_last_seen_t"] = time.monotonic()
                        tid, ident = manual_tid, identities.get(manual_tid)
                        if ident is None:
                            # Held, but not recognised — keep following them
                            # and skip the gallery-match bookkeeping below.
                            best_person = next(
                                (pp for pp in persons if pp["id"] == manual_tid), None
                            )
                            threshold, best_sim = 0.0, 1.0
                            tid = None
                    else:
                        tid, ident = self._choose_target(
                            identities, persons, state, client_id
                        )
                    if ident is not None:
                        best_person = next(
                            (pp for pp in persons if pp["id"] == tid), None
                        )
                        best_sim = ident["last_sim"]
                        state["gallery_margin"] = ident.get("margin")
                        # Shaped like a GalleryMatch for the shared code below.
                        gallery_hit = _Identified(
                            ident["person_id"], ident["name"], best_sim
                        )
                    # _identify_all and _choose_target have already applied
                    # their own thresholds, so anything returned is admissible.
                    # A manual hold has already set its own threshold above and
                    # must not be re-gated here.
                    if not manual_held:
                        threshold = 0.0 if gallery_hit else _SIMILARITY_THRESHOLD
                    elif gallery_hit:
                        threshold = 0.0

                if best_sim >= threshold and best_person is not None:
                    if target_id != best_person["id"]:
                        who = (f" as {gallery_hit.name}" if gallery_hit else "")
                        logger.info(
                            f"Session {client_id[:8]}: face matched "
                            f"#{best_person['id']}{who} (sim={best_sim:.3f})"
                        )
                        kalman.reset()
                        state["height_ema"] = None
                    state["target_track_id"]  = best_person["id"]
                    state["frames_lost"]       = 0
                    state["last_known_center"] = (best_person["cx_n"], best_person["cy_n"])
                    state["last_similarity"]   = round(best_sim, 3)
                    target_id = best_person["id"]
                    similarity = best_sim

                    if gallery_hit is not None:
                        newly_locked = state.get("locked_person_id") != gallery_hit.person_id
                        state["locked_person_id"]   = gallery_hit.person_id
                        state["locked_person_name"] = gallery_hit.name
                        if newly_locked:
                            logger.info(
                                f"Session {client_id[:8]}: LOCKED onto "
                                f"{gallery_hit.name} (sim={best_sim:.3f}, "
                                f"margin={state.get('gallery_margin')})"
                            )
                        self._queue_sighting(
                            state, client_id, gallery_hit, best_person, pending_db
                        )
                elif best_sim < _SIMILARITY_THRESHOLD * 0.7 and state["frames_lost"] > 60:
                    state["target_track_id"] = None
                    target_id = None
                    # The identity is NOT cleared here. Losing the body track
                    # does not mean the person was misidentified, and keeping
                    # locked_person_id is what stops a re-lock from silently
                    # picking a different gallery member.

            # ── Body tracking by ByteTrack ID ─────────────────────────────
            target = next((p for p in persons if p["id"] == target_id), None)

            # ── Spatial reacquisition with face verification ───────────────
            if target is None and target_id is not None and persons:
                frames_lost = state.get("frames_lost", 0)
                last_center = state.get("last_known_center")
                if frames_lost > 90 and last_center:
                    lx, ly = last_center
                    closest = min(
                        persons,
                        key=lambda p: (p["cx_n"] - lx) ** 2 + (p["cy_n"] - ly) ** 2,
                    )
                    dist_n = ((closest["cx_n"] - lx) ** 2 + (closest["cy_n"] - ly) ** 2) ** 0.5
                    if dist_n < 0.35:
                        accepted = False
                        if ref_emb is not None:
                            faces = self._detect_faces(frame_bgr)
                            x1, y1, x2, y2 = closest["box"]
                            for face in faces:
                                fcx = (face.bbox[0] + face.bbox[2]) / 2
                                fcy = (face.bbox[1] + face.bbox[3]) / 2
                                if x1 <= fcx <= x2 and y1 <= fcy <= y2:
                                    fe = face.embedding.copy()
                                    fn = np.linalg.norm(fe)
                                    if fn > 0:
                                        fe = fe / fn
                                    if float(np.dot(ref_emb, fe)) >= _SIMILARITY_THRESHOLD:
                                        accepted = True
                                        break
                            if not faces:
                                accepted = True  # face turned away; trust spatial proximity
                        else:
                            accepted = True

                        if accepted:
                            state["target_track_id"] = closest["id"]
                            target_id = closest["id"]
                            target    = closest
                            state["frames_lost"] = 0
                            state["height_ema"]  = None
                            kalman.reset()
                            logger.info(f"Session {client_id[:8]}: spatially reacquired #{closest['id']}")

            if target is not None:
                state["frames_lost"] = 0
                state["last_seen_t"] = time.monotonic()

                # Kalman in normalised space
                fx_n, fy_n = kalman.update(target["cx_n"], target["cy_n"])
                state["last_known_center"] = (fx_n, fy_n)

                # Bbox height EMA — smooths YOLO size fluctuations before distance PD
                prev_h = state["height_ema"]
                h_raw  = target["height_ratio"]
                h_ema  = h_raw if prev_h is None else (
                    _HEIGHT_EMA_ALPHA * h_raw + (1 - _HEIGHT_EMA_ALPHA) * prev_h
                )
                state["height_ema"] = h_ema

                if tracking:
                    # Pose read once, up front: the foreshortening correction
                    # below and the altitude floor further down both need it,
                    # not just the elevate decision.
                    ctx = self.frame_context(client_id)
                    pose = pose_from_telemetry(ctx.telemetry) if ctx else None
                    agl_for_floor = pose.agl_m if pose else None

                    # ── Undo viewing-angle foreshortening ─────────────────
                    # A standing person is a VERTICAL extent, so its projection
                    # shrinks by cos(depression). Apparent size then goes as
                    # sin(2*phi) and PEAKS at 45deg — meaning past that point a
                    # subject moving closer looks SMALLER, the controller reads
                    # "moving away" and drives forward, bringing them closer
                    # still. A feedback loop aimed at the subject. Measured at
                    # 6m AGL: 18.0% fill at 6m out, 14.4% at 3m, 5.8% at 1m.
                    # Where the subject meets the ground. Drives the Fixed-mode
                    # distance axis, and is the pixel the ground projection
                    # inside _range_observable has to use.
                    foot_n = foot_row(fy_n, h_ema)
                    h_eff, _phi = self._range_observable(
                        h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, _SUBJECT_HEIGHT_M
                    )
                    err_yaw  = fx_n - 0.5
                    err_alt  = fy_n - 0.5
                    # Fraction-of-range — see controllers.range_error_ratio.
                    err_dist = range_error_ratio(dist_target, h_eff)

                    yaw_deg_s = yaw_pd.compute(err_yaw)

                    if yaw_deg_s > 0.5:
                        state["last_yaw_dir"] = 1.0
                    elif yaw_deg_s < -0.5:
                        state["last_yaw_dir"] = -1.0

                    down_m_s = (
                        alt_pd.compute(err_alt)
                        if state.get("altitude_mode") == "auto"
                        else state.get("altitude_nudge_v", 0.0)
                    )

                    # ── THE DISTANCE AXIS, PER ALTITUDE MODE ──────────────
                    # Fixed reads the frame row (height is held, so the row IS
                    # range: high in frame far, low in frame near); Auto reads
                    # apparent size, unchanged. See pursuit.distance_axis.
                    alt_mode = state.get("altitude_mode", "fixed")
                    forward_raw, range_err = distance_axis(
                        state=state, altitude_mode=alt_mode,
                        foot_row_n=foot_n, size_range_error=err_dist,
                    )

                    # Floor, not a hard gate — see human_tracker.
                    yaw_factor = max(_YAW_PRIORITY_FLOOR,
                                     1.0 - abs(err_yaw) / _YAW_PRIORITY_THRESHOLD)
                    # A retreat is never throttled — see pursuit.scale_forward.
                    forward_m_s = scale_forward(forward_raw, yaw_factor, alt_mode)

                    # ── Auto-elevate: the chase fallback ──────────────────
                    # Only when the target is genuinely pulling away, and only
                    # inside both ceilings. Overrides the altitude axis because
                    # holding the subject in frame at all outranks holding them
                    # vertically centred — a perfectly framed empty sky is
                    # worse than an off-centre target.
                    elevate = None
                    if forward_m_s > 0:
                        agl = agl_for_floor
                        depression = None
                        if pose is not None and ctx is not None:
                            cam = camera_from_settings(ctx.width or W, ctx.height or H)
                            depression = pose.depression_deg(cam, W / 2.0, H / 2.0)
                        # Growing distance, from whichever error is driving the
                        # axis: in Fixed the subject climbing the frame, in Auto
                        # the subject shrinking.
                        limits = PursuitLimits.from_settings()
                        elevate = decide_elevation(
                            target_outpacing=is_outpaced(
                                forward_m_s, MAX_PURSUIT_SPEED_M_S, limits,
                                target_growing_distance=range_err > 0.01,
                            ),
                            agl_m=agl,
                            depression_deg=depression,
                            limits=limits,
                        )
                        if elevate.elevating:
                            down_m_s = elevate.climb_m_s
                        state["elevate"] = elevate.to_dict()
                    if elevate is None:
                        state["elevate"] = None

                    # THE ALTITUDE FLOOR AND CEILING — see pursuit.limit_descent
                    # and limit_climb. Applied here, at the single point every
                    # vertical command converges on. The ceiling matters most
                    # for the operator's ▲ nudge, which reached down_m_s having
                    # passed no altitude check at all.
                    _limits = PursuitLimits.from_settings()
                    down_m_s, floor_reason = limit_descent(
                        down_m_s, agl_for_floor, _limits
                    )
                    down_m_s, ceiling_reason = limit_climb(
                        down_m_s, agl_for_floor, _limits
                    )
                    state["altitude_floor_reason"] = floor_reason or ceiling_reason

                    # Row ranging assumes a held altitude; if the aircraft is
                    # climbing or descending the reference must be re-taken or
                    # the drone reads its own climb as the subject approaching.
                    if row_reference_is_stale(alt_mode, down_m_s):
                        state["target_row"] = clamp_row_target(foot_n)
                        state["row_pd"].reset()

                    raw = {
                        "type":        "velocity",
                        "forward_m_s": forward_m_s,
                        "right_m_s":   0.0,
                        "down_m_s":    down_m_s,
                        "yaw_deg_s":   yaw_deg_s,
                    }
                    cmd = smoother.smooth(raw)
                    drone_command = {
                        "type":        "velocity",
                        "forward_m_s": round(cmd["forward_m_s"], 3),
                        "right_m_s":   0.0,
                        "down_m_s":    round(cmd["down_m_s"], 3),
                        "yaw_deg_s":   round(cmd["yaw_deg_s"], 3),
                    }
                    state["last_drone_command"] = drone_command

            else:
                state["frames_lost"] = state.get("frames_lost", 0) + 1
                fl = state["frames_lost"]
                state["height_ema"] = None

                if tracking and target_id is not None:
                    searching = True
                    if fl <= _PHASE_HOLD:
                        drone_command = state.get("last_drone_command")
                    elif fl <= _PHASE_SWEEP:
                        drone_command = {
                            "type":        "velocity",
                            "forward_m_s": 0.0,
                            "right_m_s":   0.0,
                            "down_m_s":    0.0,
                            "yaw_deg_s":   round(12.0 * state.get("last_yaw_dir", 1.0), 1),
                        }
                    else:
                        drone_command = {
                            "type":        "velocity",
                            "forward_m_s": 0.0,
                            "right_m_s":   0.0,
                            "down_m_s":    0.0,
                            "yaw_deg_s":   0.0,
                        }

            break  # single session per analyzer instance

        meta: Dict[str, Any] = {
            "persons":        [{"id": p["id"], "box": p["box"], "conf": p["conf"]} for p in persons],
            "person_count":   len(persons),
            "target_id":      target_id,
            "tracking":       tracking,
            "searching":      searching,
            "face_confirmed": face_confirmed,
            "frames_lost":    state.get("frames_lost", 0),
            "similarity":     round(similarity, 3),
            "drone_command":  drone_command,
            # Gallery mode. person_name is what the overlay renders; None
            # when matching a reference photo, which has no name attached.
            "gallery_mode":   state.get("gallery_mode", False),
            "person_name":    state.get("locked_person_name") or None,
            "person_id":      state.get("locked_person_id"),
            "gallery_margin": (round(state["gallery_margin"], 3)
                               if state.get("gallery_margin") is not None else None),
            "gallery_size":   (self._gallery.person_count
                               if self._gallery is not None else 0),
            # EVERY identified person in frame, not only the followed one.
            # This is what lets the overlay put a name on each face rather
            # than a generic box, and it is deliberately independent of who
            # holds the lock.
            "identities":     [
                {
                    "track_id": tid,
                    "person_id": e["person_id"],
                    "name": e["name"],
                    "similarity": round(e["last_sim"], 3),
                    "best_similarity": round(e["best_sim"], 3),
                    "votes": e["votes"],
                    "margin": (round(e["margin"], 3)
                               if e.get("margin") is not None else None),
                }
                for tid, e in (state.get("identities") or {}).items()
            ],
            "identified_count": len(state.get("identities") or {}),
            # Live enrolment progress, so the operator can see shots landing
            # instead of wondering whether the button did anything.
            "capture": ({
                "name": state["capture"]["name"],
                "track_id": state["capture"]["track_id"],
                "shots": len(state["capture"]["paths"]),
                "needed": _CAPTURE_SHOTS,
            } if state.get("capture") else None),
            # Whether the operator picked this target or the tracker did,
            # and how long the lock has left before it frees up. Shown so
            # nobody has to guess why the drone did or did not switch.
            "lock_manual":    state.get("lock_manual", False),
            "lock_hold_s":    (_MANUAL_LOCK_HOLD_S if state.get("lock_manual")
                               else _LOCK_RELEASE_S),
        }
        # Named lock state + the auto-elevate decision. Both are reported even
        # when nothing is happening: an operator has to be able to tell
        # "coasting through an occlusion" from "guessing", and a climb the
        # pilot cannot explain is a climb they will fight.
        seen_t = state.get("last_seen_t", 0.0)
        lost_s = (time.monotonic() - seen_t) if seen_t else 0.0
        lock, lock_msg = lock_state_for(
            visible=(target_id is not None
                 and state.get("frames_lost", 0) == 0),
            seconds_lost=lost_s, tracking=tracking
        )
        meta["lock_state"] = lock.value
        meta["lock_message"] = lock_msg
        meta["seconds_lost"] = round(lost_s, 1)
        meta["elevate"] = state.get("elevate")
        # Enrolment shots are captured in this worker thread but written to
        # the gallery from the event loop — same split as plate rows.
        finished = self._run_capture(frame_bgr, persons, state) if state else None
        if finished:
            meta["_pending_enrolment"] = finished

        if pending_db:
            meta["_pending_db"] = pending_db
        return frame_bgr, meta

    # Drawing happens per CAMERA frame in stream_track (not per inference)
    # so the video stays as smooth as the fly tab; annotations lag by at
    # most one inference.
    def _range_observable(self, h_ema, pose, ctx, fx_n, fy_n, foot_n, W, H, subject_h_m):
        """
        Distance observable in size-ratio units, blending the two estimates a
        single camera can give.

        SIZE (de-foreshortened) is the primary and the only one that works
        without telemetry. POSITION (where the subject's feet meet the ground
        plane) is fused in as the view steepens, because that is exactly where
        the size estimate degrades and the position one sharpens — see
        geometry.blend_weight_for_position for the measured crossover.

        Returns h_ema unchanged when there is no pose, so every no-telemetry
        path behaves exactly as it did before this existed.
        """
        from app.vision import calibration as _cal
        from app.vision.geometry import (
            blend_weight_for_position, camera_from_settings, size_ratio_from_ground_range,
        )
        if pose is None or ctx is None:
            return h_ema, None

        cam = camera_from_settings(ctx.width or W, ctx.height or H)
        # TWO DIFFERENT PIXELS ON PURPOSE. The de-foreshortening angle belongs
        # at the subject's mid-height, because that is the vertical extent being
        # foreshortened. The ground projection below belongs at the feet. Using
        # one pixel for both is what put a forward bias in the range estimate.
        px, py = fx_n * W, fy_n * H
        phi = pose.depression_deg(cam, px, py)
        if phi is None:
            return h_ema, None

        ref = _cal.effective()["camera_mount_tilt_deg"]
        from_size = deforeshorten_size(h_ema, phi, ref)

        # FEET, NOT CENTRE. The comment here said exactly this while the code
        # passed the box centre, and the centre floats half a subject's height
        # off the ground — so its ray cleared the subject and struck the ground
        # BEYOND them. The over-estimate is AGL/(AGL - h/2), independent of
        # viewing angle: +17% at 6 m AGL, +27% at 4 m, +40% at 3 m. Range too
        # long reads as "further than wanted", which commands FORWARD, and the
        # position estimate is weighted in hardest at steep depression — i.e.
        # exactly when the subject is low in the frame and the drone should have
        # been backing off. Reported from flight as "person on the lower side of
        # frame and it moves forward instead of back".
        projected = pose.project_to_ground(cam, px, foot_n * H)
        if projected is None:
            return from_size, phi
        from_pos = size_ratio_from_ground_range(
            projected[2], subject_h_m, cam, H, ref
        )
        if from_pos is None:
            return from_size, phi

        w = blend_weight_for_position(phi)
        return (1.0 - w) * from_size + w * from_pos, phi

    def draw_overlay(self, frame_bgr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        H, W = frame_bgr.shape[:2]
        _C_ACTIVE = (200, 220, 50)
        _C_LOCKED = (30, 190, 255)
        _C_DIM    = (55, 55, 55)
        _C_SCAN   = (200, 130, 60)
        # Recognised but NOT being followed. Deliberately different from
        # both _C_ACTIVE (following) and _C_LOCKED (target acquired) so an
        # operator can tell at a glance which named person the drone is
        # actually chasing.
        _C_IDENT  = (170, 120, 220)

        persons        = meta.get("persons", [])
        target_id      = meta.get("target_id")
        tracking       = meta.get("tracking", False)
        searching      = meta.get("searching", False)
        face_confirmed = meta.get("face_confirmed", False)

        # ── Name everyone identified ─────────────────────────────────
        # Drawn for every gallery match in frame, including people who are not
        # being followed. Showing a name is the point of face recognition; a
        # box labelled "PERSON FOUND" tells an operator nothing they could not
        # already see.
        identities = {i["track_id"]: i for i in meta.get("identities", [])}
        for p in persons:
            if p["id"] == target_id:
                continue          # the target gets its own richer label below
            ident = identities.get(p["id"])
            x1, y1, x2, y2 = p["box"]
            if ident:
                # Named but not followed: distinct colour so the operator can
                # tell "recognised" from "being chased" at a glance.
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_IDENT, thickness=2)
                _draw_pill(
                    frame_bgr,
                    f"  {ident['name'].upper()}  {ident['similarity']:.2f}  ",
                    x1, y1, _C_IDENT,
                )
            elif face_confirmed:
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_DIM, thickness=1)

        target_p = next((p for p in persons if p["id"] == target_id), None)
        if target_p is not None:
            x1, y1, x2, y2 = target_p["box"]
            tx, ty = (x1 + x2) // 2, (y1 + y2) // 2
            px_cx = W // 2
            px_cy = H // 2

            # A named gallery match replaces the generic label — the whole
            # point of the demo is seeing WHO the drone thinks it has found,
            # not merely that it found somebody. Similarity travels with the
            # name so an operator can see a marginal identification as
            # marginal instead of trusting a bare label.
            person_name = meta.get("person_name")
            sim = meta.get("similarity", 0.0)
            label_found = (f"  {person_name.upper()}  {sim:.2f}  " if person_name
                           else "  PERSON FOUND  ")
            label_follow = (f"  FOLLOWING {person_name.upper()}  " if person_name
                            else "  FOLLOWING  ")

            if tracking:
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_ACTIVE, thickness=3)
                for px_, py_ in [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]:
                    cv2.circle(frame_bgr, (px_, py_), 4, _C_ACTIVE, -1, cv2.LINE_AA)
                cv2.line(frame_bgr, (px_cx, px_cy), (tx, ty), (*_C_ACTIVE[:2], 80), 1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (px_cx, px_cy), 4, _C_ACTIVE, -1, cv2.LINE_AA)
                cv2.circle(frame_bgr, (tx, ty), 10, _C_ACTIVE, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 15, ty), (tx + 15, ty), _C_ACTIVE, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 15), (tx, ty + 15), _C_ACTIVE, 1, cv2.LINE_AA)
                _draw_pill(frame_bgr, label_follow, x1, y1, _C_ACTIVE)
            else:
                draw_brackets(frame_bgr, x1, y1, x2, y2, _C_LOCKED, thickness=2)
                cv2.circle(frame_bgr, (tx, ty), 6, _C_LOCKED, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx - 10, ty), (tx + 10, ty), _C_LOCKED, 1, cv2.LINE_AA)
                cv2.line(frame_bgr, (tx, ty - 10), (tx, ty + 10), _C_LOCKED, 1, cv2.LINE_AA)
                _draw_pill(frame_bgr, label_found, x1, y1, _C_LOCKED)

            # A thin margin means the gallery cannot really separate two
            # enrolled people on this frame. Saying so is more useful than a
            # confident name that happens to be a coin flip.
            margin = meta.get("gallery_margin")
            if person_name and margin is not None and margin < 0.08:
                _draw_corner_status(
                    frame_bgr, f"  LOW CONFIDENCE  margin {margin:.2f}  ", (0, 165, 255)
                )

        if searching:
            fl = meta.get("frames_lost", 0)
            if fl > _PHASE_SWEEP:
                _draw_corner_status(frame_bgr, "  Hovering...  ", _C_SCAN)
            elif fl > _PHASE_HOLD:
                _draw_corner_status(frame_bgr, "  Sweeping...  ", _C_SCAN)
            else:
                _draw_corner_status(frame_bgr, "  Searching...  ", _C_SCAN)
        elif face_confirmed and target_p is None:
            _draw_corner_status(frame_bgr, "  Looking for person...  ", _C_SCAN)

        return frame_bgr

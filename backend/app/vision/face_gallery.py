"""
Face gallery — enrolment and matching against a database of known people.
=========================================================================

Complements, and does not replace, the reference-photo flow in
person_tracker.py. That one answers "follow THIS person, here is their
photo". This one answers "watch for anyone on this list, and tell me who
they are" — which is what makes an unattended spot-and-follow possible, with
no operator selecting a target first.

POSTGRES IS THE STORE; RAM IS THE INDEX
    Matching never queries the database. Every active embedding is loaded
    into one (N, 512) float32 matrix at session start, and a match is a
    single matmul — microseconds for the hundreds-to-thousands of faces this
    is built for, against milliseconds per DB round trip at 30 fps. Same
    reasoning, and the same trade-off, as zones/engine.py's STRtree: a row
    edited directly in SQL is invisible until reload() runs.

    pgvector only starts to earn its place past ~100k identities. A 512-dim
    float32 vector is 2 KB, so 10,000 people is 20 MB of RAM.

WHY MAX AND NOT MEAN ACROSS A PERSON'S PHOTOS
    Several photos per person is the point — different angles, lighting,
    years. Averaging their embeddings produces a centroid that can sit
    between two genuinely different appearances and match neither well. The
    score for a person is therefore the BEST of their faces, not the mean.

CROSS-MODEL COMPARISON IS REFUSED, NOT SILENTLY WRONG
    buffalo_sc and buffalo_l are both 512-dim, so mixing them raises nothing
    and looks fine — it just yields meaningless similarities and confident
    misidentification. Embeddings carry their model name and anything from a
    different model is excluded from the index with a loud warning.
"""
import asyncio
import contextlib
import logging
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from app.config import ROOT_DIR

logger = logging.getLogger("verocore.vision.face_gallery")

# Enrolled originals. Kept because they are the RE-ENROLMENT path: swapping
# the embedding model invalidates every stored vector, and only the source
# images can regenerate them.
GALLERY_ROOT = os.path.join(str(ROOT_DIR), ".data", "face_gallery")

EMBED_MODEL_NAME = "buffalo_sc"   # must match person_tracker's FaceAnalysis
EMBED_DIM = 512

# Cosine similarity thresholds. 0 = unrelated, 1 = identical.
#
# MATCH is the bar for naming someone. person_tracker uses 0.45 for a
# reference photo the operator chose and is watching; naming a person out of
# a gallery with nobody confirming it deserves more, hence 0.50.
#
# RELOCK is deliberately higher still. Re-acquiring after losing a target is
# unsupervised, and the cost of getting it wrong is a drone autonomously
# following the wrong human being — the worst failure this system has. A
# stricter bar means occasionally refusing a real re-acquisition, which is the
# right way to be wrong.
DEFAULT_MATCH_THRESHOLD = 0.50
DEFAULT_RELOCK_THRESHOLD = 0.60

# Image extensions accepted by folder enrolment.
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


# --------------------------------------------------------------------------- #
# Embedding extraction                                                          #
# --------------------------------------------------------------------------- #

_face_app = None
_face_app_lock = asyncio.Lock()


def _build_face_app():
    """
    A FaceAnalysis instance for ENROLMENT only, separate from the one each
    PersonTracker owns.

    Enrolment happens outside any session (an operator uploading photos), so
    it cannot borrow a tracker's model — there may not be a tracker running.
    Providers mirror person_tracker.py, including the HEURISTIC conv search:
    ORT's default EXHAUSTIVE benchmarks every algorithm on first inference
    and stalls for seconds.
    """
    import insightface
    import torch
    providers = (
        [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
         "CPUExecutionProvider"]
        if torch.cuda.is_available()
        else ["CPUExecutionProvider"]
    )
    app = insightface.app.FaceAnalysis(name=EMBED_MODEL_NAME, providers=providers)
    app.prepare(ctx_id=0 if torch.cuda.is_available() else -1, det_size=(640, 640))
    logger.info(f"Face gallery: enrolment model {EMBED_MODEL_NAME} ready")
    return app


async def get_face_app():
    """Lazily built and shared. The lock keeps two concurrent enrolments from
    each paying the load cost and leaving one instance orphaned."""
    global _face_app
    if _face_app is None:
        async with _face_app_lock:
            if _face_app is None:
                _face_app = await asyncio.to_thread(_build_face_app)
    return _face_app


def extract_embedding(
    face_app, img_bgr: np.ndarray
) -> Tuple[Optional[np.ndarray], float, Optional[np.ndarray]]:
    """
    Largest face in the image -> (unit embedding, det_score, padded crop).

    Largest rather than highest-scoring: an enrolment photo is of one person,
    and when a bystander is also in frame the subject is the bigger face. The
    vector is L2-normalised here so downstream cosine similarity is a plain
    dot product, matching person_tracker.extract_reference_embedding.
    """
    faces = face_app.get(img_bgr)
    if not faces:
        return None, 0.0, None
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    emb = np.asarray(face.embedding, dtype=np.float32).copy()
    norm = float(np.linalg.norm(emb))
    if norm <= 0:
        return None, 0.0, None
    emb /= norm

    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    pad = max(10, int((x2 - x1) * 0.25))
    h, w = img_bgr.shape[:2]
    crop = img_bgr[max(0, y1 - pad):min(h, y2 + pad),
                   max(0, x1 - pad):min(w, x2 + pad)]
    return emb, float(getattr(face, "det_score", 0.0) or 0.0), crop


def pack(embedding: np.ndarray) -> bytes:
    """float32 -> 2048 raw bytes for the bytea column."""
    return np.asarray(embedding, dtype=np.float32).tobytes()


def unpack(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


# --------------------------------------------------------------------------- #
# Matcher                                                                       #
# --------------------------------------------------------------------------- #

@dataclass
class GalleryMatch:
    person_id: str
    name: str
    similarity: float
    face_id: str

    def to_dict(self) -> dict:
        return {
            "person_id": self.person_id,
            "name": self.name,
            "similarity": round(self.similarity, 4),
            "face_id": self.face_id,
        }


class FaceGallery:
    """
    An immutable in-memory snapshot of the enrolled gallery.

    Built by load(); never mutated afterwards, so a live analyzer thread can
    read it without locking while a reload builds a replacement alongside it.
    """

    def __init__(self):
        self._matrix: Optional[np.ndarray] = None   # (N, 512), rows unit-norm
        self._person_ids: List[str] = []
        self._names: List[str] = []
        self._face_ids: List[str] = []
        self.model_name: str = EMBED_MODEL_NAME
        self.skipped_wrong_model: int = 0

    # ---------------------------------------------------------------- #

    @property
    def size(self) -> int:
        return 0 if self._matrix is None else int(self._matrix.shape[0])

    @property
    def person_count(self) -> int:
        return len(set(self._person_ids))

    def is_empty(self) -> bool:
        return self.size == 0

    def build(self, rows: Sequence[Tuple[str, str, str, bytes, str]]) -> "FaceGallery":
        """
        rows: (face_id, person_id, person_name, embedding_blob, model_name)

        Rows from a different embedding model are dropped rather than
        included — see the module docstring. Dropping is the safe direction:
        a smaller gallery misses people, a poisoned one names the wrong ones.
        """
        vecs, pids, names, fids = [], [], [], []
        skipped = 0
        for face_id, person_id, name, blob, model_name in rows:
            if model_name != self.model_name:
                skipped += 1
                continue
            v = unpack(blob)
            if v.size != EMBED_DIM:
                skipped += 1
                continue
            n = float(np.linalg.norm(v))
            if n <= 0:
                skipped += 1
                continue
            # Re-normalise defensively: a vector stored before normalisation
            # was enforced would otherwise scale every similarity it touches.
            vecs.append(v / n)
            pids.append(person_id)
            names.append(name)
            fids.append(face_id)

        self.skipped_wrong_model = skipped
        if skipped:
            logger.warning(
                f"Face gallery: skipped {skipped} embedding(s) not from "
                f"{self.model_name} — re-enrol those photos to include them "
                f"(cross-model similarity is meaningless, not merely noisy)"
            )
        self._matrix = np.vstack(vecs).astype(np.float32) if vecs else None
        self._person_ids, self._names, self._face_ids = pids, names, fids
        logger.info(
            f"Face gallery: {self.size} face(s) across {self.person_count} "
            f"person(s) indexed in memory"
        )
        return self

    # ---------------------------------------------------------------- #

    def match(
        self, embedding: np.ndarray, threshold: float = DEFAULT_MATCH_THRESHOLD
    ) -> Optional[GalleryMatch]:
        """Best-scoring person above `threshold`, or None."""
        best = self.match_all(embedding, threshold, limit=1)
        return best[0] if best else None

    def match_all(
        self,
        embedding: np.ndarray,
        threshold: float = DEFAULT_MATCH_THRESHOLD,
        limit: int = 5,
    ) -> List[GalleryMatch]:
        """
        Every person above threshold, best first, one entry per person.

        Returning the runners-up is not decoration: two gallery members
        scoring close together is exactly when a match should not be trusted,
        and the caller cannot see that from a single best answer.
        """
        if self._matrix is None or embedding is None:
            return []
        q = np.asarray(embedding, dtype=np.float32).ravel()
        if q.size != EMBED_DIM:
            return []
        n = float(np.linalg.norm(q))
        if n <= 0:
            return []
        q = q / n

        sims = self._matrix @ q            # rows are unit-norm, so this is cosine

        # Collapse to the best face per person — never the mean.
        best_per_person: Dict[str, Tuple[float, int]] = {}
        for i, s in enumerate(sims):
            pid = self._person_ids[i]
            prev = best_per_person.get(pid)
            if prev is None or s > prev[0]:
                best_per_person[pid] = (float(s), i)

        out = [
            GalleryMatch(pid, self._names[i], s, self._face_ids[i])
            for pid, (s, i) in best_per_person.items()
            if s >= threshold
        ]
        out.sort(key=lambda m: m.similarity, reverse=True)
        return out[:limit]

    def margin(self, embedding: np.ndarray) -> Optional[float]:
        """
        Gap between the best and second-best PERSON.

        A high top score with a thin margin means the gallery cannot really
        tell two enrolled people apart on this frame — worth surfacing rather
        than reporting a confident name. None when fewer than two people are
        above the floor.
        """
        top = self.match_all(embedding, threshold=0.0, limit=2)
        if len(top) < 2:
            return None
        return top[0].similarity - top[1].similarity


# --------------------------------------------------------------------------- #
# Folder enrolment                                                              #
# --------------------------------------------------------------------------- #

@dataclass
class EnrolmentResult:
    """Per-image outcome. Enrolment is reported image by image because a
    silently skipped photo (no face found, too blurry) is the difference
    between a demo that works and one that does not."""
    person_name: str
    filename: str
    ok: bool
    reason: str = ""
    det_score: float = 0.0


def discover_folder(root: str) -> Dict[str, List[str]]:
    """
    Read a `<root>/<person name>/<image>` tree into {name: [paths]}.

    This is the layout of the provided sample set
    ("sample human faces/photos/srikar/*.jpg"), so enrolling it needs no
    reshuffling: the directory name is the person's name.
    """
    out: Dict[str, List[str]] = {}
    if not os.path.isdir(root):
        return out
    for entry in sorted(os.listdir(root)):
        person_dir = os.path.join(root, entry)
        if not os.path.isdir(person_dir):
            continue
        images = [
            os.path.join(person_dir, f)
            for f in sorted(os.listdir(person_dir))
            if os.path.splitext(f)[1].lower() in _IMAGE_EXTS
        ]
        if images:
            out[entry] = images
    return out


def copy_into_gallery(person_id: str, src_path: str, index: int) -> Optional[str]:
    """
    Copy an enrolled original under GALLERY_ROOT/<person_id>/.

    Copied rather than referenced because the source is usually a folder the
    operator will move or delete, and losing the originals means losing the
    ability to re-enrol when the embedding model changes.
    """
    try:
        os.makedirs(os.path.join(GALLERY_ROOT, person_id), exist_ok=True)
        ext = os.path.splitext(src_path)[1].lower() or ".jpg"
        dst = os.path.join(GALLERY_ROOT, person_id, f"{index:03d}{ext}")
        with open(src_path, "rb") as fh_in, open(dst, "wb") as fh_out:
            fh_out.write(fh_in.read())
        return dst
    except OSError as e:
        logger.warning(f"Face gallery: could not copy {src_path}: {e}")
        return None


def delete_gallery_files(paths: Sequence[Optional[str]]) -> None:
    """Unlink image files, and prune any now-empty person directory."""
    dirs = set()
    for p in paths:
        if not p:
            continue
        with contextlib.suppress(OSError):
            os.remove(p)
            dirs.add(os.path.dirname(p))
    for d in dirs:
        with contextlib.suppress(OSError):
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)

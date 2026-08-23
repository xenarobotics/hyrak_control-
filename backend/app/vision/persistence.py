"""
Generic DB persistence for crowd-management / vehicle-plate-tracking meta
side effects, plus session/history export and manual cleanup.

Analyzer modules decide WHEN to persist (throttling snapshots, finalizing a
plate track) inside their own blocking _analyze_frame_blocking, since
that's where their per-session state already lives. They queue the
decision onto meta["_pending_db"]; app/webrtc/stream_track.py's recv()
(already running in the event loop - same precedent as its drone_command
dispatch) pops that key and hands it to persist_events() here.

Data model: crowd/plate rows are retained by default (no auto-purge) so an
operator can review a "previous session" from the sidebar without having
downloaded anything first. Two ways data leaves the DB: an operator
downloads a report (export_*_report - read-only, doesn't delete anything)
or explicitly clears history (clear_*_history). Nothing is ever purged
silently - that's a deliberate reversal of this feature's first version,
which auto-purged on every stop; Japesh wanted a browsable history instead.
"""
import contextlib
import logging
import os

from sqlalchemy import delete, func, select

from app.db import db_available, get_session
from app.db.models import (
    CrowdAlert, CrowdSnapshot, Person, PersonFace, PersonSighting, PlateEvent,
)

logger = logging.getLogger("verocore.vision.persistence")

_WRITERS = {
    "crowd_snapshot": CrowdSnapshot,
    "crowd_alert": CrowdAlert,
    "plate_event": PlateEvent,
    "person_sighting": PersonSighting,
}


async def persist_events(session_id: str, events: list[dict]) -> None:
    """Live-write path, called per camera frame when an analyzer queues
    something. Cheap no-op when the DB is offline - vision must never
    depend on persistence to keep working."""
    if not events or not db_available():
        return
    try:
        async with get_session() as db:
            for ev in events:
                model = _WRITERS.get(ev.get("table"))
                if not model:
                    continue
                fields = {k: v for k, v in ev.items() if k != "table"}
                fields.setdefault("session_id", session_id)
                db.add(model(**fields))
            await db.commit()
    except Exception as e:
        logger.warning(f"Vision event persist error: {e}")


def _delete_image_files(paths: list[str]) -> None:
    for p in paths:
        if p:
            with contextlib.suppress(OSError):
                os.remove(p)


# ── Per-session report export (read-only - for the manual "Download        ──
# ── report" button; never deletes anything)                                ──

async def export_crowd_report(session_id: str) -> dict:
    if not db_available():
        return {"snapshots": [], "alerts": []}
    try:
        async with get_session() as db:
            snaps = (
                await db.execute(
                    select(CrowdSnapshot).where(CrowdSnapshot.session_id == session_id).order_by(CrowdSnapshot.t)
                )
            ).scalars().all()
            alerts = (
                await db.execute(
                    select(CrowdAlert).where(CrowdAlert.session_id == session_id).order_by(CrowdAlert.t)
                )
            ).scalars().all()
            return {
                "snapshots": [s.to_dict() for s in snaps],
                "alerts": [a.to_dict() for a in alerts],
            }
    except Exception as e:
        logger.warning(f"Crowd report export error: {e}")
        return {"snapshots": [], "alerts": []}


async def export_plate_report(session_id: str) -> list[dict]:
    if not db_available():
        return []
    try:
        async with get_session() as db:
            rows = (
                await db.execute(
                    select(PlateEvent).where(PlateEvent.session_id == session_id).order_by(PlateEvent.first_seen)
                )
            ).scalars().all()
            return [r.to_dict() for r in rows]
    except Exception as e:
        logger.warning(f"Plate report export error: {e}")
        return []


# ── Cross-session history (for the "previous sessions" sidebar)            ──

async def list_crowd_history(limit: int = 10) -> dict:
    """Per-session summaries (from snapshot rows) + the most recent
    sustained-density alerts, most recent session first."""
    if not db_available():
        return {"sessions": [], "alerts": []}
    try:
        async with get_session() as db:
            rows = (
                await db.execute(
                    select(
                        CrowdSnapshot.session_id,
                        func.min(CrowdSnapshot.t).label("started"),
                        func.max(CrowdSnapshot.t).label("last_seen"),
                        func.max(CrowdSnapshot.peak_count).label("peak_count"),
                    )
                    .group_by(CrowdSnapshot.session_id)
                    .order_by(func.max(CrowdSnapshot.t).desc())
                    .limit(limit)
                )
            ).all()
            sessions = [
                {
                    "session_id": r.session_id,
                    "started": r.started.isoformat() if r.started else None,
                    "last_seen": r.last_seen.isoformat() if r.last_seen else None,
                    "peak_count": r.peak_count,
                }
                for r in rows
            ]
            alerts = (
                await db.execute(select(CrowdAlert).order_by(CrowdAlert.t.desc()).limit(limit * 3))
            ).scalars().all()
            return {"sessions": sessions, "alerts": [a.to_dict() for a in alerts]}
    except Exception as e:
        logger.warning(f"Crowd history query error: {e}")
        return {"sessions": [], "alerts": []}


async def list_plate_history(limit: int = 50) -> list[dict]:
    if not db_available():
        return []
    try:
        async with get_session() as db:
            rows = (
                await db.execute(select(PlateEvent).order_by(PlateEvent.first_seen.desc()).limit(limit))
            ).scalars().all()
            return [r.to_dict() for r in rows]
    except Exception as e:
        logger.warning(f"Plate history query error: {e}")
        return []


async def get_plate_image_path(event_id: str) -> str | None:
    if not db_available():
        return None
    try:
        async with get_session() as db:
            row = (
                await db.execute(select(PlateEvent).where(PlateEvent.id == event_id))
            ).scalar_one_or_none()
            return row.image_path if row else None
    except Exception as e:
        logger.warning(f"Plate image lookup error: {e}")
        return None


# ── Manual cleanup (operator-triggered - "Clear history" in the sidebar)   ──

async def clear_crowd_history() -> None:
    if not db_available():
        return
    try:
        async with get_session() as db:
            await db.execute(delete(CrowdSnapshot))
            await db.execute(delete(CrowdAlert))
            await db.commit()
    except Exception as e:
        logger.warning(f"Crowd history clear error: {e}")


async def clear_plate_history() -> None:
    if not db_available():
        return
    image_paths: list[str] = []
    try:
        async with get_session() as db:
            rows = (await db.execute(select(PlateEvent))).scalars().all()
            # Both images per row - the plate crop AND the vehicle shot.
            # Collecting only image_path would leave every _vehicle.jpg behind
            # as an orphan after a "clear history", growing without bound.
            image_paths = [
                p for r in rows for p in (r.image_path, r.vehicle_image_path) if p
            ]
            await db.execute(delete(PlateEvent))
            await db.commit()
    except Exception as e:
        logger.warning(f"Plate history clear error: {e}")
    _delete_image_files(image_paths)


# ── Face gallery ─────────────────────────────────────────────────────────────
#
# Unlike everything above, these rows are DURABLE BIOMETRIC IDENTITY and have
# no auto-purge path. delete_person() and clear_face_gallery() are the only
# ways they leave, and both unlink the image files as well - a bare SQL DELETE
# orphans them, exactly as it does for plate_events.image_path.

async def load_face_gallery():
    """
    Read every ACTIVE embedding into an in-memory FaceGallery.

    Called once per session start, not per frame - see face_gallery.py on why
    Postgres is the store and RAM is the index. Returns an empty gallery when
    the DB is offline so gallery mode degrades to "matches nobody" instead of
    breaking the tracker.
    """
    from app.vision.face_gallery import FaceGallery

    gallery = FaceGallery()
    if not db_available():
        logger.info("Face gallery: DB offline - gallery mode will match nobody")
        return gallery
    try:
        async with get_session() as db:
            rows = (await db.execute(
                select(
                    PersonFace.id, PersonFace.person_id, Person.name,
                    PersonFace.embedding, PersonFace.model_name,
                )
                .join(Person, Person.id == PersonFace.person_id)
                .where(Person.active.is_(True))
                .order_by(Person.name)
            )).all()
        return gallery.build([tuple(r) for r in rows])
    except Exception as e:
        logger.warning(f"Face gallery load error: {e}")
        return gallery


async def list_persons() -> list[dict]:
    """Enrolled people with their photo counts, for the gallery UI."""
    if not db_available():
        return []
    try:
        async with get_session() as db:
            counts = dict((await db.execute(
                select(PersonFace.person_id, func.count(PersonFace.id))
                .group_by(PersonFace.person_id)
            )).all())
            people = (await db.execute(
                select(Person).order_by(Person.name)
            )).scalars().all()
            return [p.to_dict(face_count=counts.get(p.id, 0)) for p in people]
    except Exception as e:
        logger.warning(f"Person list error: {e}")
        return []


async def get_person_by_name(name: str):
    """Used by folder enrolment to add photos to an existing person rather
    than creating a duplicate on a second run."""
    if not db_available():
        return None
    try:
        async with get_session() as db:
            return (await db.execute(
                select(Person).where(Person.name == name)
            )).scalars().first()
    except Exception as e:
        logger.warning(f"Person lookup error: {e}")
        return None


async def set_person_active(person_id: str, active: bool) -> bool:
    """Soft enable/disable - takes someone out of matching without destroying
    the enrolment, so a misfiring match can be investigated."""
    if not db_available():
        return False
    try:
        async with get_session() as db:
            person = (await db.execute(
                select(Person).where(Person.id == person_id)
            )).scalars().first()
            if not person:
                return False
            person.active = active
            await db.commit()
            return True
    except Exception as e:
        logger.warning(f"Person activate error: {e}")
        return False


async def delete_person(person_id: str) -> bool:
    """
    Remove a person, their embeddings, and their image files.

    Faces CASCADE in the schema; the files do not, so their paths are
    collected before the delete and unlinked after. Sightings are SET NULL
    rather than removed - deleting someone from the gallery must not rewrite
    the record of what the system did while they were in it.
    """
    if not db_available():
        return False
    from app.vision.face_gallery import delete_gallery_files
    paths: list[str] = []
    try:
        async with get_session() as db:
            faces = (await db.execute(
                select(PersonFace).where(PersonFace.person_id == person_id)
            )).scalars().all()
            paths = [f.image_path for f in faces if f.image_path]
            person = (await db.execute(
                select(Person).where(Person.id == person_id)
            )).scalars().first()
            if not person:
                return False
            await db.delete(person)
            await db.commit()
    except Exception as e:
        logger.warning(f"Person delete error: {e}")
        return False
    delete_gallery_files(paths)
    return True


async def clear_face_gallery() -> None:
    """Wipe every enrolled identity and its images. The explicit deletion
    path this data category requires."""
    if not db_available():
        return
    from app.vision.face_gallery import delete_gallery_files
    paths: list[str] = []
    try:
        async with get_session() as db:
            paths = [
                f.image_path for f in
                (await db.execute(select(PersonFace))).scalars().all()
                if f.image_path
            ]
            await db.execute(delete(PersonFace))
            await db.execute(delete(Person))
            await db.commit()
    except Exception as e:
        logger.warning(f"Face gallery clear error: {e}")
    delete_gallery_files(paths)


async def enrol_person_images(
    name: str, image_paths: list[str], notes: str = ""
) -> list:
    """
    Enrol one person from a list of image files.

    Adds to an existing person of the same name rather than creating a
    duplicate, so re-running folder enrolment is safe.

    Per-image results are returned rather than a count: a photo silently
    skipped for having no detectable face is the difference between a demo
    that works and one that quietly does not, and the operator needs to know
    which file to re-shoot.
    """
    from app.vision.face_gallery import (
        EnrolmentResult, EMBED_DIM, EMBED_MODEL_NAME,
        copy_into_gallery, extract_embedding, get_face_app, pack,
    )
    import asyncio

    results: list[EnrolmentResult] = []
    if not db_available():
        return [EnrolmentResult(name, os.path.basename(p), False, "database offline")
                for p in image_paths]

    import cv2
    face_app = await get_face_app()

    existing = await get_person_by_name(name)
    person_id = existing.id if existing else None

    try:
        async with get_session() as db:
            if person_id is None:
                person = Person(name=name, notes=notes)
                db.add(person)
                await db.flush()
                person_id = person.id
            start_index = int((await db.execute(
                select(func.count(PersonFace.id))
                .where(PersonFace.person_id == person_id)
            )).scalar() or 0)

            for offset, src in enumerate(image_paths):
                fname = os.path.basename(src)
                img = await asyncio.to_thread(cv2.imread, src)
                if img is None:
                    results.append(EnrolmentResult(name, fname, False, "unreadable image"))
                    continue
                emb, det_score, _crop = await asyncio.to_thread(
                    extract_embedding, face_app, img
                )
                if emb is None:
                    results.append(EnrolmentResult(
                        name, fname, False,
                        "no face detected - try a clearer, more frontal photo"))
                    continue
                stored = copy_into_gallery(person_id, src, start_index + offset)
                db.add(PersonFace(
                    person_id=person_id,
                    image_path=stored,
                    embedding=pack(emb),
                    embedding_dim=EMBED_DIM,
                    model_name=EMBED_MODEL_NAME,
                    det_score=det_score,
                    source_filename=fname,
                ))
                results.append(EnrolmentResult(name, fname, True, "", det_score))
            await db.commit()
    except Exception as e:
        logger.warning(f"Enrolment error for {name}: {e}")
        results.append(EnrolmentResult(name, "", False, str(e)))
    return results


async def enrol_from_folder(root: str) -> list:
    """
    Enrol a whole `<root>/<person name>/<image>` tree - the layout of the
    provided sample set, so it needs no reshuffling.
    """
    from app.vision.face_gallery import discover_folder
    found = discover_folder(root)
    if not found:
        logger.warning(f"Face gallery: no <name>/<image> folders under {root}")
        return []
    out = []
    for name, images in found.items():
        out.extend(await enrol_person_images(name, images))
    ok = sum(1 for r in out if r.ok)
    logger.info(
        f"Face gallery: enrolled {ok}/{len(out)} image(s) "
        f"across {len(found)} person(s) from {root}"
    )
    return out


async def list_sightings(session_id: str | None = None, limit: int = 200) -> list[dict]:
    """Gallery-match audit trail. Session-scoped when given a session_id."""
    if not db_available():
        return []
    try:
        async with get_session() as db:
            q = select(PersonSighting).order_by(PersonSighting.t.desc()).limit(limit)
            if session_id:
                q = q.where(PersonSighting.session_id == session_id)
            return [s.to_dict() for s in (await db.execute(q)).scalars().all()]
    except Exception as e:
        logger.warning(f"Sighting list error: {e}")
        return []


async def clear_sightings(session_id: str | None = None) -> None:
    if not db_available():
        return
    from app.vision.face_gallery import delete_gallery_files
    paths: list[str] = []
    try:
        async with get_session() as db:
            q = select(PersonSighting)
            if session_id:
                q = q.where(PersonSighting.session_id == session_id)
            rows = (await db.execute(q)).scalars().all()
            paths = [r.image_path for r in rows if r.image_path]
            d = delete(PersonSighting)
            if session_id:
                d = d.where(PersonSighting.session_id == session_id)
            await db.execute(d)
            await db.commit()
    except Exception as e:
        logger.warning(f"Sighting clear error: {e}")
    delete_gallery_files(paths)

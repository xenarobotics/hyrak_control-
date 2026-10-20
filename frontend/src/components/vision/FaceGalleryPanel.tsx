'use client'

// Enrolled-face database UI.
//
// Sits inside PersonTrackerPanel rather than being its own mode, because it is
// a second way to acquire a target for the SAME tracker - not a separate
// capability. The reference-photo upload above it is untouched.
//
// Two deliberate choices in this UI:
//
//   * Gallery mode is an explicit toggle, off by default. Face matching that
//     names people and steers the aircraft should never switch itself on.
//   * Per-file enrolment results are always shown. A photo skipped for having
//     no detectable face looks like success otherwise, and thin enrolment is
//     the single most common reason recognition disappoints in the field.

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSocket } from '@/lib/socket'
import {
    Database, FolderInput, Loader2, Trash2, UserPlus,
    Eye, EyeOff, AlertCircle, CheckCircle2,
} from 'lucide-react'
import {
    TONE, LABEL, SECONDARY, NUM, TILE, TEXT, MUTED, SUBTLE, SURFACE, BORDER, BORDER_STRONG,
    chip, btn, DISABLED, FOCUS,
} from './panelStyle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
    SAMPLE_FACES_PATH, clearGallery, deletePerson, enrolFolder, enrolPhotos,
    fetchGallery, setPersonActive, type EnrolResult, type GalleryPerson,
} from '@/lib/faceGallery'

/** One person recognised in the current frame. Independent of who holds the
 *  lock - several people can be identified while at most one is followed. */
export interface LiveIdentity {
    track_id: number
    person_id: string
    name: string
    similarity: number
    best_similarity: number
    votes: number
    margin: number | null
}

interface Props {
    /** The person being FOLLOWED, if any. */
    matchedPersonId?: string | null
    matchedName?: string | null
    similarity?: number
    /** Gap to the runner-up. A thin margin means the gallery cannot really
     *  separate two enrolled people on this frame. */
    margin?: number | null
    /** Everyone recognised right now. */
    identities?: LiveIdentity[]
    /** True when an operator picked the current target rather than the tracker. */
    lockManual?: boolean
}


export function FaceGalleryPanel({
    matchedPersonId, matchedName, similarity = 0, margin, identities = [],
    lockManual = false,
}: Props) {
    const [people, setPeople] = useState<GalleryPerson[]>([])
    const [loading, setLoading] = useState(false)
    const [galleryMode, setGalleryMode] = useState(false)
    const [enrolled, setEnrolled] = useState<{ faces: number } | null>(null)
    const [busy, setBusy] = useState<string>('')
    const [error, setError] = useState<string>('')
    const [results, setResults] = useState<EnrolResult[] | null>(null)
    const [newName, setNewName] = useState('')
    const fileRef = useRef<HTMLInputElement>(null)

    const reload = useCallback(async () => {
        setLoading(true)
        setPeople(await fetchGallery())
        setLoading(false)
    }, [])

    useEffect(() => { reload() }, [reload])

    // The backend reloads the gallery when the mode is enabled, so it reports
    // back what it actually indexed. Showing the server's count rather than
    // this component's list is what catches "enrolled but not picked up".
    useEffect(() => {
        const socket = getSocket()
        const onSet = (d: { enabled: boolean; enrolled: number; faces: number }) => {
            setGalleryMode(d.enabled)
            setEnrolled(d.enabled ? { faces: d.faces } : null)
        }
        socket.on('gallery_mode_set', onSet)
        return () => { socket.off('gallery_mode_set', onSet) }
    }, [])

    const toggleGalleryMode = () => {
        const next = !galleryMode
        setGalleryMode(next)               // optimistic; server confirms
        getSocket().emit('set_gallery_mode', { enabled: next })
    }

    // Ask the backend to follow a specific person, or null to hand control
    // back to automatic selection. Applied on the next face check - the person
    // has to be identified in frame before there is a body track to follow.
    const follow = (personId: string | null) => {
        getSocket().emit('set_follow_person', { person_id: personId })
    }

    const activeCount = people.filter(p => p.active).length
    const totalFaces = people.reduce((n, p) => n + p.face_count, 0)

    const runEnrolFolder = async () => {
        setBusy('folder'); setError(''); setResults(null)
        try {
            const out = await enrolFolder(SAMPLE_FACES_PATH)
            const flat: EnrolResult[] = []
            for (const [name, info] of Object.entries(out.persons)) {
                for (const f of info.failed) {
                    flat.push({ filename: `${name}/${f.filename}`, ok: false, reason: f.reason, det_score: 0 })
                }
                const ok = info.enrolled
                if (ok) flat.push({ filename: `${name} - ${ok} photo(s)`, ok: true, reason: '', det_score: 0 })
            }
            setResults(flat)
            await reload()
        } catch (e) {
            setError((e as Error).message)
        } finally { setBusy('') }
    }

    const runEnrolFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? [])
        if (!files.length) return
        if (!newName.trim()) { setError('Enter a name before choosing photos'); return }
        setBusy('files'); setError(''); setResults(null)
        try {
            const out = await enrolPhotos(newName.trim(), files)
            setResults(out.results)
            setNewName('')
            await reload()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy('')
            if (fileRef.current) fileRef.current.value = ''
        }
    }

    const remove = async (p: GalleryPerson) => {
        // Durable biometric data with no auto-purge - deletion is permanent
        // and takes the stored photos with it, so it is confirmed.
        if (!window.confirm(
            `Delete ${p.name} and all ${p.face_count} enrolled photo(s)?\n\n`
            + 'This erases the face data and the stored images permanently.'
        )) return
        setBusy(p.id); setError('')
        try { await deletePerson(p.id); await reload() }
        catch (e) { setError((e as Error).message) }
        finally { setBusy('') }
    }

    const toggleActive = async (p: GalleryPerson) => {
        setBusy(p.id)
        try { await setPersonActive(p.id, !p.active); await reload() }
        catch (e) { setError((e as Error).message) }
        finally { setBusy('') }
    }

    const wipe = async () => {
        if (!window.confirm(
            `Erase the entire gallery - ${people.length} person(s), ${totalFaces} photo(s)?\n\n`
            + 'This cannot be undone.'
        )) return
        setBusy('all')
        try { await clearGallery(); await reload() }
        catch (e) { setError((e as Error).message) }
        finally { setBusy('') }
    }

    const noPeople = people.length === 0
    const busyWhy = busy ? 'Wait for the current job to finish' : undefined
    const iconBtn: React.CSSProperties = {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: 6, border: 'none',
        background: 'transparent', cursor: 'pointer',
    }

    return (
        <div style={{
            ...TILE,
            display: 'flex', flexDirection: 'column', gap: 12, padding: 12,
        }}>
            {/* ── Header + mode toggle ─────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Database size={15} style={{ color: TONE.accent.fg }} aria-hidden />
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
                        Face database
                    </span>
                    <Tooltip>
                        <TooltipTrigger className={FOCUS} style={{
                            ...SECONDARY, ...NUM, cursor: 'help', background: 'none',
                            border: 'none', padding: 0, textAlign: 'left', borderRadius: 4,
                        }}>
                            {activeCount} of {people.length} active, {totalFaces} photos
                        </TooltipTrigger>
                        <TooltipContent style={{ maxWidth: 260, fontSize: 13, lineHeight: 1.5 }}>
                            Saved faces are matched against every face the drone sees.
                            Only <b>active</b> people are matched.
                        </TooltipContent>
                    </Tooltip>
                </div>

                <div style={{ marginLeft: 'auto' }}>
                    <Tooltip>
                        <TooltipTrigger
                            onClick={toggleGalleryMode}
                            disabled={noPeople}
                            aria-pressed={galleryMode}
                            className={FOCUS}
                            style={noPeople ? { ...btn(), ...DISABLED } : {
                                ...btn(),
                                ...(galleryMode ? {
                                    border: `1px solid ${TONE.accent.fg}`,
                                    background: TONE.accent.bg,
                                    color: TONE.accent.fg,
                                } : {}),
                            }}
                        >
                            <span aria-hidden style={{
                                width: 8, height: 8, borderRadius: '50%',
                                background: galleryMode ? TONE.accent.fg : 'currentColor',
                                opacity: galleryMode ? 1 : 0.6,
                            }} />
                            Auto-identify {galleryMode ? 'on' : 'off'}
                        </TooltipTrigger>
                        <TooltipContent style={{ maxWidth: 280, fontSize: 13, lineHeight: 1.5 }}>
                            {noPeople
                                ? 'Add at least one person first.'
                                : <>Match every face against the database and lock on by itself.
                                    An uploaded photo still wins.</>}
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* ── Recognised right now ─────────────────────────────────
                Lists EVERYONE identified, with the followed person marked.
                Naming only the target was the original mistake: a second
                enrolled person standing beside them went unlabelled. */}
            {galleryMode && identities.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={LABEL}>
                            Seen now ({identities.length})
                        </span>
                        {identities.length > 1 && (
                            <span style={{ ...SECONDARY, fontSize: 12 }}>
                                tap a name to follow
                            </span>
                        )}
                        {lockManual && (
                            <button
                                type="button"
                                onClick={() => follow(null)}
                                className={FOCUS}
                                style={{
                                    marginLeft: 'auto', border: 'none', background: 'none', borderRadius: 6,
                                    minHeight: 28, padding: '0 4px',
                                    fontSize: 13, fontWeight: 600, color: TONE.accent.fg, cursor: 'pointer',
                                }}
                            >
                                Back to auto
                            </button>
                        )}
                    </div>
                    {identities.map(id => {
                        const followed = id.person_id === matchedPersonId
                        return (
                            // Clickable: choosing a target by hand is the
                            // reliable way to override the tracker's own pick
                            // when two enrolled people are both in frame.
                            <button
                                type="button"
                                key={id.track_id}
                                onClick={() => follow(followed ? null : id.person_id)}
                                title={followed
                                    ? 'Release and go back to automatic'
                                    : `Follow ${id.name}`}
                                className={FOCUS}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    minHeight: 32, padding: '4px 10px', borderRadius: 6, fontSize: 13,
                                    cursor: 'pointer', textAlign: 'left', color: TEXT,
                                    background: followed ? TONE.accent.bg : SURFACE,
                                    border: `1px solid ${followed ? TONE.accent.border : BORDER}`,
                                }}
                            >
                                <span style={{ fontWeight: 700, color: followed ? TONE.accent.fg : TEXT }}>
                                    {id.name}
                                </span>
                                {followed && (
                                    <span style={chip('accent')}>
                                        {lockManual ? 'Following, manual' : 'Following'}
                                    </span>
                                )}
                                <span style={{ ...NUM, marginLeft: 'auto', color: MUTED }}>
                                    {id.similarity.toFixed(2)}
                                    {/* Vote count is the redundancy made visible:
                                        how many independent frames agree. */}
                                    <span style={{ color: SUBTLE }}> ({id.votes} votes)</span>
                                </span>
                                {id.margin != null && id.margin < 0.08 && (
                                    <span style={chip('warn')} title="Two saved people score alike">
                                        Unsure
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            )}

            {/* Followed-but-unnamed fallback (reference-photo path). */}
            {galleryMode && matchedName && identities.length === 0 && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    padding: '8px 10px', borderRadius: 6,
                    background: TONE.accent.bg,
                    border: `1px solid ${TONE.accent.border}`,
                }}>
                    <CheckCircle2 size={15} style={{ color: TONE.accent.fg }} aria-hidden />
                    <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
                        {matchedName}
                    </span>
                    <span style={{ ...NUM, fontSize: 13, color: MUTED }}>
                        {similarity.toFixed(2)}
                    </span>
                    {/* A confident-looking name with a thin margin is the case
                        worth flagging: two enrolled people are scoring alike. */}
                    {margin != null && margin < 0.08 && (
                        <span style={{ ...chip('warn'), marginLeft: 'auto' }}
                            title="Two saved people score alike on this frame">
                            Unsure (gap {margin.toFixed(2)})
                        </span>
                    )}
                </div>
            )}
            {galleryMode && enrolled && (
                <div style={{ ...SECONDARY, ...NUM }}>
                    Server loaded {enrolled.faces} face(s)
                </div>
            )}

            {/* ── Enrol ────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Person's name"
                    aria-label="Person's name"
                    className={FOCUS}
                    style={{
                        flex: 1, minWidth: 0, minHeight: 32, padding: '0 10px', fontSize: 14,
                        borderRadius: 6, background: SURFACE,
                        border: `1px solid ${BORDER_STRONG}`,
                        color: TEXT,
                    }}
                />
                <input
                    ref={fileRef} type="file" accept="image/*" multiple
                    onChange={runEnrolFiles} style={{ display: 'none' }}
                />
                <button
                    type="button"
                    disabled={!!busy}
                    title={busyWhy}
                    onClick={() => fileRef.current?.click()}
                    className={FOCUS}
                    style={busy ? { ...btn(), ...DISABLED } : btn()}
                >
                    {busy === 'files' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <UserPlus size={14} aria-hidden />}
                    Add photos
                </button>
            </div>

            <Tooltip>
                <TooltipTrigger
                    disabled={!!busy}
                    onClick={runEnrolFolder}
                    className={FOCUS}
                    style={{ ...(busy ? { ...btn(), ...DISABLED } : btn()), alignSelf: 'flex-start' }}
                >
                    {busy === 'folder' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <FolderInput size={14} aria-hidden />}
                    Import sample folder
                </TooltipTrigger>
                <TooltipContent style={{ maxWidth: 300, fontSize: 13, lineHeight: 1.5 }}>
                    {busy ? busyWhy : <>
                        Adds every <code className="font-code">&lt;name&gt;/&lt;photo&gt;</code> folder under
                        <br /><code className="font-code" style={{ fontSize: 12 }}>{SAMPLE_FACES_PATH}</code>
                        <br />Running it again adds to existing people, no duplicates.
                    </>}
                </TooltipContent>
            </Tooltip>

            {/* ── Results ──────────────────────────────────────────────── */}
            {error && (
                <div role="alert" style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 13, color: TONE.danger.fg, overflowWrap: 'anywhere',
                }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    {error}
                </div>
            )}
            {results && results.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {results.map((r, i) => (
                        <div key={i} style={{
                            display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13,
                            color: r.ok ? MUTED : TONE.warn.fg,
                        }}>
                            {r.ok ? <CheckCircle2 size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                                  : <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />}
                            <span style={{ wordBreak: 'break-word' }}>
                                {r.filename}{r.reason ? `: ${r.reason}` : ''}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Enrolled people ─────────────────────────────────────── */}
            {loading ? (
                <div role="status" style={{ ...SECONDARY, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> Loading…
                </div>
            ) : noPeople ? (
                <div style={SECONDARY}>
                    No one saved yet. Import the sample folder, or add photos above.
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {people.map(p => {
                        const isMatch = matchedPersonId === p.id
                        return (
                            <div key={p.id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '2px 4px 2px 10px', borderRadius: 6, fontSize: 13,
                                background: isMatch ? TONE.accent.bg : SURFACE,
                                border: `1px solid ${isMatch ? TONE.accent.border : 'transparent'}`,
                            }}>
                                <span style={{
                                    fontWeight: isMatch ? 700 : 600,
                                    color: isMatch ? TONE.accent.fg : p.active ? TEXT : SUBTLE,
                                    textDecoration: p.active ? 'none' : 'line-through',
                                    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                    {p.name}
                                </span>
                                <span style={{ ...NUM, fontSize: 12, color: p.active ? MUTED : SUBTLE, whiteSpace: 'nowrap' }}>
                                    {p.face_count} photo{p.face_count === 1 ? '' : 's'}
                                </span>
                                {!p.active && <span style={chip('muted')}>Off</span>}
                                {/* One distinct photo is thin coverage however many
                                    files were uploaded - a person's score is the BEST
                                    of their faces, so duplicates add nothing. */}
                                {p.face_count < 2 && (
                                    <Tooltip>
                                        <TooltipTrigger className={FOCUS} style={{
                                            ...chip('warn'), cursor: 'help',
                                        }}>
                                            Few photos
                                        </TooltipTrigger>
                                        <TooltipContent style={{ maxWidth: 260, fontSize: 13, lineHeight: 1.5 }}>
                                            Only one photo. Add 2-3 from other angles and light:
                                            faces are much harder to match from a drone.
                                        </TooltipContent>
                                    </Tooltip>
                                )}

                                <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                                    <Tooltip>
                                        <TooltipTrigger
                                            onClick={() => toggleActive(p)}
                                            disabled={busy === p.id}
                                            aria-label={p.active ? `Stop matching ${p.name}` : `Match ${p.name} again`}
                                            className={FOCUS}
                                            style={{ ...iconBtn, color: MUTED }}
                                        >
                                            {p.active ? <Eye size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />}
                                        </TooltipTrigger>
                                        <TooltipContent style={{ fontSize: 13 }}>
                                            {p.active ? 'Stop matching (keeps the data)'
                                                      : 'Match again'}
                                        </TooltipContent>
                                    </Tooltip>
                                    <button
                                        type="button"
                                        onClick={() => remove(p)}
                                        disabled={busy === p.id}
                                        aria-label={`Delete ${p.name}`}
                                        title={`Delete ${p.name}`}
                                        className={FOCUS}
                                        style={{ ...iconBtn, color: TONE.danger.fg }}
                                    >
                                        {busy === p.id ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden />
                                                       : <Trash2 size={15} aria-hidden />}
                                    </button>
                                </div>
                            </div>
                        )
                    })}

                    <button
                        type="button"
                        onClick={wipe}
                        disabled={!!busy}
                        title={busyWhy}
                        className={FOCUS}
                        style={{
                            ...(busy ? { ...btn(), ...DISABLED } : btn('danger')),
                            marginTop: 4, alignSelf: 'flex-start',
                        }}
                    >
                        <Trash2 size={14} aria-hidden /> Erase all faces
                    </button>
                </div>
            )}
        </div>
    )
}

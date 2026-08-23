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
import { Button } from '@/components/ui/button'
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

const LABEL: React.CSSProperties = {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
    color: 'hsl(var(--app-text-muted))',
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

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: 12, borderRadius: 10,
            background: 'hsl(var(--app-surface-2))',
            border: '1px solid hsl(var(--app-border))',
        }}>
            {/* ── Header + mode toggle ─────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Database size={14} style={{ color: '#22d3ee' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--app-text))' }}>
                    Face Database
                </span>
                <Tooltip>
                    <TooltipTrigger style={{
                        ...LABEL, cursor: 'help', background: 'none',
                        border: 'none', padding: 0,
                    }}>
                        {activeCount}/{people.length} active · {totalFaces} photos
                    </TooltipTrigger>
                    <TooltipContent style={{ maxWidth: 260, fontSize: 11, lineHeight: 1.5 }}>
                        Enrolled identities matched against every face the drone sees.
                        Only <b>active</b> people take part in matching.
                    </TooltipContent>
                </Tooltip>

                <div style={{ marginLeft: 'auto' }}>
                    <Tooltip>
                        <TooltipTrigger
                            onClick={toggleGalleryMode}
                            disabled={people.length === 0}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '5px 10px', borderRadius: 7, fontSize: 11,
                                fontWeight: 600, cursor: people.length ? 'pointer' : 'not-allowed',
                                border: `1px solid ${galleryMode ? '#22d3ee' : 'hsl(var(--app-border))'}`,
                                background: galleryMode ? 'rgba(34,211,238,0.15)' : 'transparent',
                                color: galleryMode ? '#22d3ee' : 'hsl(var(--app-text-muted))',
                                opacity: people.length ? 1 : 0.45,
                            }}
                        >
                            <span style={{
                                width: 7, height: 7, borderRadius: '50%',
                                background: galleryMode ? '#22d3ee' : 'hsl(var(--app-text-muted))',
                            }} />
                            Auto-identify {galleryMode ? 'ON' : 'OFF'}
                        </TooltipTrigger>
                        <TooltipContent style={{ maxWidth: 280, fontSize: 11, lineHeight: 1.5 }}>
                            {people.length === 0
                                ? 'Enrol at least one person first.'
                                : <>Match every detected face against the database and lock on
                                    automatically - no target selection needed. An uploaded
                                    reference photo still takes priority.</>}
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* ── Recognised right now ─────────────────────────────────
                Lists EVERYONE identified, with the followed person marked.
                Naming only the target was the original mistake: a second
                enrolled person standing beside them went unlabelled. */}
            {galleryMode && identities.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ ...LABEL }}>
                            Recognised now ({identities.length})
                        </span>
                        {identities.length > 1 && (
                            <span style={{ fontSize: 9, color: 'hsl(var(--app-text-muted))' }}>
                                click a name to follow
                            </span>
                        )}
                        {lockManual && (
                            <button
                                onClick={() => follow(null)}
                                style={{
                                    marginLeft: 'auto', border: 'none', background: 'none',
                                    fontSize: 9, color: '#22d3ee', cursor: 'pointer',
                                }}
                            >
                                release → auto
                            </button>
                        )}
                    </div>
                    {identities.map(id => {
                        const followed = id.person_id === matchedPersonId
                        return (
                            // Clickable: choosing a target by hand is the
                            // reliable way to override the tracker's own pick
                            // when two enrolled people are both in frame.
                            <div
                                key={id.track_id}
                                onClick={() => follow(followed ? null : id.person_id)}
                                title={followed
                                    ? 'Click to release and resume automatic selection'
                                    : `Click to follow ${id.name}`}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '5px 9px', borderRadius: 7, fontSize: 11,
                                    cursor: 'pointer',
                                    background: followed ? 'rgba(34,211,238,0.14)' : 'rgba(170,120,220,0.12)',
                                    border: `1px solid ${followed ? 'rgba(34,211,238,0.45)' : 'rgba(170,120,220,0.35)'}`,
                                }}
                            >
                                <span style={{
                                    fontWeight: 700,
                                    color: followed ? '#22d3ee' : '#c4a3e0',
                                }}>
                                    {id.name}
                                </span>
                                {followed && (
                                    <span style={{ fontSize: 9, fontWeight: 700, color: '#22d3ee' }}>
                                        {lockManual ? 'FOLLOWING · MANUAL' : 'FOLLOWING'}
                                    </span>
                                )}
                                <span style={{
                                    marginLeft: 'auto', fontFamily: 'monospace',
                                    color: 'hsl(var(--app-text-muted))',
                                }}>
                                    {id.similarity.toFixed(2)}
                                    {/* Vote count is the redundancy made visible:
                                        how many independent frames agree. */}
                                    <span style={{ opacity: 0.6 }}> ·{id.votes}v</span>
                                </span>
                                {id.margin != null && id.margin < 0.08 && (
                                    <span style={{ fontSize: 9, fontWeight: 600, color: '#fbbf24' }}>
                                        LOW CONF
                                    </span>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {/* Followed-but-unnamed fallback (reference-photo path). */}
            {galleryMode && matchedName && identities.length === 0 && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', borderRadius: 8,
                    background: 'rgba(34,211,238,0.12)',
                    border: '1px solid rgba(34,211,238,0.4)',
                }}>
                    <CheckCircle2 size={14} style={{ color: '#22d3ee' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#22d3ee' }}>
                        {matchedName}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                        {similarity.toFixed(2)}
                    </span>
                    {/* A confident-looking name with a thin margin is the case
                        worth flagging: two enrolled people are scoring alike. */}
                    {margin != null && margin < 0.08 && (
                        <span style={{
                            marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                            color: '#fbbf24',
                        }}>
                            LOW CONFIDENCE · margin {margin.toFixed(2)}
                        </span>
                    )}
                </div>
            )}
            {galleryMode && enrolled && (
                <div style={{ ...LABEL, fontSize: 10 }}>
                    Server indexed {enrolled.faces} face(s)
                </div>
            )}

            {/* ── Enrol ────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Person's name"
                    style={{
                        flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 11,
                        borderRadius: 6, background: 'hsl(var(--app-surface))',
                        border: '1px solid hsl(var(--app-border))',
                        color: 'hsl(var(--app-text))',
                    }}
                />
                <input
                    ref={fileRef} type="file" accept="image/*" multiple
                    onChange={runEnrolFiles} style={{ display: 'none' }}
                />
                <Button
                    size="sm" variant="outline"
                    disabled={!!busy}
                    onClick={() => fileRef.current?.click()}
                    style={{ fontSize: 11, height: 30, gap: 5 }}
                >
                    {busy === 'files' ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
                    Add photos
                </Button>
            </div>

            <Tooltip>
                <TooltipTrigger
                    disabled={!!busy}
                    onClick={runEnrolFolder}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 6, height: 30,
                        padding: '0 10px', fontSize: 11, borderRadius: 7,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        border: '1px solid hsl(var(--app-border))',
                        background: 'transparent', color: 'hsl(var(--app-text))',
                        opacity: busy ? 0.5 : 1,
                    }}
                >
                    {busy === 'folder' ? <Loader2 size={12} className="animate-spin" /> : <FolderInput size={12} />}
                    Import sample folder
                </TooltipTrigger>
                <TooltipContent style={{ maxWidth: 300, fontSize: 11, lineHeight: 1.5 }}>
                    Enrols every <code>&lt;name&gt;/&lt;photo&gt;</code> folder under
                    <br /><code style={{ fontSize: 10 }}>{SAMPLE_FACES_PATH}</code>
                    <br />Re-running adds to existing people instead of duplicating them.
                </TooltipContent>
            </Tooltip>

            {/* ── Results ──────────────────────────────────────────────── */}
            {error && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 11, color: '#f87171',
                }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    {error}
                </div>
            )}
            {results && results.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {results.map((r, i) => (
                        <div key={i} style={{
                            display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 10,
                            color: r.ok ? 'hsl(var(--app-text-muted))' : '#fbbf24',
                        }}>
                            {r.ok ? <CheckCircle2 size={11} style={{ marginTop: 1, flexShrink: 0 }} />
                                  : <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} />}
                            <span style={{ wordBreak: 'break-word' }}>
                                {r.filename}{r.reason ? ` - ${r.reason}` : ''}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Enrolled people ─────────────────────────────────────── */}
            {loading ? (
                <div style={{ ...LABEL, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Loader2 size={11} className="animate-spin" /> Loading…
                </div>
            ) : people.length === 0 ? (
                <div style={{ ...LABEL, lineHeight: 1.6 }}>
                    Nobody enrolled yet. Import the sample folder, or add photos
                    for one person above.
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {people.map(p => {
                        const isMatch = matchedPersonId === p.id
                        return (
                            <div key={p.id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '5px 8px', borderRadius: 6, fontSize: 11,
                                background: isMatch ? 'rgba(34,211,238,0.12)' : 'hsl(var(--app-surface))',
                                border: `1px solid ${isMatch ? 'rgba(34,211,238,0.4)' : 'transparent'}`,
                                opacity: p.active ? 1 : 0.5,
                            }}>
                                <span style={{
                                    fontWeight: isMatch ? 700 : 500,
                                    color: isMatch ? '#22d3ee' : 'hsl(var(--app-text))',
                                    textDecoration: p.active ? 'none' : 'line-through',
                                }}>
                                    {p.name}
                                </span>
                                <span style={{ ...LABEL, fontFamily: 'monospace' }}>
                                    {p.face_count} photo{p.face_count === 1 ? '' : 's'}
                                </span>
                                {/* One distinct photo is thin coverage however many
                                    files were uploaded - a person's score is the BEST
                                    of their faces, so duplicates add nothing. */}
                                {p.face_count < 2 && (
                                    <Tooltip>
                                        <TooltipTrigger style={{
                                            fontSize: 10, color: '#fbbf24', cursor: 'help',
                                            background: 'none', border: 'none', padding: 0,
                                        }}>
                                            thin
                                        </TooltipTrigger>
                                        <TooltipContent style={{ maxWidth: 260, fontSize: 11, lineHeight: 1.5 }}>
                                            Only one photo enrolled. Add 2-3 from different
                                            angles and lighting - recognition from a drone is
                                            much harder than from a passport photo.
                                        </TooltipContent>
                                    </Tooltip>
                                )}

                                <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                                    <Tooltip>
                                        <TooltipTrigger
                                            onClick={() => toggleActive(p)}
                                            disabled={busy === p.id}
                                            style={{
                                                display: 'flex', padding: 4, borderRadius: 5,
                                                border: 'none', background: 'transparent',
                                                cursor: 'pointer', color: 'hsl(var(--app-text-muted))',
                                            }}
                                        >
                                            {p.active ? <Eye size={12} /> : <EyeOff size={12} />}
                                        </TooltipTrigger>
                                        <TooltipContent style={{ fontSize: 11 }}>
                                            {p.active ? 'Exclude from matching (keeps the data)'
                                                      : 'Include in matching again'}
                                        </TooltipContent>
                                    </Tooltip>
                                    <button
                                        onClick={() => remove(p)}
                                        disabled={busy === p.id}
                                        style={{
                                            padding: 4, borderRadius: 5, border: 'none',
                                            background: 'transparent', cursor: 'pointer',
                                            color: '#f87171',
                                        }}
                                    >
                                        {busy === p.id ? <Loader2 size={12} className="animate-spin" />
                                                       : <Trash2 size={12} />}
                                    </button>
                                </div>
                            </div>
                        )
                    })}

                    <button
                        onClick={wipe}
                        disabled={!!busy}
                        style={{
                            marginTop: 2, padding: '4px 0', border: 'none',
                            background: 'transparent', cursor: 'pointer',
                            fontSize: 10, color: 'hsl(var(--app-text-muted))',
                            textAlign: 'left',
                        }}
                    >
                        Erase entire gallery
                    </button>
                </div>
            )}
        </div>
    )
}

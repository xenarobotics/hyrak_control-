'use client'

// Class names as chips. Click a chip to rename it in place: the chip and
// its input share one box, so nothing around it moves. Enter saves, Escape
// cancels. Classes are tied to the model's outputs, so they can be renamed
// but not added or removed.

import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { css as s } from './ui'

const FIRST = 24

export function ClassChips({ labels, onChange, readOnly }: {
    labels: string[]
    onChange?: (next: string[]) => void
    readOnly?: boolean
}) {
    const [all, setAll] = useState(false)
    const shown = all ? labels : labels.slice(0, FIRST)
    if (labels.length === 0) {
        return <p className={s.muted}>No class names were found in this model.</p>
    }
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className={s.chips}>
                {shown.map((l, i) => readOnly || !onChange ? (
                    <span key={i} className={s.chip + ' ' + s.chipMute}>{l}</span>
                ) : (
                    <ClassChip key={i} index={i} value={l}
                        onSave={v => onChange(labels.map((x, j) => j === i ? v : x))} />
                ))}
            </div>
            {labels.length > FIRST && (
                <button type="button" className={s.link} style={{ alignSelf: 'flex-start' }} onClick={() => setAll(a => !a)}>
                    {all ? 'Show fewer' : `Show all ${labels.length} classes`}
                </button>
            )}
        </div>
    )
}

function ClassChip({ index, value, onSave }: { index: number; value: string; onSave: (v: string) => void }) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(value)
    // Escape unmounts the input, which blurs it: skip that blur's commit.
    const cancelled = useRef(false)
    const commit = () => {
        if (cancelled.current) { cancelled.current = false; return }
        const v = draft.trim()
        if (v && v !== value) onSave(v)
        else setDraft(value)
        setEditing(false)
    }
    return (
        <span className={s.classChip}>
            <button type="button" tabIndex={editing ? -1 : 0} aria-hidden={editing || undefined} onClick={() => { setDraft(value); setEditing(true) }}
                aria-label={`Rename class ${index}: ${value}`}
                style={{ visibility: editing ? 'hidden' : undefined }}>
                <span className={s.idx}>{index}</span>{value}<Pencil size={10} aria-hidden style={{ opacity: 0.5 }} />
            </button>
            {editing && (
                <input autoFocus size={1} value={draft} style={{ width: '100%', minWidth: 0 }} aria-label={`Class ${index} name`}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commit() }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setDraft(value); setEditing(false) }
                    }} />
            )}
        </span>
    )
}

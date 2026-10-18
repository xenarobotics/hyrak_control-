'use client'

// Read-only UI for workspace viewers (docs/ACCESS_MODEL.md section 8a): a
// customer whose role on the active workspace has no `fly` watches video,
// telemetry and AI overlays but sends no commands. Command surfaces are
// wrapped in <ViewOnlyFence>: a disabled <fieldset> disables every button
// and input inside it natively (their disabled styles apply as usual),
// with a short note above. Staff and pilots get the children untouched.
// The server refuses the commands anyway; this keeps the UI honest.

import { Eye } from 'lucide-react'
import { useLiveScope } from '@/hooks/useLiveScope'

export const VIEW_ONLY_TEXT = 'View only: your role in this workspace can watch, not command.'

export function ViewOnlyNote({ tone = 'dark', compact }: { tone?: 'dark' | 'simple'; compact?: boolean }) {
    if (tone === 'simple') {
        return (
            <p role="note" className="flex items-start gap-2 rounded-xl px-3 py-2 text-[15px]"
                style={{ background: 'var(--s-blue-soft)', color: 'var(--s-ink)' }}>
                <Eye size={18} className="shrink-0 mt-0.5" />
                View only. Your role in this workspace can watch the drone, not fly it.
            </p>
        )
    }
    return (
        <p role="note" title={VIEW_ONLY_TEXT}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] leading-snug"
            style={{ borderColor: 'rgba(34,211,238,.35)', background: 'rgba(34,211,238,.08)', color: '#a5f3fc' }}>
            <Eye size={11} className="shrink-0" />
            {compact ? 'VIEW ONLY' : VIEW_ONLY_TEXT}
        </p>
    )
}

export function ViewOnlyFence({ children, note = true, tone, compact }: {
    children: React.ReactNode
    /** Show the note above the fenced controls. */
    note?: boolean
    tone?: 'dark' | 'simple'
    compact?: boolean
}) {
    const { viewOnly } = useLiveScope()
    if (!viewOnly) return <>{children}</>
    return (
        <>
            {note && <ViewOnlyNote tone={tone} compact={compact} />}
            <fieldset disabled aria-label="Commands (view only)" className="contents">
                {children}
            </fieldset>
        </>
    )
}

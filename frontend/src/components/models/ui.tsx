'use client'

// Small shared pieces for the model library: the themed root class, the
// status chip, the slide-over shell and inline callouts.

import type { ReactNode } from 'react'
import { AlertTriangle, Info, Loader } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useUiMode } from '@/hooks/useUiMode'
import { cn } from '@/lib/utils'
import { stepWords, type ModelSource, type ModelStatus } from '@/lib/models'
import s from './models.module.css'

export { s as css }

/** The root class for this UI mode: Dev palette, or Normal's daylight one. */
export function useCmClass(): { root: string; normal: boolean } {
    const normal = useUiMode()[0] === 'normal'
    return { root: cn(s.cm, normal && s.normal), normal }
}

export function StatusChip({ status, step, progress, source }: {
    status: ModelStatus; step?: string | null; progress?: number | null; source?: ModelSource
}) {
    if (status === 'ready') {
        return <span className={cn(s.chip, s.chipOk)}><span className={s.dot} aria-hidden />Ready</span>
    }
    if (status === 'failed') {
        return <span className={cn(s.chip, s.chipBad)}><AlertTriangle size={11} aria-hidden />Needs attention</span>
    }
    const pct = progress != null && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null
    return (
        <span className={cn(s.chip, s.chipInfo)} role="status">
            <Loader size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />
            {stepWords(step, source)}{pct != null ? ` ${Math.round(pct * 100)}%` : ''}
            {pct != null && <span className={s.chipBar} aria-hidden><i style={{ width: `${pct * 100}%` }} /></span>}
        </span>
    )
}

/** A right-hand slide-over (focus trapped, Escape closes, focus returns to
 *  the trigger), themed for the current UI mode. */
export function SlideOver({ open, onOpenChange, title, description, children, head, foot }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    /** Extra header content under the title (e.g. a stepper). */
    head?: ReactNode
    children: ReactNode
    foot?: ReactNode
}) {
    const { root } = useCmClass()
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className={cn(root, s.sheet)}>
                <div className={s.sheetHead}>
                    <SheetTitle className={s.title}>{title}</SheetTitle>
                    {description && <SheetDescription className={s.muted}>{description}</SheetDescription>}
                    {head}
                </div>
                <div className={s.sheetBody}>{children}</div>
                {foot && <div className={s.sheetFoot}>{foot}</div>}
            </SheetContent>
        </Sheet>
    )
}

export function Callout({ tone = 'bad', title, children, actions }: {
    tone?: 'bad' | 'warn' | 'info'; title?: ReactNode; children?: ReactNode; actions?: ReactNode
}) {
    const Icon = tone === 'info' ? Info : AlertTriangle
    const color = tone === 'bad' ? 'var(--cm-bad)' : tone === 'warn' ? 'var(--cm-warn)' : 'var(--cm-accent)'
    return (
        <div className={cn(s.callout, tone === 'bad' ? s.calloutBad : tone === 'warn' ? s.calloutWarn : s.calloutInfo)}
            role={tone === 'bad' ? 'alert' : 'status'}>
            <Icon size={15} style={{ color }} aria-hidden />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                {title && <strong style={{ color: 'var(--cm-ink)' }}>{title}</strong>}
                {children}
                {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>{actions}</div>}
            </div>
        </div>
    )
}

/** A hint from the server, with any `command like this` shown as code. */
export function Hint({ text }: { text: string | null | undefined }) {
    if (!text) return null
    const parts = text.split(/(`[^`]+`)/g)
    // Bare "yolo export ..." style commands after a colon read better as code.
    const colon = parts.length === 1 ? /^(.*?:\s*)((?:yolo|python|optimum-cli|pip|torch)\b.*)$/.exec(text) : null
    if (colon) return <span>{colon[1]}<code>{colon[2]}</code></span>
    return <span>{parts.map((p, i) => p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p)}</span>
}

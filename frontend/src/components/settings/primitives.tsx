'use client'

// Building blocks shared by the settings page and its server-backed groups
// (Account, Workspace): the label/sub/control row, plus the small inputs,
// buttons and status lines those groups need.

import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function PrefRow({ label, sub, tip, right }: { label: React.ReactNode; sub?: React.ReactNode; tip?: string; right: React.ReactNode }) {
    return (
        // Wraps on a narrow pane: the control drops under its label instead
        // of pushing the page sideways.
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 16, rowGap: 8, padding: '12px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'hsl(var(--app-text))' }}>{label}</span>
                    {tip && (
                        <Tooltip>
                            <TooltipTrigger aria-label="More about this setting" style={{ background: 'none', border: 'none', padding: 2, margin: -2, borderRadius: 999, cursor: 'help', display: 'flex' }}>
                                <Info size={14} style={{ color: 'hsl(var(--app-text-muted))' }} />
                            </TooltipTrigger>
                            <TooltipContent style={{ maxWidth: 280, fontSize: 13, lineHeight: 1.5 }}>{tip}</TooltipContent>
                        </Tooltip>
                    )}
                </div>
                {sub && <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '2px 0 0', lineHeight: 1.45, maxWidth: '70ch' }}>{sub}</p>}
            </div>
            <div style={{ flexShrink: 0, maxWidth: '100%' }}>{right}</div>
        </div>
    )
}

export const S_INPUT: React.CSSProperties = {
    minHeight: 32, padding: '6px 10px', borderRadius: 6, fontSize: 14,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border-strong))',
    color: 'hsl(var(--app-text))', minWidth: 0,
}

/** Section caption (PROFILE, MEMBERS ...): 12px 700, short tracking. */
export const S_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 700,
    letterSpacing: '0.06em', color: 'hsl(var(--app-text-muted))', marginBottom: 6,
}

/** A form field's label: sentence case, 13px. */
export const S_FIELD_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text))', marginBottom: 6,
}

export const S_NOTE: React.CSSProperties = {
    fontSize: 13, color: 'hsl(var(--app-text-muted))', lineHeight: 1.5, margin: 0,
}

// primary: the one filled action of a group. plain: neutral outline.
// danger: red outline, for what cannot be undone.
type Tone = 'primary' | 'danger' | 'plain'
const TONE: Record<Tone, { border: string; color: string; background: string }> = {
    primary: { border: 'var(--app-accent)', color: 'var(--app-accent-ink)', background: 'var(--app-accent)' },
    danger: { border: 'var(--app-danger)', color: 'var(--app-danger)', background: 'transparent' },
    plain: { border: 'hsl(var(--app-border-strong))', color: 'hsl(var(--app-text))', background: 'transparent' },
}

export function SButton({ tone = 'plain', disabled, onClick, type = 'button', children, title }: {
    tone?: Tone
    disabled?: boolean
    onClick?: () => void
    type?: 'button' | 'submit'
    children: React.ReactNode
    title?: string
}) {
    const t = TONE[tone]
    // Disabled stays readable (muted text on surface-2, dashed edge) rather
    // than fading the whole button.
    return (
        <button type={type} onClick={onClick} disabled={disabled} title={title} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: 32, padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
            border: disabled ? '1px dashed hsl(var(--app-border-strong))' : `1px solid ${t.border}`,
            background: disabled ? 'hsl(var(--app-surface-2))' : t.background,
            color: disabled ? 'hsl(var(--app-text-muted))' : t.color,
            cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
            transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        }}>
            {children}
        </button>
    )
}

/** One-line result under a form: the server's error, or a short confirmation. */
export function Status({ error, ok }: { error?: string; ok?: string }) {
    if (!error && !ok) return null
    return (
        <p role={error ? 'alert' : 'status'} style={{ ...S_NOTE, padding: '6px 0', color: error ? 'var(--app-danger)' : 'var(--app-ok)' }}>
            {error || ok}
        </p>
    )
}

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'cyan' | 'amber' }) {
    const c = tone === 'cyan' ? 'var(--app-accent)' : tone === 'amber' ? 'var(--app-warn)' : 'hsl(var(--app-text-muted))'
    const bg = tone === 'cyan' ? 'var(--app-accent-soft)' : tone === 'amber' ? 'var(--app-warn-soft)' : 'transparent'
    return (
        <span style={{
            fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', padding: '1px 8px',
            borderRadius: 999, border: '1px solid', borderColor: tone === 'muted' ? 'hsl(var(--app-border))' : 'transparent',
            background: bg, color: c, whiteSpace: 'nowrap',
        }}>
            {children}
        </span>
    )
}

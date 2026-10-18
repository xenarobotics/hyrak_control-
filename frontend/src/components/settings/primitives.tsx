'use client'

// Building blocks shared by the settings page and its server-backed groups
// (Account, Workspace): the label/sub/control row, plus the small inputs,
// buttons and status lines those groups need.

import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function PrefRow({ label, sub, tip, right }: { label: React.ReactNode; sub?: React.ReactNode; tip?: string; right: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 13, color: 'hsl(var(--app-text))' }}>{label}</span>
                    {tip && (
                        <Tooltip>
                            <TooltipTrigger style={{ background: 'none', border: 'none', padding: 0, cursor: 'help', display: 'flex' }}>
                                <Info size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                            </TooltipTrigger>
                            <TooltipContent style={{ maxWidth: 220, fontSize: 11, lineHeight: 1.5 }}>{tip}</TooltipContent>
                        </Tooltip>
                    )}
                </div>
                {sub && <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0', lineHeight: 1.4 }}>{sub}</p>}
            </div>
            <div style={{ flexShrink: 0 }}>{right}</div>
        </div>
    )
}

export const S_INPUT: React.CSSProperties = {
    padding: '6px 9px', borderRadius: 6, fontFamily: 'monospace', fontSize: 12,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
    color: 'hsl(var(--app-text))', outline: 'none', minWidth: 0,
}

export const S_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
    letterSpacing: '0.12em', color: 'hsl(var(--app-text-muted))', marginBottom: 5,
}

export const S_NOTE: React.CSSProperties = {
    fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', lineHeight: 1.5, margin: 0,
}

type Tone = 'primary' | 'danger' | 'plain'
const TONE: Record<Tone, { border: string; color: string }> = {
    primary: { border: 'rgba(34,211,238,0.55)', color: '#22d3ee' },
    danger: { border: 'rgba(248,113,113,0.5)', color: '#f87171' },
    plain: { border: 'hsl(var(--app-border))', color: 'hsl(var(--app-text))' },
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
    return (
        <button type={type} onClick={onClick} disabled={disabled} title={title} style={{
            padding: '5px 12px', borderRadius: 6, border: `1px solid ${t.border}`,
            background: 'transparent', color: t.color, fontSize: 12, fontFamily: 'monospace',
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        }}>
            {children}
        </button>
    )
}

/** One-line result under a form: the server's error, or a short confirmation. */
export function Status({ error, ok }: { error?: string; ok?: string }) {
    if (!error && !ok) return null
    return (
        <p role={error ? 'alert' : 'status'} style={{ ...S_NOTE, padding: '6px 0', color: error ? '#f87171' : '#34d399' }}>
            {error || ok}
        </p>
    )
}

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'cyan' | 'amber' }) {
    const c = tone === 'cyan' ? '#22d3ee' : tone === 'amber' ? '#f59e0b' : 'hsl(var(--app-text-muted))'
    return (
        <span style={{
            fontSize: 10, fontFamily: 'monospace', letterSpacing: '0.06em', padding: '1px 6px',
            borderRadius: 4, border: '1px solid', borderColor: tone === 'muted' ? 'hsl(var(--app-border))' : c,
            color: c, whiteSpace: 'nowrap',
        }}>
            {children}
        </span>
    )
}

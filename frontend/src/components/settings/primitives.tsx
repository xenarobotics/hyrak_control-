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
                            <TooltipTrigger aria-label="More about this setting" className="bg-transparent text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent" style={{ border: 'none', padding: 5, margin: -5, borderRadius: 999, cursor: 'help', display: 'flex' }}>
                                <Info size={14} />
                            </TooltipTrigger>
                            <TooltipContent style={{ maxWidth: 280, fontSize: 13, lineHeight: 1.5 }}>{tip}</TooltipContent>
                        </Tooltip>
                    )}
                </div>
                {sub && <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '2px 0 0', lineHeight: 1.45, maxWidth: '70ch' }}>{sub}</p>}
            </div>
            <div style={{ flexShrink: 0, maxWidth: '100%', minWidth: 0 }}>{right}</div>
        </div>
    )
}

export const S_INPUT: React.CSSProperties = {
    minHeight: 32, padding: '6px 10px', borderRadius: 6, fontSize: 14,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border-strong))',
    color: 'hsl(var(--app-text))', minWidth: 0,
}

/** Section heading (Profile, Members ...): sentence case, 16px 700. */
export const S_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 16, fontWeight: 700, lineHeight: '22px',
    color: 'hsl(var(--app-text))', marginBottom: 6,
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
    // Disabled stays readable (subtle text on surface-2, quiet solid edge) rather
    // than fading the whole button.
    return (
        <button type={type} onClick={onClick} disabled={disabled} title={title} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: 32, padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
            border: disabled ? '1px solid hsl(var(--app-border))' : `1px solid ${t.border}`,
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
    // Tinted pills keep the full ink colour for text: accent text on its own
    // soft tint sits right at 4.5:1 in light, the border carries the hue.
    const c = tone === 'muted' ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))'
    const bg = tone === 'cyan' ? 'var(--app-accent-soft)' : tone === 'amber' ? 'var(--app-warn-soft)' : 'transparent'
    const bd = tone === 'cyan' ? 'color-mix(in srgb, var(--app-accent) 45%, transparent)' : tone === 'amber' ? 'color-mix(in srgb, var(--app-warn) 45%, transparent)' : 'hsl(var(--app-border))'
    return (
        <span style={{
            fontSize: 12, fontWeight: 700, padding: '1px 8px',
            borderRadius: 999, border: '1px solid', borderColor: bd,
            background: bg, color: c, whiteSpace: 'nowrap',
        }}>
            {children}
        </span>
    )
}

/** A short, local date for setup screens: "21 Oct, 01:15" (the year only
 *  when it is not this year), in India time - the people using this are. */
export function fmtShort(iso: string | null | undefined): string {
    if (!iso) return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '-'
    const tz = 'Asia/Kolkata'
    const year = d.toLocaleString('en-IN', { year: 'numeric', timeZone: tz })
    const thisYear = new Date().toLocaleString('en-IN', { year: 'numeric', timeZone: tz })
    const day = d.toLocaleString('en-IN', { day: 'numeric', month: 'short', timeZone: tz })
    const time = d.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
    return `${day}${year !== thisYear ? ` ${year}` : ''}, ${time}`
}

/** Readable device names from a session label (a user agent or what the
 *  server derived from one). Scripts and API clients are told apart so the
 *  device list can group them. */
export function describeDevice(label: string | null | undefined): { name: string; script: boolean } {
    const raw = (label || '').trim()
    if (!raw) return { name: 'Unnamed device', script: false }
    const script = /^(python|node|curl|wget|okhttp|go-http|axios|postman|insomnia|java|ruby|php|undici|deno|bun)\b/i.test(raw)
    if (script) return { name: raw.replace(/\//, ' '), script: true }
    const browser = /edg\//i.test(raw) ? 'Edge' : /firefox\//i.test(raw) ? 'Firefox' : /electron\//i.test(raw) ? 'HYRAK desktop app'
        : /chrome\//i.test(raw) ? 'Chrome' : /safari\//i.test(raw) ? 'Safari' : null
    const os = /android/i.test(raw) ? 'Android' : /iphone|ipad|ios/i.test(raw) ? 'iOS' : /windows/i.test(raw) ? 'Windows'
        : /mac os|macintosh/i.test(raw) ? 'macOS' : /linux|x11/i.test(raw) ? 'Linux' : null
    if (browser) return { name: os ? `${browser} on ${os}` : browser, script: false }
    return { name: raw, script: false }
}

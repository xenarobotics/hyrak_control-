'use client'

// Small pieces of the HYRAK console's visual language, shared by its tabs:
// theme tokens (dark and light), sentence-case labels, toned buttons
// and status chips that pair an icon with a word.

import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Info, OctagonAlert, FlaskConical } from 'lucide-react'
import { copyText } from '@/lib/workspaces'

/** Focus ring every console control uses (2px accent, offset 2px). */
export const FOCUS_CLS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)]'
export const INPUT_CLS = 'h-8 bg-app-surface-2 border border-app-border-strong rounded-md px-2 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle focus:border-app-accent min-w-0 ' + FOCUS_CLS
export const LABEL_CLS = 'block text-[13px] font-semibold text-app-text-muted mb-1'
/** Table header cell and body row, shared by every console table. */
export const TH_CLS = 'px-3 h-10 text-left text-[13px] font-semibold text-app-text-muted whitespace-nowrap'
export const TR_CLS = 'h-11 border-b border-app-border last:border-b-0 transition-colors duration-[120ms] hover:bg-app-surface-2'

type TagTone = 'amber' | 'emerald' | 'red' | 'zinc' | 'violet' | 'cyan'
const TAG: Record<TagTone, { cls: string; Icon: typeof Info }> = {
    amber:   { cls: 'text-app-warn bg-app-warn-soft border-app-warn/40', Icon: AlertTriangle },
    emerald: { cls: 'text-app-ok bg-app-ok-soft border-app-ok/40', Icon: CheckCircle2 },
    red:     { cls: 'text-app-danger bg-app-danger-soft border-app-danger/40', Icon: OctagonAlert },
    zinc:    { cls: 'text-app-text-muted bg-app-surface-2 border-app-border', Icon: Circle },
    violet:  { cls: 'text-violet-700 dark:text-violet-300 bg-violet-500/10 border-violet-500/40', Icon: FlaskConical },
    cyan:    { cls: 'text-app-text bg-app-accent-soft border-app-accent/45', Icon: Info },
}

/** Status chip: icon + word + colour, so colour never carries the meaning
 *  alone. `icon={false}` for plain name chips (roles, kinds). */
export function Tag({ label, tone, icon = true }: { label: string; tone: TagTone; icon?: boolean }) {
    const { cls, Icon } = TAG[tone]
    return (
        <span className={`inline-flex items-center gap-1 h-6 border rounded-full px-2 text-[12px] font-bold whitespace-nowrap ${cls}`}>
            {icon && <Icon size={12} aria-hidden strokeWidth={2.5} />}
            {label}
        </span>
    )
}

type Tone = 'plain' | 'primary' | 'cyan' | 'emerald' | 'red'
const BTN: Record<Tone, string> = {
    plain:   'border-app-border-strong text-app-text hover:bg-app-surface-2',
    // The one filled action of a view (Grant, Create, Save).
    primary: 'border-app-accent bg-app-accent text-app-accent-ink hover:bg-[color-mix(in_srgb,var(--app-accent)_85%,hsl(var(--app-text)))] hover:border-[color-mix(in_srgb,var(--app-accent)_85%,hsl(var(--app-text)))]',
    cyan:    'border-app-accent/60 text-app-accent hover:bg-app-accent-soft',
    emerald: 'border-app-ok/50 text-app-ok hover:bg-app-ok-soft',
    red:     'border-app-danger/50 text-app-danger hover:bg-app-danger-soft',
}

export function Btn({ tone = 'plain', onClick, disabled, type = 'button', children, className = '', title }: {
    tone?: Tone
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit'
    children: React.ReactNode
    className?: string
    title?: string
}) {
    return (
        <button type={type} onClick={onClick} disabled={disabled} title={title}
            className={`inline-flex items-center justify-center gap-1.5 min-h-8 px-3 rounded-md border text-[13px] font-semibold whitespace-nowrap transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:border-dashed disabled:border-app-border-strong disabled:bg-transparent disabled:text-app-text-muted ${FOCUS_CLS} ${BTN[tone]} ${className}`}>
            {children}
        </button>
    )
}

export function Section({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
    return (
        <section className="border border-app-border rounded-[10px] bg-app-surface overflow-clip">
            <div className="px-4 min-h-12 py-2 text-[14px] font-bold text-app-text border-b border-app-border flex items-center gap-2">
                <h3 className="truncate m-0 text-[14px] font-bold">{title}</h3>
                {right && <span className="ml-auto flex items-center gap-2 font-normal">{right}</span>}
            </div>
            {children}
        </section>
    )
}

/** The lead line of a console page. The page title itself is the H1 in the
 *  console's top bar (components/auth/AppFrame), so `title` is not repeated
 *  here; it only names the block for assistive tech. */
export function PageHead({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-3 pb-1" aria-label={title} role="group">
            <div className="min-w-0 flex-1">
                {sub && <p className="m-0 text-[14px] text-app-text-muted">{sub}</p>}
            </div>
            {right}
        </div>
    )
}

/** The server's message, verbatim, or a short confirmation. */
export function Notice({ error, ok }: { error?: string; ok?: string }) {
    if (!error && !ok) return null
    return (
        <div role={error ? 'alert' : 'status'} className={`text-[13px] ${error ? 'text-app-danger' : 'text-app-ok'}`}>
            {error || ok}
        </div>
    )
}

export function Empty({ children }: { children: React.ReactNode }) {
    return <div className="p-4 text-[13px] text-app-text-muted">{children}</div>
}

/** A one-time link (invite, password reset): read-only field and a Copy button. */
export function CopyLink({ label, url, note }: { label: string; url: string; note?: string }) {
    const ref = useRef<HTMLInputElement>(null)
    const [msg, setMsg] = useState('')
    return (
        <div className="space-y-1">
            <div className={LABEL_CLS}>{label}</div>
            <div className="flex gap-2">
                <input ref={ref} readOnly value={url} onFocus={e => e.currentTarget.select()}
                    aria-label={label} className={`${INPUT_CLS} flex-1`} />
                <Btn tone="cyan" onClick={() => {
                    void copyText(url, ref.current).then(how =>
                        setMsg(how === 'copied' ? 'Copied' : 'Selected - press Ctrl+C'))
                }}>
                    {msg === 'Copied' ? 'Copied' : 'Copy'}
                </Btn>
            </div>
            <div className="text-[12px] text-app-text-muted">{msg && msg !== 'Copied' ? msg : note}</div>
        </div>
    )
}

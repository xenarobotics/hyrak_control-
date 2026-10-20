'use client'

// App-wide notices from custom model rules (rule_event) and the old single
// alert (model_alert): a small stack, top centre, below the zone, refusal and
// takeover banners. Attachment results (attachment_result) share the stack. Info goes away by itself after 6 s; a question
// ("Person seen (82%). Follow it?") stays until answered or its 10 s run out.
// Mounted once in the platform layout.

import { useEffect, useState } from 'react'
import { BellRing, Info, TriangleAlert, Volume2, VolumeX, X } from 'lucide-react'
import { ACTION_WORDS, ensureRulesFeed, useRulesStore, type RuleToast } from '@/lib/modelRules'
import { ensureAttachmentFeed } from '@/lib/attachments'

const INFO_MS = 6000
const WARN_MS = 9000

export function RuleToasts() {
    const toasts = useRulesStore(s => s.toasts)
    useEffect(() => { ensureRulesFeed(); ensureAttachmentFeed() }, [])
    if (toasts.length === 0) return null
    return (
        <div aria-label="AI rule notices"
            className="pointer-events-none fixed left-1/2 top-28 z-[2900] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2">
            {toasts.map(t => <Toast key={t.id} t={t} />)}
        </div>
    )
}

function Toast({ t }: { t: RuleToast }) {
    const dismiss = useRulesStore(s => s.dismiss)
    const answer = useRulesStore(s => s.answer)
    const muted = useRulesStore(s => s.muted)
    const setMuted = useRulesStore(s => s.setMuted)
    const confirm = t.kind === 'confirm'
    const total = t.deadline ? Math.max(1, t.deadline - Date.now()) : 0
    const [left, setLeft] = useState(total)

    // Info and warnings close by themselves; a question counts down.
    useEffect(() => {
        if (!confirm) {
            const id = setTimeout(() => dismiss(t.id), t.kind === 'warn' ? WARN_MS : INFO_MS)
            return () => clearTimeout(id)
        }
        const id = setInterval(() => {
            const ms = (t.deadline ?? 0) - Date.now()
            if (ms <= 0) dismiss(t.id)
            else setLeft(ms)
        }, 250)
        return () => clearInterval(id)
    }, [confirm, t.id, t.kind, t.deadline, dismiss])

    // Always-dark cards in both themes (they can sit over video or the map),
    // so the colours come from the fixed overlay set, never theme tokens -
    // and never the raw dark hexes, which the light-theme remap would darken.
    const tone = confirm
        ? { bg: 'rgba(8, 47, 56, .97)', line: 'var(--overlay-accent)', ink: 'var(--overlay-text)', icon: 'var(--overlay-accent)' }
        : t.kind === 'warn'
            ? { bg: 'rgba(120, 53, 15, .97)', line: 'rgba(251, 191, 36, .55)', ink: '#fef3c7', icon: 'var(--overlay-warn)' }
            : { bg: 'rgba(15, 23, 32, .97)', line: 'var(--overlay-border)', ink: 'var(--overlay-text)', icon: 'var(--overlay-accent)' }
    const Icon = confirm || t.action === 'alert' ? BellRing : t.kind === 'warn' ? TriangleAlert : Info
    const verb = t.action && t.action !== 'attachment' ? ACTION_WORDS[t.action].short : 'Do it'
    const ask = t.action === 'attachment' ? ' Do it?' : ` ${verb} it?`
    const secs = Math.ceil(left / 1000)

    return (
        <div role={confirm || t.kind === 'warn' ? 'alert' : 'status'}
            className="pointer-events-auto flex flex-col gap-2 overflow-hidden rounded-[10px] px-3.5 py-2.5 text-[13px] shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-[240ms]"
            style={{ background: tone.bg, border: `1px solid ${tone.line}`, color: tone.ink }}>
            <div className="flex items-start gap-2.5">
                <Icon size={18} className="mt-0.5 shrink-0" style={{ color: tone.icon }} aria-hidden />
                <span className="min-w-0 flex-1 leading-relaxed">
                    {t.message}{confirm && t.action && !t.message.trim().endsWith('?') ? ask : ''}
                </span>
                <button type="button" onClick={() => setMuted(!muted)}
                    aria-label={muted ? 'Turn rule sounds on' : 'Mute rule sounds'} title={muted ? 'Sounds off' : 'Sounds on'}
                    className="-my-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms] hover:bg-white/10"
                    style={{ color: 'var(--overlay-muted)' }}>
                    {muted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
                </button>
                {!confirm && (
                    <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss"
                        title="Dismiss"
                        className="-my-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms] hover:bg-white/10">
                        <X size={16} aria-hidden />
                    </button>
                )}
            </div>
            {confirm && (
                <>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => answer(t, true)}
                            className="h-8 rounded-md px-3 text-[13px] font-bold"
                            style={{ background: 'var(--overlay-accent)', color: '#04161b' }}>
                            {verb}
                        </button>
                        <button type="button" onClick={() => answer(t, false)}
                            className="h-8 rounded-md border px-3 text-[13px] font-semibold transition-colors duration-[120ms] hover:bg-white/10"
                            style={{ borderColor: 'var(--overlay-border)', color: 'var(--overlay-text)' }}>
                            Ignore
                        </button>
                        <span className="ml-auto tabular-nums" style={{ color: 'var(--overlay-muted)' }} aria-live="off">{secs} s</span>
                    </div>
                    <span className="h-1 overflow-hidden rounded-full bg-white/15" aria-hidden>
                        <i className="block h-full motion-safe:transition-[width] motion-safe:duration-200"
                            style={{ width: `${Math.max(0, Math.min(1, left / total)) * 100}%`, background: 'var(--overlay-accent)' }} />
                    </span>
                </>
            )}
        </div>
    )
}

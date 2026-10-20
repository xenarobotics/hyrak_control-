'use client'

// App-wide notices from custom model rules (rule_event) and the old single
// alert (model_alert): a small stack, top centre, below the zone, refusal and
// takeover banners. Info goes away by itself after 6 s; a question
// ("Person seen (82%). Follow it?") stays until answered or its 10 s run out.
// Mounted once in the platform layout.

import { useEffect, useState } from 'react'
import { BellRing, Info, TriangleAlert, Volume2, VolumeX, X } from 'lucide-react'
import { ACTION_WORDS, ensureRulesFeed, useRulesStore, type RuleToast } from '@/lib/modelRules'

const INFO_MS = 6000
const WARN_MS = 9000

export function RuleToasts() {
    const toasts = useRulesStore(s => s.toasts)
    useEffect(() => { ensureRulesFeed() }, [])
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

    const tone = confirm
        ? { bg: 'rgba(8, 47, 56, .97)', line: 'rgba(34, 211, 238, .6)', ink: '#cffafe', icon: '#22d3ee' }
        : t.kind === 'warn'
            ? { bg: 'rgba(120, 53, 15, .96)', line: 'rgba(251, 191, 36, .55)', ink: '#fef3c7', icon: '#fbbf24' }
            : { bg: 'rgba(15, 23, 32, .96)', line: 'rgba(148, 163, 184, .35)', ink: '#e2e8f0', icon: '#22d3ee' }
    const Icon = confirm || t.action === 'alert' ? BellRing : t.kind === 'warn' ? TriangleAlert : Info
    const verb = t.action ? ACTION_WORDS[t.action].short : 'Do it'
    const secs = Math.ceil(left / 1000)

    return (
        <div role={confirm || t.kind === 'warn' ? 'alert' : 'status'}
            className="pointer-events-auto flex flex-col gap-2 overflow-hidden rounded-xl px-3.5 py-2.5 font-mono text-[11px] shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-150"
            style={{ background: tone.bg, border: `1px solid ${tone.line}`, color: tone.ink, backdropFilter: 'blur(8px)' }}>
            <div className="flex items-start gap-2.5">
                <Icon size={15} className="mt-px shrink-0" style={{ color: tone.icon }} aria-hidden />
                <span className="min-w-0 flex-1 leading-relaxed">
                    {t.message}{confirm && t.action && !t.message.trim().endsWith('?') ? ` ${verb} it?` : ''}
                </span>
                <button type="button" onClick={() => setMuted(!muted)}
                    aria-label={muted ? 'Turn rule sounds on' : 'Mute rule sounds'} title={muted ? 'Sounds off' : 'Sounds on'}
                    className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100">
                    {muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
                </button>
                {!confirm && (
                    <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss"
                        className="shrink-0 rounded p-0.5 hover:bg-white/10">
                        <X size={13} aria-hidden />
                    </button>
                )}
            </div>
            {confirm && (
                <>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => answer(t, true)}
                            className="h-7 rounded-md px-3 text-[11px] font-semibold tracking-wide"
                            style={{ background: '#22d3ee', color: '#04161b' }}>
                            {verb}
                        </button>
                        <button type="button" onClick={() => answer(t, false)}
                            className="h-7 rounded-md border border-white/25 px-3 text-[11px] hover:bg-white/10">
                            Ignore
                        </button>
                        <span className="ml-auto tabular-nums opacity-80" aria-live="off">{secs} s</span>
                    </div>
                    <span className="h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
                        <i className="block h-full motion-safe:transition-[width] motion-safe:duration-200"
                            style={{ width: `${Math.max(0, Math.min(1, left / total)) * 100}%`, background: '#22d3ee' }} />
                    </span>
                </>
            )}
        </div>
    )
}

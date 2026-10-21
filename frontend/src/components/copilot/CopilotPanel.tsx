'use client'

// The Command dock's Copilot tab (copilot_contract.md, Frontend):
//   header        on/off switch and the model chips (Speech, Vision, Planner)
//   task bar      magenta while HYRAK follows, tracks or orbits, with Stop
//   conversation  pilot and Copilot lines, plan cards and target cards
//   composer      hold to talk (or hold V), a text box, mute for replies

import { useEffect, useRef, useState } from 'react'
import {
    Loader2, Send, Volume2, VolumeX, Crosshair, Orbit, Navigation, Square, AudioLines, TriangleAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import {
    useCopilotStore, ensureCopilotFeed, setCopilotEnabled, sendCopilotText, cancelCopilot, isFollowMe, toMs,
    MAX_TEXT, type CopilotMessage, type CopilotTask,
} from '@/lib/copilot'
import { CopilotCardView } from './CopilotCards'
import { PushToTalkButton, MicExplain, MicPicker } from './PushToTalk'
import { FollowMeChip } from './FollowMeSharer'

// ── header ───────────────────────────────────────────────────────────────

function Switch({ on, pending, onClick }: { on: boolean; pending: boolean; onClick: () => void }) {
    return (
        <button onClick={onClick} role="switch" aria-checked={on} aria-label="Copilot"
            title={on ? 'Turn Copilot off' : 'Turn Copilot on'}
            className={cn('relative w-11 h-6 rounded-full border shrink-0 transition-colors duration-[140ms] after:absolute after:-inset-2', FOCUS,
                on ? 'bg-app-accent border-app-accent' : 'bg-app-surface-2 border-app-border-strong')}>
            <span className={cn('absolute left-0 top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full shadow-md flex items-center justify-center',
                'transition-transform duration-[140ms] motion-reduce:transition-none',
                on ? 'translate-x-[21px] bg-[hsl(var(--app-raised))]' : 'translate-x-[2px] bg-app-text-muted')}>
                {pending && <Loader2 size={12} className="animate-spin motion-reduce:animate-none text-app-text-muted" />}
            </span>
        </button>
    )
}

type ChipState = 'ready' | 'loading' | 'idle'

function Chip({ label, state, hint }: { label: string; state: ChipState; hint: string }) {
    return (
        <span title={hint}
            className="h-7 px-2.5 rounded-full border border-app-border flex items-center gap-1.5 text-[12px] font-semibold text-app-text whitespace-nowrap">
            {state === 'loading'
                ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none text-app-text-muted" />
                : <span aria-hidden className={cn('size-2 rounded-full', state === 'ready' ? 'bg-app-ok' : 'border border-app-text-subtle')} />}
            {label}
            <span className="sr-only">{state === 'ready' ? 'ready' : state === 'loading' ? 'loading' : 'loads on first use'}</span>
        </span>
    )
}

/** Which chip a server model name belongs to (the contract lists the names
 *  loading, not their spelling). */
function loadingFor(loading: string[], words: string[]): boolean {
    return loading.some(n => words.some(w => n.toLowerCase().includes(w)))
}

function ModelChips() {
    const ready = useCopilotStore(s => s.ready)
    const loading = useCopilotStore(s => s.loading)
    const enabled = useCopilotStore(s => s.enabled)
    const st = (isReady: boolean, words: string[]): ChipState =>
        loadingFor(loading, words) ? 'loading' : enabled && isReady ? 'ready' : 'idle'
    const claude = ready.planner === 'claude'
    return (
        <div className="flex flex-wrap gap-1.5">
            <Chip label="Speech" state={st(!!ready.stt, ['stt', 'speech', 'whisper'])}
                hint="Speech to text (Whisper on the HYRAK server). Loads on first use." />
            <Chip label="Vision" state={st(!!ready.vision, ['vision', 'florence'])}
                hint="Finds and describes things in the camera picture (Florence-2). Loads on first use." />
            <Chip label={`Planner: ${claude ? 'Claude' : 'Basic'}`} state={st(true, ['planner', 'claude'])}
                hint={claude ? 'Claude plans requests; safety words are handled on the server first.'
                    : 'The built-in planner understands the core commands. Claude plans when the server has an API key.'} />
        </div>
    )
}

// ── task bar ─────────────────────────────────────────────────────────────

const VERB: Record<string, string> = {
    follow: 'Following', follow_me: 'Following', track: 'Tracking', orbit: 'Orbiting', survey: 'Surveying',
}

function taskText(t: CopilotTask): string {
    if (isFollowMe(t)) return 'Following you'
    const verb = VERB[t.kind.toLowerCase().replace(/[-\s]/g, '_')] ?? 'Active'
    const label = t.label?.trim() ?? ''
    if (!label) return verb
    return label.toLowerCase().startsWith(verb.toLowerCase()) ? label : `${verb}: ${label}`
}

function useElapsed(since: number | undefined): string {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!since) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [since])
    if (!since) return ''
    const s = Math.max(0, Math.round((now - toMs(since)) / 1000))
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

function TaskBar() {
    const task = useCopilotStore(s => s.task)
    const elapsed = useElapsed(task?.since)
    if (!task) return null
    const k = task.kind.toLowerCase()
    const Icon = k.startsWith('orbit') ? Orbit : k.startsWith('survey') ? Navigation : Crosshair
    return (
        <div role="status" className="flex items-center gap-2 min-h-11 pl-3 pr-1.5 py-1 rounded-[10px] border border-app-magenta bg-app-magenta-soft">
            <Icon size={16} className="shrink-0 text-app-magenta" />
            <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-app-text truncate">{taskText(task)}</p>
                {elapsed && <p className="text-[12px] text-app-text-muted tabular-nums">for {elapsed}</p>}
            </div>
            <button onClick={cancelCopilot} title="Stop the task (the drone holds)"
                className={cn('shrink-0 h-9 px-3 rounded-md border border-app-border-strong bg-app-surface flex items-center gap-1.5 text-[13px] font-bold text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms] active:scale-[.98]', FOCUS)}>
                <Square size={12} className="fill-current" /> Stop</button>
        </div>
    )
}

// ── conversation ─────────────────────────────────────────────────────────

function MessageRow({ m }: { m: CopilotMessage }) {
    if (m.role === 'system') {
        return (
            <p className={cn('self-center max-w-[92%] text-center text-[12px] font-semibold px-2',
                m.status === 'error' ? 'text-app-danger' : 'text-app-text-muted')}>{m.text}</p>
        )
    }
    const pilot = m.role === 'pilot'
    const thinking = m.status === 'thinking'
    return (
        <div className={cn('flex flex-col gap-1.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
            pilot ? 'items-end' : 'items-start')}>
            <span className="text-[12px] font-semibold text-app-text-muted px-1">{pilot ? 'You' : 'HYRAK'}</span>
            {(m.text || thinking) && (
                <div className={cn('max-w-[88%] rounded-[12px] px-3 py-2 text-[14px] leading-snug break-words',
                    pilot ? 'bg-app-accent-soft border border-[color-mix(in_srgb,var(--app-accent)_35%,transparent)] text-app-text rounded-br-[4px]'
                        : 'bg-app-surface-2 text-app-text rounded-bl-[4px]',
                    m.status === 'refused' && 'border border-app-warn',
                    m.status === 'error' && 'border border-app-danger')}>
                    {thinking && !m.text ? (
                        <span className="flex items-center gap-2 text-app-text-muted">
                            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> Thinking</span>
                    ) : (
                        <span className="flex items-start gap-2">
                            {m.status === 'refused' && <TriangleAlert size={15} className="shrink-0 mt-0.5 text-app-warn" />}
                            {m.status === 'error' && <TriangleAlert size={15} className="shrink-0 mt-0.5 text-app-danger" />}
                            <span>{m.text}</span>
                            {thinking && <Loader2 size={14} className="shrink-0 mt-0.5 animate-spin motion-reduce:animate-none text-app-text-muted" />}
                        </span>
                    )}
                </div>
            )}
            {m.card && <div className="w-full max-w-[96%]"><CopilotCardView card={m.card} /></div>}
        </div>
    )
}

const EXAMPLES = [
    'Follow the man in the red shirt', 'Count the people', 'What do you see?',
    'Go up 10 metres', 'Orbit here at 20 metres radius', 'Battery?',
]

function Conversation({ onExample }: { onExample: (t: string) => void }) {
    const messages = useCopilotStore(s => s.messages)
    const ref = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const last = messages[messages.length - 1]

    // Newest at the bottom: follow it unless the pilot scrolled up to read.
    useEffect(() => {
        const el = ref.current
        if (el && stick.current) el.scrollTop = el.scrollHeight
    }, [messages.length, last?.text, last?.status, last?.card])

    return (
        <div ref={ref} onScroll={e => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
            role="log" aria-live="polite" aria-label="Copilot conversation"
            className="max-md:max-h-[52vh] max-md:min-h-[200px] md:flex-1 md:min-h-[120px] overflow-y-auto -mx-1 px-1 flex flex-col gap-3">
            {messages.length === 0 ? (
                <div className="my-auto flex flex-col items-center gap-3 py-4 text-center">
                    <p className="text-[13px] text-app-text-muted max-w-[280px]">
                        Hold the button and speak, or type below. Anything that moves the drone shows a plan to confirm first.</p>
                    <div className="flex flex-wrap justify-center gap-1.5">
                        {EXAMPLES.map(e => (
                            <button key={e} onClick={() => onExample(e)} title="Put this in the text box"
                                className={cn('h-8 px-2.5 rounded-full border border-app-border text-[12px] font-semibold text-app-text-muted hover:text-app-text hover:border-app-border-strong transition-colors duration-[140ms]', FOCUS)}>
                                {e}</button>
                        ))}
                    </div>
                </div>
            ) : messages.map(m => <MessageRow key={m.id} m={m} />)}
        </div>
    )
}

// ── composer ─────────────────────────────────────────────────────────────

function Composer({ text, setText, inputRef }: {
    text: string; setText: (t: string) => void; inputRef: React.RefObject<HTMLInputElement | null>
}) {
    const enabled = useCopilotStore(s => s.enabled)
    const muted = useCopilotStore(s => s.muted)
    const setMuted = useCopilotStore(s => s.setMuted)
    const hint = useCopilotStore(s => s.listeningHint)
    const submit = () => { if (sendCopilotText(text)) setText('') }
    return (
        <div className="shrink-0 flex flex-col gap-2 pt-1 border-t border-app-border">
            <MicExplain />
            <MicPicker />
            <div className="hidden md:block pt-2"><PushToTalkButton disabled={!enabled} /></div>
            {hint && enabled && <p className="text-[12px] text-app-text-muted">{hint}</p>}
            {/* Phone: the round talk button floats at the right of this row. */}
            <form className={cn('flex gap-2 max-md:pt-2', enabled && 'max-md:pr-[76px]')} onSubmit={e => { e.preventDefault(); submit() }}>
                <label htmlFor="copilot-text" className="sr-only">Type a command</label>
                <input id="copilot-text" ref={inputRef} value={text} disabled={!enabled}
                    onChange={e => setText(e.target.value.slice(0, MAX_TEXT))}
                    placeholder={enabled ? 'Type a command' : 'Turn Copilot on to type'} autoComplete="off" enterKeyHint="send"
                    className={cn('flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-strong bg-app-surface-2 text-[14px] text-app-text placeholder:text-app-text-subtle',
                        'transition-colors duration-[140ms] disabled:cursor-not-allowed disabled:border-app-border', FOCUS)} />
                <button type="submit" disabled={!enabled || !text.trim()} aria-label="Send" title="Send"
                    className={cn('size-10 shrink-0 rounded-md flex items-center justify-center bg-app-accent text-[var(--app-accent-ink)] hover:brightness-110 transition-[filter,transform] duration-[140ms] active:scale-[.98]', FOCUS,
                        'disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:border disabled:border-app-border disabled:hover:brightness-100 disabled:cursor-not-allowed')}>
                    <Send size={16} /></button>
                <button type="button" onClick={() => setMuted(!muted)} aria-pressed={muted}
                    aria-label={muted ? 'Unmute voice replies' : 'Mute voice replies'} title={muted ? 'Voice replies muted' : 'Voice replies on'}
                    className={cn('size-10 shrink-0 rounded-md border flex items-center justify-center transition-colors duration-[140ms]', FOCUS,
                        muted ? 'border-app-border-strong text-app-text-muted hover:text-app-text' : 'border-app-border-strong text-app-text hover:bg-app-surface-2')}>
                    {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
            </form>
        </div>
    )
}

// ── panel ────────────────────────────────────────────────────────────────

function OffState() {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-6 text-center">
            <span className="size-12 rounded-full border border-app-border bg-app-surface-2 flex items-center justify-center text-app-text-muted">
                <AudioLines size={22} /></span>
            <p className="text-[14px] font-bold text-app-text">Fly by voice</p>
            <p className="text-[13px] text-app-text-muted max-w-[290px]">
                Ask HYRAK to hold, land, follow a person or car, count what it sees or survey an area.
                Plans that move the drone wait for your confirm.</p>
            <button onClick={() => setCopilotEnabled(true)}
                className={cn('h-10 px-4 rounded-md bg-app-accent text-[var(--app-accent-ink)] text-[14px] font-bold hover:brightness-110 transition-[filter,transform] duration-[140ms] active:scale-[.98]', FOCUS)}>
                Turn on Copilot</button>
            <p className="text-[12px] text-app-text-muted">Models load on first use and stay warm while Copilot is on.</p>
        </div>
    )
}

export function CopilotPanel() {
    const enabled = useCopilotStore(s => s.enabled)
    const pending = useCopilotStore(s => s.pendingEnabled)
    const hasMessages = useCopilotStore(s => s.messages.length > 0)
    const [text, setText] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => { ensureCopilotFeed() }, [])

    const shownOn = pending ?? enabled
    return (
        <div className="flex flex-col gap-3 md:flex-1 md:min-h-0">
            <div className="flex flex-col gap-2 shrink-0">
                <div className="flex items-center gap-2">
                    <AudioLines size={16} className="text-app-text-muted" />
                    <span className="text-[16px] font-bold text-app-text">Copilot</span>
                    <span className="ml-auto text-[13px] font-semibold text-app-text-muted">{shownOn ? 'On' : 'Off'}</span>
                    <Switch on={shownOn} pending={pending !== null} onClick={() => setCopilotEnabled(!shownOn)} />
                </div>
                <ModelChips />
            </div>
            <TaskBar />
            <FollowMeChip />
            {!enabled && !hasMessages ? <OffState /> : (
                <Conversation onExample={t => { setText(t); inputRef.current?.focus() }} />
            )}
            {(enabled || hasMessages) && <Composer text={text} setText={setText} inputRef={inputRef} />}
        </div>
    )
}

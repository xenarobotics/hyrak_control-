'use client'

// No-code rules for custom models: the plain words, the helpers the editor
// and the running panel share, and the live feed (rule_event, model_control,
// the legacy model_alert) kept in one small store.
//
//   rulesOf          a model's rules, with the legacy single `alert` shown
//                    as one alert rule until the editor saves
//   useRulesStore    model control, the last event per rule, the toasts
//   ensureRulesFeed  wires the store to the socket once per page
//   beep             a short, quiet WebAudio tone (muted is remembered)

import { create } from 'zustand'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { MAX_RULES, type CustomModel, type ModelRule, type RuleAction } from '@/lib/models'
import type { ModelAlertEvent, ModelControlState, RuleEvent } from '@/types/vision'

export { MAX_RULES }

export const RULE_DEFAULTS = { min_score: 0.5, for_s: 1, cooldown_s: 30, confirm: true } as const

export const ACTION_WORDS: Record<RuleAction, { label: string; short: string; hint: string }> = {
    alert: { label: 'Alert me', short: 'Alert', hint: 'A message and a short sound in the app. HYRAK staff see it too.' },
    mark: { label: 'Pin it on the map', short: 'Pin', hint: 'Drops a pin where it is on the ground and keeps it with the flight, even when Record to map is off.' },
    hover: { label: 'Hover (drone stops)', short: 'Hover', hint: 'The drone stops and holds where it is. A running mission is paused.' },
    follow: { label: 'Follow it (drone follows)', short: 'Follow', hint: 'The drone follows it at up to 3 m/s and keeps its height. It stops and holds if it loses sight for 3 s.' },
}

export const ACTIONS: RuleAction[] = ['alert', 'mark', 'hover', 'follow']

/** hover and follow move the drone. */
export const movesDrone = (a: RuleAction) => a === 'hover' || a === 'follow'

/** Classify models have no box, so nothing to pin or follow. */
export const needsBox = (a: RuleAction) => a === 'mark' || a === 'follow'

/** Why something did not happen or stopped, in plain words. The server's
 *  own message wins when it sends one. */
export const REASON_TEXT: Record<string, string> = {
    model_control_off: 'Allow model control is off.',
    taken_over: 'HYRAK staff have taken over this flight.',
    pilot_control: 'The pilot took control with the remote.',
    no_link: 'No drone is connected.',
    not_flying: 'The drone is not flying.',
    red_zone: 'The drone is in a no-fly zone.',
    orange_no_permit: 'The drone is in a restricted zone without a permit.',
    no_position: 'The drone has no GPS position.',
    target_lost: 'It lost sight of the target for 3 seconds.',
    mode_changed: 'The AI model was stopped or changed.',
    link_lost: 'The link to the drone was lost.',
    failed: 'The drone did not accept the command.',
    rules_changed: 'The hover or follow rules were changed. Turn it on again to accept the new rules.',
}

export function reasonText(code?: string | null, message?: string | null): string | null {
    if (message) return message
    if (!code) return null
    return REASON_TEXT[code] ?? 'Something stopped it.'
}

/** A rule id: 12 chars of [a-z0-9]. */
export function newRuleId(): string {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const bytes = new Uint8Array(12)
    try { crypto.getRandomValues(bytes) } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256) }
    return Array.from(bytes, b => abc[b % abc.length]).join('')
}

export function newRule(label: string, action: RuleAction = 'alert'): ModelRule {
    return { id: newRuleId(), enabled: true, label, action, ...RULE_DEFAULTS, confirm: movesDrone(action) }
}

/** The model's rules. A model with only the old single alert shows it as one
 *  alert rule (it fired as soon as it was seen, so "right away"). `legacy`
 *  says the editor must write `alert: null` with its first save. */
export function rulesOf(m: CustomModel | null | undefined): { rules: ModelRule[]; legacy: boolean } {
    if (Array.isArray(m?.rules) && m!.rules.length > 0) return { rules: m!.rules, legacy: false }
    if (m?.alert?.label) {
        return {
            legacy: true,
            rules: [{
                id: newRuleId(), enabled: true, label: m.alert.label, action: 'alert',
                min_score: m.alert.min_score ?? RULE_DEFAULTS.min_score, for_s: 0,
                cooldown_s: m.alert.cooldown_s ?? RULE_DEFAULTS.cooldown_s, confirm: false,
            }],
        }
    }
    return { rules: [], legacy: false }
}

export function pct(score: number): string {
    return `${Math.round(score * 100)}%`
}

export function seconds(s: number): string {
    if (s <= 0) return 'right away'
    if (s >= 60 && s % 60 === 0) return `${s / 60} min`
    return `${s} s`
}

// ── live state ────────────────────────────────────────────────────────────

export type ToastKind = 'info' | 'warn' | 'confirm'

export interface RuleToast {
    id: string
    kind: ToastKind
    message: string
    /** awaiting_confirm: answered with rule_confirm. */
    token?: string
    ruleId?: string
    action?: RuleAction
    /** Local clock, ms. Confirm toasts count down to it. */
    deadline?: number
}

const MAX_TOASTS = 4
const MUTE_KEY = 'hyrak.rules.muted'
/** A cv_results frame may lag a model_control push; trust the push this long. */
const PUSH_WINS_MS = 1500

interface RulesState {
    control: ModelControlState
    controlAt: number
    /** Waiting for the server's answer to the switch. */
    controlPending: boolean
    lastByRule: Record<string, RuleEvent>
    toasts: RuleToast[]
    muted: boolean
    setMuted: (v: boolean) => void
    setControl: (c: ModelControlState) => void
    requestControl: (enabled: boolean) => void
    push: (t: RuleToast) => void
    dismiss: (id: string) => void
    answer: (t: RuleToast, accept: boolean) => void
    onRuleEvent: (e: RuleEvent) => void
    reset: () => void
}

function readMuted(): boolean {
    try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}

export const useRulesStore = create<RulesState>((set, get) => ({
    control: { enabled: false },
    controlAt: 0,
    controlPending: false,
    lastByRule: {},
    toasts: [],
    muted: false,
    setMuted: (v) => {
        try { localStorage.setItem(MUTE_KEY, v ? '1' : '0') } catch { /* fine */ }
        set({ muted: v })
    },
    setControl: (c) => set({ control: c, controlAt: Date.now(), controlPending: false }),
    requestControl: (enabled) => {
        set({ controlPending: true })
        getSocket().emit('set_model_control', { enabled })
        // No answer (an old server, a dropped socket): stop waiting.
        setTimeout(() => { if (get().controlPending) set({ controlPending: false }) }, 5000)
    },
    push: (t) => set(s => {
        const rest = s.toasts.filter(x => x.id !== t.id)
        let next = [...rest, t]
        // Too many: drop the oldest that is not waiting for an answer.
        while (next.length > MAX_TOASTS) {
            const i = next.findIndex(x => x.kind !== 'confirm')
            if (i < 0) break
            next = next.filter((_, j) => j !== i)
        }
        return { toasts: next }
    }),
    dismiss: (id) => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
    answer: (t, accept) => {
        if (t.token) getSocket().emit('rule_confirm', { token: t.token, accept })
        get().dismiss(t.id)
    },
    onRuleEvent: (e) => {
        const s = get()
        set({ lastByRule: { ...s.lastByRule, [e.rule_id]: e } })
        // A later event answers an open question for the same rule.
        if (e.status !== 'awaiting_confirm') {
            set(st => ({ toasts: st.toasts.filter(x => !(x.kind === 'confirm' && (e.token ? x.token === e.token : x.ruleId === e.rule_id))) }))
        }
        const base = { id: e.id, message: e.message, ruleId: e.rule_id, action: e.action }
        switch (e.status) {
            case 'awaiting_confirm': {
                const left = e.expires_at && e.ts ? Math.max(1, e.expires_at - e.ts) : 10
                s.push({ ...base, kind: 'confirm', token: e.token, deadline: Date.now() + left * 1000 })
                beep('confirm')
                break
            }
            case 'done':
                s.push({ ...base, kind: 'info' })
                if (e.action === 'alert') beep('alert')
                break
            case 'refused':
            case 'stopped':
                s.push({ ...base, kind: 'warn' })
                break
            case 'expired':
                s.push({ ...base, kind: 'info' })
                break
            case 'declined':
                // The pilot pressed Ignore: nothing more to say.
                break
        }
    },
    reset: () => set({ control: { enabled: false }, controlAt: 0, controlPending: false, lastByRule: {}, toasts: [] }),
}))

// ── sound ─────────────────────────────────────────────────────────────────

let audio: AudioContext | null = null

/** A short, quiet tone: one for an alert, two rising for a question. */
export function beep(kind: 'alert' | 'confirm'): void {
    if (typeof window === 'undefined' || useRulesStore.getState().muted) return
    try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        audio ??= new Ctx()
        if (audio.state === 'suspended') void audio.resume()
        const notes = kind === 'confirm' ? [660, 880] : [880]
        notes.forEach((f, i) => {
            const t0 = audio!.currentTime + i * 0.16
            const osc = audio!.createOscillator()
            const gain = audio!.createGain()
            osc.type = 'sine'
            osc.frequency.value = f
            gain.gain.setValueAtTime(0.0001, t0)
            gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.015)
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13)
            osc.connect(gain).connect(audio!.destination)
            osc.start(t0)
            osc.stop(t0 + 0.14)
        })
    } catch { /* no sound is fine */ }
}

// ── socket feed ───────────────────────────────────────────────────────────

let attached = false

/** Wire the store to the socket once per page. */
export function ensureRulesFeed(): void {
    if (attached || typeof window === 'undefined') return
    attached = true
    useRulesStore.setState({ muted: readMuted() })
    const socket = getSocket()
    socket.on('rule_event', (e: RuleEvent) => {
        if (e && typeof e === 'object' && e.rule_id) useRulesStore.getState().onRuleEvent(e)
    })
    socket.on('model_control', (c: ModelControlState) => {
        if (c && typeof c === 'object') useRulesStore.getState().setControl({ ...c, enabled: !!c.enabled })
    })
    socket.on('model_alert', (a: ModelAlertEvent) => {
        const st = useRulesStore.getState()
        st.push({
            id: `alert-${a?.ts ?? Date.now()}-${a?.label ?? ''}`, kind: 'info', action: 'alert',
            message: a?.message ?? `${a?.label ?? 'Something'} seen${a?.score != null ? ` (${pct(a.score)})` : ''}`,
        })
        beep('alert')
    })
    // A new session starts with model control off.
    let sessionId: string | null = useDroneStore.getState().session?.session_id ?? null
    socket.on('session_ready', (d: { session_id?: string }) => {
        if (d?.session_id && d.session_id !== sessionId) {
            sessionId = d.session_id
            useRulesStore.getState().reset()
        }
    })
    // cv_results carries the switch too: it corrects a missed push.
    useDroneStore.subscribe((st, prev) => {
        const cv = st.cvResults
        if (!cv || cv === prev.cvResults || typeof cv.model_control !== 'boolean') return
        const r = useRulesStore.getState()
        if (cv.model_control === r.control.enabled || r.controlPending) return
        if (Date.now() - r.controlAt < PUSH_WINS_MS) return
        r.setControl({ ...r.control, enabled: cv.model_control, ...(cv.model_control ? { reason: undefined, reason_code: undefined } : {}) })
    })
}

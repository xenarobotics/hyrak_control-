'use client'

// HYRAK Copilot: the voice-driven assistant on the Command window.
// Contract: copilot_contract.md (event names and payloads below follow it
// exactly). The server owns everything that matters: it transcribes, plans,
// checks the guards and flies; the browser records the pilot's voice, shows
// the conversation and the plan cards, speaks replies and, during follow me,
// shares the pilot's position.

import { create } from 'zustand'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

// ── payloads ─────────────────────────────────────────────────────────────

export type CopilotRole = 'pilot' | 'copilot' | 'system'
export type CopilotMsgStatus = 'thinking' | 'done' | 'refused' | 'error'
export type CopilotPlanner = 'claude' | 'local'
export type CardStatus = 'accepted' | 'declined' | 'expired' | 'done' | 'refused'

/** A box in source-frame pixels: [x1, y1, x2, y2]. */
export type FrameBox = [number, number, number, number]

export interface CopilotCandidate {
    index: number
    label: string
    score: number
    box: FrameBox
    frame_w: number
    frame_h: number
}

export interface CopilotWaypoint { lat: number; lng: number; alt: number }

export interface CopilotPreview {
    waypoints: CopilotWaypoint[]
    area?: { center: { lat: number; lng: number }; radius_m: number }
}

export interface CopilotCard {
    token: string
    kind: 'confirm' | 'choose'
    title: string
    lines: string[]
    moves: boolean
    expires_at: number
    skill: string
    args: Record<string, unknown>
    candidates?: CopilotCandidate[]
    preview?: CopilotPreview
}

export interface CopilotMessage {
    id: string
    role: CopilotRole
    text: string
    ts: number
    status?: CopilotMsgStatus
    speak?: boolean
    card?: CopilotCard
}

export interface CopilotTask {
    kind: string
    label: string
    since: number
    target_box?: FrameBox
    /** Not in the contract; read if the server sends it (see isFollowMe). */
    target?: string
}

export interface CopilotReady {
    stt: boolean
    vision: boolean
    planner: CopilotPlanner
}

export interface CopilotStatePayload {
    enabled: boolean
    loading: string[]
    ready: CopilotReady
    task: CopilotTask | null
    listening_hint?: string
}

export interface CopilotCardUpdate {
    token: string
    status: CardStatus
    message: string
}

/** cv_results.copilot_target, while tracking or following. */
export interface CopilotTarget { box: FrameBox; label: string }

// ── store ────────────────────────────────────────────────────────────────

export type TalkPhase = 'idle' | 'starting' | 'recording' | 'sending'
export type MicAccess = 'unknown' | 'explain' | 'asking' | 'granted' | 'denied'
export type GeoShare = 'off' | 'waiting' | 'sharing' | 'denied' | 'unavailable'

export const MAX_TALK_MS = 15_000
export const MAX_AUDIO_BYTES = 1.5 * 1024 * 1024
export const MAX_TEXT = 500
const MAX_MESSAGES = 200
const MUTE_KEY = 'hyrak-copilot-muted'
const PREVIEW_KEY = 'hyrak-copilot-map-preview'

interface CopilotStore {
    /** The server's word on whether Copilot is on. */
    enabled: boolean
    /** The switch was flipped and the server has not answered yet. */
    pendingEnabled: boolean | null
    loading: string[]
    ready: CopilotReady
    task: CopilotTask | null
    listeningHint: string | null
    messages: CopilotMessage[]
    /** Final status of each card the server closed, by token. */
    cardStatus: Record<string, { status: CardStatus; message: string }>
    /** Cards the pilot answered here, waiting for the server's update. */
    answered: Record<string, 'accept' | 'decline' | number>
    muted: boolean
    /** "Show on map" for plan previews. */
    showPreview: boolean
    talk: { phase: TalkPhase; startedAt: number; level: number }
    mic: MicAccess
    /** Follow me: this browser's position sharing. */
    geo: { state: GeoShare; accuracy: number | null }
    sessionId: string | null

    setState: (p: CopilotStatePayload) => void
    upsertMessage: (m: CopilotMessage) => void
    addLocal: (role: CopilotRole, text: string, status?: CopilotMsgStatus) => void
    updateCard: (u: CopilotCardUpdate) => void
    markAnswered: (token: string, a: 'accept' | 'decline' | number) => void
    setMuted: (m: boolean) => void
    setShowPreview: (v: boolean) => void
    setTalk: (t: Partial<CopilotStore['talk']>) => void
    setMic: (m: MicAccess) => void
    setPendingEnabled: (v: boolean | null) => void
    reset: (sessionId: string | null) => void
}

function readFlag(key: string, fallback: boolean): boolean {
    try {
        const v = localStorage.getItem(key)
        return v === null ? fallback : v === '1'
    } catch { return fallback }
}
function writeFlag(key: string, v: boolean): void {
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* this page only */ }
}

const NOT_READY: CopilotReady = { stt: false, vision: false, planner: 'local' }

export const useCopilotStore = create<CopilotStore>((set, get) => ({
    enabled: false,
    pendingEnabled: null,
    loading: [],
    ready: NOT_READY,
    task: null,
    listeningHint: null,
    messages: [],
    cardStatus: {},
    answered: {},
    // Read from storage in ensureCopilotFeed, after hydration.
    muted: false,
    showPreview: true,
    talk: { phase: 'idle', startedAt: 0, level: 0 },
    mic: 'unknown',
    geo: { state: 'off', accuracy: null },
    sessionId: null,

    setState: (p) => set({
        enabled: !!p.enabled,
        pendingEnabled: null,
        loading: Array.isArray(p.loading) ? p.loading : [],
        ready: { ...NOT_READY, ...(p.ready ?? {}) },
        task: p.task ?? null,
        listeningHint: p.listening_hint ?? null,
    }),
    upsertMessage: (m) => set(s => {
        const i = s.messages.findIndex(x => x.id === m.id)
        if (i >= 0) {
            const next = s.messages.slice()
            next[i] = { ...next[i], ...m }
            return { messages: next }
        }
        return { messages: [...s.messages, m].slice(-MAX_MESSAGES) }
    }),
    addLocal: (role, text, status) => get().upsertMessage({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role, text, ts: Date.now() / 1000, status,
    }),
    updateCard: (u) => set(s => ({ cardStatus: { ...s.cardStatus, [u.token]: { status: u.status, message: u.message ?? '' } } })),
    markAnswered: (token, a) => set(s => ({ answered: { ...s.answered, [token]: a } })),
    setMuted: (m) => { writeFlag(MUTE_KEY, m); set({ muted: m }); if (m) stopSpeaking() },
    setShowPreview: (v) => { writeFlag(PREVIEW_KEY, v); set({ showPreview: v }) },
    setTalk: (t) => set(s => ({ talk: { ...s.talk, ...t } })),
    setMic: (m) => set({ mic: m }),
    setPendingEnabled: (v) => set({ pendingEnabled: v }),
    reset: (sessionId) => set({
        sessionId, enabled: false, pendingEnabled: null, loading: [], ready: NOT_READY, task: null,
        listeningHint: null, messages: [], cardStatus: {}, answered: {},
    }),
}))

// ── derived ──────────────────────────────────────────────────────────────

/** Server timestamps are seconds (python time.time()); accept ms too. */
export function toMs(t: number): number {
    return t < 1e12 ? t * 1000 : t
}

/** A card still waiting for the pilot: not closed by the server and not
 *  past its expiry. */
export function cardOpen(card: CopilotCard, s: Pick<CopilotStore, 'cardStatus'>, now = Date.now()): boolean {
    return !s.cardStatus[card.token] && toMs(card.expires_at) > now
}

/** The newest open card of a kind, for the video overlay and the map. */
export function latestOpenCard(
    s: Pick<CopilotStore, 'messages' | 'cardStatus'>, pred: (c: CopilotCard) => boolean, now = Date.now(),
): CopilotCard | null {
    for (let i = s.messages.length - 1; i >= 0; i--) {
        const c = s.messages[i].card
        if (c && pred(c) && cardOpen(c, s, now)) return c
    }
    return null
}

/** The contract names the follow-me task only by its skill ("follow" with
 *  target "me"); accept the likely kind spellings. */
export function isFollowMe(t: CopilotTask | null): boolean {
    if (!t) return false
    const k = t.kind.toLowerCase().replace(/[-\s]/g, '_')
    if (k === 'follow_me') return true
    return k === 'follow' && (t.target === 'me' || /^(following )?(me|you)$/i.test(t.label.trim()))
}

// ── voice replies ────────────────────────────────────────────────────────

let voice: SpeechSynthesisVoice | null = null
function pickVoice(): SpeechSynthesisVoice | null {
    if (voice) return voice
    const all = window.speechSynthesis.getVoices()
    voice = all.find(v => v.lang === 'en-GB' && v.localService)
        ?? all.find(v => v.lang === 'en-US' && v.localService)
        ?? all.find(v => v.lang.startsWith('en'))
        ?? null
    return voice
}

export function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    if (useCopilotStore.getState().muted || !text.trim()) return
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) u.voice = v
    u.lang = v?.lang ?? 'en-GB'
    u.rate = 1.05
    window.speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
}

const spoken = new Set<string>()
function maybeSpeak(m: CopilotMessage): void {
    if (!m.speak || m.role === 'pilot' || m.status === 'thinking' || spoken.has(m.id)) return
    spoken.add(m.id)
    speak(m.text)
}

// ── socket feed ──────────────────────────────────────────────────────────

let attached = false

/** Wire the store to the socket once per page. Safe to call from every
 *  component that reads the store. */
export function ensureCopilotFeed(): void {
    if (attached || typeof window === 'undefined') return
    attached = true
    useCopilotStore.setState({ muted: readFlag(MUTE_KEY, false), showPreview: readFlag(PREVIEW_KEY, true) })
    const socket = getSocket()
    socket.on('copilot_state', (p: CopilotStatePayload) => {
        if (p && typeof p === 'object') useCopilotStore.getState().setState(p)
    })
    socket.on('copilot_message', (m: CopilotMessage) => {
        if (!m || typeof m.id !== 'string') return
        useCopilotStore.getState().upsertMessage(m)
        maybeSpeak(m)
    })
    socket.on('copilot_card_update', (u: CopilotCardUpdate) => {
        if (u && typeof u.token === 'string') useCopilotStore.getState().updateCard(u)
    })
    // A new cloud session starts a new conversation; a resumed one keeps it.
    const onReady = (d: { session_id?: string; resumed?: boolean }) => {
        const st = useCopilotStore.getState()
        if (!d?.session_id || st.sessionId === d.session_id) return
        if (st.sessionId && !d.resumed) st.reset(d.session_id)
        else useCopilotStore.setState({ sessionId: d.session_id })
    }
    socket.on('session_ready', onReady)
    const current = useDroneStore.getState().session?.session_id
    if (current) onReady({ session_id: current })
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.addEventListener?.('voiceschanged', () => { voice = null })
    }
}

// ── emit helpers ─────────────────────────────────────────────────────────

/** Emit only on a live socket: socket.io would otherwise queue the command
 *  and deliver a stale "land" whenever the link came back. */
function send(event: string, data: unknown): boolean {
    const s = getSocket()
    if (!s.connected) {
        useCopilotStore.getState().addLocal('system', 'Not connected to the server. Try again when the link is back.', 'error')
        return false
    }
    s.emit(event, data)
    return true
}

export function setCopilotEnabled(enabled: boolean): void {
    if (send('copilot_set', { enabled })) useCopilotStore.getState().setPendingEnabled(enabled)
    if (!enabled) stopSpeaking()
}

export function sendCopilotText(text: string): boolean {
    const t = text.trim().slice(0, MAX_TEXT)
    if (!t) return false
    stopSpeaking()
    return send('copilot_text', { text: t })
}

export function sendCopilotAudio(audio: ArrayBuffer, mime: string): boolean {
    return send('copilot_audio', { audio, mime })
}

export function confirmCard(token: string, accept: boolean): void {
    if (send('copilot_confirm', { token, accept })) useCopilotStore.getState().markAnswered(token, accept ? 'accept' : 'decline')
}

export function chooseCandidate(token: string, index: number): void {
    if (send('copilot_choose', { token, index })) useCopilotStore.getState().markAnswered(token, index)
}

export function cancelCopilot(): void {
    stopSpeaking()
    send('copilot_cancel', {})
}

export function sendPilotPosition(lat: number, lon: number, accuracy_m: number): void {
    // Position samples are periodic: a dropped one is replaced in 2 s, so
    // no message for a dead link here.
    const s = getSocket()
    if (s.connected) s.emit('copilot_pilot_position', { lat, lon, accuracy_m })
}

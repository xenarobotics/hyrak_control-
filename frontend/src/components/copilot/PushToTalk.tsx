'use client'

// Push to talk: hold the button (or V) to record, release to send.
//
// The microphone is opened on press and closed on release, so nothing is
// ever recorded unless the pilot is holding. The first time, the browser's
// permission prompt is preceded by one plain explanation (MicExplain); the
// press that finds permission unknown opens that explanation instead of
// recording. Every utterance is capped at 15 s and 1.5 MB.

import { useEffect, useState } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
import { SimpleSelect } from '@/components/ui/select'
import {
    useCopilotStore, sendCopilotAudio, stopSpeaking, MAX_TALK_MS, MAX_AUDIO_BYTES,
} from '@/lib/copilot'

const MIC_OK_KEY = 'hyrak-copilot-mic-ok'
const MIN_TALK_MS = 350

// ── recorder (one per page) ──────────────────────────────────────────────

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let audioCtx: AudioContext | null = null
let meterRaf = 0
let capTimer: ReturnType<typeof setTimeout> | null = null
/** Released before the microphone opened: stop as soon as it does. */
let releaseEarly = false

function pickMime(): string {
    const want = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']
    for (const m of want) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
    return ''
}

function micKnownOk(): boolean {
    try { return localStorage.getItem(MIC_OK_KEY) === '1' } catch { return false }
}

export function micSupported(): boolean {
    return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
}

// The microphone to record from. The system default can be a virtual
// device (a "Loopback" or "Monitor" source) that carries no room sound, so
// the pilot can pick one, and without a pick a virtual default is skipped.
const MIC_DEVICE_KEY = 'hyrak.copilot.micDevice'
const VIRTUAL_MIC = /loopback|monitor|virtual|stereo mix|what u hear|null/i

export function savedMicId(): string {
    try { return localStorage.getItem(MIC_DEVICE_KEY) || '' } catch { return '' }
}

export function saveMicId(id: string): void {
    try { if (id) localStorage.setItem(MIC_DEVICE_KEY, id); else localStorage.removeItem(MIC_DEVICE_KEY) } catch { /* not remembered */ }
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
    try {
        return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
    } catch { return [] }
}

/** The device to open: the pilot's pick if it still exists, else the
 *  first real (non-virtual) microphone when the default looks virtual. */
async function micToUse(): Promise<string> {
    const mics = await listMics()
    const saved = savedMicId()
    if (saved && mics.some(m => m.deviceId === saved)) return saved
    // Chromium on Linux names the system default just "Default", so it
    // cannot be told apart from a virtual source that way. When the system
    // has any virtual input at all, open a real microphone by name instead
    // of trusting "Default".
    const named = mics.filter(m => m.deviceId !== 'default' && m.deviceId !== 'communications' && m.label)
    const real = named.find(m => !VIRTUAL_MIC.test(m.label))
    const def = mics.find(m => m.deviceId === 'default') ?? mics[0]
    if (real && (named.some(m => VIRTUAL_MIC.test(m.label)) || (def && VIRTUAL_MIC.test(def.label)))) {
        return real.deviceId
    }
    return ''
}

let micLabel = ''
// Loudest level seen while recording: a take with no sound at all is not sent.
let peak = 0
const SILENT_PEAK = 0.02

/** The explanation's button: ask the browser, then close the stream at once. */
export async function requestMic(): Promise<void> {
    const st = useCopilotStore.getState()
    st.setMic('asking')
    try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true })
        s.getTracks().forEach(t => t.stop())
        try { localStorage.setItem(MIC_OK_KEY, '1') } catch { /* asked again next time */ }
        st.setMic('granted')
    } catch {
        st.setMic('denied')
    }
}

// The microphone stays open (not recording) for a while after a take, and
// from when Copilot is switched on once permission is known, so the next
// press records at once instead of losing the first word to device start-up.
// Nothing is recorded or sent unless the button is held.
const WARM_MS = 90_000
let warmTimer: ReturnType<typeof setTimeout> | null = null
let warmId = ''

function live(s: MediaStream | null): s is MediaStream {
    return !!s && s.getAudioTracks().some(t => t.readyState === 'live')
}

export function releaseMic(): void {
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null }
    if (recorder && recorder.state !== 'inactive') return      // never cut a take
    stream?.getTracks().forEach(t => t.stop())
    stream = null
}

function keepWarm(): void {
    if (warmTimer) clearTimeout(warmTimer)
    warmTimer = setTimeout(releaseMic, WARM_MS)
}

async function openMic(): Promise<MediaStream> {
    const id = await micToUse()
    if (live(stream) && warmId === id) return stream
    stream?.getTracks().forEach(t => t.stop())
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    let s: MediaStream
    try {
        s = await navigator.mediaDevices.getUserMedia({ audio: id ? { ...base, deviceId: { exact: id } } : base })
    } catch (e) {
        // The chosen device is gone: fall back to the system default.
        if (!id || (e as DOMException)?.name === 'NotAllowedError') throw e
        s = await navigator.mediaDevices.getUserMedia({ audio: base })
    }
    stream = s
    warmId = id
    micLabel = s.getAudioTracks()[0]?.label ?? ''
    return s
}

/** Copilot switched on with the microphone already allowed: open it now. */
export async function warmMic(): Promise<void> {
    if (!micSupported() || !micKnownOk()) return
    try { await openMic(); keepWarm() } catch { /* opened on the first press instead */ }
}

function cleanup(): void {
    cancelAnimationFrame(meterRaf)
    if (capTimer) { clearTimeout(capTimer); capTimer = null }
    keepWarm()
    void audioCtx?.close().catch(() => { /* already closed */ })
    audioCtx = null
}

function startMeter(s: MediaStream): void {
    try {
        audioCtx = new AudioContext()
        const src = audioCtx.createMediaStreamSource(s)
        const an = audioCtx.createAnalyser()
        an.fftSize = 512
        src.connect(an)
        const buf = new Uint8Array(an.fftSize)
        let last = 0
        const tick = (t: number) => {
            meterRaf = requestAnimationFrame(tick)
            if (t - last < 66) return               // ~15 updates a second
            last = t
            an.getByteTimeDomainData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
            const rms = Math.sqrt(sum / buf.length)
            if (rms > peak) peak = rms
            useCopilotStore.getState().setTalk({ level: Math.min(1, rms * 4) })
        }
        meterRaf = requestAnimationFrame(tick)
    } catch { /* no meter, recording still works */ }
}

/** Press: open the microphone and record. */
export async function startTalk(): Promise<void> {
    const st = useCopilotStore.getState()
    if (!st.enabled || st.talk.phase !== 'idle') return
    if (!micSupported()) {
        st.addLocal('system', 'This browser cannot record audio here. Type instead.', 'error')
        return
    }
    if (st.mic === 'denied') { st.setMic('denied'); return }
    if (st.mic !== 'granted' && !micKnownOk()) {
        // Permission state from the browser when it can tell us.
        try {
            const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName })
            if (p?.state === 'denied') { st.setMic('denied'); return }
            if (p?.state !== 'granted') { st.setMic('explain'); return }
        } catch { st.setMic('explain'); return }
    }
    stopSpeaking()
    releaseEarly = false
    st.setTalk({ phase: 'starting', startedAt: Date.now(), level: 0 })
    let mic: MediaStream
    try {
        mic = await openMic()
    } catch {
        cleanup()
        releaseMic()
        st.setTalk({ phase: 'idle', level: 0 })
        try { localStorage.removeItem(MIC_OK_KEY) } catch { /* fine */ }
        st.setMic('denied')
        return
    }
    st.setMic('granted')
    const mime = pickMime()
    try {
        recorder = new MediaRecorder(mic, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined)
    } catch {
        cleanup()
        st.setTalk({ phase: 'idle', level: 0 })
        st.addLocal('system', 'Could not start recording. Type instead.', 'error')
        return
    }
    chunks = []
    peak = 0
    const startedAt = Date.now()
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    recorder.onstop = () => void finish(recorder?.mimeType || mime || 'audio/webm', Date.now() - startedAt)
    recorder.start()
    st.setTalk({ phase: 'recording', startedAt, level: 0 })
    startMeter(mic)
    capTimer = setTimeout(() => stopTalk(), MAX_TALK_MS)
    if (releaseEarly) stopTalk()
}

/** Release: stop and send. */
export function stopTalk(): void {
    const phase = useCopilotStore.getState().talk.phase
    if (phase === 'starting') { releaseEarly = true; return }
    if (phase !== 'recording' || !recorder) return
    useCopilotStore.getState().setTalk({ phase: 'sending', level: 0 })
    if (recorder.state !== 'inactive') recorder.stop()
}

async function finish(mime: string, ms: number): Promise<void> {
    cleanup()
    recorder = null
    const st = useCopilotStore.getState()
    const blob = new Blob(chunks, { type: mime })
    chunks = []
    try {
        if (ms < MIN_TALK_MS || blob.size === 0) {
            st.addLocal('system', 'Too short. Hold the button while you speak.')
            return
        }
        if (peak > 0 && peak < SILENT_PEAK) {
            st.addLocal('system', `No sound came from ${micLabel ? `"${micLabel}"` : 'the microphone'}. `
                + 'Pick another microphone below, or check it is not muted.', 'error')
            st.setMicHint(true)
            return
        }
        st.setMicHint(false)
        if (blob.size > MAX_AUDIO_BYTES) {
            st.addLocal('system', 'That recording is too large to send. Try a shorter command.', 'error')
            return
        }
        sendCopilotAudio(await blob.arrayBuffer(), mime)
    } finally {
        st.setTalk({ phase: 'idle', level: 0 })
    }
}

// ── UI ───────────────────────────────────────────────────────────────────

function fmt(ms: number): string {
    const s = Math.min(MAX_TALK_MS, Math.max(0, ms)) / 1000
    return `0:${String(Math.floor(s)).padStart(2, '0')}`
}

/** Elapsed recording time, ticking while recording. */
export function useTalkElapsed(): number {
    const talk = useCopilotStore(s => s.talk)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (talk.phase !== 'recording') return
        const t = setInterval(() => setNow(Date.now()), 200)
        return () => clearInterval(t)
    }, [talk.phase])
    return talk.phase === 'recording' ? now - talk.startedAt : 0
}

/** Five bars that follow the voice level. */
function LevelBars({ level, className }: { level: number; className?: string }) {
    const bars = [0.35, 0.7, 1, 0.7, 0.35]
    return (
        <span aria-hidden className={cn('flex items-center gap-[3px] h-5', className)}>
            {bars.map((w, i) => (
                <span key={i} className="w-[3px] rounded-full bg-current transition-[height] duration-[90ms]"
                    style={{ height: `${Math.round(4 + Math.min(1, level * w * 1.6) * 16)}px` }} />
            ))}
        </span>
    )
}

/** Pointer and keyboard holding for a talk button. */
function holdHandlers(disabled: boolean) {
    return {
        onPointerDown: (e: React.PointerEvent) => {
            if (disabled || e.button !== 0) return
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
            void startTalk()
        },
        onPointerUp: () => stopTalk(),
        onPointerCancel: () => stopTalk(),
        onLostPointerCapture: () => stopTalk(),
        onKeyDown: (e: React.KeyboardEvent) => {
            if (disabled || e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return
            e.preventDefault()
            void startTalk()
        },
        onKeyUp: (e: React.KeyboardEvent) => {
            if (e.key !== ' ' && e.key !== 'Enter') return
            e.preventDefault()
            stopTalk()
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    }
}

/** The big push-to-talk button at the bottom of the Copilot panel. */
export function PushToTalkButton({ disabled, className }: { disabled: boolean; className?: string }) {
    const talk = useCopilotStore(s => s.talk)
    const elapsed = useTalkElapsed()
    const rec = talk.phase === 'recording'
    const busy = talk.phase === 'starting' || talk.phase === 'sending'
    return (
        <button type="button" disabled={disabled} {...holdHandlers(disabled)}
            aria-label="Hold to talk to Copilot" aria-pressed={rec}
            title={disabled ? undefined : 'Hold to talk (or hold V)'}
            className={cn(className, 'relative w-full h-14 rounded-[10px] border flex items-center justify-center gap-3 select-none touch-none',
                'text-[15px] font-bold transition-[background-color,border-color,color,transform] duration-[140ms] active:scale-[.98]', FOCUS,
                'disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-2 disabled:text-app-text-subtle disabled:active:scale-100',
                rec ? 'bg-app-accent border-app-accent text-[var(--app-accent-ink)]'
                    : 'bg-app-accent-soft border-app-accent text-app-selected-ink hover:bg-[color-mix(in_srgb,var(--app-accent)_22%,transparent)]')}>
            {busy ? <Loader2 size={20} className="animate-spin motion-reduce:animate-none" /> : <Mic size={20} />}
            {rec ? (
                <>
                    <span>Listening</span>
                    <LevelBars level={talk.level} />
                    <span className="tabular-nums font-semibold">{fmt(elapsed)} / 0:15</span>
                </>
            ) : talk.phase === 'starting' ? <span>Opening microphone</span>
              : talk.phase === 'sending' ? <span>Sending</span>
              : (
                <>
                    <span>Hold to talk</span>
                    <kbd className="hidden md:inline-flex items-center h-6 px-1.5 rounded border border-current/40 text-[12px] font-bold opacity-80">V</kbd>
                </>
            )}
            {rec && (
                <span aria-hidden className="absolute left-0 bottom-0 h-1 rounded-b-[10px] bg-[var(--app-accent-ink)] opacity-40"
                    style={{ width: `${(elapsed / MAX_TALK_MS) * 100}%` }} />
            )}
        </button>
    )
}

/** Round thumb button for phones: floats above the action bar while the
 *  Copilot tab is open. */
export function PushToTalkFab({ disabled }: { disabled: boolean }) {
    const talk = useCopilotStore(s => s.talk)
    const elapsed = useTalkElapsed()
    const rec = talk.phase === 'recording'
    const busy = talk.phase === 'starting' || talk.phase === 'sending'
    return (
        <div className="flex items-center gap-2">
            {rec && (
                <span className="h-8 px-2.5 rounded-full flex items-center gap-2 border border-app-border bg-app-raised text-app-text text-[13px] font-bold tabular-nums shadow-[var(--app-shadow)]">
                    <LevelBars level={talk.level} className="text-app-accent" />{fmt(elapsed)}
                </span>
            )}
            <button type="button" disabled={disabled} {...holdHandlers(disabled)}
                aria-label="Hold to talk to Copilot" aria-pressed={rec}
                className={cn('size-16 rounded-full border-2 flex items-center justify-center select-none touch-none shadow-[var(--app-shadow)]',
                    'transition-[background-color,color,transform] duration-[140ms] active:scale-[.96]', FOCUS,
                    'disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-2 disabled:text-app-text-subtle',
                    rec ? 'bg-app-accent border-app-accent text-[var(--app-accent-ink)] scale-105'
                        : 'bg-app-raised border-app-accent text-app-selected-ink')}>
                {busy ? <Loader2 size={24} className="animate-spin motion-reduce:animate-none" /> : <Mic size={26} />}
            </button>
        </div>
    )
}

/** First use: why the microphone, before the browser asks. */
export function MicExplain() {
    const mic = useCopilotStore(s => s.mic)
    const setMic = useCopilotStore(s => s.setMic)
    if (mic === 'denied') {
        return (
            <div role="alert" className="rounded-[10px] border border-app-border bg-app-surface-2 p-3 flex flex-col gap-2">
                <p className="text-[13px] font-bold text-app-text">Microphone blocked</p>
                <p className="text-[13px] text-app-text-muted">
                    The browser is not letting this page use the microphone. Allow it in the site settings
                    (the icon left of the address), then hold to talk again. You can type commands meanwhile.</p>
                <button onClick={() => setMic('unknown')}
                    className={cn('self-start h-8 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text hover:bg-app-surface', FOCUS)}>
                    Dismiss</button>
            </div>
        )
    }
    if (mic !== 'explain' && mic !== 'asking') return null
    return (
        <div className="rounded-[10px] border border-app-accent bg-app-accent-soft p-3 flex flex-col gap-2">
            <p className="text-[13px] font-bold text-app-text">Use your microphone for Copilot</p>
            <p className="text-[13px] text-app-text-muted">
                Copilot listens only while you hold the talk button or the V key. Each recording, up to 15 seconds,
                goes to the HYRAK server to be turned into text. The browser will ask once.</p>
            <div className="flex gap-2">
                <button onClick={() => void requestMic()} disabled={mic === 'asking'}
                    className={cn('h-9 px-3 rounded-md bg-app-accent text-[var(--app-accent-ink)] text-[13px] font-bold hover:brightness-110 active:scale-[.98] transition-[filter,transform] duration-[140ms] disabled:opacity-70', FOCUS)}>
                    {mic === 'asking' ? 'Waiting for the browser' : 'Allow microphone'}</button>
                <button onClick={() => setMic('unknown')}
                    className={cn('h-9 px-3 rounded-md border border-app-border-strong text-[13px] font-semibold text-app-text hover:bg-app-surface', FOCUS)}>
                    Not now</button>
            </div>
        </div>
    )
}

/** Which microphone Copilot records from. Labels appear once the browser
 *  has granted the microphone. */
export function MicPicker() {
    const mic = useCopilotStore(s => s.mic)
    const hint = useCopilotStore(s => s.micHint)
    const [mics, setMics] = useState<MediaDeviceInfo[]>([])
    const [value, setValue] = useState(() => savedMicId())
    useEffect(() => {
        let alive = true
        const load = () => void listMics().then(l => { if (alive) setMics(l) })
        load()
        navigator.mediaDevices?.addEventListener?.('devicechange', load)
        return () => { alive = false; navigator.mediaDevices?.removeEventListener?.('devicechange', load) }
    }, [mic])
    const named = mics.filter(m => m.label)
    if (named.length < 2 && !hint) return null
    const options = [{ value: '', label: 'Automatic (skip virtual devices)' },
        ...named.filter(m => m.deviceId !== 'default' && m.deviceId !== 'communications')
            .map(m => ({ value: m.deviceId, label: m.label + (VIRTUAL_MIC.test(m.label) ? ' (virtual, no room sound)' : '') }))]
    return (
        <div className="flex items-center gap-2">
            <Mic size={14} className={hint ? 'text-app-warn shrink-0' : 'text-app-text-muted shrink-0'} aria-hidden />
            <SimpleSelect size="sm" value={value} options={options} ariaLabel="Microphone" className="flex-1 min-w-0"
                onValueChange={v => { setValue(v); saveMicId(v); useCopilotStore.getState().setMicHint(false) }} />
        </div>
    )
}

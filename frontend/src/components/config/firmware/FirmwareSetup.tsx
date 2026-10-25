'use client'

// Config > Firmware. Installs PX4 on a flight controller over USB, the way
// QGroundControl's Firmware page does: press Start with the board unplugged,
// plug it in, HYRAK catches the bootloader in the few seconds it listens
// after power-up, then the operator picks a build and confirms.
//
// The work happens in the desktop app's main process
// (desktop/src/firmware/service.ts); a browser tab cannot talk to the
// bootloader reliably, so it only explains that.

import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cpu, FileUp, Loader, Plug, Usb } from 'lucide-react'
import { isDesktopApp, nativeFirmware } from '@/lib/nativeBridge'
import { useDroneStore } from '@/store/drone'
import { disconnectTelemetryLink } from '@/hooks/useDrone'
import { Btn, Chip, FOCUS_RING, Note, Panel, T, mix } from '@/components/config/kit'
import { OptionSelect } from '@/components/config/OptionSelect'

type State = 'idle' | 'waiting' | 'connecting' | 'ready' | 'downloading' | 'erasing' | 'programming' | 'verifying' | 'rebooting' | 'done' | 'error'

interface Status {
    state: State
    message: string
    board: { path: string; boardId: number; boardRev: number; blRev: number; flashSize: number; chip: string | null } | null
    targets: { target: string; name: string }[]
    progress: number
    flashed: { gitIdentity: string; summary: string; seconds: number } | null
}

type Ev = { type: 'status'; status: Status } | { type: 'log'; line: string; level: 'info' | 'warn' | 'error' }

type Choice = 'stable' | 'beta' | 'master' | 'custom'

const IDLE: Status = { state: 'idle', message: '', board: null, targets: [], progress: 0, flashed: null }
const FLASHING: State[] = ['downloading', 'erasing', 'programming', 'verifying', 'rebooting']

const PHASE: Record<string, string> = {
    downloading: 'Downloading', erasing: 'Erasing', programming: 'Writing', verifying: 'Verifying', rebooting: 'Restarting',
}

const CHOICES: { id: Choice; label: string; sub: string }[] = [
    { id: 'stable', label: 'PX4 stable', sub: 'The current release. Choose this unless you know you need something else.' },
    { id: 'beta', label: 'PX4 beta', sub: 'The next release while it is being tested.' },
    { id: 'master', label: 'PX4 daily build', sub: 'Built from the development branch every day. Not flight tested.' },
    { id: 'custom', label: 'A .px4 file', sub: 'Your own build, or one from a vendor. It must be built for this board.' },
]

export function FirmwareSetup() {
    const desktop = isDesktopApp()
    const api = nativeFirmware()
    const [st, setSt] = useState<Status>(IDLE)
    const [log, setLog] = useState<{ line: string; level: string; at: number }[]>([])
    const [choice, setChoice] = useState<Choice>('stable')
    const [target, setTarget] = useState('')
    const [file, setFile] = useState<{ name: string; text: string } | null>(null)
    const [err, setErr] = useState<string | null>(null)
    const [pending, setPending] = useState(false)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const logRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!api) return
        void api.status().then(s => { if (s) setSt(s as Status) })
        return api.onEvent((raw) => {
            const e = raw as Ev
            if (e.type === 'status') setSt(e.status)
            else setLog(l => [...l.slice(-199), { line: e.line, level: e.level, at: Date.now() }])
        })
    }, [api])

    useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [log])
    useEffect(() => { if (st.targets.length && !st.targets.some(t => t.target === target)) setTarget(st.targets[0].target) }, [st.targets, target])
    useEffect(() => { if (st.state === 'ready' && !st.targets.length) setChoice('custom') }, [st.state, st.targets.length])

    if (!desktop) {
        return (
            <Panel>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <Cpu size={20} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} aria-hidden />
                    <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: T.text }}>Firmware flashing needs the HYRAK desktop app</h3>
                        <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.55, color: T.muted, maxWidth: '64ch' }}>
                            Installing PX4 talks to the flight controller&apos;s bootloader over USB in the few seconds after it powers up. A browser tab cannot do that reliably. Open this page in the HYRAK desktop app on the computer the board is plugged into.
                        </p>
                    </div>
                </div>
            </Panel>
        )
    }
    if (!api) {
        return <Note tone="warn">This copy of the HYRAK desktop app is older than firmware flashing. Update it from Settings, About, then come back here.</Note>
    }

    const flashing = FLASHING.includes(st.state)
    const linked = telemetryStatus === 'connected' || telemetryStatus === 'connecting'

    const start = async () => {
        setErr(null); setPending(true)
        try {
            // The vehicle link would hold the very port the bootloader appears on.
            if (linked) await disconnectTelemetryLink()
            setLog([])
            const r = await api.start()
            if (!r.ok) setErr(r.error ?? 'Could not start')
        } finally { setPending(false) }
    }
    const cancel = async () => {
        setErr(null)
        const r = await api.cancel()
        if (!r.ok) setErr(r.error ?? 'Could not stop')
    }
    const flash = async () => {
        setErr(null)
        if (choice === 'custom') {
            if (!file) { setErr('Choose a .px4 file first.'); return }
            const r = await api.flash({ kind: 'custom', fileName: file.name, text: file.text })
            if (!r.ok) setErr(r.error ?? 'Flashing failed')
            return
        }
        const r = await api.flash({ kind: 'official', channel: choice, target })
        if (!r.ok) setErr(r.error ?? 'Flashing failed')
    }
    const pickFile = async (f: File | undefined) => {
        setErr(null)
        if (!f) { setFile(null); return }
        if (f.size > 32 * 1024 * 1024) { setErr('That file is far larger than any firmware.'); return }
        setFile({ name: f.name, text: await f.text() })
    }

    const board = st.board
    const pct = Math.round(st.progress * 100)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880 }}>
            {(st.state === 'idle' || st.state === 'done' || st.state === 'error') && (
                <Panel title={st.state === 'done' ? 'Firmware installed' : st.state === 'error' ? 'Flashing did not finish' : 'Install or update PX4'}>
                    {st.state === 'done' && st.flashed && (
                        <Note tone="ok" icon={<CheckCircle2 size={15} style={{ color: T.ok, flexShrink: 0, marginTop: 2 }} />}>
                            <b>{st.flashed.gitIdentity || 'New firmware'}</b> is on the board ({st.flashed.seconds} s). It is restarting now; with auto-connect on it reconnects by itself. Check the airframe and calibrations on the Vehicle and Sensors pages before flying.
                        </Note>
                    )}
                    {st.state === 'error' && <Note tone="danger">{st.message}</Note>}
                    <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, lineHeight: 1.5, color: T.text }}>
                        <li><b>Unplug the flight controller</b> from USB, and from its battery if it has one connected.</li>
                        <li>Press <b>Start</b>, then plug the board in with a USB cable straight to this computer (no hub if you can avoid it).</li>
                        <li>HYRAK finds the board and shows which firmware fits. Nothing is erased until you confirm.</li>
                    </ol>
                    <Note tone="warn">Only flash on the ground, never with a battery-powered vehicle armed. Parameters usually survive an update, but note anything important first.</Note>
                    {linked && <Note>The vehicle link will be closed when you press Start.</Note>}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Btn kind="primary" big onClick={start} disabled={pending}><Plug size={18} aria-hidden /> {st.state === 'idle' ? 'Start' : 'Start again'}</Btn>
                    </div>
                </Panel>
            )}

            {(st.state === 'waiting' || st.state === 'connecting') && (
                <Panel title="Plug in the board">
                    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 0' }}>
                        <span style={{ width: 52, height: 52, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: mix(T.accent, 10), border: `1px solid ${mix(T.accent, 35)}`, flexShrink: 0 }}>
                            {st.state === 'connecting'
                                ? <Loader size={22} className="motion-safe:animate-spin" style={{ color: T.accent }} aria-hidden />
                                : <Usb size={22} style={{ color: T.accent }} aria-hidden />}
                        </span>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{st.state === 'connecting' ? 'Board found' : 'Plug the flight controller into USB now'}</div>
                            <div style={{ fontSize: 14, color: T.muted, lineHeight: 1.5 }}>{st.message || 'If it is already plugged in, unplug it and plug it back in.'}</div>
                        </div>
                    </div>
                    <div><Btn onClick={cancel}>Cancel</Btn></div>
                </Panel>
            )}

            {board && (st.state === 'ready' || flashing) && (
                <Panel title="Board" right={<Chip tone="ok">In bootloader</Chip>}>
                    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                        {[
                            ['Board', st.targets[0]?.name ?? `Board id ${board.boardId}`],
                            ['Board id', `${board.boardId} (rev ${board.boardRev})`],
                            ['Flash', `${Math.round(board.flashSize / 1024)} KB`],
                            ['Bootloader', `protocol ${board.blRev}`],
                            ['Port', board.path],
                        ].map(([k, v]) => (
                            <div key={k} style={{ minWidth: 0 }}>
                                <dt style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>{k}</dt>
                                <dd style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.text, overflowWrap: 'anywhere' }}>{v}</dd>
                            </div>
                        ))}
                    </dl>
                </Panel>
            )}

            {st.state === 'ready' && (
                <Panel title="Choose the firmware">
                    {st.message && !st.message.startsWith('Found') && <Note tone="warn">{st.message}</Note>}
                    <div role="radiogroup" aria-label="Firmware" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {CHOICES.filter(c => c.id === 'custom' || st.targets.length > 0).map(c => {
                            const on = c.id === choice
                            return (
                                <button key={c.id} type="button" role="radio" aria-checked={on} onClick={() => setChoice(c.id)}
                                    className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2'}
                                    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                                        background: on ? mix(T.accent, 8) : 'transparent', border: `1px solid ${on ? mix(T.accent, 55) : T.border}` }}>
                                    <span aria-hidden style={{ width: 16, height: 16, borderRadius: 999, marginTop: 2, flexShrink: 0, border: `2px solid ${on ? T.accent : T.borderStrong}`, boxShadow: on ? `inset 0 0 0 3px hsl(var(--app-surface)), inset 0 0 0 8px ${T.accent}` : 'none' }} />
                                    <span style={{ minWidth: 0 }}>
                                        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: T.text }}>{c.label}</span>
                                        <span style={{ display: 'block', fontSize: 13, color: T.muted, lineHeight: 1.45 }}>{c.sub}</span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                    {choice !== 'custom' && st.targets.length > 1 && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Which board is this?</span>
                            <OptionSelect aria-label="Board" value={target} onChange={setTarget}
                                options={st.targets.map(t => ({ value: t.target, label: `${t.name} (${t.target})` }))} />
                            <span style={{ fontSize: 13, color: T.muted }}>Several boards share this id. A wrong pick is refused before anything is erased.</span>
                        </label>
                    )}
                    {choice === 'custom' && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Firmware file (.px4)</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <span className={FOCUS_RING} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, padding: '0 14px', borderRadius: 8, border: `1px solid ${T.borderStrong}`, fontSize: 13, fontWeight: 700, color: T.text, cursor: 'pointer' }}>
                                    <FileUp size={15} aria-hidden /> Choose file
                                </span>
                                <span style={{ fontSize: 13, color: file ? T.text : T.muted, overflowWrap: 'anywhere' }}>{file ? file.name : 'No file chosen'}</span>
                            </span>
                            <input type="file" accept=".px4,application/json" onChange={e => void pickFile(e.target.files?.[0])}
                                style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} />
                        </label>
                    )}
                    <Note tone="warn">Installing erases the current firmware. Keep the cable in until HYRAK says it is done (usually under a minute).</Note>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Btn kind="primary" big onClick={flash} disabled={choice === 'custom' && !file}>Install firmware</Btn>
                        <Btn onClick={cancel} title="Restart the board with the firmware it already has">Leave the board as it is</Btn>
                    </div>
                </Panel>
            )}

            {flashing && (
                <Panel title={`${PHASE[st.state] ?? 'Working'}...`}>
                    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: T.warn }}>
                        <AlertTriangle size={16} aria-hidden /> Do not unplug the board or close HYRAK.
                    </div>
                    <div role="progressbar" aria-label={PHASE[st.state]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                        style={{ height: 10, borderRadius: 999, background: T.surface2, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--app-accent)', transition: 'width 200ms var(--ease-out)' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                        <span>{st.message}</span><span>{pct}%</span>
                    </div>
                </Panel>
            )}

            {err && <Note tone="danger">{err}</Note>}

            {log.length > 0 && (
                <Panel title="Log">
                    <div ref={logRef} role="log" aria-live="polite"
                        style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'var(--font-code, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.6, color: T.text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {log.map((l, i) => (
                            <div key={i} style={{ color: l.level === 'error' ? T.danger : l.level === 'warn' ? T.warn : T.text }}>{l.line}</div>
                        ))}
                    </div>
                </Panel>
            )}
        </div>
    )
}

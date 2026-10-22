'use client'

// Config > PX4 console: the flight controller's NuttShell over MAVLink, as
// in QGroundControl's MAVLink Console. Commands go through the guarded
// `mavlink_shell` socket event (backend app/events/shell_events.py).

import React, { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { Btn, Note, Panel, T, FOCUS_RING } from '@/components/config/kit'

const QUICK = ['ver all', 'top once', 'listener vehicle_status', 'sensors status', 'ekf2 status', 'param show-for-airframe', 'dmesg', 'free']
const MAX_CHARS = 200_000

export function MavlinkConsole() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const [out, setOut] = useState('')
    const [cmd, setCmd] = useState('')
    const [hist, setHist] = useState<string[]>([])
    const [hi, setHi] = useState(-1)
    const box = useRef<HTMLPreElement>(null)

    useEffect(() => {
        const s = getSocket()
        // Strip ANSI colour codes; the shell paints with them.
        // eslint-disable-next-line no-control-regex
        const on = (d: { text: string }) => setOut(o => (o + d.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-MAX_CHARS))
        s.on('shell_output', on)
        return () => { s.off('shell_output', on) }
    }, [])
    useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [out])

    const send = (c: string) => {
        if (!connected) return
        setOut(o => o + `\n> ${c}\n`)
        if (c.trim()) setHist(h => [c, ...h.filter(x => x !== c)].slice(0, 50))
        setHi(-1)
        getSocket().emit('mavlink_shell', { cmd: c })
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!connected && <Note>Connect a drone to open its console.</Note>}
            <Note tone="warn">This is the flight controller&apos;s own shell. Commands run as typed, with no checks: <b>reboot</b>, <b>param set</b> and <b>commander</b> act on the aircraft immediately.</Note>
            <Panel title="PX4 console" hint="NuttShell over MAVLink"
                right={<Btn onClick={() => setOut('')}>Clear</Btn>}>
                <pre ref={box} aria-live="polite" aria-label="Console output" className="font-code"
                    style={{ margin: 0, height: 420, overflow: 'auto', padding: 12, borderRadius: 8, background: 'hsl(var(--app-bg))', border: `1px solid ${T.border}`,
                        color: T.text, fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {out || <span style={{ color: T.muted }}>{connected ? 'Type a command below, or pick one. Try ver all.' : 'No drone connected.'}</span>}
                </pre>
                <form onSubmit={e => { e.preventDefault(); send(cmd); setCmd('') }} style={{ display: 'flex', gap: 8 }}>
                    <span aria-hidden className="font-code" style={{ alignSelf: 'center', color: T.accent, fontWeight: 700 }}>nsh&gt;</span>
                    <input value={cmd} onChange={e => setCmd(e.target.value)} disabled={!connected} aria-label="Console command" autoComplete="off" spellCheck={false}
                        onKeyDown={e => {
                            if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const n = Math.min(hi + 1, hist.length - 1); setHi(n); setCmd(hist[n]) }
                            if (e.key === 'ArrowDown') { e.preventDefault(); const n = hi - 1; setHi(Math.max(n, -1)); setCmd(n >= 0 ? hist[n] : '') }
                        }}
                        className={FOCUS_RING + ' font-code'}
                        style={{ flex: 1, minWidth: 0, height: 36, padding: '0 10px', borderRadius: 6, outline: 'none', fontSize: 14,
                            background: connected ? T.surface : T.surface2, border: `1px solid ${T.borderStrong}`, color: T.text }} />
                    <Btn kind="primary" type="submit" disabled={!connected}>Send</Btn>
                </form>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {QUICK.map(q => (
                        <button key={q} type="button" onClick={() => send(q)} disabled={!connected}
                            className={FOCUS_RING + ' font-code transition-colors hover:bg-app-surface-2'}
                            style={{ padding: '4px 10px', minHeight: 30, borderRadius: 999, border: `1px solid ${T.border}`, background: 'transparent',
                                color: connected ? T.text : T.muted, fontSize: 12, cursor: connected ? 'pointer' : 'not-allowed' }}>{q}</button>
                    ))}
                </div>
            </Panel>
        </div>
    )
}

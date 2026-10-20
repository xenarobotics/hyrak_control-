'use client'

// Shown only while the cloud is unreachable AND this machine holds the
// aircraft's link (radio or SITL relay). Everything here runs locally: the
// numbers come straight from the aircraft's MAVLink, and the buttons go
// straight down the radio - see lib/localLink.ts.

import { useEffect, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { FOCUS, DISABLED } from './flightStyles'
import {
    getLocalState, hasLocalLink, isCloudUp, sendLocalCommand, subscribeLocal,
    type LocalCommand,
} from '@/lib/localLink'

/** Wall clock for event handlers (never called during render). */
const wallClock = () => Date.now()

const RESULT: Record<number, string> = { 0: 'accepted', 1: 'temporarily rejected', 2: 'denied', 3: 'unsupported', 4: 'failed', 5: 'in progress' }

const K = 'text-[13px] font-semibold text-app-text-muted'
const V = 'text-[14px] font-bold'

export function LocalLinkPanel() {
    // The clock is state, not read during render: ticked by the link's own
    // events and once a second for the age counter.
    const [now, setNow] = useState(0)
    const [sent, setSent] = useState<{ cmd: LocalCommand; at: number } | null>(null)
    useEffect(() => {
        const unsub = subscribeLocal(() => setNow(Date.now()))
        const id = setInterval(() => setNow(Date.now()), 1000)   // age counter
        return () => { unsub(); clearInterval(id) }
    }, [])

    if (isCloudUp() || !hasLocalLink()) return null
    const s = getLocalState()
    const age = s.lastRxMs && now ? (now - s.lastRxMs) / 1000 : null
    const fresh = age !== null && age < 3
    const ack = s.lastAck && sent && s.lastAck.command === 176 && s.lastAck.atMs >= sent.at ? s.lastAck : null

    const send = (cmd: LocalCommand) => {
        const at = wallClock()
        if (sendLocalCommand(cmd)) { setSent({ cmd, at }); setNow(at) }
    }

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,460px)] rounded-[14px] border-2 border-app-warn bg-app-raised text-app-text shadow-[var(--app-shadow)] px-4 py-3 text-[13px]" role="alertdialog" aria-label="Cloud unreachable, local link">
            <div className="flex items-center gap-2 text-app-warn text-[14px] font-bold">
                <CloudOff size={16} />
                CLOUD UNREACHABLE - LOCAL LINK
                <span className="ml-auto text-[13px] font-normal text-app-text-muted">reconnecting…</span>
            </div>
            <div className="mt-1.5 text-app-text-muted">
                This machine is keeping the aircraft&apos;s link alive and can command it directly.
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
                <div><div className={K}>Mode</div><div className={V}>{s.mode}</div></div>
                <div><div className={K}>State</div><div className={`${V} ${s.armed ? 'text-app-danger' : ''}`}>{s.armed ? 'ARMED' : 'DISARMED'}</div></div>
                <div><div className={K}>Alt</div><div className={V}>{s.altM !== null ? `${s.altM.toFixed(1)} m` : '-'}</div></div>
                <div><div className={K}>Batt</div><div className={V}>{s.batteryPct !== null ? `${s.batteryPct}%` : '-'}</div></div>
            </div>
            <div className={`mt-1.5 font-semibold ${fresh ? 'text-app-ok' : 'text-app-danger'}`}>
                {age === null ? 'no packets from the aircraft yet'
                    : fresh ? `aircraft link OK (${age.toFixed(1)} s)` : `no packets from the aircraft for ${age.toFixed(0)} s`}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
                {(['hold', 'rtl', 'land'] as LocalCommand[]).map(c => (
                    <button key={c} onClick={() => send(c)} disabled={s.sysid === null}
                        title={s.sysid === null ? 'Waiting for the aircraft to be heard' : undefined}
                        className={`h-10 rounded-md border border-app-warn text-[14px] font-bold text-app-text hover:bg-app-warn-soft ${FOCUS} ${DISABLED}`}>
                        {c === 'hold' ? 'Hold' : c === 'rtl' ? 'RTL' : 'Land'}
                    </button>
                ))}
            </div>
            {sent && (
                <div className="mt-1.5 text-app-text-muted">
                    {sent.cmd === 'rtl' ? 'RTL' : sent.cmd.charAt(0).toUpperCase() + sent.cmd.slice(1)} sent locally{ack ? ` - aircraft: ${RESULT[ack.result] ?? `result ${ack.result}`}` : ' - waiting for the aircraft'}
                </div>
            )}
        </div>
    )
}

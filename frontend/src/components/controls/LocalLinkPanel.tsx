'use client'

// Shown only while the cloud is unreachable AND this machine holds the
// aircraft's link (radio or SITL relay). Everything here runs locally: the
// numbers come straight from the aircraft's MAVLink, and the buttons go
// straight down the radio - see lib/localLink.ts.

import { useEffect, useState } from 'react'
import { CloudOff } from 'lucide-react'
import {
    getLocalState, hasLocalLink, isCloudUp, sendLocalCommand, subscribeLocal,
    type LocalCommand,
} from '@/lib/localLink'

const RESULT: Record<number, string> = { 0: 'accepted', 1: 'temporarily rejected', 2: 'denied', 3: 'unsupported', 4: 'failed', 5: 'in progress' }

export function LocalLinkPanel() {
    const [, setTick] = useState(0)
    const [sent, setSent] = useState<{ cmd: LocalCommand; at: number } | null>(null)
    useEffect(() => {
        const unsub = subscribeLocal(() => setTick(t => t + 1))
        const id = setInterval(() => setTick(t => t + 1), 1000)   // age counter
        return () => { unsub(); clearInterval(id) }
    }, [])

    if (isCloudUp() || !hasLocalLink()) return null
    const s = getLocalState()
    const age = s.lastRxMs ? (Date.now() - s.lastRxMs) / 1000 : null
    const fresh = age !== null && age < 3
    const ack = s.lastAck && sent && s.lastAck.command === 176 && s.lastAck.atMs >= sent.at ? s.lastAck : null

    const send = (cmd: LocalCommand) => {
        if (sendLocalCommand(cmd)) setSent({ cmd, at: Date.now() })
    }

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,460px)] rounded-lg border border-amber-500/60 bg-background/95 shadow-xl backdrop-blur px-3 py-2.5 text-xs font-mono">
            <div className="flex items-center gap-2 text-amber-500 font-semibold">
                <CloudOff size={14} />
                CLOUD UNREACHABLE - LOCAL LINK
                <span className="ml-auto font-normal text-muted-foreground">reconnecting…</span>
            </div>
            <div className="mt-1.5 text-muted-foreground">
                This machine is keeping the aircraft&apos;s link alive and can command it directly.
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
                <div><div className="text-muted-foreground">MODE</div><div className="font-semibold">{s.mode}</div></div>
                <div><div className="text-muted-foreground">STATE</div><div className={s.armed ? 'text-red-500 font-semibold' : ''}>{s.armed ? 'ARMED' : 'DISARMED'}</div></div>
                <div><div className="text-muted-foreground">ALT</div><div>{s.altM !== null ? `${s.altM.toFixed(1)} m` : '-'}</div></div>
                <div><div className="text-muted-foreground">BATT</div><div>{s.batteryPct !== null ? `${s.batteryPct}%` : '-'}</div></div>
            </div>
            <div className={`mt-1 ${fresh ? 'text-green-500' : 'text-red-500'}`}>
                {age === null ? 'no packets from the aircraft yet'
                    : fresh ? `aircraft link OK (${age.toFixed(1)} s)` : `no packets from the aircraft for ${age.toFixed(0)} s`}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
                {(['hold', 'rtl', 'land'] as LocalCommand[]).map(c => (
                    <button key={c} onClick={() => send(c)} disabled={s.sysid === null}
                        className="rounded border border-border py-1.5 font-semibold hover:bg-accent disabled:opacity-40">
                        {c === 'hold' ? 'HOLD' : c === 'rtl' ? 'RETURN' : 'LAND'}
                    </button>
                ))}
            </div>
            {sent && (
                <div className="mt-1.5 text-muted-foreground">
                    {sent.cmd.toUpperCase()} sent locally{ack ? ` - aircraft: ${RESULT[ack.result] ?? `result ${ack.result}`}` : ' - waiting for the aircraft'}
                </div>
            )}
        </div>
    )
}

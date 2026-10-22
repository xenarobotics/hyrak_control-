'use client'

// Config > Vehicle: the airframe the AIRCRAFT is set to (SYS_AUTOSTART),
// beside the name and label kept in this browser. Applying one is what
// QGroundControl's Airframe page does: write SYS_AUTOSTART, ask PX4 to load
// that airframe's defaults on the next boot (SYS_AUTOCONFIG = 1), reboot.

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParams } from '@/lib/vehicleParams'
import { droneAction } from '@/lib/droneAction'
import { Btn, Chip, Dialog, Note, NumberBox, Panel, T } from '@/components/config/kit'

/** A few airframes by number. Anything else is entered as a number; PX4's
 *  full list is at docs.px4.io (Airframe reference). */
const KNOWN: Record<number, string> = {
    4001: 'Generic quadcopter (X)',
    6001: 'Generic hexacopter (X)',
    13000: 'Generic standard VTOL',
    2100: 'Standard plane',
    3000: 'Generic flying wing',
    4302: 'HYRAK mono-coaxial',
    4303: 'HYRAK tandem tilt-wing',
}

export function AirframePanel() {
    const vp = useVehicleParams()
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const cur = vp.get('SYS_AUTOSTART')
    const [pick, setPick] = useState<number | null>(null)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const target = pick ?? cur
    const apply = async () => {
        if (target == null) return
        setBusy(true); setErr(null)
        await writeParams([['SYS_AUTOSTART', target], ['SYS_AUTOCONFIG', 1]], 400)
        const r = await droneAction('reboot', {}, 8000)
        setBusy(false)
        if (!r.ok) setErr(r.error ?? 'The reboot was refused. Reboot the flight controller yourself to apply.')
        else setOpen(false)
    }
    return (
        <Panel title="Airframe on the drone" hint="SYS_AUTOSTART"
            right={vp.ready && cur != null ? <Chip tone="accent">{KNOWN[cur] ?? `Airframe ${cur}`}</Chip> : undefined}>
            {!vp.ready ? (
                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Connect a drone to read and change its airframe.</p>
            ) : (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text }}>Airframe number</span>
                        <NumberBox label="Airframe number" value={target} onCommit={setPick} min={0} max={9999999} decimals={0} width={110} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {Object.entries(KNOWN).map(([n, l]) => (
                            <button key={n} type="button" onClick={() => setPick(Number(n))}
                                className="transition-colors hover:bg-app-surface-2"
                                style={{ padding: '4px 10px', minHeight: 30, borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                                    border: `1px solid ${Number(n) === target ? 'var(--app-accent)' : T.border}`, background: Number(n) === target ? 'var(--app-accent-soft)' : 'transparent',
                                    color: Number(n) === target ? 'var(--app-selected-ink)' : T.muted }}>{n} {l}</button>
                        ))}
                    </div>
                    <Btn kind="primary" disabled={target == null || target === cur || armed} onClick={() => setOpen(true)}
                        title={armed ? 'Disarm first' : undefined}>Apply and reboot</Btn>
                </>
            )}
            <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Change airframe">
                <Note tone="warn">Changing to airframe {target}{target != null && KNOWN[target] ? ` (${KNOWN[target]})` : ''} resets the airframe&apos;s parameters to its defaults on the next boot: geometry, outputs and tuning. Calibrations are kept. Export your parameters on the Advanced page first if you may want them back.</Note>
                {err && <Note tone="danger">{err}</Note>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setOpen(false)} disabled={busy}>Cancel</Btn>
                    <Btn kind="primary" onClick={apply} disabled={busy}>{busy ? 'Applying...' : 'Apply and reboot'}</Btn>
                </div>
            </Dialog>
        </Panel>
    )
}

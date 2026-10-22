'use client'

// Config > Vehicle: the airframe the AIRCRAFT is set to (SYS_AUTOSTART),
// picked from a gallery the way QGroundControl's Airframe page does it.
// Applying one writes SYS_AUTOSTART, asks PX4 to load that airframe's
// defaults on the next boot (SYS_AUTOCONFIG = 1) and reboots.

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParams } from '@/lib/vehicleParams'
import { droneAction } from '@/lib/droneAction'
import { Btn, Chip, Dialog, FOCUS_RING, Note, NumberBox, Panel, T, mix } from '@/components/config/kit'
import { AIRFRAMES, FRAME_CATEGORIES, FrameIcon, airframeById, kindFromAutostart, type FrameCategory } from '@/components/config/airframes'

export function AirframePanel() {
    const vp = useVehicleParams()
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const cur = vp.get('SYS_AUTOSTART')
    const [pick, setPick] = useState<number | null>(null)
    const [cat, setCat] = useState<FrameCategory | null>(null)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const target = pick ?? cur
    const curFrame = airframeById(cur)
    // Open on the current airframe's group; "All" until there is one.
    const shownCat = cat ?? curFrame?.cat ?? null
    const list = shownCat ? AIRFRAMES.filter(a => a.cat === shownCat) : AIRFRAMES
    const targetName = airframeById(target)?.name

    const apply = async () => {
        if (target == null) return
        setBusy(true); setErr(null)
        await writeParams([['SYS_AUTOSTART', target], ['SYS_AUTOCONFIG', 1]], 400)
        const r = await droneAction('reboot', {}, 8000)
        setBusy(false)
        if (!r.ok) setErr(r.error ?? 'The reboot was refused. Reboot the flight controller yourself to apply.')
        else { setOpen(false); setPick(null) }
    }

    const curKind = kindFromAutostart(cur)
    return (
        <Panel title="Airframe" hint="SYS_AUTOSTART"
            right={vp.ready && cur != null ? <Chip tone="accent">{curFrame?.name ?? `Airframe ${cur}`}</Chip> : undefined}>
            {!vp.ready && (
                <Note>{vp.connected ? 'Reading the airframe from the drone.' : 'Connect a drone to read and change its airframe. You can browse the list now.'}</Note>
            )}
            {vp.ready && cur != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 8, background: T.surface2, border: `1px solid ${T.border}` }}>
                    <span style={{ color: T.accent }}>{curKind ? <FrameIcon kind={curKind} size={44} /> : null}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>On the drone now</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{curFrame?.name ?? 'Airframe not in this list'}</div>
                        <div style={{ fontSize: 13, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>Number {cur}{curFrame?.note ? `, ${curFrame.note}` : ''}</div>
                    </div>
                </div>
            )}

            <div role="tablist" aria-label="Airframe type" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[null, ...FRAME_CATEGORIES].map(c => {
                    const on = c === shownCat
                    return (
                        <button key={c ?? 'all'} type="button" role="tab" aria-selected={on} onClick={() => setCat(c)}
                            className={FOCUS_RING + ' transition-colors' + (on ? '' : ' hover:bg-app-surface-2')}
                            style={{ minHeight: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                                border: `1px solid ${on ? 'var(--app-accent)' : T.border}`, background: on ? 'var(--app-accent-soft)' : 'transparent',
                                color: on ? 'var(--app-selected-ink)' : T.muted }}>{c ?? 'All'}</button>
                    )
                })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(46%, 150px), 1fr))', gap: 8 }}>
                {list.map(a => {
                    const sel = a.id === target, isCur = a.id === cur && vp.ready
                    return (
                        <button key={a.id} type="button" aria-pressed={sel} onClick={() => setPick(a.id)}
                            className={FOCUS_RING + ' transition-colors' + (sel ? '' : ' hover:bg-app-surface-2')}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 8px 10px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                                border: `1px solid ${sel ? 'var(--app-accent)' : T.border}`, background: sel ? mix('var(--app-accent)', 8) : 'transparent', position: 'relative' }}>
                            {isCur && <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 12, fontWeight: 700, color: T.ok }}>Current</span>}
                            <span style={{ color: sel ? T.accent : T.muted }}><FrameIcon kind={a.kind} size={48} /></span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{a.name}</span>
                            <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{a.id}</span>
                        </button>
                    )
                })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text, paddingTop: 10 }}>Other airframe number</span>
                <span style={{ paddingTop: 10 }}><NumberBox label="Airframe number" value={target} onCommit={setPick} min={0} max={9999999} decimals={0} width={110} /></span>
                <span style={{ marginLeft: 'auto', paddingTop: 10, display: 'inline-flex', gap: 8 }}>
                    {pick != null && pick !== cur && <Btn onClick={() => setPick(null)}>Undo</Btn>}
                    <Btn kind="primary" disabled={!vp.ready || target == null || target === cur || armed} onClick={() => setOpen(true)}
                        title={!vp.ready ? 'Connect a drone first' : armed ? 'Disarm first' : undefined}>Apply and reboot</Btn>
                </span>
            </div>

            <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Change airframe">
                <Note tone="warn">Changing to airframe {target}{targetName ? ` (${targetName})` : ''} resets the airframe&apos;s parameters to its defaults on the next boot: geometry, outputs and tuning. Calibrations are kept. Export your parameters on the Advanced page first if you may want them back.</Note>
                <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>The flight controller reboots now and the link drops for a few seconds.</p>
                {err && <Note tone="danger">{err}</Note>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setOpen(false)} disabled={busy}>Cancel</Btn>
                    <Btn kind="primary" onClick={apply} disabled={busy}>{busy ? 'Applying...' : 'Apply and reboot'}</Btn>
                </div>
            </Dialog>
        </Panel>
    )
}

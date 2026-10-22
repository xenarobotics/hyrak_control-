'use client'

// Config > Vehicle: what this aircraft is. Everything here comes from the
// drone itself (AUTOPILOT_VERSION, HEARTBEAT, parameters) or from HYRAK's
// drone record; nothing is a label typed into this browser. The old page kept
// a name, airframe and firmware in localStorage that no other page read, and
// the banner showed them as if they were the aircraft's.

import React, { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Pencil, WifiOff } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useVehicleInfo } from '@/lib/vehicleInfo'
import { writeParam } from '@/lib/vehicleParams'
import { droneAction } from '@/lib/droneAction'
import { apiFetch } from '@/lib/api'
import { useLiveScope } from '@/hooks/useLiveScope'
import { AirframePanel } from '@/components/config/AirframePanel'
import { Btn, Chip, Dialog, FOCUS_RING, Grid, Note, Panel, ParamRow, T } from '@/components/config/kit'

/** One fact: label left, value right, optional copy button. */
export function Fact({ label, value, mono, copy, sub, children, emptyText = 'Not reported' }: {
    label: string; value?: React.ReactNode; mono?: boolean; copy?: string; sub?: React.ReactNode; children?: React.ReactNode; emptyText?: string
}) {
    const [copied, setCopied] = useState(false)
    const empty = (value == null || value === '') && !children
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minHeight: 28, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.muted, flex: '0 0 132px' }}>{label}</span>
            <span style={{ flex: '1 1 160px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span className={mono ? 'font-code' : undefined}
                    style={{ fontSize: mono ? 13 : 14, fontWeight: 600, color: empty ? T.muted : T.text, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                    {empty ? emptyText : value}
                </span>
                {children}
                {copy && (
                    <button type="button" aria-label={`Copy ${label.toLowerCase()}`} title="Copy"
                        onClick={() => { void navigator.clipboard?.writeText(copy).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
                        className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2 hover:text-app-text'}
                        style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        {copied ? <Check size={14} style={{ color: T.ok }} /> : <Copy size={14} />}
                    </button>
                )}
            </span>
            {sub && <span style={{ flexBasis: '100%', fontSize: 12, color: T.muted, marginTop: -4 }}>{sub}</span>}
        </div>
    )
}

const hex = (n?: number | null) => (n ? '0x' + n.toString(16).padStart(4, '0') : '')

function fmtDuration(s: number): string {
    if (s < 60) return `${Math.round(s)} s`
    const m = Math.round(s / 60)
    if (m < 60) return `${m} min`
    return `${Math.floor(m / 60)} h ${m % 60} min`
}

interface FlightRow { duration_s: number; started_at: string | null; in_progress: boolean }

/** HYRAK's record of this drone: its name, and what it has flown here. */
function HyrakRecord() {
    const drone = useDroneStore(s => s.session?.drone ?? null)
    const setSession = useDroneStore(s => s.setSession)
    const { customer } = useLiveScope()
    const [flights, setFlights] = useState<FlightRow[] | null>(null)
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState('')
    const [err, setErr] = useState<string | null>(null)
    const droneId = drone?.id

    useEffect(() => {
        if (!droneId) return
        let alive = true
        apiFetch(`/api/drones/${encodeURIComponent(droneId)}/flights?limit=200`)
            .then(r => r.ok ? r.json() : { flights: [] })
            .then(j => { if (alive) setFlights(j.flights ?? []) })
            .catch(() => { if (alive) setFlights([]) })
        return () => { alive = false }
    }, [droneId])

    const rename = async () => {
        const n = name.trim()
        if (!n || !drone) return
        setErr(null)
        try {
            const r = await apiFetch(`/api/drones/${encodeURIComponent(drone.id)}`, { method: 'PATCH', json: { name: n } })
            if (!r.ok) { setErr(r.status === 403 ? 'Renaming needs an operator account.' : 'The name was not saved. Try again.'); return }
            const s = useDroneStore.getState().session
            if (s) setSession({ ...s, drone: { ...drone, name: n } })
            setEditing(false)
        } catch { setErr('HYRAK did not answer. Try again.') }
    }

    if (!drone) {
        return (
            <Panel title="In HYRAK">
                <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5 }}>
                    HYRAK names each drone by its flight controller&apos;s hardware ID the first time it connects, and keeps its flight history here.
                    Connect a drone to see its record.
                </p>
            </Panel>
        )
    }
    const done = (flights ?? []).filter(f => !f.in_progress)
    const total = done.reduce((a, f) => a + (f.duration_s || 0), 0)
    const last = done[0]?.started_at ? new Date(done[0].started_at) : null
    return (
        <Panel title="In HYRAK" right={drone.is_simulated ? <Chip tone="off">Simulator</Chip> : undefined}>
            {editing ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input aria-label="Drone name" value={name} autoFocus maxLength={64}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setEditing(false) }}
                        className={FOCUS_RING}
                        style={{ flex: '1 1 180px', height: 34, padding: '0 10px', borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: T.surface, color: T.text, fontSize: 14, outline: 'none' }} />
                    <Btn kind="primary" onClick={() => void rename()} disabled={!name.trim()}>Save name</Btn>
                    <Btn onClick={() => setEditing(false)}>Cancel</Btn>
                </div>
            ) : (
                <Fact label="Name" value={drone.name}>
                    {!customer && (
                        <button type="button" aria-label="Rename drone" title="Rename" onClick={() => { setName(drone.name ?? ''); setEditing(true); setErr(null) }}
                            className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2 hover:text-app-text'}
                            style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Pencil size={14} />
                        </button>
                    )}
                </Fact>
            )}
            {err && <p role="alert" style={{ margin: 0, fontSize: 13, color: T.danger }}>{err}</p>}
            <Fact label="Flights" value={flights == null ? '...' : `${done.length}${done.length >= 200 ? '+' : ''}`} />
            <Fact label="Flight time" value={flights == null ? '...' : done.length ? fmtDuration(total) : 'None yet'} />
            <Fact label="Last flight" value={last ? last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : flights == null ? '...' : 'None yet'} />
        </Panel>
    )
}

/** MAV_SYS_ID, editable behind a warning: it changes who the aircraft is on
 *  the link, and a second drone with the same id is indistinguishable. */
function SystemIdPanel({ gcsSysid }: { gcsSysid?: number }) {
    const connected = useDroneStore(s => s.telemetryStatus) === 'connected'
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const [ask, setAsk] = useState<number | null>(null)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState<string | null>(null)
    const save = async (reboot: boolean) => {
        if (ask == null) return
        setBusy(true); setMsg(null)
        writeParam('MAV_SYS_ID', ask)
        if (reboot) {
            await new Promise(r => setTimeout(r, 500))
            const r = await droneAction('reboot', {}, 8000)
            if (!r.ok) { setBusy(false); setMsg(r.error ?? 'The reboot was refused. Reboot the flight controller yourself.'); return }
        }
        setBusy(false); setAsk(null)
    }
    return (
        <Panel title="MAVLink identity">
            <ParamRow spec={{ key: 'MAV_SYS_ID', label: 'Vehicle system ID', tip: 'Who this aircraft is on the MAVLink link. Every drone on one link needs its own. Applies after a reboot', def: 1, min: 1, max: 250, decimals: 0 }}
                disabled={armed} onWrite={(_k, v) => setAsk(Math.round(v))} />
            <Fact label="HYRAK ground ID" value={gcsSysid != null ? String(gcsSysid) : ''} emptyText={connected ? 'Not reported' : '-'} sub="The system ID HYRAK uses on this link. Set by HYRAK, one per link." />
            <Dialog open={ask != null} onClose={() => !busy && setAsk(null)} title="Change the vehicle system ID">
                <Note tone="warn">
                    The aircraft will answer as system {ask} after its next reboot. Two drones with the same ID on one link cannot be told apart,
                    and other ground stations or companion computers set to the old ID will lose it.
                </Note>
                <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>After the reboot, disconnect and connect again so HYRAK addresses the new ID.</p>
                {msg && <Note tone="danger">{msg}</Note>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <Btn onClick={() => setAsk(null)} disabled={busy}>Cancel</Btn>
                    <Btn onClick={() => void save(false)} disabled={busy}>Save only</Btn>
                    <Btn kind="primary" onClick={() => void save(true)} disabled={busy || armed}>{busy ? 'Saving...' : 'Save and reboot'}</Btn>
                </div>
            </Dialog>
        </Panel>
    )
}

export function VehicleSetup() {
    const { info, connected } = useVehicleInfo()
    const i = info?.ok ? info : null
    const px4 = (i?.autopilot ?? '').toUpperCase() === 'PX4'
    const fw = i?.firmware ? `${i.autopilot ? i.autopilot + ' ' : ''}${i.firmware}` : ''
    const board = [i?.vendor_name, i?.product_name].filter(Boolean).join(' ')
    const dash = connected ? 'Not reported' : '-'
    const ids = i?.vendor_id || i?.product_id ? `${hex(i?.vendor_id)} : ${hex(i?.product_id)}` : ''
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={340}>
                <Panel title="Flight controller" hint="as the drone reports it"
                    right={i?.release ? <Chip tone={i.release === 'release' ? 'ok' : 'warn'}>{i.release}</Chip> : undefined}>
                    {!connected && (
                        <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                            <b>No drone connected.</b> Connect one on the Connection page to read its firmware, board and hardware ID.
                        </Note>
                    )}
                    {connected && !info && <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Asking the flight controller...</p>}
                    {(!connected || info) && (
                        <>
                            <Fact label="Flight stack" value={i?.autopilot} emptyText={dash} />
                            <Fact label="Firmware" value={fw} emptyText={dash}>
                                {px4 && i?.git_hash && (
                                    <a href={`https://github.com/PX4/PX4-Autopilot/commit/${i.git_hash}`} target="_blank" rel="noreferrer"
                                        className={FOCUS_RING + ' rounded-sm hover:underline'} style={{ fontSize: 13, fontWeight: 600, color: T.accent, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        View commit <ExternalLink size={12} aria-hidden />
                                    </a>
                                )}
                            </Fact>
                            <Fact label="Git hash" value={i?.git_hash} mono copy={i?.git_hash || undefined} emptyText={dash} />
                            <Fact label="Operating system" value={i?.os_version ? `NuttX ${i.os_version}` : ''} emptyText={dash} />
                            <Fact label="Board" value={board} sub={ids ? `USB vendor : product ${ids}` : undefined} emptyText={dash} />
                            <Fact label="Hardware ID" value={i?.hardware_uid} mono copy={i?.hardware_uid || undefined} emptyText={dash} />
                            <Fact label="Vehicle type" value={i?.vehicle_type} emptyText={dash} />
                            {info && info.ok && info.info_ok === false && (
                                <Note>The flight controller has not answered the version request yet. Some simulators never do.</Note>
                            )}
                        </>
                    )}
                </Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                    <HyrakRecord />
                    <SystemIdPanel gcsSysid={i?.gcs_sysid} />
                </div>
            </Grid>
            <AirframePanel />
        </div>
    )
}

'use client'

// Shared pieces for the Config pages added for QGroundControl parity
// (Flight behaviour, fixed-wing tuning, VTOL, GPS & RTK, Payload, Traffic &
// Remote ID): what kind of aircraft this is, parameter rows that fill units,
// ranges and choices from PX4's metadata and only list what the aircraft has,
// a bitmask editor, the recent-writes log, a confirmed command button that
// shows the aircraft's acknowledgement, and the passive live feed.

import React, { useEffect, useState } from 'react'
import { Check, Loader, X } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { useParamMeta, type PMeta } from '@/lib/paramMeta'
import { useParamWriteLog } from '@/lib/paramWriteLog'
import { droneAction, type ActionResult } from '@/lib/droneAction'
import { kindFromAutostart, kindFromMavType } from '@/components/config/airframes'
import { useVehicleInfo } from '@/lib/vehicleInfo'
import { Btn, Dialog, Panel, ParamRow, T, Tip, Toggle, resolveKey, type ParamSpec } from '@/components/config/kit'

// ── What kind of aircraft ────────────────────────────────────────────────────

export interface VehicleClass {
    connected: boolean
    ready: boolean
    /** Fixed-wing controllers matter: a plane, or a VTOL in forward flight. */
    fw: boolean
    vtol: boolean
    plane: boolean
    /** VT_TYPE: 0 tailsitter, 1 tiltrotor, 2 standard; null if unknown. */
    vtolType: number | null
    /** Shown as reference with no aircraft: every page, PX4 defaults. */
    reference: boolean
}

/** From SYS_AUTOSTART (HYRAK's airframe list, so 4303 tilt-wing is a VTOL),
 *  then CA_AIRFRAME, then the heartbeat's MAV_TYPE. */
export function useVehicleClass(): VehicleClass {
    const vp = useVehicleParams()
    const { info } = useVehicleInfo()
    const kind = kindFromAutostart(vp.get('SYS_AUTOSTART'))
    const ca = vp.get('CA_AIRFRAME')
    const mt = kindFromMavType(info?.mav_type)
    const vtol = kind ? kind.startsWith('vtol') : ca != null ? ca >= 2 && ca <= 4 : !!mt?.startsWith('vtol')
    const plane = !vtol && (kind ? kind === 'plane' || kind === 'wing' : ca != null ? ca === 1 : mt === 'plane' || mt === 'wing')
    const reference = !vp.ready
    const vt = vp.get('VT_TYPE')
    return {
        connected: vp.connected, ready: vp.ready,
        vtol: vtol || reference, plane: plane || reference, fw: vtol || plane || reference,
        vtolType: vt ?? (kind === 'vtol-tilt' ? 1 : kind === 'vtol-tailsitter' ? 0 : kind === 'vtol-standard' ? 2 : null),
        reference,
    }
}

// ── Rows from metadata ───────────────────────────────────────────────────────

const UNIT: Record<string, string> = { deg: '°', 'deg/s': '°/s', 'deg/s^2': '°/s²', 'm/s^2': 'm/s²', 'm/s^3': 'm/s³', norm: '', '%': '%' }

/** A spec with the gaps (unit, range, default, choices) filled from PX4's
 *  metadata for this firmware. What the spec says wins. */
export function withMeta(spec: ParamSpec, m: PMeta | undefined | null): ParamSpec {
    if (!m) return spec
    const out: ParamSpec = { ...spec }
    if (out.unit == null && m.u) out.unit = UNIT[m.u] ?? m.u
    if (out.def == null && m.d != null) out.def = m.d
    if (!out.bool && !out.options) {
        if (m.v && m.v.length) {
            const opts = m.v.map(([value, label]) => ({ value, label }))
            if (opts.length === 2 && opts.every(o => o.value === 0 || o.value === 1) && /disabled|off/i.test(String(opts.find(o => o.value === 0)?.label))) out.bool = true
            else out.options = opts
        } else {
            if (out.min == null && m.min != null) out.min = (out.scale ?? 1) * m.min
            if (out.max == null && m.max != null) out.max = (out.scale ?? 1) * m.max
            if (out.decimals == null && m.dec != null) out.decimals = m.dec
            if (out.decimals == null && m.t === 'i') out.decimals = 0
        }
    }
    if (out.tip == null && m.s) out.tip = m.s
    return out
}

/** Parameter rows that only list what the aircraft has (all of them, as
 *  reference, with no aircraft). `empty` is shown when none is present. */
export function SpecRows({ specs, compact, empty, disabled }: { specs: ParamSpec[]; compact?: boolean; empty?: React.ReactNode; disabled?: boolean }) {
    const vp = useVehicleParams()
    const { meta } = useParamMeta()
    const inMeta = (s: ParamSpec) => !!meta && [s.key, ...(s.alt ?? [])].some(k => !!meta[k])
    // With no aircraft, of two specs for the same setting (an old and a new
    // parameter name) show the one this PX4 reference has.
    const shown = specs.filter(s => vp.ready ? vp.has(resolveKey(s, vp.has))
        : inMeta(s) || !specs.some(o => o !== s && o.label === s.label && inMeta(o)))
    if (!shown.length) return <>{empty ?? <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Not on this firmware.</p>}</>
    return <>{shown.map(s => <ParamRow key={s.key} spec={withMeta(s, meta?.[resolveKey(s, vp.has)])} compact={compact} disabled={disabled} />)}</>
}

/** True when at least one of the keys is on the aircraft (or no aircraft). */
export function useAnyParam(keys: string[]): boolean {
    const vp = useVehicleParams()
    return !vp.ready || keys.some(k => vp.has(k))
}

/** A bitmask parameter as a list of switches, one per bit, with PX4's own
 *  bit names unless `bits` gives plainer ones. */
export function BitmaskRow({ k, label, tip, bits }: { k: string; label: string; tip?: string; bits?: [number, string][] }) {
    const vp = useVehicleParams()
    const { meta } = useParamMeta()
    const m = meta?.[k]
    const list = bits ?? m?.b ?? []
    const live = vp.get(k)
    const value = vp.ready ? live : m?.d ?? null
    if (vp.ready && live == null) return null
    const canEdit = vp.ready && live != null
    const pending = !!vp.pending[k], failed = vp.failed[k]
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</span>
                <Tip text={`${tip ?? m?.s ?? label} (${k})`} />
                {!vp.ready && <span style={{ fontSize: 12, color: T.subtle }}>default</span>}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {pending ? <Loader size={13} className="animate-spin" style={{ color: T.accent, verticalAlign: -2 }} aria-label="Saving" /> : null} {value ?? '-'}
                </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))', gap: '4px 16px' }}>
                {list.map(([bit, name]) => {
                    const on = value != null && ((Math.round(value) >>> 0) & (1 << bit)) !== 0
                    return (
                        <label key={bit} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, fontSize: 13, color: canEdit ? T.text : T.muted }}>
                            <Toggle label={name} value={on} disabled={!canEdit || pending}
                                onChange={v => live != null && writeParam(k, v ? (Math.round(live) | (1 << bit)) : (Math.round(live) & ~(1 << bit)))} />
                            {name}
                        </label>
                    )
                })}
            </div>
            {failed && <p role="alert" style={{ margin: 0, fontSize: 12, color: T.danger }}>{failed}</p>}
        </div>
    )
}

// ── Recent writes ────────────────────────────────────────────────────────────

const fmt = (v: number | null) => v == null ? '?' : Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))

/** What each write changed and what the aircraft answered. */
export function WriteLog() {
    const entries = useParamWriteLog()
    if (!entries.length) return null
    return (
        <Panel title="Changes this session" hint="each write and the aircraft's answer" gap={4}>
            {entries.map((e, i) => (
                <div key={`${e.key}-${e.at}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, fontSize: 13, flexWrap: 'wrap' }}>
                    <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center' }}>
                        {e.state === 'pending' ? <Loader size={14} className="animate-spin" style={{ color: T.accent }} aria-label="Waiting for the aircraft" />
                            : e.state === 'saved' ? <Check size={15} strokeWidth={3} style={{ color: T.ok }} aria-label="Saved" />
                            : <X size={15} style={{ color: T.danger }} aria-label="Refused" />}
                    </span>
                    <span className="font-code" style={{ fontWeight: 700, color: T.text }}>{e.key}</span>
                    <span style={{ color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(e.from)} to {e.state === 'saved' ? fmt(e.to) : '...'}
                    </span>
                    <span style={{ marginLeft: 'auto', color: e.state === 'refused' ? T.danger : e.state === 'saved' ? T.ok : T.muted, fontWeight: 600 }}>
                        {e.state === 'pending' ? 'Waiting for the aircraft' : e.state === 'saved' ? 'Saved on the aircraft' : `Refused: ${e.reason}`}
                    </span>
                </div>
            ))}
        </Panel>
    )
}

// ── A command with a confirmation and the aircraft's answer ─────────────────

/** A bench command: disabled unless connected and disarmed, asks for a
 *  confirmation, then shows what the aircraft answered. */
export function ConfirmCommand({ label, title, body, confirmLabel, action, data, kind = 'quiet', timeoutMs = 9000, disabledWhy }: {
    label: React.ReactNode; title: string; body: React.ReactNode; confirmLabel: string
    action: string; data: Record<string, unknown>; kind?: 'quiet' | 'primary' | 'danger'; timeoutMs?: number
    disabledWhy?: string | null
}) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = useDroneStore(s => !!s.telemetry?.flight_mode?.is_armed)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [res, setRes] = useState<ActionResult & { ack?: string } | null>(null)
    const why = !connected ? 'Connect a drone first' : armed ? 'Disarm first' : disabledWhy ?? null
    const go = async () => {
        setOpen(false); setBusy(true); setRes(null)
        const r = await droneAction(action, { ...data, confirmed: true }, timeoutMs)
        setRes(r as ActionResult & { ack?: string }); setBusy(false)
    }
    return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
            <Btn kind={kind === 'danger' ? 'danger' : kind} disabled={!!why || busy} title={why ?? undefined} onClick={() => setOpen(true)}>
                {busy && <Loader size={14} className="animate-spin" aria-hidden />}{label}
            </Btn>
            {res && (
                <span role="status" style={{ fontSize: 13, lineHeight: 1.45, color: res.ok ? T.ok : T.danger }}>
                    {res.ok ? (res.msg ?? 'Done') : (res.error ?? 'The drone refused')}
                </span>
            )}
            <Dialog open={open} onClose={() => setOpen(false)} title={title}>
                {body}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <Btn onClick={() => setOpen(false)}>Cancel</Btn>
                    <Btn kind={kind === 'danger' ? 'danger' : 'primary'} big={kind === 'danger'} onClick={go}>{confirmLabel}</Btn>
                </div>
            </Dialog>
        </span>
    )
}

// ── Passive live feed (backend app/events/gps_events.py) ────────────────────

type M<T> = T & { age: number }
export interface GpsRaw {
    fix_type?: number; lat?: number; lon?: number; alt?: number; eph?: number; epv?: number; vel?: number; cog?: number
    satellites_visible?: number; h_acc?: number; v_acc?: number; yaw?: number; dgps_numch?: number; dgps_age?: number
}
export interface GpsRtk { rtk_health?: number; rtk_rate?: number; nsats?: number; baseline_a_mm?: number; baseline_b_mm?: number; baseline_c_mm?: number; accuracy?: number; iar_num_hypotheses?: number }
export interface AdsbVehicle {
    ICAO_address: number; lat?: number; lon?: number; altitude?: number; altitude_type?: number; heading?: number
    hor_velocity?: number; ver_velocity?: number; callsign?: string; emitter_type?: number; tslc?: number; flags?: number; squawk?: number; age: number
}
export interface SetupLive {
    GPS_RAW_INT?: M<GpsRaw>
    GPS2_RAW?: M<GpsRaw>
    GPS_RTK?: M<GpsRtk>
    GPS2_RTK?: M<GpsRtk>
    OPEN_DRONE_ID_ARM_STATUS?: M<{ status?: number; error?: string; component?: number }>
    ADSB_VEHICLE?: AdsbVehicle[]
    error?: string
}

/** Latest GNSS / ADS-B / Remote ID readings off the session's own link while
 *  mounted. Passive; the request is a lease renewed every 8 s. */
export function useSetupLive(): { data: SetupLive; at: number } {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const [state, setState] = useState<{ data: SetupLive; at: number }>({ data: {}, at: 0 })
    const [was, setWas] = useState(connected)
    if (was !== connected) {
        setWas(connected)
        if (!connected) setState({ data: {}, at: 0 })
    }
    useEffect(() => {
        if (!connected) return
        const socket = getSocket()
        const on = (d: SetupLive) => setState({ data: d ?? {}, at: Date.now() })
        socket.on('setup_live_data', on)
        const ask = () => socket.emit('setup_live', { on: true })
        ask()
        const t = setInterval(ask, 8000)
        return () => { clearInterval(t); socket.off('setup_live_data', on); socket.emit('setup_live', { on: false }) }
    }, [connected])
    return state
}

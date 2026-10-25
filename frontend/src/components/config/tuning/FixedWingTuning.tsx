'use client'

// Config > Tuning > Fixed-wing. QGroundControl's fixed-wing tuning pages on
// PX4 1.15-1.17: the rate PIDs per axis, the attitude loop, TECS (height and
// airspeed), NPFG path following, airspeeds and throttle. Only parameters the
// aircraft has are listed; with no aircraft, PX4 defaults for reference.

import React from 'react'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { useParamMeta } from '@/lib/paramMeta'
import { Grid, Note, NumberBox, Panel, T, Tip, mix } from '@/components/config/kit'
import { SpecRows } from '@/components/config/setupKit'
import { FW_ATT, FW_GUIDANCE, FW_RATE, FW_RATE_COLS, FW_SPEED, FW_TECS, FW_THROTTLE } from './fwGains'

export function FixedWingTuning() {
    const vp = useVehicleParams()
    const stall = vp.get('FW_AIRSPD_STALL'), min = vp.get('FW_AIRSPD_MIN'), trim = vp.get('FW_AIRSPD_TRIM'), max = vp.get('FW_AIRSPD_MAX')
    const order = vp.ready && min != null && trim != null && max != null && !(min < trim && trim < max && (stall == null || stall < min))
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Note>
                Fixed-wing flight is tuned in this order: airspeeds and cruise throttle first, then the rate loop (feed-forward does most of the work),
                then the attitude time constants, then TECS for height and speed. PX4&apos;s fixed-wing autotune runs from the transmitter (FW_AT_*).
            </Note>
            {order && <Note tone="warn">Airspeeds are out of order. PX4 needs stall below minimum, minimum below cruise, and cruise below maximum.</Note>}
            <Panel title="Rate controller" hint="how hard each control surface fights a rotation"
                right={<Tip text="PX4 fixed-wing rate loop: surface = FF x rate setpoint + P x error + I x integral + D x rate of change, scaled by airspeed. Tune feed-forward first so the aircraft follows the stick, then add P for disturbances." />}>
                <FwRateTable />
            </Panel>
            <Grid min={340}>
                <Panel title="Attitude controller" hint="how quickly it holds an angle"><SpecRows specs={FW_ATT} compact /></Panel>
                <Panel title="Height and speed (TECS)" hint="climb, sink and the trade between them"><SpecRows specs={FW_TECS} compact /></Panel>
                <Panel title="Path following (NPFG)" hint="how tightly it flies lines and orbits"><SpecRows specs={FW_GUIDANCE} compact /></Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <Panel title="Airspeeds"><SpecRows specs={FW_SPEED} compact /></Panel>
                    <Panel title="Throttle"><SpecRows specs={FW_THROTTLE} compact /></Panel>
                </div>
            </Grid>
        </div>
    )
}

function FwRateTable() {
    const vp = useVehicleParams()
    const { meta } = useParamMeta()
    const cols = FW_RATE_COLS.map((c, i) => ({ c, i })).filter(({ i }) => !vp.ready || FW_RATE.some(r => vp.has(r.cells[i].key)))
    if (vp.ready && cols.length === 0) return <p style={{ margin: 0, fontSize: 13, color: T.muted }}>This firmware has no fixed-wing rate controller.</p>
    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr><th style={TH} />{cols.map(({ c }) => <th key={c} style={TH}>{c}</th>)}</tr></thead>
                <tbody>
                    {FW_RATE.map(row => (
                        <tr key={row.axis}>
                            <td style={{ ...TD, fontWeight: 700, fontSize: 14 }}>{row.axis}</td>
                            {cols.map(({ i }) => {
                                const cell = row.cells[i]
                                const live = vp.get(cell.key)
                                const missing = vp.ready && live == null
                                const m = meta?.[cell.key]
                                return (
                                    <td key={cell.key} style={TD} title={vp.failed[cell.key] || cell.key}>
                                        <span style={{ display: 'inline-flex', borderRadius: 7, outline: vp.pending[cell.key] ? `2px solid ${mix('var(--app-accent)', 50)}` : vp.failed[cell.key] ? `2px solid ${mix('var(--app-danger)', 60)}` : undefined }}>
                                            <NumberBox label={`${row.axis} ${cell.key}`} value={vp.ready ? live : (m?.d ?? cell.def)} disabled={!vp.ready || missing}
                                                onCommit={v => writeParam(cell.key, v)} min={m?.min ?? 0} max={m?.max ?? 10} decimals={m?.dec ?? 3} width={84}
                                                placeholder={missing ? 'n/a' : undefined} />
                                        </span>
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, fontSize: 12, color: T.muted, textAlign: 'left', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, color: T.text, whiteSpace: 'nowrap' }

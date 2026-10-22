'use client'

// Config > Radio & RC, the parts QGroundControl has that the stick page did
// not: which channel drives each stick axis, per-channel reverse and
// deadzone, and the calibrated endpoints PX4 holds for every channel.

import React from 'react'
import { numberedKeys, useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Grid, NumberBox, Panel, T, Tip, Toggle, mix } from '@/components/config/kit'

const AXES = [
    { key: 'RC_MAP_ROLL', label: 'Roll', def: 1 },
    { key: 'RC_MAP_PITCH', label: 'Pitch', def: 2 },
    { key: 'RC_MAP_THROTTLE', label: 'Throttle', def: 3 },
    { key: 'RC_MAP_YAW', label: 'Yaw', def: 4 },
]
const CH_OPTS = [{ value: 0, label: 'Unassigned' }, ...Array.from({ length: 18 }, (_, i) => ({ value: i + 1, label: `CH${i + 1}` }))]

export function RadioChannels({ extra }: { extra?: React.ReactNode } = {}) {
    const vp = useVehicleParams()
    const chans = vp.ready ? numberedKeys(vp.params, /^RC(\d+)_MIN$/) : Array.from({ length: 8 }, (_, i) => i + 1)
    const axisOf = (ch: number) => AXES.find(a => (vp.ready ? vp.get(a.key) : a.def) === ch)?.label
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={300}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                <Panel title="Stick channels" hint="which channel drives each axis">
                    {AXES.map(a => {
                        const v = vp.ready ? vp.get(a.key) : a.def
                        return (
                            <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
                                <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text }}>{a.label}</span>
                                {!vp.ready && <span style={{ fontSize: 12, color: T.subtle }}>default</span>}
                                <OptionSelect size="sm" aria-label={`${a.label} channel`} className="w-auto min-w-[120px] text-[13px] data-[size=sm]:h-8"
                                    value={v} disabled={!vp.ready} onChange={ch => writeParam(a.key, ch)} options={CH_OPTS} />
                            </div>
                        )
                    })}
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>Run the stick calibration again after changing these.</p>
                </Panel>
                {extra}
                </div>
                <Panel title="Channels" hint="calibrated range, reverse and deadzone"
                    right={<Tip text="Min, trim and max come from the stick calibration (RCn_MIN / TRIM / MAX). Reverse flips a channel (RCn_REV). Deadzone ignores small movements around the centre (RCn_DZ, microseconds)." />}>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                            <thead><tr style={{ color: T.muted, textAlign: 'left' }}>
                                {['Ch', 'Axis', 'Min', 'Trim', 'Max', 'Reverse', 'Deadzone'].map(h => <th key={h} style={TH}>{h}</th>)}
                            </tr></thead>
                            <tbody>
                                {chans.map(c => {
                                    const rev = vp.get(`RC${c}_REV`)
                                    const axis = axisOf(c)
                                    const min = vp.get(`RC${c}_MIN`), trim = vp.get(`RC${c}_TRIM`), max = vp.get(`RC${c}_MAX`)
                                    const odd = vp.ready && min != null && max != null && (max - min < 600 || min < 800 || max > 2200)
                                    return (
                                        <tr key={c}>
                                            <td style={TD}><b>{c}</b></td>
                                            <td style={{ ...TD, color: axis ? T.accent : T.subtle, fontWeight: axis ? 700 : 400 }}>{axis ?? '-'}</td>
                                            <td style={{ ...TD, color: odd ? T.warn : T.text }}>{vp.ready ? (min ?? '-') : 1000}</td>
                                            <td style={TD}>{vp.ready ? (trim ?? '-') : 1500}</td>
                                            <td style={{ ...TD, color: odd ? T.warn : T.text }}>{vp.ready ? (max ?? '-') : 2000}</td>
                                            <td style={TD}>
                                                <Toggle label={`Reverse channel ${c}`} value={(rev ?? 1) < 0} disabled={!vp.ready || rev == null}
                                                    onChange={on => writeParam(`RC${c}_REV`, on ? -1 : 1)} />
                                            </td>
                                            <td style={TD}>
                                                <span style={{ display: 'inline-flex', borderRadius: 7, outline: vp.pending[`RC${c}_DZ`] ? `2px solid ${mix('var(--app-accent)', 50)}` : undefined }}>
                                                    <NumberBox label={`Channel ${c} deadzone`} value={vp.ready ? vp.get(`RC${c}_DZ`) : 10} disabled={!vp.ready || !vp.has(`RC${c}_DZ`)}
                                                        onCommit={v => writeParam(`RC${c}_DZ`, v)} min={0} max={100} decimals={0} width={64} />
                                                </span>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </Panel>
            </Grid>
        </div>
    )
}

const TH: React.CSSProperties = { padding: '6px 6px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const TD: React.CSSProperties = { padding: '4px 6px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap', color: T.text }

'use client'

// Config > Traffic & Remote ID. ADS-B in (a receiver on the aircraft: the
// live traffic it reports and what PX4 does about it), ADS-B out (transponder
// identity), and Remote ID (Open Drone ID): PX4's arming check and the live
// arm status the Remote ID module reports. Live data is read passively off
// this session's link (backend app/events/gps_events.py, `setup_live`).

import React from 'react'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Chip, Grid, Note, Panel, ParamSourceBar, ReloadButton, T, type ParamSpec } from '@/components/config/kit'
import { SpecRows, WriteLog, useSetupLive, type AdsbVehicle } from '@/components/config/setupKit'

const TRAFFIC: ParamSpec[] = [
    { key: 'NAV_TRAFF_AVOID', label: 'When traffic comes close', tip: 'What PX4 does when an ADS-B or FLARM report predicts a conflict.' },
    { key: 'NAV_TRAFF_A_HOR', label: 'Horizontal safety distance' },
    { key: 'NAV_TRAFF_A_VER', label: 'Vertical safety distance' },
    { key: 'NAV_TRAFF_COLL_T', label: 'Warn this long before a conflict' },
    { key: 'COM_ARM_TRAFF', label: 'Arming needs a traffic receiver' },
    { key: 'ADSB_LIST_MAX', label: 'Aircraft tracked at once' },
]

const OUT: ParamSpec[] = [
    { key: 'ADSB_ICAO_ID', label: 'ICAO address', tip: 'The 24-bit aircraft address issued with the registration. -1 = none.' },
    { key: 'ADSB_SQUAWK', label: 'Squawk code', tip: 'Four octal digits, 0000 to 7777. 1200 is VFR in many countries.' },
    { key: 'ADSB_EMIT_TYPE', label: 'Emitter type' },
    { key: 'ADSB_LEN_WIDTH', label: 'Size class' },
    { key: 'ADSB_MAX_SPEED', label: 'Max speed class' },
    { key: 'ADSB_GPS_OFF_LAT', label: 'Antenna offset, sideways' },
    { key: 'ADSB_GPS_OFF_LON', label: 'Antenna offset, along' },
    { key: 'ADSB_IDENT', label: 'Ident' },
    { key: 'ADSB_EMERGC', label: 'Emergency state' },
]

const ODID: ParamSpec[] = [
    { key: 'COM_ARM_ODID', label: 'Arming needs Remote ID', options: [{ value: 0, label: 'No check' }, { value: 1, label: 'Warn only' }, { value: 2, label: 'Refuse to arm without it' }],
        tip: 'PX4 checks that a Remote ID module is present and healthy before arming.' },
]

const EMITTER: Record<number, string> = { 1: 'Light', 2: 'Small', 3: 'Large', 5: 'Heavy', 7: 'Rotorcraft', 9: 'Glider', 10: 'Balloon', 12: 'Ultralight', 14: 'Drone' }

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000, r = Math.PI / 180
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
}

export function TrafficSetup() {
    const vp = useVehicleParams()
    const live = useSetupLive()
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const odid = live.data.OPEN_DRONE_ID_ARM_STATUS
    const hasAdsbOut = !vp.ready || OUT.some(s => vp.has(s.key))
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="traffic and Remote ID settings" /></div>
                <ReloadButton />
            </div>
            <TrafficList list={live.data.ADSB_VEHICLE ?? []} connected={connected} waiting={!live.at} />
            <Grid min={360}>
                <Panel title="Traffic avoidance" hint="ADS-B / FLARM in"><SpecRows specs={TRAFFIC} compact /></Panel>
                <Panel title="Remote ID" hint="Open Drone ID"
                    right={odid ? <Chip tone={odid.status === 0 ? 'ok' : 'warn'}>{odid.status === 0 ? 'Ready to arm' : 'Not ready'}</Chip> : connected ? <Chip tone="off">No module heard</Chip> : undefined}>
                    <SpecRows specs={ODID} />
                    {odid && odid.status !== 0 && odid.error && <Note tone="warn">The Remote ID module says: {odid.error}</Note>}
                    {connected && !odid && <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>No OPEN_DRONE_ID_ARM_STATUS on this link. A Remote ID module that speaks MAVLink reports here; a standalone broadcast module does not.</p>}
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Operator ID and operator location are not sent from HYRAK yet. Set them in the module&apos;s own tool where your regulator requires them.
                    </p>
                </Panel>
                <Panel title="ADS-B out" hint="transponder identity">
                    {hasAdsbOut ? <SpecRows specs={OUT} compact /> : <Note>No ADS-B transponder driver on this firmware.</Note>}
                </Panel>
            </Grid>
            <WriteLog />
        </div>
    )
}

function TrafficList({ list, connected, waiting }: { list: AdsbVehicle[]; connected: boolean; waiting: boolean }) {
    const pos = useDroneStore(s => s.telemetry?.position)
    const here = pos && (pos.latitude_deg || pos.longitude_deg) ? pos : null
    const rows = list.map(v => {
        const ok = (v.flags ?? 1) & 1 && v.lat != null && v.lon != null
        const d = ok && here ? distM(here.latitude_deg, here.longitude_deg, v.lat! / 1e7, v.lon! / 1e7) : null
        const dAlt = (v.flags ?? 2) & 2 && v.altitude != null && here ? v.altitude / 1000 - here.absolute_altitude_m : null
        return { v, d, dAlt }
    }).sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12))
    return (
        <Panel title="Traffic nearby" hint="ADS-B reports from the aircraft's receiver"
            right={connected ? <Chip tone={rows.length ? 'accent' : 'off'}>{rows.length} aircraft</Chip> : undefined}>
            {!connected ? <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Connect a drone with an ADS-B receiver to see traffic.</p>
                : rows.length === 0 ? <p style={{ margin: 0, fontSize: 13, color: T.muted }}>{waiting ? 'Listening...' : 'No traffic reported in the last minute. Without an ADS-B receiver on the aircraft this stays empty.'}</p>
                : (
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums', width: '100%' }}>
                            <thead><tr>{['Callsign', 'ICAO', 'Distance', 'Height vs drone', 'Heading', 'Speed', 'Squawk', 'Type', 'Heard'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                            <tbody>
                                {rows.map(({ v, d, dAlt }) => {
                                    const close = d != null && d < 2000 && (dAlt == null || Math.abs(dAlt) < 300)
                                    return (
                                        <tr key={v.ICAO_address}>
                                            <td style={{ ...TD, fontWeight: 700 }}>{v.callsign || '-'}</td>
                                            <td style={TD} className="font-code">{v.ICAO_address.toString(16).toUpperCase().padStart(6, '0')}</td>
                                            <td style={{ ...TD, color: close ? T.danger : T.text, fontWeight: close ? 700 : 400 }}>{d == null ? '-' : d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toFixed(1)} km`}</td>
                                            <td style={TD}>{dAlt == null ? '-' : `${dAlt >= 0 ? '+' : ''}${dAlt.toFixed(0)} m`}</td>
                                            <td style={TD}>{v.heading == null || !((v.flags ?? 4) & 4) ? '-' : `${(v.heading / 100).toFixed(0)}°`}</td>
                                            <td style={TD}>{v.hor_velocity == null || !((v.flags ?? 8) & 8) ? '-' : `${(v.hor_velocity / 100 * 3.6).toFixed(0)} km/h`}</td>
                                            <td style={TD}>{v.squawk ? v.squawk.toString().padStart(4, '0') : '-'}</td>
                                            <td style={TD}>{EMITTER[v.emitter_type ?? -1] ?? '-'}</td>
                                            <td style={TD}>{v.age.toFixed(0)} s ago</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
        </Panel>
    )
}

const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, fontSize: 12, color: T.muted, textAlign: 'left', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, color: T.text, whiteSpace: 'nowrap' }

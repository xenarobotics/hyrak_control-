'use client'

// Config > Connection. The link is picked with the same controls as the Fly
// page's Link card (DeviceSelector, backed by useTelemetryLink), so the two
// pages can never offer different links. A typed MAVLink address stays as an
// expert option for staff, because it makes the SERVER bind a port
// (docs/ACCESS_MODEL.md section 8a).

import React, { useCallback, useState } from 'react'
import { ChevronRight, Cloud, Cpu, Laptop, Radio, Wifi, WifiOff } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { useVehicleInfo } from '@/lib/vehicleInfo'
import { useLiveScope } from '@/hooks/useLiveScope'
import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { getRfDownlinkPort, setRfDownlinkPort, getRfUplinkPort, setRfUplinkPort, getRfUplinkHost, setRfUplinkHost } from '@/lib/rfBridge'
import { Btn, Chip, FOCUS_RING, Grid, Note, Panel, T, mix } from '@/components/config/kit'
import { Fact } from '@/components/config/VehicleSetup'

// Sentinel address for the wfb-ng air-unit preset: connect() fires
// 'connect_rf_bridge' instead of 'connect_telemetry', since the RF link needs
// the split-port bridge in app/telemetry/rf_bridge.py rather than a direct
// MAVSDK udpin:// connect.
const RF_BRIDGE_ADDR = 'rfbridge://wfb-ng'
const ADDRESS_KEY = 'hyrak-mav-address'

const MAV_PRESETS = [
    { label: 'PX4 SITL (UDP)', addr: 'udpin://0.0.0.0:14540' },
    { label: 'ArduPilot SITL', addr: 'udpin://0.0.0.0:14550' },
    { label: 'Custom RF air unit (wfb-ng)', addr: RF_BRIDGE_ADDR },
    { label: 'USB / telemetry radio on the server', addr: 'serial:///dev/ttyUSB0:57600' },
    { label: 'TCP (companion)', addr: 'tcp://192.168.1.1:5760' },
]

function readAddress(): string {
    if (typeof window === 'undefined') return MAV_PRESETS[0].addr
    try { const v = localStorage.getItem(ADDRESS_KEY); return v ? JSON.parse(v) : MAV_PRESETS[0].addr } catch { return MAV_PRESETS[0].addr }
}
function saveAddress(v: string) {
    try { localStorage.setItem(ADDRESS_KEY, JSON.stringify(v)) } catch { /* private window */ }
}

const INPUT: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 11px', borderRadius: 6, boxSizing: 'border-box', outline: 'none',
    background: T.surface, border: `1px solid ${T.borderStrong}`, color: T.text, fontSize: 14, fontVariantNumeric: 'tabular-nums',
}
const DISABLED_INPUT: React.CSSProperties = { ...INPUT, background: T.surface2, border: `1px solid ${T.border}`, color: T.muted, cursor: 'not-allowed' }

/** Drone, link, this device, HYRAK: the path every message takes, top to
 *  bottom, the line lit while the link is up. */
function LinkPath({ connected, linkLabel }: { connected: boolean; linkLabel: string }) {
    const nodes = [
        { icon: Cpu, title: 'Flight controller', sub: 'on the drone' },
        { icon: Radio, title: linkLabel || 'Radio or simulator', sub: 'the telemetry link' },
        { icon: Laptop, title: 'This device', sub: 'browser or HYRAK desktop app' },
        { icon: Cloud, title: 'HYRAK', sub: 'ground station in the cloud' },
    ]
    const c = connected ? T.ok : T.muted
    return (
        <ol role="list" aria-label={`Flight controller, ${linkLabel || 'link'}, this device, HYRAK: ${connected ? 'connected' : 'not connected'}`}
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {nodes.map((n, i) => (
                <li key={n.title} style={{ display: 'flex', gap: 12, minHeight: i < nodes.length - 1 ? 50 : 0 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                        <span style={{ width: 32, height: 32, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: `1px solid ${connected ? mix(T.ok, 40) : T.border}`, background: connected ? mix(T.ok, 8) : T.surface2 }}>
                            <n.icon size={15} style={{ color: c }} aria-hidden />
                        </span>
                        {i < nodes.length - 1 && <span aria-hidden style={{ flex: 1, width: 2, minHeight: 14, borderRadius: 1, background: connected ? mix(T.ok, 45) : T.border }} />}
                    </div>
                    <div style={{ minWidth: 0, paddingTop: 5 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{n.title}</div>
                        <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.4 }}>{n.sub}</div>
                    </div>
                </li>
            ))}
        </ol>
    )
}

function LinkHealth({ linkLabel }: { linkLabel: string }) {
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const linkOk = useDroneStore(s => s.telemetry?.link_ok)
    const lostS = useDroneStore(s => s.telemetry?.link_lost_s)
    const { info } = useVehicleInfo(2000)
    const connected = telStatus === 'connected'
    if (!connected) {
        return (
            <Panel title="Link health">
                <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                    {telStatus === 'connecting' ? 'Connecting...' : 'No drone connected. Pick a link and connect to see how it is doing.'}
                </Note>
            </Panel>
        )
    }
    const i = info?.ok ? info : null
    const age = i?.last_rx_age_s
    const ageTone = age == null ? undefined : age < 1.5 ? T.ok : age < 3 ? T.warn : T.danger
    const rates = i?.rates ?? {}
    const total = Object.values(rates).reduce((a, b) => a + b, 0)
    const lost = linkOk === false
    return (
        <Panel title="Link health" right={lost ? <Chip tone="danger">Link lost {lostS ? `${Math.round(lostS)} s` : ''}</Chip> : <Chip tone="ok">Receiving</Chip>}>
            <Fact label="Link" value={linkLabel} />
            <Fact label="Last message">
                {age != null && <span style={{ fontSize: 14, fontWeight: 700, color: ageTone, fontVariantNumeric: 'tabular-nums' }}>{age < 0.1 ? 'just now' : `${age.toFixed(1)} s ago`}</span>}
                {age == null && <span style={{ fontSize: 14, color: T.muted }}>Waiting</span>}
            </Fact>
            <Fact label="Messages" value={total > 0 ? `${total.toFixed(1)} per second` : ''}
                sub={Object.keys(rates).length ? Object.entries(rates).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') + ' (measured on arrival)' : undefined} />
            <Fact label="Tuned for" value={i?.link_kind === 'radio' ? 'Telemetry radio (lower rates)' : i?.link_kind ? 'Local network (full rates)' : ''} />
            <Fact label="Vehicle system ID" value={i?.vehicle_sysid != null ? String(i.vehicle_sysid) : ''} />
            <Fact label="HYRAK ground ID" value={i?.gcs_sysid != null ? String(i.gcs_sysid) : ''} />
            <Fact label="Server endpoint" value={i?.address} mono />
        </Panel>
    )
}

/** Measured stream rates against what this build asks for. A 3DR/SiK radio's
 *  ceiling is set by AIR_SPEED and ECC on the radio, invisible from here, so
 *  the request is only a request: if the measured figure stops following it,
 *  that is the ceiling. */
function LinkThroughput() {
    const measured = useDroneStore(s => s.telemetry?.measured_rates)
    if (!measured || Object.keys(measured).length === 0) return null
    const asked: Record<string, number> = { position: 8, attitude: 10 }
    const tone = (m: number, a: number) => !a ? T.muted : m / a >= 0.85 ? T.ok : m / a >= 0.55 ? T.warn : T.danger
    return (
        <Panel title="Throughput" hint="measured against what HYRAK asks for">
            {Object.entries(measured).map(([k, v]) => {
                const want = asked[k] ?? 0
                return (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, color: T.muted }}>{k}</span>
                        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: tone(v as number, want) }}>
                            {(v as number).toFixed(1)} Hz{want > 0 && <span style={{ color: T.muted }}> of {want} asked</span>}
                        </span>
                    </div>
                )
            })}
            <p style={{ fontSize: 13, color: T.muted, lineHeight: 1.5, margin: 0 }}>
                Green means the link delivers what was asked. If it stays amber or red, the radio is at its ceiling:
                raise AIR_SPEED or turn ECC off on the radio.
            </p>
        </Panel>
    )
}

/** The expert path: a MAVLink address the server opens itself. */
function CustomAddress() {
    const connected = useDroneStore(s => s.telemetryStatus) === 'connected'
    const [address, setAddressState] = useState(readAddress)
    const setAddress = (v: string) => { setAddressState(v); saveAddress(v) }
    const [downlinkPort, setDownlinkPort] = useState(() => getRfDownlinkPort())
    const [uplinkPort, setUplinkPort] = useState(() => getRfUplinkPort())
    const [uplinkHost, setUplinkHost] = useState(() => getRfUplinkHost())
    const connect = useCallback(() => {
        saveAddress(address)
        if (address === RF_BRIDGE_ADDR) getSocket().emit('connect_rf_bridge', { downlinkPort, uplinkPort, uplinkHost })
        else getSocket().emit('connect_telemetry', { address })
    }, [address, downlinkPort, uplinkPort, uplinkHost])
    const label = (t: string) => <span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>{t}</span>

    return (
        <details className="group" style={{ borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface }}>
            <summary className={'flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-4 py-3 text-app-text hover:bg-app-surface-2 transition-colors ' + FOCUS_RING} style={{ fontSize: 14, fontWeight: 700, flexWrap: 'wrap' }}>
                <ChevronRight size={16} aria-hidden className="text-app-text-muted transition-transform duration-200 group-open:rotate-90" />
                Advanced: custom MAVLink address
                <span style={{ fontSize: 13, fontWeight: 400, color: T.muted }}>a port the HYRAK server opens itself (staff)</span>
            </summary>
            <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {label('MAVLink address')}
                    <input aria-label="MAVLink address" value={address} disabled={connected} onChange={e => setAddress(e.target.value)}
                        placeholder="udpin://0.0.0.0:14540" className={FOCUS_RING + ' font-code'} style={connected ? DISABLED_INPUT : INPUT} />
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {MAV_PRESETS.map(p => {
                            const on = p.addr === address
                            return (
                                <button key={p.addr} type="button" disabled={connected} onClick={() => setAddress(p.addr)} title={p.addr}
                                    className={FOCUS_RING + ' transition-colors' + (on ? '' : ' hover:bg-app-surface-2')}
                                    style={{ minHeight: 30, padding: '0 10px', borderRadius: 999, cursor: connected ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
                                        border: `1px solid ${on ? 'var(--app-accent)' : T.border}`, background: on ? 'var(--app-accent-soft)' : 'transparent',
                                        color: on ? 'var(--app-selected-ink)' : T.muted }}>{p.label}</button>
                            )
                        })}
                    </div>
                </div>
                {/* Shown while connected too, read-only: the uplink host is the
                    one setting whose wrong value is invisible in operation
                    (telemetry looks perfect and commands vanish). */}
                {address === RF_BRIDGE_ADDR && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <label style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {label('Downlink port')}
                                <input type="number" min={1} max={65535} value={downlinkPort} disabled={connected}
                                    onChange={e => { const v = Number(e.target.value); setDownlinkPort(v); if (v > 0 && v < 65536) setRfDownlinkPort(v) }}
                                    className={FOCUS_RING} style={connected ? DISABLED_INPUT : INPUT} />
                            </label>
                            <label style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {label('Uplink port')}
                                <input type="number" min={1} max={65535} value={uplinkPort} disabled={connected}
                                    onChange={e => { const v = Number(e.target.value); setUplinkPort(v); if (v > 0 && v < 65536) setRfUplinkPort(v) }}
                                    className={FOCUS_RING} style={connected ? DISABLED_INPUT : INPUT} />
                            </label>
                        </div>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {label('Uplink host (where wfb_tx or the decoder runs)')}
                            <input value={uplinkHost} placeholder="127.0.0.1" disabled={connected}
                                onChange={e => { setUplinkHost(e.target.value); setRfUplinkHost(e.target.value) }}
                                className={FOCUS_RING + ' font-code'} style={connected ? DISABLED_INPUT : INPUT} />
                        </label>
                        <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                            Commands go to <b style={{ color: T.text }}>{uplinkHost}:{uplinkPort}</b>. Use 127.0.0.1 only if the RF decoder runs on
                            the server. With the decoder on its own board, telemetry still reads correctly while every command is lost.
                        </p>
                    </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {connected
                        ? <Btn kind="danger" onClick={() => getSocket().emit('disconnect_telemetry')}><WifiOff size={14} /> Disconnect</Btn>
                        : <Btn kind="primary" onClick={connect}><Wifi size={14} /> Connect to this address</Btn>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                    {[
                        { badge: 'PX4', text: 'MAVSDK over UDP. SITL default port 14540. A radio on the server: serial:///dev/ttyUSB0:57600' },
                        { badge: 'ArduPilot', text: 'MAVLink dialect. SITL default port 14550. Set TERRAIN_ENABLE=1 for terrain follow.' },
                        { badge: 'TCP', text: 'Companion computer bridge: tcp://192.168.x.x:5760.' },
                    ].map(p => (
                        <div key={p.badge} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <span style={{ padding: '1px 7px', borderRadius: 6, fontSize: 12, fontWeight: 700, background: T.surface2, border: `1px solid ${T.border}`, color: T.text, flexShrink: 0, marginTop: 1 }}>{p.badge}</span>
                            <p style={{ fontSize: 13, color: T.muted, lineHeight: 1.5, margin: 0 }}>{p.text}</p>
                        </div>
                    ))}
                </div>
            </div>
        </details>
    )
}

export function ConnectionSetup() {
    const { customer } = useLiveScope()
    const connected = useDroneStore(s => s.telemetryStatus) === 'connected'
    // The same option list the Fly card and the status bar read, so the link
    // is named the same everywhere.
    const { source, options, radios, nativeRadios } = useTelemetryLink()
    const linkLabel = source.startsWith('nradio-') ? nativeRadios[Number(source.slice(7))]?.label ?? 'USB radio'
        : source.startsWith('radio-') ? radios[Number(source.slice(6))]?.label ?? 'USB radio'
            : options.find(o => o.value === source)?.label ?? source

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={340}>
                <Panel title="Link" hint="the same choices as the Fly page">
                    <DeviceSelector />
                </Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                    <LinkHealth linkLabel={linkLabel} />
                    <LinkThroughput />
                    <Panel title="How the link works">
                        <LinkPath connected={connected} linkLabel={linkLabel} />
                        <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
                            HYRAK is the ground station and companion computer, in the cloud. The drone&apos;s MAVLink reaches it through this
                            device: a radio or flight controller plugged in here, or a simulator on this machine through the desktop app.
                            Commands go back the same way, so keep this tab or the app open while flying.
                        </p>
                    </Panel>
                </div>
            </Grid>
            {!customer && <CustomAddress />}
        </div>
    )
}

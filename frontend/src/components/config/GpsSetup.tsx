'use client'

// Config > GPS & RTK. QGroundControl's GPS settings and RTK corrections:
//  - live status of each receiver (fix, satellites, HDOP / VDOP, accuracy,
//    RTK float / fixed, dual-antenna heading) from the telemetry HYRAK
//    already has plus GPS_RAW_INT / GPS2_RAW read passively off the link;
//  - receiver setup (port, baud, protocol, constellations, u-blox model and
//    mode, second receiver) and how the estimator uses GPS (EKF2_GPS_CTRL,
//    the EKF2_GPS_CHECK pre-flight checks and their EKF2_REQ_* limits,
//    antenna position, heading offset);
//  - NTRIP: corrections from a caster, fetched by HYRAK's cloud and
//    forwarded down this session's link as GPS_RTCM_DATA (backend
//    app/telemetry/ntrip.py). The username and password go to the server for
//    this session only and are never stored in the browser.

import React, { useEffect, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Btn, Chip, Grid, Note, Panel, ParamRow, ParamSourceBar, Readout, ReloadButton, SubTabs, T, Tip, Toggle, FOCUS_RING, type ParamSpec, type Tone } from '@/components/config/kit'
import { BitmaskRow, SpecRows, WriteLog, useSetupLive, type GpsRaw } from '@/components/config/setupKit'

const FIX: Record<number, { label: string; tone: Tone }> = {
    0: { label: 'No GPS', tone: 'danger' }, 1: { label: 'No fix', tone: 'danger' }, 2: { label: '2D fix', tone: 'warn' },
    3: { label: '3D fix', tone: 'ok' }, 4: { label: 'DGPS', tone: 'ok' }, 5: { label: 'RTK float', tone: 'accent' },
    6: { label: 'RTK fixed', tone: 'ok' }, 7: { label: 'Static', tone: 'ok' }, 8: { label: 'PPP', tone: 'ok' },
}

// PX4 serial port numbers (the *_CONFIG parameters) and the matching baud parameter.
const PORTS: { value: number; label: string; baud?: string }[] = [
    { value: 0, label: 'Disabled' },
    { value: 201, label: 'GPS 1', baud: 'SER_GPS1_BAUD' }, { value: 202, label: 'GPS 2', baud: 'SER_GPS2_BAUD' },
    { value: 203, label: 'GPS 3', baud: 'SER_GPS3_BAUD' },
    { value: 101, label: 'TELEM 1', baud: 'SER_TEL1_BAUD' }, { value: 102, label: 'TELEM 2', baud: 'SER_TEL2_BAUD' },
    { value: 103, label: 'TELEM 3', baud: 'SER_TEL3_BAUD' }, { value: 104, label: 'TELEM / SERIAL 4', baud: 'SER_TEL4_BAUD' },
    { value: 6, label: 'UART 6', baud: 'SER_URT6_BAUD' }, { value: 300, label: 'Radio controller', baud: 'SER_RC_BAUD' },
    { value: 301, label: 'Wifi port', baud: 'SER_WIFI_BAUD' }, { value: 401, label: 'EXT 2', baud: 'SER_EXT2_BAUD' },
]
const BAUDS = [0, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => ({ value: b, label: b === 0 ? 'Auto' : `${b}` }))

const RECEIVER = (n: 1 | 2): ParamSpec[] => [
    { key: `GPS_${n}_PROTOCOL`, label: 'Protocol', tip: 'u-blox for most receivers. Auto detect probes every protocol and is slower to start. Needs a reboot.' },
]

const UBLOX: ParamSpec[] = [
    { key: 'GPS_UBX_DYNMODEL', label: 'Platform model', tip: 'How the u-blox receiver expects to move. Airborne < 2g suits most drones; choose < 4g for agile aircraft. Needs a reboot.' },
    { key: 'GPS_UBX_MODE', label: 'Receiver mode', tip: 'Default works for single receivers, RTK and dual GPS without heading. Heading and moving-base modes are for two F9P receivers giving GPS heading. Needs a reboot.' },
    { key: 'GPS_UBX_RATE', label: 'Output rate', tip: '0 lets PX4 choose for the receiver model. Needs a reboot.' },
    { key: 'GPS_UBX_MIN_CNO', label: 'Minimum signal strength' },
    { key: 'GPS_UBX_MIN_ELEV', label: 'Minimum satellite elevation' },
    { key: 'GPS_UBX_JAM_DET', label: 'Jamming detection' },
    { key: 'GPS_SAT_INFO', label: 'Send satellite details', tip: 'Per-satellite signal levels in the log. Costs some link and CPU.' },
]

const ESTIMATOR: ParamSpec[] = [
    { key: 'EKF2_REQ_FIX', label: 'Fix needed' },
    { key: 'EKF2_REQ_NSATS', label: 'Satellites needed' },
    { key: 'EKF2_REQ_PDOP', label: 'Max PDOP' },
    { key: 'EKF2_REQ_EPH', label: 'Max horizontal error' },
    { key: 'EKF2_REQ_EPV', label: 'Max vertical error' },
    { key: 'EKF2_REQ_SACC', label: 'Max speed error' },
    { key: 'EKF2_REQ_HDRIFT', label: 'Max horizontal drift' },
    { key: 'EKF2_REQ_VDRIFT', label: 'Max vertical drift' },
    { key: 'EKF2_REQ_GPS_H', label: 'Healthy for at least' },
    { key: 'EKF2_GPS_DELAY', label: 'Receiver delay', tip: 'Time from measurement to arrival. Leave at the default unless the receiver documents another value.' },
    { key: 'COM_ARM_WO_GPS', label: 'Arming without GPS' },
]

const ANTENNA: ParamSpec[] = [
    { key: 'EKF2_GPS_POS_X', label: 'Antenna forward of centre', unit: 'm', decimals: 3 },
    { key: 'EKF2_GPS_POS_Y', label: 'Antenna right of centre', unit: 'm', decimals: 3 },
    { key: 'EKF2_GPS_POS_Z', label: 'Antenna below centre', unit: 'm', decimals: 3 },
]

const HEADING: ParamSpec[] = [
    { key: 'GPS_YAW_OFFSET', label: 'Antenna heading offset', tip: '0 when the two antennas lie along the nose, rover antenna in front. 90 when the rover antenna is on the right. Increases clockwise. Needs a reboot.' },
    { key: 'EKF2_GPS_YAW_OFF', label: 'Estimator heading offset' },
]

type Tab = 'status' | 'receivers' | 'estimator' | 'ntrip'

export function GpsSetup() {
    const [tab, setTab] = useState<Tab>('status')
    const live = useSetupLive()
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="GPS settings" /></div>
                <ReloadButton />
            </div>
            <SubTabs label="GPS and RTK" value={tab} onChange={setTab} tabs={[
                { id: 'status', label: 'Status' },
                { id: 'receivers', label: 'Receivers' },
                { id: 'estimator', label: 'Checks and antenna' },
                { id: 'ntrip', label: 'RTK corrections' },
            ]} />
            {tab === 'status' && <StatusTab live={live.data} at={live.at} />}
            {tab === 'receivers' && <ReceiversTab />}
            {tab === 'estimator' && (
                <Grid min={360}>
                    <Panel title="Pre-flight GPS checks" hint="what the estimator needs before it trusts GPS">
                        <BitmaskRow k="EKF2_GPS_CHECK" label="Checks that must pass" />
                    </Panel>
                    <Panel title="Limits for those checks"><SpecRows specs={ESTIMATOR} compact /></Panel>
                    <Panel title="What GPS is used for">
                        <BitmaskRow k="EKF2_GPS_CTRL" label="Fuse into the estimate" bits={[[0, 'Latitude and longitude'], [1, 'Altitude'], [2, '3D velocity'], [3, 'Dual antenna heading']]} />
                        <SpecRows specs={[{ key: 'EKF2_GPS_MODE', label: 'After a GPS outage' }]} compact />
                    </Panel>
                    <Panel title="Antenna position" hint="from the centre of gravity"><SpecRows specs={ANTENNA} compact /></Panel>
                    <Panel title="RTK heading" hint="two antennas, moving base"><SpecRows specs={HEADING} compact empty={<p style={{ margin: 0, fontSize: 13, color: T.muted }}>This firmware has no dual-antenna heading.</p>} /></Panel>
                </Grid>
            )}
            {tab === 'ntrip' && <NtripPanel />}
            <WriteLog />
        </div>
    )
}

// ── Status ──────────────────────────────────────────────────────────────────

const dop = (v?: number) => v == null || v >= 65535 ? null : v / 100
const mm = (v?: number) => v == null || v <= 0 || v >= 4294967295 ? null : v / 1000

function StatusTab({ live, at }: { live: ReturnType<typeof useSetupLive>['data']; at: number }) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const gps = useDroneStore(s => s.telemetry?.gps)
    if (!connected) return <Note>Connect a drone to see its GPS. The settings on the other tabs show PX4 defaults until then.</Note>
    const r1 = live.GPS_RAW_INT
    const r2 = live.GPS2_RAW
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={320}>
                <ReceiverCard title="Main receiver" raw={r1} fallback={gps ? { fix_type: gps.fix_type, satellites_visible: gps.satellites_visible } : undefined} waiting={!at} />
                {r2 ? <ReceiverCard title="Second receiver" raw={r2} /> : (
                    <Panel title="Second receiver"><p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        None reporting. A second receiver shows here once it is set up (Receivers tab) and PX4 sends GPS2_RAW.</p></Panel>
                )}
            </Grid>
            {(live.GPS_RTK || live.GPS2_RTK) && <RtkCard rtk={(live.GPS_RTK ?? live.GPS2_RTK)!} />}
        </div>
    )
}

function ReceiverCard({ title, raw, fallback, waiting }: { title: string; raw?: GpsRaw & { age?: number }; fallback?: GpsRaw; waiting?: boolean }) {
    const g = raw ?? fallback
    const fix = g?.fix_type ?? 0
    const f = FIX[fix] ?? { label: `Fix ${fix}`, tone: 'off' as Tone }
    const sats = g?.satellites_visible
    const hdop = dop(raw?.eph), vdop = dop(raw?.epv)
    const hacc = mm(raw?.h_acc), vacc = mm(raw?.v_acc)
    const yaw = raw?.yaw && raw.yaw !== 65535 ? (raw.yaw === 36000 ? 0 : raw.yaw / 100) : null
    const stale = raw?.age != null && raw.age > 3
    return (
        <Panel title={title} right={<Chip tone={stale ? 'warn' : f.tone}>{stale ? `No update for ${Math.round(raw!.age!)} s` : f.label}</Chip>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 16 }}>
                <Readout label="Satellites" value={sats == null || sats === 255 ? '-' : sats} tone={sats != null && sats < 6 ? 'warn' : undefined} />
                <Readout label="HDOP" value={hdop == null ? '-' : hdop.toFixed(2)} tone={hdop != null && hdop > 2 ? 'warn' : undefined} />
                <Readout label="VDOP" value={vdop == null ? '-' : vdop.toFixed(2)} />
                <Readout label="Horizontal accuracy" value={hacc == null ? '-' : hacc < 1 ? (hacc * 100).toFixed(0) : hacc.toFixed(1)} unit={hacc == null ? undefined : hacc < 1 ? 'cm' : 'm'} />
                <Readout label="Vertical accuracy" value={vacc == null ? '-' : vacc < 1 ? (vacc * 100).toFixed(0) : vacc.toFixed(1)} unit={vacc == null ? undefined : vacc < 1 ? 'cm' : 'm'} />
                {yaw != null && <Readout label="GPS heading" value={yaw.toFixed(1)} unit="°" />}
                {raw?.dgps_numch != null && raw.dgps_numch > 0 && <Readout label="Correction stations" value={raw.dgps_numch} />}
            </div>
            {!raw && waiting && <p style={{ margin: 0, fontSize: 12, color: T.muted }}>Fix and satellites from telemetry; reading HDOP and accuracy from the link.</p>}
            {fix === 5 && <Note>RTK float: corrections are arriving and the receiver is resolving them. Fixed usually follows within a minute under open sky.</Note>}
            {fix === 6 && <Note tone="ok">RTK fixed: centimetre-level position.</Note>}
        </Panel>
    )
}

function RtkCard({ rtk }: { rtk: NonNullable<ReturnType<typeof useSetupLive>['data']['GPS_RTK']> }) {
    const base = [rtk.baseline_a_mm, rtk.baseline_b_mm, rtk.baseline_c_mm].map(v => (v ?? 0) / 1000)
    const dist = Math.hypot(...base)
    return (
        <Panel title="RTK baseline" hint="distance to the base station or moving base">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 16 }}>
                <Readout label="Baseline" value={dist < 1000 ? dist.toFixed(2) : (dist / 1000).toFixed(2)} unit={dist < 1000 ? 'm' : 'km'} />
                <Readout label="Satellites used" value={rtk.nsats ?? '-'} />
                <Readout label="Correction rate" value={rtk.rtk_rate ?? '-'} unit="Hz" />
                <Readout label="Ambiguity hypotheses" value={rtk.iar_num_hypotheses ?? '-'} />
            </div>
        </Panel>
    )
}

// ── Receivers ───────────────────────────────────────────────────────────────

function PortRows({ n }: { n: 1 | 2 }) {
    const vp = useVehicleParams()
    const cfgKey = `GPS_${n}_CONFIG`
    const port = vp.get(cfgKey) ?? (vp.ready ? null : n === 1 ? 201 : 0)
    const baud = PORTS.find(p => p.value === port)?.baud
    return (
        <>
            {(!vp.ready || vp.has(cfgKey)) && <ParamRow spec={{ key: cfgKey, label: 'Serial port', def: n === 1 ? 201 : 0, options: PORTS.map(p => ({ value: p.value, label: p.label })), tip: 'Which flight controller port the receiver is plugged into. Needs a reboot.' }} />}
            {baud && (!vp.ready || vp.has(baud)) && <ParamRow spec={{ key: baud, label: 'Baud rate', def: 0, options: BAUDS, tip: 'Auto lets PX4 find the receiver\'s speed. Needs a reboot.' }} />}
        </>
    )
}

function ReceiversTab() {
    const vp = useVehicleParams()
    const second = !vp.ready || (vp.get('GPS_2_CONFIG') ?? 0) !== 0
    return (
        <Grid min={360}>
            <Panel title="Main receiver">
                <PortRows n={1} />
                <SpecRows specs={RECEIVER(1)} />
                <BitmaskRow k="GPS_1_GNSS" label="Satellite systems" tip="Constellations the receiver uses. None selected = the receiver's own default. u-blox only. Needs a reboot." />
            </Panel>
            <Panel title="Second receiver" hint="for redundancy or GPS heading">
                <PortRows n={2} />
                {second ? <>
                    <SpecRows specs={RECEIVER(2)} />
                    <BitmaskRow k="GPS_2_GNSS" label="Satellite systems" />
                </> : <p style={{ margin: 0, fontSize: 13, color: T.muted }}>Pick its serial port to set it up.</p>}
                <SpecRows specs={[{ key: 'SENS_GPS_MASK', label: 'Blend the two receivers' }, { key: 'SENS_GPS_PRIME', label: 'Preferred receiver' }]} compact empty={null} />
            </Panel>
            <Panel title="u-blox receiver"><SpecRows specs={UBLOX} compact /></Panel>
            <Note>Port, protocol and receiver settings take effect after the flight controller reboots (Vehicle, Reboot).</Note>
        </Grid>
    )
}

// ── NTRIP ───────────────────────────────────────────────────────────────────

interface NtripState {
    state: 'idle' | 'connecting' | 'connected' | 'retrying' | 'stopped' | 'error'
    error?: string; host?: string; port?: number; mountpoint?: string
    bytes_in?: number; frames?: number; messages_sent?: number; dropped?: number; bad_crc?: number
    types?: Record<string, number>; last_data_age_s?: number | null; connected_s?: number | null; attempts?: number
}

const SAVED_KEY = 'hyrak-ntrip-caster'
const RTCM_NAME: Record<string, string> = {
    '1005': 'Base position', '1006': 'Base position', '1033': 'Receiver info', '1230': 'GLONASS biases',
    '1074': 'GPS', '1075': 'GPS', '1077': 'GPS', '1084': 'GLONASS', '1085': 'GLONASS', '1087': 'GLONASS',
    '1094': 'Galileo', '1095': 'Galileo', '1097': 'Galileo', '1124': 'BeiDou', '1125': 'BeiDou', '1127': 'BeiDou',
}

function NtripPanel() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const [st, setSt] = useState<NtripState>({ state: 'idle' })
    // Caster address only is remembered in this browser; never the username or password.
    const [form, setForm] = useState(() => {
        let saved: { host?: string; port?: number; mountpoint?: string; tls?: boolean; send_gga?: boolean } = {}
        try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') } catch { /* private window */ }
        return { host: saved.host ?? '', port: String(saved.port ?? 2101), mountpoint: saved.mountpoint ?? '', username: '', password: '', tls: !!saved.tls, send_gga: !!saved.send_gga }
    })
    const [err, setErr] = useState<string | null>(null)

    useEffect(() => {
        const socket = getSocket()
        const on = (d: NtripState) => setSt(d)
        socket.on('ntrip_state', on)
        socket.emit('ntrip_status')
        return () => { socket.off('ntrip_state', on) }
    }, [])

    const running = st.state === 'connecting' || st.state === 'connected' || st.state === 'retrying'
    const start = () => {
        const port = Number(form.port)
        if (!form.host.trim()) return setErr('Enter the caster host')
        if (!Number.isInteger(port) || port < 1 || port > 65535) return setErr('The port must be between 1 and 65535')
        if (!form.mountpoint.trim()) return setErr('Enter the mountpoint')
        setErr(null)
        try { localStorage.setItem(SAVED_KEY, JSON.stringify({ host: form.host.trim(), port, mountpoint: form.mountpoint.trim(), tls: form.tls, send_gga: form.send_gga })) } catch { /* fine */ }
        setSt({ state: 'connecting' })
        getSocket().emit('ntrip_start', { host: form.host.trim(), port, mountpoint: form.mountpoint.trim(), username: form.username, password: form.password, tls: form.tls, send_gga: form.send_gga })
        setForm(f => ({ ...f, password: '' }))
    }
    const stop = () => getSocket().emit('ntrip_stop')

    const tone: Tone = st.state === 'connected' ? ((st.last_data_age_s ?? 0) > 5 ? 'warn' : 'ok') : st.state === 'error' ? 'danger' : st.state === 'retrying' ? 'warn' : running ? 'accent' : 'off'
    const words = { idle: 'Off', stopped: 'Stopped', connecting: 'Connecting', connected: 'Receiving', retrying: 'Reconnecting', error: 'Failed' }[st.state] ?? st.state
    const field = (k: 'host' | 'port' | 'mountpoint' | 'username' | 'password', label: string, opts: { type?: string; placeholder?: string; mode?: 'numeric'; width?: number } = {}) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: `1 1 ${opts.width ?? 200}px`, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>{label}</span>
            <input value={form[k]} type={opts.type ?? 'text'} inputMode={opts.mode} placeholder={opts.placeholder} disabled={running}
                autoComplete={k === 'password' ? 'new-password' : 'off'} spellCheck={false}
                onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                className={FOCUS_RING}
                style={{ height: 36, padding: '0 10px', borderRadius: 6, border: `1px solid ${T.borderStrong}`, background: running ? T.surface2 : T.surface, color: T.text, fontSize: 14, minWidth: 0, outline: 'none' }} />
        </label>
    )
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Grid min={360}>
                <Panel title="NTRIP caster" hint="RTK corrections over the internet"
                    right={<Tip text="HYRAK's cloud connects to the caster and forwards its RTCM corrections to the drone's GPS over this session's link, the way QGroundControl does from a laptop. The username and password are sent to the server for this session only, kept in memory while corrections run, and never stored or logged." />}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {field('host', 'Caster host', { placeholder: 'rtk2go.com', width: 220 })}
                        {field('port', 'Port', { mode: 'numeric', width: 90 })}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {field('mountpoint', 'Mountpoint', { width: 200 })}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {field('username', 'Username', { width: 160 })}
                        {field('password', 'Password', { type: 'password', width: 160 })}
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: T.text, minHeight: 34 }}>
                        <Toggle label="Send the drone's position to the caster" value={form.send_gga} disabled={running} onChange={v => setForm(f => ({ ...f, send_gga: v }))} />
                        Send the drone&apos;s position (needed for network / VRS mountpoints)
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: T.text, minHeight: 34 }}>
                        <Toggle label="Use TLS" value={form.tls} disabled={running} onChange={v => setForm(f => ({ ...f, tls: v }))} />
                        Encrypted connection (TLS), only if the caster asks for it
                    </label>
                    {err && <p role="alert" style={{ margin: 0, fontSize: 13, color: T.danger }}>{err}</p>}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {running
                            ? <Btn kind="danger" onClick={stop}><Square size={14} aria-hidden />Stop corrections</Btn>
                            : <Btn kind="primary" onClick={start} disabled={!connected} title={connected ? undefined : 'Connect a drone first'}><Play size={14} aria-hidden />Start corrections</Btn>}
                        {!connected && <span style={{ fontSize: 13, color: T.muted }}>Needs a connected drone.</span>}
                    </div>
                </Panel>
                <Panel title="Corrections" right={<Chip tone={tone}>{words}</Chip>}>
                    {st.error && <Note tone={st.state === 'error' ? 'danger' : 'warn'}>{st.error}</Note>}
                    {st.host && <p style={{ margin: 0, fontSize: 13, color: T.muted }} className="font-code">{st.host}:{st.port}/{st.mountpoint}</p>}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 16 }}>
                        <Readout label="Received" value={((st.bytes_in ?? 0) / 1024).toFixed(1)} unit="kB" />
                        <Readout label="RTCM messages" value={st.frames ?? 0} />
                        <Readout label="Sent to the drone" value={st.messages_sent ?? 0} unit="packets" />
                        <Readout label="Last data" value={st.last_data_age_s == null ? '-' : st.last_data_age_s.toFixed(0)} unit={st.last_data_age_s == null ? undefined : 's ago'}
                            tone={(st.last_data_age_s ?? 0) > 5 ? 'warn' : undefined} />
                    </div>
                    {(st.dropped ?? 0) > 0 && <p style={{ margin: 0, fontSize: 13, color: T.warn }}>{st.dropped} message{st.dropped === 1 ? '' : 's'} too long for MAVLink (over 720 bytes) were skipped.</p>}
                    {st.types && Object.keys(st.types).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {Object.entries(st.types).map(([t, n]) => <Chip key={t} tone="off">{t}{RTCM_NAME[t] ? ` ${RTCM_NAME[t]}` : ''}: {n}</Chip>)}
                        </div>
                    )}
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Watch the fix on the Status tab: RTK float, then RTK fixed, under open sky. Corrections stop when you press Stop, the link drops, or this session ends.
                    </p>
                </Panel>
            </Grid>
            <Note>A base station plugged into this computer (QGroundControl&apos;s survey-in) is not supported from the browser. Feed your own base to a caster (RTK2go or your own NTRIP caster) and use it here.</Note>
        </div>
    )
}

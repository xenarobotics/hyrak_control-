'use client'

// Config > Radio & RC: QGroundControl's Radio and Flight Modes pages in
// HYRAK's shape. Everything the transmitter does to the aircraft is decided
// by PX4 parameters, and every control here reads and writes THOSE through
// the shared parameter copy (lib/vehicleParams.ts).
//
// LIVE CHANNELS, FOR EVERYONE. The session's own link is read passively for
// RC_CHANNELS (lib/configLive.ts), which works on every link type a customer
// can use, serial included. The older server-wide RC monitor on udp/14550 is
// kept as a fallback for staff only: it binds one shared server port and sees
// whichever aircraft streams to it (docs/ACCESS_MODEL.md 8a), so it stays
// staff-only.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAccess } from '@/hooks/useAccess'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { Check, SlidersHorizontal, ToggleRight } from 'lucide-react'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Btn, Chip, Dialog, NumberBox, Note, Panel, ParamRow, ParamSourceBar, SubTabs, T, Tip, mix } from '@/components/config/kit'
import { SpektrumBind } from '@/components/config/SpektrumBind'
import { RadioChannels } from '@/components/config/RadioChannels'
import { useVehicleParams, writeParam, writeParams } from '@/lib/vehicleParams'
import { rcChannels, useConfigLive } from '@/lib/configLive'

function ls<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
    try { if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(val)) } catch { /* storage blocked */ }
}

/** Diagram text at a fixed reading size whatever the SVG's rendered width. */
function useSvgPx(viewBoxWidth: number) {
    const ref = useRef<SVGSVGElement>(null)
    const [scale, setScale] = useState(1)
    useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width ?? 0
            if (w > 0) setScale(w / viewBoxWidth)
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [viewBoxWidth])
    const px = useCallback((size: number) => Math.min(16, Math.max(12, size)) / scale, [scale])
    return [ref, px] as const
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** COM_FLTMODE1..6 values, PX4's commander mode slots. */
const FLTMODE_OPTS: { v: number; l: string }[] = [
    { v: -1, l: 'Unassigned' },
    { v: 0, l: 'Manual' }, { v: 8, l: 'Stabilized' }, { v: 6, l: 'Acro' },
    { v: 1, l: 'Altitude' }, { v: 2, l: 'Position' },
    { v: 3, l: 'Mission' }, { v: 4, l: 'Hold' }, { v: 5, l: 'Return' },
    { v: 7, l: 'Offboard' }, { v: 10, l: 'Takeoff' }, { v: 11, l: 'Land' },
    { v: 12, l: 'Follow Me' }, { v: 14, l: 'Orbit' },
]

/** Switch channel and its threshold. PX4: threshold > 0 means ON above it,
 *  < 0 means ON below its magnitude, on the channel's calibrated 0..1 range. */
const SWITCHES = [
    { key: 'RC_MAP_KILL_SW', th: 'RC_KILLSWITCH_TH', label: 'Kill switch', tip: 'Stops the motors at once, even in the air. Assign this: it is the hardware answer to a flyaway.' },
    { key: 'RC_MAP_RETURN_SW', th: 'RC_RETURN_TH', label: 'Return switch', tip: 'Flies home (Return mode).' },
    { key: 'RC_MAP_ARM_SW', th: 'RC_ARMSWITCH_TH', label: 'Arm switch', tip: 'Arms and disarms on a switch instead of the stick gesture.' },
    { key: 'RC_MAP_OFFB_SW', th: 'RC_OFFB_TH', label: 'Offboard switch', tip: 'Hands control to HYRAK (Offboard) and takes it back.' },
    { key: 'RC_MAP_LOITER_SW', th: 'RC_LOITER_TH', label: 'Hold switch', tip: 'Parks the drone where it is.' },
    { key: 'RC_MAP_GEAR_SW', th: 'RC_GEAR_TH', label: 'Landing gear switch', tip: 'Raises and lowers retractable gear.' },
    { key: 'RC_MAP_ENG_MOT', th: 'RC_ENG_MOT_TH', label: 'Engine switch', tip: 'Engine motor control, for fuel engines.' },
] as const

const CH_OPTS = [{ value: 0, label: 'Unassigned' }, ...Array.from({ length: 18 }, (_, i) => ({ value: i + 1, label: `CH${i + 1}` }))]

/** Which physical stick carries which axis, per transmitter mode. */
const STICK_LAYOUT: Record<string, { left: { x: string; y: string }; right: { x: string; y: string } }> = {
    '1': { left: { x: 'yaw', y: 'pitch' }, right: { x: 'roll', y: 'throttle' } },
    '2': { left: { x: 'yaw', y: 'throttle' }, right: { x: 'roll', y: 'pitch' } },
    '3': { left: { x: 'roll', y: 'pitch' }, right: { x: 'yaw', y: 'throttle' } },
    '4': { left: { x: 'roll', y: 'throttle' }, right: { x: 'yaw', y: 'pitch' } },
}
const MODE_HINT: Record<string, string> = {
    '1': 'Throttle on the right', '2': 'Throttle on the left', '3': 'Throttle right, roll left', '4': 'Throttle and roll left',
}
const AXIS_SHORT: Record<string, string> = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw', throttle: 'Throttle' }
const AXIS_KEY: Record<string, string> = { roll: 'RC_MAP_ROLL', pitch: 'RC_MAP_PITCH', yaw: 'RC_MAP_YAW', throttle: 'RC_MAP_THROTTLE' }

/** Which mode slots a physical switch can reach. PX4 splits the channel into
 *  six equal bands; a 3-position switch lands in 1, 4 and 6. */
const SWITCH_REACH: Record<string, Record<number, string>> = {
    '2': { 1: 'Low', 6: 'High' },
    '3': { 1: 'Low', 4: 'Mid', 6: 'High' },
    '6': { 1: 'Pos 1', 2: 'Pos 2', 3: 'Pos 3', 4: 'Pos 4', 5: 'Pos 5', 6: 'Pos 6' },
}

/** Which slot a channel value selects: PX4's six-band split. */
function slotForValue(v: number): number {
    if (v <= 0) return 0
    const frac = Math.max(0, Math.min(1, (v - 1000) / 1000))
    return Math.min(Math.floor(frac * 6) + 1, 6)
}

// ── Live channels ───────────────────────────────────────────────────────────

/** Live channel values: the session's own link first, the staff RC monitor
 *  as a fallback. `source` names which one, for the honest note. */
function useLiveChannels() {
    const { data, at } = useConfigLive(true)
    const own = rcChannels(data.RC_CHANNELS)
    const ownFresh = own.length > 0 && (data.RC_CHANNELS?.age ?? 99) < 3
    const { isStaff } = useAccess()

    const [mon, setMon] = useState<{ channels: number[]; at: number }>({ channels: [], at: 0 })
    const [monStatus, setMonStatus] = useState<{ listening: boolean; port: number } | null>(null)
    const [now, setNow] = useState(0)
    // The server-wide monitor only when the session's own link has no RC.
    const wantMonitor = isStaff && !ownFresh
    useEffect(() => {
        if (!wantMonitor) return
        const socket = getSocket()
        const onChans = (p: { channels: number[] }) => setMon({ channels: p.channels, at: Date.now() })
        const onStatus = (st: { listening: boolean; port: number }) => setMonStatus(st)
        socket.on('rc_channels', onChans)
        socket.on('rc_monitor_status', onStatus)
        socket.emit('start_rc_monitor')
        return () => { socket.off('rc_channels', onChans); socket.off('rc_monitor_status', onStatus) }
    }, [wantMonitor])
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [])
    const monFresh = wantMonitor && mon.at > 0 && now - mon.at < 3000 && mon.channels.length > 0
    const channels = ownFresh ? own : monFresh ? mon.channels : []
    return {
        channels, live: channels.length > 0,
        source: ownFresh ? 'link' as const : monFresh ? 'monitor' as const : null,
        rssi: ownFresh ? data.RC_CHANNELS?.rssi ?? null : null,
        feedUp: at > 0, monStatus, isStaff,
    }
}
type Live = ReturnType<typeof useLiveChannels>

// ── Page ────────────────────────────────────────────────────────────────────

type Tab = 'transmitter' | 'modes' | 'channels'

export function RadioSetup() {
    const [tab, setTab] = useState<Tab>('transmitter')
    const live = useLiveChannels()
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SubTabs<Tab> label="Radio setup" value={tab} onChange={setTab} tabs={[
                { id: 'transmitter', label: 'Transmitter' },
                { id: 'modes', label: 'Flight modes and switches' },
                { id: 'channels', label: 'Channels' },
            ]} />
            <ParamSourceBar what="the radio setup" />
            <div role="tabpanel">
                {tab === 'transmitter' && <TransmitterTab live={live} />}
                {tab === 'modes' && <ModesTab live={live} />}
                {tab === 'channels' && <ChannelsTab live={live} />}
            </div>
        </div>
    )
}

/** The one honest line about where live channels come from. */
function LiveSourceNote({ live }: { live: Live }) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const rc = useDroneStore(s => s.telemetry?.rc)
    if (!connected) return <Note>Connect a drone to see your sticks move here and to calibrate them.</Note>
    if (live.source) return null
    if (rc && !rc.available) return <Note tone="warn">The drone reports no RC receiver signal. Turn the transmitter on and check it is bound.</Note>
    return (
        <Note>
            Waiting for live channel data from the drone.
            {!live.feedUp && ' If nothing arrives, the HYRAK server needs a restart to pick up live readings.'}
            {live.isStaff && live.monStatus && !live.monStatus.listening && ' The staff RC monitor could not open its port either.'}
        </Note>
    )
}

// ── Transmitter tab: stick drawing, channel monitor, calibration ────────────

type Target = { axis: string; dir: 1 | -1 }
const WIZ_STEPS: { id: string; title: string; text: string; target?: Target }[] = [
    { id: 'center', title: 'Centre the sticks', text: 'Let both sticks spring to centre and pull the throttle all the way down. Set every switch to its normal position.' },
    { id: 'thr-up', title: 'Throttle up', text: 'Push the throttle all the way up and hold it there.', target: { axis: 'throttle', dir: 1 } },
    { id: 'thr-down', title: 'Throttle down', text: 'Pull the throttle all the way down.', target: { axis: 'throttle', dir: -1 } },
    { id: 'yaw-right', title: 'Yaw right', text: 'Push the yaw stick all the way right.', target: { axis: 'yaw', dir: 1 } },
    { id: 'yaw-left', title: 'Yaw left', text: 'Push the yaw stick all the way left.', target: { axis: 'yaw', dir: -1 } },
    { id: 'roll-right', title: 'Roll right', text: 'Push the roll stick all the way right.', target: { axis: 'roll', dir: 1 } },
    { id: 'roll-left', title: 'Roll left', text: 'Push the roll stick all the way left.', target: { axis: 'roll', dir: -1 } },
    { id: 'pitch-up', title: 'Pitch forward', text: 'Push the pitch stick all the way forward (away from you).', target: { axis: 'pitch', dir: 1 } },
    { id: 'pitch-down', title: 'Pitch back', text: 'Pull the pitch stick all the way back.', target: { axis: 'pitch', dir: -1 } },
    { id: 'switches', title: 'Switches and dials', text: 'Flip every switch through all its positions and turn every dial end to end.' },
    { id: 'finish', title: 'Centre and finish', text: 'Centre both sticks and pull the throttle down. This position becomes the trim.' },
]

type Wiz = { phase: 'idle' } | { phase: 'capture'; step: number } | { phase: 'review' } | { phase: 'writing'; at: number; of: number } | { phase: 'done' }

function TransmitterTab({ live }: { live: Live }) {
    const vp = useVehicleParams()
    const telemetry = useDroneStore(s => s.telemetry)
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = telemetry?.flight_mode?.is_armed ?? false
    const [mode, setMode] = useState<string>(() => ls('hyrak-rc-visual-mode', '2'))
    const layout = STICK_LAYOUT[mode] ?? STICK_LAYOUT['2']
    const { channels } = live

    const chOf = (axis: string) => vp.get(AXIS_KEY[axis]) ?? 0
    const axisValue = (axis: string): number => {
        const ch = chOf(axis)
        if (!live.live || ch < 1 || ch > channels.length) return axis === 'throttle' ? -1 : 0
        const raw = channels[ch - 1]
        if (raw <= 0) return 0
        const min = vp.get(`RC${ch}_MIN`) ?? 1000, max = vp.get(`RC${ch}_MAX`) ?? 2000, trim = vp.get(`RC${ch}_TRIM`) ?? 1500
        const rev = (vp.get(`RC${ch}_REV`) ?? 1) < 0 ? -1 : 1
        const v = axis === 'throttle' ? ((raw - min) / Math.max(1, max - min)) * 2 - 1
            : raw >= trim ? (raw - trim) / Math.max(1, max - trim) : (raw - trim) / Math.max(1, trim - min)
        return Math.max(-1, Math.min(1, v * rev))
    }

    // ── Calibration wizard ──
    const [wiz, setWiz] = useState<Wiz>({ phase: 'idle' })
    const ranges = useRef<{ min: number; max: number }[]>([])
    const [captured, setCaptured] = useState<{ min: number; max: number }[]>([])
    const [trims, setTrims] = useState<number[]>([])
    const [reached, setReached] = useState<Record<string, boolean>>({})

    useEffect(() => {
        if (wiz.phase !== 'capture' || !live.live) return
        const r = ranges.current
        channels.forEach((v, i) => {
            if (v <= 0) return
            if (!r[i]) r[i] = { min: v, max: v }
            else { r[i].min = Math.min(r[i].min, v); r[i].max = Math.max(r[i].max, v) }
        })
    }, [channels, wiz, live.live])

    // A stick step is reached when the mapped channel has moved far from its
    // centre in either direction (a reversed channel moves the other way).
    const step = wiz.phase === 'capture' ? WIZ_STEPS[wiz.step] : null
    const stepCh = step?.target ? chOf(step.target.axis) : 0
    const stepRaw = stepCh > 0 ? channels[stepCh - 1] ?? 0 : 0
    const stepHit = !!step?.target && stepRaw > 0 && (step.target.axis === 'throttle'
        ? (step.target.dir > 0 ? stepRaw > 1800 : stepRaw < 1200)
        : Math.abs(stepRaw - 1500) > 300)
    if (step && stepHit && !reached[step.id]) setReached(r => ({ ...r, [step.id]: true }))

    const begin = () => {
        ranges.current = []; setCaptured([]); setTrims([]); setReached({})
        setWiz({ phase: 'capture', step: 0 })
    }
    const nextStep = () => {
        if (wiz.phase !== 'capture') return
        if (wiz.step + 1 < WIZ_STEPS.length) { setWiz({ phase: 'capture', step: wiz.step + 1 }); return }
        setTrims([...channels])
        setCaptured(ranges.current.map(r => r && { ...r }))
        setWiz({ phase: 'review' })
    }
    const rows = captured
        .map((r, i) => r ? {
            ch: i + 1, min: r.min, max: r.max,
            trim: Math.max(r.min, Math.min(r.max, trims[i] ?? Math.round((r.min + r.max) / 2))),
            moved: r.max - r.min >= 300,
        } : null)
        .filter((x): x is NonNullable<typeof x> => x !== null && x.moved)
    const write = async () => {
        const entries: [string, number][] = rows.flatMap(r => [[`RC${r.ch}_MIN`, r.min], [`RC${r.ch}_TRIM`, r.trim], [`RC${r.ch}_MAX`, r.max]] as [string, number][])
        setWiz({ phase: 'writing', at: 0, of: entries.length })
        for (let i = 0; i < entries.length; i++) {
            writeParam(entries[i][0], entries[i][1])
            setWiz({ phase: 'writing', at: i + 1, of: entries.length })
            await new Promise(res => setTimeout(res, 150))
        }
        setWiz({ phase: 'done' })
    }

    const ghost = step?.target ? targetFor(layout, step.target) : null
    const canStart = live.live && !armed && vp.ready

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                <Panel title="Transmitter" hint={live.live ? undefined : 'not live'}
                    right={live.live ? <Chip tone="ok">Live{live.source === 'monitor' ? ' (staff monitor)' : ''}</Chip> : undefined}>
                    <ModePicker mode={mode} onPick={m => { setMode(m); lsSet('hyrak-rc-visual-mode', m) }} />
                    <TransmitterSvg layout={layout} axisValue={axisValue} live={live.live} ghost={ghost}
                        modeChannel={vp.get('RC_MAP_FLTMODE') ?? 0}
                        modeValue={(() => { const c = vp.get('RC_MAP_FLTMODE') ?? 0; return live.live && c > 0 ? channels[c - 1] ?? 0 : 0 })()}
                        flightMode={connected ? telemetry?.flight_mode?.mode ?? '' : 'NO LINK'} />
                    <LiveSourceNote live={live} />
                </Panel>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <Panel title="Stick calibration" hint={wiz.phase === 'capture' ? `step ${wiz.step + 1} of ${WIZ_STEPS.length}` : undefined}
                right={<Tip text="Teaches PX4 each channel's real end points and centre (RCn_MIN / TRIM / MAX). Channels that move less than 300 µs during the capture are left untouched." />}
                style={wiz.phase === 'capture' ? { borderColor: mix('var(--app-warn)', 45) } : undefined}>
                {wiz.phase === 'idle' && (
                    <>
                        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, color: T.text }}>
                            <li>Pick your transmitter mode on the left so the drawing matches your sticks.</li>
                            <li>Take the propellers off or keep the drone disarmed.</li>
                            <li>Follow {WIZ_STEPS.length} short steps: each stick to its ends, then every switch.</li>
                            <li>Check the result and write it to the drone.</li>
                        </ol>
                        {!connected ? <Note>Connect a drone first.</Note>
                            : armed ? <Note tone="warn">Disarm the drone before calibrating.</Note>
                            : !live.live ? <Note>Needs live channel data. Turn the transmitter on.</Note> : null}
                        <div><Btn kind="primary" onClick={begin} disabled={!canStart}><SlidersHorizontal size={15} /> Start calibration</Btn></div>
                    </>
                )}
                {wiz.phase === 'capture' && step && (
                    <>
                        <StepDots at={wiz.step} reached={reached} />
                        <div>
                            <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: T.text }}>{step.title}</p>
                            <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5, color: T.muted }}>{step.text}</p>
                        </div>
                        {step.target && (
                            stepCh > 0
                                ? <Note tone={reached[step.id] ? 'ok' : 'off'} icon={reached[step.id] ? <Check size={15} style={{ color: T.ok, flexShrink: 0, marginTop: 2 }} /> : undefined}>
                                    {reached[step.id] ? 'Got it. Press Next.' : `Watching CH${stepCh} (${AXIS_SHORT[step.target.axis]}): ${stepRaw || '-'} µs. The ghost stick on the drawing shows where to go.`}
                                </Note>
                                : <Note tone="warn">{AXIS_SHORT[step.target.axis]} has no channel assigned (Channels tab). Move it anyway; its range is still recorded.</Note>
                        )}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Btn kind="primary" onClick={nextStep}>{wiz.step + 1 === WIZ_STEPS.length ? 'Review' : 'Next'}</Btn>
                            {wiz.step > 0 && <Btn onClick={() => setWiz({ phase: 'capture', step: wiz.step - 1 })}>Back</Btn>}
                            <Btn kind="danger" onClick={() => setWiz({ phase: 'idle' })} style={{ marginLeft: 'auto' }}>Cancel</Btn>
                        </div>
                    </>
                )}
                {(wiz.phase === 'review' || wiz.phase === 'writing' || wiz.phase === 'done') && (
                    <>
                        {rows.length === 0 ? <Note tone="warn">No channel moved more than 300 µs, so there is nothing to write. Check the transmitter is on and try again.</Note> : (
                            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                                <thead><tr style={{ color: T.muted, textAlign: 'left' }}>
                                    {['Channel', 'Used for', 'Min', 'Trim', 'Max'].map(h => <th key={h} style={TH}>{h}</th>)}
                                </tr></thead>
                                <tbody>{rows.map(r => {
                                    const axis = Object.keys(AXIS_KEY).find(a => chOf(a) === r.ch)
                                    return (
                                        <tr key={r.ch}>
                                            <td style={TD}><b>CH{r.ch}</b></td>
                                            <td style={{ ...TD, color: axis ? T.accent : T.muted }}>{axis ? AXIS_SHORT[axis] : 'Switch or dial'}</td>
                                            <td style={TD}>{r.min}</td><td style={TD}>{r.trim}</td><td style={TD}>{r.max}</td>
                                        </tr>
                                    )
                                })}</tbody>
                            </table>
                        )}
                        {wiz.phase === 'review' && (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <Btn kind="primary" onClick={write} disabled={rows.length === 0 || armed}>Write to drone</Btn>
                                <Btn onClick={begin}>Start over</Btn>
                                <Btn kind="danger" onClick={() => setWiz({ phase: 'idle' })} style={{ marginLeft: 'auto' }}>Discard</Btn>
                            </div>
                        )}
                        {wiz.phase === 'writing' && <Note>Writing {wiz.at} of {wiz.of} values...</Note>}
                        {wiz.phase === 'done' && (
                            <>
                                <Note tone="ok" icon={<Check size={15} style={{ color: T.ok, flexShrink: 0, marginTop: 2 }} />}>
                                    Written. Check the monitor: full stick reaches the end of its bar, centred sits in the middle. Any value the drone refused is marked on the Channels tab.
                                </Note>
                                <div><Btn onClick={() => setWiz({ phase: 'idle' })}>Done</Btn></div>
                            </>
                        )}
                    </>
                )}
            </Panel>
            <ChannelMonitor live={live} />
            </div>
        </div>
    )
}

/** Where the ghost knob sits for a wizard step, on the current layout. */
function targetFor(layout: typeof STICK_LAYOUT['2'], t: Target): { side: 'left' | 'right'; dx: number; dy: number } | null {
    for (const side of ['left', 'right'] as const) {
        if (layout[side].x === t.axis) return { side, dx: t.dir, dy: 0 }
        if (layout[side].y === t.axis) return { side, dx: 0, dy: t.dir }
    }
    return null
}

function StepDots({ at, reached }: { at: number; reached: Record<string, boolean> }) {
    return (
        <div aria-hidden style={{ display: 'flex', gap: 4 }}>
            {WIZ_STEPS.map((s, i) => {
                const done = i < at || reached[s.id]
                return <span key={s.id} style={{ flex: 1, height: 4, borderRadius: 2, background: i === at ? T.warn : done ? T.ok : T.surface2, transition: 'background-color var(--dur) var(--ease-out)' }} />
            })}
        </div>
    )
}

/** Mode 1 to 4 as small pictures: which stick carries the throttle is the
 *  thing people recognise, so it is drawn, not just numbered. */
function ModePicker({ mode, onPick }: { mode: string; onPick: (m: string) => void }) {
    return (
        <div role="radiogroup" aria-label="Transmitter mode" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
            {['1', '2', '3', '4'].map(m => {
                const on = m === mode
                const l = STICK_LAYOUT[m]
                const thrLeft = l.left.y === 'throttle' || l.left.x === 'throttle'
                return (
                    <button key={m} type="button" role="radio" aria-checked={on} onClick={() => onPick(m)} title={MODE_HINT[m]}
                        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] transition-colors"
                        style={{
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', borderRadius: 8, cursor: 'pointer',
                            background: on ? mix('var(--app-accent)', 12) : 'transparent', border: `1px solid ${on ? T.accent : T.border}`,
                        }}>
                        <svg viewBox="0 0 60 26" width={60} height={26} aria-hidden>
                            <rect x={1} y={1} width={58} height={24} rx={8} fill="none" stroke={on ? 'var(--app-accent)' : 'hsl(var(--app-border-strong))'} />
                            {[17, 43].map((cx, i) => {
                                const isThr = (i === 0) === thrLeft
                                return (
                                    <g key={cx}>
                                        <circle cx={cx} cy={13} r={7} fill="none" stroke="hsl(var(--app-border-strong))" />
                                        <circle cx={cx} cy={isThr ? 18 : 13} r={3} fill={isThr ? (on ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))') : 'hsl(var(--app-text-muted))'} />
                                    </g>
                                )
                            })}
                        </svg>
                        <span style={{ fontSize: 13, fontWeight: 700, color: on ? T.text : T.muted }}>Mode {m}</span>
                        <span style={{ fontSize: 12, color: T.muted, textAlign: 'center', lineHeight: 1.3 }}>{thrLeft ? 'Throttle left' : 'Throttle right'}</span>
                    </button>
                )
            })}
        </div>
    )
}

function ChannelMonitor({ live }: { live: Live }) {
    const vp = useVehicleParams()
    const { channels } = live
    const count = Math.max(8, channels.length)
    const role = (ch: number): string | null => {
        for (const [a, k] of Object.entries(AXIS_KEY)) if (vp.get(k) === ch) return AXIS_SHORT[a]
        if (vp.get('RC_MAP_FLTMODE') === ch) return 'Mode'
        for (const s of SWITCHES) if (vp.get(s.key) === ch) return s.label.replace(' switch', '')
        return null
    }
    return (
        <Panel title="Channel monitor" hint={live.live ? `${channels.length} channels` : 'no live data'}
            right={<Tip text="Raw channel values in microseconds, as the drone receives them. The tick marks the calibrated centre." />}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {Array.from({ length: count }, (_, i) => {
                    const ch = i + 1
                    const v = channels[i] ?? 0
                    const min = vp.get(`RC${ch}_MIN`) ?? 1000, max = vp.get(`RC${ch}_MAX`) ?? 2000, trim = vp.get(`RC${ch}_TRIM`) ?? 1500
                    const span = 1200 // 900..2100 µs drawn
                    const pos = (x: number) => Math.max(0, Math.min(100, ((x - 900) / span) * 100))
                    const r = role(ch)
                    return (
                        <div key={ch} style={{ display: 'grid', gridTemplateColumns: '44px 72px 1fr 48px', alignItems: 'center', gap: 8, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                            <b style={{ color: T.text }}>CH{ch}</b>
                            <span style={{ color: r ? T.accent : T.muted, fontWeight: r ? 700 : 400, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r ?? '-'}</span>
                            <span style={{ position: 'relative', height: 10, borderRadius: 5, background: T.surface2, border: `1px solid ${T.border}` }}>
                                <span style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos(min)}%`, width: `${pos(max) - pos(min)}%`, background: mix('var(--app-accent)', 10), borderRadius: 5 }} />
                                <span style={{ position: 'absolute', top: -3, bottom: -3, left: `${pos(trim)}%`, width: 1, background: T.borderStrong }} />
                                {v > 0 && <span style={{ position: 'absolute', top: 1, bottom: 1, width: 8, marginLeft: -4, left: `${pos(v)}%`, borderRadius: 4, background: T.accent, transition: 'left 120ms linear' }} />}
                            </span>
                            <span style={{ textAlign: 'right', color: v > 0 ? T.text : T.muted }}>{v > 0 ? v : '-'}</span>
                        </div>
                    )
                })}
            </div>
        </Panel>
    )
}

// ── Flight modes and switches ───────────────────────────────────────────────

function ModesTab({ live }: { live: Live }) {
    const vp = useVehicleParams()
    const telemetry = useDroneStore(s => s.telemetry)
    const [switchType, setSwitchType] = useState<string>(() => ls('hyrak-rc-switch-type', '3'))
    const modeChannel = vp.get('RC_MAP_FLTMODE')
    const liveModeValue = live.live && (modeChannel ?? 0) >= 1 ? live.channels[(modeChannel ?? 1) - 1] ?? 0 : 0
    const activeSlot = slotForValue(liveModeValue)
    const reach = SWITCH_REACH[switchType] ?? SWITCH_REACH['3']
    const reported = telemetry?.flight_mode?.mode

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
            <Panel title="Flight modes" hint="six slots on one channel"
                right={reported && vp.connected ? <Chip tone="accent">Drone in {reported}</Chip> : undefined}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.text, flex: 1 }}>Mode channel</span>
                    <Tip text="The transmitter channel your mode switch sends on (RC_MAP_FLTMODE)." />
                    <OptionSelect size="sm" aria-label="Mode channel" className={SEL}
                        value={modeChannel} placeholder={vp.connected ? 'Loading' : 'No drone'} disabled={!vp.ready}
                        onChange={ch => writeParam('RC_MAP_FLTMODE', ch)} options={CH_OPTS} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: T.muted, flex: 1 }}>Your mode switch has</span>
                    {['2', '3', '6'].map(t => (
                        <button key={t} type="button" onClick={() => { setSwitchType(t); lsSet('hyrak-rc-switch-type', t) }} aria-pressed={switchType === t}
                            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] transition-colors"
                            style={{
                                padding: '0 10px', minHeight: 32, borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                                background: switchType === t ? mix('var(--app-accent)', 14) : 'transparent',
                                border: `1px solid ${switchType === t ? T.accent : T.borderStrong}`, color: switchType === t ? T.text : T.muted,
                            }}>{t} positions</button>
                    ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {Array.from({ length: 6 }, (_, i) => {
                        const key = `COM_FLTMODE${i + 1}`
                        const v = vp.get(key)
                        const posLabel = reach[i + 1]
                        const reachable = posLabel !== undefined
                        const isActive = live.live && activeSlot === i + 1
                        const enabled = vp.ready && v != null && (modeChannel ?? 0) > 0 && reachable
                        return (
                            <div key={key} style={{
                                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 8,
                                background: isActive ? mix('var(--app-ok)', 9) : 'transparent',
                                border: `1px solid ${isActive ? mix('var(--app-ok)', 45) : 'transparent'}`,
                                transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out)',
                            }}>
                                <span style={{
                                    width: 26, height: 26, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                                    background: isActive ? T.ok : reachable ? T.surface2 : 'transparent',
                                    color: isActive ? 'hsl(var(--app-surface))' : reachable ? T.text : T.muted,
                                    border: isActive ? 'none' : `1px ${reachable ? 'solid' : 'dashed'} ${T.borderStrong}`,
                                }}>{i + 1}</span>
                                <span style={{ width: 78, fontSize: 12, color: isActive ? T.ok : T.muted, fontWeight: isActive ? 700 : 400 }}>
                                    {isActive ? 'Active' : reachable ? posLabel : 'Unreachable'}
                                </span>
                                <OptionSelect size="sm" aria-label={`Flight mode for slot ${i + 1}`} className={SEL + ' flex-1'}
                                    value={v} placeholder={vp.connected ? 'Loading' : 'No drone'} disabled={!enabled}
                                    title={reachable ? undefined : `A ${switchType}-position switch never lands on this slot`}
                                    onChange={m => writeParam(key, m)} options={FLTMODE_OPTS.map(o => ({ value: o.v, label: o.l }))} />
                            </div>
                        )
                    })}
                </div>
                {modeChannel === 0 && <Note>Assign a mode channel to choose the modes.</Note>}
                {live.live && (modeChannel ?? 0) > 0 && (
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
                        Mode channel at {liveModeValue || '-'} µs. Flip the switch: the active slot follows.
                    </p>
                )}
            </Panel>

            <Panel title="Switches" hint="channel and switch point"
                right={<Tip text="Each switch on its own channel. The switch point is where on the channel's range it turns on: 0.75 = on above 75 %, -0.25 = on below 25 % (RC_*_TH)." />}>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, fontWeight: 600, color: T.muted }}>
                    <span style={{ flex: 1 }}>Switch</span><span style={{ width: 112 }}>Channel</span><span style={{ width: 70, textAlign: 'right' }}>Switch point</span>
                </div>
                {SWITCHES.filter(s => !vp.ready || vp.has(s.key)).map(s => (
                    <SwitchRow key={s.key} sw={s} live={live} />
                ))}
            </Panel>
        </div>
    )
}

function SwitchRow({ sw, live }: { sw: (typeof SWITCHES)[number]; live: Live }) {
    const vp = useVehicleParams()
    const ch = vp.get(sw.key)
    const th = vp.get(sw.th)
    const hasTh = vp.has(sw.th)
    let state: boolean | null = null
    if (live.live && ch && ch > 0 && th != null) {
        const raw = live.channels[ch - 1] ?? 0
        const min = vp.get(`RC${ch}_MIN`) ?? 1000, max = vp.get(`RC${ch}_MAX`) ?? 2000
        const rev = (vp.get(`RC${ch}_REV`) ?? 1) < 0
        let f = (raw - min) / Math.max(1, max - min)
        if (rev) f = 1 - f
        if (raw > 0) state = th >= 0 ? f > th : f < -th
    }
    const danger = sw.key === 'RC_MAP_KILL_SW'
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 40, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 }}>
            <ToggleRight size={16} aria-hidden style={{ color: state ? (danger ? T.danger : T.ok) : T.muted, flexShrink: 0 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{sw.label}</span>
            <Tip text={sw.tip} />
            {state != null && <Chip tone={state ? (danger ? 'danger' : 'ok') : 'off'}>{state ? 'On' : 'Off'}</Chip>}
            <span style={{ flex: 1 }} />
            <OptionSelect size="sm" aria-label={`${sw.label} channel`} className={SEL}
                value={vp.ready ? ch : 0} disabled={!vp.ready} onChange={c => writeParam(sw.key, c)} options={CH_OPTS} />
            <NumberBox label={`${sw.label} switch point`} value={vp.ready ? th : 0.75} disabled={!vp.ready || !hasTh || !ch}
                onCommit={v => writeParam(sw.th, v)} min={-1} max={1} decimals={2} width={70} />
        </div>
    )
}

// ── Channels tab ────────────────────────────────────────────────────────────

function ChannelsTab({ live }: { live: Live }) {
    const vp = useVehicleParams()
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const [confirm, setConfirm] = useState(false)
    const trimAxes = ['roll', 'pitch', 'yaw'].map(a => ({ a, ch: vp.get(AXIS_KEY[a]) ?? 0 }))
    const canCopy = vp.ready && live.live && !armed && trimAxes.every(t => t.ch > 0)
    const copy = () => {
        writeParams(trimAxes.map(t => [`RC${t.ch}_TRIM`, live.channels[t.ch - 1]] as [string, number]).filter(([, v]) => v > 0))
        setConfirm(false)
    }
    const rssiCh = vp.get('RC_RSSI_PWM_CHAN')
    const rssi = live.rssi
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <RadioChannels extra={<>
                <Panel title="Copy trims" right={<Tip text="Takes the sticks' current centre as the trim for roll, pitch and yaw (RCn_TRIM), the way QGC's Copy Trims does. Then zero the trims on the transmitter." />}>
                    <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5 }}>
                        If you trimmed the drone on the transmitter in flight, copy those trims to the drone, then set the transmitter trims back to zero.
                    </p>
                    <div><Btn onClick={() => setConfirm(true)} disabled={!canCopy}
                        title={!live.live ? 'Needs live channel data' : armed ? 'Disarm first' : undefined}>Copy trims</Btn></div>
                </Panel>
                <Panel title="Signal strength (RSSI)" right={<Tip text="Most receivers report RSSI inside the RC link. Some send it as a PWM channel instead: pick that channel here (RC_RSSI_PWM_CHAN)." />}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Live RSSI</span>
                        <span style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: rssi != null && rssi < 255 ? T.text : T.muted }}>
                            {rssi == null ? '-' : rssi >= 255 ? 'Not reported' : `${Math.round((rssi / 254) * 100)} %`}
                        </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>RSSI from channel</span>
                        <OptionSelect size="sm" aria-label="RSSI channel" className={SEL} value={vp.ready ? rssiCh : 0} disabled={!vp.ready || !vp.has('RC_RSSI_PWM_CHAN')}
                            onChange={c => writeParam('RC_RSSI_PWM_CHAN', c)} options={[{ value: 0, label: 'Not used' }, ...CH_OPTS.slice(1)]} />
                    </div>
                    {(rssiCh ?? 0) > 0 && (
                        <>
                            <ParamRow compact spec={{ key: 'RC_RSSI_PWM_MIN', label: 'Weakest signal at', unit: 'µs', decimals: 0 }} />
                            <ParamRow compact spec={{ key: 'RC_RSSI_PWM_MAX', label: 'Strongest signal at', unit: 'µs', decimals: 0 }} />
                        </>
                    )}
                </Panel>
                <SpektrumBind />
            </>} />
            <Dialog open={confirm} onClose={() => setConfirm(false)} title="Copy trims">
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>Let go of the sticks so they rest at centre. These values become the trims:</p>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
                    {trimAxes.map(t => <li key={t.a}>{AXIS_SHORT[t.a]} (CH{t.ch}): {live.channels[t.ch - 1] ?? '-'} µs</li>)}
                </ul>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
                    <Btn kind="primary" onClick={copy}>Copy to drone</Btn>
                </div>
            </Dialog>
        </div>
    )
}

// ── Transmitter drawing ─────────────────────────────────────────────────────

/** The transmitter, drawn. With live data the sticks ARE the operator's
 *  sticks; a ghost knob shows where a calibration step wants them. Motion is
 *  a CSS transition, so 5 to 10 Hz updates glide instead of ticking. */
function TransmitterSvg({ layout, axisValue, live, modeChannel, modeValue, flightMode, ghost }: {
    layout: typeof STICK_LAYOUT['2']
    axisValue: (axis: string) => number
    live: boolean
    modeChannel: number
    modeValue: number
    flightMode: string
    ghost: { side: 'left' | 'right'; dx: number; dy: number } | null
}) {
    const [svgRef, px] = useSvgPx(420)
    const R = 30
    const off = (ax: { x: string; y: string }) => ({ dx: axisValue(ax.x) * R, dy: -axisValue(ax.y) * R })
    const L = off(layout.left), Rk = off(layout.right)
    const stickCol = live ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'
    const slot = slotForValue(modeValue)
    return (
        <svg ref={svgRef} viewBox="0 0 420 228" style={{ width: '100%', maxWidth: 440, height: 'auto', display: 'block', margin: '0 auto', overflow: 'visible' }} role="img" aria-label="Transmitter stick layout">
            <rect x={20} y={30} width={380} height={176} rx={28} fill="hsl(var(--app-surface-2))" stroke="hsl(var(--app-border))" strokeWidth={1.5} />
            <line x1={54} y1={36} x2={28} y2={6} stroke="hsl(var(--app-text-muted))" strokeWidth={4} strokeLinecap="round" />
            <text x={392} y={20} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill={modeChannel > 0 ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'}>
                {modeChannel > 0 ? `Mode switch CH${modeChannel}${live && slot ? `, slot ${slot}` : ''}` : 'Mode switch not assigned'}
            </text>
            {[{ cx: 118, o: L, ax: layout.left, side: 'left' as const }, { cx: 302, o: Rk, ax: layout.right, side: 'right' as const }].map(({ cx, o, ax, side }) => (
                <g key={side}>
                    <circle cx={cx} cy={118} r={46} fill="hsl(var(--app-bg))" stroke="hsl(var(--app-border))" strokeWidth={1.5} />
                    <line x1={cx - 36} y1={118} x2={cx + 36} y2={118} stroke="hsl(var(--app-border))" strokeWidth={0.8} />
                    <line x1={cx} y1={82} x2={cx} y2={154} stroke="hsl(var(--app-border))" strokeWidth={0.8} />
                    {ghost?.side === side && (
                        <g>
                            <circle cx={cx + ghost.dx * R} cy={118 - ghost.dy * R} r={13} fill="none" stroke="var(--app-warn)" strokeWidth={2} strokeDasharray="4 3">
                                <animate attributeName="r" values="12;15;12" dur="1.4s" repeatCount="indefinite" />
                            </circle>
                        </g>
                    )}
                    <g style={{ transform: `translate(${cx + o.dx}px, ${118 + o.dy}px)`, transition: 'transform 140ms linear' }}>
                        <line x1={-o.dx} y1={-o.dy} x2={0} y2={0} stroke={stickCol} strokeWidth={4.5} strokeLinecap="round" opacity={0.75} />
                        <circle r={12} fill={stickCol} />
                        <circle r={5.5} fill="hsl(var(--app-surface))" />
                    </g>
                    <text x={cx} y={182} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">
                        <tspan x={cx}>{AXIS_SHORT[ax.y]} up and down</tspan>
                        <tspan x={cx} dy={px(12) * 1.25}>{AXIS_SHORT[ax.x]} left and right</tspan>
                    </text>
                </g>
            ))}
            <rect x={174} y={100} width={72} height={36} rx={6} fill="hsl(var(--app-bg))" stroke="hsl(var(--app-border))" strokeWidth={1.2} />
            <text x={210} y={115} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill={live ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))'}>{live ? 'RC live' : 'No RC'}</text>
            {flightMode !== 'NO LINK' && flightMode && (
                <text x={210} y={130} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fontWeight="700" fill="var(--app-accent)">{flightMode.slice(0, 9)}</text>
            )}
        </svg>
    )
}

const SEL = 'w-auto min-w-[112px] text-[13px] tabular-nums data-[size=sm]:h-8'
const TH: React.CSSProperties = { padding: '6px 6px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const TD: React.CSSProperties = { padding: '5px 6px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap', color: T.text }

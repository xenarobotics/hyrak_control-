'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import {
    Radio, Wifi, WifiOff, Check,
    Plane, Gauge, SlidersHorizontal, Battery, Shield, Navigation,
    Terminal, ChevronRight, LayoutList,
    AlertTriangle,
    Camera, Package, Fan, SquareTerminal, FileText, Gamepad2,
} from 'lucide-react'
import { ViewOnlyFence } from '@/components/layout/ViewOnly'
import { AttachmentsSection } from '@/components/attachments/AttachmentsConfig'
import { useSessionAttachments } from '@/lib/attachments'
import { OptionSelect } from '@/components/config/OptionSelect'
import { PowerSetup } from '@/components/config/PowerSetup'
import { ActuatorsSetup } from '@/components/config/ActuatorsSetup'
import { SafetySetup } from '@/components/config/SafetySetup'
import { TuningSetup } from '@/components/config/TuningSetup'
import { CameraGimbalSetup } from '@/components/config/CameraGimbalSetup'
import { SensorsSetup } from '@/components/config/SensorsSetup'
import { RadioSetup } from '@/components/config/RadioSetup'
import { JoystickSetup } from '@/components/config/JoystickSetup'
import { VehicleSetup } from '@/components/config/VehicleSetup'
import { ConnectionSetup } from '@/components/config/ConnectionSetup'
import { FrameIcon, airframeById, kindFromAutostart, kindFromMavType } from '@/components/config/airframes'
import { useVehicleInfo } from '@/lib/vehicleInfo'
import { PageHeader } from '@/components/config/kit'
import { MavlinkConsole } from '@/components/config/MavlinkConsole'
import { ParametersSetup } from '@/components/config/ParametersSetup'
import { LogsSetup } from '@/components/config/LogsSetup'
import { useVehicleParams } from '@/lib/vehicleParams'

function hColor(pct: number, locked = false) {
    if (locked) return 'hsl(var(--app-text-muted))'
    if (pct >= 100) return 'var(--app-ok)'
    if (pct >= 65)  return 'var(--app-accent)'
    if (pct >= 35)  return 'var(--app-warn)'
    return 'var(--app-danger)'
}

type SectionId = 'connection' | 'vehicle' | 'sensors' | 'radio' | 'power' | 'actuators' | 'safety' | 'flight' | 'camera' | 'parameters' | 'console' | 'logs' | 'joystick' | 'attachments'


const DOMAIN_META: { id: SectionId; label: string; icon: React.ElementType; desc: string }[] = [
    { id: 'connection', label: 'Connection',  icon: Radio,             desc: 'How HYRAK reaches the drone: pick the link and watch its health' },
    { id: 'vehicle',    label: 'Vehicle',     icon: Plane,             desc: 'What the drone reports about itself: firmware, board, IDs and airframe' },
    { id: 'sensors',    label: 'Sensors',     icon: Gauge,             desc: 'Live sensor health and calibration' },
    { id: 'radio',      label: 'Radio & RC',  icon: SlidersHorizontal, desc: 'Stick calibration, live channels, flight modes and switches' },
    { id: 'joystick',   label: 'Joystick',    icon: Gamepad2,          desc: 'Gamepad setup: sticks, feel and button actions, stored in this browser' },
    { id: 'power',      label: 'Power',       icon: Battery,           desc: 'Batteries, power module calibration, low battery levels and ESC calibration' },
    { id: 'actuators',  label: 'Actuators',   icon: Fan,               desc: 'Motor geometry, output mapping, and motor testing with the propellers off' },
    { id: 'safety',     label: 'Safety',      icon: Shield,            desc: 'Link loss, RC loss, geofence, return home and landing failsafes' },
    { id: 'camera',     label: 'Camera & gimbal', icon: Camera,        desc: 'Camera trigger for surveys, and how PX4 drives the gimbal' },
    { id: 'flight',     label: 'Tuning',      icon: Navigation,        desc: 'Speeds and heights, controller gains, hover thrust and autotune' },
    { id: 'parameters', label: 'Parameters',   icon: Terminal,          desc: 'Every PX4 parameter: search, edit, reset to default, import and export' },
    { id: 'console',    label: 'PX4 console', icon: SquareTerminal,    desc: 'The flight controller shell over MAVLink, for diagnostics' },
    { id: 'logs',       label: 'Logs',        icon: FileText,          desc: 'Flight logs on the SD card, and the flights HYRAK recorded' },
    { id: 'attachments', label: 'Attachments', icon: Package,           desc: 'What is fitted to the drone: drop hook, gripper, winch, light, speaker, sprayer' },
]

// ── Base SVG ──────────────────────────────────────────────────────────────────

function StatusRing({ pct, color, size = 44, stroke = 3.5 }: { pct: number; color: string; size?: number; stroke?: number }) {
    const r = (size - stroke * 2) / 2, circ = 2 * Math.PI * r
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }} aria-hidden>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="hsl(var(--app-border))" strokeWidth={stroke} />
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${circ * pct / 100} ${circ}`} strokeLinecap="round" />
        </svg>
    )
}

/** A readiness ring with its value inside; a check at 100 so 3 digits never
 *  overflow the ring. Only rendered for values that are measured. */
function ReadinessRing({ pct, color, size = 52 }: { pct: number; color: string; size?: number }) {
    return (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            role="img" aria-label={`${pct.toFixed(0)}% ready`}>
            <StatusRing pct={pct} color={color} size={size} stroke={4} />
            <span style={{ position: 'absolute', fontSize: size >= 52 ? 14 : 12, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {pct >= 100 ? <Check size={size >= 52 ? 20 : 16} strokeWidth={3} /> : <>{pct.toFixed(0)}<span style={{ fontSize: 12, fontWeight: 700 }}>%</span></>}
            </span>
        </div>
    )
}

// ── Primitives ────────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)]'


// ── Readiness checklist ─────────────────────────────────────────────────────

type RowState = 'ok' | 'warn' | 'idle' | 'none'

/** One line of the overview: a state mark, the section, what it is set to,
 *  and at most one action. The whole row opens the section. */
function ReadinessRow({ label, icon: Icon, state, value, action, onClick }: {
    label: string; icon: React.ElementType; state: RowState; value: string
    action?: string; onClick: () => void
}) {
    const mark = state === 'ok' ? <Check size={16} strokeWidth={2.75} style={{ color: 'var(--app-ok)' }} aria-label="Set" />
        : state === 'warn' ? <AlertTriangle size={16} style={{ color: 'var(--app-warn)' }} aria-label="Needs attention" />
        : state === 'idle' ? <span aria-label="Not checked" style={{ width: 10, height: 2, borderRadius: 1, background: 'hsl(var(--app-text-subtle))' }} />
        : <span aria-hidden style={{ width: 10 }} />
    return (
        <li style={{ listStyle: 'none' }}>
            <button type="button" onClick={onClick}
                className={'group w-full text-left bg-transparent hover:bg-app-surface-2 active:bg-app-surface-2 transition-colors ' + FOCUS_RING}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', minHeight: 52, border: 'none', cursor: 'pointer' }}>
                <span style={{ width: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{mark}</span>
                <Icon size={16} aria-hidden style={{ color: 'hsl(var(--app-text-muted))', flexShrink: 0 }} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="sm:w-[150px] sm:shrink-0" style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>{label}</span>
                    <span className="sm:truncate" style={{ minWidth: 0, fontSize: 14, color: state === 'idle' ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                </span>
                <span className="text-app-text-muted group-hover:text-app-text transition-colors" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {action && <span className="max-sm:hidden">{action}</span>}
                    <ChevronRight size={16} aria-hidden />
                </span>
            </button>
        </li>
    )
}

// ── Vehicle Banner ────────────────────────────────────────────────────────────

/** Who the aircraft is, from the drone and HYRAK's record of it: the
 *  registry name, the airframe PX4 is set to, the firmware it reports. */
function VehicleBanner({ readiness }: { readiness: number | null }) {
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const drone = useDroneStore(s => s.session?.drone ?? null)
    const connected = telStatus === 'connected'
    const { info } = useVehicleInfo()
    const vp = useVehicleParams()
    const autostart = vp.get('SYS_AUTOSTART')
    const kind = kindFromAutostart(autostart) ?? kindFromMavType(info?.mav_type) ?? 'quad-x'
    const frameName = airframeById(autostart)?.name ?? (autostart ? `Airframe ${autostart}` : info?.vehicle_type)
    const fw = info?.firmware ? `${info.autopilot ? info.autopilot + ' ' : ''}${info.firmware}` : info?.autopilot
    const chip: React.CSSProperties = { fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--app-text-muted))', background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', whiteSpace: 'nowrap' }
    const title = drone?.name ?? (connected ? 'Connected drone' : 'No drone connected')
    return (
        <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px clamp(16px, 3vw, 24px)', borderBottom: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ color: connected ? 'var(--app-accent)' : 'hsl(var(--app-text-subtle))', display: 'flex' }}><FrameIcon kind={kind} size={40} /></span>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: connected ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.25 }}>{title}</h1>
                    {connected && frameName && <span style={chip}>{frameName}</span>}
                    {connected && fw && <span style={chip}>{fw}</span>}
                    {drone?.is_simulated && <span style={chip}>Simulator</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 }}>
                    {connected ? <Wifi size={14} style={{ color: 'var(--app-ok)', flexShrink: 0 }} /> : <WifiOff size={14} style={{ color: 'hsl(var(--app-text-muted))', flexShrink: 0 }} />}
                    <span style={{ fontSize: 13, fontWeight: 600, color: connected ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))' }}>{connected ? 'Connected' : 'Not connected'}</span>
                    {connected && info?.address && <span className="font-code" style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.address}</span>}
                </div>
            </div>
            {readiness != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}
                    title="Sensor health measured on the connected drone (GPS, gyro and accel, compass, baro)">
                    <ReadinessRing pct={readiness} color={hColor(readiness)} size={44} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>Ready</span>
                </div>
            )}
        </header>
    )
}

// ── Section navigation ──────────────────────────────────────────────────────

type NavId = SectionId | 'overview'

/** Setup sections, always visible on the left (a select at phone width). */
function SectionNav({ current, onSelect, items }: {
    current: NavId; onSelect: (id: NavId) => void
    items: { id: NavId; label: string; icon: React.ElementType }[]
}) {
    return (
        <nav role="tablist" aria-label="Setup sections" aria-orientation="vertical"
            className="max-md:hidden flex flex-col"
            style={{ width: 216, flexShrink: 0, gap: 2, padding: '16px 10px', borderRight: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', overflowY: 'auto' }}>
            {items.map((t, i) => {
                const active = t.id === current, Icon = t.icon
                return (
                    <React.Fragment key={t.id}>
                        {i === 1 && <div aria-hidden style={{ height: 1, background: 'hsl(var(--app-border))', margin: '6px 8px' }} />}
                        <button role="tab" aria-selected={active} onClick={() => onSelect(t.id)}
                            className={(active ? 'bg-app-accent-soft text-app-selected-ink' : 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2') + ' transition-colors ' + FOCUS_RING}
                            style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', minHeight: 38, borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 700 : 600, textAlign: 'left', whiteSpace: 'nowrap' }}>
                            <span aria-hidden style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, background: 'var(--app-accent)', opacity: active ? 1 : 0, transition: 'opacity var(--dur) var(--ease-out)' }} />
                            <Icon size={16} style={{ color: active ? 'var(--app-accent)' : undefined, flexShrink: 0 }} />{t.label}
                        </button>
                    </React.Fragment>
                )
            })}
        </nav>
    )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHead({ meta, pct }: { meta: { label: string; desc: string }; pct: number | null }) {
    return <PageHeader title={meta.label} desc={meta.desc} right={pct != null ? <ReadinessRing pct={pct} color={hColor(pct)} size={48} /> : undefined} />
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConfigPage() {
    const telStatus    = useDroneStore(s => s.telemetryStatus)
    const telemetry    = useDroneStore(s => s.telemetry)
    const terrainFollow = useMissionStore(s => s.terrainFollow)
    const fitted = useSessionAttachments()

    const [section, setSection] = useState<NavId>('overview')


    const connected = telStatus === 'connected'
    // Same verdicts as the Sensors workspace - PX4's health flags where they
    // exist, never inferred from the data (heading !== 0 declared the compass
    // broken whenever the aircraft faced magnetic north).
    const hlth = connected && telemetry?.health?.received ? telemetry.health : null
    const sensorOK = [
        connected && (telemetry?.gps?.fix_type ?? 0) >= 3,
        connected && (hlth ? hlth.gyro_cal_ok && hlth.accel_cal_ok : telemetry?.attitude != null),
        connected && (hlth ? hlth.mag_cal_ok : true),
        connected,  // baro: PX4 keeps no verdict - reporting is the claim
    ].filter(Boolean).length

    // Readiness only where something is measured from the drone. Sections
    // that hold local settings (radio, power, safety, flight, parameters,
    // attachments) have no ring: a percentage there would be invented.
    const domainPcts: Record<SectionId, number | null> = {
        connection:  null,
        vehicle:     null,
        sensors:     connected ? (sensorOK / 4) * 100 : null,
        radio:       null,
        power:       null,
        actuators:   null,
        camera:      null,
        safety:      null,
        flight:      null,
        parameters:  null,
        console:     null,
        logs:        null,
        joystick:    null,
        attachments: null,
    }
    const readiness = connected ? Math.round((sensorOK / 4) * 100) : null

    // ── Two-finger swipe back interception ────────────────────────────────────
    // Opening a section from the overview pushes a history entry, so the
    // browser's back gesture returns to the overview instead of leaving.
    const view = section === 'overview' ? 'grid' : 'workspace'
    const viewRef        = useRef(view)
    const navBackRef     = useRef(false)
    useEffect(() => { viewRef.current = view }, [view])

    useEffect(() => {
        if (view === 'workspace') {
            window.history.pushState({ hyrakConfig: true }, '')
        }
    }, [view])

    useEffect(() => {
        const handle = () => {
            if (navBackRef.current) { navBackRef.current = false; return }
            if (viewRef.current === 'workspace') setSection('overview')
        }
        window.addEventListener('popstate', handle)
        return () => window.removeEventListener('popstate', handle)
    }, [])

    const select = useCallback((id: NavId) => {
        if (id === 'overview' && viewRef.current === 'workspace') {
            navBackRef.current = true
            setSection('overview')
            if (window.history.state?.hyrakConfig) window.history.back()
            return
        }
        setSection(id)
    }, [])

    const navItems: { id: NavId; label: string; icon: React.ElementType }[] = [
        { id: 'overview', label: 'Overview', icon: LayoutList },
        ...DOMAIN_META.filter(d => d.id !== 'parameters' && d.id !== 'console' && d.id !== 'logs'),
        ...DOMAIN_META.filter(d => d.id === 'parameters'),
        ...DOMAIN_META.filter(d => d.id === 'console'),
        ...DOMAIN_META.filter(d => d.id === 'logs'),
    ]
    const meta = section === 'overview'
        ? { label: 'Overview', desc: 'Is the drone ready to fly? Open any line to change it.' }
        : (DOMAIN_META.find(d => d.id === section) ?? DOMAIN_META[0])

    // Power, actuators, safety and tuning rows read the aircraft's own
    // parameters. Without a drone they say so rather than show a setting
    // that lives nowhere.
    const vp = useVehicleParams()
    const boundDrone = useDroneStore(s => s.session?.drone ?? null)
    const { info: vInfo } = useVehicleInfo()
    const pv = (k: string, alt?: string) => vp.get(k) ?? (alt ? vp.get(alt) : null)
    const LOSS_WORD: Record<number, string> = { 0: 'nothing', 1: 'Hold', 2: 'Return', 3: 'Land', 5: 'Terminate', 6: 'Lockdown' }
    const BAT_ACT_WORD: Record<number, string> = { 0: 'warn only', 2: 'land at critical', 3: 'return at critical' }
    const paramRow = (fill: () => { state: RowState; value: string }): { state: RowState; value: string } =>
        !connected ? { state: 'idle', value: 'Needs a drone' } : !vp.params ? { state: 'idle', value: vp.loading ? 'Reading parameters' : 'Parameters not read' } : fill()
    const powerRow = paramRow(() => {
        const cells = pv('BAT1_N_CELLS', 'BAT_N_CELLS') ?? 0, cap = pv('BAT1_CAPACITY', 'BAT_CAPACITY') ?? -1
        const act = pv('COM_LOW_BAT_ACT'), crit = pv('BAT_CRIT_THR')
        return { state: cells > 0 ? 'ok' : 'warn', value: `${cells > 0 ? `${cells}S` : 'Cells not set'}${cap > 0 ? ` ${cap} mAh` : ''}, ${BAT_ACT_WORD[act ?? 0] ?? 'action ' + act}${crit != null ? ` (critical ${Math.round(crit * 100)}%)` : ''}` }
    })
    const actuatorRow = paramRow(() => {
        const n = pv('CA_ROTOR_COUNT')
        return n == null ? { state: 'none', value: 'Geometry needs PX4 1.14+' } : { state: 'ok', value: `${n} motor${n === 1 ? '' : 's'}` }
    })
    const safetyRow = paramRow(() => {
        const dll = pv('NAV_DLL_ACT'), obl = pv('COM_OBL_RC_ACT'), rtl = pv('RTL_RETURN_ALT')
        const bad = dll === 0 || dll === 5 || dll === 6 || obl === 6 || obl === 7
        return { state: bad ? 'warn' : 'ok', value: `Link loss: ${LOSS_WORD[dll ?? -1] ?? '?'}, return at ${rtl ?? '?'} m${bad ? ', blocks arming' : ''}, terrain ${terrainFollow ? 'on' : 'off'}` }
    })
    const radioRow = paramRow(() => {
        const ch = pv('RC_MAP_FLTMODE'), thr = pv('RC_MAP_THROTTLE')
        if (!thr) return { state: 'warn', value: 'Sticks not mapped (RC_MAP_THROTTLE)' }
        return ch ? { state: 'ok', value: `Mode switch on CH${ch}` } : { state: 'warn', value: 'No mode switch channel' }
    })
    const TRIG_WORD: Record<number, string> = { 0: 'trigger off', 1: 'time trigger on command', 2: 'time trigger', 3: 'distance trigger', 4: 'survey trigger' }
    const cameraRow = paramRow(() => {
        const t = pv('TRIG_MODE'), m = pv('MNT_MODE_IN')
        return { state: 'ok', value: `${t == null ? 'No trigger module' : TRIG_WORD[t] ?? `trigger mode ${t}`}, gimbal ${m == null || m < 0 ? 'off' : 'on'}` }
    })
    const flightRow = paramRow(() => ({ state: 'ok', value: `Takeoff ${pv('MIS_TAKEOFF_ALT') ?? '?'} m, max ${pv('MPC_XY_VEL_MAX') ?? '?'} m/s` }))
    const attachmentsValue = !fitted.droneId ? 'Needs a drone' : fitted.attachments.length ? fitted.attachments.map(x => x.name).join(', ') : 'None fitted'
    const vehicleRow: { state: RowState; value: string } = !connected ? { state: 'idle', value: 'Needs a drone' } : {
        state: 'ok',
        value: [boundDrone?.name, airframeById(vp.get('SYS_AUTOSTART'))?.name ?? (vp.get('SYS_AUTOSTART') ? `Airframe ${vp.get('SYS_AUTOSTART')}` : vInfo?.vehicle_type),
            vInfo?.firmware ? `${vInfo.autopilot ?? ''} ${vInfo.firmware}`.trim() : null].filter(Boolean).join(', ') || 'Connected',
    }
    const rows: { id: SectionId; state: RowState; value: string; action?: string }[] = [
        { id: 'vehicle',     ...vehicleRow },
        { id: 'connection',  state: connected ? 'ok' : 'idle', value: connected ? 'Connected' : 'Not connected', action: connected ? undefined : 'Connect' },
        { id: 'sensors',     state: !connected ? 'idle' : sensorOK === 4 ? 'ok' : 'warn', value: !connected ? 'Needs a drone' : `${sensorOK} of 4 healthy`, action: connected && sensorOK < 4 ? 'Calibrate' : undefined },
        { id: 'radio',       ...radioRow },
        { id: 'power',       ...powerRow },
        { id: 'actuators',   ...actuatorRow },
        { id: 'safety',      ...safetyRow, action: safetyRow.state === 'warn' ? 'Fix' : undefined },
        { id: 'flight',      ...flightRow },
        { id: 'camera',      ...cameraRow },
        { id: 'attachments', state: fitted.droneId ? 'ok' : 'idle', value: attachmentsValue },
        { id: 'parameters',  state: 'none', value: vp.params ? `${Object.keys(vp.params).length} parameters` : 'All PX4 parameters', action: 'Open' },
    ]

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <VehicleBanner readiness={readiness} />

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <SectionNav current={section} onSelect={select} items={navItems} />

                <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
                    <div style={{ maxWidth: 1320, padding: '24px clamp(16px, 3vw, 32px) 48px' }}>
                        {/* Phone width: the section list becomes a select. */}
                        <div className="flex flex-col md:hidden" style={{ gap: 6, marginBottom: 20 }}>
                            <span id="cfg-section-label" style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>Section</span>
                            <OptionSelect aria-labelledby="cfg-section-label" value={section} onChange={select}
                                className="data-[size=default]:h-11 text-[15px] font-semibold"
                                options={navItems.map(n => ({ value: n.id, label: n.label }))} />
                        </div>

                        <div key={section} role="tabpanel" className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                            <SectionHead meta={meta} pct={section === 'overview' ? null : domainPcts[section]} />

                            {section === 'overview' && (
                                <section aria-label="Readiness" style={{ borderRadius: 10, border: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', overflow: 'hidden' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid hsl(var(--app-border))' }}>
                                        <h3 style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0, flex: 1 }}>Readiness</h3>
                                        {!connected && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'hsl(var(--app-text-muted))' }}><WifiOff size={14} aria-hidden /> Connect a drone to check sensors</span>}
                                    </div>
                                    <ul style={{ margin: 0, padding: 0 }} className="divide-y divide-app-border">
                                        {rows.map(r => {
                                            const d = DOMAIN_META.find(x => x.id === r.id)!
                                            return <ReadinessRow key={r.id} label={d.label} icon={d.icon} state={r.state} value={r.value} action={r.action} onClick={() => select(r.id)} />
                                        })}
                                    </ul>
                                </section>
                            )}

                            {/* Parameter writes, calibration and reboots are
                                commands: a workspace viewer reads this page only. */}
                            {section !== 'overview' && section !== 'attachments' && (
                                <ViewOnlyFence>
                                {section === 'connection' && <ConnectionSetup />}
                                {section === 'vehicle'    && <VehicleSetup />}
                                {section === 'sensors'    && <SensorsSetup />}
                                {section === 'radio'      && <RadioSetup />}
                                {section === 'joystick'   && <JoystickSetup />}
                                {section === 'power'      && <PowerSetup />}
                                {section === 'actuators'  && <ActuatorsSetup />}
                                {section === 'safety'     && <SafetySetup />}
                                {section === 'flight'     && <TuningSetup />}
                                {section === 'camera'     && <CameraGimbalSetup />}
                                {section === 'console'    && <MavlinkConsole />}
                                {section === 'parameters' && <ParametersSetup />}
                                {section === 'logs'       && <LogsSetup />}
                                </ViewOnlyFence>
                            )}
                            {/* Reads for everyone; owners and admins edit (the server says who). */}
                            {section === 'attachments' && <AttachmentsSection />}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

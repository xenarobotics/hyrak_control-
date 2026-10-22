'use client'

// Config > Sensors: QGroundControl's Sensors setup in HYRAK's shape.
//
// THREE TABS. "Calibrate" is the guided flow: live health across the top, the
// calibrations as numbered steps in the order they should be done, and the
// aircraft model beside them showing what to do now. "Sensors" lists every
// compass, IMU and barometer the autopilot has a calibration for, with the
// per-compass enable / priority / rotation QGC offers, plus live raw readings.
// "Orientation" holds the mount rotation, level trims and factory calibration.
//
// EVERY VERDICT COMES FROM THE AUTOPILOT. "Calibrated" is PX4's health flag
// (the same bits QGC shows) or a run that finished OK this session, never
// inferred from the data. Parameters come from the shared copy in
// lib/vehicleParams.ts, and every write is confirmed by the aircraft.

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useCalibration } from '@/hooks/useCalibration'
import { CalibrationStage } from '@/components/config/CalibrationStage'
import { CAL_SENSORS } from '@/types/calibration'
import { getSocket } from '@/lib/socket'
import {
    Check, AlertTriangle, Satellite, Compass as CompassIcon, Activity, Mountain, Move3d, Camera,
    AlignCenterHorizontal, RotateCw, Loader, Wind, Cpu, Waypoints,
} from 'lucide-react'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Btn, Chip, Note, Panel, ParamRow, ParamSourceBar, ReloadButton, SubTabs, T, Tip, Toggle, mix } from '@/components/config/kit'
import { useVehicleParams, writeParam } from '@/lib/vehicleParams'
import { SYS_SENSOR, sysSensor, useConfigLive, type ConfigLive } from '@/lib/configLive'

// ── Shared bits (Radio & RC uses these too) ─────────────────────────────────

export type SensorStatus = 'ok' | 'warn' | 'off'
const STATUS_COLOUR: Record<SensorStatus, string> = {
    ok: 'var(--app-ok)', warn: 'var(--app-warn)', off: 'hsl(var(--app-text-muted))',
}

export function SectionHeader({ title, hint, right }: {
    title: string; hint?: string; right?: React.ReactNode
}) {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10, rowGap: 2, padding: '2px 2px 0' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, margin: 0, whiteSpace: 'nowrap' }}>{title}</h3>
            {hint && <span style={{ fontSize: 13, color: T.muted }}>{hint}</span>}
            {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
        </div>
    )
}

export function StatusChip({ status, text }: { status: SensorStatus; text: string }) {
    const c = STATUS_COLOUR[status]
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
            background: mix(c, 8), border: `1px solid ${mix(c, 23)}`,
            fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: c, whiteSpace: 'nowrap',
        }}>
            {status === 'ok' ? <Check size={12} strokeWidth={3} aria-hidden /> : status === 'warn' ? <AlertTriangle size={12} aria-hidden /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />}
            {text}
        </span>
    )
}

const GPS_FIX_LABEL: Record<number, string> = {
    0: 'No fix', 1: 'No fix', 2: '2D fix', 3: '3D fix', 4: 'DGPS', 5: 'RTK float', 6: 'RTK fixed',
}

// ── Rotations (MAV_SENSOR_ORIENTATION) ──────────────────────────────────────

/** Every rotation PX4 defines (except #38, a device-specific oddity), as the
 *  roll / pitch / yaw it is made of. */
const ROT_TABLE: { r: number; p: number; y: number; v: number }[] = [
    { r: 0, p: 0, y: 0, v: 0 }, { r: 0, p: 0, y: 45, v: 1 }, { r: 0, p: 0, y: 90, v: 2 },
    { r: 0, p: 0, y: 135, v: 3 }, { r: 0, p: 0, y: 180, v: 4 }, { r: 0, p: 0, y: 225, v: 5 },
    { r: 0, p: 0, y: 270, v: 6 }, { r: 0, p: 0, y: 315, v: 7 },
    { r: 180, p: 0, y: 0, v: 8 }, { r: 180, p: 0, y: 45, v: 9 }, { r: 180, p: 0, y: 90, v: 10 },
    { r: 180, p: 0, y: 135, v: 11 }, { r: 0, p: 180, y: 0, v: 12 }, { r: 180, p: 0, y: 225, v: 13 },
    { r: 180, p: 0, y: 270, v: 14 }, { r: 180, p: 0, y: 315, v: 15 },
    { r: 90, p: 0, y: 0, v: 16 }, { r: 90, p: 0, y: 45, v: 17 }, { r: 90, p: 0, y: 90, v: 18 },
    { r: 90, p: 0, y: 135, v: 19 }, { r: 270, p: 0, y: 0, v: 20 }, { r: 270, p: 0, y: 45, v: 21 },
    { r: 270, p: 0, y: 90, v: 22 }, { r: 270, p: 0, y: 135, v: 23 },
    { r: 0, p: 90, y: 0, v: 24 }, { r: 0, p: 270, y: 0, v: 25 },
    { r: 0, p: 180, y: 90, v: 26 }, { r: 0, p: 180, y: 270, v: 27 },
    { r: 90, p: 90, y: 0, v: 28 }, { r: 180, p: 90, y: 0, v: 29 }, { r: 270, p: 90, y: 0, v: 30 },
    { r: 90, p: 180, y: 0, v: 31 }, { r: 270, p: 180, y: 0, v: 32 },
    { r: 90, p: 270, y: 0, v: 33 }, { r: 180, p: 270, y: 0, v: 34 }, { r: 270, p: 270, y: 0, v: 35 },
    { r: 90, p: 180, y: 90, v: 36 }, { r: 90, p: 0, y: 270, v: 37 },
    { r: 0, p: 315, y: 0, v: 39 }, { r: 90, p: 315, y: 0, v: 40 },
]
const ROLL_OPTS = [0, 90, 180, 270]
const PITCH_OPTS = [0, 90, 180, 270, 315]
const YAW_OPTS = [0, 45, 90, 135, 180, 225, 270, 315]
type Rpy = { r: number; p: number; y: number }
const rpyOf = (v: number): Rpy | null => ROT_TABLE.find(e => e.v === v) ?? null

function rotationLabel(v: number | null): string {
    if (v === null) return '...'
    if (v === -1) return 'Internal'
    const d = rpyOf(v)
    if (!d) return `#${v}`
    if (d.r === 0 && d.p === 0 && d.y === 0) return 'Not rotated'
    return [d.r ? `Roll ${d.r}°` : '', d.p ? `Pitch ${d.p}°` : '', d.y ? `Yaw ${d.y}°` : ''].filter(Boolean).join(', ')
}
const ROT_OPTIONS = ROT_TABLE.map(e => ({ value: e.v, label: rotationLabel(e.v) }))

// ── Device ids (PX4 device_id bitfield) ─────────────────────────────────────

const BUS: Record<number, string> = { 1: 'I2C', 2: 'SPI', 3: 'DroneCAN', 4: 'Simulated', 5: 'Serial', 6: 'MAVLink' }
const DEVTYPE: Record<number, string> = {
    0x01: 'HMC5883', 0x03: 'Sim', 0x04: 'AK8963', 0x05: 'LIS3MDL', 0x06: 'IST8310', 0x07: 'RM3100', 0x08: 'QMC5883L',
    0x09: 'AK09916', 0x0A: 'VCM1193L', 0x0B: 'IST8308', 0x0D: 'MMC5983MA', 0x0E: 'IIS2MDC', 0x0F: 'QMC5883P',
    0x11: 'LSM303D', 0x14: 'Sim', 0x21: 'MPU6000', 0x22: 'L3GD20', 0x24: 'MPU9250', 0x25: 'ICM20649', 0x26: 'ICM42688P',
    0x27: 'ICM40609D', 0x28: 'ICM20948', 0x29: 'ICM42605', 0x2A: 'ICM42670P', 0x2B: 'IIM42652', 0x2C: 'IAM20680HP',
    0x2D: 'ICM42686P', 0x2E: 'IIM42653', 0x33: 'MPU6050', 0x34: 'ICM45686', 0x35: 'MPU6050', 0x36: 'MPU6500',
    0x37: 'BMI270', 0x38: 'ICM20602', 0x3A: 'ICM20608G', 0x3C: 'ICM20689', 0x3D: 'MS5611', 0x3E: 'MS5607',
    0x3F: 'BMP280', 0x40: 'LPS25H', 0x41: 'BMI055', 0x42: 'BMI055', 0x43: 'BMM150', 0x44: 'LSM9DS1', 0x45: 'LSM9DS1',
    0x4D: 'TCBP001TA', 0x4E: 'MS5837', 0x4F: 'SPL06', 0x50: 'LPS33HW', 0x51: 'MPL3115A2', 0x52: 'FXOS8701C',
    0x54: 'FXAS2100C', 0x57: 'ADIS16448', 0x58: 'ADIS16470', 0x59: 'ADIS16477', 0x5A: 'ADIS16507', 0x5B: 'SCH16T',
    0x5F: 'MPC2520', 0x60: 'LPS22HB', 0x61: 'LSM303AGR', 0x62: 'LSM303AGR', 0x63: 'ADIS16497', 0x65: 'Sim',
    0x66: 'BMI088', 0x67: 'BMP388', 0x68: 'DPS310', 0x6A: 'BMI088', 0x6C: 'BMI085', 0x6D: 'BMI085', 0x6E: 'BMP390',
    0x6F: 'BMP581', 0x80: 'DroneCAN', 0x81: 'DroneCAN', 0x86: 'DroneCAN', 0x87: 'DroneCAN', 0x88: 'DroneCAN',
    0xB7: 'ICP101XX', 0xB8: 'ICP201XX', 0xE5: 'BMM350', 0xE7: 'AUAV', 0xE8: 'SPA06',
}

function describeDevice(id: number): { chip: string; where: string } {
    const busType = id & 0x7, bus = (id >> 3) & 0x1f, addr = (id >> 8) & 0xff, dev = (id >> 16) & 0xff
    const chip = DEVTYPE[dev] ?? `Type 0x${dev.toString(16)}`
    const b = BUS[busType] ?? 'Unknown bus'
    const where = busType === 4 ? 'Simulator' : busType === 3 ? `DroneCAN node ${addr}` : `${b} ${bus}, address 0x${addr.toString(16).padStart(2, '0')}`
    return { chip, where }
}

const PRIO_OPTS = [
    { value: -1, label: 'Not set' }, { value: 0, label: 'Disabled' }, { value: 1, label: 'Lowest' },
    { value: 25, label: 'Low' }, { value: 50, label: 'Normal' }, { value: 75, label: 'High' }, { value: 100, label: 'Highest' },
]

// ── Steps ───────────────────────────────────────────────────────────────────

const CAL_ICON: Record<string, React.ElementType> = {
    gyro: RotateCw, accel: Move3d, mag: CompassIcon, level: AlignCenterHorizontal, gimbal: Camera, airspeed: Wind,
}
const CAL_HEALTH_FLAG: Record<string, 'gyro_cal_ok' | 'accel_cal_ok' | 'mag_cal_ok'> = {
    gyro: 'gyro_cal_ok', accel: 'accel_cal_ok', mag: 'mag_cal_ok',
}
/** One line each, visible: what the operator physically does. */
const STEP_WHAT: Record<string, string> = {
    gyro: 'Set the drone down and keep it completely still.',
    accel: 'Hold it still in six positions, one after another.',
    mag: 'Outdoors, away from metal. Rotate it around each axis.',
    level: 'On a truly level surface. Fixes drift in a steady hover.',
    gimbal: 'Only for a gimbal with its own IMU. Hold it level.',
}
const REQUIRED = ['gyro', 'accel', 'mag', 'level']

type Tab = 'calibrate' | 'sensors' | 'orientation'

export function SensorsSetup() {
    const [tab, setTab] = useState<Tab>('calibrate')
    const cal = useCalibration()
    const live = useConfigLive(true)
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SubTabs<Tab> label="Sensor setup" value={tab} onChange={setTab} tabs={[
                { id: 'calibrate', label: 'Calibrate' },
                { id: 'sensors', label: 'Sensor list' },
                { id: 'orientation', label: 'Orientation and trims' },
            ]} />
            <div role="tabpanel">
                {tab === 'calibrate' && <CalibrateTab cal={cal} live={live.data} onOrientation={() => setTab('orientation')} />}
                {tab === 'sensors' && <SensorsTab live={live.data} liveAt={live.at} />}
                {tab === 'orientation' && <OrientationTab />}
            </div>
        </div>
    )
}

// ── Calibrate tab ───────────────────────────────────────────────────────────

function CalibrateTab({ cal: calHook, live, onOrientation }: {
    cal: ReturnType<typeof useCalibration>; live: ConfigLive; onOrientation: () => void
}) {
    const { state: cal, refusal, busy, start, cancel, dismiss } = calHook
    const telemetry = useDroneStore(s => s.telemetry)
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const vp = useVehicleParams()

    // A run that finished OK this session counts as calibrated: PX4 keeps no
    // health flag for level or gimbal, and the flags for the others catch up
    // a second later. Updated during render on the transition itself.
    const [doneSession, setDoneSession] = useState<Record<string, boolean>>({})
    if (cal.phase === 'done' && cal.sensor && !doneSession[cal.sensor]) {
        setDoneSession(d => ({ ...d, [cal.sensor]: true }))
    }
    const [calLinked, setCalLinked] = useState(connected)
    if (connected !== calLinked) {
        setCalLinked(connected)
        if (!connected) setDoneSession({})
    }

    const health = connected && telemetry?.health?.received ? telemetry.health : null
    const verdict = (key: string): boolean | null => doneSession[key] ? true
        : health && CAL_HEALTH_FLAG[key] ? health[CAL_HEALTH_FLAG[key]] : null

    const required = CAL_SENSORS.filter(s => REQUIRED.includes(s.key))
    const optional = CAL_SENSORS.filter(s => !REQUIRED.includes(s.key))
    // The next step: the first required one PX4 says is not calibrated, or,
    // with no verdict at all, the first one this session has not finished.
    const nextKey = connected
        ? (required.find(s => verdict(s.key) === false) ?? required.find(s => verdict(s.key) === null))?.key ?? null
        : null
    const doneCount = required.filter(s => verdict(s.key) === true).length
    const nextAfter = (key: string) => {
        const i = required.findIndex(s => s.key === key)
        const n = required.slice(i + 1).find(s => verdict(s.key) !== true)
        return n ? { label: n.label, onStart: () => start(n.key) } : null
    }
    const nextSensor = required.find(s => s.key === nextKey)

    const boardRot = vp.get('SENS_BOARD_ROT')
    const hasAirspeed = airframeHasAirspeed(vp)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <HealthStrip live={live} doneSession={doneSession} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
                <Panel title="Calibration steps" hint={connected ? 'in this order' : 'connect a drone to start'}
                    right={connected ? <span style={{ fontSize: 13, fontWeight: 700, color: doneCount === required.length ? T.ok : T.muted, fontVariantNumeric: 'tabular-nums' }}>{doneCount} of {required.length} done</span> : undefined}
                    gap={8}>
                    <div aria-hidden style={{ height: 4, borderRadius: 2, background: T.surface2, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${(doneCount / required.length) * 100}%`, background: T.ok, transition: 'width var(--dur-slow) var(--ease-out)' }} />
                    </div>
                    <StepRow
                        n={1} icon={Cpu} label="Board orientation" mins="1 min"
                        what="Tell PX4 how the flight controller is mounted. Do this first."
                        chip={connected && boardRot != null ? <Chip tone={boardRot === 0 ? 'off' : 'accent'}>{rotationLabel(boardRot)}</Chip> : null}
                        state="info" connected={connected} busy={false}
                        action={<Btn onClick={onOrientation} disabled={!connected}>Review</Btn>}
                    />
                    {required.map((s, i) => (
                        <CalStep key={s.key} n={i + 2} sensor={s} verdict={verdict(s.key)} isNext={s.key === nextKey}
                            cal={cal} connected={connected} busy={busy} onStart={() => start(s.key)} />
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 2px 0' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.muted }}>Optional</span>
                        <span style={{ flex: 1, height: 1, background: T.border }} />
                    </div>
                    {optional.map(s => (
                        <CalStep key={s.key} sensor={s} verdict={verdict(s.key)} isNext={false}
                            cal={cal} connected={connected} busy={busy} onStart={() => start(s.key)} />
                    ))}
                    {hasAirspeed && (
                        <StepRow icon={Wind} label="Airspeed" mins="~1 min"
                            what="Not available from HYRAK yet. Its settings are on the Sensors tab."
                            state="info" connected={connected} busy={false}
                            action={<Btn disabled title="Airspeed calibration from HYRAK is not built yet">Start</Btn>} />
                    )}
                    {refusal && <Note tone="danger">{refusal}</Note>}
                </Panel>

                <CalibrationStage
                    state={cal}
                    onCancel={cancel}
                    onDismiss={dismiss}
                    onRetry={() => start(cal.sensor)}
                    onReboot={() => getSocket().emit('drone_action', { action: 'reboot' })}
                    sceneHeight={340}
                    idleTitle={!connected ? 'Connect a drone to calibrate'
                        : nextSensor ? `Next: ${nextSensor.label}`
                        : 'All sensors calibrated'}
                    idleSub={!connected ? 'Once connected, this model follows the drone\'s live attitude.'
                        : nextSensor ? `${STEP_WHAT[nextSensor.key]} Press Start on the left when ready.`
                        : 'This model follows the real drone. Turn it and watch.'}
                    next={cal.sensor ? nextAfter(cal.sensor) : null}
                />
            </div>
        </div>
    )
}

function StepRow({ n, icon: Icon, label, mins, what, chip, state, isNext, running, progress, connected, action }: {
    n?: number; icon: React.ElementType; label: string; mins: string; what: string; chip?: React.ReactNode
    state: 'ok' | 'warn' | 'info' | 'running' | 'failed'; isNext?: boolean; running?: boolean; progress?: number
    connected: boolean; busy: boolean; action: React.ReactNode
}) {
    const c = state === 'ok' ? T.ok : state === 'running' || state === 'warn' ? T.warn : state === 'failed' ? T.danger : isNext ? T.accent : null
    const edge = isNext && state !== 'running' ? T.accent : c
    return (
        <div style={{
            position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10,
            background: state === 'running' ? mix('var(--app-warn)', 6) : isNext ? mix('var(--app-accent)', 5) : T.surface2,
            border: `1px solid ${edge ? mix(edge, isNext || state === 'running' ? 45 : 26) : T.border}`,
            transition: 'border-color var(--dur-slow) var(--ease-out), background-color var(--dur-slow) var(--ease-out)',
            opacity: connected ? 1 : 0.85, overflow: 'hidden',
        }}>
            <span aria-hidden style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                background: state === 'ok' ? T.ok : c ? mix(c, 12) : T.surface,
                color: state === 'ok' ? 'hsl(var(--app-surface))' : c ?? T.muted,
                border: state === 'ok' ? 'none' : `1px solid ${c ? mix(c, 40) : T.borderStrong}`,
            }}>
                {state === 'ok' ? <Check size={16} strokeWidth={3} />
                    : running ? <Loader size={15} className="animate-spin motion-reduce:animate-none" />
                    : n ?? <Icon size={15} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{label}</span>
                    <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{mins}</span>
                    {chip}
                </div>
                <p style={{ margin: '2px 0 0', fontSize: 13, lineHeight: 1.45, color: T.muted }}>{what}</p>
            </div>
            {action}
            {running && progress != null && (
                <span aria-hidden style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: `${progress}%`, background: T.warn, transition: 'width var(--dur-slow) var(--ease-out)' }} />
            )}
        </div>
    )
}

function CalStep({ n, sensor, verdict, isNext, cal, connected, busy, onStart }: {
    n?: number; sensor: (typeof CAL_SENSORS)[number]; verdict: boolean | null; isNext: boolean
    cal: ReturnType<typeof useCalibration>['state']; connected: boolean; busy: boolean; onStart: () => void
}) {
    const isActive = cal.sensor === sensor.key && cal.phase !== 'idle'
    const running = isActive && (cal.phase === 'running' || cal.phase === 'starting')
    const failed = isActive && cal.phase === 'failed'
    const progress = Math.max(0, Math.min(100, cal.progress ?? 0))
    const state = running ? 'running' : failed ? 'failed' : verdict === true ? 'ok' : verdict === false ? 'warn' : 'info'
    const chip = running ? <Chip tone="warn">Running {progress}%</Chip>
        : failed ? <Chip tone="danger">Failed</Chip>
        : verdict === false ? <Chip tone="warn">Needs calibration</Chip>
        : verdict === true ? <Chip tone="ok">Calibrated</Chip>
        : null
    const can = connected && !busy
    return (
        <StepRow n={n} icon={CAL_ICON[sensor.key] ?? Activity} label={sensor.label} mins={sensor.mins}
            what={STEP_WHAT[sensor.key] ?? sensor.blurb} chip={chip} state={state} isNext={isNext && !running}
            running={running} progress={progress} connected={connected} busy={busy}
            action={running ? <span style={{ fontSize: 13, fontWeight: 700, color: T.warn, minWidth: 64, textAlign: 'center' }}>Running</span>
                : <Btn kind={isNext ? 'primary' : 'quiet'} onClick={onStart} disabled={!can}
                    title={connected ? `Start ${sensor.label} calibration` : 'Connect a drone first'}>
                    {failed ? 'Retry' : verdict === true ? 'Redo' : 'Start'}
                </Btn>}
        />
    )
}

// ── Health strip ────────────────────────────────────────────────────────────

function HealthStrip({ live, doneSession }: { live: ConfigLive; doneSession: Record<string, boolean> }) {
    const telemetry = useDroneStore(s => s.telemetry)
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const health = connected && telemetry?.health?.received ? telemetry.health : null
    const fix = telemetry?.gps?.fix_type ?? 0
    const sats = telemetry?.gps?.satellites_visible ?? 0
    const att = telemetry?.attitude
    const sys = live.SYS_STATUS
    const fault = (bit: number) => sysSensor(sys, bit) === 'fault'

    const gps: SensorStatus = !connected ? 'off' : fix >= 3 && !fault(SYS_SENSOR.gps) ? 'ok' : 'warn'
    const imuCal = health ? (health.gyro_cal_ok || doneSession.gyro) && (health.accel_cal_ok || doneSession.accel) : true
    const imu: SensorStatus = !connected ? 'off' : fault(SYS_SENSOR.gyro) || fault(SYS_SENSOR.accel) || !imuCal ? 'warn' : att ? 'ok' : 'warn'
    const magCal = health ? health.mag_cal_ok || doneSession.mag : true
    const mag: SensorStatus = !connected ? 'off' : fault(SYS_SENSOR.mag) || !magCal ? 'warn' : 'ok'
    const baro: SensorStatus = !connected ? 'off' : fault(SYS_SENSOR.baro) ? 'warn' : 'ok'

    const ek = live.ESTIMATOR_STATUS
    const ratios = ek ? [ek.vel_ratio, ek.pos_horiz_ratio, ek.pos_vert_ratio, ek.mag_ratio, ek.hagl_ratio].filter((v): v is number => v != null) : []
    const worst = ratios.length ? Math.max(...ratios) : null
    const ekf: SensorStatus = !connected ? 'off'
        : worst != null ? (worst < 1 ? 'ok' : 'warn')
        : health ? (health.local_position_ok ? 'ok' : 'warn') : 'off'

    const vib = live.VIBRATION
    const vibMax = vib ? Math.max(vib.vibration_x ?? 0, vib.vibration_y ?? 0, vib.vibration_z ?? 0) : null
    const sp = live.SCALED_PRESSURE

    const cards: { icon: React.ElementType; title: string; status: SensorStatus; chip: string; value: string; sub: string }[] = [
        { icon: Satellite, title: 'GPS', status: gps, chip: !connected ? 'Off' : GPS_FIX_LABEL[fix] ?? `Fix ${fix}`,
            value: connected ? `${sats} satellites` : '-',
            sub: connected && ek?.pos_horiz_accuracy != null ? `Accuracy ${ek.pos_horiz_accuracy.toFixed(1)} m` : 'Global position' },
        { icon: Activity, title: 'IMU', status: imu,
            chip: !connected ? 'Off' : fault(SYS_SENSOR.gyro) || fault(SYS_SENSOR.accel) ? 'Fault' : !imuCal ? 'Calibrate' : 'OK',
            value: connected && att ? `Roll ${att.roll_deg?.toFixed(1)}°, pitch ${att.pitch_deg?.toFixed(1)}°` : '-',
            sub: vibMax != null ? `Vibration ${vibMax.toFixed(1)} m/s²` : 'Accelerometer and gyro' },
        { icon: CompassIcon, title: 'Compass', status: mag,
            chip: !connected ? 'Off' : fault(SYS_SENSOR.mag) ? 'Fault' : !magCal ? 'Calibrate' : 'OK',
            value: connected && telemetry?.heading_deg != null ? `${telemetry.heading_deg.toFixed(0)}° heading` : '-',
            sub: ek?.mag_ratio != null ? `Fit ${ratioWord(ek.mag_ratio)}` : 'Magnetic heading' },
        { icon: Mountain, title: 'Barometer', status: baro, chip: !connected ? 'Off' : fault(SYS_SENSOR.baro) ? 'Fault' : 'OK',
            value: connected && telemetry?.position ? `${(telemetry.position.relative_altitude_m ?? 0).toFixed(1)} m above home` : '-',
            sub: sp?.press_abs != null ? `${sp.press_abs.toFixed(1)} hPa${sp.temperature != null ? `, ${(sp.temperature / 100).toFixed(0)} °C` : ''}` : 'Zeroed at boot' },
        { icon: Waypoints, title: 'Estimator', status: ekf,
            chip: !connected ? 'Off' : worst != null ? (worst < 1 ? 'OK' : 'Check') : health ? (health.local_position_ok ? 'OK' : 'No position') : 'No data',
            value: worst != null ? `Worst check ${Math.round(worst * 100)}%` : connected ? (health?.local_position_ok ? 'Position OK' : '-') : '-',
            sub: 'EKF2 consistency' },
    ]
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 8 }}>
            {cards.map(c => {
                const col = STATUS_COLOUR[c.status]
                return (
                    <div key={c.title} style={{
                        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, padding: '10px 12px', borderRadius: 10,
                        background: T.surface, border: `1px solid ${c.status === 'off' ? T.border : mix(col, 30)}`,
                        boxShadow: c.status === 'warn' ? `inset 3px 0 0 ${col}` : undefined,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <c.icon size={15} style={{ color: col, flexShrink: 0 }} aria-hidden />
                            <span style={{ fontSize: 14, fontWeight: 700, color: T.text, flex: 1, minWidth: 0 }}>{c.title}</span>
                            <StatusChip status={c.status} text={c.chip} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: c.status === 'off' ? T.muted : T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.value}</p>
                            <p style={{ margin: '1px 0 0', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</p>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

/** EKF test ratio in words: under 0.5 good, under 1 fair, over 1 failing. */
function ratioWord(r: number): string {
    return r < 0.5 ? 'good' : r < 1 ? 'fair' : 'failing'
}

// ── Sensors tab ─────────────────────────────────────────────────────────────

function SensorsTab({ live, liveAt }: { live: ConfigLive; liveAt: number }) {
    const vp = useVehicleParams()
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ParamSourceBar what="the sensor list" />
            <CompassPanel />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
                <InstancePanel />
                <LiveReadings live={live} liveAt={liveAt} />
            </div>
            {airframeHasAirspeed(vp) && <AirspeedPanel />}
        </div>
    )
}

function slots(vp: ReturnType<typeof useVehicleParams>, prefix: string): number[] {
    return [0, 1, 2, 3].filter(i => vp.has(`${prefix}${i}_ID`))
}

function CompassPanel() {
    const vp = useVehicleParams()
    const telemetry = useDroneStore(s => s.telemetry)
    const health = vp.connected && telemetry?.health?.received ? telemetry.health : null
    const all = slots(vp, 'CAL_MAG')
    const used = all.filter(i => (vp.get(`CAL_MAG${i}_ID`) ?? 0) !== 0)
    return (
        <Panel title="Compasses" hint={vp.ready ? `${used.length} found` : undefined}
            right={<><Tip text="Every compass PX4 has a calibration for (CAL_MAGn_*). The highest priority healthy one is used for heading. Disable a compass that sits next to power wiring or motors. External compasses need their rotation set; internal ones follow the board." /><ReloadButton /></>}>
            {!vp.ready ? (
                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>{vp.connected ? 'Reading parameters...' : 'Connect a drone to list its compasses.'}</p>
            ) : used.length === 0 ? (
                <Note tone="warn">No compass has been calibrated on this drone yet. Run the compass calibration on the Calibrate tab; detected compasses appear here afterwards.</Note>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        <thead><tr style={{ textAlign: 'left', color: T.muted }}>
                            {['Compass', 'Device', 'Calibration', 'Use', 'Priority', 'Rotation'].map(h => <th key={h} style={TH}>{h}</th>)}
                        </tr></thead>
                        <tbody>
                            {used.map(i => {
                                const id = vp.get(`CAL_MAG${i}_ID`) ?? 0
                                const rot = vp.get(`CAL_MAG${i}_ROT`)
                                const prio = vp.get(`CAL_MAG${i}_PRIO`)
                                const hasEn = vp.has(`CAL_MAG${i}_EN`)
                                const enabled = hasEn ? (vp.get(`CAL_MAG${i}_EN`) ?? 1) !== 0 : prio !== 0
                                const internal = rot === -1
                                const d = describeDevice(id)
                                const off = ['X', 'Y', 'Z'].map(a => vp.get(`CAL_MAG${i}_${a}OFF`) ?? 0)
                                const hasOffsets = off.some(v => Math.abs(v) > 1e-6)
                                return (
                                    <tr key={i}>
                                        <td style={TD}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <b style={{ fontSize: 14 }}>Mag {i}</b>
                                                <Chip tone={internal ? 'off' : 'accent'}>{internal ? 'Internal' : 'External'}</Chip>
                                            </div>
                                        </td>
                                        <td style={TD}>
                                            <div style={{ fontWeight: 600, color: T.text }}>{d.chip}</div>
                                            <div style={{ fontSize: 12, color: T.muted }} title={`Device id ${id}`}>{d.where}</div>
                                        </td>
                                        <td style={TD}>
                                            {health && !health.mag_cal_ok ? <Chip tone="warn">Recalibrate</Chip>
                                                : <Chip tone="ok">Calibrated</Chip>}
                                            <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }} title="Hard-iron offsets, gauss">
                                                {hasOffsets ? `Offsets ${off.map(v => v.toFixed(2)).join(' / ')}` : 'No offsets stored'}
                                            </div>
                                        </td>
                                        <td style={TD}>
                                            <Toggle label={`Use Mag ${i}`} value={enabled}
                                                disabled={hasEn ? false : prio == null}
                                                onChange={on => hasEn ? writeParam(`CAL_MAG${i}_EN`, on ? 1 : 0) : writeParam(`CAL_MAG${i}_PRIO`, on ? 50 : 0)} />
                                        </td>
                                        <td style={TD}>
                                            <OptionSelect size="sm" aria-label={`Mag ${i} priority`} className={SEL}
                                                value={prio} disabled={prio == null}
                                                onChange={v => writeParam(`CAL_MAG${i}_PRIO`, v)}
                                                options={PRIO_OPTS.some(o => o.value === prio) || prio == null ? PRIO_OPTS : [...PRIO_OPTS, { value: prio, label: String(prio) }]} />
                                        </td>
                                        <td style={TD}>
                                            {internal ? <span style={{ color: T.muted }}>Follows the board</span> : (
                                                <OptionSelect size="sm" aria-label={`Mag ${i} rotation`} className={SEL + ' min-w-[170px]'}
                                                    value={rot} disabled={rot == null}
                                                    onChange={v => writeParam(`CAL_MAG${i}_ROT`, v)} options={ROT_OPTIONS} />
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {vp.ready && vp.has('SENS_MAG_AUTOROT') && (
                <ParamRow compact spec={{ key: 'SENS_MAG_AUTOROT', label: 'Detect external compass rotation', bool: true, tip: 'During compass calibration PX4 works out how each external compass is rotated and saves it. Turn off only if detection picks the wrong rotation.' }} />
            )}
        </Panel>
    )
}

function InstancePanel() {
    const vp = useVehicleParams()
    const telemetry = useDroneStore(s => s.telemetry)
    const health = vp.connected && telemetry?.health?.received ? telemetry.health : null
    const groups = [
        { prefix: 'CAL_ACC', name: 'Accel', ok: health?.accel_cal_ok },
        { prefix: 'CAL_GYRO', name: 'Gyro', ok: health?.gyro_cal_ok },
        { prefix: 'CAL_BARO', name: 'Baro', ok: undefined },
    ]
    const rows = groups.flatMap(g => slots(vp, g.prefix).filter(i => (vp.get(`${g.prefix}${i}_ID`) ?? 0) !== 0).map(i => ({ ...g, i })))
    return (
        <Panel title="IMUs and barometers" right={<Tip text="Accelerometers, gyroscopes and barometers PX4 has a calibration for. The highest priority healthy one is used; set one to Disabled to take it out of use." />}>
            {!vp.ready ? (
                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>{vp.connected ? 'Reading parameters...' : 'Connect a drone to list its sensors.'}</p>
            ) : rows.length === 0 ? (
                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>No calibrated IMU or barometer yet.</p>
            ) : (
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                    <thead><tr style={{ textAlign: 'left', color: T.muted }}>
                        {['Sensor', 'Device', 'Priority'].map(h => <th key={h} style={TH}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                        {rows.map(r => {
                            const id = vp.get(`${r.prefix}${r.i}_ID`) ?? 0
                            const d = describeDevice(id)
                            const prio = vp.get(`${r.prefix}${r.i}_PRIO`)
                            return (
                                <tr key={`${r.prefix}${r.i}`}>
                                    <td style={TD}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <b style={{ fontSize: 14 }}>{r.name} {r.i}</b>
                                            {r.ok === false && <Chip tone="warn">Recalibrate</Chip>}
                                        </div>
                                    </td>
                                    <td style={TD}>
                                        <div style={{ fontWeight: 600, color: T.text }}>{d.chip}</div>
                                        <div style={{ fontSize: 12, color: T.muted }}>{d.where}</div>
                                    </td>
                                    <td style={TD}>
                                        {prio == null ? <span style={{ color: T.muted }}>-</span> : (
                                            <OptionSelect size="sm" aria-label={`${r.name} ${r.i} priority`} className={SEL}
                                                value={prio} onChange={v => writeParam(`${r.prefix}${r.i}_PRIO`, v)}
                                                options={PRIO_OPTS.some(o => o.value === prio) ? PRIO_OPTS : [...PRIO_OPTS, { value: prio, label: String(prio) }]} />
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            )}
        </Panel>
    )
}

const G = 9.80665
function LiveReadings({ live, liveAt }: { live: ConfigLive; liveAt: number }) {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const hi = live.HIGHRES_IMU
    const sc = live.SCALED_IMU
    // HIGHRES_IMU is in SI units; SCALED_IMU in milli-units.
    const acc = hi ? [hi.xacc, hi.yacc, hi.zacc] : sc ? [sc.xacc, sc.yacc, sc.zacc].map(v => v == null ? v : v * G / 1000) : null
    const gyr = hi ? [hi.xgyro, hi.ygyro, hi.zgyro].map(v => v == null ? v : v * 180 / Math.PI) : sc ? [sc.xgyro, sc.ygyro, sc.zgyro].map(v => v == null ? v : v * 0.180 / Math.PI) : null
    const mag = hi ? [hi.xmag, hi.ymag, hi.zmag] : sc ? [sc.xmag, sc.ymag, sc.zmag].map(v => v == null ? v : v / 1000) : null
    const sp = live.SCALED_PRESSURE
    const vib = live.VIBRATION
    const ek = live.ESTIMATOR_STATUS
    const xyz = (v: (number | undefined)[] | null, d: number) => v ? v.map(n => n == null ? '-' : n.toFixed(d)).join('  ') : '-'
    const noFeed = connected && liveAt === 0
    return (
        <Panel title="Live readings" hint={connected ? (liveAt ? 'from the drone' : 'waiting for data') : undefined}
            right={<Tip text="Raw values straight from the drone's telemetry, read passively. Nothing here is sent to the drone." />}>
            {!connected ? <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Connect a drone to see live sensor values.</p> : noFeed ? (
                <Note>No live readings yet. If this stays empty, the HYRAK server needs a restart to pick up live readings.</Note>
            ) : (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                        <RowL k="Accelerometer" v={xyz(acc, 2)} u="m/s²" />
                        <RowL k="Gyroscope" v={xyz(gyr, 1)} u="°/s" />
                        <RowL k="Magnetometer" v={xyz(mag, 3)} u="gauss" />
                        <RowL k="Barometer" v={sp?.press_abs != null ? `${sp.press_abs.toFixed(2)} hPa${sp.temperature != null ? `, ${(sp.temperature / 100).toFixed(1)} °C` : ''}` : '-'} />
                        <RowL k="Vibration" v={vib ? xyz([vib.vibration_x, vib.vibration_y, vib.vibration_z], 2) : '-'} u={vib ? `m/s², clipping ${(vib.clipping_0 ?? 0) + (vib.clipping_1 ?? 0) + (vib.clipping_2 ?? 0)}` : undefined} />
                    </div>
                    {!acc && <p style={{ margin: 0, fontSize: 12, color: T.muted, lineHeight: 1.5 }}>Raw accelerometer, gyro and compass values are not part of PX4&apos;s normal telemetry stream on this link, so they show as dashes. Their health above still comes from PX4.</p>}
                    {ek && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: T.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                                Estimator checks <Tip text="EKF2 test ratios: how far each sensor disagrees with the estimate, as a share of what PX4 tolerates. Under 50% is good; over 100% means PX4 is rejecting that sensor." />
                            </span>
                            {([['Velocity', ek.vel_ratio], ['Horizontal position', ek.pos_horiz_ratio], ['Height', ek.pos_vert_ratio], ['Compass', ek.mag_ratio], ['Height above ground', ek.hagl_ratio]] as [string, number | undefined][])
                                .filter(([, v]) => v != null).map(([k, v]) => <RatioBar key={k} label={k} v={v as number} />)}
                        </div>
                    )}
                </>
            )}
        </Panel>
    )
}

function RowL({ k, v, u }: { k: string; v: string; u?: string }) {
    return (
        <>
            <span style={{ color: T.muted, fontWeight: 600 }}>{k}</span>
            <span style={{ color: v === '-' || v.startsWith('-  -') ? T.muted : T.text, whiteSpace: 'pre' }}>{v}{u && v !== '-' ? <span style={{ color: T.muted }}>  {u}</span> : null}</span>
        </>
    )
}

function RatioBar({ label, v }: { label: string; v: number }) {
    const c = v < 0.5 ? T.ok : v < 1 ? T.warn : T.danger
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 44px', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{ color: T.muted }}>{label}</span>
            <span style={{ height: 6, borderRadius: 3, background: T.surface2, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.min(100, v * 100)}%`, background: c, transition: 'width var(--dur) var(--ease-out)' }} />
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c, fontWeight: 700 }}>{Math.round(v * 100)}%</span>
        </div>
    )
}

/** Does this airframe have an airspeed sensor? PX4 says so through
 *  SYS_HAS_NUM_ASPD, or through an enabled airspeed driver. */
function airframeHasAirspeed(vp: ReturnType<typeof useVehicleParams>): boolean {
    if (!vp.ready) return false
    if ((vp.get('SYS_HAS_NUM_ASPD') ?? 0) > 0) return true
    return ['SENS_EN_MS4525DO', 'SENS_EN_MS5525DS', 'SENS_EN_SDP3X', 'SENS_EN_ETSASPD', 'SENS_EN_ASP5033', 'SENS_EN_AUAVX']
        .some(k => (vp.get(k) ?? 0) > 0)
}

function AirspeedPanel() {
    return (
        <Panel title="Airspeed sensor" right={<Tip text="Airspeed calibration zeroes the differential pressure sensor (SENS_DPRES_OFF). Shield the pitot from wind, then blow into it when PX4 asks." />}>
            <Note>Airspeed calibration cannot be started from HYRAK yet. The settings below are live.</Note>
            <ParamRow spec={{ key: 'SENS_DPRES_OFF', label: 'Pressure offset', unit: 'Pa', decimals: 2, tip: 'Set by the airspeed calibration. Zero means it was never calibrated.' }} />
            <ParamRow spec={{ key: 'ASPD_SCALE_1', label: 'Airspeed scale', decimals: 3, tip: 'Corrects the indicated airspeed. PX4 can learn it in flight (ASPD_SCALE_APPLY).' }} />
            <ParamRow spec={{ key: 'CAL_AIR_CMODEL', label: 'Tube model', options: [{ value: 0, label: 'With pitot' }, { value: 1, label: 'Without pitot' }, { value: 2, label: 'Pressure loss only' }], tip: 'How PX4 corrects for the pitot tubing.' }} />
            <ParamRow spec={{ key: 'CAL_AIR_TUBELEN', label: 'Tube length', unit: 'm', decimals: 2 }} />
            <ParamRow spec={{ key: 'CAL_AIR_TUBED_MM', label: 'Tube diameter', unit: 'mm', decimals: 1 }} />
        </Panel>
    )
}

// ── Orientation tab ─────────────────────────────────────────────────────────

function OrientationTab() {
    const vp = useVehicleParams()
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ParamSourceBar what="the mounting setup" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
                <BoardOrientation />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <Panel title="Level trims" hint="small corrections, in degrees"
                        right={<Tip text="Fine corrections for a board that is mounted slightly off level. Level Horizon calibration sets these for roll and pitch; edit them by hand only to nudge a drift." />}>
                        <ParamRow spec={{ key: 'SENS_BOARD_X_OFF', label: 'Roll trim', unit: '°', decimals: 2, def: 0, min: -45, max: 45, tip: 'Positive tilts the reference right.' }} />
                        <ParamRow spec={{ key: 'SENS_BOARD_Y_OFF', label: 'Pitch trim', unit: '°', decimals: 2, def: 0, min: -45, max: 45, tip: 'Positive tilts the reference nose up.' }} />
                        <ParamRow spec={{ key: 'SENS_BOARD_Z_OFF', label: 'Yaw trim', unit: '°', decimals: 2, def: 0, min: -45, max: 45 }} />
                    </Panel>
                    <Panel title="Factory calibration" right={<Tip text="On boards with separate calibration storage, calibrations made in this mode survive a parameter reset (SYS_FAC_CAL_MODE)." />}>
                        {vp.ready && !vp.has('SYS_FAC_CAL_MODE')
                            ? <p style={{ margin: 0, fontSize: 14, color: T.muted }}>This flight controller does not offer factory calibration.</p>
                            : <>
                                <ParamRow spec={{ key: 'SYS_FAC_CAL_MODE', label: 'Store next calibrations as factory', def: 0, options: [{ value: 0, label: 'Off' }, { value: 1, label: 'All sensors' }, { value: 2, label: 'All except compass' }] }} />
                                <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>Only works on boards with a separate calibration memory. Turn it on, run the calibrations, then turn it off.</p>
                            </>}
                    </Panel>
                </div>
            </div>
        </div>
    )
}

/** Board rotation (SENS_BOARD_ROT) as three dropdowns: nobody mounts a board
 *  in enum values. A combination PX4 has no value for stays visibly unsaved. */
function BoardOrientation() {
    const vp = useVehicleParams()
    const v = vp.get('SENS_BOARD_ROT')
    const [draft, setDraft] = useState<Rpy | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [savedV, setSavedV] = useState<number | null>(null)
    const enabled = vp.ready && v != null
    const shown: Rpy = draft ?? (v != null ? rpyOf(v) : null) ?? { r: 0, p: 0, y: 0 }
    const rebootNeeded = savedV != null && v === savedV

    const pick = (axis: 'r' | 'p' | 'y', deg: number) => {
        const next = { ...shown, [axis]: deg }
        const entry = ROT_TABLE.find(e => e.r === next.r && e.p === next.p && e.y === next.y)
        if (entry) {
            setError(null); setDraft(null); setSavedV(entry.v)
            writeParam('SENS_BOARD_ROT', entry.v)
        } else {
            setDraft(next)
            setError(`PX4 has no rotation for roll ${next.r}°, pitch ${next.p}°, yaw ${next.y}°. Change one axis.`)
        }
    }
    return (
        <Panel title="Board orientation" hint={vp.ready && v != null ? rotationLabel(v) : undefined}
            right={<Tip text="How the flight controller is turned relative to the airframe (SENS_BOARD_ROT). All zeros: its arrow points at the nose, component side up. Set this BEFORE calibrating; it applies after a reboot." />}>
            <BoardDiagram rpy={shown} />
            <div style={{ display: 'flex', gap: 8 }}>
                {([['r', 'Roll', ROLL_OPTS], ['p', 'Pitch', PITCH_OPTS], ['y', 'Yaw', YAW_OPTS]] as const).map(([axis, label, opts]) => (
                    <label key={axis} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}>{label}</span>
                        <OptionSelect size="sm" aria-label={`Board ${label}`} value={shown[axis]} disabled={!enabled}
                            onChange={d => pick(axis, d)} options={opts.map(d => ({ value: d, label: `${d}°` }))} />
                    </label>
                ))}
            </div>
            {error && <Note tone="danger">{error}</Note>}
            <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>External compasses have their own rotation, set per compass on the Sensor list tab.</p>
            {rebootNeeded && (
                <Note tone="warn">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ flex: 1, minWidth: 180 }}>Saved. PX4 applies it after a reboot; then redo the accelerometer and level calibrations.</span>
                        <Btn onClick={() => { getSocket().emit('drone_action', { action: 'reboot' }); setSavedV(null) }}
                            title="Restarts the flight controller. Only works while disarmed; the link drops and reconnects.">Reboot flight controller</Btn>
                    </div>
                </Note>
            )}
        </Panel>
    )
}

/** A top-down board with its arrow, turned by the yaw and flipped by a roll
 *  or pitch of 180. Enough to check the picture matches the drone. */
function BoardDiagram({ rpy }: { rpy: Rpy }) {
    const flipped = (rpy.r === 180) !== (rpy.p === 180)
    const tilted = rpy.r === 90 || rpy.r === 270 || rpy.p === 90 || rpy.p === 270 || rpy.p === 315
    const v = ROT_TABLE.find(e => e.r === rpy.r && e.p === rpy.p && e.y === rpy.y)?.v ?? 0
    return (
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <svg viewBox="0 0 200 150" width={200} height={150} role="img" aria-label={`Board drawn: ${rotationLabel(v)}`}>
                <text x={100} y={13} textAnchor="middle" fontSize={12} fontWeight={600} fill="hsl(var(--app-text-muted))" fontFamily="inherit">Nose</text>
                <path d="M100 18 L94 28 L106 28 Z" fill="hsl(var(--app-text-muted))" />
                <g style={{ transform: `translate(100px, 88px) rotate(${rpy.y}deg) scale(${tilted ? 0.5 : 1}, 1)`, transition: 'transform var(--dur-slow) var(--ease-out)' }}>
                    <rect x={-40} y={-50} width={80} height={100} rx={10}
                        fill={flipped ? 'hsl(var(--app-surface-2))' : mix('var(--app-accent)', 14)}
                        stroke={flipped ? 'hsl(var(--app-border-strong))' : 'var(--app-accent)'} strokeWidth={1.5} strokeDasharray={flipped ? '4 3' : undefined} />
                    <path d="M0 -34 L14 -6 L5 -6 L5 32 L-5 32 L-5 -6 L-14 -6 Z" fill={flipped ? 'hsl(var(--app-text-muted))' : 'var(--app-accent)'} />
                </g>
            </svg>
            <figcaption style={{ fontSize: 13, color: T.muted }}>
                {flipped ? 'Upside down, seen from above' : tilted ? 'Standing on its edge' : 'Component side up, seen from above'}
            </figcaption>
        </figure>
    )
}

const SEL = 'w-auto min-w-[120px] text-[13px] tabular-nums data-[size=sm]:h-8'
const TH: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', borderBottom: `1px solid ${T.border}` }
const TD: React.CSSProperties = { padding: '8px 8px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle', color: T.text }

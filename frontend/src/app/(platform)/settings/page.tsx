'use client'

import { useState, useEffect } from 'react'
import { useTheme } from '@/lib/theme'
import { Sun, Moon, Info, Zap } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMissionStore } from '@/store/mission'

// ── localStorage helpers ──────────────────────────────────────────────────────

function ls<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
    if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(val))
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function GroupLabel({ text }: { text: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 0 8px' }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.12em', color: 'hsl(var(--app-text-muted))' }}>{text}</span>
            <div style={{ flex: 1, height: 1, background: 'hsl(var(--app-border))' }} />
        </div>
    )
}

function PrefRow({ label, sub, tip, right }: { label: string; sub?: string; tip?: string; right: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
            <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 13, color: 'hsl(var(--app-text))' }}>{label}</span>
                    {tip && (
                        <Tooltip>
                            <TooltipTrigger style={{ background: 'none', border: 'none', padding: 0, cursor: 'help', display: 'flex' }}>
                                <Info size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                            </TooltipTrigger>
                            <TooltipContent style={{ maxWidth: 220, fontSize: 11, lineHeight: 1.5 }}>{tip}</TooltipContent>
                        </Tooltip>
                    )}
                </div>
                {sub && <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0', lineHeight: 1.4 }}>{sub}</p>}
            </div>
            <div style={{ flexShrink: 0 }}>{right}</div>
        </div>
    )
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
    return (
        <div onClick={onChange} style={{
            width: 38, height: 22, borderRadius: 11, cursor: 'pointer',
            background: value ? '#22d3ee' : 'hsl(var(--app-border))',
            position: 'relative', transition: 'background 0.18s', flexShrink: 0,
        }}>
            <div style={{ position: 'absolute', top: 4, width: 14, height: 14, borderRadius: '50%', background: 'white', left: value ? 20 : 4, transition: 'left 0.18s' }} />
        </div>
    )
}

function SegmentControl<T extends string>({ value, options, onChange }: {
    value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void
}) {
    return (
        <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))' }}>
            {options.map(o => (
                <button key={o.value} onClick={() => onChange(o.value)} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px',
                    borderRadius: 6, border: 'none', cursor: 'pointer',
                    background: value === o.value ? 'hsl(var(--app-surface))' : 'transparent',
                    color: value === o.value ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontFamily: 'monospace', fontWeight: value === o.value ? 600 : 400,
                    boxShadow: value === o.value ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                    transition: 'all 0.12s',
                }}>
                    {o.icon} {o.label}
                </button>
            ))}
        </div>
    )
}

function ChipGroup<T extends string>({ value, options, onChange }: {
    value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {options.map(o => (
                <button key={o.value} onClick={() => onChange(o.value)} style={{
                    padding: '5px 12px', borderRadius: 20, border: '1.5px solid',
                    borderColor: value === o.value ? '#22d3ee' : 'hsl(var(--app-border))',
                    background: value === o.value ? 'rgba(34,211,238,0.1)' : 'transparent',
                    color: value === o.value ? '#22d3ee' : 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontFamily: 'monospace', cursor: 'pointer', transition: 'all 0.12s',
                }}>
                    {o.label}
                </button>
            ))}
        </div>
    )
}

// ── Sections ──────────────────────────────────────────────────────────────────

function DisplayGroup() {
    const { theme, setTheme } = useTheme()
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])

    if (!mounted) return null

    return (
        <>
            <GroupLabel text="APPEARANCE" />
            <PrefRow
                label="Theme"
                sub="Changes the colour scheme of the entire interface"
                right={
                    <SegmentControl
                        value={(theme as any) ?? 'dark'}
                        onChange={v => setTheme(v as 'dark' | 'light')}
                        options={[
                            { value: 'dark',   label: 'Dark',   icon: <Moon size={12} /> },
                            { value: 'light',  label: 'Light',  icon: <Sun size={12} /> },
                        ]}
                    />
                }
            />
        </>
    )
}

function UnitsGroup() {
    const [distance, setDistance] = useState<string>(() => ls('hyrak-unit-dist', 'metric'))
    const [altitude, setAltitude] = useState<string>(() => ls('hyrak-unit-alt',  'meters'))
    const [speed,    setSpeed]    = useState<string>(() => ls('hyrak-unit-speed', 'ms'))

    const save = (key: string, val: string) => lsSet(key, val)

    return (
        <>
            <GroupLabel text="UNITS" />
            <PrefRow
                label="Distance"
                tip="Horizontal distance unit for map measurements and mission planning"
                right={
                    <ChipGroup value={distance as any} onChange={v => { setDistance(v); save('hyrak-unit-dist', v) }} options={[
                        { value: 'metric',   label: 'm / km' },
                        { value: 'imperial', label: 'ft / mi' },
                    ]} />
                }
            />
            <PrefRow
                label="Altitude"
                tip="Altitude unit for OSD, telemetry displays, and mission altitude inputs"
                right={
                    <ChipGroup value={altitude as any} onChange={v => { setAltitude(v); save('hyrak-unit-alt', v) }} options={[
                        { value: 'meters', label: 'Meters' },
                        { value: 'feet',   label: 'Feet' },
                    ]} />
                }
            />
            <PrefRow
                label="Speed"
                tip="Speed unit for OSD and telemetry displays"
                right={
                    <ChipGroup value={speed as any} onChange={v => { setSpeed(v); save('hyrak-unit-speed', v) }} options={[
                        { value: 'ms',    label: 'm/s' },
                        { value: 'kmh',   label: 'km/h' },
                        { value: 'knots', label: 'kts' },
                    ]} />
                }
            />
        </>
    )
}

function MapGroup() {
    const [style, setStyle] = useState<string>(() => ls('hyrak-map-style', 'satellite'))
    const [cache, setCache] = useState<boolean>(() => ls('hyrak-map-cache', true))

    return (
        <>
            <GroupLabel text="MAP" />
            <PrefRow
                label="Default map style"
                sub="Used in the Mission tab. Can be changed per-session there too."
                right={
                    <ChipGroup value={style as any} onChange={v => { setStyle(v); lsSet('hyrak-map-style', v) }} options={[
                        { value: 'satellite', label: 'Satellite' },
                        { value: 'streets',   label: 'Streets' },
                        { value: 'hybrid',    label: 'Hybrid' },
                        { value: 'terrain',   label: 'Terrain' },
                    ]} />
                }
            />
            <PrefRow
                label="Tile caching"
                sub="Cache map tiles locally — faster reload in areas you've already visited"
                tip="Stored in browser IndexedDB. Clear browser data to remove the cache."
                right={<Toggle value={cache} onChange={() => { const v = !cache; setCache(v); lsSet('hyrak-map-cache', v) }} />}
            />
        </>
    )
}

type NotifKeys = 'lowBattery' | 'signalLoss' | 'geofenceBreach' | 'missionComplete' | 'armDisarm'

function NotificationsGroup() {
    const [notifs, setNotifs] = useState<Record<NotifKeys, boolean>>(() => ls('hyrak-notifs', {
        lowBattery: true, signalLoss: true, geofenceBreach: true, missionComplete: true, armDisarm: false,
    }))

    const toggle = (k: NotifKeys) => setNotifs(prev => {
        const next = { ...prev, [k]: !prev[k] }
        lsSet('hyrak-notifs', next)
        return next
    })

    const rows: { key: NotifKeys; label: string; sub: string }[] = [
        { key: 'lowBattery',      label: 'Low battery',       sub: 'Warning when battery drops below the threshold in Config → Power' },
        { key: 'signalLoss',      label: 'Signal loss',        sub: 'Alert when RC or telemetry link drops out' },
        { key: 'geofenceBreach',  label: 'Geofence breach',   sub: 'Alert when approaching or exceeding the configured geofence' },
        { key: 'missionComplete', label: 'Mission complete',   sub: 'Notification when a mission finishes all waypoints' },
        { key: 'armDisarm',       label: 'Arm / Disarm',       sub: 'Confirmation each time the drone arms or disarms' },
    ]

    return (
        <>
            <GroupLabel text="ALERTS" />
            {rows.map(r => (
                <PrefRow key={r.key} label={r.label} sub={r.sub} right={<Toggle value={notifs[r.key]} onChange={() => toggle(r.key)} />} />
            ))}
        </>
    )
}

function DataGroup() {
    const [autoLog, setAutoLog] = useState(() => ls('hyrak-auto-log', true))
    const [logPath, setLogPath] = useState(() => ls('hyrak-log-path', '~/hyrak_logs'))
    const [autoUpload, setAutoUpload] = useState(() => ls('hyrak-auto-upload', false))

    return (
        <>
            <GroupLabel text="DATA & LOGS" />
            <PrefRow
                label="Auto-record telemetry"
                sub="Starts logging to file as soon as a drone connects"
                right={<Toggle value={autoLog} onChange={() => { const v = !autoLog; setAutoLog(v); lsSet('hyrak-auto-log', v) }} />}
            />
            <PrefRow
                label="Log directory"
                sub="Path on the server where flight logs and recorded video are saved"
                right={
                    <input
                        value={logPath}
                        onChange={e => { setLogPath(e.target.value); lsSet('hyrak-log-path', e.target.value) }}
                        style={{
                            padding: '6px 10px', borderRadius: 8, width: 200,
                            background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                        }}
                    />
                }
            />
            <PrefRow
                label="Upload logs after flight"
                sub="Automatically sync logs to the configured server endpoint after landing"
                tip="Endpoint can be configured when this feature is implemented."
                right={<Toggle value={autoUpload} onChange={() => { const v = !autoUpload; setAutoUpload(v); lsSet('hyrak-auto-upload', v) }} />}
            />
        </>
    )
}

const SHORTCUTS = [
    { key: 'Space',         action: 'Emergency stop' },
    { key: '↑ / ↓',        action: 'Throttle' },
    { key: '← / →',        action: 'Yaw' },
    { key: 'W / S',         action: 'Pitch forward / back' },
    { key: 'A / D',         action: 'Roll left / right' },
    { key: 'L',             action: 'Toggle left panel' },
    { key: 'R',             action: 'Toggle right panel' },
    { key: 'Ctrl+Z',        action: 'Undo last waypoint' },
    { key: 'Delete',        action: 'Remove selected waypoint' },
    { key: 'Ctrl+Enter',    action: 'Upload & start mission' },
    { key: 'Esc',           action: 'Close / cancel' },
]

function ShortcutsGroup() {
    return (
        <>
            <GroupLabel text="KEYBOARD SHORTCUTS" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
                {SHORTCUTS.map(s => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
                        <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>{s.action}</span>
                        <kbd style={{ padding: '2px 7px', borderRadius: 5, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))', whiteSpace: 'nowrap' }}>{s.key}</kbd>
                    </div>
                ))}
            </div>
        </>
    )
}

function MissionGroup() {
    const autoFollowOnMission    = useMissionStore(s => s.autoFollowOnMission)
    const setAutoFollowOnMission = useMissionStore(s => s.setAutoFollowOnMission)

    return (
        <>
            <GroupLabel text="MISSION" />
            <PrefRow
                label="Auto-follow on mission start"
                sub="Switches to 3D view and starts the chase camera when a mission begins"
                tip="When enabled, the moment the drone enters MISSION flight mode, the map switches to 3D and the camera locks behind the drone automatically. Disable this if you prefer to stay in 2D or control the view manually."
                right={<Toggle value={autoFollowOnMission} onChange={() => setAutoFollowOnMission(!autoFollowOnMission)} />}
            />
        </>
    )
}

function AboutGroup() {
    return (
        <>
            <GroupLabel text="ABOUT" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', margin: '4px 0 12px' }}>
                <div style={{ width: 44, height: 44, borderRadius: 11, background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Zap size={22} style={{ color: '#22d3ee' }} />
                </div>
                <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>Hyrak Control</p>
                    <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>Ground Control Station · 0.1.0-dev</p>
                </div>
            </div>
            {[
                { k: 'Frontend',   v: 'Next.js 15 · React 19 · TypeScript' },
                { k: 'Backend',    v: 'FastAPI · MAVSDK · aiortc' },
                { k: 'AI Runtime', v: 'CUDA 12 · PyTorch 2 · Ultralytics' },
                { k: 'Autopilots', v: 'PX4 · ArduPilot via MAVLink / MAVSDK' },
                { k: 'Platform',   v: 'Linux · RTX 4070 Laptop · 8 GB VRAM' },
            ].map(r => (
                <PrefRow key={r.k} label={r.k} right={<span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>{r.v}</span>} />
            ))}
        </>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
    return (
        <div style={{ height: '100%', overflowY: 'auto' }}>
            <div style={{ maxWidth: 680, margin: '0 auto', padding: '4px 32px 48px' }}>

                <div style={{ padding: '18px 0 4px' }}>
                    <h1 style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>App Settings</h1>
                    <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '3px 0 0' }}>Preferences saved to this device — not sent to the drone</p>
                </div>

                <DisplayGroup />
                <UnitsGroup />
                <MapGroup />
                <MissionGroup />
                <NotificationsGroup />
                <DataGroup />
                <ShortcutsGroup />
                <AboutGroup />

            </div>
        </div>
    )
}

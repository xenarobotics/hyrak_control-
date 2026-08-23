'use client'

import { useState, useEffect } from 'react'
import { useTheme } from '@/lib/theme'
import { getUiFont, setUiFont, getUiZoom, setUiZoom, getUiTextSize, setUiTextSize, UI_FONTS, UI_ZOOMS, UI_TEXT_SIZES, type UiFont, type UiTextSize } from '@/lib/uiPrefs'
import {
    Sun, Moon, MoonStar, Info, Zap,
    SlidersHorizontal, Video, Bot, Map, Route, Bell, Database, Keyboard, AlertTriangle, Radio,
    type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatRate, formatEta } from '@/lib/formatBytes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMissionStore } from '@/store/mission'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getVideoSettings, getFeedMode, RES_OPTIONS, FPS_OPTIONS, type VideoRes, type VideoFps, type FeedMode, getCrowdPreset, type CrowdPreset, getCrowdThresholds, getCrowdCustom, normaliseCrowdThresholds, getStandbyUplink, type StandbyUplink, getCaptureProfile, type CaptureProfile } from '@/lib/videoSettings'
import { getSocket } from '@/lib/socket'
import {
    fetchCalibration, saveCalibration, resetCalibration, derivedVfov, gsdAtNadir,
    type CalibrationField, type CalibrationSchema,
} from '@/lib/calibration'
import { useDroneStore } from '@/store/drone'
import { useDrone } from '@/hooks/useDrone'
import {
    getTelemetryAddress, setTelemetryAddress, getTelemetryBaud, setTelemetryBaud,
    BAUD_OPTIONS, DEFAULT_TELEMETRY_ADDRESS,
} from '@/lib/linkSettings'
import { setStatusBarEnabled, setStatusBarLinksEnabled } from '@/lib/statusBarSettings'
import { VIDEO_SOURCES, SOURCE_GROUPS, specFor, sourceNeeds,
    getVideoSource, setVideoSource, getSiyiRtspUrl, setSiyiRtspUrl, getAirUnitVideoPort, setAirUnitVideoPort, getAirUnitFanoutPort, setAirUnitFanoutPort, type VideoSource, getRelayTransport, setRelayTransport, getRelayLatencyMs, setRelayLatencyMs, type RelayTransport, getRtspTransport, setRtspTransport, type RtspTransport, getPreviewFragMode, setPreviewFragMode, type PreviewFragMode, getLiveEdgeClamp, setLiveEdgeClamp, getGstJitterMs, setGstJitterMs, getGstAccel, setGstAccel, type GstAccel,
    getReceiverHost, setReceiverHost, getReceiverTransport, setReceiverTransport,
    getReceiverLatencyMs, setReceiverLatencyMs, getReceiverAccel, setReceiverAccel,
    getReceiverPassthrough, setReceiverPassthrough,
    type ReceiverTransport, DEFAULT_RECEIVER_LATENCY_MS } from '@/lib/videoSource'

// Sources that push to the backend's relay listener, and therefore expose the
// uplink transport and SRT latency controls. air_unit_gst was missing here,
// which hid the latency dial on the one mode that most needs it — the SRT
// window governs how far the AI overlay trails the locally-decoded picture.
const USES_RELAY: VideoSource[] = ['rtsp_relay', 'air_unit_srt', 'air_unit_gst', 'hyrak_receiver']


import { getActiveRung, getRungFailures, getReportedCodec } from '@/lib/rtspCameraStream'
import { getLiveEdgeDriftMs } from '@/lib/liveEdge'
import { probeDroneNetwork, explainResult, type ProbeReport } from '@/lib/netProbe'
import { isDesktopApp, nativeUpdater } from '@/lib/nativeBridge'
import { useAirUnitVideoBridge } from '@/hooks/useAirUnitVideoBridge'

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
    const [font, setFont] = useState<UiFont>(() => getUiFont())
    const [zoom, setZoom] = useState<number>(() => getUiZoom())
    const [textSize, setTextSize] = useState<UiTextSize>(() => getUiTextSize())

    return (
        <>
            <PrefRow
                label="Theme"
                sub="Classic is the original palette. Midnight is the reworked dark — brighter secondary text and visible panel edges, for reading dense pages at a glance. Bright is the light theme."
                right={
                    <SegmentControl
                        value={(theme as any) ?? 'dark'}
                        onChange={v => setTheme(v as 'dark' | 'midnight' | 'light')}
                        options={[
                            { value: 'dark',     label: 'Classic',  icon: <Moon size={12} /> },
                            { value: 'midnight', label: 'Midnight', icon: <MoonStar size={12} /> },
                            { value: 'light',    label: 'Bright',   icon: <Sun size={12} /> },
                        ]}
                    />
                }
            />
            <PrefRow
                label="Font"
                sub="Interface typeface, applied everywhere — headings, descriptions, status chips and the task bar. The default keeps telemetry monospaced for column alignment; any other choice restyles those too."
                right={
                    <ChipGroup
                        value={font}
                        onChange={v => { setFont(v as UiFont); setUiFont(v as UiFont) }}
                        options={UI_FONTS.map(f => ({ value: f.value, label: f.label }))}
                    />
                }
            />
            <PrefRow
                label="Text size"
                sub="Grows the type only and leaves the layout alone. Combine with Interface scale below if everything should grow."
                right={
                    <ChipGroup
                        value={textSize}
                        onChange={v => { setTextSize(v as UiTextSize); setUiTextSize(v as UiTextSize) }}
                        options={UI_TEXT_SIZES.map(t => ({ value: t.value, label: t.label }))}
                    />
                }
            />
            <PrefRow
                label="Interface scale"
                sub="Scales the entire interface — panels with their text, so nothing overflows. Use this if the text reads too small."
                right={
                    <ChipGroup
                        value={String(zoom)}
                        onChange={v => { const n = Number(v); setZoom(n); setUiZoom(n) }}
                        options={UI_ZOOMS.map(z => ({ value: String(z), label: `${z}%` }))}
                    />
                }
            />
        </>
    )
}

function StatusBarGroup() {
    const [enabled, setEnabled] = useState(() => ls('hyrak-statusbar-enabled', true))
    const [links, setLinks] = useState(() => ls('hyrak-statusbar-links-enabled', false))

    return (
        <>
            <PrefRow
                label="Show status bar"
                sub="Persistent bar on Mission / AI / Config / Settings — altitude, arm/takeoff, flight mode, GPS, connectivity, plus quick Land / Emergency kill. Hidden on the Fly tab, which already has its own controls."
                right={<Toggle value={enabled} onChange={() => { const v = !enabled; setEnabled(v); setStatusBarEnabled(v) }} />}
            />
            <PrefRow
                label="Link controls in the status bar"
                sub="Adds video-source, camera and telemetry-link pickers to the bar, so a vehicle can be retasked from Mission or AI without going back to Fly. Off by default — these are setup controls, and they sit next to Emergency kill. They show the SAME selection as the Fly tab, and changing the video source or camera restarts a running stream."
                right={<Toggle value={links} onChange={() => { const v = !links; setLinks(v); setStatusBarLinksEnabled(v) }} />}
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

// Desktop-app-only. Starts/stops the native air-unit-video bridge
// (desktop/src/bridges/airUnitVideoBridge.ts) — same technique as
// air_unit_relay/video_webcam.sh (SDP + low-latency ffmpeg options,
// hardware decode when a VAAPI-capable ffmpeg is available, feeds a
// v4l2loopback device), just built into the app instead of a script the
// client has to run separately. Once running, pick "HyrakAirUnit" from
// the ordinary Camera dropdown above — this row only starts the feed,
// it doesn't change how the browser consumes it. Shares useAirUnitVideoBridge
// (and its bridge id) with the Fly tab's own Start control — starting it
// from either place is reflected in both, since it's the same underlying
// bridge connection.
function NativeAirUnitVideoRow({ source }: { source: VideoSource }) {
    const [mounted, setMounted] = useState(false)
    const [port, setPort] = useState(5600)
    const [device, setDevice] = useState('/dev/video10')
    const bridge = useAirUnitVideoBridge()

    useEffect(() => { setMounted(true) }, [])

    // Always render SOMETHING here rather than silently disappearing —
    // a row that vanishes with no explanation reads as "this feature
    // doesn't exist" rather than "here's what you need to do first",
    // which is what was actually happening (this used to hide itself
    // completely whenever source wasn't 'camera', with zero indication
    // why — easy to land on across devices with different saved settings).
    if (!mounted) return null

    if (!isDesktopApp()) {
        return (
            <PrefRow
                label="Native air-unit video bridge"
                sub="Desktop app only — this browser tab can't run it"
                right={<span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>—</span>}
            />
        )
    }

    if (source !== 'camera') {
        return (
            <PrefRow
                label="Native air-unit video bridge"
                sub="Set Video source (above) to 'Camera' first — this feeds a camera device, it doesn't replace that setting"
                right={<span style={{ fontSize: 11, fontFamily: 'monospace', color: '#f59e0b' }}>Needs Camera source</span>}
            />
        )
    }

    return (
        <>
            <PrefRow
                label="Native air-unit video bridge"
                sub="Feeds the HyrakAirUnit camera device directly — no separate video_webcam.sh to run"
                tip="Reads your air unit's RF video link (see start-gs.sh) the same way video_webcam.sh does, built into the app instead. Once running, pick 'HyrakAirUnit' from the Camera dropdown above like any other webcam (also startable from the Fly tab's device panel directly). Uses hardware decode automatically when a VAAPI-capable ffmpeg is available on this machine, same as before."
                right={
                    <button
                        onClick={() => bridge.running ? bridge.stop() : bridge.start({ port, device })}
                        disabled={bridge.busy}
                        style={{
                            padding: '6px 12px', borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                            background: bridge.running ? 'transparent' : '#22d3ee',
                            border: bridge.running ? '1px solid #ef4444' : 'none',
                            color: bridge.running ? '#ef4444' : 'black',
                            opacity: bridge.busy ? 0.5 : 1,
                        }}
                    >
                        {bridge.busy ? 'Working…' : bridge.running ? 'Stop' : 'Start'}
                    </button>
                }
            />
            {!bridge.running && (
                <PrefRow
                    label="Port / device"
                    right={
                        <div style={{ display: 'flex', gap: 6 }}>
                            <input
                                type="number" min={1} max={65535} value={port}
                                onChange={e => setPort(Number(e.target.value) || 5600)}
                                style={{ padding: '6px 10px', borderRadius: 8, width: 80, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                            />
                            <input
                                value={device} onChange={e => setDevice(e.target.value)}
                                style={{ padding: '6px 10px', borderRadius: 8, width: 120, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                            />
                        </div>
                    }
                />
            )}
            {bridge.status && (
                <PrefRow
                    label="Status"
                    right={<span style={{ fontSize: 11, fontFamily: 'monospace', color: bridge.status.error ? '#ef4444' : '#22d3ee' }}>{bridge.status.msg}</span>}
                />
            )}
            {bridge.status?.log && (
                <pre style={{
                    margin: '4px 0 12px', padding: 10, borderRadius: 8, fontSize: 10, fontFamily: 'monospace',
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                    color: 'hsl(var(--app-text-muted))', maxHeight: 200, overflowY: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>
                    {bridge.status.log}
                </pre>
            )}
        </>
    )
}

// Which rung of the RTSP fallback ladder is actually carrying video, on screen
// rather than behind a console incantation.
//
// This exists because the ladder degraded silently: a feed that ran on the
// H.264 transcode at ~500ms fell back to MJPEG at ~1.5s and nothing said so.
// Three rounds of latency work were spent tuning a pipeline that wasn't even
// the one in use. The active path is the first thing anyone needs to know
// before touching a single latency dial.
// Answers "can this machine reach the drone hardware?" BEFORE Start is pressed.
//
// Exists because a roaming laptop silently left the ground unit's network seven
// times in one evening, and each time the failure surfaced as a video/telemetry
// timeout rather than as "you are on the wrong network". Reports the subnet, not
// the SSID — the SSID was misleading, since a bridging ground unit hands out the
// upstream router's addresses while the camera stays on its own subnet.
function NetworkCheckRow() {
    const [report, setReport] = useState<ProbeReport | null>(null)
    const [busy, setBusy] = useState(false)

    const run = async () => {
        setBusy(true)
        try { setReport(await probeDroneNetwork()) } finally { setBusy(false) }
    }

    // Checked on mount so the answer is already on screen, rather than needing
    // to be remembered and clicked.
    useEffect(() => { void run() }, [])

    return (
        <PrefRow
            label="Hardware reachability"
            sub="Whether this machine can reach the camera and ground unit right now"
            tip="Green means on your own subnet — reached directly, the reliable case. Amber means reachable but ROUTED through a gateway, which depends on another device forwarding and is what fails intermittently. Red means unreachable: either this machine is on the wrong network, or the hardware is off. This deliberately reports your SUBNET rather than the WiFi name, because a ground unit that bridges to a phone hands out the phone's addresses while the camera stays on its own subnet — so the network name proves nothing."
            right={
                <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 11, maxWidth: 340 }}>
                    {report?.error && (
                        <div style={{ color: '#fbbf24', whiteSpace: 'normal', lineHeight: 1.4 }}>{report.error}</div>
                    )}
                    {report?.results.map(r => {
                        const colour = !r.ok ? '#f87171' : r.onLink ? '#4ade80' : '#fbbf24'
                        return (
                            <div key={r.label} style={{ marginBottom: 4 }}>
                                <span style={{ color: colour, fontWeight: 600 }}>
                                    {r.label}: {r.ok ? (r.onLink ? 'OK' : 'routed') : 'unreachable'}
                                </span>
                                <div style={{ color: 'hsl(var(--app-text-dim))', fontSize: 10, whiteSpace: 'normal', lineHeight: 1.4 }}>
                                    {r.host}:{r.port} — {explainResult(r, report.addresses)}
                                </div>
                            </div>
                        )
                    })}
                    {report && report.addresses.length > 0 && (
                        <div style={{ color: 'hsl(var(--app-text-dim))', fontSize: 10, marginTop: 2 }}>
                            this machine: {report.addresses.map(a => a.cidr).join(', ')}
                        </div>
                    )}
                    <button
                        onClick={run}
                        disabled={busy}
                        style={{
                            marginTop: 6, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                            background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))', fontSize: 11, fontFamily: 'monospace',
                        }}
                    >
                        {busy ? 'checking…' : 'Re-check'}
                    </button>
                </div>
            }
        />
    )
}

function RtspPathRow() {
    const [info, setInfo] = useState({
        rung: null as string | null,
        codec: null as string | null,
        failures: [] as string[],
        drift: 0,
    })

    // Polled rather than pushed: these live at module scope in
    // rtspCameraStream.ts and liveEdge.ts, written from the stream-start path
    // and the clamp's own timer. Wiring events through for a diagnostic
    // readout would couple far more than it's worth.
    useEffect(() => {
        const tick = () => setInfo({
            rung: getActiveRung(),
            codec: getReportedCodec(),
            failures: getRungFailures(),
            drift: getLiveEdgeDriftMs(),
        })
        tick()
        const t = setInterval(tick, 1000)
        return () => clearInterval(t)
    }, [])

    // MJPEG is a safety net, not an acceptable steady state — 20fps with no
    // inter-frame compression, through <img> -> canvas -> rAF -> captureStream.
    // It gets a warning colour so it can never quietly become the norm again.
    const colour = !info.rung
        ? 'hsl(var(--app-text-dim))'
        : /MJPEG/i.test(info.rung) ? '#f87171'
            : /transcode/i.test(info.rung) ? '#fbbf24'
                : '#4ade80'

    return (
        <PrefRow
            label="Active video path"
            sub="Which rung of the RTSP fallback ladder is carrying video right now"
            tip="The ladder tries, best first: direct (no re-encode, needs an H.264 camera) → H.264 transcode (for an H.265 camera, since Chromium ships no software HEVC decoder) → MJPEG (last resort, cannot fail on codec but is 20fps and has no inter-frame compression). Green is best, amber is a re-encode, red means you are on the fallback and latency will be roughly 3x worse. Buffer is the browser's own playback backlog — if that number is small while the picture is still late, the delay is upstream of the browser."
            right={
                <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 11, maxWidth: 300 }}>
                    <div style={{ color: colour, fontWeight: 600 }}>
                        {info.rung ?? 'not streaming'}
                    </div>
                    <div style={{ color: 'hsl(var(--app-text-dim))', marginTop: 2 }}>
                        {info.codec ? `camera: ${info.codec}` : 'camera: unknown'}
                        {' · '}
                        buffer: {info.drift}ms
                    </div>
                    {info.failures.length > 0 && (
                        <div style={{ color: '#f87171', marginTop: 4, fontSize: 10, whiteSpace: 'normal', lineHeight: 1.4 }}>
                            {info.failures.map((f, i) => <div key={i}>skipped — {f}</div>)}
                        </div>
                    )}
                </div>
            }
        />
    )
}

function VideoGroup() {
    const { isStreaming, applyVideoSettings } = useWebRTCContext()
    const [res, setRes] = useState<VideoRes>(() => getVideoSettings().res)
    const [fps, setFps] = useState<VideoFps>(() => getVideoSettings().fps)
    const [feed, setFeed] = useState<FeedMode>(() => getFeedMode())
    const [standby, setStandby] = useState<StandbyUplink>(() => getStandbyUplink())
    const [capture, setCapture] = useState<CaptureProfile>(() => getCaptureProfile())
    const [source, setSource] = useState<VideoSource>(() => getVideoSource())
    const [rtspUrl, setRtspUrl] = useState(() => getSiyiRtspUrl())
    const [airUnitPort, setAirUnitPort] = useState(() => getAirUnitVideoPort())
    const [fanoutPort, setFanoutPort] = useState(() => getAirUnitFanoutPort())
    const [relayTransport, setRelayTransportState] = useState<RelayTransport>(() => getRelayTransport())
    const [relayLatency, setRelayLatencyState] = useState(() => getRelayLatencyMs())
    const [rtspTransport, setRtspTransportState] = useState<RtspTransport>(() => getRtspTransport())
    const [fragMode, setFragModeState] = useState<PreviewFragMode>(() => getPreviewFragMode())
    const [liveEdge, setLiveEdgeState] = useState(() => getLiveEdgeClamp())
    const [gstJitter, setGstJitterState] = useState(() => getGstJitterMs())
    const [gstAccel, setGstAccelState] = useState<GstAccel>(() => getGstAccel())
    const [rxHost, setRxHostState] = useState(() => getReceiverHost())
    const [rxTransport, setRxTransportState] = useState<ReceiverTransport>(() => getReceiverTransport())
    const [rxLatency, setRxLatencyState] = useState(() => getReceiverLatencyMs())
    const [rxAccel, setRxAccelState] = useState<GstAccel>(() => getReceiverAccel())
    const [rxPassthrough, setRxPassthroughState] = useState(() => getReceiverPassthrough())

    // Live-apply when a stream is running; otherwise takes effect next start.
    const apply = (nextRes: VideoRes, nextFps: VideoFps) => {
        lsSet('hyrak-video-res', nextRes)
        lsSet('hyrak-video-fps', nextFps)
        if (isStreaming) applyVideoSettings()
    }

    return (
        <>
            <PrefRow
                label="Video source"
                sub={isStreaming ? "Can't switch mid-stream — stop and restart to apply" : 'Applies to the next stream started from any tab (Fly, Modules)'}
                tip="Camera uses your device's webcam like normal. Air unit (UDP) skips the browser entirely and has the backend read your RF link's video feed directly (see backend/app/webrtc/udp_video_source.py). SIYI RTSP has the BACKEND pull the camera — only works when the server is on the same network as the camera, which off a dev machine it never is. RTSP relay is the one to use for a real deployment: THIS machine pulls the camera and forwards the original bytes to the server without re-encoding, and shows you a local preview off the same process (desktop app only). The two DataChannel modes are the newest and the only ones that are BOTH bit-exact and NAT-traversing: the desktop opens its own WebRTC PeerConnection carrying raw RTP with no media track, so no codec is negotiated and H.265 survives untouched (aiortc can only negotiate VP8/H.264 on a track, which forces a transcode everywhere else). 'RTSP -> DataChannel' uses ffmpeg purely to speak RTSP. 'Air unit -> DataChannel' uses no ffmpeg at all — wfb_rx already delivers RTP/H.265 to the port, so the app just forwards datagrams; it is the cheapest path here and bit-identical to what the drone's encoder produced. 'Air unit -> GStreamer' is the newest and the one to prefer on Linux: a SINGLE GStreamer pipeline owns udp:5600 and splits it with a tee — a hardware-decoded local preview for the pilot, and a bit-exact H.265 SRT uplink for the server's AI. Nothing passes through JavaScript (the DataChannel path reads every packet on Electron's one event loop, and drops them silently when it stalls), and hardware codecs are actually reachable — the bundled ffmpeg has no VAAPI at all. Measured on 1080p20: ffmpeg preview ~79% of a core, GStreamer software 41%, GStreamer hardware 4.4%. Needs GStreamer installed on this machine. Resolution/fps/feed-mode below don't apply to any backend-sourced mode."
                right={
                    <select
                        value={source}
                        onChange={e => {
                            const v = e.target.value as VideoSource
                            setSource(v); setVideoSource(v)
                        }}
                        style={{
                            padding: '7px 10px', borderRadius: 8, width: 280,
                            background: 'hsl(var(--app-surface-2))',
                            border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))',
                            fontSize: 12, fontFamily: 'monospace', outline: 'none',
                        }}
                    >
                        {/* Derived from the catalogue, NOT a hand-written list.
                            It was hardcoded to three groups, so adding
                            'Ground decoder' silently dropped the entire group
                            from the dropdown — the source existed, worked, and
                            could not be selected. Exactly the class of bug the
                            data-driven catalogue above was introduced to kill,
                            reintroduced two lines from it. */}
                        {SOURCE_GROUPS.map(group => (
                            <optgroup key={group} label={group}>
                                {VIDEO_SOURCES.filter(s => s.group === group).map(s => (
                                    <option key={s.value} value={s.value}>
                                        {s.label}{s.desktopOnly ? '  (desktop)' : ''}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                }
            />

            {/* What the selected source actually does, and what it needs to
                work. Nine sources differ mostly in WHO opens the stream and
                whether that machine can reach it — which was buried in one
                enormous tooltip nobody could read at the moment of choosing. */}
            {specFor(source) && (
                <div style={{
                    margin: '2px 2px 10px', padding: '10px 12px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    fontSize: 11.5, lineHeight: 1.5,
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    {specFor(source)!.blurb}
                    {specFor(source)!.serverReaches && (
                        <div style={{ marginTop: 6, color: '#f59e0b' }}>
                            Requires the SERVER to reach the source directly — not this laptop.
                        </div>
                    )}
                    {specFor(source)!.desktopOnly && !isDesktopApp() && (
                        <div style={{ marginTop: 6, color: '#f59e0b' }}>
                            Needs the desktop app. In a browser tab this will fall back to the camera.
                        </div>
                    )}
                </div>
            )}
            <NativeAirUnitVideoRow source={source} />
            {sourceNeeds(source, 'udpPort') && (
                <PrefRow
                    label="Air unit video port"
                    sub="Local UDP port the backend reads the RTP/H.265 video stream from"
                    tip="Matches whatever port your ground-station wfb_rx (or equivalent) delivers video to — see communication/start-gs.sh. Default 5600."
                    right={
                        <input
                            type="number"
                            min={1}
                            max={65535}
                            value={airUnitPort}
                            onChange={e => {
                                const v = Number(e.target.value)
                                setAirUnitPort(v)
                                if (v > 0 && v < 65536) setAirUnitVideoPort(v)
                            }}
                            style={{
                                padding: '6px 10px', borderRadius: 8, width: 100,
                                background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                            }}
                        />
                    }
                />
            )}
            {sourceNeeds(source, 'fanout') && (
                <PrefRow
                    label="Local fan-out port"
                    sub="Re-send a verbatim copy of the video to another local UDP port — 0 to disable"
                    tip="Only one program can receive a UDP port, so streaming the feed takes it away from any local viewer already reading it (gst-decode.sh reads 5600). Set e.g. 5601 here and point that viewer at 5601 instead: one capture, two consumers, identical bytes. gst-launch-1.0 udpsrc port=5601 caps='application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,payload=96' ! rtpjitterbuffer latency=50 ! rtph265depay ! h265parse ! avdec_h265 ! autovideosink sync=false"
                    right={
                        <input
                            type="number"
                            min={0}
                            max={65535}
                            value={fanoutPort}
                            onChange={e => {
                                const v = Number(e.target.value)
                                setFanoutPort(v)
                                if (v >= 0 && v < 65536) setAirUnitFanoutPort(v)
                            }}
                            style={{
                                padding: '6px 10px', borderRadius: 8, width: 100,
                                background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                            }}
                        />
                    }
                />
            )}
            {/* Camera address — only for sources that actually open one. The
                air-unit modes were previously inside this same block and got
                an RTSP URL field they have no use for. */}
            {sourceNeeds(source, 'rtspUrl') && (
                <>
                    <PrefRow
                        label="Camera URL"
                        sub="RTSP address this machine pulls from — the SIYI ground unit on its own hotspot"
                        tip="Shares the same saved value as SIYI (RTSP) mode. The difference is who opens it: relay mode opens it from THIS laptop, which is the only machine that can actually reach 192.168.144.x."
                        right={
                            <input
                                value={rtspUrl}
                                onChange={e => { setRtspUrl(e.target.value); setSiyiRtspUrl(e.target.value) }}
                                placeholder="rtsp://192.168.144.25:8554/video1"
                                style={{
                                    padding: '6px 10px', borderRadius: 8, width: 260,
                                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                                }}
                            />
                        }
                    />
                    <NetworkCheckRow />
                    <RtspPathRow />
                </>
            )}

            {sourceNeeds(source, 'rtspXport') && (
                <PrefRow
                    label="Camera transport"
                        sub="How ffmpeg opens the RTSP feed — the hop from the SIYI ground unit to this laptop"
                        tip="Independent of the uplink transport below: this is the CAMERA leg, not the server leg. TCP loses nothing, but a retransmission stalls everything queued behind it (head-of-line blocking) — so on a weak or distant hotspot link the delay ACCUMULATES instead of glitching, which can be hundreds of milliseconds of standing lag. UDP drops late packets instead of waiting for them, so loss shows as brief artifacts and can never pile up; it also pins ffmpeg's packet-reorder buffer to zero, which otherwise exists purely to wait. Try UDP if the feed is steadily late rather than stuttery. TCP is the default and the known-good setting."
                        right={
                            <ChipGroup
                                value={rtspTransport}
                                onChange={v => { setRtspTransportState(v); setRtspTransport(v) }}
                                options={[
                                    { value: 'tcp' as RtspTransport, label: 'TCP' },
                                    { value: 'udp' as RtspTransport, label: 'UDP' },
                                ]}
                            />
                        }
                    />
            )}

            {/* Local preview tuning. Both rows drive a <video> element, which
                the GStreamer/WebCodecs path does not use — it renders to a
                canvas with no playback buffer to fragment or clamp. */}
            {sourceNeeds(source, 'preview') && (
                <>
                    <PrefRow
                        label="Preview fragmenting"
                        sub="Size of the chunks the local preview is cut into"
                        tip="A fragmented-MP4 fragment is only written once it is complete, so this value is added to the preview's delay in full. Low latency cuts at 20 ms — under one frame at 30fps, so the fragment boundary stops mattering at all. Compatible is the original 100 ms; switch back to it if short fragments upset playback anywhere."
                        right={
                            <ChipGroup
                                value={fragMode}
                                onChange={v => { setFragModeState(v); setPreviewFragMode(v) }}
                                options={[
                                    { value: 'low' as PreviewFragMode, label: 'Low latency (20 ms)' },
                                    { value: 'compatible' as PreviewFragMode, label: 'Compatible (100 ms)' },
                                ]}
                            />
                        }
                    />
                    <PrefRow
                        label="Live-edge clamp"
                        sub="Drain the browser's playback buffer back toward the newest frame"
                        tip="Chromium settles a few hundred ms behind its own newest buffered frame when it starts a live stream, and never catches up on its own — frames arrive at exactly the rate they are consumed, so the startup backlog is permanent. This nudges playback slightly above 1.0x until the backlog is spent, then returns to normal. Side effect: motion runs a little fast for about a second after a stream starts. Read the current backlog in the DevTools console with __hyrakLiveEdge()."
                        right={<Toggle value={liveEdge} onChange={() => { const next = !liveEdge; setLiveEdgeState(next); setLiveEdgeClamp(next) }} />}
                    />
                </>
            )}

            {sourceNeeds(source, 'relay') && (
                <>
                    <PrefRow
                        label="Uplink transport"
                        sub="How the copied video reaches the server"
                        tip="SRT retransmits lost packets inside a bounded window, so loss becomes a brief glitch instead of a freeze — the right default. TCP delivers everything but stalls the whole stream while it recovers a lost packet; use it only where UDP is blocked entirely (some campus and hotel networks). Plain UDP never retransmits at all — LAN only."
                        right={
                            <ChipGroup
                                value={relayTransport}
                                onChange={v => { setRelayTransportState(v); setRelayTransport(v) }}
                                options={[
                                    { value: 'srt' as RelayTransport, label: 'SRT' },
                                    { value: 'tcp' as RelayTransport, label: 'TCP' },
                                    { value: 'udp' as RelayTransport, label: 'UDP' },
                                ]}
                            />
                        }
                    />
                    {relayTransport === 'srt' && (
                        <PrefRow
                            label="SRT latency window"
                            sub="Milliseconds of buffer for retransmitting lost packets (min 80)"
                            tip="A floor on delay as well as the retransmission budget: packets lost further back than this cannot be recovered. SRT needs 2.5-4x the round-trip time, so anything under ~80 ms cannot retransmit at all and only adds its own delay — values below that are ignored. In air_unit_gst mode this does NOT delay your video, which is decoded locally; it delays only the server's copy, and therefore how far the AI overlay boxes trail the picture. Through a relay VPS use ~300 ms; testing against a server on your own machine or LAN, 80-120 ms is plenty."
                            right={
                                <input
                                    type="number"
                                    min={20}
                                    max={2000}
                                    step={10}
                                    value={relayLatency}
                                    onChange={e => {
                                        const v = Number(e.target.value)
                                        setRelayLatencyState(v)
                                        // Floor matches getRelayLatencyMs: below ~80ms SRT cannot complete a
                                        // NAK plus resend at any real RTT, so the value would be stored and
                                        // then silently ignored.
                                        if (v >= 80 && v <= 2000) setRelayLatencyMs(v)
                                    }}
                                    style={{
                                        padding: '6px 10px', borderRadius: 8, width: 100,
                                        background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                        color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                                    }}
                                />
                            }
                        />
                    )}
                </>
            )}

            {/* HYRAK Receiver — the ground decoder. The address is a REQUIRED
                setting rather than a constant: the decoder ships with a static
                IP today, but a client on a different subnet has no way to
                reach it and no way to say so if this is hardcoded. */}
            {sourceNeeds(source, 'receiver') && (
                <>
                    <PrefRow
                        label="Ground decoder address"
                        sub="IP of the HYRAK ground decoder on the Ethernet link"
                        tip="The decoder terminates the RF link and hands this PC decrypted, compressed video — no driver, no keys, no wfb-ng on this machine. It ships with a static address (192.168.50.12 on the tested link). If the picture never appears, check this first: an address on a different subnet from this PC cannot be reached no matter what the transport is."
                        right={
                            <input
                                type="text"
                                value={rxHost}
                                spellCheck={false}
                                onChange={e => { setRxHostState(e.target.value); setReceiverHost(e.target.value) }}
                                style={{
                                    padding: '6px 10px', borderRadius: 8, width: 160,
                                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                                }}
                            />
                        }
                    />
                    <PrefRow
                        label="Transport"
                        sub="How the video gets from the decoder to this PC"
                        tip="RTSP is the default and the right answer for almost everyone: THIS PC connects outward, so the decoder needs no knowledge of your address and no inbound firewall rule is involved. Over TCP nothing is lost, but TCP recovers a lost packet by stalling everything behind it with no upper bound — which is why VLC looks clean and runs about half a second behind. SRT keeps RTSP's addressing and firewall behaviour and fixes the unbounded part: loss is retransmitted only inside the latency window below and dropped outside it, so delay cannot accumulate. It needs 'srt: yes' enabled in MediaMTX on the decoder — the same process that already serves RTSP, so it costs that board almost nothing. UDP is the lowest latency of the three and the most fragile operationally: the decoder PUSHES, so it must be configured with this PC's address, and Windows Firewall must allow the port inbound — both fail as a black screen rather than as a message."
                        right={
                            <ChipGroup
                                value={rxTransport}
                                onChange={v => {
                                    setRxTransportState(v)
                                    setReceiverTransport(v)
                                    // Latency is stored per transport, so the
                                    // displayed value has to follow the switch
                                    // — showing an SRT budget next to a UDP
                                    // jitter buffer would be a lie.
                                    setRxLatencyState(getReceiverLatencyMs(v))
                                }}
                                options={[
                                    { value: 'rtsp' as ReceiverTransport, label: 'RTSP' },
                                    { value: 'srt' as ReceiverTransport, label: 'SRT' },
                                    { value: 'udp' as ReceiverTransport, label: 'UDP' },
                                ]}
                            />
                        }
                    />
                    <PrefRow
                        label={rxTransport === 'srt' ? 'Retransmit window' : 'Jitter buffer'}
                        sub={rxTransport === 'srt'
                            ? 'Milliseconds within which lost packets are recovered'
                            : 'Milliseconds of buffer absorbing arrival jitter'}
                        tip="The same dial means different things per transport, which is why it is stored separately for each. On UDP and RTSP it absorbs variation in arrival time; on SRT it is the retransmission budget itself and is also a floor on delay. Lower is snappier and less tolerant: 20-25ms runs cleanly on a direct cable, but if you see micro-stutter — visible, not something the logs will show — go back up toward 50. There is no universally right number; tune it against your actual link."
                        right={
                            <input
                                type="number"
                                min={0} max={2000} step={5}
                                value={rxLatency}
                                onChange={e => {
                                    const v = Number(e.target.value)
                                    setRxLatencyState(v)
                                    if (v >= 0 && v <= 2000) setReceiverLatencyMs(rxTransport, v)
                                }}
                                style={{
                                    padding: '6px 10px', borderRadius: 8, width: 100,
                                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                                }}
                            />
                        }
                    />
                    <PrefRow
                        label="H.265 passthrough"
                        sub="Send the decoder's H.265 to the screen with nothing transcoding it"
                        tip="Off by default, and that is deliberate. Skipping the transcode sounds strictly better, but Chromium's HEVC support is platform-gated and will report that it supports H.265 and then fail the actual decode — a black picture with only 'Decoding error' to show for it, which is what happened on this machine. With this off, the stream is converted to H.264 first, which every Chromium decodes everywhere; on hardware that conversion costs about 4% of one core. Worth turning ON to test on a Windows machine with a modern NVIDIA GPU, where the platform decoder is solid and the transcode is pure waste. If it fails, the app detects the real decode error and falls back on its own for the rest of the session."
                        right={<Toggle value={rxPassthrough} onChange={() => { const next = !rxPassthrough; setRxPassthroughState(next); setReceiverPassthrough(next) }} />}
                    />
                    <PrefRow
                        label="Decode path"
                        sub={`Auto probes this machine and falls back on its own (default ${DEFAULT_RECEIVER_LATENCY_MS[rxTransport]}ms buffer)`}
                        tip="Leave this on Auto. The receiver prefers passing H.265 straight to the browser engine, which reaches your GPU through the OS and costs nothing to install — that is what makes one download work on Windows, Linux and ARM64 alike. If this machine's browser engine cannot decode H.265 it transcodes to H.264 first, using hardware if any is genuinely usable and stepping down through decode-on-GPU/encode-in-software to all-software until something runs. Forcing Software is a diagnostic: it proves whether a fault is the GPU without guessing. The path actually running is reported on the video pane."
                        right={
                            <ChipGroup
                                value={rxAccel}
                                onChange={v => { setRxAccelState(v); setReceiverAccel(v) }}
                                options={[
                                    { value: 'auto' as GstAccel, label: 'Auto' },
                                    { value: 'hardware' as GstAccel, label: 'Hardware' },
                                    { value: 'software' as GstAccel, label: 'Software' },
                                ]}
                            />
                        }
                    />
                </>
            )}

            {/* GStreamer-specific. These had no UI at all, which is how a
                stale jitter value could sit in localStorage silently
                overriding a fix with no way to see or change it. */}
            {sourceNeeds(source, 'gst') && (
                <>
                    <PrefRow
                        label="Jitter buffer"
                        sub="Milliseconds the RTP buffer will wait for a late packet (min 30)"
                        tip="Paired with drop-on-latency, so this is not 'how long we wait' but 'how late a packet may be before it is DISCARDED'. Ordinary Wi-Fi jitter exceeds 10 ms, and a discarded packet in a compressed stream breaks every frame that references it until the next keyframe — which the server logs as 'Could not find ref with POC'. 60 ms is the smallest value that survives normal Wi-Fi. Raise to 100-150 on a long or lossy RF link; it costs that much delay on your local preview."
                        right={
                            <input
                                type="number"
                                min={30}
                                max={2000}
                                step={10}
                                value={gstJitter}
                                onChange={e => {
                                    const v = Number(e.target.value)
                                    setGstJitterState(v)
                                    // Floor matches getGstJitterMs — below 30 the value
                                    // would be stored and then silently ignored.
                                    if (v >= 30 && v <= 2000) setGstJitterMs(v)
                                }}
                                style={{
                                    padding: '6px 10px', borderRadius: 8, width: 100,
                                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                                }}
                            />
                        }
                    />
                    <PrefRow
                        label="Decode path"
                        sub="Hardware uses the GPU; software is roughly ten times the CPU"
                        tip="Auto prefers hardware and falls back on its own — and demotes itself permanently for the session if the hardware pipeline dies twice quickly. Measured on 1080p20 H.265: GStreamer hardware 4.4% of a core, software 41.3%, bundled-ffmpeg preview ~79%. Force software only when debugging a driver problem."
                        right={
                            <ChipGroup
                                value={gstAccel}
                                onChange={v => { setGstAccelState(v); setGstAccel(v) }}
                                options={[
                                    { value: 'auto' as GstAccel, label: 'Auto' },
                                    { value: 'hardware' as GstAccel, label: 'Hardware' },
                                    { value: 'software' as GstAccel, label: 'Software' },
                                ]}
                            />
                        }
                    />
                </>
            )}

            <PrefRow
                label="AI module feed"
                sub="Applies when the next stream starts"
                tip="Direct + overlay shows your camera feed directly and draws AI results on top — sharpest video, lowest latency, and roughly half the bandwidth since no video is sent back from the server. The overlays lag the video by one inference (~100 ms). Processed shows the server-rendered feed — video and annotations perfectly in sync, but quality is limited by the return encode and bandwidth is higher. Depth mapping and enhance always use the processed feed."
                right={
                    <ChipGroup
                        value={feed}
                        onChange={v => { setFeed(v); lsSet('hyrak-feed-mode', v) }}
                        options={[
                            { value: 'overlay' as FeedMode, label: 'Direct + overlay' },
                            { value: 'processed' as FeedMode, label: 'Processed' },
                        ]}
                    />
                }
            />
            <PrefRow
                label="Standby uplink"
                sub={isStreaming ? 'Applied live to the running stream' : 'Applies while no AI mode is active'}
                tip="What the browser sends the server while you're just flying (no AI mode running) — the server only uses it for the admin dashboard's live preview; your own view is always the full local feed. Full sends the resolution/fps chosen below. Eco sends a small 8 fps preview instead, freeing this machine's CPU — important on low-power ground stations that are also decoding an RF video link. Auto picks Eco only when the selected camera is the HyrakAirUnit virtual webcam (air-unit ground stations), Full otherwise. AI modes always uplink at full quality regardless."
                right={
                    <ChipGroup
                        value={standby}
                        onChange={v => { setStandby(v); lsSet('hyrak-standby-uplink', v); if (isStreaming) applyVideoSettings() }}
                        options={[
                            { value: 'auto' as StandbyUplink, label: 'Auto' },
                            { value: 'full' as StandbyUplink, label: 'Full' },
                            { value: 'eco' as StandbyUplink, label: 'Eco' },
                        ]}
                    />
                }
            />
            {/* Browser capture only. Every backend-sourced mode delivers
                whatever the air unit or camera already encoded, so these
                controls did nothing there but were always shown. */}
            {sourceNeeds(source, 'capture') && (
                <>
            <PrefRow
                label="Capture priority"
                sub={isStreaming ? 'Applied live to the running stream' : 'Applies when the stream starts'}
                tip="How the browser's encoder spends bitrate on the way to the server. Smooth prioritises motion: under congestion the resolution drops and the frame rate holds — right for flying and for watching. Detail prioritises fine detail: the frame rate drops and the RESOLUTION holds, the encoder is told to preserve detail rather than smooth motion, and the bitrate ceiling roughly doubles. Use Detail for number plates and any small text: a plate is only a few hundred pixels of high-frequency detail, which is exactly what a motion-tuned encoder discards first, and a dropped frame costs nothing because the plate is still there on the next one. Note this only affects browser camera capture — every backend-sourced mode already delivers the original bytes untouched."
                right={
                    <ChipGroup
                        value={capture}
                        onChange={v => {
                            setCapture(v); lsSet('hyrak-capture-profile', v)
                            if (isStreaming) applyVideoSettings()
                        }}
                        options={[
                            { value: 'smooth' as CaptureProfile, label: 'Smooth' },
                            { value: 'detail' as CaptureProfile, label: 'Detail' },
                        ]}
                    />
                }
            />
            <PrefRow
                label="Stream resolution"
                sub={isStreaming ? 'Applied live to the running stream' : 'Applies when the stream starts'}
                tip="What the camera captures and sends to the server. Resolution is NOT cosmetic for every mode: plate tracking analyses the frame at its native size and crowd counting at 1280, so both genuinely see more at 1080p. The close-range trackers do run at 640 internally, and for those higher resolution only sharpens what you see."
                right={
                    <ChipGroup
                        value={res}
                        onChange={v => { setRes(v); apply(v, fps) }}
                        options={RES_OPTIONS.map(r => ({ value: r, label: `${r}p` }))}
                    />
                }
            />
            <PrefRow
                label="Frame rate"
                sub="Camera capture rate in frames per second"
                tip="Lower frame rates reduce bandwidth and CPU load; higher rates look smoother. Under network congestion the stream keeps this frame rate and drops resolution instead."
                right={
                    <ChipGroup
                        value={String(fps) as `${VideoFps}`}
                        onChange={v => { const f = Number(v) as VideoFps; setFps(f); apply(res, f) }}
                        options={FPS_OPTIONS.map(f => ({ value: String(f) as `${VideoFps}`, label: String(f) }))}
                    />
                }
            />
                </>
            )}
        </>
    )
}

function CrowdGroup() {
    const { isStreaming } = useWebRTCContext()
    const mode = useDroneStore(s => s.mode)
    const [preset, setPreset] = useState<CrowdPreset>(() => getCrowdPreset())
    const [custom, setCustom] = useState(() => getCrowdCustom())

    const push = () => {
        if (isStreaming && mode === 'crowd-management') {
            const { lightMax, moderateMax } = getCrowdThresholds()
            getSocket().emit('set_crowd_thresholds', { light_max: lightMax, moderate_max: moderateMax })
        }
    }

    const apply = (next: CrowdPreset) => {
        lsSet('hyrak-crowd-preset', next)
        setPreset(next)
        push()
    }

    // Normalised on every edit, not on blur: moderateMax must stay above
    // lightMax or the "orange" band disappears and counts jump straight from
    // green to red with nothing in between.
    const applyCustom = (light: number, moderate: number) => {
        const next = normaliseCrowdThresholds(light, moderate)
        setCustom(next)
        lsSet('hyrak-crowd-custom', next)
        if (preset !== 'custom') { lsSet('hyrak-crowd-preset', 'custom'); setPreset('custom') }
        push()
    }

    return (
        <>
            <PrefRow
                label="Density sensitivity"
                sub="How many people in frame count as light / moderate / dense"
                tip="Whole-frame headcount depends entirely on how tight the drone is framed and its altitude — there's no single correct value. Tight flags density sooner (good for confined spaces); Loose needs more people before warning (good for wide-open areas). Applies live if a crowd-management stream is running."
                right={
                    <ChipGroup
                        value={preset}
                        onChange={apply}
                        options={[
                            { value: 'tight' as CrowdPreset, label: 'Tight' },
                            { value: 'default' as CrowdPreset, label: 'Default' },
                            { value: 'loose' as CrowdPreset, label: 'Loose' },
                            { value: 'custom' as CrowdPreset, label: 'Custom' },
                        ]}
                    />
                }
            />
            {preset === 'custom' && (
                <PrefRow
                    label="Custom thresholds"
                    sub="People in frame: up to Light = green, up to Moderate = orange, above = red"
                    tip="Your own numbers, for when you have counted them. A venue with a known safe occupancy, or a site you have flown before, has better thresholds than any preset here — these depend on lens, altitude and framing, so nobody can pick them for you. Moderate is always kept at least one above Light, otherwise the orange band vanishes and the count jumps straight from green to red."
                    right={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {([
                                ['Light', custom.lightMax,
                                 (v: number) => applyCustom(v, custom.moderateMax)],
                                ['Moderate', custom.moderateMax,
                                 (v: number) => applyCustom(custom.lightMax, v)],
                            ] as const).map(([label, value, onChange]) => (
                                <label key={label} style={{
                                    display: 'flex', alignItems: 'center', gap: 5,
                                    fontSize: 11, color: 'hsl(var(--app-text-muted))',
                                }}>
                                    {label}
                                    <input
                                        type="number"
                                        min={1}
                                        max={999}
                                        value={value}
                                        onChange={e => onChange(Number(e.target.value))}
                                        style={{
                                            width: 62, padding: '4px 6px', borderRadius: 6,
                                            fontSize: 12, fontFamily: 'monospace',
                                            textAlign: 'right',
                                            border: '1px solid hsl(var(--app-border))',
                                            background: 'hsl(var(--app-surface-2))',
                                            color: 'hsl(var(--app-text))',
                                        }}
                                    />
                                </label>
                            ))}
                        </div>
                    }
                />
            )}
        </>
    )
}

function MissionGroup() {
    const autoFollowOnMission    = useMissionStore(s => s.autoFollowOnMission)
    const setAutoFollowOnMission = useMissionStore(s => s.setAutoFollowOnMission)

    return (
        <>
            <PrefRow
                label="Auto-follow on mission start"
                sub="Switches to 3D view and starts the chase camera when a mission begins"
                tip="When enabled, the moment the drone enters MISSION flight mode, the map switches to 3D and the camera locks behind the drone automatically. Disable this if you prefer to stay in 2D or control the view manually."
                right={<Toggle value={autoFollowOnMission} onChange={() => setAutoFollowOnMission(!autoFollowOnMission)} />}
            />
        </>
    )
}

// Desktop-app-only — nothing renders in the browser build (isDesktopApp()
// is false there). Manual mirror of the same consent-gated flow the
// startup UpdatePrompt uses (components/updater/UpdatePrompt.tsx) — this
// is the "check right now" entry point, that one is the "we noticed on
// launch" entry point. Both just call the same native updater API.
type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error'

function DesktopUpdateRow() {
    const [mounted, setMounted]   = useState(false)
    const [version, setVersion]   = useState('')
    const [newVersion, setNewVersion] = useState('')
    const [status, setStatus]     = useState<UpdateStatus>('idle')
    const [statusMsg, setStatusMsg] = useState('')
    // Undefined until the first progress event — distinguishes "authorized,
    // nothing has moved yet" from "0% downloaded", which look identical if you
    // only track a number.
    const [progress, setProgress] = useState<{ percent: number; transferred?: number; total?: number; rate?: number } | null>(null)

    useEffect(() => {
        setMounted(true)
        if (!isDesktopApp()) return
        const updater = nativeUpdater()
        if (!updater) return
        void updater.appVersion().then(setVersion)
        return updater.onEvent(event => {
            if (event.type === 'checking') { setStatus('checking'); setStatusMsg('') }
            else if (event.type === 'not-available') { setStatus('current'); setStatusMsg('Up to date') }
            else if (event.type === 'available') {
                setNewVersion(event.version ?? '')
                setStatus('available'); setStatusMsg(`v${event.version} available`)
            }
            // download-progress / downloaded were dropped on the floor here, so
            // this row went silent for the entire download — the one part of
            // the flow where the user most wants to see something happening.
            else if (event.type === 'download-progress') {
                setStatus('downloading')
                setProgress({
                    percent: Math.round(event.percent ?? 0),
                    transferred: event.transferred,
                    total: event.total,
                    rate: event.bytesPerSecond,
                })
                setStatusMsg('')
            }
            else if (event.type === 'downloaded') {
                setStatus('downloaded')
                if (event.version) setNewVersion(event.version)
                setStatusMsg('Downloaded — restart to apply')
            }
            else if (event.type === 'error') {
                setStatus('error')
                setStatusMsg(event.message || 'Could not check for updates')
            }
        })
    }, [])

    if (!mounted || !isDesktopApp()) return null

    const startDownload = () => {
        setProgress(null)
        setStatus('downloading')
        void nativeUpdater()?.authorizeDownload()
    }

    // One button whose job follows the stage, rather than a check-only button
    // that leaves the user with nowhere to go once an update is found.
    const action = (() => {
        if (status === 'available')   return { label: `Download v${newVersion}`, onClick: startDownload, primary: true }
        if (status === 'downloaded')  return { label: 'Restart & install', onClick: () => void nativeUpdater()?.install(), primary: true }
        if (status === 'downloading') return { label: 'Downloading…', onClick: () => {}, disabled: true }
        if (status === 'checking')    return { label: 'Checking…', onClick: () => {}, disabled: true }
        return { label: 'Check for updates', onClick: () => void nativeUpdater()?.checkNow() }
    })()

    const detail = progress
        ? [
            progress.transferred !== undefined && progress.total
                ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}` : null,
            progress.rate ? formatRate(progress.rate) : null,
            progress.transferred !== undefined && progress.total && progress.rate
                ? formatEta(progress.transferred, progress.total, progress.rate) : null,
        ].filter(Boolean).join(' · ')
        : ''

    return (
        <>
            <PrefRow
                label="Desktop app"
                sub={version ? `Installed version ${version}` : undefined}
                tip="This app's native shell (bridges + updater) rarely changes — most day-to-day updates are the site itself, which always loads live and needs no update step at all."
                right={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {statusMsg && status !== 'error' && (
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: status === 'available' || status === 'downloaded' ? '#22d3ee' : 'hsl(var(--app-text-muted))' }}>
                                {statusMsg}
                            </span>
                        )}
                        <button
                            onClick={action.onClick}
                            disabled={action.disabled}
                            style={{
                                padding: '6px 10px', borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                                whiteSpace: 'nowrap',
                                background: action.primary ? '#22d3ee' : 'hsl(var(--app-surface-2))',
                                border: '1px solid ' + (action.primary ? '#22d3ee' : 'hsl(var(--app-border))'),
                                color: action.primary ? 'black' : 'hsl(var(--app-text))',
                                opacity: action.disabled ? 0.5 : 1,
                                cursor: action.disabled ? 'default' : 'pointer',
                            }}
                        >
                            {action.label}
                        </button>
                    </div>
                }
            />

            {status === 'downloading' && (
                <div style={{ padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>
                            {progress ? `${progress.percent}%` : 'Starting download…'}
                        </span>
                        {detail && <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>{detail}</span>}
                    </div>
                    <div style={{ height: 5, borderRadius: 999, background: 'hsl(var(--app-surface-2))', overflow: 'hidden' }}>
                        {/* Without a first progress event there is no honest percentage
                            to draw, so pulse instead of asserting 0%. */}
                        <div
                            className={progress ? undefined : 'animate-pulse'}
                            style={{
                                height: '100%', borderRadius: 999, background: '#22d3ee',
                                width: progress ? `${progress.percent}%` : '33%',
                                transition: progress ? 'width 200ms linear' : undefined,
                            }}
                        />
                    </div>
                </div>
            )}

            {status === 'error' && statusMsg && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
                    <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', lineHeight: 1.5 }}>{statusMsg}</span>
                </div>
            )}
        </>
    )
}

function AboutGroup() {
    return (
        <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))', margin: '4px 0 12px' }}>
                <div style={{ width: 44, height: 44, borderRadius: 11, background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Zap size={22} style={{ color: '#22d3ee' }} />
                </div>
                <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>Hyrak Control</p>
                    <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>Ground Control Station · 0.1.0-dev</p>
                </div>
            </div>
            <DesktopUpdateRow />
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


// ── Camera calibration ────────────────────────────────────────────────────────
//
// The only group on this page backed by the SERVER rather than localStorage.
// These are properties of the airframe and the mission: they must apply to any
// session from any browser and survive a restart, so the backend owns them
// (backend/app/vision/calibration.py) and this renders whatever field table it
// serves. Ranges and help text are NOT duplicated here — that is how a form
// starts accepting values the backend then rejects.

function CalibrationRow({ field, onSave, busy }: {
    field: CalibrationField
    onSave: (key: string, value: number | string) => Promise<void>
    busy: boolean
}) {
    const [draft, setDraft] = useState(String(field.value))
    const [error, setError] = useState('')

    // Re-sync when the server sends a new value (another tab, or a reset).
    useEffect(() => { setDraft(String(field.value)); setError('') }, [field.value])

    const dirty = draft !== String(field.value)

    const commit = async () => {
        if (!dirty) return
        setError('')
        try {
            await onSave(field.key, field.type === 'enum' ? draft : Number(draft))
        } catch (e) {
            setError((e as Error).message)
            setDraft(String(field.value))   // snap back; nothing was saved
        }
    }

    const sub = [
        field.overridden ? 'measured' : 'default',
        field.min !== undefined ? `${field.min}–${field.max}${field.unit ? ' ' + field.unit : ''}` : '',
    ].filter(Boolean).join('  ·  ')

    return (
        <PrefRow
            label={field.label}
            sub={error || sub}
            tip={field.help}
            right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {field.type === 'enum' ? (
                        <ChipGroup
                            value={draft}
                            onChange={async (v: string) => {
                                setDraft(v)
                                setError('')
                                try { await onSave(field.key, v) }
                                catch (e) { setError((e as Error).message); setDraft(String(field.value)) }
                            }}
                            options={(field.options ?? []).map(o => ({ value: o, label: o }))}
                        />
                    ) : (
                        <>
                            <input
                                type="number"
                                value={draft}
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                disabled={busy}
                                onChange={e => setDraft(e.target.value)}
                                // Commit on blur or Enter rather than per
                                // keystroke: each save is a server round trip,
                                // and half-typed numbers are out of range.
                                onBlur={commit}
                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                style={{
                                    width: 84, padding: '5px 8px', fontSize: 12,
                                    fontFamily: 'monospace', textAlign: 'right',
                                    borderRadius: 6,
                                    background: 'hsl(var(--app-surface))',
                                    border: `1px solid ${error ? '#f87171'
                                        : dirty ? '#22d3ee' : 'hsl(var(--app-border))'}`,
                                    color: 'hsl(var(--app-text))',
                                }}
                            />
                            {field.unit && (
                                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', width: 28 }}>
                                    {field.unit}
                                </span>
                            )}
                        </>
                    )}
                </div>
            }
        />
    )
}

function useCalibration() {
    const [schema, setSchema] = useState<CalibrationSchema | null>(null)
    const [busy, setBusy] = useState(false)
    const [offline, setOffline] = useState(false)

    useEffect(() => {
        fetchCalibration().then(s => { setSchema(s); setOffline(s === null) })
    }, [])

    const save = async (key: string, value: number | string) => {
        setBusy(true)
        try { setSchema(await saveCalibration({ [key]: value })) }
        finally { setBusy(false) }
    }
    const reset = async () => {
        setBusy(true)
        try { setSchema(await resetCalibration()) }
        finally { setBusy(false) }
    }
    return { schema, busy, offline, save, reset }
}

function CameraCalibrationGroup() {
    const { schema, busy, offline, save, reset } = useCalibration()
    const fields = (schema?.fields ?? []).filter(f => f.group === 'camera')
    const hfov = Number(fields.find(f => f.key === 'camera_hfov_deg')?.value ?? 70)

    if (offline) {
        return (
            <p style={{ fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
                Backend unreachable — calibration is stored on the server, so it
                cannot be read or changed right now.
            </p>
        )
    }
    if (!schema) {
        return <p style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>Loading…</p>
    }

    return (
        <>
            {/* Until something is measured every metric output rests on a
                guessed lens. Saying so is more useful than a silent default. */}
            {!schema.calibrated && (
                <div style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                    padding: '8px 10px', marginBottom: 8, borderRadius: 8,
                    background: 'rgba(251,191,36,0.10)',
                    border: '1px solid rgba(251,191,36,0.35)',
                    fontSize: 11, lineHeight: 1.6, color: '#fbbf24',
                }}>
                    <Info size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>
                        <b>Not calibrated yet</b> — these are deploy-time defaults.
                        Speed, distance and ground position all scale directly off
                        the horizontal FOV, so measure it before trusting any of
                        them: fill the frame edge-to-edge with a target of known
                        width <i>W</i> at distance <i>D</i>, then
                        {' '}<code>HFOV = 2·atan(W / 2D)</code>.
                    </span>
                </div>
            )}

            {fields.map(f => (
                <CalibrationRow key={f.key} field={f} onSave={save} busy={busy} />
            ))}

            {/* Consequences of the numbers above, so the effect of a change is
                visible without flying to find out. */}
            <PrefRow
                label="Implied geometry"
                sub="Derived from the values above — not editable"
                tip="Vertical FOV is what decides whether ONE fixed mount angle can cover both a shallow view (for reading plates and faces) and a steep one (for ground projection). GSD is metres per pixel at nadir: it tells you whether a target has enough pixels to analyse at that height."
                right={
                    <div style={{ fontSize: 11, fontFamily: 'monospace', textAlign: 'right', color: 'hsl(var(--app-text-muted))', lineHeight: 1.6 }}>
                        <div>VFOV {derivedVfov(hfov).toFixed(1)}°</div>
                        <div>{(gsdAtNadir(hfov, 50) * 1000).toFixed(1)} mm/px @ 50 m</div>
                    </div>
                }
            />

            <div style={{ paddingTop: 10 }}>
                <button
                    onClick={reset}
                    disabled={busy || !schema.calibrated}
                    style={{
                        border: 'none', background: 'none', padding: 0,
                        fontSize: 11, cursor: schema.calibrated ? 'pointer' : 'default',
                        color: schema.calibrated ? '#f87171' : 'hsl(var(--app-text-muted))',
                        opacity: busy ? 0.5 : 1,
                    }}
                >
                    Reset calibration to defaults
                </button>
            </div>
        </>
    )
}

function FollowTuningGroup() {
    const { schema, busy, offline, save } = useCalibration()
    const fields = (schema?.fields ?? []).filter(f => f.group === 'follow')

    if (offline || !schema) {
        return (
            <p style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                {offline ? 'Backend unreachable.' : 'Loading…'}
            </p>
        )
    }
    return (
        <>
            <p style={{ fontSize: 11, color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: '0 0 6px' }}>
                How hard the drone turns to keep a subject centred, for{' '}
                <b>every</b> mode that can follow one — human tracking, person
                tracking, crowd management, traffic management and vehicle-plate
                tracking. Yaw is the axis that decides whether the subject stays
                in frame at all.
            </p>
            {fields.map(f => (
                <CalibrationRow key={f.key} field={f} onSave={save} busy={busy} />
            ))}
            {/* Said plainly, because the alternative is an operator concluding
                the Settings values "don't work" after watching a panel slider
                win. The panel sliders are per-session and were here first. */}
            <p style={{ fontSize: 11, color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: '8px 0 0' }}>
                Applied when a tracking mode next <b>starts</b> — unlike the
                camera calibration above, which takes effect on the next frame.
                Switch AI mode, or restart the stream, to pick up a change.
            </p>
            <p style={{ fontSize: 11, color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: '6px 0 0' }}>
                These are the values every mode <i>starts</i> from. Human
                Tracking and Person Tracker also keep their own sliders for
                changing them between runs — those act on the running session
                only, and are not saved here.
            </p>
        </>
    )
}

function VisionLimitsGroup() {
    const { schema, busy, offline, save } = useCalibration()
    const fields = (schema?.fields ?? []).filter(f => f.group === 'limits')

    if (offline || !schema) {
        return (
            <p style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                {offline ? 'Backend unreachable.' : 'Loading…'}
            </p>
        )
    }
    return (
        <>
            <p style={{ fontSize: 11, color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: '0 0 6px' }}>
                Per-mission limits, kept separate from the camera calibration
                above: that describes the rig and changes when the lens does,
                these are decisions an operator makes for a given flight.
            </p>
            {fields.map(f => (
                <CalibrationRow key={f.key} field={f} onSave={save} busy={busy} />
            ))}
        </>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

// The groups above are pure content — no headings of their own. Section
// headings live HERE instead, so the page's structure is declarative and
// visible in one place rather than implied by the order of eleven components
// that each printed their own label. Adding a settings group means adding a
// line to this table, and it lands in a deliberate category instead of at the
// bottom of one long scroll.
interface Section {
    label: string                        // divider text within a category
    Body: () => React.JSX.Element
}
interface Category {
    id: string
    label: string
    icon: LucideIcon
    blurb: string                        // one line under the category heading
    sections: Section[]
}


// ── Comm links ────────────────────────────────────────────────────────────────

function LinkGroup() {
    const { telemetryStatus, disconnectTelemetry } = useDrone()
    const [address, setAddressState] = useState(() => getTelemetryAddress())
    const [baud, setBaudState] = useState(() => getTelemetryBaud())
    const [busy, setBusy] = useState(false)

    const connected = telemetryStatus === 'connected'

    return (
        <>
            <PrefRow
                label="Link status"
                sub={connected
                    ? 'Connected — the link can be released from here or from the Fly tab'
                    : 'No telemetry link'}
                tip="Disconnecting stops whichever local relay owns the radio (Web Serial, native serial or native RF) BEFORE telling the server to forget the link — otherwise the still-running relay would immediately re-establish it from its own traffic."
                right={
                    connected ? (
                        <button
                            onClick={async () => {
                                setBusy(true)
                                try { await disconnectTelemetry() } finally { setBusy(false) }
                            }}
                            disabled={busy}
                            style={{
                                padding: '6px 12px', borderRadius: 8,
                                background: 'hsl(var(--app-surface-2))',
                                border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text))',
                                fontSize: 12, fontFamily: 'monospace',
                                cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                            }}
                        >
                            {busy ? 'Disconnecting...' : 'Disconnect'}
                        </button>
                    ) : (
                        <span style={{
                            fontSize: 12, fontFamily: 'monospace',
                            color: 'hsl(var(--app-text-muted))',
                        }}>
                            {telemetryStatus}
                        </span>
                    )
                }
            />
            <PrefRow
                label="Default MAVLink address"
                sub="Pre-filled in the Fly tab's connect box"
                tip="udp://:14540 is PX4 SITL's default. For a real vehicle over a network link use the address the autopilot streams to, e.g. udp://:14550. Serial radios do not use this — pick the port and baud below instead."
                right={
                    <input
                        value={address}
                        onChange={e => { setAddressState(e.target.value); setTelemetryAddress(e.target.value) }}
                        placeholder={DEFAULT_TELEMETRY_ADDRESS}
                        style={{
                            padding: '6px 10px', borderRadius: 8, width: 200,
                            background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                        }}
                    />
                }
            />
            <PrefRow
                label="Radio baud rate"
                sub="Default for serial telemetry radios"
                tip="SiK-family radios (the common 433/915 MHz modules) ship at 57600. RFD900 and some clones use 115200. A wrong baud opens the port successfully and then delivers nothing decodable, which looks exactly like a dead radio — so if the port connects but no telemetry arrives, try the other value here first."
                right={
                    <select
                        value={baud}
                        onChange={e => {
                            const v = Number(e.target.value)
                            setBaudState(v); setTelemetryBaud(v)
                        }}
                        style={{
                            padding: '6px 10px', borderRadius: 8, width: 120,
                            background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none',
                        }}
                    >
                        {BAUD_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                }
            />
        </>
    )
}

const CATEGORIES: Category[] = [
    {
        id: 'general', label: 'General', icon: SlidersHorizontal,
        blurb: 'Theme, status bar, and the units used across every tab',
        sections: [
            { label: 'APPEARANCE', Body: DisplayGroup },
            { label: 'STATUS BAR', Body: StatusBarGroup },
            { label: 'UNITS',      Body: UnitsGroup },
        ],
    },
    {
        id: 'video', label: 'Video', icon: Video,
        blurb: 'Where the feed comes from, its quality, and how AI results are drawn',
        sections: [
            { label: 'VIDEO', Body: VideoGroup },
            { label: 'CAMERA CALIBRATION', Body: CameraCalibrationGroup },
        ],
    },
    {
        id: 'links', label: 'Comm links', icon: Radio,
        blurb: 'Telemetry link defaults and the active connection',
        sections: [{ label: 'COMM LINKS', Body: LinkGroup }],
    },
    {
        id: 'ai', label: 'AI Modules', icon: Bot,
        blurb: 'Per-mode tuning for the vision modules',
        sections: [
            { label: 'FOLLOW TUNING', Body: FollowTuningGroup },
            { label: 'CROWD MANAGEMENT', Body: CrowdGroup },
            { label: 'TRACKING & SPEED LIMITS', Body: VisionLimitsGroup },
        ],
    },
    {
        id: 'map', label: 'Map', icon: Map,
        blurb: 'Default basemap and tile caching for the Mission tab',
        sections: [{ label: 'MAP', Body: MapGroup }],
    },
    {
        id: 'mission', label: 'Mission', icon: Route,
        blurb: 'Behaviour when a mission starts',
        sections: [{ label: 'MISSION', Body: MissionGroup }],
    },
    {
        id: 'alerts', label: 'Alerts', icon: Bell,
        blurb: 'Which events raise a notification',
        sections: [{ label: 'ALERTS', Body: NotificationsGroup }],
    },
    {
        id: 'data', label: 'Data & Logs', icon: Database,
        blurb: 'Telemetry recording and where logs are written',
        sections: [{ label: 'DATA & LOGS', Body: DataGroup }],
    },
    {
        id: 'shortcuts', label: 'Shortcuts', icon: Keyboard,
        blurb: 'Keyboard shortcuts available while flying',
        sections: [{ label: 'SHORTCUTS', Body: ShortcutsGroup }],
    },
    {
        id: 'about', label: 'About', icon: Info,
        blurb: 'Version, updates, and the stack this build runs on',
        sections: [{ label: 'ABOUT', Body: AboutGroup }],
    },
]

const TAB_KEY = 'hyrak-settings-tab'

function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
    return (
        // Column beside the content on a normal window; a horizontally
        // scrollable row when the pane is too narrow for both (the desktop
        // app can be resized well below a comfortable two-column width).
        <nav className="flex shrink-0 gap-1 overflow-x-auto pb-2 md:sticky md:top-1 md:w-[172px] md:flex-col md:overflow-x-visible md:pb-0">
            {CATEGORIES.map(({ id, label, icon: Icon }) => (
                <button
                    key={id}
                    onClick={() => onSelect(id)}
                    aria-current={id === active ? 'page' : undefined}
                    className={cn(
                        'flex shrink-0 cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors',
                        id === active
                            ? 'border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-2))] text-[hsl(var(--app-text))]'
                            : 'border-transparent text-[hsl(var(--app-text-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-text))]',
                    )}
                >
                    <Icon size={14} className="shrink-0" />
                    {label}
                </button>
            ))}
        </nav>
    )
}

export default function SettingsPage() {
    // Every group below reads a localStorage-backed preference straight into
    // its initial state (theme, video source, units, ...). The server has no
    // localStorage to read, so it always renders the fallback default —
    // whenever a saved value differs, the client's first render disagrees
    // with the server-rendered HTML and React flags a hydration mismatch
    // (harmless in practice, but noisy and technically unsound). Delaying
    // the settings groups themselves until after mount sidesteps this for
    // the whole page in one place instead of per-component. The active tab is
    // read the same way, for the same reason.
    const [mounted, setMounted] = useState(false)
    const [activeId, setActiveId] = useState(CATEGORIES[0].id)
    useEffect(() => {
        setMounted(true)
        const saved = ls(TAB_KEY, CATEGORIES[0].id)
        if (CATEGORIES.some(c => c.id === saved)) setActiveId(saved)
    }, [])

    const select = (id: string) => { setActiveId(id); lsSet(TAB_KEY, id) }
    const active = CATEGORIES.find(c => c.id === activeId) ?? CATEGORIES[0]

    return (
        <div style={{ height: '100%', overflowY: 'auto' }}>
            <div style={{ maxWidth: 900, margin: '0 auto', padding: '4px 32px 48px' }}>

                <div style={{ padding: '18px 0 14px' }}>
                    <h1 style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>App Settings</h1>
                    <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '3px 0 0' }}>Preferences saved to this device — not sent to the drone</p>
                </div>

                {mounted && (
                    <div className="flex flex-col gap-7 md:flex-row">
                        <SettingsNav active={activeId} onSelect={select} />

                        <div style={{ flex: 1, minWidth: 0, maxWidth: 660 }}>
                            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>{active.label}</h2>
                            <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '3px 0 0' }}>{active.blurb}</p>

                            {active.sections.map(({ label, Body }) => (
                                <div key={label}>
                                    {/* A lone section whose name just repeats the category heading
                                        would be pure noise — only show the divider when it adds
                                        information (several sections, or a different name). */}
                                    {(active.sections.length > 1 || label !== active.label.toUpperCase()) && (
                                        <GroupLabel text={label} />
                                    )}
                                    <Body />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

            </div>
        </div>
    )
}

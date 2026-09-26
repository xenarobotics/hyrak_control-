'use client'

// COMMAND - the all-in-one flight window.
//
// Built for flying from one screen, not assembled from the Fly and Mission
// tabs: the view (video or map) fills the window, with the other as a
// minimap; everything needed while flying floats on the view where the eye
// already is -
//   top     status strip: cloud + aircraft link, mode, armed, battery, GPS,
//           home distance, flight time, avoidance state and sensor
//   left    action rail: arm, take off (altitude stepper), mission, hold,
//           RTL, land, kill (two taps)
//   centre  flight HUD over the video: horizon, heading tape, speed, altitude
//   bottom  mission progress, what avoidance is doing, the latest FC message
// The dock on the right holds the detail, one tab at a time: avoidance,
// telemetry, setup (devices + full flight controls) and the message log. It
// resizes by dragging its edge and hides entirely.
//
// Keys: M swaps video and map, P shows/hides the dock.
// Swapping never remounts the video or the map, so the stream never restarts.
// The map is read-only here (edit missions on the Mission tab).

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { CornerDownLeft, Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useSwarmStore } from '@/store/swarm'
import { useDroneStore } from '@/store/drone'
import { getVideoSource } from '@/lib/videoSource'
import { cn } from '@/lib/utils'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { StatusStrip } from '@/components/command/StatusStrip'
import { ActionRail } from '@/components/command/ActionRail'
import { FlightHud } from '@/components/command/FlightHud'
import { MissionStrip } from '@/components/command/MissionStrip'
import { useAvoidanceLive } from '@/components/command/useAvoidanceLive'

const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center bg-zinc-900">
            <p className="text-xs font-mono text-zinc-400">Loading map…</p>
        </div>
    ),
})

type View = 'video' | 'map'
type Corner = 'bl' | 'br' | 'tl' | 'tr'
type PipSize = 's' | 'm' | 'l'
type DockTab = 'avoid' | 'telemetry' | 'setup' | 'log'
interface Layout {
    big: View; corner: Corner; size: PipSize; dockW: number; dockHidden: boolean; tab: DockTab
}

const DEFAULT: Layout = { big: 'video', corner: 'br', size: 'm', dockW: 340, dockHidden: false, tab: 'avoid' }
const STORE_KEY = 'hyrak-command-layout-v2'
const PIP_DIMS: Record<PipSize, [number, number]> = { s: [220, 140], m: [320, 200], l: [440, 275] }
const CORNERS: Corner[] = ['br', 'bl', 'tl', 'tr']
const TOP_CLEAR = 52        // below the status strip
// The video's own control bar (Start, fullscreen) owns the bottom ~46 px when
// the video is full screen; the mission strip and minimap sit above it.
const VIDEO_BAR = 46
const stripBottom = (big: View) => (big === 'video' ? VIDEO_BAR : 8)
const pipBottom = (big: View) => stripBottom(big) + 44
const DOCK_MIN = 280, DOCK_MAX = 600
const TABS: { id: DockTab; label: string }[] = [
    { id: 'avoid', label: 'AVOID' }, { id: 'telemetry', label: 'TELEMETRY' },
    { id: 'setup', label: 'SETUP' }, { id: 'log', label: 'LOG' },
]

function loadLayout(): Layout {
    try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
    } catch { /* storage unavailable */ }
    return DEFAULT
}
function saveLayout(l: Layout) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(l)) } catch { /* not critical */ }
}

function pipBox(corner: Corner, size: PipSize, big: View): React.CSSProperties {
    const [w, h] = PIP_DIMS[size]
    const pos: React.CSSProperties = { width: w, height: h, maxWidth: '42%', maxHeight: '42%' }
    if (corner[0] === 'b') pos.bottom = pipBottom(big); else pos.top = TOP_CLEAR
    if (corner[1] === 'l') pos.left = 76; else pos.right = 10      // clear of the action rail
    return pos
}

function MessageLog() {
    const msgs = useDroneStore(s => s.fcMessages)
    if (!msgs.length) return <p className="text-xs font-mono text-zinc-500">No messages from the aircraft yet.</p>
    return (
        <div className="flex flex-col gap-1 font-mono text-[11px]">
            {[...msgs].reverse().slice(0, 200).map(m => (
                <div key={(m as { id?: number }).id ?? m.ts} className="flex gap-2">
                    <span className="text-zinc-500 tabular-nums shrink-0">{new Date(m.ts * 1000).toLocaleTimeString()}</span>
                    <span style={{ color: m.rank >= 5 ? '#f87171' : m.rank >= 4 ? '#fbbf24' : '#d4d4d8' }}>{m.text}</span>
                </div>
            ))}
        </div>
    )
}

export default function CommandPage() {
    const [mounted, setMounted] = useState(false)
    const [layout, setLayout] = useState<Layout>(DEFAULT)
    const [wallOn, setWallOn] = useState(false)
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const avoid = useAvoidanceLive()
    const dragRef = useRef<{ x: number; w: number } | null>(null)

    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })   // raw feed
        setLayout(loadLayout())
        setMounted(true)
    }, [])

    const update = useCallback((patch: Partial<Layout>) => {
        setLayout(prev => { const next = { ...prev, ...patch }; saveLayout(next); return next })
    }, [])
    const swap = useCallback(() => setLayout(prev => {
        const next = { ...prev, big: (prev.big === 'video' ? 'map' : 'video') as View }; saveLayout(next); return next
    }), [])
    const toggleDock = useCallback(() => setLayout(prev => {
        const next = { ...prev, dockHidden: !prev.dockHidden }; saveLayout(next); return next
    }), [])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = e.target as HTMLElement | null
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
            if (e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === 'm' || e.key === 'M') swap()
            if (e.key === 'p' || e.key === 'P') toggleDock()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [swap, toggleDock])

    const onDragStart = (e: React.MouseEvent) => {
        e.preventDefault()
        dragRef.current = { x: e.clientX, w: layout.dockW }
        const move = (ev: MouseEvent) => {
            if (!dragRef.current) return
            const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, dragRef.current.w + (dragRef.current.x - ev.clientX)))
            setLayout(prev => ({ ...prev, dockW: w }))
        }
        const up = () => {
            dragRef.current = null
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            setLayout(prev => { saveLayout(prev); return prev })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
    }

    const boxFor = (v: View): React.CSSProperties =>
        layout.big === v
            ? { position: 'absolute', inset: 0, zIndex: 0 }
            : { position: 'absolute', zIndex: 30, borderRadius: 10, overflow: 'hidden',
                boxShadow: '0 10px 30px rgba(0,0,0,.6)', border: '1px solid rgba(255,255,255,.2)',
                ...pipBox(layout.corner, layout.size, layout.big) }

    const pipChrome = (label: string) => (
        <>
            <button onClick={swap} aria-label={`Show ${label} full screen`}
                className="absolute inset-0 z-[1500] cursor-pointer" style={{ background: 'transparent' }} />
            <div className="absolute top-1.5 left-1.5 right-1.5 z-[1600] flex items-center justify-between pointer-events-none">
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-widest bg-black/60 text-zinc-200">
                    {label} · tap to expand</span>
                <span className="flex gap-1 pointer-events-auto">
                    <button onClick={() => update({ corner: CORNERS[(CORNERS.indexOf(layout.corner) + 1) % 4] })}
                        className="p-1 rounded bg-black/60 text-zinc-200" title="Move to the next corner"><CornerDownLeft size={11} /></button>
                    <button onClick={() => update({ size: layout.size === 's' ? 'm' : layout.size === 'm' ? 'l' : 's' })}
                        className="p-1 rounded bg-black/60 text-zinc-200" title="Minimap size">
                        {layout.size === 'l' ? <Minimize2 size={11} /> : <Maximize2 size={11} />}</button>
                </span>
            </div>
        </>
    )

    const dockHidden = mounted && layout.dockHidden

    return (
        <div className="flex h-full min-h-0">
            {/* ── Stage ───────────────────────────────────────────────────── */}
            <div className="relative flex-1 min-w-0 rounded-xl border border-white/10 overflow-hidden bg-black">
                <div style={boxFor('video')} className="flex">
                    <div className="absolute inset-0 flex">
                        {wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream />}
                    </div>
                    {layout.big !== 'video' && pipChrome('VIDEO')}
                </div>
                <div style={boxFor('map')}>
                    {mounted && <MissionMap readOnly follow compact={layout.big !== 'map'} />}
                    {layout.big !== 'map' && pipChrome('MAP')}
                </div>

                {mounted && layout.big === 'video' && !wallOn && (
                    <div className="absolute inset-0 z-10 pointer-events-none"><FlightHud /></div>
                )}

                <div className="absolute top-2 left-2 right-2 z-20 flex items-start gap-2">
                    <div className="flex-1 min-w-0"><StatusStrip avoid={avoid} /></div>
                    <button onClick={toggleDock} title={dockHidden ? 'Show panels (P)' : 'Hide panels (P)'}
                        className="h-9 px-2.5 rounded-lg border border-white/10 text-zinc-300 flex items-center gap-1 text-[10px] font-mono"
                        style={{ background: 'rgba(9,11,16,.78)' }}>
                        {dockHidden ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
                    </button>
                </div>

                <div className="absolute left-2 z-20 overflow-y-auto" style={{ top: TOP_CLEAR, bottom: pipBottom(layout.big) }}>
                    <ActionRail />
                </div>

                {mounted && layout.big === 'video' && !wallOn && getVideoSource() === 'air_unit_udp' && (
                    <button onClick={() => setWallOn(true)}
                        className="absolute right-2 z-20 px-2 py-1 rounded border border-white/10 text-[10px] font-mono tracking-widest text-zinc-400"
                        style={{ top: TOP_CLEAR, background: 'rgba(9,11,16,.78)' }}
                        title="Show every mesh unit delivering video">WALL</button>
                )}

                <div className="absolute left-[76px] z-20"
                    style={{ bottom: stripBottom(layout.big), right: 10, maxWidth: 760 }}>
                    <MissionStrip avoid={avoid} />
                </div>
            </div>

            {/* ── Dock: tabs, resizable, hideable ─────────────────────────── */}
            {!dockHidden && (
                <>
                    <div onMouseDown={onDragStart} className="w-2 shrink-0 cursor-col-resize flex items-center justify-center group"
                        title="Drag to resize">
                        <div className="w-0.5 h-10 rounded bg-zinc-500/40 group-hover:bg-cyan-400/80" />
                    </div>
                    <aside className="shrink-0 flex flex-col min-h-0 rounded-xl border overflow-hidden"
                        style={{ width: layout.dockW, background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
                        <div className="flex shrink-0 border-b" style={{ borderColor: 'hsl(var(--app-border))' }}>
                            {TABS.filter(tb => !(tb.id === 'avoid' && swarmEnabled)).map(tb => (
                                <button key={tb.id} onClick={() => update({ tab: tb.id })}
                                    className={cn('flex-1 py-2.5 text-[10px] font-mono tracking-widest border-b-2 transition-colors',
                                        layout.tab === tb.id ? 'border-cyan-400 text-cyan-400' : 'border-transparent')}
                                    style={layout.tab === tb.id ? undefined : { color: 'hsl(var(--app-text-muted))' }}>
                                    {tb.label}
                                </button>
                            ))}
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
                            {layout.tab === 'avoid' && !swarmEnabled && <AvoidancePanel />}
                            {layout.tab === 'telemetry' && <TelemetryPanel />}
                            {layout.tab === 'setup' && (
                                <>
                                    {mounted && swarmEnabled
                                        ? <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                            Swarm mode - manage the fleet on the Fly tab.</p>
                                        : <DeviceSelector />}
                                    <div className="border-t pt-4" style={{ borderColor: 'hsl(var(--app-border))' }}>
                                        <DroneControls />
                                    </div>
                                </>
                            )}
                            {layout.tab === 'log' && <MessageLog />}
                        </div>
                    </aside>
                </>
            )}
        </div>
    )
}

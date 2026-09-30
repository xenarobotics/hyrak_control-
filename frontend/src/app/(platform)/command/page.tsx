'use client'

// COMMAND - the all-in-one flight window.
//
// Fixed places, no chrome floating over the picture:
//   top     status cells (links, mode, armed, battery, GPS, home, time,
//           avoidance) + the two link switches: telemetry CONNECT and
//           START VIDEO, side by side + the panel toggle
//   left    action rail: arm, take off, START mission, hold, RTL, land, kill
//   centre  the view - video (with the Fly tab's configurable OSD), map (2D
//           or 3D) or, while an AI module runs, the AI view - and the others
//           as pictures-in-picture pinned to corners. Click a PiP to make it
//           the main view; drag it to another corner. The AI drawer (slim tab
//           on the left edge) starts and stops the AI modules.
//   right   the dock, one tab at a time: avoidance (+ optional radar and
//           forward-depth views), the running AI module's panel, telemetry,
//           setup (devices + full controls), message log. Drag its edge to
//           resize; P hides it.
//   bottom  mission bar: altitude profile along the route with the
//           avoidance floor, next/left/time, avoidance state, last message.
//
// Keys: M swaps video and map, P shows/hides the dock.
// Swapping never remounts the video or the map, so the stream never restarts.
// The map is read-only here (edit missions on the Mission tab).

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen, X } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useSwarmStore } from '@/store/swarm'
import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import { getVideoSource } from '@/lib/videoSource'
import { cn } from '@/lib/utils'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { StatusStrip } from '@/components/command/StatusStrip'
import { LinkCluster } from '@/components/command/LinkCluster'
import { ActionRail } from '@/components/command/ActionRail'
import { MissionBar } from '@/components/command/MissionBar'
import { ObstacleRadar, DepthStrip } from '@/components/command/ObstacleRadar'
import { useAvoidanceLive } from '@/components/command/useAvoidanceLive'
import { IndoorNavCard } from '@/components/command/IndoorNavCard'
import { AiDrawer } from '@/components/command/AiDrawer'
import { AiView } from '@/components/command/AiView'
import { AiPanel } from '@/components/command/AiPanel'
import { useAiModule } from '@/components/command/useAiModule'
import { MODES } from '@/components/vision/ModeSelector'

const mapLoading = () => (
    <div className="w-full h-full flex items-center justify-center bg-zinc-900">
        <p className="text-xs font-mono text-zinc-400">Loading map…</p>
    </div>
)
const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), { ssr: false, loading: mapLoading })
const MissionMap3D = dynamic(() => import('@/components/mission/MissionMap3D'), { ssr: false, loading: mapLoading })

type View = 'video' | 'map' | 'ai'
type Corner = 'bl' | 'br' | 'tl' | 'tr'
type PipSize = 's' | 'm' | 'l'
type DockTab = 'avoid' | 'ai' | 'telemetry' | 'setup' | 'log'
interface Layout {
    big: View
    corners: Record<View, Corner>   // where each view sits while it is a PiP
    size: PipSize; dockW: number; dockHidden: boolean; tab: DockTab
    map3d: boolean; radar: boolean; depth: boolean
}

const DEFAULT: Layout = {
    big: 'video', corners: { video: 'br', map: 'br', ai: 'bl' }, size: 'm', dockW: 340,
    dockHidden: false, tab: 'avoid', map3d: false, radar: false, depth: false,
}
const STORE_KEY = 'hyrak-command-layout-v4'
const OLD_STORE_KEY = 'hyrak-command-layout-v3'   // single-PiP layout, migrated once
const PIP_DIMS: Record<PipSize, [number, number]> = { s: [240, 150], m: [336, 210], l: [460, 288] }
const EDGE = 10             // PiP gap to the stage edge
const DOCK_MIN = 280, DOCK_MAX = 600
const TABS: { id: DockTab; label: string }[] = [
    { id: 'avoid', label: 'AVOID' }, { id: 'ai', label: 'AI' }, { id: 'telemetry', label: 'TELEMETRY' },
    { id: 'setup', label: 'SETUP' }, { id: 'log', label: 'LOG' },
]
const PANEL: React.CSSProperties = { background: '#0b0e13', borderColor: 'rgba(255,255,255,.08)' }

function loadLayout(): Layout {
    try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) {
            const l = JSON.parse(raw)
            return { ...DEFAULT, ...l, corners: { ...DEFAULT.corners, ...(l.corners ?? {}) } }
        }
        const old = localStorage.getItem(OLD_STORE_KEY)
        if (old) {                       // v3: one PiP with one `corner`
            const { corner, ...rest } = JSON.parse(old)
            const c: Corner = corner ?? 'br'
            const other: Corner = `${c[0]}${c[1] === 'l' ? 'r' : 'l'}` as Corner
            return { ...DEFAULT, ...rest, corners: { video: c, map: c, ai: other } }
        }
    } catch { /* storage unavailable */ }
    return DEFAULT
}
function saveLayout(l: Layout) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(l)) } catch { /* not critical */ }
}

const flipH = (c: Corner): Corner => `${c[0]}${c[1] === 'l' ? 'r' : 'l'}` as Corner
const flipV = (c: Corner): Corner => `${c[0] === 't' ? 'b' : 't'}${c[1]}` as Corner

// Corner of every PiP: its own saved corner, or - when an earlier PiP already
// sits there - the one across, so two PiPs never stack.
function placePips(small: View[], corners: Record<View, Corner>): Partial<Record<View, Corner>> {
    const out: Partial<Record<View, Corner>> = {}
    const taken = new Set<Corner>()
    for (const v of small) {
        let c = corners[v]
        for (const alt of [c, flipH(c), flipV(c), flipH(flipV(c))]) {
            if (!taken.has(alt)) { c = alt; break }
        }
        taken.add(c)
        out[v] = c
    }
    return out
}

function pipBox(corner: Corner, size: PipSize): React.CSSProperties {
    const [w, h] = PIP_DIMS[size]
    const pos: React.CSSProperties = { width: w, height: h, maxWidth: '45%', maxHeight: '45%' }
    if (corner[0] === 'b') pos.bottom = EDGE; else pos.top = EDGE
    if (corner[1] === 'l') pos.left = EDGE; else pos.right = EDGE
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

function Toggle({ on, label, hint, onClick }: { on: boolean; label: string; hint: string; onClick: () => void }) {
    return (
        <button onClick={onClick} title={hint}
            className="flex-1 h-8 rounded-md border text-[10px] font-mono tracking-widest transition-colors"
            style={on
                ? { background: 'rgba(34,211,238,.15)', borderColor: 'rgba(34,211,238,.6)', color: '#67e8f9' }
                : { borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}>
            {label} {on ? 'ON' : 'OFF'}
        </button>
    )
}

export default function CommandPage() {
    const [mounted, setMounted] = useState(false)
    const [layout, setLayout] = useState<Layout>(DEFAULT)
    const [wallOn, setWallOn] = useState(false)
    const [drag, setDrag] = useState<{ view: View; x: number; y: number } | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const ai = useAiModule()
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const avoid = useAvoidanceLive()
    const dockDrag = useRef<{ x: number; w: number } | null>(null)
    const stageRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        // Resync the backend to the raw feed only when no module is selected.
        // A module the operator started (from this window's AI drawer, still
        // in the store after a layout change or a trip to another tab) keeps
        // running - resetting it here used to stop every AI module the moment
        // Command opened.
        if (useDroneStore.getState().mode === 'manual-control') {
            getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
        }
        setLayout(loadLayout())
        setMounted(true)
    }, [])

    const update = useCallback((patch: Partial<Layout>) => {
        setLayout(prev => { const next = { ...prev, ...patch }; saveLayout(next); return next })
    }, [])
    // `v` becomes the main view; the old main view takes v's PiP corner.
    const makeBig = useCallback((v: View) => setLayout(prev => {
        if (prev.big === v) return prev
        const next = { ...prev, big: v, corners: { ...prev.corners, [prev.big]: prev.corners[v] } }
        saveLayout(next); return next
    }), [])
    const swap = useCallback(() => setLayout(prev => {
        const v: View = prev.big === 'map' ? 'video' : 'map'
        const next = { ...prev, big: v, corners: { ...prev.corners, [prev.big]: prev.corners[v] } }
        saveLayout(next); return next
    }), [])

    // The AI view exists only while a module runs; if it was the main view
    // when the module stopped, the video takes over.
    useEffect(() => {
        if (mounted && !ai.running && layout.big === 'ai') makeBig('video')
    }, [mounted, ai.running, layout.big, makeBig])
    const toggleDock = useCallback(() => setLayout(prev => {
        const next = { ...prev, dockHidden: !prev.dockHidden }; saveLayout(next); return next
    }), [])

    // 3D chase camera follows the aircraft while it is shown here; the
    // Mission tab's own setting is put back on the way out.
    useEffect(() => {
        if (!mounted || !layout.map3d) return
        const st = useMissionStore.getState()
        const before = st.followDrone
        st.setFollowDrone(true)
        return () => useMissionStore.getState().setFollowDrone(before)
    }, [mounted, layout.map3d])

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

    const onDockDrag = (e: React.MouseEvent) => {
        e.preventDefault()
        dockDrag.current = { x: e.clientX, w: layout.dockW }
        const move = (ev: MouseEvent) => {
            if (!dockDrag.current) return
            const w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, dockDrag.current.w + (dockDrag.current.x - ev.clientX)))
            setLayout(prev => ({ ...prev, dockW: w }))
        }
        const up = () => {
            dockDrag.current = null
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            setLayout(prev => { saveLayout(prev); return prev })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
    }

    // PiP: a click makes it the main view, a drag moves it and it snaps to
    // the nearest corner (trading places with a PiP already there).
    const onPipDown = (e: React.PointerEvent, view: View) => {
        if (e.button !== 0) return
        const stage = stageRef.current?.getBoundingClientRect()
        const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
        if (!stage) return
        const sx = e.clientX, sy = e.clientY
        const ox = sx - box.left, oy = sy - box.top
        let moved = false
        const move = (ev: PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
            moved = true
            setDrag({
                view,
                x: Math.max(0, Math.min(stage.width - box.width, ev.clientX - stage.left - ox)),
                y: Math.max(0, Math.min(stage.height - box.height, ev.clientY - stage.top - oy)),
            })
        }
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            if (!moved) { makeBig(view); return }
            const cx = ev.clientX - stage.left - ox + box.width / 2
            const cy = ev.clientY - stage.top - oy + box.height / 2
            const to = `${cy > stage.height / 2 ? 'b' : 't'}${cx > stage.width / 2 ? 'r' : 'l'}` as Corner
            setLayout(prev => {
                const from = placed[view] ?? prev.corners[view]
                const corners = { ...prev.corners, [view]: to }
                for (const o of small) if (o !== view && placed[o] === to) corners[o] = from
                const next = { ...prev, corners }
                saveLayout(next); return next
            })
            setDrag(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    const views: View[] = ai.running ? ['video', 'map', 'ai'] : ['video', 'map']
    const small = views.filter(v => v !== layout.big)
    const placed = placePips(small, layout.corners)

    const boxFor = (v: View): React.CSSProperties =>
        layout.big === v
            ? { position: 'absolute', inset: 0, zIndex: 0 }
            : {
                position: 'absolute', zIndex: 30, borderRadius: 10, overflow: 'hidden',
                boxShadow: '0 10px 30px rgba(0,0,0,.6)', border: '1px solid rgba(255,255,255,.22)',
                ...pipBox(placed[v] ?? layout.corners[v], layout.size),
                ...(drag?.view === v ? { left: drag.x, top: drag.y, right: 'auto', bottom: 'auto', zIndex: 40 } : {}),
            }

    const pipChrome = (view: View, label: string) => (
        <>
            <div onPointerDown={e => onPipDown(e, view)} role="button" aria-label={`Show ${label} full screen`}
                className="absolute inset-0 z-[1500] cursor-pointer touch-none select-none" style={{ background: 'transparent' }} />
            <div className="absolute top-1.5 left-1.5 right-1.5 z-[1600] flex items-center justify-between pointer-events-none select-none">
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-widest bg-black/65 text-zinc-100">
                    {label} · click to enlarge · drag to move</span>
                <button onClick={() => update({ size: layout.size === 's' ? 'm' : layout.size === 'm' ? 'l' : 's' })}
                    className="p-1.5 rounded bg-black/65 text-zinc-200 pointer-events-auto" title="Picture size">
                    {layout.size === 'l' ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</button>
            </div>
        </>
    )

    const dockHidden = mounted && layout.dockHidden
    // Swarm mode has no AVOID tab: a persisted 'avoid' left the dock blank.
    const activeTab: DockTab = swarmEnabled && layout.tab === 'avoid' ? 'telemetry' : layout.tab
    const mapBig = layout.big === 'map'
    const runningMod = MODES.find(m => m.value === ai.mode)
    const toggleModule = (m: string) => {
        const starting = m !== ai.mode
        ai.toggle(m)
        if (starting) update({ tab: 'ai' })
    }

    return (
        <div className="flex flex-col h-full min-h-0 gap-2 text-zinc-100">
            {/* ── Top bar ─────────────────────────────────────────────────── */}
            <div className="h-12 shrink-0 flex items-center gap-2 px-2 rounded-xl border" style={PANEL}>
                <div className="flex-1 min-w-0"><StatusStrip avoid={avoid} /></div>
                {mounted && runningMod && (
                    <div className="h-9 flex items-center rounded-lg border overflow-hidden text-[11px] font-mono shrink-0"
                        style={{ borderColor: `${runningMod.color}66`, background: `${runningMod.color}14` }}>
                        <button onClick={() => update({ tab: 'ai', dockHidden: false })} title="Show the module's panel"
                            className="h-full pl-2.5 pr-2 flex items-center gap-1.5" style={{ color: runningMod.color }}>
                            <runningMod.icon size={14} />
                            <span className="font-bold tracking-wider">AI {runningMod.label.toUpperCase()}</span>
                        </button>
                        <button onClick={ai.stop} aria-label={`Stop ${runningMod.label}`} title="Stop the module"
                            className="h-full w-8 flex items-center justify-center border-l text-zinc-300 hover:text-white"
                            style={{ borderColor: `${runningMod.color}44` }}>
                            <X size={13} />
                        </button>
                    </div>
                )}
                {mounted && !wallOn && getVideoSource() === 'air_unit_udp' && (
                    <button onClick={() => setWallOn(true)}
                        className="h-9 px-2.5 rounded-lg border border-white/10 text-[10px] font-mono tracking-widest text-zinc-400"
                        title="Show every mesh unit delivering video">WALL</button>
                )}
                {mounted && <LinkCluster avoid={avoid} />}
                <button onClick={toggleDock} title={dockHidden ? 'Show panel (P)' : 'Hide panel (P)'}
                    className="h-9 w-9 rounded-lg border border-white/10 text-zinc-300 flex items-center justify-center">
                    {dockHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
                </button>
            </div>

            <div className="flex flex-1 min-h-0 gap-2">
                {/* ── Action rail ─────────────────────────────────────────── */}
                <div className="shrink-0 rounded-xl border p-1.5 overflow-y-auto" style={PANEL}>
                    <ActionRail avoid={avoid} />
                </div>

                {/* ── Stage ───────────────────────────────────────────────── */}
                <div ref={stageRef} className="relative flex-1 min-w-0 rounded-xl border border-white/10 overflow-hidden bg-black">
                    <div style={boxFor('video')} className="flex">
                        <div className="absolute inset-0 flex">
                            {wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream bare cleanFeed />}
                        </div>
                        {layout.big !== 'video' && pipChrome('video', 'VIDEO')}
                    </div>
                    <div style={boxFor('map')}>
                        {mounted && (layout.map3d
                            ? <MissionMap3D readOnly />
                            : <MissionMap readOnly follow compact={!mapBig} />)}
                        {!mapBig && pipChrome('map', layout.map3d ? 'MAP 3D' : 'MAP')}
                        {mapBig && (
                            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1600] flex rounded-lg border border-white/15 overflow-hidden text-[11px] font-mono"
                                style={{ background: 'rgba(9,11,16,.85)' }}>
                                {([false, true] as const).map(is3d => (
                                    <button key={String(is3d)} onClick={() => update({ map3d: is3d })}
                                        className="px-3 h-8 tracking-widest"
                                        style={layout.map3d === is3d ? { background: 'rgba(34,211,238,.2)', color: '#67e8f9' } : { color: '#a1a1aa' }}>
                                        {is3d ? '3D' : '2D'}</button>
                                ))}
                            </div>
                        )}
                    </div>
                    {mounted && ai.running && (
                        <div style={boxFor('ai')}>
                            <AiView />
                            {layout.big !== 'ai' && pipChrome('ai', `AI ${runningMod?.label.toUpperCase() ?? ''}`)}
                        </div>
                    )}
                    {mounted && (
                        <AiDrawer open={drawerOpen} onOpen={() => setDrawerOpen(true)}
                            onClose={() => setDrawerOpen(false)} mode={ai.mode} onToggle={toggleModule} />
                    )}
                </div>

                {/* ── Dock: tabs, resizable, hideable ─────────────────────── */}
                {!dockHidden && (
                    <>
                        <div onMouseDown={onDockDrag} className="w-1.5 -mx-1 shrink-0 cursor-col-resize flex items-center justify-center group"
                            title="Drag to resize">
                            <div className="w-0.5 h-10 rounded bg-zinc-500/40 group-hover:bg-cyan-400/80" />
                        </div>
                        <aside className="shrink-0 flex flex-col min-h-0 rounded-xl border overflow-hidden"
                            style={{ width: layout.dockW, background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
                            <div className="flex shrink-0 border-b" style={{ borderColor: 'hsl(var(--app-border))' }}>
                                {TABS.filter(tb => !(tb.id === 'avoid' && swarmEnabled)).map(tb => (
                                    <button key={tb.id} onClick={() => update({ tab: tb.id })}
                                        className={cn('flex-1 py-2.5 text-[10px] font-mono tracking-widest border-b-2 transition-colors',
                                            activeTab === tb.id ? 'border-cyan-400 text-cyan-400' : 'border-transparent')}
                                        style={activeTab === tb.id ? undefined : { color: 'hsl(var(--app-text-muted))' }}>
                                        {tb.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
                                {activeTab === 'avoid' && !swarmEnabled && (
                                    <>
                                        <div className="flex gap-2">
                                            <Toggle on={layout.radar} label="RADAR" onClick={() => update({ radar: !layout.radar })}
                                                hint="Top-down view of sensor sectors and mapped obstacles (polls the map once a second while on)" />
                                            <Toggle on={layout.depth} label="DEPTH" onClick={() => update({ depth: !layout.depth })}
                                                hint="Forward 90 degrees as a proximity bar" />
                                        </div>
                                        {layout.radar && <ObstacleRadar avoid={avoid} />}
                                        {layout.depth && <DepthStrip avoid={avoid} />}
                                        <AvoidancePanel />
                                    </>
                                )}
                                {activeTab === 'ai' && <AiPanel onStop={ai.stop} />}
                                {activeTab === 'telemetry' && <TelemetryPanel />}
                                {activeTab === 'setup' && (
                                    <>
                                        {!swarmEnabled && <IndoorNavCard avoid={avoid} />}
                                        {mounted && swarmEnabled
                                            ? <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                                Swarm mode - manage the fleet on the Fly tab.</p>
                                            : <DeviceSelector />}
                                        <div className="border-t pt-4" style={{ borderColor: 'hsl(var(--app-border))' }}>
                                            <DroneControls />
                                        </div>
                                    </>
                                )}
                                {activeTab === 'log' && <MessageLog />}
                            </div>
                        </aside>
                    </>
                )}
            </div>

            {/* ── Mission bar ─────────────────────────────────────────────── */}
            <div className="h-[68px] shrink-0 rounded-xl border" style={PANEL}>
                <MissionBar avoid={avoid} />
            </div>
        </div>
    )
}

'use client'

// COMMAND - the all-in-one flight window.
//
// One full-screen view (video or map) with the other as a picture-in-picture
// minimap, video-call style: click the minimap and the two trade places. The
// flight display floats over the main view. On the right, a dock with every
// panel the flight needs; it can be resized by dragging its edge, each section
// folds, and the whole dock can be hidden. Layout is remembered per browser.
//
// Swapping NEVER remounts the video or the map - both stay mounted and only
// their box moves, instantly (no animation: an animated resize makes the map
// redraw every frame and the video rescale every frame, for nothing) - so the stream does not restart and the map keeps its
// place. The map is read-only here (no click-to-add, no dragging).
//
// Keys: M swaps video and map.

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
    ChevronDown, ChevronRight, CornerDownLeft, Maximize2, Minimize2, PanelRightClose,
    PanelRightOpen,
} from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useSwarmStore } from '@/store/swarm'
import { getVideoSource } from '@/lib/videoSource'
import { cn } from '@/lib/utils'
import { OSDBar } from '@/components/osd/OSDBar'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { EmergencyStop } from '@/components/controls/EmergencyStop'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'

// Leaflet touches `window` - no SSR
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
interface Layout {
    big: View
    corner: Corner
    size: PipSize
    dockW: number
    dockHidden: boolean
    collapsed: Record<string, boolean>
}

const DEFAULT: Layout = { big: 'video', corner: 'bl', size: 'm', dockW: 340, dockHidden: false, collapsed: {} }
const STORE_KEY = 'hyrak-command-layout'
const PIP_DIMS: Record<PipSize, [number, number]> = { s: [220, 140], m: [320, 200], l: [440, 275] }
const CORNERS: Corner[] = ['bl', 'tl', 'tr', 'br']
const HUD_H = 58            // the floating flight display; top corners sit below it
const DOCK_MIN = 260, DOCK_MAX = 560

function loadLayout(): Layout {
    try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) return { ...DEFAULT, ...JSON.parse(raw) }
    } catch { /* storage unavailable: defaults */ }
    return DEFAULT
}
function saveLayout(l: Layout) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(l)) } catch { /* not critical */ }
}

function pipBox(corner: Corner, size: PipSize): React.CSSProperties {
    const [w, h] = PIP_DIMS[size]
    const pos: React.CSSProperties = { width: w, height: h, maxWidth: '45%', maxHeight: '45%' }
    if (corner[0] === 'b') pos.bottom = 12; else pos.top = HUD_H + 8
    if (corner[1] === 'l') pos.left = 12; else pos.right = 12
    return pos
}

function DockSection({ id, title, collapsed, onToggle, children }: {
    id: string; title: string; collapsed: boolean; onToggle: (id: string) => void; children: React.ReactNode
}) {
    return (
        <section className="rounded-xl border shrink-0"
            style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
            <button onClick={() => onToggle(id)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-[10px] font-mono tracking-widest"
                style={{ color: 'hsl(var(--app-text-muted))' }}
                aria-expanded={!collapsed}>
                {title}
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
            {!collapsed && <div className="px-4 pb-4 flex flex-col gap-3">{children}</div>}
        </section>
    )
}

export default function CommandPage() {
    const [mounted, setMounted] = useState(false)
    const [layout, setLayout] = useState<Layout>(DEFAULT)
    const [wallOn, setWallOn] = useState(false)
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const dragRef = useRef<{ x: number; w: number } | null>(null)

    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })   // raw feed, like the Fly tab
        setLayout(loadLayout())
        setMounted(true)
    }, [])

    const update = useCallback((patch: Partial<Layout>) => {
        setLayout(prev => { const next = { ...prev, ...patch }; saveLayout(next); return next })
    }, [])
    const swap = useCallback(() => {
        setLayout(prev => { const next = { ...prev, big: (prev.big === 'video' ? 'map' : 'video') as View }; saveLayout(next); return next })
    }, [])

    // M swaps video and map (not while typing in a field)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
            if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) swap()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [swap])

    // Dock resize: drag its left edge
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

    const toggleSection = (id: string) =>
        update({ collapsed: { ...layout.collapsed, [id]: !layout.collapsed[id] } })

    const boxFor = (v: View): React.CSSProperties =>
        layout.big === v
            ? { position: 'absolute', inset: 0, zIndex: 0 }
            : { position: 'absolute', zIndex: 30, borderRadius: 12, overflow: 'hidden',
                boxShadow: '0 8px 30px rgba(0,0,0,.55)', border: '1px solid rgba(255,255,255,.18)',
                ...pipBox(layout.corner, layout.size) }

    // The minimap's own chrome: the whole box swaps on click; small buttons move and resize it.
    const pipChrome = (label: string) => (
        <>
            <button onClick={swap} aria-label={`Show ${label} full screen`}
                className="absolute inset-0 z-[1500] cursor-pointer" style={{ background: 'transparent' }} />
            <div className="absolute top-1.5 left-1.5 right-1.5 z-[1600] flex items-center justify-between pointer-events-none">
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-widest"
                    style={{ background: 'rgba(0,0,0,.6)', color: '#e5e7eb' }}>{label} · click to expand</span>
                <span className="flex gap-1 pointer-events-auto">
                    <button onClick={() => update({ corner: CORNERS[(CORNERS.indexOf(layout.corner) + 1) % 4] })}
                        className="p-1 rounded" style={{ background: 'rgba(0,0,0,.6)', color: '#e5e7eb' }}
                        title="Move to the next corner"><CornerDownLeft size={11} /></button>
                    <button onClick={() => update({ size: layout.size === 's' ? 'm' : layout.size === 'm' ? 'l' : 's' })}
                        className="p-1 rounded" style={{ background: 'rgba(0,0,0,.6)', color: '#e5e7eb' }}
                        title="Minimap size">{layout.size === 'l' ? <Minimize2 size={11} /> : <Maximize2 size={11} />}</button>
                </span>
            </div>
        </>
    )

    const dockHidden = mounted && layout.dockHidden

    return (
        <div className="flex h-full gap-0 min-h-0">
            {/* ── Stage: main view + minimap + floating HUD ───────────────── */}
            <div className="relative flex-1 min-w-0 rounded-xl border overflow-hidden bg-black"
                style={{ borderColor: 'hsl(var(--app-border))' }}>

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

                {/* Flight display, floating over whichever view is full screen */}
                <div className="absolute top-2 left-2 right-2 z-20 rounded-xl border overflow-hidden"
                    style={{ background: 'hsl(var(--app-surface) / .82)', borderColor: 'hsl(var(--app-border))',
                        backdropFilter: 'blur(8px)' }}>
                    <OSDBar />
                </div>

                {/* Drone messages + camera wall, top right under the HUD */}
                <div className="absolute right-2 z-[25] flex flex-col items-end gap-2" style={{ top: HUD_H + 8 }}>
                    <FcMessageLog variant="floating" />
                    {mounted && layout.big === 'video' && !wallOn && getVideoSource() === 'air_unit_udp' && (
                        <button onClick={() => setWallOn(true)}
                            className="px-2 py-1 rounded border text-[10px] font-mono tracking-widest"
                            style={{ background: 'rgba(17,19,24,.85)', borderColor: 'rgba(255,255,255,.12)', color: '#a1a1aa' }}
                            title="Show every mesh unit that is delivering video">WALL</button>
                    )}
                </div>

                {/* Show / hide the dock */}
                <button onClick={() => update({ dockHidden: !layout.dockHidden })}
                    className="absolute right-2 bottom-2 z-[26] flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono tracking-widest"
                    style={{ background: 'rgba(17,19,24,.85)', borderColor: 'rgba(255,255,255,.12)', color: '#a1a1aa' }}
                    title={dockHidden ? 'Show panels' : 'Hide panels'}>
                    {dockHidden ? <PanelRightOpen size={12} /> : <PanelRightClose size={12} />}
                    {dockHidden ? 'PANELS' : 'HIDE'}
                </button>
            </div>

            {/* ── Dock: resizable, sections fold ─────────────────────────── */}
            {!dockHidden && (
                <>
                    <div onMouseDown={onDragStart}
                        className="w-2 shrink-0 cursor-col-resize flex items-center justify-center group"
                        title="Drag to resize the panels">
                        <div className="w-0.5 h-10 rounded bg-zinc-500/40 group-hover:bg-cyan-400/80" />
                    </div>
                    <aside className="shrink-0 flex flex-col gap-3 min-h-0" style={{ width: layout.dockW }}>
                        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-0.5">
                            <DockSection id="devices" title="DEVICES" collapsed={!!layout.collapsed.devices} onToggle={toggleSection}>
                                {mounted && swarmEnabled
                                    ? <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                        Swarm mode - manage the fleet on the Fly tab.</p>
                                    : <DeviceSelector />}
                            </DockSection>
                            <DockSection id="controls" title="FLIGHT CONTROLS" collapsed={!!layout.collapsed.controls} onToggle={toggleSection}>
                                <DroneControls />
                            </DockSection>
                            {!swarmEnabled && (
                                <DockSection id="avoidance" title="AVOIDANCE" collapsed={!!layout.collapsed.avoidance} onToggle={toggleSection}>
                                    <AvoidancePanel />
                                </DockSection>
                            )}
                            <DockSection id="telemetry" title="TELEMETRY DATA" collapsed={!!layout.collapsed.telemetry} onToggle={toggleSection}>
                                <TelemetryPanel />
                            </DockSection>
                        </div>
                        <div className="shrink-0 pb-1">
                            <EmergencyStop />
                        </div>
                    </aside>
                </>
            )}
        </div>
    )
}

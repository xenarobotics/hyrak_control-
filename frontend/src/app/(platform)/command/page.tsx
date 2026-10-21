'use client'

// COMMAND - the all-in-one flight window (design audit 2, 5.2).
//
// The global status bar above carries the link, the aircraft's state and
// HOLD / RTL / LAND / KILL; this page adds its avoidance state to that bar
// (AvoidChips). Below it, fixed places, no chrome floating over the picture
// except the stage's own switches:
//   centre  the stage - video (with the Fly tab's configurable OSD), map (2D
//           or 3D) or, while an AI module runs, the AI view - and the others
//           as pictures-in-picture pinned to corners. Video | Map switch top
//           left; click a PiP to make it the main view, drag it to another
//           corner. The AI drawer (slim tab on the left edge) starts and stops
//           the AI modules.
//   right   the dock, icon tabs, one at a time: avoidance (+ optional radar
//           and forward-depth views), the running AI module's panel,
//           telemetry, setup (devices + full controls), message log. Drag its
//           edge to resize; P hides it.
//   bottom  the action bar: the two links (telemetry, video), arm, take off,
//           fly the mission; then the mission's altitude profile and
//           next / left / time.
// Below 768px: stage, links, dock, with the action bar pinned at the bottom.
//
// Keys: M swaps video and map, P shows/hides the dock.
// Swapping never remounts the video or the map, so the stream never restarts.
// The map is read-only here (edit missions on the Mission tab).

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Scaling, PanelRightClose, PanelRightOpen, X, ShieldCheck, Bot, Activity, SlidersHorizontal, ScrollText, Video, Map as MapIcon, AudioLines } from 'lucide-react'
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
import { AvoidChips } from '@/components/command/AvoidChips'
import { LinkCluster } from '@/components/command/LinkCluster'
import { ActionBar } from '@/components/command/ActionBar'
import { MissionBar } from '@/components/command/MissionBar'
import { ObstacleRadar, DepthStrip } from '@/components/command/ObstacleRadar'
import { useAvoidanceLive } from '@/components/command/useAvoidanceLive'
import { useUiMode } from '@/hooks/useUiMode'
import { useClientValue, useHydrated } from '@/hooks/useClientValue'
import { SimpleCommand } from '@/components/simple/SimpleCommand'
import { IndoorNavCard } from '@/components/command/IndoorNavCard'
import { AiDrawer } from '@/components/command/AiDrawer'
import { AiView } from '@/components/command/AiView'
import { AiPanel } from '@/components/command/AiPanel'
import { useAiModule } from '@/components/command/useAiModule'
import { useLibraryEntry } from '@/components/models/useModelLibrary'
import { ViewOnlyFence } from '@/components/layout/ViewOnly'
import { useLiveScope } from '@/hooks/useLiveScope'
import { useResolvedDroneId } from '@/lib/droneId'
import { FOCUS, FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { CopilotPanel } from '@/components/copilot/CopilotPanel'
import { CopilotHost } from '@/components/copilot/CopilotHost'
import { CopilotVideoOverlay } from '@/components/copilot/CopilotVideoOverlay'
import { PushToTalkFab } from '@/components/copilot/PushToTalk'
import { useCopilotStore } from '@/lib/copilot'

const mapLoading = () => (
    <div className="w-full h-full flex items-center justify-center bg-app-surface-2">
        <p className="text-[13px] text-app-text-muted">Loading map</p>
    </div>
)
const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), { ssr: false, loading: mapLoading })
const MissionMap3D = dynamic(() => import('@/components/mission/MissionMap3D'), { ssr: false, loading: mapLoading })

type View = 'video' | 'map' | 'ai'
type Corner = 'bl' | 'br' | 'tl' | 'tr'
type PipSize = 's' | 'm' | 'l'
type DockTab = 'avoid' | 'ai' | 'copilot' | 'telemetry' | 'setup' | 'log'
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
const TABS: { id: DockTab; label: string; hint: string; icon: typeof Bot }[] = [
    { id: 'avoid', label: 'Avoid', hint: 'Obstacle avoidance', icon: ShieldCheck },
    { id: 'ai', label: 'AI', hint: 'The running AI module', icon: Bot },
    { id: 'copilot', label: 'Copilot', hint: 'Copilot: fly and ask by voice', icon: AudioLines },
    { id: 'telemetry', label: 'Telemetry', hint: 'Every telemetry value', icon: Activity },
    { id: 'setup', label: 'Setup', hint: 'Devices, link and full flight controls', icon: SlidersHorizontal },
    { id: 'log', label: 'Log', hint: 'Messages from the aircraft', icon: ScrollText },
]
// The dock and the action bar follow the theme.
const PANEL = "bg-app-surface border-app-border"

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
// Read once per page load and kept in step by saveLayout, so the hydration-
// safe read below always gets the same object until the layout changes.
let cachedLayout: Layout | null = null
const savedLayout = (): Layout => (cachedLayout ??= loadLayout())

function saveLayout(l: Layout) {
    cachedLayout = l
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
    if (!msgs.length) return <p className="text-[13px] text-app-text-muted">No messages from the aircraft yet.</p>
    return (
        <div className="flex flex-col gap-1.5 text-[13px]">
            {[...msgs].reverse().slice(0, 200).map(m => (
                <div key={(m as { id?: number }).id ?? m.ts} className="flex gap-2">
                    <span className="text-app-text-muted tabular-nums shrink-0">{new Date(m.ts * 1000).toLocaleTimeString()}</span>
                    <span className={cn(m.rank >= 5 ? 'text-app-danger font-semibold' : m.rank >= 4 ? 'text-app-warn font-semibold' : 'text-app-text')}>{m.text}</span>
                </div>
            ))}
        </div>
    )
}

function Toggle({ on, label, hint, onClick }: { on: boolean; label: string; hint: string; onClick: () => void }) {
    return (
        <button onClick={onClick} title={hint} aria-pressed={on}
            className={cn('flex-1 h-9 rounded-md border text-[13px] font-semibold transition-colors duration-[140ms] active:scale-[.98]', FOCUS,
                on ? 'bg-app-accent-soft border-app-accent text-app-selected-ink'
                    : 'border-app-border-strong text-app-text-muted hover:text-app-text hover:bg-app-surface-2')}>
            {label} <span className="font-normal">{on ? 'on' : 'off'}</span>
        </button>
    )
}

/** A segmented switch drawn over the stage (video or map). */
function StageSeg<T extends string>({ value, options, onChange, label }: {
    value: T; options: { id: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void; label: string
}) {
    return (
        <div role="group" aria-label={label}
            className="flex gap-0.5 p-0.5 rounded-md border border-overlay-border bg-overlay-scrim backdrop-blur-[6px] shadow-[var(--app-shadow)]">
            {options.map(o => (
                <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={value === o.id}
                    className={cn('flex items-center gap-1.5 h-8 px-3 rounded text-[13px] font-bold transition-colors duration-[140ms]', FOCUS_OVERLAY,
                        value === o.id ? 'bg-[color-mix(in_srgb,var(--overlay-accent)_18%,transparent)] text-overlay-selected-ink'
                            : 'text-overlay-muted hover:text-overlay-text')}>
                    {o.icon}{o.label}
                </button>
            ))}
        </div>
    )
}

// Normal mode (anyone can fly) or Dev mode (this full engineering screen).
export default function CommandPage() {
    const [uiMode] = useUiMode()
    if (uiMode === null) return null
    return uiMode === 'normal' ? <SimpleCommand /> : <DevCommand />
}

function DevCommand() {
    const mounted = useHydrated()
    // The saved layout comes in hydration-safely; the first change made here
    // forks it into local state (and saveLayout keeps the cache in step).
    const saved = useClientValue(savedLayout, DEFAULT)
    const [own, setOwn] = useState<Layout | null>(null)
    const layout = own ?? saved
    // Updaters only ever run in the browser, where savedLayout() is the real
    // stored layout - so this stays stable and never forks from DEFAULT.
    const setLayout = useCallback(
        (f: (prev: Layout) => Layout) => setOwn(prev => f(prev ?? savedLayout())), [])
    const [wallOn, setWallOn] = useState(false)
    const [drag, setDrag] = useState<{ view: View; x: number; y: number } | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const ai = useAiModule()
    const swarmEnabled = useSwarmStore(s => s.enabled)
    // Workspace viewers (docs/ACCESS_MODEL.md section 8a) watch only: the
    // command surfaces below are fenced and the AI drawer is not offered.
    const { viewOnly } = useLiveScope()
    const avoid = useAvoidanceLive()
    const copilotOn = useCopilotStore(s => s.enabled)
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
    }, [])

    const update = useCallback((patch: Partial<Layout>) => {
        setLayout(prev => { const next = { ...prev, ...patch }; saveLayout(next); return next })
    }, [setLayout])
    // `v` becomes the main view; the old main view takes v's PiP corner.
    const makeBig = useCallback((v: View) => setLayout(prev => {
        if (prev.big === v) return prev
        const next = { ...prev, big: v, corners: { ...prev.corners, [prev.big]: prev.corners[v] } }
        saveLayout(next); return next
    }), [setLayout])
    const swap = useCallback(() => setLayout(prev => {
        const v: View = prev.big === 'map' ? 'video' : 'map'
        const next = { ...prev, big: v, corners: { ...prev.corners, [prev.big]: prev.corners[v] } }
        saveLayout(next); return next
    }), [setLayout])

    // The AI view exists only while a module runs; if it was the main view
    // when the module stopped, the video takes over.
    // Adjusted during render: an effect would paint one frame of the empty AI view.
    if (mounted && !ai.running && layout.big === 'ai') makeBig('video')
    const toggleDock = useCallback(() => setLayout(prev => {
        const next = { ...prev, dockHidden: !prev.dockHidden }; saveLayout(next); return next
    }), [setLayout])

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

    // PiP chrome: a header band (label left, size right) and the picture
    // below it. Both start a drag or, on a plain click, make the PiP the main
    // view; the size button sits inside the band, so no two controls overlap.
    const pipChrome = (view: View, label: string) => (
        <>
            <div onPointerDown={e => onPipDown(e, view)} role="button" aria-label={`Show ${label} full screen`}
                className="absolute inset-x-0 bottom-0 top-11 z-[1500] cursor-pointer touch-none select-none" style={{ background: 'transparent' }} />
            <div onPointerDown={e => onPipDown(e, view)}
                className="absolute top-0 inset-x-0 h-11 px-1.5 z-[1600] flex items-center justify-between cursor-pointer touch-none select-none"
                title="Click to enlarge, drag to move">
                <span className="px-2 py-1 rounded-md text-[12px] font-bold bg-overlay-scrim text-overlay-text">
                    {label}</span>
                <button onPointerDown={e => e.stopPropagation()}
                    onClick={() => update({ size: layout.size === 's' ? 'm' : layout.size === 'm' ? 'l' : 's' })}
                    className={cn(OVERLAY_BTN, 'w-8 px-0', FOCUS_OVERLAY)}
                    title={`Picture size: ${layout.size === 's' ? 'small' : layout.size === 'm' ? 'medium' : 'large'}`} aria-label="Picture size">
                    <Scaling size={14} /></button>
            </div>
        </>
    )

    const dockHidden = mounted && layout.dockHidden
    // Swarm mode has no AVOID tab: a persisted 'avoid' left the dock blank.
    // Customers have it since phase 2b, for their own drone
    // (docs/ACCESS_MODEL.md 8b; the server scopes every route to it).
    const noAvoid = swarmEnabled
    const activeTab: DockTab = noAvoid && layout.tab === 'avoid' ? 'telemetry' : layout.tab
    const mapBig = layout.big === 'map'
    const runningMod = useLibraryEntry(ai.mode)
    const toggleModule = (m: string) => {
        const starting = m !== ai.mode
        ai.toggle(m)
        if (starting) update({ tab: 'ai' })
    }

    const tabs = TABS.filter(tb => !(tb.id === 'avoid' && noAvoid))
    const tabIdx = Math.max(0, tabs.findIndex(tb => tb.id === activeTab))
    const bigSel: 'video' | 'map' | 'ai' = layout.big
    // Avoid tab with no drone: one empty state, filling the panel.
    const avoidDroneId = useResolvedDroneId()

    return (
        <div className="flex flex-col h-full min-h-0 gap-3 text-app-text overflow-y-auto md:overflow-hidden">
            {/* Command's own status (avoidance, home) goes into the global bar. */}
            <AvoidChips avoid={avoid} />

            <div className="flex flex-col md:flex-row md:flex-1 md:min-h-0 gap-3">
                {/* ── Stage ───────────────────────────────────────────────── */}
                <div ref={stageRef} className="relative shrink-0 aspect-video min-h-[200px] md:aspect-auto md:min-h-0 md:shrink md:flex-1 min-w-0 rounded-[10px] border border-app-border overflow-hidden bg-app-surface-2">
                    <div style={boxFor('video')} className={cn('flex', layout.big !== 'video' && 'max-md:hidden')}>
                        <div className="absolute inset-0 flex">
                            {wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream bare cleanFeed />}
                            {!wallOn && <CopilotVideoOverlay interactive={layout.big === 'video'} />}
                        </div>
                        {layout.big !== 'video' && pipChrome('video', 'Video')}
                    </div>
                    <div style={boxFor('map')} className={cn(!mapBig && 'max-md:hidden')}>
                        {mounted && (layout.map3d
                            ? <MissionMap3D readOnly showNav={mapBig} />
                            : <MissionMap readOnly follow compact={!mapBig} />)}
                        {!mapBig && pipChrome('map', layout.map3d ? 'Map 3D' : 'Map')}
                    </div>
                    {mounted && ai.running && (
                        <div style={boxFor('ai')} className={cn(layout.big !== 'ai' && 'max-md:hidden')}>
                            <AiView />
                            {layout.big !== 'ai' && pipChrome('ai', `AI ${runningMod?.name ?? ''}`)}
                        </div>
                    )}

                    {/* Stage switches: what is big, and the map's 2D / 3D. */}
                    <div className="absolute top-2 left-2 z-[1600] flex items-center gap-1.5">
                        <StageSeg label="Main view" value={bigSel}
                            onChange={v => makeBig(v)}
                            options={[
                                { id: 'video', label: 'Video', icon: <Video size={14} /> },
                                { id: 'map', label: 'Map', icon: <MapIcon size={14} /> },
                                ...(mounted && ai.running ? [{ id: 'ai' as const, label: 'AI', icon: <Bot size={14} /> }] : []),
                            ]} />
                        {mapBig && (
                            <StageSeg label="Map view" value={layout.map3d ? '3d' : '2d'}
                                onChange={v => update({ map3d: v === '3d' })}
                                options={[{ id: '2d', label: '2D' }, { id: '3d', label: '3D' }]} />
                        )}
                    </div>
                    <div className="absolute top-2 right-2 z-[1600] flex items-center gap-1.5">
                        {mounted && runningMod && (
                            <div className="h-9 flex items-center rounded-md border border-overlay-border bg-overlay-scrim backdrop-blur-[6px] overflow-hidden text-[13px]">
                                <button onClick={() => update({ tab: 'ai', dockHidden: false })} title="Show the module's panel"
                                    className={cn('h-full pl-2.5 pr-2 flex items-center gap-1.5', FOCUS_OVERLAY)} style={{ color: runningMod.color }}>
                                    <runningMod.icon size={14} />
                                    <span className="font-bold text-overlay-text">AI: {runningMod.name}</span>
                                </button>
                                <button onClick={ai.stop} aria-label={`Stop ${runningMod.name}`} title="Stop the module"
                                    className={cn('h-full w-8 flex items-center justify-center border-l border-overlay-border text-overlay-muted hover:text-overlay-text', FOCUS_OVERLAY)}>
                                    <X size={13} />
                                </button>
                            </div>
                        )}
                        {mounted && !wallOn && getVideoSource() === 'air_unit_udp' && (
                            <button onClick={() => setWallOn(true)} className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'h-9')}
                                title="Show every mesh unit delivering video">Wall</button>
                        )}
                        <button onClick={toggleDock} title={dockHidden ? 'Show panel (P)' : 'Hide panel (P)'}
                            aria-label={dockHidden ? 'Show panel' : 'Hide panel'} aria-expanded={!dockHidden}
                            className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'hidden md:inline-flex h-9 w-9 px-0')}>
                            {dockHidden ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                        </button>
                    </div>

                    {mounted && !viewOnly && (
                        <AiDrawer open={drawerOpen} onOpen={() => setDrawerOpen(true)}
                            onClose={() => setDrawerOpen(false)} mode={ai.mode} onToggle={toggleModule} />
                    )}
                </div>

                {/* Links: on a phone they sit under the stage (the action bar
                    at the bottom carries only the flight actions there). */}
                {mounted && <div className="md:hidden flex flex-wrap gap-2"><LinkCluster avoid={avoid} /></div>}

                {/* ── Dock: icon tabs, resizable, hideable ────────────────── */}
                {!dockHidden && (
                    <>
                        <div onMouseDown={onDockDrag} className="hidden md:flex w-1.5 -mx-1.5 shrink-0 cursor-col-resize items-center justify-center group"
                            title="Drag to resize">
                            <div className="w-0.5 h-10 rounded bg-app-accent opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100" />
                        </div>
                        <aside className={cn('w-full md:w-[var(--dock-w)] shrink-0 flex flex-col md:min-h-0 rounded-[10px] border overflow-hidden', PANEL)}
                            style={{ '--dock-w': `${layout.dockW}px` } as React.CSSProperties}>
                            {/* Tabs: icon and a short word, the full name in the
                                tooltip; the underline slides to the open one. */}
                            <div role="tablist" aria-label="Panel" className="relative flex shrink-0 border-b border-app-border">
                                {tabs.map(tb => (
                                    <button key={tb.id} role="tab" aria-selected={activeTab === tb.id} onClick={() => update({ tab: tb.id })}
                                        title={tb.hint} aria-label={tb.hint}
                                        className={cn('flex-1 min-w-0 h-14 flex flex-col items-center justify-center gap-1 text-[12px] font-semibold transition-colors duration-[140ms]', FOCUS,
                                            activeTab === tb.id ? 'text-app-selected-ink' : 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2')}>
                                        <tb.icon size={18} />
                                        <span className="whitespace-nowrap">{tb.label}</span>
                                    </button>
                                ))}
                                <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-app-accent transition-transform duration-[220ms] ease-[var(--ease-out)] motion-reduce:transition-none"
                                    style={{ width: `${100 / tabs.length}%`, transform: `translateX(${tabIdx * 100}%)` }} />
                            </div>
                            <div key={activeTab} className="md:flex-1 md:min-h-0 overflow-y-auto p-4 flex flex-col gap-4 animate-in fade-in-0 duration-200">
                                {activeTab === 'avoid' && !noAvoid && !avoidDroneId && (
                                    <div className="flex-1 flex items-center justify-center">
                                        <ViewOnlyFence><AvoidancePanel /></ViewOnlyFence>
                                    </div>
                                )}
                                {activeTab === 'avoid' && !noAvoid && avoidDroneId && (
                                    <>
                                        <div className="flex gap-2">
                                            <Toggle on={layout.radar} label="Radar" onClick={() => update({ radar: !layout.radar })}
                                                hint="Top-down view of sensor sectors and mapped obstacles (polls the map once a second while on)" />
                                            <Toggle on={layout.depth} label="Depth" onClick={() => update({ depth: !layout.depth })}
                                                hint="Forward 90 degrees as a proximity bar" />
                                        </div>
                                        {layout.radar && <ObstacleRadar avoid={avoid} />}
                                        {layout.depth && <DepthStrip avoid={avoid} />}
                                        <ViewOnlyFence><AvoidancePanel /></ViewOnlyFence>
                                    </>
                                )}
                                {activeTab === 'ai' && <ViewOnlyFence><AiPanel onStop={ai.stop} /></ViewOnlyFence>}
                                {activeTab === 'copilot' && <ViewOnlyFence><CopilotPanel /></ViewOnlyFence>}
                                {activeTab === 'telemetry' && <TelemetryPanel />}
                                {activeTab === 'setup' && (
                                    <>
                                        {!noAvoid && <ViewOnlyFence note={false}><IndoorNavCard avoid={avoid} /></ViewOnlyFence>}
                                        {mounted && swarmEnabled
                                            ? <p className="text-[13px] text-app-text-muted">
                                                Swarm mode: manage the fleet on the Fly tab.</p>
                                            : <DeviceSelector />}
                                        <div className="border-t border-app-border pt-4 flex flex-col gap-2">
                                            <ViewOnlyFence><DroneControls /></ViewOnlyFence>
                                        </div>
                                    </>
                                )}
                                {activeTab === 'log' && <MessageLog />}
                            </div>
                        </aside>
                    </>
                )}
            </div>

            {mounted && !viewOnly && <CopilotHost />}

            {/* ── Action bar: links, arm, take off, mission ───────────────── */}
            <div className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 flex items-center gap-3 min-w-0',
                'max-md:sticky max-md:bottom-0 max-md:z-20 max-md:mt-auto max-md:shadow-[var(--app-shadow)]', PANEL)}>
                {/* Phone: hold to talk under the thumb, just above this bar,
                    while the Copilot tab is open. */}
                {mounted && !viewOnly && !dockHidden && activeTab === 'copilot' && copilotOn && (
                    <div className="md:hidden absolute right-2 bottom-[calc(100%+12px)]"><PushToTalkFab disabled={false} /></div>
                )}
                {mounted && <div className="hidden md:flex items-center shrink-0"><LinkCluster avoid={avoid} /></div>}
                <span aria-hidden className="hidden md:block w-px h-6 bg-app-border shrink-0" />
                <ViewOnlyFence compact>
                    <ActionBar avoid={avoid} />
                </ViewOnlyFence>
                <div className="hidden lg:block flex-1 min-w-[240px] h-12 border-l border-app-border pl-3">
                    <MissionBar avoid={avoid} />
                </div>
            </div>
        </div>
    )
}

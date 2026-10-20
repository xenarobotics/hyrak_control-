'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { OSDBar } from '@/components/osd/OSDBar'
import { EmergencyStop } from '@/components/controls/EmergencyStop'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { getVideoSource } from '@/lib/videoSource'
import { Separator } from '@/components/ui/separator'
import { ChevronRight, ChevronLeft, Radio, Video, Map as MapIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS, FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { useHydrated } from '@/hooks/useClientValue'
import { useAccess } from '@/hooks/useAccess'
import { ViewOnlyFence } from '@/components/layout/ViewOnly'
import { AttachmentStrip } from '@/components/attachments/AttachmentStrip'

// Leaflet touches `window` - no SSR
const FleetMap = dynamic(() => import('@/components/swarm/FleetMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center rounded-[10px] border border-app-border">
            <p className="text-[13px] text-app-text-muted">Loading map…</p>
        </div>
    ),
})

// ── Fleet device summary shown instead of DeviceSelector in swarm mode ──────

function FleetDeviceSummary() {
    const drones      = useSwarmStore(s => s.drones)
    const activeDroneId = useSwarmStore(s => s.activeDroneId)
    const setActiveDrone = useSwarmStore(s => s.setActiveDrone)
    const scanStatus  = useSwarmStore(s => s.scanStatus)

    const droneList   = Object.values(drones)
    const connected   = droneList.filter(d => d.connected)

    if (droneList.length === 0) {
        return (
            <div className="text-[13px] text-center py-2 text-app-text-muted">
                {scanStatus === 'scanning' ? 'Scanning for drones…' : 'No drones found. Use the Fleet panel.'}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[13px] mb-0.5 text-app-text-muted">
                {connected.length}/{droneList.length} connected - tap to control
            </div>
            {droneList.map(drone => {
                const isActive = drone.id === activeDroneId
                return (
                    <button
                        key={drone.id}
                        onClick={() => setActiveDrone(isActive ? null : drone.id)}
                        aria-pressed={isActive}
                        className={cn('flex items-center gap-2 w-full min-h-9 rounded-md px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] border', FOCUS,
                            isActive ? '' : 'bg-app-bg border-app-border hover:border-app-border-strong')}
                        style={isActive ? { background: drone.color + '18', borderColor: drone.color + '90' } : undefined}
                    >
                        <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: drone.connected ? drone.color : 'hsl(var(--app-text-subtle))' }}
                        />
                        <span className="flex-1 text-[14px] font-semibold truncate text-app-text">
                            {drone.name}
                        </span>
                        {isActive && (
                            <span className="text-[12px] font-bold px-1.5 rounded-md border border-app-accent text-app-accent bg-app-accent-soft">
                                CTRL
                            </span>
                        )}
                        <Radio size={14} className={drone.connected ? '' : 'text-app-text-subtle'}
                            style={{ color: drone.connected ? drone.color : undefined, flexShrink: 0 }} />
                    </button>
                )
            })}
        </div>
    )
}

/** A titled card on the Fly side panel. */
function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
    return (
        <section className={cn('rounded-[10px] border border-app-border bg-app-surface shadow-[var(--app-shadow)] p-4 flex flex-col gap-3', className)}>
            <h2 className="text-[16px] font-bold leading-tight text-app-text">{title}</h2>
            {children}
        </section>
    )
}

export default function FlyPage() {
    const [panelCollapsed, setPanelCollapsed] = useState(false)
    const [wallOn, setWallOn] = useState(false)
    // Deferred mount flag prevents sessionStorage-driven Zustand values from
    // reaching the JSX on the initial (hydration) render. Without this, the
    // server renders with enabled=false while the client immediately reads
    // enabled=true from sessionStorage, causing a React hydration mismatch.
    const mounted = useHydrated()
    const [mainView, setMainView] = useState<'video' | 'map'>('video')
    const swarmEnabled    = useSwarmStore(s => s.enabled)
    const setSwarmEnabled = useSwarmStore(s => s.setEnabled)
    // Swarm and the fleet are staff-only (docs/ACCESS_MODEL.md section 8a).
    const { isCustomer } = useAccess()

    // Whenever the user lands on the Fly tab, reset the backend to raw-feed mode
    // so the OSD never shows a stale annotated frame from a previous AI session.
    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
    }, [])

    return (
        // Below 768px the page stacks and scrolls: readouts, video (16:9,
        // never collapsed), then the panel, with the emergency stop pinned.
        <div className="flex flex-col h-full gap-3 overflow-y-auto md:overflow-hidden">

            {/* OSD bar */}
            <div className="rounded-[10px] border border-app-border bg-app-surface shadow-[var(--app-shadow)] shrink-0">
                <OSDBar />
            </div>

            {/* Main */}
            <div className="flex flex-col md:flex-row md:flex-1 gap-3 md:min-h-0">

                {/* Main area: video, or the live fleet map in swarm mode */}
                <div className="relative shrink-0 aspect-video min-h-[200px] md:aspect-auto md:min-h-0 md:shrink md:flex-1 min-w-0 flex">
                    {mounted && swarmEnabled && mainView === 'map'
                        ? <FleetMap />
                        : wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream />}
                    {mounted && !wallOn && getVideoSource() === 'air_unit_udp' && !(swarmEnabled && mainView === 'map') && (
                        <button onClick={() => setWallOn(true)}
                            className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'absolute right-3 bottom-14 z-20')}
                            title="Show every mesh unit that is delivering video">
                            Wall
                        </button>
                    )}

                    {/* THE DRONE'S MESSAGES, ON THE ONE SURFACE THAT IS ALWAYS
                        THERE. This first went into the right-hand panel, which
                        is collapsible AND scrolls - so on the Fly tab it was
                        either below the fold or hidden entirely, and the report
                        was simply "I can't see them". The video pane is the one
                        thing on this tab that cannot be collapsed away, and the
                        moment you want this is the moment something has gone
                        wrong on the aircraft you are watching. */}
                    <div className="absolute top-2 right-2 z-[1100]">
                        <FcMessageLog variant="floating" />
                    </div>

                    {/* VIDEO / MAP toggle - swarm mode only */}
                    {mounted && swarmEnabled && (
                        <div className="absolute top-2 left-2 z-[1100] flex gap-0.5 p-0.5 rounded-md border border-overlay-border bg-overlay-scrim backdrop-blur-[6px]">
                            {([['video', Video, 'Video'], ['map', MapIcon, 'Map']] as const).map(([key, Icon, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setMainView(key)}
                                    aria-pressed={mainView === key}
                                    className={cn('flex items-center gap-1.5 h-8 px-3 rounded text-[13px] font-bold transition-colors duration-[var(--dur-fast)]', FOCUS_OVERLAY,
                                        mainView === key ? 'bg-[rgba(34,211,238,.22)] text-[var(--overlay-accent)]' : 'text-overlay-muted hover:text-overlay-text')}
                                >
                                    <Icon size={14} />
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                {/* Collapse toggle */}
                <button
                    onClick={() => setPanelCollapsed(p => !p)}
                    className={cn('hidden md:flex self-center shrink-0 h-8 w-8 items-center justify-center rounded-md border border-app-border-strong text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[var(--dur-fast)]', FOCUS)}
                    title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
                    aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
                    aria-expanded={!panelCollapsed}
                >
                    {panelCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                </button>

                {/* Right panel */}
                <div className={cn(
                    'flex flex-col gap-3 shrink-0 w-full md:overflow-hidden transition-opacity duration-[var(--dur-slow)]',
                    panelCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-72 xl:w-80 md:opacity-100'
                )}>
                    <div className="flex flex-col gap-3 md:h-full md:overflow-y-auto md:pr-0.5">

                        <Panel title="Devices">
                            {mounted && swarmEnabled ? (
                                // In swarm mode: show fleet summary instead of single-drone selector
                                <FleetDeviceSummary />
                            ) : (
                                <DeviceSelector />
                            )}
                            {!isCustomer && <div
                                className="flex items-center justify-between pt-3 mt-1 border-t border-app-border"
                            >
                                <span id="fly-swarm-label" className="text-[14px] font-semibold text-app-text">
                                    Swarm mode
                                </span>
                                <button
                                    onClick={() => setSwarmEnabled(!swarmEnabled)}
                                    role="switch"
                                    aria-checked={mounted && swarmEnabled}
                                    aria-labelledby="fly-swarm-label"
                                    className={cn(
                                        'relative w-11 h-6 rounded-full transition-colors duration-[var(--dur)] shrink-0 border',
                                        'after:absolute after:-inset-1.5 after:content-[""]',
                                        FOCUS,
                                        mounted && swarmEnabled
                                            ? 'bg-app-accent border-app-accent'
                                            : 'bg-app-surface-2 border-app-border-strong'
                                    )}
                                    title={mounted && swarmEnabled ? 'Disable swarm mode' : 'Enable swarm mode'}
                                >
                                    <span className={cn(
                                        'absolute left-0 top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full',
                                        'shadow-md transition-transform duration-[var(--dur)]',
                                        mounted && swarmEnabled ? 'translate-x-[21px] bg-white' : 'translate-x-[2px] bg-app-text-muted'
                                    )} />
                                </button>
                            </div>}
                        </Panel>

                        <Panel title="Flight controls">
                            <ViewOnlyFence><DroneControls /></ViewOnlyFence>
                        </Panel>

                        {/* Hidden when the drone has no attachments, and for viewers. */}
                        {!swarmEnabled && (
                            <AttachmentStrip frame={strip => <Panel title="Attachments">{strip}</Panel>} />
                        )}

                        {!swarmEnabled && (
                            <Panel title="Avoidance">
                                <ViewOnlyFence note={false}><AvoidancePanel /></ViewOnlyFence>
                            </Panel>
                        )}

                        <div className="rounded-[10px] border border-app-border bg-app-surface shadow-[var(--app-shadow)] flex flex-col md:flex-1 md:min-h-0">
                            <h2 className="text-[16px] font-bold text-app-text px-4 pt-4 pb-2 shrink-0">
                                Telemetry
                            </h2>
                            <div className="md:flex-1 md:overflow-y-auto px-4 pb-4 md:min-h-0">
                                <TelemetryPanel />
                            </div>
                        </div>

                        {/* Pinned to the bottom of the screen on phones, so it is always reachable. */}
                        <div className="shrink-0 pb-1 sticky bottom-0 z-10 bg-app-bg pt-2 md:static md:pt-0">
                            <Separator className="mb-3 hidden md:block bg-app-border" />
                            <ViewOnlyFence note={false}><EmergencyStop /></ViewOnlyFence>
                        </div>

                    </div>
                </div>

            </div>
        </div>
    )
}
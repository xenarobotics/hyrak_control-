'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { OSDBar } from '@/components/osd/OSDBar'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { getVideoSource } from '@/lib/videoSource'
import { ChevronDown, PanelRightClose, PanelRightOpen, Radio, Video, Map as MapIcon, Plug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS, FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { useHydrated } from '@/hooks/useClientValue'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
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
                                In control
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
function Panel({ title, children, className, action }: {
    title: string; children: React.ReactNode; className?: string; action?: React.ReactNode
}) {
    return (
        <section className={cn('rounded-[10px] border border-app-border bg-app-surface p-4 flex flex-col gap-3', className)}>
            <div className="flex items-center justify-between gap-2 min-h-6">
                <h2 className="text-[16px] font-bold leading-tight text-app-text">{title}</h2>
                {action}
            </div>
            {children}
        </section>
    )
}

/** The swarm switch (staff only), inside the setup strip. */
function SwarmSwitch({ mounted }: { mounted: boolean }) {
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const setSwarmEnabled = useSwarmStore(s => s.setEnabled)
    return (
        <div className="flex items-center gap-3">
            <span id="fly-swarm-label" className="text-[14px] font-semibold text-app-text">Swarm mode</span>
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
                    mounted && swarmEnabled ? 'translate-x-[21px] bg-[hsl(var(--app-raised))]' : 'translate-x-[2px] bg-app-text-muted'
                )} />
            </button>
        </div>
    )
}

/**
 * One-time setup (camera, telemetry link, swarm) as a strip under the video.
 * Open until the drone is linked, then it folds to one line; the pilot can
 * open it again at any time.
 */
function SetupStrip({ mounted, swarm, isCustomer }: { mounted: boolean; swarm: boolean; isCustomer: boolean }) {
    const linked = useDroneStore(s => s.telemetryStatus) === 'connected'
    const { isStreaming } = useWebRTCContext()
    // null = follow the link (open while unlinked); a press pins it.
    const [pinned, setPinned] = useState<boolean | null>(null)
    const open = pinned ?? !linked
    return (
        <section className="rounded-[10px] border border-app-border bg-app-surface">
            <button type="button" onClick={() => setPinned(!open)} aria-expanded={open}
                className={cn('w-full flex items-center gap-3 min-h-12 px-4 py-2 text-left rounded-[10px] transition-colors duration-[140ms] hover:bg-app-surface-2', FOCUS)}>
                <Plug size={16} className="shrink-0 text-app-text-muted" />
                <span className="text-[14px] font-bold text-app-text">Link and devices</span>
                <span className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span className={cn('inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[12px] font-semibold',
                        linked ? 'bg-app-ok-soft text-app-ok' : 'bg-app-surface-2 text-app-text-muted')}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', linked ? 'bg-app-ok' : 'bg-app-text-subtle')} />
                        {linked ? 'Drone linked' : 'No drone'}
                    </span>
                    <span className={cn('inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[12px] font-semibold',
                        isStreaming ? 'bg-app-ok-soft text-app-ok' : 'bg-app-surface-2 text-app-text-muted')}>
                        <Video size={12} />
                        {isStreaming ? 'Video on' : 'Video off'}
                    </span>
                </span>
                <span className="ml-auto flex items-center gap-1 text-[13px] font-semibold text-app-text-muted shrink-0">
                    <span className="hidden sm:inline">{open ? 'Hide' : 'Change'}</span>
                    <ChevronDown size={16} className={cn('transition-transform duration-[180ms]', open && 'rotate-180')} />
                </span>
            </button>
            {open && (
                <div className="px-4 pb-4 pt-1 flex flex-col gap-4 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                    {mounted && swarm ? <FleetDeviceSummary /> : <DeviceSelector layout="strip" />}
                    {!isCustomer && (
                        <div className="pt-3 border-t border-app-border"><SwarmSwitch mounted={mounted} /></div>
                    )}
                </div>
            )}
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
    // Swarm and the fleet are staff-only (docs/ACCESS_MODEL.md section 8a).
    const { isCustomer } = useAccess()
    const swarm = mounted && swarmEnabled

    // Whenever the user lands on the Fly tab, reset the backend to raw-feed mode
    // so the OSD never shows a stale annotated frame from a previous AI session.
    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
    }, [])

    // Layout (design audit 2, 5.1): the status bar above carries the link,
    // the state and Hold / RTL / Land / Kill. Here: the live view with the
    // one-time setup strip under it, and on the right the flight card -
    // readouts at eye level, then mode, arm and take off.
    // Below 768px it stacks: video, flight card, setup strip, the rest.
    return (
        <div className={cn(
            'h-full flex flex-col gap-3 overflow-y-auto',
            'md:grid md:overflow-hidden md:grid-rows-[minmax(0,1fr)_auto]',
            panelCollapsed ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]',
        )}>

            {/* Live view: video, or the fleet map in swarm mode */}
            <div className="order-1 md:col-start-1 md:row-start-1 relative shrink-0 aspect-video min-h-[200px] md:aspect-auto md:min-h-0 min-w-0 flex">
                {swarm && mainView === 'map'
                    ? <FleetMap />
                    : wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream />}
                {mounted && !wallOn && getVideoSource() === 'air_unit_udp' && !(swarm && mainView === 'map') && (
                    <button onClick={() => setWallOn(true)}
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'absolute right-3 bottom-14 z-20')}
                        title="Show every mesh unit that is delivering video">
                        Wall
                    </button>
                )}

                {/* Top-right of the picture: the drone's messages on a phone
                    (the status bar carries them on a wider window), and the
                    way back to a hidden flight panel. */}
                <div className="absolute top-2 right-2 z-[1100] flex items-center gap-1.5">
                    <div className="md:hidden"><FcMessageLog variant="floating" /></div>
                    {panelCollapsed && (
                        <button onClick={() => setPanelCollapsed(false)}
                            className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'hidden md:inline-flex h-8')}
                            title="Show the flight panel" aria-label="Show the flight panel" aria-expanded={false}>
                            <PanelRightOpen size={15} /> Flight panel
                        </button>
                    )}
                </div>

                {/* Video / map switch - swarm mode only */}
                {swarm && (
                    <div className="absolute top-2 left-2 z-[1100] flex gap-0.5 p-0.5 rounded-md border border-overlay-border bg-overlay-scrim backdrop-blur-[6px]">
                        {([['video', Video, 'Video'], ['map', MapIcon, 'Map']] as const).map(([key, Icon, label]) => (
                            <button
                                key={key}
                                onClick={() => setMainView(key)}
                                aria-pressed={mainView === key}
                                className={cn('flex items-center gap-1.5 h-8 px-3 rounded text-[13px] font-bold transition-colors duration-[var(--dur-fast)]', FOCUS_OVERLAY,
                                    mainView === key ? 'bg-[color-mix(in_srgb,var(--overlay-accent)_20%,transparent)] text-[var(--overlay-accent)]' : 'text-overlay-muted hover:text-overlay-text')}
                            >
                                <Icon size={14} />
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* One-time setup, folded once the drone is linked */}
            <div className="order-3 md:order-none md:col-start-1 md:row-start-2 shrink-0">
                <SetupStrip mounted={mounted} swarm={swarm} isCustomer={isCustomer} />
            </div>

            {/* Flight panel */}
            {!panelCollapsed && (
                <div className="order-2 md:order-none md:col-start-2 md:row-start-1 md:row-span-2 flex flex-col gap-3 shrink-0 md:shrink md:min-h-0 md:overflow-y-auto md:pr-0.5 animate-in fade-in-0 duration-200">
                    <Panel title="Flight" action={
                        <button onClick={() => setPanelCollapsed(true)}
                            className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]', FOCUS)}
                            title="Hide the flight panel" aria-label="Hide the flight panel" aria-expanded>
                            <PanelRightClose size={16} />
                        </button>
                    }>
                        <OSDBar />
                        <div className="border-t border-app-border pt-3">
                            <ViewOnlyFence><DroneControls /></ViewOnlyFence>
                        </div>
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

                    <Panel title="All telemetry" className="md:min-h-[240px]">
                        <TelemetryPanel />
                    </Panel>
                </div>
            )}
        </div>
    )
}

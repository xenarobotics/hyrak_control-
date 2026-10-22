'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useSwarmStore } from '@/store/swarm'
import { FleetAside } from '@/components/swarm/FleetAside'
import { getSocket } from '@/lib/socket'
import { OSDBar } from '@/components/osd/OSDBar'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { FOCUS_LINK_EVENT } from '@/components/layout/StatusBar'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { getVideoSource } from '@/lib/videoSource'
import { ChevronDown, PanelRightClose, PanelRightOpen, Video, Map as MapIcon, Plug } from 'lucide-react'
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

/** A row that opens a section inside the flight card: a divider, the title
 *  on the left, a chevron on the right. Replaces the near-empty cards. */
function Disclosure({ title, open, onToggle, hint, children }: {
    title: string; open: boolean; onToggle: () => void; hint?: string; children: React.ReactNode
}) {
    return (
        <div className="border-t border-app-border -mx-4 px-4">
            <button type="button" onClick={onToggle} aria-expanded={open}
                className={cn('w-full flex items-center gap-2 min-h-11 -mx-2 px-2 rounded-md text-left transition-colors duration-[140ms] hover:bg-app-surface-2', FOCUS)}
                style={{ width: 'calc(100% + 16px)' }}>
                <span className="text-[14px] font-bold text-app-text">{title}</span>
                {hint && <span className="text-[13px] text-app-text-muted truncate">{hint}</span>}
                <ChevronDown size={16} className={cn('ml-auto shrink-0 text-app-text-muted transition-transform duration-[180ms]', open && 'rotate-180')} />
            </button>
            {open && <div className="pb-3 pt-1 animate-in fade-in-0 slide-in-from-top-1 duration-200">{children}</div>}
        </div>
    )
}

/** The swarm switch (staff only), in the Link card's header. */
function SwarmSwitch({ mounted }: { mounted: boolean }) {
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const setSwarmEnabled = useSwarmStore(s => s.setEnabled)
    const on = mounted && swarmEnabled
    return (
        <div className="flex items-center gap-2">
            <span id="fly-swarm-label" className="text-[13px] font-semibold text-app-text-muted">Swarm</span>
            <button
                onClick={() => setSwarmEnabled(!swarmEnabled)}
                role="switch"
                aria-checked={on}
                aria-labelledby="fly-swarm-label"
                className={cn(
                    'relative w-11 h-6 rounded-full transition-colors duration-[var(--dur)] shrink-0 border',
                    'after:absolute after:-inset-1.5 after:content-[""]',
                    FOCUS,
                    on ? 'bg-app-accent border-app-accent' : 'bg-app-surface-2 border-app-border-strong'
                )}
                title={on ? 'Turn swarm mode off' : 'Turn swarm mode on: the fleet list takes the place of the device pickers'}
            >
                <span className={cn(
                    'absolute left-0 top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full',
                    'shadow-md transition-transform duration-[var(--dur)]',
                    on ? 'translate-x-[21px] bg-[hsl(var(--app-raised))]' : 'translate-x-[2px] bg-app-text-muted'
                )} />
            </button>
        </div>
    )
}

/** A small state pill in the Link card. */
function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
    return (
        <span className={cn('inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[12px] font-semibold whitespace-nowrap',
            ok ? 'bg-app-ok-soft text-app-ok' : 'bg-app-surface-2 text-app-text-muted')}>
            {children}
        </span>
    )
}

/**
 * Link and devices, at the top of the side column: camera, telemetry link
 * and (staff) the swarm switch. Open until the drone is linked, then it
 * folds to one line of state; "Change" opens it again. In swarm mode the
 * fleet list takes the place of the pickers, in this same card.
 */
function LinkCard({ mounted, swarm, isCustomer, open, onToggle, onHidePanel, cardRef }: {
    mounted: boolean; swarm: boolean; isCustomer: boolean; open: boolean
    onToggle: () => void; onHidePanel: () => void; cardRef: React.RefObject<HTMLElement | null>
}) {
    const linked = useDroneStore(s => s.telemetryStatus) === 'connected'
    const { isStreaming } = useWebRTCContext()
    const drones = useSwarmStore(s => s.drones)
    const fleet = Object.values(drones)
    const fleetUp = fleet.filter(d => d.connected).length
    return (
        <section ref={cardRef} className="rounded-[10px] border border-app-border bg-app-surface p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 min-h-6">
                <Plug size={16} className="shrink-0 text-app-text-muted" />
                <h2 className="text-[16px] font-bold leading-tight text-app-text">Link</h2>
                <div className="ml-auto flex items-center gap-2">
                    {mounted && !isCustomer && <SwarmSwitch mounted={mounted} />}
                    <button onClick={onHidePanel}
                        className={cn('hidden md:flex h-8 w-8 items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]', FOCUS)}
                        title="Hide the side panel" aria-label="Hide the side panel" aria-expanded>
                        <PanelRightClose size={16} />
                    </button>
                </div>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
                {swarm
                    ? <Pill ok={fleetUp > 0}><span className={cn('w-1.5 h-1.5 rounded-full', fleetUp > 0 ? 'bg-app-ok' : 'bg-app-text-subtle')} />{fleetUp}/{fleet.length} drones</Pill>
                    : <Pill ok={linked}><span className={cn('w-1.5 h-1.5 rounded-full', linked ? 'bg-app-ok' : 'bg-app-text-subtle')} />{linked ? 'Drone linked' : 'No drone'}</Pill>}
                <Pill ok={isStreaming}><Video size={12} />{isStreaming ? 'Video on' : 'Video off'}</Pill>
                <button type="button" onClick={onToggle} aria-expanded={open}
                    className={cn('ml-auto flex items-center gap-1 h-8 px-2 -mr-2 rounded-md text-[13px] font-semibold text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]', FOCUS)}>
                    {open ? 'Hide' : 'Change'}
                    <ChevronDown size={16} className={cn('transition-transform duration-[180ms]', open && 'rotate-180')} />
                </button>
            </div>
            {open && (
                <div className="animate-in fade-in-0 slide-in-from-top-1 duration-200">
                    {swarm ? <FleetAside embedded /> : <DeviceSelector />}
                </div>
            )}
        </section>
    )
}

export default function FlyPage() {
    const [panelCollapsed, setPanelCollapsed] = useState(false)
    const linked = useDroneStore(s => s.telemetryStatus) === 'connected'
    // Avoidance follows the link (open once a drone is linked) until pressed.
    const [avoidPinned, setAvoidPinned] = useState<boolean | null>(null)
    const avoidOpen = avoidPinned ?? linked
    const [telemetryOpen, setTelemetryOpen] = useState(false)
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
    const swarm = mounted && swarmEnabled && !isCustomer
    // Link card: null = follow the link (open while unlinked, and in swarm
    // mode); a press pins it.
    const [linkPinned, setLinkPinned] = useState<boolean | null>(null)
    const linkOpen = linkPinned ?? (!linked || swarm)
    const linkRef = useRef<HTMLElement>(null)
    // The status bar's "Connect" (no drone): show the panel, open the Link
    // card and focus its first picker.
    useEffect(() => {
        const show = () => {
            setPanelCollapsed(false)
            setLinkPinned(true)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                linkRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                linkRef.current?.querySelector<HTMLElement>('[data-slot="select-trigger"]:not([disabled]), button[aria-expanded]')?.focus()
            }))
        }
        window.addEventListener(FOCUS_LINK_EVENT, show)
        return () => window.removeEventListener(FOCUS_LINK_EVENT, show)
    }, [])

    // Whenever the user lands on the Fly tab, reset the backend to raw-feed mode
    // so the OSD never shows a stale annotated frame from a previous AI session.
    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
    }, [])

    // Layout: the status bar above carries the link state and Hold / RTL /
    // Land / Kill. The live view takes the whole left side; the side column
    // holds Link (camera, telemetry, swarm) at the top, then the flight card:
    // readouts at eye level, then mode, arm and take off. Swarm mode changes
    // that column in place (the fleet list replaces the pickers).
    // Below 768px it stacks: video, Link, flight card.
    return (
        <div className={cn(
            'h-full flex flex-col gap-3 overflow-y-auto',
            'md:grid md:overflow-hidden md:grid-rows-[minmax(0,1fr)]',
            panelCollapsed ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]',
        )}>

            {/* Live view: video, or the fleet map in swarm mode */}
            <div className="md:col-start-1 md:row-start-1 relative shrink-0 aspect-video min-h-[200px] md:aspect-auto md:min-h-0 min-w-0 flex">
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
                    way back to a hidden side panel. */}
                <div className="absolute top-2 right-2 z-[1100] flex items-center gap-1.5">
                    <div className="md:hidden"><FcMessageLog variant="floating" /></div>
                    {panelCollapsed && (
                        <button onClick={() => setPanelCollapsed(false)}
                            className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'hidden md:inline-flex h-8')}
                            title="Show the side panel" aria-label="Show the side panel" aria-expanded={false}>
                            <PanelRightOpen size={15} /> Side panel
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
                                    mainView === key ? 'bg-[color-mix(in_srgb,var(--overlay-accent)_18%,transparent)] text-overlay-selected-ink' : 'text-overlay-muted hover:text-overlay-text')}
                            >
                                <Icon size={14} />
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Flight panel */}
            {!panelCollapsed && (
                <div className="md:col-start-2 md:row-start-1 flex flex-col gap-3 shrink-0 md:shrink md:min-h-0 md:overflow-y-auto md:pr-0.5 animate-in fade-in-0 duration-200">
                    <LinkCard mounted={mounted} swarm={swarm} isCustomer={isCustomer}
                        open={linkOpen} onToggle={() => setLinkPinned(!linkOpen)}
                        onHidePanel={() => setPanelCollapsed(true)} cardRef={linkRef} />

                    {/* One flight card: readouts, controls, then avoidance and
                        the full telemetry as rows that open in place. */}
                    <Panel title="Flight">
                        <OSDBar />
                        <div className="border-t border-app-border pt-3">
                            <ViewOnlyFence><DroneControls /></ViewOnlyFence>
                        </div>
                        {!swarmEnabled && (
                            <Disclosure title="Avoidance" open={avoidOpen} onToggle={() => setAvoidPinned(!avoidOpen)}>
                                <ViewOnlyFence note={false}><AvoidancePanel /></ViewOnlyFence>
                            </Disclosure>
                        )}
                        <Disclosure title="All telemetry" open={telemetryOpen} onToggle={() => setTelemetryOpen(o => !o)}>
                            <div className="min-h-[200px] flex flex-col"><TelemetryPanel /></div>
                        </Disclosure>
                    </Panel>

                    {/* Hidden when the drone has no attachments, and for viewers. */}
                    {!swarmEnabled && (
                        <AttachmentStrip frame={strip => <Panel title="Attachments">{strip}</Panel>} />
                    )}
                </div>
            )}
        </div>
    )
}

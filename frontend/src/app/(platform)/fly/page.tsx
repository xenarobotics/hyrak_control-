'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { getSocket } from '@/lib/socket'
import { OSDBar } from '@/components/osd/OSDBar'
import { EmergencyStop } from '@/components/controls/EmergencyStop'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { VideoStream } from '@/components/video/VideoStream'
import { Separator } from '@/components/ui/separator'
import { ChevronRight, ChevronLeft, Radio, Video, Map as MapIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Leaflet touches `window` — no SSR
const FleetMap = dynamic(() => import('@/components/swarm/FleetMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center rounded-xl border"
            style={{ borderColor: 'hsl(var(--app-border))' }}>
            <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>Loading map…</p>
        </div>
    ),
})

function SurfaceCard({ title, children, className }: {
    title: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            className={cn('rounded-xl border p-4 flex flex-col gap-3', className)}
            style={{
                background: 'hsl(var(--app-surface))',
                borderColor: 'hsl(var(--app-border))',
            }}
        >
            <p className="text-[10px] font-mono tracking-widest"
                style={{ color: 'hsl(var(--app-text-muted))' }}
            >
                {title}
            </p>
            {children}
        </div>
    )
}

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
            <div
                className="text-[10px] font-mono text-center py-2 leading-relaxed"
                style={{ color: 'hsl(var(--app-text-muted))' }}
            >
                {scanStatus === 'scanning' ? 'Scanning for drones…' : 'No drones found. Use Fleet panel →'}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-1.5">
            <div
                className="text-[9px] font-mono mb-0.5"
                style={{ color: 'hsl(var(--app-text-muted))' }}
            >
                {connected.length}/{droneList.length} connected — tap to control
            </div>
            {droneList.map(drone => {
                const isActive = drone.id === activeDroneId
                return (
                    <button
                        key={drone.id}
                        onClick={() => setActiveDrone(isActive ? null : drone.id)}
                        className="flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-left transition-all"
                        style={{
                            background: isActive ? drone.color + '18' : 'hsl(var(--app-bg))',
                            border: `1px solid ${isActive ? drone.color + '60' : 'hsl(var(--app-border))'}`,
                        }}
                    >
                        <div
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: drone.connected ? drone.color : '#52525b' }}
                        />
                        <span
                            className="flex-1 text-xs font-mono truncate"
                            style={{ color: isActive ? drone.color : 'hsl(var(--app-text))' }}
                        >
                            {drone.name}
                        </span>
                        {isActive && (
                            <span
                                className="text-[8px] font-mono font-bold px-1 rounded"
                                style={{ background: drone.color + '30', color: drone.color }}
                            >
                                CTRL
                            </span>
                        )}
                        <Radio size={10} style={{ color: drone.connected ? drone.color : '#52525b', flexShrink: 0 }} />
                    </button>
                )
            })}
        </div>
    )
}

export default function FlyPage() {
    const [panelCollapsed, setPanelCollapsed] = useState(false)
    // Deferred mount flag prevents sessionStorage-driven Zustand values from
    // reaching the JSX on the initial (hydration) render. Without this, the
    // server renders with enabled=false while the client immediately reads
    // enabled=true from sessionStorage, causing a React hydration mismatch.
    const [mounted, setMounted] = useState(false)
    const [mainView, setMainView] = useState<'video' | 'map'>('video')
    const swarmEnabled    = useSwarmStore(s => s.enabled)
    const setSwarmEnabled = useSwarmStore(s => s.setEnabled)

    // Whenever the user lands on the Fly tab, reset the backend to raw-feed mode
    // so the OSD never shows a stale annotated frame from a previous AI session.
    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
        setMounted(true)
    }, [])

    return (
        <div className="flex flex-col h-full gap-3">

            {/* OSD bar */}
            <div className="rounded-xl border shrink-0 overflow-hidden"
                style={{
                    background: 'hsl(var(--app-surface))',
                    borderColor: 'hsl(var(--app-border))',
                }}
            >
                <OSDBar />
            </div>

            {/* Main */}
            <div className="flex flex-1 gap-3 min-h-0">

                {/* Main area: video, or the live fleet map in swarm mode */}
                <div className="relative flex-1 min-w-0 flex">
                    {mounted && swarmEnabled && mainView === 'map'
                        ? <FleetMap />
                        : <VideoStream />}

                    {/* VIDEO / MAP toggle — swarm mode only */}
                    {mounted && swarmEnabled && (
                        <div
                            className="absolute top-2 left-2 z-[1100] flex rounded-lg overflow-hidden border"
                            style={{ borderColor: 'hsl(var(--app-border))', background: 'rgba(0,0,0,.55)' }}
                        >
                            {([['video', Video, 'VIDEO'], ['map', MapIcon, 'MAP']] as const).map(([key, Icon, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setMainView(key)}
                                    className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-bold transition-colors"
                                    style={{
                                        background: mainView === key ? 'rgba(34,211,238,.25)' : 'transparent',
                                        color: mainView === key ? '#22d3ee' : '#a1a1aa',
                                    }}
                                >
                                    <Icon size={11} />
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                {/* Collapse toggle */}
                <button
                    onClick={() => setPanelCollapsed(p => !p)}
                    className="self-center shrink-0 rounded-lg p-1 border transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                    title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
                >
                    {panelCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                </button>

                {/* Right panel */}
                <div className={cn(
                    'flex flex-col gap-3 shrink-0 transition-all duration-300 overflow-hidden',
                    panelCollapsed ? 'w-0 opacity-0' : 'w-64 lg:w-72 xl:w-80 opacity-100'
                )}>
                    <div className="flex flex-col gap-3 h-full overflow-y-auto pr-0.5">

                        <SurfaceCard title="DEVICES">
                            {mounted && swarmEnabled ? (
                                // In swarm mode: show fleet summary instead of single-drone selector
                                <FleetDeviceSummary />
                            ) : (
                                <DeviceSelector />
                            )}
                            <div
                                className="flex items-center justify-between pt-2 mt-1 border-t"
                                style={{ borderColor: 'hsl(var(--app-border))' }}
                            >
                                <span className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                    Swarm Mode
                                </span>
                                <button
                                    onClick={() => setSwarmEnabled(!swarmEnabled)}
                                    role="switch"
                                    aria-checked={mounted && swarmEnabled}
                                    className={cn(
                                        'relative w-10 h-[22px] rounded-full transition-colors duration-200 shrink-0',
                                        'border focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60',
                                        mounted && swarmEnabled
                                            ? 'bg-cyan-500 border-cyan-400'
                                            : 'bg-zinc-300 dark:bg-zinc-700 border-zinc-400/40 dark:border-zinc-600'
                                    )}
                                    title={mounted && swarmEnabled ? 'Disable swarm mode' : 'Enable swarm mode'}
                                >
                                    <span className={cn(
                                        'absolute left-0 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white',
                                        'shadow-md transition-transform duration-200',
                                        mounted && swarmEnabled ? 'translate-x-[21px]' : 'translate-x-[3px]'
                                    )} />
                                </button>
                            </div>
                        </SurfaceCard>

                        <SurfaceCard title="FLIGHT CONTROLS">
                            <DroneControls />
                        </SurfaceCard>

                        <div className="rounded-xl border flex flex-col flex-1 min-h-0"
                            style={{
                                background: 'hsl(var(--app-surface))',
                                borderColor: 'hsl(var(--app-border))',
                            }}
                        >
                            <p className="text-[10px] font-mono tracking-widest px-4 pt-3 pb-2 shrink-0"
                                style={{ color: 'hsl(var(--app-text-muted))' }}
                            >
                                TELEMETRY DATA
                            </p>
                            <div className="flex-1 overflow-y-auto px-4 pb-3 min-h-0">
                                <TelemetryPanel />
                            </div>
                        </div>

                        <div className="shrink-0 pb-1">
                            <Separator className="mb-3" style={{ background: 'hsl(var(--app-border))' }} />
                            <EmergencyStop />
                        </div>

                    </div>
                </div>

            </div>
        </div>
    )
}
'use client'

// COMMAND - everything about the flight on one screen.
//
// The Fly tab has the video and the controls but no map; the Mission tab has
// the map but no video. Watching an avoidance run meant switching between
// them at exactly the moment both mattered. This tab puts the live video, the
// live map (mission, drone track, obstacles the aircraft is avoiding), the
// flight controls, the avoidance state with its event timeline, telemetry and
// the drone's own messages side by side. It reuses the same components as
// those tabs, so nothing here can disagree with them.
//
// The map is read-only here: a click while flying never adds or drags a
// waypoint (edit the mission on the Mission tab).

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { getSocket } from '@/lib/socket'
import { useSwarmStore } from '@/store/swarm'
import { getVideoSource } from '@/lib/videoSource'
import { cn } from '@/lib/utils'
import { OSDBar } from '@/components/osd/OSDBar'
import { SurfaceCard } from '@/components/layout/SurfaceCard'
import { VideoStream } from '@/components/video/VideoStream'
import { CameraWall } from '@/components/video/CameraWall'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { DeviceSelector } from '@/components/controls/DeviceSelector'
import { DroneControls } from '@/components/controls/DroneControls'
import { EmergencyStop } from '@/components/controls/EmergencyStop'
import { AvoidancePanel } from '@/components/avoidance/AvoidancePanel'
import { TelemetryPanel } from '@/components/telemetry/TelemetryPanel'
import { Separator } from '@/components/ui/separator'

// Leaflet touches `window` - no SSR
const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center">
            <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>Loading map…</p>
        </div>
    ),
})

function Pane({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn('relative min-w-0 min-h-0 rounded-xl border overflow-hidden flex', className)}
            style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
            {children}
        </div>
    )
}

export default function CommandPage() {
    const [mounted, setMounted] = useState(false)
    const [mapLarge, setMapLarge] = useState(false)     // which pane gets the space
    const [panelCollapsed, setPanelCollapsed] = useState(false)
    const [wallOn, setWallOn] = useState(false)
    const swarmEnabled = useSwarmStore(s => s.enabled)

    // Same as the Fly tab: land on a raw feed, never a stale annotated frame.
    useEffect(() => {
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
        setMounted(true)
    }, [])

    const video = (
        <>
            {wallOn ? <CameraWall onClose={() => setWallOn(false)} /> : <VideoStream />}
            {mounted && !wallOn && getVideoSource() === 'air_unit_udp' && (
                <button onClick={() => setWallOn(true)}
                    className="absolute right-3 top-12 z-20 px-2 py-1 rounded border text-[10px] font-mono tracking-widest"
                    style={{ background: 'rgba(17,19,24,.85)', borderColor: 'rgba(255,255,255,.12)', color: '#a1a1aa' }}
                    title="Show every mesh unit that is delivering video">
                    WALL
                </button>
            )}
            <div className="absolute top-2 right-2 z-[1100]">
                <FcMessageLog variant="floating" />
            </div>
        </>
    )
    const map = mounted ? <MissionMap readOnly follow /> : null

    return (
        <div className="flex flex-col h-full gap-3">
            <div className="rounded-xl border shrink-0 overflow-hidden"
                style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}>
                <OSDBar />
            </div>

            <div className="flex flex-1 gap-3 min-h-0">
                {/* Video and map side by side (stacked on narrow screens); SWAP
                    gives the large pane to the other one. */}
                <div className="relative flex flex-col lg:flex-row flex-1 gap-3 min-w-0 min-h-0">
                    <Pane className="flex-[3]">{mapLarge ? map : video}</Pane>
                    <Pane className="flex-[2]">{mapLarge ? video : map}</Pane>
                    <button onClick={() => setMapLarge(v => !v)}
                        className="absolute left-2 top-2 z-[1200] flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono tracking-widest"
                        style={{ background: 'rgba(17,19,24,.85)', borderColor: 'rgba(255,255,255,.12)', color: '#a1a1aa' }}
                        title="Swap which of video and map gets the large pane">
                        <ArrowLeftRight size={11} /> SWAP
                    </button>
                </div>

                <button onClick={() => setPanelCollapsed(p => !p)}
                    className="self-center shrink-0 rounded-lg p-1 border transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    style={{ borderColor: 'hsl(var(--app-border))' }}
                    title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}>
                    {panelCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                </button>

                <div className={cn(
                    'flex flex-col gap-3 shrink-0 transition-all duration-300 overflow-hidden',
                    panelCollapsed ? 'w-0 opacity-0' : 'w-64 lg:w-72 xl:w-80 opacity-100',
                )}>
                    <div className="flex flex-col gap-3 h-full overflow-y-auto pr-0.5">
                        <SurfaceCard title="DEVICES">
                            {mounted && swarmEnabled
                                ? <p className="text-xs font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                                    Swarm mode - manage the fleet on the Fly tab.</p>
                                : <DeviceSelector />}
                        </SurfaceCard>
                        <SurfaceCard title="FLIGHT CONTROLS">
                            <DroneControls />
                        </SurfaceCard>
                        {!swarmEnabled && (
                            <SurfaceCard title="AVOIDANCE">
                                <AvoidancePanel />
                            </SurfaceCard>
                        )}
                        <SurfaceCard title="TELEMETRY DATA">
                            <TelemetryPanel />
                        </SurfaceCard>
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

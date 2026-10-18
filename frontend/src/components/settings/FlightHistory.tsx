'use client'

// Flight history for the workspace (docs/ACCESS_MODEL.md 8b): every
// armed-to-disarmed cycle recorded with its 1 Hz track. Customers see the
// flights of the workspace their session is in; staff every workspace they
// can view (the server decides which). Open a flight to replay its track
// on the map or save it as CSV.

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Download, Pause, Play } from 'lucide-react'
import { apiDownload, apiFetch } from '@/lib/api'
import { isCustomer } from '@/lib/auth'
import { getServerUrl } from '@/lib/server-url'
import { useDroneStore } from '@/store/drone'

const FlightTrackMap = dynamic(() => import('@/components/admin/FlightTrackMap'), { ssr: false })

export interface FlightRow {
    id: string
    drone_id: string
    drone_name?: string | null
    workspace_id?: string
    started_at: string | null
    duration_s: number
    max_alt_m: number
    distance_m: number
    in_progress: boolean
    crossed_orange: boolean
    crossed_red: boolean
}

interface TrackPoint { t: string; lat: number; lng: number; alt: number; speed: number; battery: number; mode: string }

function fmtWhen(iso: string | null): string {
    if (!iso) return '-'
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function fmtDur(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
    return `${Math.floor(s)}s`
}

const muted = { color: 'hsl(var(--app-text-muted))' }
const border = { borderColor: 'hsl(var(--app-border))' }

function Replay({ flight, track }: { flight: FlightRow; track: TrackPoint[] }) {
    const [i, setI] = useState(0)
    const [playing, setPlaying] = useState(false)
    useEffect(() => {
        if (!playing) return
        const id = setInterval(() => {
            setI(n => {
                if (n >= track.length - 1) { setPlaying(false); return n }
                return n + 1
            })
        }, 200)          // 5x real time at 1 Hz samples
        return () => clearInterval(id)
    }, [playing, track.length])
    const p = track[i]
    return (
        <div className="flex flex-col gap-2 pb-3">
            <div className="h-56 rounded overflow-hidden border" style={border}>
                <FlightTrackMap track={track} cursor={track.length ? i : null} />
            </div>
            {track.length > 1 && (
                <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setPlaying(v => !v)}
                        aria-label={playing ? 'Pause replay' : 'Play replay'}
                        className="p-1.5 rounded border" style={border}>
                        {playing ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <input type="range" min={0} max={track.length - 1} value={i}
                        aria-label="Replay position"
                        onChange={e => { setPlaying(false); setI(Number(e.target.value)) }}
                        className="flex-1" />
                </div>
            )}
            {p && (
                <div className="grid grid-cols-4 gap-2 text-[10px] font-mono" style={muted}>
                    <span>T+{i}s</span>
                    <span>{p.alt.toFixed(1)} m</span>
                    <span>{p.speed.toFixed(1)} m/s</span>
                    <span>{p.battery.toFixed(0)}% {p.mode}</span>
                </div>
            )}
            <button type="button"
                onClick={() => { void apiDownload(`/api/flights/${flight.id}/download`, `flight_${flight.id}.csv`) }}
                className="self-start flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-mono" style={border}>
                <Download size={11} /> Download CSV
            </button>
        </div>
    )
}

export function FlightHistory() {
    const workspaceId = useDroneStore(s => s.session?.workspace_id ?? null)
    const [flights, setFlights] = useState<FlightRow[] | null>(null)
    const [open, setOpen] = useState<{ id: string; track: TrackPoint[] } | null>(null)

    const load = useCallback(async () => {
        const ws = isCustomer() && workspaceId ? `&workspace_id=${encodeURIComponent(workspaceId)}` : ''
        try {
            const r = await apiFetch(`${getServerUrl()}/api/flights?limit=50${ws}`)
            setFlights(r.ok ? ((await r.json()).flights ?? []) : [])
        } catch { setFlights([]) }
    }, [workspaceId])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets state only after its fetch resolves
        void load()
    }, [load])

    const toggle = async (id: string) => {
        if (open?.id === id) { setOpen(null); return }
        try {
            const r = await apiFetch(`${getServerUrl()}/api/flights/${id}`)
            if (r.ok) setOpen({ id, track: (await r.json()).track ?? [] })
        } catch { /* keep the list */ }
    }

    if (flights === null) return <p className="text-[11px] font-mono" style={muted}>Loading flights</p>
    if (flights.length === 0) {
        return (
            <p className="text-[11px] font-mono leading-relaxed" style={muted}>
                No flights recorded yet. Every arm-to-disarm is stored with its full track as
                soon as the drone is identified.
            </p>
        )
    }
    return (
        <div className="flex flex-col divide-y" style={border}>
            {flights.map(f => (
                <div key={f.id} style={border}>
                    <button type="button" onClick={() => void toggle(f.id)}
                        aria-expanded={open?.id === f.id}
                        className="w-full flex items-center gap-3 py-2 text-left text-[11px] font-mono">
                        <span>{fmtWhen(f.started_at)}</span>
                        <span style={muted}>{f.drone_name ?? f.drone_id.slice(0, 8)}</span>
                        <span style={muted}>{f.in_progress ? 'in flight' : fmtDur(f.duration_s)}</span>
                        <span style={muted}>{f.max_alt_m.toFixed(0)} m · {(f.distance_m / 1000).toFixed(2)} km</span>
                        {f.crossed_orange && <span className="text-amber-500" title="Passed through an orange zone">●</span>}
                        {f.crossed_red && <span className="text-red-500" title="Entered a red zone">●</span>}
                        <span className="ml-auto" style={muted}>{open?.id === f.id ? '▾' : '▸'}</span>
                    </button>
                    {open?.id === f.id && <Replay flight={f} track={open.track} />}
                </div>
            ))}
        </div>
    )
}

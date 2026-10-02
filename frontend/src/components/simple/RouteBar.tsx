'use client'

// How far along the planned route the drone is: a line from Home to Finish
// with the drone's place on it, and the stop count in words.

import type { FlightState } from './useFlightState'

export function RouteBar({ s }: { s: FlightState }) {
    if (s.routeStops === 0) return null
    const done = s.routeFinished ? s.routeStops : Math.max(0, s.routeIndex)
    const pct = Math.min(100, (done / Math.max(1, s.routeStops)) * 100)
    const flying = s.mode === 'MISSION' || s.routeIndex >= 0
    return (
        <footer className="rounded-[var(--s-radius)] px-5 py-3 flex items-center gap-5"
            style={{ background: 'var(--s-panel)', border: '1px solid var(--s-line)' }} aria-label="Route progress">
            <span className="text-[16px] font-bold shrink-0">Route</span>
            <div className="flex-1 flex items-center gap-3 min-w-0">
                <span className="text-[14px] shrink-0" style={{ color: 'var(--s-ink-2)' }}>Home</span>
                <div className="relative flex-1 h-3 rounded-full" style={{ background: 'var(--s-blue-soft)' }}
                    role="progressbar" aria-valuemin={0} aria-valuemax={s.routeStops} aria-valuenow={done}>
                    <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: 'var(--s-blue)' }} />
                    <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full border-[3px]"
                        style={{ left: `${pct}%`, background: '#fff', borderColor: 'var(--s-blue)' }} aria-hidden="true" />
                </div>
                <span className="text-[14px] shrink-0" style={{ color: 'var(--s-ink-2)' }}>Finish</span>
            </div>
            <span className="text-[16px] shrink-0">
                {s.routeFinished ? 'All stops done' : flying && s.routeIndex >= 0
                    ? `Stop ${Math.min(s.routeIndex + 1, s.routeStops)} of ${s.routeStops}`
                    : `${s.routeStops} stops planned`}
            </span>
        </footer>
    )
}

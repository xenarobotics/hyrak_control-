'use client'

// Persistent, opt-in status/control bar shown above every platform tab
// (Fly/Mission/AI/Config/Settings) — not just the Fly page's own OSD. Gives
// the operator drone status + Land/Kill without having to switch tabs.
// Toggled from Settings → "Status bar" (frontend/src/lib/statusBarSettings.ts),
// default on.

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useDrone } from '@/hooks/useDrone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import {
    Wifi, WifiOff, Globe, Shield, ShieldOff, Satellite, Battery,
    Navigation, PlaneLanding, PlaneTakeoff, TriangleAlert, MoveVertical, SignalMedium,
} from 'lucide-react'
import { gpsFixLabel, gpsFixColor, batteryTextColor, connectionQuality, connectionQualityColor } from '@/lib/osd'
import { FLIGHT_MODES } from '@/lib/flightModes'

// Altitude is only genuinely unavailable when a tracking loop is ACTIVELY
// driving it — that is, Follow is armed AND the mode is on Auto altitude.
// Issuing a position-mode goto then would fight the PD loop.
//
// This used to be a list of MODE NAMES, which locked the control the moment
// person- or human-tracking was selected, regardless of whether anything was
// being tracked or which altitude mode was set. So merely opening a tracking
// tab took away manual altitude for the rest of the flight, which is not what
// the lock was for.

function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(true)
    useEffect(() => {
        setOnline(navigator.onLine)
        const on = () => setOnline(true)
        const off = () => setOnline(false)
        window.addEventListener('online', on)
        window.addEventListener('offline', off)
        return () => {
            window.removeEventListener('online', on)
            window.removeEventListener('offline', off)
        }
    }, [])
    return online
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
    return (
        <div
            title={title}
            style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '4px 9px', borderRadius: 8,
                background: 'hsl(var(--app-surface-2))',
                border: '1px solid hsl(var(--app-border))',
                fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap',
                color: 'hsl(var(--app-text-muted))',
            }}
        >
            {children}
        </div>
    )
}

function Divider() {
    return <div style={{ width: 1, height: 20, background: 'hsl(var(--app-border))', flexShrink: 0 }} />
}

function BarButton({ onClick, disabled, color, title, children }: {
    onClick: () => void; disabled?: boolean; color: string; title?: string; children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 11px', borderRadius: 7, fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
                background: 'transparent', border: `1px solid ${color}60`, color,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap',
            }}
        >
            {children}
        </button>
    )
}

export function StatusBar() {
    const { telemetry, telemetryStatus, mode, cvResults } = useDroneStore()
    const { sendAction, arm, disarm } = useDrone()
    const { isStreaming, stats } = useWebRTCContext()
    const online = useOnlineStatus()

    const [altInput, setAltInput] = useState('')
    const [killConfirm, setKillConfirm] = useState(false)
    // Brief 'sent' confirmation after an altitude command.
    const [altSent, setAltSent] = useState<number | null>(null)
    const altSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const killTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (killTimer.current) clearTimeout(killTimer.current) }, [])

    const armed = telemetry?.flight_mode.is_armed ?? false
    const inAir = telemetry?.flight_mode.is_in_air ?? false
    const flightMode = telemetry?.flight_mode.mode ?? 'NO LINK'
    const alt = telemetry?.position.relative_altitude_m ?? 0
    const sats = telemetry?.gps.satellites_visible ?? 0
    const fix = telemetry?.gps.fix_type ?? 0
    const bat = telemetry?.battery.remaining_percent ?? 0
    const droneLinked = telemetryStatus === 'connected'
    // Live state, not mode name: locked only while a follow is actually
    // armed AND that mode owns the altitude axis (Auto).
    const altitudeLocked = (cvResults?.tracking ?? false)
        && (cvResults?.altitude_mode ?? 'fixed') === 'auto'
    const canTakeoff = droneLinked && armed && !inAir && !altitudeLocked
    const canSetAlt = droneLinked && inAir && !altitudeLocked

    const handleAltAction = () => {
        const v = parseFloat(altInput)
        if (!Number.isFinite(v)) return
        if (inAir ? !canSetAlt : !canTakeoff) return
        const altitude = Math.min(120, Math.max(1, v))
        sendAction(inAir ? 'set_altitude' : 'takeoff', { altitude })
        // Confirm the command left, so typing a number and getting no visible
        // response is never ambiguous. Pressing Enter previously did nothing
        // at all — the key was never bound — which read as "altitude control
        // is broken" rather than "use the button".
        setAltSent(altitude)
        if (altSentTimer.current) clearTimeout(altSentTimer.current)
        altSentTimer.current = setTimeout(() => setAltSent(null), 2500)
    }

    // Confirm-then-kill, same idea as EmergencyStop.tsx, but auto-cancels
    // after 4s so a stray tap can't leave an armed confirm state sitting
    // there for a non-technical operator to bump into later.
    const handleKillClick = () => {
        if (!killConfirm) {
            setKillConfirm(true)
            killTimer.current = setTimeout(() => setKillConfirm(false), 4000)
            return
        }
        if (killTimer.current) clearTimeout(killTimer.current)
        sendAction('emergency_stop')
        setKillConfirm(false)
    }

    return (
        <div
            style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 14px', height: 44, flexShrink: 0, overflowX: 'auto',
                background: 'hsl(var(--app-surface))',
                borderBottom: '1px solid hsl(var(--app-border))',
            }}
        >
            {/* ── Connectivity ─────────────────────────────────────────── */}
            <Chip title="Browser internet connectivity">
                <Globe size={12} style={{ color: online ? '#4ade80' : '#f87171' }} />
                <span>{online ? 'INTERNET' : 'OFFLINE'}</span>
            </Chip>
            <Chip title="Backend ↔ drone telemetry link">
                {droneLinked
                    ? <Wifi size={12} style={{ color: '#4ade80' }} />
                    : <WifiOff size={12} style={{ color: '#f87171' }} />}
                <span>{droneLinked ? 'DRONE LINK' : 'NO DRONE LINK'}</span>
            </Chip>
            {isStreaming && stats && (() => {
                const q = connectionQuality(stats.roundTripTime, stats.packetLoss)
                const qColor = connectionQualityColor(q)
                return (
                    <Chip title={`Video link — ${q}, ${stats.roundTripTime.toFixed(0)}ms`}>
                        <SignalMedium size={12} style={{ color: qColor }} />
                        <span style={{ color: qColor, textTransform: 'uppercase' }}>{q}</span>
                    </Chip>
                )
            })()}

            <Divider />

            {/* ── Vehicle state ────────────────────────────────────────── */}
            <BarButton
                onClick={armed ? disarm : arm}
                disabled={!droneLinked}
                color={armed ? '#fb923c' : '#4ade80'}
                title={armed ? 'Disarm motors' : 'Arm motors'}
            >
                {armed ? <ShieldOff size={13} /> : <Shield size={13} />}
                {armed ? 'DISARM' : 'ARM'}
            </BarButton>

            <Chip title="Current flight mode">
                <span style={{ color: '#22d3ee' }}>{flightMode}</span>
            </Chip>
            <select
                disabled={!droneLinked}
                value=""
                onChange={e => { const m = e.target.value; if (m) sendAction('set_mode', { mode: m }) }}
                title="Change flight mode"
                style={{
                    fontSize: 11, fontFamily: 'monospace', padding: '4px 6px', borderRadius: 6,
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                    color: 'hsl(var(--app-text-muted))', outline: 'none', maxWidth: 92,
                    cursor: droneLinked ? 'pointer' : 'not-allowed', opacity: droneLinked ? 1 : 0.4,
                }}
            >
                <option value="" disabled>Mode…</option>
                {FLIGHT_MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                ))}
            </select>

            <Chip title={`GPS: ${sats} satellites visible`}>
                <Satellite size={12} style={{ color: gpsFixColor(fix) }} />
                <span style={{ color: gpsFixColor(fix) }}>{gpsFixLabel(fix)}</span>
                <span>{sats}</span>
            </Chip>
            <Chip title="Battery">
                <Battery size={12} style={{ color: batteryTextColor(bat) }} />
                <span style={{ color: batteryTextColor(bat), fontWeight: 700 }}>{bat.toFixed(0)}%</span>
            </Chip>

            <Divider />

            {/* ── Altitude ─────────────────────────────────────────────── */}
            <Chip title="Current altitude (relative to takeoff)">
                <Navigation size={12} style={{ color: '#60a5fa' }} />
                <span style={{ fontWeight: 700 }}>{alt.toFixed(1)}</span>
                <span>m</span>
            </Chip>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                    type="number" min={1} max={120} step={1}
                    placeholder="alt"
                    value={altInput}
                    onChange={e => setAltInput(e.target.value)}
                    // Enter is the obvious way to submit a number typed into a
                    // box, and it was not wired — so the whole control looked
                    // dead to anyone who did not spot the button beside it.
                    onKeyDown={e => { if (e.key === 'Enter') handleAltAction() }}
                    disabled={altitudeLocked}
                    title={altitudeLocked
                        ? 'Altitude is controlled from the AI tracking panel (Fixed/Auto) while a tracking mode is active'
                        : 'Target altitude in meters'}
                    style={{
                        width: 46, fontSize: 11, fontFamily: 'monospace', padding: '4px 6px',
                        borderRadius: 6, background: 'hsl(var(--app-surface-2))',
                        border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text))',
                        outline: 'none', opacity: altitudeLocked ? 0.4 : 1,
                    }}
                />
                {inAir ? (
                    <button
                        onClick={handleAltAction}
                        disabled={!canSetAlt || !altInput}
                        title="Re-position to this altitude while airborne"
                        style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            padding: '4px 9px', borderRadius: 6, fontSize: 10.5, fontFamily: 'monospace', fontWeight: 700,
                            background: 'transparent', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text-muted))',
                            cursor: (!canSetAlt || !altInput) ? 'not-allowed' : 'pointer',
                            opacity: (!canSetAlt || !altInput) ? 0.4 : 1,
                        }}
                    >
                        <MoveVertical size={10} /> {altSent != null ? `→ ${altSent}m` : 'SET ALT'}
                    </button>
                ) : (
                    <button
                        onClick={handleAltAction}
                        disabled={!canTakeoff || !altInput}
                        title={!armed ? 'Arm first' : 'Arm and take off to this altitude'}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            padding: '4px 9px', borderRadius: 6, fontSize: 10.5, fontFamily: 'monospace', fontWeight: 700,
                            background: 'transparent', border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text-muted))',
                            cursor: (!canTakeoff || !altInput) ? 'not-allowed' : 'pointer',
                            opacity: (!canTakeoff || !altInput) ? 0.4 : 1,
                        }}
                    >
                        <PlaneTakeoff size={10} /> TAKEOFF
                    </button>
                )}
            </div>

            {/* ── Controls ─────────────────────────────────────────────── */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <BarButton onClick={() => sendAction('land')} disabled={!droneLinked} color="#38bdf8" title="Descend and land now">
                    <PlaneLanding size={13} /> LAND
                </BarButton>

                {killConfirm ? (
                    <div style={{ display: 'flex', gap: 5 }}>
                        <button
                            onClick={handleKillClick}
                            style={{
                                padding: '5px 11px', borderRadius: 7, fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                                background: '#dc2626', border: '1px solid #f87171', color: 'white', cursor: 'pointer',
                            }}
                        >
                            CONFIRM KILL
                        </button>
                        <button
                            onClick={() => { if (killTimer.current) clearTimeout(killTimer.current); setKillConfirm(false) }}
                            style={{
                                padding: '5px 11px', borderRadius: 7, fontSize: 11, fontFamily: 'monospace',
                                background: 'transparent', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text-muted))', cursor: 'pointer',
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <BarButton onClick={handleKillClick} disabled={!droneLinked} color="#f87171" title="Immediately cuts motors — use only for genuine emergencies">
                        <TriangleAlert size={13} /> KILL
                    </BarButton>
                )}
            </div>
        </div>
    )
}

'use client'

// Persistent, opt-in status/control bar shown above every platform tab
// (Fly/Mission/AI/Config/Settings) - not just the Fly page's own OSD. Gives
// the operator drone status + Land/Kill without having to switch tabs.
// Toggled from Settings → "Status bar" (frontend/src/lib/statusBarSettings.ts),
// default on.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useDroneStore, type ActionResult } from '@/store/drone'
import { useDrone } from '@/hooks/useDrone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import {
    Wifi, WifiOff, Globe, Shield, ShieldOff, Satellite, Battery,
    Navigation, PlaneLanding, PlaneTakeoff, TriangleAlert, MoveVertical, SignalMedium,
    Loader,
} from 'lucide-react'
import { gpsFixLabel, gpsFixColor, batteryTextColor, connectionQuality, connectionQualityColor } from '@/lib/osd'
import { FLIGHT_MODES, modeOptionFor, modeLabel } from '@/lib/flightModes'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { StatusBarLinks } from '@/components/layout/StatusBarLinks'
import { getStatusBarLinksEnabled, STATUSBAR_LINKS_CHANGE_EVENT } from '@/lib/statusBarSettings'
import { useClientValueOn } from '@/hooks/useClientValue'

// Altitude is only genuinely unavailable when a tracking loop is ACTIVELY
// driving it - that is, Follow is armed AND the mode is on Auto altitude.
// Issuing a position-mode goto then would fight the PD loop.
//
// This used to be a list of MODE NAMES, which locked the control the moment
// person- or human-tracking was selected, regardless of whether anything was
// being tracked or which altitude mode was set. So merely opening a tracking
// tab took away manual altitude for the rest of the flight, which is not what
// the lock was for.

function subscribeOnline(onChange: () => void) {
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
    return () => {
        window.removeEventListener('online', onChange)
        window.removeEventListener('offline', onChange)
    }
}
function useOnlineStatus(): boolean {
    return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
    return (
        <div
            title={title}
            style={{
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                height: 32, padding: '0 10px', borderRadius: 6,
                background: 'hsl(var(--app-surface-2))',
                border: '1px solid hsl(var(--app-border))',
                fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                color: 'hsl(var(--app-text-muted))',
            }}
        >
            {children}
        </div>
    )
}

function Divider() {
    return <div aria-hidden style={{ width: 1, height: 20, background: 'hsl(var(--app-border))', flexShrink: 0 }} />
}

// Disabled never fades the label away (design system 8): the word stays
// readable in muted text on surface-2 with a dashed edge, and the tooltip
// says why it cannot be pressed.
function BarButton({ onClick, disabled, disabledReason, color, title, strong, children }: {
    onClick: () => void; disabled?: boolean; disabledReason?: string; color: string; title?: string
    /** The one control that must out-shout the rest (KILL). */
    strong?: boolean
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={disabled && disabledReason ? disabledReason : title}
            style={{
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                height: 32, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                background: disabled ? 'hsl(var(--app-surface-2))' : strong ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
                border: disabled ? '1px dashed hsl(var(--app-border-strong))' : `${strong ? 2 : 1}px solid ${color}`,
                color: disabled ? 'hsl(var(--app-text-muted))' : color,
                cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
            }}
        >
            {children}
        </button>
    )
}

const NO_LINK_REASON = 'No drone link. Connect a drone first.'

export function StatusBar() {
    const telemetry = useDroneStore(s => s.telemetry)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const mode = useDroneStore(s => s.mode)
    const cvResults = useDroneStore(s => s.cvResults)
    const lastActionResult = useDroneStore(s => s.lastActionResult)
    const pendingAction = useDroneStore(s => s.pendingAction)
    const { sendAction, arm, disarm } = useDrone()
    const { isStreaming, stats } = useWebRTCContext()
    const online = useOnlineStatus()

    // Opt-in, and read on mount rather than during render - localStorage does
    // not exist while the server renders this. The event keeps a bar that is
    // already mounted in step with the Settings toggle, which is the same
    // problem the bar's own toggle already solves this way.
    const linksOn = useClientValueOn(STATUSBAR_LINKS_CHANGE_EVENT, getStatusBarLinksEnabled, false)

    const [altInput, setAltInput] = useState('')
    const [killConfirm, setKillConfirm] = useState(false)
    // Brief 'sent' confirmation after an altitude command.
    const [altSent, setAltSent] = useState<number | null>(null)
    // The autopilot's own reason for refusing whatever was last pressed.
    const altSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const killTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (killTimer.current) clearTimeout(killTimer.current) }, [])

    const armed = telemetry?.flight_mode.is_armed ?? false
    const armPending = pendingAction?.action === 'arm' || pendingAction?.action === 'disarm'
    const modePending = pendingAction?.action === 'set_mode'
    const alt = telemetry?.position.relative_altitude_m ?? 0
    // AIRBORNE IS JUDGED FROM THE ALTITUDE TOO, not from the flag alone.
    //
    // is_in_air comes from its own MAVLink stream at 1 Hz over a serial radio,
    // and that one subscription failing (or simply not being served by a given
    // PX4 build) leaves the flag false while the drone is plainly flying. The
    // bar then kept offering TAKEOFF instead of SET ALT - and a takeoff sent to
    // an already-airborne vehicle is rejected, so the box looked dead no matter
    // what was typed into it. The backend's goto_altitude has always used this
    // same two-source test; the UI deciding which button to show did not, so the
    // two disagreed about the state of the aircraft.
    const inAir = (telemetry?.flight_mode.is_in_air ?? false) || alt > 1.0
    const flightMode = telemetry?.flight_mode.mode ?? 'NO LINK'
    const sats = telemetry?.gps.satellites_visible ?? 0
    const fix = telemetry?.gps.fix_type ?? 0
    const bat = telemetry?.battery.remaining_percent ?? 0
    const droneLinked = telemetryStatus === 'connected'
    const commandedAlt = telemetry?.commanded_altitude_m ?? null
    const altWarning = telemetry?.altitude_warning ?? null
    // Only once airborne and settled - during the climb the gap is expected and
    // flagging it would make the indicator meaningless by the time it matters.
    const altMismatch = commandedAlt != null && inAir && altWarning != null
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
        if (altRefusal) setAltDismissed(altRefusal)
        sendAction(inAir ? 'set_altitude' : 'takeoff', { altitude })
        // Confirm the command left, so typing a number and getting no visible
        // response is never ambiguous. Pressing Enter previously did nothing
        // at all - the key was never bound - which read as "altitude control
        // is broken" rather than "use the button".
        setAltSent(altitude)
        if (altSentTimer.current) clearTimeout(altSentTimer.current)
        altSentTimer.current = setTimeout(() => setAltSent(null), 2500)
    }

    // A REFUSED COMMAND MUST LOOK DIFFERENT FROM AN ACCEPTED ONE.
    //
    // Every altitude action already came back over `action_result` with an ok
    // flag, and the bar showed the same cheerful "→ 5m" either way. So a
    // rejection - no position fix, arm timed out, PX4 refusing a reposition -
    // was indistinguishable from success, and the only symptom left was a
    // drone that did not move. That is precisely "I type a number and nothing
    // changes".
    // Derived from the result rather than copied into state: the message is
    // a function of the latest refused altitude result until it is dismissed
    // (by the timer below, or by a newer result replacing it).
    const altRefusal = lastActionResult && !lastActionResult.ok
        && (lastActionResult.action === 'set_altitude' || lastActionResult.action === 'takeoff')
        ? lastActionResult : null
    const [altDismissed, setAltDismissed] = useState<ActionResult | null>(null)
    const altError = altRefusal && altRefusal !== altDismissed
        ? (altRefusal.action === 'takeoff' ? 'takeoff refused' : 'altitude refused')
        : null
    useEffect(() => {
        if (!altRefusal) return
        const t = setTimeout(() => setAltDismissed(altRefusal), 6000)
        return () => clearTimeout(t)
    }, [altRefusal])

    // "COMMANDS ARE NOT REACHING THE DRONE" IS USUALLY THE DRONE SAYING NO.
    //
    // A refused arm and a dead radio produced the identical UI - the button
    // simply did not latch - so the natural conclusion was that the telemetry
    // link had failed, and the next hour went into the radio. Meanwhile the
    // refusal itself had travelled back over that radio, which proves it
    // works. The autopilot names the cause ("Arming denied: ...", "Preflight
    // Fail: Compass not calibrated"); it is now carried on action_result.error
    // and shown here, beside the button that was pressed.
    const refused = lastActionResult && !lastActionResult.ok
        && (lastActionResult.error || lastActionResult.msg) ? lastActionResult : null
    const [refusalDismissed, setRefusalDismissed] = useState<ActionResult | null>(null)
    const refusal = refused && refused !== refusalDismissed
        ? { action: refused.action, reason: (refused.error || refused.msg) as string }
        : null
    useEffect(() => {
        if (!refused) return
        const t = setTimeout(() => setRefusalDismissed(refused), 12000)
        return () => clearTimeout(t)
    }, [refused])

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
            role="region" aria-label="Drone status and quick controls"
            style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 12px', height: 48, flexShrink: 0, minWidth: 0,
                background: 'hsl(var(--app-surface))',
                borderBottom: '1px solid hsl(var(--app-border))',
            }}
        >
            {/* Read-only status and the arm/altitude tools scroll inside
                their own strip on a narrow window; LAND and KILL sit outside
                it, so they are always on screen and the page never scrolls
                sideways (design system 10). */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, overflowX: 'auto', height: '100%' }}>
            {/* ── Connectivity ─────────────────────────────────────────── */}
            <Chip title="Browser internet connectivity">
                <Globe size={14} style={{ color: online ? 'var(--app-ok)' : 'var(--app-danger)' }} />
                <span>{online ? 'INTERNET' : 'OFFLINE'}</span>
            </Chip>
            <Chip title="Backend ↔ drone telemetry link">
                {droneLinked
                    ? <Wifi size={14} style={{ color: 'var(--app-ok)' }} />
                    : <WifiOff size={14} style={{ color: 'var(--app-danger)' }} />}
                <span>{droneLinked ? 'DRONE LINK' : 'NO DRONE LINK'}</span>
            </Chip>
            {isStreaming && stats && (() => {
                const q = connectionQuality(stats.roundTripTime, stats.packetLoss)
                const qColor = connectionQualityColor(q)
                return (
                    <Chip title={`Video link - ${q}, ${stats.roundTripTime.toFixed(0)}ms`}>
                        <SignalMedium size={14} style={{ color: qColor }} />
                        <span style={{ color: qColor, textTransform: 'uppercase' }}>{q}</span>
                    </Chip>
                )
            })()}

            <Divider />

            {/* ── Vehicle state ────────────────────────────────────────── */}
            {/* Pressed → ARMING… → ARMED. The middle state is the whole point:
                the command spends roughly a second on the radio before the
                drone can answer, and with nothing on screen for that second
                the press looks lost. */}
            <BarButton
                onClick={armed ? disarm : arm}
                disabled={!droneLinked || armPending}
                disabledReason={armPending ? 'Waiting for the drone to acknowledge' : NO_LINK_REASON}
                color={armed ? 'var(--app-warn)' : 'var(--app-ok)'}
                title={armPending
                    ? 'Waiting for the drone to acknowledge'
                    : armed ? 'Disarm motors' : 'Arm motors'}
            >
                {armPending
                    ? <Loader size={14} className="animate-spin" />
                    : armed ? <ShieldOff size={14} /> : <Shield size={14} />}
                {armPending ? (armed ? 'DISARMING' : 'ARMING') : armed ? 'DISARM' : 'ARM'}
            </BarButton>

            {refusal && (
                <Chip title={`${refusal.action.replace(/_/g, ' ')} refused by the drone - ${refusal.reason}. The refusal came back over the telemetry link, so the link itself is working.`}>
                    <TriangleAlert size={14} style={{ color: 'var(--app-danger)' }} />
                    <span style={{
                        color: 'var(--app-danger)', maxWidth: 340, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {refusal.reason}
                    </span>
                </Chip>
            )}

            <Chip title="Current flight mode">
                <span style={{ color: droneLinked ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))' }}>{modeLabel(flightMode)}</span>
            </Chip>
            {/* Bound to the LIVE mode, not to "". A select that always shows a
                placeholder cannot show you that the mode you picked was
                refused, or quietly turned into a different one. */}
            <select
                disabled={!droneLinked || modePending}
                value={modeOptionFor(flightMode)}
                onChange={e => { const m = e.target.value; if (m) sendAction('set_mode', { mode: m }) }}
                title={droneLinked ? 'Change flight mode' : NO_LINK_REASON}
                aria-label="Change flight mode"
                style={{
                    flexShrink: 0, height: 32, fontSize: 13, fontWeight: 600, padding: '0 6px', borderRadius: 6,
                    background: 'hsl(var(--app-surface-2))',
                    border: `1px ${droneLinked ? 'solid' : 'dashed'} hsl(var(--app-border-strong))`,
                    color: droneLinked ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))', maxWidth: 104,
                    cursor: droneLinked ? 'pointer' : 'not-allowed',
                }}
            >
                <option value="">{modePending ? 'Switching…' : 'Mode…'}</option>
                {FLIGHT_MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                ))}
            </select>

            <Chip title={`GPS: ${sats} satellites visible`}>
                <Satellite size={14} style={{ color: gpsFixColor(fix) }} />
                <span style={{ color: gpsFixColor(fix) }}>{gpsFixLabel(fix)}</span>
                <span>{sats}</span>
            </Chip>
            <Chip title="Battery">
                <Battery size={14} style={{ color: batteryTextColor(bat) }} />
                <span style={{ color: batteryTextColor(bat), fontWeight: 700 }}>{bat.toFixed(0)}%</span>
            </Chip>

            <Divider />

            {/* ── Altitude ─────────────────────────────────────────────────
                WHAT WAS ASKED FOR SITS NEXT TO WHAT THE DRONE REPORTS.
                Those are two different numbers and only one of them was ever
                on screen. A drone commanded to 2 m and holding 5 m shows "5.0"
                - a perfectly ordinary-looking reading that is only wrong if you
                still remember what you typed, which on a flight line nobody
                does. Side by side, the disagreement is the display. */}
            <Chip title={commandedAlt != null
                ? `Commanded ${commandedAlt.toFixed(1)} m - drone reports ${alt.toFixed(1)} m`
                : 'Current altitude (relative to takeoff)'}>
                <Navigation size={14} style={{ color: altMismatch ? 'var(--app-danger)' : 'var(--app-accent)' }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: altMismatch ? 'var(--app-danger)' : 'hsl(var(--app-text))' }}>
                    {alt.toFixed(1)}
                </span>
                <span>m</span>
                {commandedAlt != null && (
                    <span>
                        / {commandedAlt.toFixed(0)} set
                    </span>
                )}
            </Chip>
            {altWarning && (
                <Chip title={altWarning}>
                    <TriangleAlert size={14} style={{ color: 'var(--app-danger)' }} />
                    <span style={{
                        color: 'var(--app-danger)', maxWidth: 300, overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}>
                        {altWarning}
                    </span>
                </Chip>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <input
                    type="number" min={1} max={120} step={1}
                    placeholder="alt"
                    value={altInput}
                    onChange={e => setAltInput(e.target.value)}
                    // Enter is the obvious way to submit a number typed into a
                    // box, and it was not wired - so the whole control looked
                    // dead to anyone who did not spot the button beside it.
                    onKeyDown={e => { if (e.key === 'Enter') handleAltAction() }}
                    disabled={altitudeLocked}
                    title={altitudeLocked
                        ? 'Altitude is controlled from the AI tracking panel (Fixed/Auto) while a tracking mode is active'
                        : 'Target altitude in meters'}
                    aria-label="Target altitude in meters"
                    style={{
                        width: 56, height: 32, fontSize: 13, fontVariantNumeric: 'tabular-nums', padding: '0 6px',
                        borderRadius: 6, background: 'hsl(var(--app-surface-2))',
                        border: `1px ${altitudeLocked ? 'dashed' : 'solid'} hsl(var(--app-border-strong))`,
                        color: altitudeLocked ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))',
                    }}
                />
                {inAir ? (
                    <button
                        onClick={handleAltAction}
                        disabled={!canSetAlt || !altInput}
                        title={!droneLinked ? NO_LINK_REASON : !altInput ? 'Type an altitude first' : 'Re-position to this altitude while airborne'}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6, height: 32,
                            padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                            background: (!canSetAlt || !altInput) ? 'hsl(var(--app-surface-2))' : 'transparent',
                            border: `1px ${(!canSetAlt || !altInput) ? 'dashed' : 'solid'} ${altError ? 'var(--app-danger)' : 'hsl(var(--app-border-strong))'}`,
                            color: altError ? 'var(--app-danger)' : (!canSetAlt || !altInput) ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))',
                            cursor: (!canSetAlt || !altInput) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        <MoveVertical size={14} />
                        {altError ? altError : altSent != null ? `→ ${altSent}m` : 'SET ALT'}
                    </button>
                ) : (
                    <button
                        onClick={handleAltAction}
                        disabled={!canTakeoff || !altInput}
                        title={!droneLinked ? NO_LINK_REASON : !armed ? 'Arm first' : !altInput ? 'Type an altitude first' : 'Take off to this altitude'}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6, height: 32,
                            padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                            background: (!canTakeoff || !altInput) ? 'hsl(var(--app-surface-2))' : 'transparent',
                            border: `1px ${(!canTakeoff || !altInput) ? 'dashed' : 'solid'} ${altError ? 'var(--app-danger)' : 'hsl(var(--app-border-strong))'}`,
                            color: altError ? 'var(--app-danger)' : (!canTakeoff || !altInput) ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))',
                            cursor: (!canTakeoff || !altInput) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        <PlaneTakeoff size={14} /> {altError ? altError : 'TAKEOFF'}
                    </button>
                )}
            </div>

            {/* ── Link pickers (opt-in) ────────────────────────────────── */}
            {linksOn && (
                <>
                    <Divider />
                    <StatusBarLinks />
                </>
            )}

            </div>

            {/* ── Controls ─────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <FcMessageLog />
                <BarButton onClick={() => sendAction('land')} disabled={!droneLinked} disabledReason={NO_LINK_REASON}
                    color="var(--app-accent)" title="Descend and land now">
                    <PlaneLanding size={16} /> LAND
                </BarButton>

                {killConfirm ? (
                    <div style={{ display: 'flex', gap: 5 }}>
                        <button
                            type="button"
                            onClick={handleKillClick}
                            style={{
                                height: 32, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 800,
                                background: '#b91c1c', border: '2px solid #b91c1c', color: '#ffffff', cursor: 'pointer',
                            }}
                        >
                            CONFIRM KILL
                        </button>
                        <button
                            type="button"
                            onClick={() => { if (killTimer.current) clearTimeout(killTimer.current); setKillConfirm(false) }}
                            style={{
                                height: 32, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                                background: 'transparent', border: '1px solid hsl(var(--app-border-strong))',
                                color: 'hsl(var(--app-text))', cursor: 'pointer',
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <BarButton onClick={handleKillClick} disabled={!droneLinked} disabledReason={NO_LINK_REASON}
                        color="var(--app-danger)" strong title="Cuts the motors at once. Emergencies only. Press twice.">
                        <TriangleAlert size={16} /> KILL
                    </BarButton>
                )}
            </div>
        </div>
    )
}

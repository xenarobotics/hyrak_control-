'use client'

// THE ONE STATUS BAR (docs/DESIGN_SYSTEM.md sections 10 and 11).
//
// Mounted once by the platform layout above every page, Fly and Command
// included, so the drone's state and the four safety actions sit in the same
// place whichever tab is open:
//
//   left    read-only status, icon + word, one colour each. Grey "-" while
//           there is no drone (never a red NO FIX / 0%): red means act now.
//   middle  Mode, and on pages without their own flight controls the arm and
//           altitude tools (`tools`).
//   right   HOLD, RTL, LAND and KILL, fixed to the right edge at every width.
//           KILL is the strongest element and asks to be pressed twice.
//
// Below 768px the status folds into one summary chip that opens a sheet;
// the four actions stay on the bar.
//
// Pages add their own read-only chips through <StatusBarSlot> (Command puts
// the avoidance state there), so the bar never has to poll for them.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useDroneStore, type ActionResult } from '@/store/drone'
import { useDrone } from '@/hooks/useDrone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import {
    Wifi, WifiOff, Shield, ShieldAlert, Satellite, Battery, Timer, CloudOff,
    Navigation, PlaneLanding, PlaneTakeoff, TriangleAlert, MoveVertical, SignalMedium,
    Loader2, CirclePause, Home, OctagonX, ChevronDown, X,
} from 'lucide-react'
import { gpsFixLabel, gpsFixColor, batteryTextColor, connectionQuality, connectionQualityColor, formatDuration } from '@/lib/osd'
import { FLIGHT_MODES, modeOptionFor, modeLabel } from '@/lib/flightModes'
import { FcMessageLog } from '@/components/layout/FcMessageLog'
import { StatusBarLinks } from '@/components/layout/StatusBarLinks'
import { getStatusBarLinksEnabled, STATUSBAR_LINKS_CHANGE_EVENT } from '@/lib/statusBarSettings'
import { useClientValueOn } from '@/hooks/useClientValue'
import { useFlightTimer } from '@/hooks/useFlightTimer'
import { useLiveScope } from '@/hooks/useLiveScope'
import { VIEW_ONLY_TEXT } from '@/components/layout/ViewOnly'
import { cn } from '@/lib/utils'

// ── Page slot ────────────────────────────────────────────────────────────
// A page renders <StatusBarSlot>{chips}</StatusBarSlot>; the bar owns where
// they land (inline on a wide window, inside the sheet on a phone).
let slotEl: HTMLElement | null = null
const slotListeners = new Set<() => void>()
const subscribeSlot = (l: () => void) => { slotListeners.add(l); return () => { slotListeners.delete(l) } }
function setSlotEl(el: HTMLElement | null) {
    if (slotEl === el) return
    slotEl = el
    slotListeners.forEach(l => l())
}
export function StatusBarSlot({ children }: { children: React.ReactNode }) {
    const el = useSyncExternalStore(subscribeSlot, () => slotEl, () => null)
    return el ? createPortal(children, el) : null
}

// ── Pieces ───────────────────────────────────────────────────────────────

export type BarTone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted' | 'text'
const TONE_TEXT: Record<BarTone, string> = {
    ok: 'text-app-ok', warn: 'text-app-warn', danger: 'text-app-danger',
    accent: 'text-app-accent', muted: 'text-app-text-muted', text: 'text-app-text',
}

/** A read-only status item: icon + word in one colour, no box. */
export function BarStat({ icon, children, tone = 'muted', title, strong, label }: {
    icon?: React.ReactNode; children: React.ReactNode; tone?: BarTone; title?: string
    /** A word naming the value, shown only in the phone sheet. */
    label?: string
    /** A fault: tinted pill, so it stands out from the plain readings. */
    strong?: boolean
}) {
    return (
        <span title={title}
            className={cn('inline-flex shrink-0 items-center gap-1.5 h-8 whitespace-nowrap text-[13px] font-semibold tabular-nums',
                strong ? 'px-2.5 rounded-md border' : 'px-1.5',
                strong && tone === 'danger' && 'border-app-danger bg-app-danger-soft',
                strong && tone === 'warn' && 'border-app-warn bg-app-warn-soft',
                strong && tone === 'accent' && 'border-app-accent bg-app-accent-soft',
                TONE_TEXT[tone])}>
            {icon}
            {label && <span data-bar-label className="hidden font-normal text-app-text-muted">{label}</span>}
            {children}
        </span>
    )
}

const Divider = () => <span aria-hidden className="w-px h-5 shrink-0 bg-app-border" />

type ActionTone = 'move' | 'neutral'
function ActionButton({ onClick, disabled, why, title, active, pending, icon, label, ariaLabel, tone = 'move', compact }: {
    onClick: () => void; disabled?: boolean; why?: string | null; title: string
    active?: boolean; pending?: boolean; icon: React.ReactNode; label: string; ariaLabel?: string
    tone?: ActionTone; compact?: boolean
}) {
    return (
        <span title={disabled ? (why ?? undefined) : undefined} className={cn('shrink-0', disabled && 'cursor-not-allowed')}>
            <button type="button" onClick={onClick} disabled={disabled}
                title={disabled ? undefined : title} aria-label={ariaLabel ?? label} aria-pressed={active || undefined}
                className={cn(
                    'inline-flex items-center justify-center gap-1.5 h-9 rounded-md border text-[13px] font-bold whitespace-nowrap',
                    'transition-[color,background-color,border-color,transform] duration-[140ms] ease-[var(--ease-out)] active:scale-[.98]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                    compact ? 'px-2' : 'px-3',
                    disabled
                        ? 'border-dashed border-app-border-strong bg-app-surface-2 text-app-text-muted'
                        : active
                            ? 'border-app-accent bg-app-accent-soft text-app-accent'
                            : tone === 'move'
                                ? 'border-app-warn text-app-warn hover:bg-app-warn-soft'
                                : 'border-app-border-strong text-app-text hover:bg-app-surface-2',
                )}>
                {pending ? <Loader2 size={15} className="animate-spin" /> : <span className={cn(compact && 'hidden sm:inline-flex')}>{icon}</span>}
                {label}
            </button>
        </span>
    )
}

const NO_LINK_REASON = 'Connect a drone first'

function useIsWide() {
    return useSyncExternalStore(
        (cb) => {
            const mq = window.matchMedia('(min-width: 768px)')
            mq.addEventListener('change', cb)
            return () => mq.removeEventListener('change', cb)
        },
        () => window.matchMedia('(min-width: 768px)').matches,
        () => true,
    )
}

function useOnlineStatus(): boolean {
    return useSyncExternalStore(
        (onChange) => {
            window.addEventListener('online', onChange)
            window.addEventListener('offline', onChange)
            return () => {
                window.removeEventListener('online', onChange)
                window.removeEventListener('offline', onChange)
            }
        },
        () => navigator.onLine, () => true,
    )
}

// ── The bar ──────────────────────────────────────────────────────────────

/** `tools`: show Arm and the altitude box. Off on Fly and Command, which
 *  carry those controls in their own layout. */
export function StatusBar({ tools = true }: { tools?: boolean }) {
    const telemetry = useDroneStore(s => s.telemetry)
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const connectionStatus = useDroneStore(s => s.connectionStatus)
    const cvResults = useDroneStore(s => s.cvResults)
    const lastActionResult = useDroneStore(s => s.lastActionResult)
    const pendingAction = useDroneStore(s => s.pendingAction)
    const { sendAction, arm, disarm, emergencyStop } = useDrone()
    const { isStreaming, stats } = useWebRTCContext()
    const online = useOnlineStatus()
    const wide = useIsWide()
    const { elapsed, running } = useFlightTimer()
    // Viewers watch only (docs/ACCESS_MODEL.md section 8a): every command
    // on the bar is disabled for them, the status stays.
    const { viewOnly } = useLiveScope()

    // Opt-in, and read on mount rather than during render - localStorage does
    // not exist while the server renders this. The event keeps a bar that is
    // already mounted in step with the Settings toggle.
    const linksOn = useClientValueOn(STATUSBAR_LINKS_CHANGE_EVENT, getStatusBarLinksEnabled, false)

    const [sheetOpen, setSheetOpen] = useState(false)
    const [altInput, setAltInput] = useState('')
    const [killConfirm, setKillConfirm] = useState(false)
    // Brief 'sent' confirmation after an altitude command.
    const [altSent, setAltSent] = useState<number | null>(null)
    const altSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const killTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const barRef = useRef<HTMLDivElement>(null)
    useEffect(() => () => { if (killTimer.current) clearTimeout(killTimer.current) }, [])

    // The sheet closes on Escape, on a tap outside, and when the window
    // widens past the phone layout.
    useEffect(() => {
        if (!sheetOpen) return
        const down = (e: MouseEvent) => {
            const t = e.target as Node
            if (barRef.current?.contains(t)) return
            // Menus and the message window render to <body>; a tap there is not "outside".
            if ((t as HTMLElement).closest?.('[data-radix-popper-content-wrapper], [role="dialog"]')) return
            setSheetOpen(false)
        }
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false) }
        window.addEventListener('mousedown', down)
        window.addEventListener('keydown', key)
        return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key) }
    }, [sheetOpen])
    const sheetShown = sheetOpen && !wide

    const droneLinked = telemetryStatus === 'connected'
    const has = droneLinked && !!telemetry
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
    // same two-source test.
    const inAir = (telemetry?.flight_mode.is_in_air ?? false) || alt > 1.0
    // Hold and RTL keep the Command rail's guard: the aircraft's own flag.
    const flagInAir = telemetry?.flight_mode.is_in_air ?? false
    const flightMode = telemetry?.flight_mode.mode ?? 'NO LINK'
    const modeUpper = flightMode.toUpperCase()
    const inMission = modeUpper === 'MISSION'
    const sats = telemetry?.gps.satellites_visible ?? 0
    const fix = telemetry?.gps.fix_type ?? 0
    const bat = telemetry?.battery.remaining_percent ?? 0
    const linkLost = !!telemetry && telemetry.link_ok === false
    const commandedAlt = telemetry?.commanded_altitude_m ?? null
    const altWarning = telemetry?.altitude_warning ?? null
    // Only once airborne and settled - during the climb the gap is expected.
    const altMismatch = commandedAlt != null && inAir && altWarning != null
    // Live state, not mode name: locked only while a follow is actually
    // armed AND that mode owns the altitude axis (Auto).
    const altitudeLocked = (cvResults?.tracking ?? false)
        && (cvResults?.altitude_mode ?? 'fixed') === 'auto'
    const canTakeoff = droneLinked && armed && !inAir && !altitudeLocked
    const canSetAlt = droneLinked && inAir && !altitudeLocked
    const pend = (...a: string[]) => a.includes(pendingAction?.action ?? '')

    const handleAltAction = () => {
        const v = parseFloat(altInput)
        if (!Number.isFinite(v)) return
        if (inAir ? !canSetAlt : !canTakeoff) return
        const altitude = Math.min(120, Math.max(1, v))
        if (altRefusal) setAltDismissed(altRefusal)
        sendAction(inAir ? 'set_altitude' : 'takeoff', { altitude })
        // Confirm the command left, so typing a number and getting no visible
        // response is never ambiguous.
        setAltSent(altitude)
        if (altSentTimer.current) clearTimeout(altSentTimer.current)
        altSentTimer.current = setTimeout(() => setAltSent(null), 2500)
    }

    // A REFUSED COMMAND MUST LOOK DIFFERENT FROM AN ACCEPTED ONE. Derived from
    // the latest refused altitude result until it is dismissed (by the timer
    // below, or by a newer result replacing it).
    const altRefusal = lastActionResult && !lastActionResult.ok
        && (lastActionResult.action === 'set_altitude' || lastActionResult.action === 'takeoff')
        ? lastActionResult : null
    const [altDismissed, setAltDismissed] = useState<ActionResult | null>(null)
    const altError = altRefusal && altRefusal !== altDismissed
        ? (altRefusal.action === 'takeoff' ? 'Takeoff refused' : 'Altitude refused')
        : null
    useEffect(() => {
        if (!altRefusal) return
        const t = setTimeout(() => setAltDismissed(altRefusal), 6000)
        return () => clearTimeout(t)
    }, [altRefusal])

    // "COMMANDS ARE NOT REACHING THE DRONE" IS USUALLY THE DRONE SAYING NO.
    // The autopilot names the cause ("Arming denied: ...") on
    // action_result.error; it is shown here, so a refusal never reads as a
    // dead radio (the refusal itself travelled back over that radio).
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

    // Confirm-then-kill: the first press arms a confirm that cancels itself
    // after 4 s, so a stray tap never leaves it waiting to be bumped.
    const handleKillClick = () => {
        if (!killConfirm) {
            setKillConfirm(true)
            killTimer.current = setTimeout(() => setKillConfirm(false), 4000)
            return
        }
        if (killTimer.current) clearTimeout(killTimer.current)
        emergencyStop()
        setKillConfirm(false)
    }
    const cancelKill = () => { if (killTimer.current) clearTimeout(killTimer.current); setKillConfirm(false) }

    // ── Link: the one word that says whether anything else is live ──────
    const cloudDown = connectionStatus !== 'connected'
    const link: { tone: BarTone; word: string; icon: React.ReactNode; title: string } =
        !online ? { tone: 'danger', word: 'Offline', icon: <CloudOff size={15} />, title: 'This device has no internet connection' }
        : cloudDown ? {
            tone: connectionStatus === 'connecting' || connectionStatus === 'reconnecting' ? 'warn' : 'danger',
            word: connectionStatus === 'reconnecting' ? 'Reconnecting' : connectionStatus === 'connecting' ? 'Connecting' : 'Cloud offline',
            icon: <CloudOff size={15} />, title: 'Browser to cloud connection',
        }
        : linkLost ? {
            tone: 'danger', word: `Link lost ${Math.round(telemetry?.link_lost_s ?? 0)}s`,
            icon: <WifiOff size={15} />, title: 'No telemetry from the drone for a few seconds',
        }
        : droneLinked ? { tone: 'ok', word: 'Linked', icon: <Wifi size={15} />, title: 'Cloud to drone telemetry link' }
        : telemetryStatus === 'connecting' ? { tone: 'warn', word: 'Connecting', icon: <Wifi size={15} />, title: 'Connecting to the drone' }
        : { tone: 'muted', word: 'No drone', icon: <WifiOff size={15} />, title: 'No drone connected. Connect one on Fly or Command.' }

    const linkStat = (
        <BarStat tone={link.tone} strong={link.tone === 'danger'} title={link.title}
            icon={<span className={cn('w-2 h-2 rounded-full shrink-0',
                link.tone === 'ok' ? 'bg-app-ok' : link.tone === 'warn' ? 'bg-app-warn' : link.tone === 'danger' ? 'bg-app-danger' : 'bg-app-text-subtle')} />}>
            {link.word}
        </BarStat>
    )

    const dash = <span className="text-app-text-muted">-</span>
    const statusItems = (
        <>
            {linkStat}
            <BarStat tone={has ? (armed ? 'danger' : 'text') : 'muted'} strong={has && armed}
                icon={armed ? <ShieldAlert size={15} /> : <Shield size={15} />} title="Motors" label="Motors">
                {has ? (armed ? 'ARMED' : 'DISARMED') : dash}
            </BarStat>
            <BarStat tone="muted" label="GPS" title={has ? `GPS: ${gpsFixLabel(fix)}, ${sats} satellites` : 'GPS'}
                icon={<Satellite size={15} style={has ? { color: gpsFixColor(fix, 'app') } : undefined} />}>
                {has ? <><span style={{ color: gpsFixColor(fix, 'app') }}>{gpsFixLabel(fix) === 'NO FIX' ? 'No fix' : gpsFixLabel(fix)}</span><span>{sats}</span></> : dash}
            </BarStat>
            <BarStat tone="muted" label="Battery" title={has ? `Battery ${bat.toFixed(0)}%, ${telemetry?.battery.voltage_v.toFixed(1)} V` : 'Battery'}
                icon={<Battery size={15} style={has ? { color: batteryTextColor(bat, 'app') } : undefined} />}>
                {has ? <span className="font-bold" style={{ color: batteryTextColor(bat, 'app') }}>{bat.toFixed(0)}%</span> : dash}
            </BarStat>
            <BarStat tone={has ? (altMismatch ? 'danger' : 'text') : 'muted'} label="Altitude"
                title={commandedAlt != null
                    ? `Asked for ${commandedAlt.toFixed(1)} m, drone reports ${alt.toFixed(1)} m`
                    : 'Altitude above takeoff'}
                icon={<Navigation size={15} />}>
                {has ? <>{alt.toFixed(1)} m{commandedAlt != null && <span className="text-app-text-muted font-normal">of {commandedAlt.toFixed(0)}</span>}</> : dash}
            </BarStat>
            <BarStat tone={running ? 'ok' : 'muted'} icon={<Timer size={15} />} title="Flight time" label="Flight time">
                {formatDuration(elapsed)}
            </BarStat>
            {isStreaming && stats && (() => {
                const q = connectionQuality(stats.roundTripTime, stats.packetLoss)
                return (
                    <BarStat tone="muted" title={`Video link ${q}, ${stats.roundTripTime.toFixed(0)} ms`}
                        icon={<SignalMedium size={15} style={{ color: connectionQualityColor(q, 'app') }} />}>
                        <span className="capitalize" style={{ color: connectionQualityColor(q, 'app') }}>{q}</span>
                    </BarStat>
                )
            })()}
            {altWarning && (
                <BarStat tone="danger" strong icon={<TriangleAlert size={15} />} title={altWarning}>
                    <span className="max-w-[280px] truncate">{altWarning}</span>
                </BarStat>
            )}
            {refusal && (
                <BarStat tone="danger" strong icon={<TriangleAlert size={15} />}
                    title={`The drone refused ${refusal.action.replace(/_/g, ' ')}: ${refusal.reason}. The refusal came back over the telemetry link, so the link itself works.`}>
                    <span className="max-w-[320px] truncate">{refusal.reason}</span>
                </BarStat>
            )}
            <span ref={setSlotEl} className="contents" />
        </>
    )

    // Bound to the LIVE mode, not to "". A select that always shows a
    // placeholder cannot show you that the mode you picked was refused.
    const modeSelect = (
        <label className="inline-flex shrink-0 items-center gap-1.5" title={droneLinked ? 'Change flight mode' : NO_LINK_REASON}>
            <span className="text-[13px] font-semibold text-app-text-muted">Mode</span>
            <span className="relative inline-flex">
                <select
                    disabled={!droneLinked || modePending}
                    value={modeOptionFor(flightMode)}
                    onChange={e => { const m = e.target.value; if (m) sendAction('set_mode', { mode: m }) }}
                    aria-label="Change flight mode"
                    className={cn('appearance-none h-9 pl-2.5 pr-7 rounded-md border text-[13px] font-semibold max-w-[150px]',
                        'transition-colors duration-[140ms] outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                        droneLinked ? 'bg-app-surface-2 border-app-border-strong text-app-accent hover:border-app-accent'
                            : 'bg-app-surface-2 border-dashed border-app-border-strong text-app-text-muted cursor-not-allowed')}
                >
                    <option value="">{modePending ? 'Switching' : droneLinked ? modeLabel(flightMode) : '-'}</option>
                    {FLIGHT_MODES.map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                </select>
                <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-app-text-muted" />
            </span>
        </label>
    )

    const altBtnOff = inAir ? (!canSetAlt || !altInput) : (!canTakeoff || !altInput)
    const flightTools = tools && (
        <fieldset disabled={viewOnly} className="contents">
            <span title={!droneLinked ? NO_LINK_REASON : armPending ? 'Waiting for the drone to answer' : undefined}
                className={cn('shrink-0', (!droneLinked || armPending) && 'cursor-not-allowed')}>
                <button type="button" onClick={armed ? disarm : arm} disabled={!droneLinked || armPending}
                    title={armed ? 'Disarm motors' : 'Arm motors'}
                    className={cn('inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-[13px] font-bold whitespace-nowrap transition-colors duration-[140ms] active:scale-[.98]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                        'disabled:border-dashed disabled:border-app-border-strong disabled:bg-app-surface-2 disabled:text-app-text-muted',
                        armed ? 'border-app-warn text-app-warn hover:bg-app-warn-soft' : 'border-app-ok text-app-ok hover:bg-app-ok-soft')}>
                    {armPending ? <Loader2 size={15} className="animate-spin" /> : <Shield size={15} />}
                    {armPending ? (armed ? 'Disarming' : 'Arming') : armed ? 'Disarm' : 'Arm'}
                </button>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
                <span className={cn('inline-flex items-center h-9 w-[76px] pr-2 rounded-md border bg-app-surface-2',
                    'focus-within:ring-2 focus-within:ring-app-accent focus-within:ring-offset-2 focus-within:ring-offset-app-surface',
                    altitudeLocked ? 'border-dashed border-app-border-strong' : 'border-app-border-strong')}>
                    <input
                        type="number" min={1} max={120} step={1}
                        placeholder="Alt"
                        value={altInput}
                        onChange={e => setAltInput(e.target.value)}
                        // Enter is the obvious way to submit a number typed into a box.
                        onKeyDown={e => { if (e.key === 'Enter') handleAltAction() }}
                        disabled={altitudeLocked}
                        title={altitudeLocked
                            ? 'Altitude is controlled from the AI tracking panel (Fixed/Auto) while a tracking mode is active'
                            : 'Target altitude in metres'}
                        aria-label="Target altitude in metres"
                        className={cn('w-full min-w-0 h-full pl-2.5 bg-transparent border-0 outline-none text-[13px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none placeholder:text-app-text-muted',
                            altitudeLocked ? 'text-app-text-muted' : 'text-app-text')}
                    />
                    <span aria-hidden className="text-[12px] text-app-text-muted">m</span>
                </span>
                <span title={altBtnOff ? (!droneLinked ? NO_LINK_REASON : !inAir && !armed ? 'Arm first' : !altInput ? 'Type an altitude first' : undefined) : undefined}
                    className={cn(altBtnOff && 'cursor-not-allowed')}>
                    <button type="button" onClick={handleAltAction} disabled={altBtnOff}
                        title={inAir ? 'Move to this altitude while flying' : 'Take off to this altitude'}
                        className={cn('inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-[13px] font-bold whitespace-nowrap transition-colors duration-[140ms] active:scale-[.98]',
                            'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                            'disabled:border-dashed disabled:bg-app-surface-2',
                            altError ? 'border-app-danger text-app-danger'
                                : altBtnOff ? 'border-app-border-strong text-app-text-muted'
                                    : 'border-app-border-strong text-app-text hover:bg-app-surface-2')}>
                        {inAir ? <MoveVertical size={15} /> : <PlaneTakeoff size={15} />}
                        {altError ?? (inAir ? (altSent != null ? `Sent ${altSent} m` : 'Set altitude') : 'Take off')}
                    </button>
                </span>
            </span>
        </fieldset>
    )

    // ── The four safety actions ─────────────────────────────────────────
    const actions = (
        <fieldset disabled={viewOnly} title={viewOnly ? VIEW_ONLY_TEXT : undefined}
            className="flex shrink-0 items-center gap-1 sm:gap-2 min-w-0 border-0 p-0 m-0">
            <ActionButton compact={!wide} label="Hold" ariaLabel="Hold position"
                icon={<CirclePause size={15} />}
                disabled={!droneLinked || !flagInAir} why={!droneLinked ? NO_LINK_REASON : 'Only while flying'}
                active={modeUpper === 'HOLD'} pending={pend('hold', 'pause_mission')}
                onClick={() => sendAction(inMission ? 'pause_mission' : 'hold')}
                title={inMission ? 'Pause the mission and hover' : 'Hover in place'} />
            <ActionButton compact={!wide} label="RTL" ariaLabel="Return to launch"
                icon={<Home size={15} />}
                disabled={!droneLinked || !flagInAir} why={!droneLinked ? NO_LINK_REASON : 'Only while flying'}
                active={modeUpper.includes('RETURN') || modeUpper === 'RTL'} pending={pend('return')}
                onClick={() => sendAction('return')} title="Return to launch" />
            <ActionButton compact={!wide} label="Land" ariaLabel="Land now"
                icon={<PlaneLanding size={15} />}
                disabled={!droneLinked} why={NO_LINK_REASON}
                active={modeUpper === 'LAND'} pending={pend('land')}
                onClick={() => sendAction('land')} title="Descend and land here" />

            {killConfirm ? (
                <span role="group" aria-label="Confirm kill" className="inline-flex shrink-0 items-center gap-1 animate-in fade-in-0 zoom-in-95 duration-150">
                    <button type="button" onClick={handleKillClick} autoFocus
                        className="inline-flex items-center gap-1.5 h-10 px-3 rounded-md border-2 border-app-danger bg-app-danger text-[hsl(var(--app-bg))] text-[14px] font-extrabold whitespace-nowrap ring-2 ring-app-danger/40 ring-offset-2 ring-offset-app-surface active:scale-[.98] transition-transform duration-[90ms]"
                        title="Cuts the motors now. A flying drone will fall.">
                        <OctagonX size={16} /> Confirm kill
                    </button>
                    <button type="button" onClick={cancelKill} aria-label="Cancel kill" title="Cancel"
                        className="inline-flex items-center justify-center h-10 w-10 rounded-md border border-app-border-strong text-app-text hover:bg-app-surface-2 transition-colors duration-[140ms]">
                        <X size={16} />
                    </button>
                </span>
            ) : (
                <span title={!droneLinked ? NO_LINK_REASON : undefined} className={cn('shrink-0', !droneLinked && 'cursor-not-allowed')}>
                    <button type="button" onClick={handleKillClick} disabled={!droneLinked}
                        aria-label="Kill motors"
                        title="Kill motors: cuts them at once. Emergencies only. Press twice."
                        className={cn('inline-flex items-center justify-center gap-1.5 h-10 rounded-md border-2 text-[14px] font-extrabold whitespace-nowrap',
                            wide ? 'px-4' : 'px-2.5',
                            'transition-[color,background-color,border-color,transform] duration-[140ms] ease-[var(--ease-out)] active:scale-[.98]',
                            'outline-none focus-visible:ring-2 focus-visible:ring-app-danger focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                            'border-app-danger bg-app-danger text-[hsl(var(--app-bg))] hover:brightness-110',
                            'disabled:bg-app-danger-soft disabled:text-app-danger disabled:border-dashed disabled:hover:brightness-100')}>
                        <OctagonX size={16} />
                        Kill
                    </button>
                </span>
            )}
        </fieldset>
    )

    // Phone summary: the worst thing first.
    const summary: { tone: BarTone; text: string } =
        link.tone === 'danger' ? { tone: 'danger', text: link.word }
            : has && armed ? { tone: 'danger', text: 'ARMED' }
                : link.tone === 'warn' ? { tone: 'warn', text: link.word }
                    : has ? { tone: 'ok', text: modeLabel(flightMode) }
                        : { tone: 'muted', text: 'No drone' }

    return (
        <div ref={barRef} role="region" aria-label="Drone status and quick controls"
            className="relative z-[2000] flex h-12 shrink-0 items-center gap-2 px-2 sm:px-3 min-w-0 border-b border-app-border bg-app-surface">
            {wide ? (
                <div className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] h-full">
                    {statusItems}
                    <span className="flex-1 min-w-2" />
                    {flightTools && <>{flightTools}<Divider /></>}
                    {linksOn && <><StatusBarLinks /><Divider /></>}
                    {modeSelect}
                </div>
            ) : (
                <button type="button" onClick={() => setSheetOpen(o => !o)} aria-expanded={sheetShown}
                    aria-label={`Drone status: ${summary.text}. ${sheetShown ? 'Hide' : 'Show'} details`}
                    className={cn('flex flex-1 min-w-0 items-center gap-1.5 h-9 px-2 rounded-md border text-[13px] font-bold transition-colors duration-[140ms]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app-surface',
                        summary.tone === 'danger' ? 'border-app-danger bg-app-danger-soft' : 'border-app-border bg-app-surface-2',
                        TONE_TEXT[summary.tone])}>
                    <span className={cn('w-2 h-2 rounded-full shrink-0',
                        summary.tone === 'ok' ? 'bg-app-ok' : summary.tone === 'warn' ? 'bg-app-warn' : summary.tone === 'danger' ? 'bg-app-danger' : 'bg-app-text-subtle')} />
                    <span className="truncate">{summary.text}</span>
                    <ChevronDown size={14} className={cn('ml-auto shrink-0 text-app-text-muted transition-transform duration-[180ms]', sheetShown && 'rotate-180')} />
                </button>
            )}

            {wide && <><Divider /><FcMessageLog /></>}
            {actions}

            {sheetShown && (
                <div className="absolute left-0 right-0 top-full border-b border-app-border bg-app-surface shadow-[var(--app-shadow)] px-3 py-3 flex flex-col gap-3 animate-in fade-in-0 slide-in-from-top-2 duration-200 ease-[var(--ease-out)]">
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 [&_[data-bar-label]]:inline">{statusItems}</div>
                    <div className="flex flex-wrap items-center gap-2">
                        {modeSelect}
                        <span className="flex-1" />
                        <FcMessageLog />
                    </div>
                    {flightTools && <div className="flex flex-wrap items-center gap-2">{flightTools}</div>}
                    {linksOn && <div className="flex flex-wrap items-center gap-2"><StatusBarLinks /></div>}
                </div>
            )}
        </div>
    )
}

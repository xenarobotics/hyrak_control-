'use client'

// The follow control, shared by every mode that can chase something.
//
// It exists because four panels had four different answers to the same three
// questions - is a target selected, is the drone actually flying at it, and
// how far / how high should it sit - and the inconsistency was itself the
// reliability problem. An operator should not have to relearn the controls
// when they switch from vehicles to crowds.
//
// The important interaction rule: SELECTING and FLYING are separate. Tapping
// a target on the video selects it. Nothing moves until Follow is armed.
// Arming is what starts PX4 Offboard, so it is a deliberate second action.

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { AlertTriangle, Crosshair, Square, MoveVertical, Info, Mountain, Users, X } from 'lucide-react'
import type { GroupFraming } from '@/types/vision'
import { TONE, LABEL as LABEL_BASE, MUTED, TEXT, BORDER_STRONG, SURFACE, SURFACE_2, NUM, SECONDARY, chip, FOCUS } from './panelStyle'

export type FollowKind = 'vehicle' | 'person'

const DIST_MIN = 0.08
const DIST_MAX = 0.70
const DIST_STEP = 0.06

const LABEL: React.CSSProperties = LABEL_BASE

function Hint({ text }: { text: string }) {
    return (
        <span style={{ display: 'flex' }} title={text}>
            <Info size={13} style={{ color: MUTED, cursor: 'help' }} />
        </span>
    )
}

// Selected state is accent; the Follow / Stop button that starts or stops
// the chase is amber: it moves the drone.
const ACC = TONE.accent
const WARN = TONE.warn
const BAD = TONE.danger

/** A small segmented toggle button (on/off, fixed/auto). */
function seg(active: boolean): React.CSSProperties {
    return {
        minHeight: 28, padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: 600,
        cursor: 'pointer', textTransform: 'capitalize',
        border: `1px solid ${active ? ACC.fg : BORDER_STRONG}`,
        background: active ? ACC.bg : 'transparent',
        color: active ? ACC.fg : MUTED,
        transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
    }
}

export function FollowControls({
    kind, selectedLabel, lockState, lockMessage,
    altitudeMode, targetRatio, actualFillPct, elevate, onRelease, multi,
}: {
    kind: FollowKind
    /** What is selected, already formatted (e.g. "VH-000042  719257C"). */
    selectedLabel: string | null
    /**
     * GROUP FOLLOW - traffic-management only, and absent everywhere else.
     *
     * Passed in rather than read from the store here because it is the one
     * capability this shared control does NOT share: traffic-management is the
     * only module that finds people and vehicles in one detection pass, so it
     * is the only one where a track id identifies exactly one subject across
     * both kinds and a mixed group is even expressible.
     */
    multi?: {
        enabled: boolean
        members: number[]
        max: number
        framing: GroupFraming | null
        /** How to name a member in a chip - the panel knows the plates. */
        labelFor: (id: number) => string
    }
    lockState?: string
    lockMessage?: string
    altitudeMode?: 'fixed' | 'auto'
    targetRatio?: number
    actualFillPct?: number | null
    elevate?: { elevating: boolean; blocked_by: string | null; reason: string } | null
    onRelease: () => void
}) {
    // WHETHER THE DRONE IS FLYING AT THE TARGET comes from the analyzer's own
    // payload, not from a socket ack the panel happened to subscribe to.
    //
    // Each panel used to keep its own flag, fed by whichever status event it
    // remembered: set_vehicle_tracking replies with `vehicle_tracking_status`
    // and set_tracking with `tracking_status`, so a panel listening for one
    // and arming through the other never updated. Traffic hit exactly that -
    // following a PERSON arms via set_tracking, the panel listened only for
    // the vehicle event, and the button stayed on "Follow" while the aircraft
    // was already chasing. Crowd listened for neither.
    //
    // The analyzer reports `tracking` in every payload and cannot disagree
    // with itself, so reading it here fixes all four panels at once and gives
    // this component no way to drift from them again.
    const tracking = useDroneStore(s => s.cvResults?.tracking) ?? false

    // WHY ARMING FAILED, shown where the operator pressed the button.
    //
    // The backend already explains itself - "Failed to start Offboard mode -
    // is the drone armed and airborne?" - but the only listener for `error`
    // surfaced it while telemetry was CONNECTING and otherwise sent it to
    // console.error. So a Follow press against a disarmed or grounded aircraft
    // produced a perfectly good diagnosis that nobody could see, and the
    // button looked dead. That is indistinguishable from the routing bug it
    // sat behind, which is why this cost two debugging rounds.
    const [armError, setArmError] = useState<string | null>(null)
    useEffect(() => {
        const socket = getSocket()
        const onError = (d: { msg?: string }) => {
            if (!d?.msg) return
            setArmError(d.msg)
            // Clears on its own: a stale reason next to a control that has
            // since started working is worse than none.
            window.setTimeout(() => setArmError(null), 8000)
        }
        // WHY THE FOLLOW STOPPED, in the place that was showing it running.
        // A pilot taking the aircraft on their mode switch disarms the tracker
        // from the backend, so this control flips back to "Follow" on its own
        // - correctly, and with no explanation at all. "It just stopped" is
        // the report that costs a debugging round; it stopped because somebody
        // took the aircraft, and that is worth one line.
        const onPilot = (d: { mode?: string }) => {
            setArmError(
                `Follow stopped - the pilot took the aircraft${d?.mode ? ` in ${d.mode}` : ''}. ` +
                `Take control back in the flight controls before following again.`
            )
            window.setTimeout(() => setArmError(null), 12000)
        }
        socket.on('error', onError)
        socket.on('pilot_override', onPilot)
        return () => { socket.off('error', onError); socket.off('pilot_override', onPilot) }
    }, [])

    const [dist, setDist] = useState(targetRatio ?? 0.22)
    // Follow the backend's value when it reports a new one (during render,
    // so the slider never paints the stale value for a frame).
    const [syncedRatio, setSyncedRatio] = useState(targetRatio)
    if (targetRatio !== syncedRatio) {
        setSyncedRatio(targetRatio)
        if (targetRatio != null) setDist(targetRatio)
    }

    // Vehicles and people arm through different events: vehicle follow has its
    // own handler because it must also start Offboard for a mode the shared
    // one does not know about.
    const armEvent = kind === 'vehicle' ? 'set_vehicle_tracking' : 'set_tracking'
    const arm = (active: boolean) => getSocket().emit(armEvent, { active })

    const applyDist = (v: number) => {
        const clamped = Math.max(DIST_MIN, Math.min(DIST_MAX, v))
        const rounded = Math.round(clamped * 100) / 100
        setDist(rounded)
        getSocket().emit('set_tracking_params', { target_distance_ratio: rounded })
    }

    if (selectedLabel === null) {
        return (
            <div style={{ ...SECONDARY, textAlign: 'center', padding: '6px 0' }}>
                Tap a {kind === 'vehicle' ? 'vehicle' : 'person'} on the video to select it
            </div>
        )
    }

    const targetPct = Math.round(dist * 100)
    const wayOff = actualFillPct != null && Math.abs(actualFillPct - targetPct) > 20

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            padding: '10px 12px', borderRadius: 10,
            background: ACC.bg, border: `1px solid ${ACC.border}`,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <Crosshair size={14} style={{ color: ACC.fg }} aria-hidden />
                <span style={{ fontWeight: 700, color: TEXT, ...NUM }}>{selectedLabel}</span>
                {lockState && (
                    <span style={{ ...LABEL, marginLeft: 'auto' }}>
                        {lockState}
                    </span>
                )}
            </div>
            {lockMessage && (
                <div style={{ fontSize: 13, lineHeight: '18px', color: WARN.fg, fontWeight: 600 }}>
                    {lockMessage}
                </div>
            )}
            {armError && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 13, lineHeight: '18px', color: BAD.fg, fontWeight: 600,
                }}>
                    <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span>{armError}</span>
                </div>
            )}

            {/* Selecting frames a target; flying at it is a second, explicit
                decision - arming is what starts PX4 Offboard. Amber: it moves
                the drone. */}
            <div style={{ display: 'flex', gap: 8 }}>
                <button
                    className={FOCUS}
                    onClick={() => arm(!tracking)}
                    title={tracking ? 'Stop flying after the target' : 'Fly after the target (starts Offboard)'}
                    style={{
                        flex: 1, minHeight: 32, borderRadius: 6, fontSize: 13,
                        fontWeight: 700, cursor: 'pointer',
                        border: `1px solid ${tracking ? BAD.fg : WARN.fg}`,
                        background: tracking ? BAD.bg : WARN.bg,
                        color: tracking ? BAD.fg : WARN.fg,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
                    }}
                >
                    {tracking ? <><Square size={13} aria-hidden /> Stop following</>
                              : <><Crosshair size={13} aria-hidden /> Follow</>}
                </button>
                <button
                    className={FOCUS}
                    onClick={onRelease}
                    title="Drop the selection"
                    style={{
                        minHeight: 32, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                        cursor: 'pointer', border: `1px solid ${BORDER_STRONG}`,
                        background: SURFACE, color: TEXT,
                    }}
                >
                    Release
                </button>
            </div>

            {/* ── Multi-follow ─────────────────────────────────────────── */}
            {multi && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Users size={13} style={{ color: MUTED }} aria-hidden />
                        <span style={LABEL}>Group follow</span>
                        <Hint text="Keep several subjects in frame at once. The drone backs off and climbs until they all fit, then holds. While on, tap a subject on the video to add or drop them." />
                        <button
                            className={FOCUS}
                            onClick={() => getSocket().emit('set_multi_follow', { enabled: !multi.enabled })}
                            aria-pressed={multi.enabled}
                            style={{ ...seg(multi.enabled), marginLeft: 'auto' }}
                        >
                            {multi.enabled ? 'On' : 'Off'}
                        </button>
                    </div>

                    {multi.enabled && (
                        <>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                                {multi.members.map((id, i) => (
                                    <span
                                        key={id}
                                        title={i === 0
                                            ? 'Primary: plate, name and hold distance come from this one'
                                            : 'Tap the x to drop from the group'}
                                        style={{
                                            ...chip(i === 0 ? 'accent' : 'muted'),
                                            ...(i === 0 ? {} : { color: TEXT }),
                                            paddingRight: multi.members.length > 1 ? 2 : 8,
                                        }}
                                    >
                                        {multi.labelFor(id)}
                                        {/* Dropping the LAST member would stop the aircraft,
                                            which is a much bigger action than an X on a chip
                                            appears to offer. Release is what does that. */}
                                        {multi.members.length > 1 && (
                                            <button
                                                className={FOCUS}
                                                onClick={() => getSocket().emit('set_follow_vehicle', { track_id: id })}
                                                aria-label="Drop from group"
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    width: 20, height: 20, border: 'none', background: 'none',
                                                    cursor: 'pointer', padding: 0, borderRadius: 999,
                                                    color: MUTED,
                                                }}
                                            ><X size={12} aria-hidden /></button>
                                        )}
                                    </span>
                                ))}
                                <span style={{ ...SECONDARY, ...NUM, marginLeft: 'auto' }}>
                                    {multi.members.length} / {multi.max}
                                </span>
                            </div>
                            <div style={SECONDARY}>
                                {multi.members.length < multi.max
                                    ? 'Tap another subject on the video to add them.'
                                    : 'Group is full. Drop one to add another.'}
                            </div>
                            {multi.framing && <GroupFramingReadout f={multi.framing} />}
                        </>
                    )}
                </div>
            )}

            {/* ── Distance ─────────────────────────────────────────────── */}
            {/* HIDDEN IN GROUP MODE, because it does nothing there. The
                forward axis is driven by containment - fit everyone with
                margin - not by any one subject's apparent size, so leaving the
                slider on screen would offer a control the aircraft ignores.
                That is worse than no control: it makes the operator think they
                have tried something when they have not. */}
            {!(multi?.enabled && multi.members.length > 1) &&
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MoveVertical size={13} style={{ color: MUTED, transform: 'rotate(90deg)' }} aria-hidden />
                    <span style={LABEL}>Distance</span>
                    <Hint text="How much of the frame height the target should fill. The drone moves in or back to match. Watch 'now' and nudge until the two agree." />
                    <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: TEXT, ...NUM }}>
                        {targetPct}%
                        {actualFillPct != null && (
                            <span style={{ marginLeft: 6, fontWeight: 600, color: wayOff ? BAD.fg : MUTED }}>
                                now {actualFillPct.toFixed(0)}%
                            </span>
                        )}
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className={FOCUS} onClick={() => applyDist(dist - DIST_STEP)} title="Hold further back"
                        aria-label="Hold further back" style={stepBtn}>−</button>
                    <input
                        className={FOCUS}
                        type="range" min={DIST_MIN * 100} max={DIST_MAX * 100} step={1}
                        value={targetPct}
                        onChange={e => applyDist(Number(e.target.value) / 100)}
                        aria-label="Follow distance"
                        style={{ flex: 1, accentColor: 'var(--app-accent)', cursor: 'pointer', minHeight: 24 }}
                    />
                    <button className={FOCUS} onClick={() => applyDist(dist + DIST_STEP)} title="Hold closer"
                        aria-label="Hold closer" style={stepBtn}>+</button>
                </div>
                {wayOff && (
                    <div style={{ fontSize: 13, lineHeight: '18px', color: BAD.fg }}>
                        Well {actualFillPct! > targetPct ? 'above' : 'below'} target. The drone keeps
                        moving {actualFillPct! > targetPct ? 'back' : 'in'} until they meet.
                    </div>
                )}
            </div>}

            {/* ── Altitude ─────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Mountain size={13} style={{ color: MUTED }} aria-hidden />
                <span style={LABEL}>Altitude</span>
                <Hint text="Fixed holds the height Follow started at (nudge or auto-elevate change it). Auto climbs or descends to keep the target centred. Fixed is usually right." />
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {(['fixed', 'auto'] as const).map(m => (
                        <button
                            key={m}
                            className={FOCUS}
                            aria-pressed={altitudeMode === m}
                            onClick={() => getSocket().emit('set_altitude_mode', { mode: m })}
                            style={seg(altitudeMode === m)}
                        >
                            {m}
                        </button>
                    ))}
                </div>
            </div>
            {altitudeMode !== 'auto' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={SECONDARY}>Nudge</span>
                    {([['▲', -0.8], ['▼', 0.8]] as const).map(([glyph, v]) => (
                        <button
                            key={glyph}
                            className={FOCUS}
                            aria-label={v < 0 ? 'Climb (hold)' : 'Descend (hold)'}
                            title="Hold to move"
                            onPointerDown={() => getSocket().emit('set_altitude_nudge', { velocity: v })}
                            onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                            onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                            style={{ ...stepBtn, width: 36, color: WARN.fg, borderColor: WARN.border, background: WARN.bg }}
                        >{glyph}</button>
                    ))}
                    <span style={SECONDARY}>hold to move</span>
                </div>
            )}

            {elevate && (elevate.elevating || elevate.blocked_by) && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13,
                    lineHeight: '18px', color: elevate.elevating ? WARN.fg : BAD.fg,
                }}>
                    <MoveVertical size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span><b>{elevate.elevating ? 'Auto-elevating' : 'Cannot climb'}</b>{': '}{elevate.reason}</span>
                </div>
            )}
        </div>
    )
}

/**
 * What group follow is doing and how much margin it has left.
 *
 * The FILL NUMBERS are shown next to the limit rather than only the action,
 * for the same reason the single-target control shows target and actual
 * together: "framed" and "framed, barely" produce identical behaviour right up
 * until they do not, and the operator needs to see the second one coming.
 */
function GroupFramingReadout({ f }: { f: GroupFraming }) {
    const bad = f.action === 'unframeable'
    const busy = f.action === 'widen' || f.action === 'close'
    const color = bad ? BAD.fg : busy ? WARN.fg : MUTED
    const tight = (v: number, max: number) => v > max * 0.9

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ ...LABEL, color }}>
                    {bad ? 'Cannot frame all' : f.action}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, ...NUM }}>
                    <span style={{ color: tight(f.fill_w_pct, f.max_fill_w_pct) ? WARN.fg : MUTED }}>
                        W {f.fill_w_pct.toFixed(0)}/{f.max_fill_w_pct.toFixed(0)}%
                    </span>
                    <span style={{ marginLeft: 6, color: tight(f.fill_h_pct, f.max_fill_h_pct) ? WARN.fg : MUTED }}>
                        H {f.fill_h_pct.toFixed(0)}/{f.max_fill_h_pct.toFixed(0)}%
                    </span>
                </span>
            </div>
            {/* A member out of frame is reported even while the rest are
                framed perfectly. Group follow keeps flying on whoever it can
                see, so without this line a silent loss looks like normal
                operation. */}
            {f.members_visible < f.members_total && (
                <div style={{ fontSize: 13, color: WARN.fg, lineHeight: '18px' }}>
                    {f.members_visible} of {f.members_total} in frame. Holding so the missing one stays recoverable.
                </div>
            )}
            {/* HOW MUCH ROOM THE WIDEN HAS LEFT, and which bound is
                measuring it. A widen is the one thing here that flies the
                aircraft somewhere, so "backing off" without a budget beside it
                gives no sense of how much further it intends to go. */}
            {(f.action === 'widen' || f.action === 'unframeable') && (
                <div style={{ fontSize: 13, lineHeight: '18px', ...NUM,
                              color: f.widen_budget.by === 'time' ? WARN.fg : MUTED }}>
                    {f.widen_budget.by === 'distance'
                        ? `Backed off ${(f.widen_budget.spent_m ?? 0).toFixed(0)} / ${f.widen_budget.limit_m.toFixed(0)} m`
                        : `Backed off ${f.widen_budget.spent_s.toFixed(0)} / ${f.widen_budget.limit_s.toFixed(0)} s (no GPS fix, limited by time)`}
                </div>
            )}
            <div style={{ fontSize: 13, color, lineHeight: '18px' }}>{f.reason}</div>
            {bad && f.required_range_m != null && (
                <div style={{ fontSize: 13, color: BAD.fg, lineHeight: '18px' }}>
                    Needs about {f.required_range_m.toFixed(0)} m of range, too far to read plates
                    or faces. Drop a member or release.
                </div>
            )}
        </div>
    )
}

const stepBtn: React.CSSProperties = {
    width: 32, height: 32, borderRadius: 6, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1px solid ${BORDER_STRONG}`,
    background: SURFACE_2,
    cursor: 'pointer', fontSize: 16, fontWeight: 700, lineHeight: 1,
    color: TEXT,
}

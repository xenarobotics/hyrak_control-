'use client'

// The follow control, shared by every mode that can chase something.
//
// It exists because four panels had four different answers to the same three
// questions — is a target selected, is the drone actually flying at it, and
// how far / how high should it sit — and the inconsistency was itself the
// reliability problem. An operator should not have to relearn the controls
// when they switch from vehicles to crowds.
//
// The important interaction rule: SELECTING and FLYING are separate. Tapping
// a target on the video selects it. Nothing moves until Follow is armed.
// Arming is what starts PX4 Offboard, so it is a deliberate second action.

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'
import { AlertTriangle, Crosshair, Square, MoveVertical, Info, Mountain } from 'lucide-react'

export type FollowKind = 'vehicle' | 'person'

const DIST_MIN = 0.08
const DIST_MAX = 0.70
const DIST_STEP = 0.06

const LABEL: React.CSSProperties = {
    fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
}

function Hint({ text }: { text: string }) {
    return (
        <span style={{ display: 'flex' }} title={text}>
            <Info size={10} style={{ color: 'hsl(var(--app-text-muted))', cursor: 'help' }} />
        </span>
    )
}

export function FollowControls({
    kind, selectedLabel, lockState, lockMessage,
    altitudeMode, targetRatio, actualFillPct, elevate, onRelease,
}: {
    kind: FollowKind
    /** What is selected, already formatted (e.g. "VH-000042  719257C"). */
    selectedLabel: string | null
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
    // and arming through the other never updated. Traffic hit exactly that —
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
    // The backend already explains itself — "Failed to start Offboard mode —
    // is the drone armed and airborne?" — but the only listener for `error`
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
        socket.on('error', onError)
        return () => { socket.off('error', onError) }
    }, [])

    const [dist, setDist] = useState(targetRatio ?? 0.22)
    useEffect(() => { if (targetRatio != null) setDist(targetRatio) }, [targetRatio])

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
            <div style={{ ...LABEL, textAlign: 'center', padding: '6px 0' }}>
                tap a {kind === 'vehicle' ? 'vehicle' : 'person'} on the video to select
            </div>
        )
    }

    const targetPct = Math.round(dist * 100)
    const wayOff = actualFillPct != null && Math.abs(actualFillPct - targetPct) > 20

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 7,
            padding: '8px 10px', borderRadius: 8,
            background: 'rgba(56,160,255,0.10)',
            border: '1px solid rgba(56,160,255,0.35)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <Crosshair size={13} style={{ color: '#38a0ff' }} />
                <span style={{ fontWeight: 700, color: '#38a0ff' }}>{selectedLabel}</span>
                {lockState && (
                    <span style={{ ...LABEL, marginLeft: 'auto', textTransform: 'uppercase' }}>
                        {lockState}
                    </span>
                )}
            </div>
            {lockMessage && (
                <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#fbbf24' }}>
                    {lockMessage}
                </div>
            )}
            {armError && (
                <div style={{
                    display: 'flex', gap: 5, alignItems: 'flex-start',
                    fontSize: 10, lineHeight: 1.45, color: '#f87171',
                }}>
                    <AlertTriangle size={11} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>{armError}</span>
                </div>
            )}

            {/* Selecting frames a target; flying at it is a second, explicit
                decision — arming is what starts PX4 Offboard. */}
            <div style={{ display: 'flex', gap: 6 }}>
                <button
                    onClick={() => arm(!tracking)}
                    style={{
                        flex: 1, padding: '7px 0', borderRadius: 7, fontSize: 11,
                        fontWeight: 600, cursor: 'pointer',
                        border: `1px solid ${tracking ? '#f87171' : '#38a0ff'}`,
                        background: tracking ? 'rgba(248,113,113,0.15)' : 'rgba(56,160,255,0.15)',
                        color: tracking ? '#f87171' : '#38a0ff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    }}
                >
                    {tracking ? <><Square size={11} /> Stop following</>
                              : <><Crosshair size={11} /> Follow</>}
                </button>
                <button
                    onClick={onRelease}
                    style={{
                        padding: '7px 10px', borderRadius: 7, fontSize: 11,
                        cursor: 'pointer', border: '1px solid hsl(var(--app-border))',
                        background: 'transparent', color: 'hsl(var(--app-text-muted))',
                    }}
                >
                    Release
                </button>
            </div>

            {/* ── Distance ─────────────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MoveVertical size={11} style={{ color: 'hsl(var(--app-text-muted))', transform: 'rotate(90deg)' }} />
                    <span style={LABEL}>Distance</span>
                    <Hint text="Frame height = 100%. The drone moves forward/backward to keep the target filling this much of the frame. There is no single right value — apparent size depends on viewing angle as well as range — so watch 'actual' and nudge until they agree." />
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace', color: '#38a0ff' }}>
                        target {targetPct}%
                        {actualFillPct != null && (
                            <span style={{ marginLeft: 6, color: wayOff ? '#f87171' : 'hsl(var(--app-text-muted))' }}>
                                actual {actualFillPct.toFixed(0)}%
                            </span>
                        )}
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => applyDist(dist - DIST_STEP)} title="Hold further back"
                        style={stepBtn}>−</button>
                    <input
                        type="range" min={DIST_MIN * 100} max={DIST_MAX * 100} step={1}
                        value={targetPct}
                        onChange={e => applyDist(Number(e.target.value) / 100)}
                        style={{ flex: 1, accentColor: '#38a0ff', cursor: 'pointer' }}
                    />
                    <button onClick={() => applyDist(dist + DIST_STEP)} title="Hold closer"
                        style={stepBtn}>+</button>
                </div>
                {wayOff && (
                    <div style={{ fontSize: 9.5, color: '#f87171', lineHeight: 1.4 }}>
                        Actual is well {actualFillPct! > targetPct ? 'above' : 'below'} target — the drone
                        will keep moving {actualFillPct! > targetPct ? 'back' : 'in'} until they meet.
                    </div>
                )}
            </div>

            {/* ── Altitude ─────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Mountain size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                <span style={LABEL}>Altitude</span>
                <Hint text="Fixed holds the height Follow armed at, moving only on the nudge buttons or auto-elevate. Auto changes altitude to keep the target vertically centred. Fixed is usually right: with a fixed downward-tilted camera, a target high or low in frame mostly means far or near, which the distance control already handles." />
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {(['fixed', 'auto'] as const).map(m => (
                        <button
                            key={m}
                            onClick={() => getSocket().emit('set_altitude_mode', { mode: m })}
                            style={{
                                padding: '3px 10px', borderRadius: 6, fontSize: 10,
                                cursor: 'pointer', textTransform: 'capitalize',
                                border: `1px solid ${altitudeMode === m ? '#38a0ff' : 'hsl(var(--app-border))'}`,
                                background: altitudeMode === m ? 'rgba(56,160,255,0.15)' : 'transparent',
                                color: altitudeMode === m ? '#38a0ff' : 'hsl(var(--app-text-muted))',
                            }}
                        >
                            {m}
                        </button>
                    ))}
                </div>
            </div>
            {altitudeMode !== 'auto' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ ...LABEL, fontSize: 9.5 }}>nudge</span>
                    {([['▲', -0.8], ['▼', 0.8]] as const).map(([glyph, v]) => (
                        <button
                            key={glyph}
                            onPointerDown={() => getSocket().emit('set_altitude_nudge', { velocity: v })}
                            onPointerUp={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                            onPointerLeave={() => getSocket().emit('set_altitude_nudge', { velocity: 0 })}
                            style={{ ...stepBtn, width: 34 }}
                        >{glyph}</button>
                    ))}
                    <span style={{ ...LABEL, fontSize: 9 }}>hold to move</span>
                </div>
            )}

            {elevate && (elevate.elevating || elevate.blocked_by) && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 10,
                    lineHeight: 1.5, color: elevate.elevating ? '#38a0ff' : '#f87171',
                }}>
                    <MoveVertical size={11} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span><b>{elevate.elevating ? 'Auto-elevating' : 'Cannot climb'}</b>{' — '}{elevate.reason}</span>
                </div>
            )}
        </div>
    )
}

const stepBtn: React.CSSProperties = {
    width: 26, height: 26, borderRadius: 6, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid hsl(var(--app-border))',
    background: 'hsl(var(--app-surface-2))',
    cursor: 'pointer', fontSize: 14, lineHeight: 1,
    color: 'hsl(var(--app-text))',
}

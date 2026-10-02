'use client'

// "What to do now": only the buttons that make sense in this moment, each
// saying in plain words what will happen. On the ground: take off (arms the
// motors first, then climbs) or fly the planned route. In the air: pause,
// continue, come home, land. Stopping the motors is a separate press-and-hold
// button, shown only while they run.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useDrone } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import type { FlightState } from './useFlightState'
import { HoldButton } from './HoldButton'
import { SetupPanel } from './SetupPanel'
import { setParams, type AvoidanceStatus } from '@/lib/avoidance'

const HEIGHTS = [
    { m: 3, label: 'Low', sub: '3 m' },
    { m: 10, label: 'Medium', sub: '10 m' },
    { m: 30, label: 'High', sub: '30 m' },
]
const INDOOR_HEIGHT = 1.5

type Tone = 'blue' | 'green' | 'plain'

function BigButton({ children, sub, onClick, tone = 'plain', disabled, busy }: {
    children: React.ReactNode; sub?: string; onClick: () => void; tone?: Tone; disabled?: boolean; busy?: boolean
}) {
    const style = tone === 'blue' ? { background: 'var(--s-blue)', color: 'var(--s-blue-ink)', borderColor: 'var(--s-blue)' }
        : tone === 'green' ? { background: 'var(--s-green)', color: '#fff', borderColor: 'var(--s-green)' }
            : { background: 'var(--s-panel)', color: 'var(--s-ink)', borderColor: 'var(--s-line)' }
    return (
        <button type="button" onClick={onClick} disabled={disabled || busy}
            className="w-full min-h-[64px] rounded-[var(--s-radius)] border-2 px-4 py-2.5 text-left disabled:opacity-40 hover:brightness-95 active:brightness-90"
            style={style}>
            <span className="block text-[20px] font-bold leading-tight">{busy ? 'Working…' : children}</span>
            {sub && <span className="block text-[14px] mt-0.5 opacity-90">{sub}</span>}
        </button>
    )
}

// Plain-language versions of the autopilot's refusals.
function explain(raw: string): string {
    const s = raw.toLowerCase()
    if (s.includes('gps') || s.includes('global position')) return 'The drone has no GPS position yet. Wait outside with a clear sky.'
    if (s.includes('battery')) return 'The battery is too low to fly.'
    if (s.includes('preflight') || s.includes('pre-arm') || s.includes('arming denied')) return `The drone is not ready to fly: ${raw}`
    if (s.includes('failsafe')) return raw
    return raw
}

export function ActionPanel({ s, avoid }: { s: FlightState; avoid: AvoidanceStatus | null }) {
    const { sendAction, arm, disarm, emergencyStop } = useDrone()
    const pending = useDroneStore(st => st.pendingAction)
    const last = useDroneStore(st => st.lastActionResult)
    const [height, setHeight] = useState(10)
    const [problem, setProblem] = useState<string | null>(null)
    const [starting, setStarting] = useState(false)
    const wantTakeoff = useRef<number | null>(null)

    useEffect(() => { if (s.indoor) setHeight(INDOOR_HEIGHT) }, [s.indoor])

    // Show a refusal for a while, in plain words.
    useEffect(() => {
        if (!last || last.ok !== false) return
        const why = (last as { error?: string }).error ?? last.msg
        setProblem(why ? explain(why) : 'The drone did not accept that. Try again in a moment.')
        setStarting(false); wantTakeoff.current = null
        const id = setTimeout(() => setProblem(null), 10000)
        return () => clearTimeout(id)
    }, [last])

    // Take off = start the motors, then climb once the drone confirms they run.
    useEffect(() => {
        if (wantTakeoff.current == null) return
        if (s.armed) {
            const h = wantTakeoff.current
            wantTakeoff.current = null
            sendAction('takeoff', { altitude: h })
            setTimeout(() => setStarting(false), 1500)
        }
    }, [s.armed, sendAction])
    useEffect(() => {
        if (!starting) return
        const id = setTimeout(() => {
            if (wantTakeoff.current != null) {
                wantTakeoff.current = null
                setStarting(false)
                setProblem('The motors did not start. Check the drone and try again.')
            }
        }, 8000)
        return () => clearTimeout(id)
    }, [starting])

    const takeOff = () => {
        setProblem(null)
        const h = s.indoor ? INDOOR_HEIGHT : height
        if (s.armed) { sendAction('takeoff', { altitude: h }); return }
        wantTakeoff.current = h
        setStarting(true)
        arm()
    }
    const busy = (...a: string[]) => a.includes(pending?.action ?? '')
    const inRoute = s.mode === 'MISSION' && !s.routeFinished
    const midRoute = s.routeStops > 0 && s.routeIndex > 0 && !s.routeFinished

    const section = 'flex flex-col gap-3'
    const title = 'text-[15px] font-bold'
    const titleStyle = { color: 'var(--s-ink-2)' }

    if (s.phase === 'no-server' || s.phase === 'no-drone' || s.phase === 'connecting') {
        return <SetupPanel />
    }

    return (
        <div className="flex flex-col gap-5">
            {problem && (
                <div role="alert" className="rounded-[var(--s-radius)] px-4 py-3 text-[16px]"
                    style={{ background: 'var(--s-red-soft)', color: '#7A140D' }}>{problem}</div>
            )}

            {!s.inAir && avoid && (
                <label className="flex items-center justify-between gap-3 rounded-xl border-2 px-4 min-h-[56px] cursor-pointer"
                    style={{ borderColor: s.indoor ? 'var(--s-blue)' : 'var(--s-line)', background: s.indoor ? 'var(--s-blue-soft)' : 'var(--s-panel)' }}>
                    <span className="flex flex-col leading-tight">
                        <span className="text-[17px] font-bold">I&rsquo;m flying indoors</span>
                        <span className="text-[13px]" style={{ color: 'var(--s-ink-2)' }}>Low and slow, no GPS needed</span>
                    </span>
                    <input type="checkbox" className="w-6 h-6 accent-[var(--s-blue)]" checked={(avoid.env_mode ?? 0) === 2}
                        onChange={e => { void setParams(avoid.drone_id, { env_mode: e.target.checked ? 2 : 0 }).catch(err => setProblem(String(err.message ?? err))) }} />
                </label>
            )}

            {!s.inAir && (
                <div className={section}>
                    {!s.indoor ? (
                        <>
                            <h2 className={title} style={titleStyle}>How high?</h2>
                            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Take-off height">
                                {HEIGHTS.map(o => {
                                    const on = height === o.m
                                    return (
                                        <button key={o.m} type="button" role="radio" aria-checked={on}
                                            onClick={() => setHeight(o.m)}
                                            className="min-h-[56px] rounded-xl border-2 text-center"
                                            style={on ? { borderColor: 'var(--s-blue)', background: 'var(--s-blue-soft)', color: 'var(--s-ink)' }
                                                : { borderColor: 'var(--s-line)', background: 'var(--s-panel)', color: 'var(--s-ink)' }}>
                                            <span className="block text-[17px] font-bold">{o.label}</span>
                                            <span className="block text-[13px]" style={{ color: 'var(--s-ink-2)' }}>{o.sub}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    ) : (
                        <p className="text-[15px]" style={titleStyle}>Indoor flying: takes off to {INDOOR_HEIGHT} m.</p>
                    )}
                    <BigButton tone="blue" busy={starting || busy('takeoff', 'arm')} disabled={!s.gpsOk}
                        onClick={takeOff} sub={s.armed ? undefined : 'Starts the motors, then climbs and hovers'}>
                        Take off
                    </BigButton>
                    {s.routeStops > 0 ? (
                        <BigButton tone="green" disabled={!s.gpsOk}
                            busy={busy('start_mission', 'arm_and_start_mission', 'restart_mission', 'arm_and_restart_mission')}
                            onClick={() => sendAction(s.routeFinished ? (s.armed ? 'restart_mission' : 'arm_and_restart_mission')
                                : (s.armed ? 'start_mission' : 'arm_and_start_mission'))}
                            sub={`Takes off and flies the ${s.routeStops} planned stops by itself`}>
                            Fly the planned route
                        </BigButton>
                    ) : (
                        <Link href="/mission" className="text-[16px] underline underline-offset-4 inline-flex items-center min-h-[44px]" style={{ color: 'var(--s-blue)' }}>
                            Plan a route for the drone to fly by itself
                        </Link>
                    )}
                    {s.armed && (
                        <BigButton onClick={() => disarm()} busy={busy('disarm')} sub="Only works on the ground">
                            Turn the motors off
                        </BigButton>
                    )}
                </div>
            )}

            {s.inAir && (
                <div className={section}>
                    {inRoute && (
                        <BigButton busy={busy('pause_mission')} onClick={() => sendAction('pause_mission')}
                            sub="Stops and hovers where it is">Pause here</BigButton>
                    )}
                    {!inRoute && midRoute && (
                        <BigButton tone="green" busy={busy('start_mission')} onClick={() => sendAction('start_mission')}
                            sub={`Carries on from stop ${s.routeIndex + 1}`}>Continue the route</BigButton>
                    )}
                    {!inRoute && !midRoute && s.mode !== 'HOLD' && s.mode !== 'LOITER' && (
                        <BigButton busy={busy('hold')} onClick={() => sendAction('hold')}
                            sub="Stops and hovers where it is">Hover here</BigButton>
                    )}
                    {!s.indoor && (
                        <BigButton tone="blue" busy={busy('return')} onClick={() => sendAction('return')}
                            sub="Flies back to where it took off and lands">Come back home</BigButton>
                    )}
                    <BigButton tone={s.indoor ? 'blue' : 'plain'} busy={busy('land')} onClick={() => sendAction('land')}
                        sub="Lands straight down, right here">Land here</BigButton>
                </div>
            )}

            {s.armed && (
                <div className="mt-auto pt-2">
                    <HoldButton label="Emergency: stop the motors"
                        hint={s.inAir ? 'Press and hold. The drone will fall.' : 'Press and hold to stop the motors now.'}
                        onConfirm={() => emergencyStop()} />
                </div>
            )}
        </div>
    )
}

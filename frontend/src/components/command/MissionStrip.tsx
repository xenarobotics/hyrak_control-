'use client'

// Bottom of the Command view: where the mission is, what avoidance is doing
// right now, and the aircraft's latest message - the three things a pilot
// checks between glances at the picture.

import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import type { AvoidanceStatus } from '@/lib/avoidance'

const SEV_COLOR = (rank: number) => rank >= 5 ? '#f87171' : rank >= 4 ? '#fbbf24' : '#a1a1aa'

export function MissionStrip({ avoid }: { avoid: AvoidanceStatus | null }) {
    const t = useDroneStore(s => s.telemetry)
    const msgs = useDroneStore(s => s.fcMessages)
    const plan = useMissionStore(s => s.waypoints)
    const last = msgs.length ? msgs[msgs.length - 1] : null
    const idx = t?.mission_current_index ?? -1
    const total = plan.length
    const pct = total > 0 && idx >= 0 ? Math.min(100, Math.round((idx / total) * 100)) : 0
    const steering = avoid?.state === 'avoiding' || avoid?.state === 'holding'

    return (
        <div className="flex flex-col gap-1.5 font-mono">
            {steering && avoid && (
                <div className="rounded-lg border px-3 py-1.5 text-[11px]"
                    style={{ background: 'rgba(8,47,73,.85)', borderColor: 'rgba(34,211,238,.5)', color: '#a5f3fc' }}>
                    <b>{avoid.state.toUpperCase()}</b> - {avoid.planner?.reason ?? avoid.reason}
                    {avoid.planner?.ttc_s != null && <> · TTC {avoid.planner.ttc_s}s</>}
                    {avoid.planner?.speed_m_s != null && <> · {avoid.planner.speed_m_s.toFixed(1)} m/s</>}
                </div>
            )}
            <div className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-200"
                style={{ background: 'rgba(9,11,16,.78)', backdropFilter: 'blur(8px)' }}>
                <span className="text-zinc-400 tracking-widest text-[9px]">MISSION</span>
                {total > 0
                    ? <>
                        <span className="tabular-nums">WP {idx >= 0 ? idx + 1 : '-'} / {total}</span>
                        <div className="w-24 h-1.5 rounded bg-white/10 overflow-hidden">
                            <div className="h-full bg-cyan-400" style={{ width: `${pct}%` }} />
                        </div>
                    </>
                    : <span className="text-zinc-500">none loaded</span>}
                {last && (
                    <span className="truncate min-w-0" style={{ color: SEV_COLOR(last.rank) }} title={last.text}>
                        · {last.text}
                    </span>
                )}
            </div>
        </div>
    )
}

'use client'

// "Calibrate with a person" - the no-equipment depth calibration for the
// camera path. The person stands 3-8 m from the camera, whole body in view;
// the backend measures ~2 s of frames against their height and stores a
// scale for this camera (see backend person_ruler.py). Shown inside the
// Command window's video menu.

import { useEffect, useState } from 'react'
import { Loader2, Ruler } from 'lucide-react'
import {
    cancelPersonCalibration, getPersonCalibration, startPersonCalibration, type PersonCalibration as Cal,
} from '@/lib/avoidance'

export function PersonCalibration({ droneId }: { droneId: string }) {
    const [height, setHeight] = useState(1.7)
    const [cal, setCal] = useState<Cal | null>(null)
    const [err, setErr] = useState<string | null>(null)

    useEffect(() => {
        let alive = true
        const tick = () => getPersonCalibration(droneId).then(c => { if (alive) setCal(c) }).catch(() => {})
        tick()
        const id = setInterval(tick, 700)
        return () => { alive = false; clearInterval(id) }
    }, [droneId])

    const running = cal?.state === 'collecting'
    const start = async () => {
        setErr(null)
        try { setCal(await startPersonCalibration(droneId, height)) } catch (e) { setErr((e as Error).message) }
    }
    const tone = cal?.state === 'done' ? '#86efac' : cal?.state === 'failed' ? '#fca5a5' : '#a1a1aa'

    return (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-zinc-400" htmlFor="cal-h">Person height</label>
                <input id="cal-h" type="number" min={1} max={2.3} step={0.01} value={height} disabled={running}
                    onChange={e => setHeight(Number(e.target.value) || 1.7)}
                    className="w-16 h-7 rounded border border-white/15 bg-black/40 px-1.5 text-[11px] text-zinc-100" />
                <span className="text-[10px] text-zinc-500">m</span>
                <button onClick={running ? () => { void cancelPersonCalibration(droneId) } : () => { void start() }}
                    className="ml-auto h-7 px-2 rounded border text-[10px] font-bold tracking-wider flex items-center gap-1"
                    style={running
                        ? { borderColor: 'rgba(252,165,165,.5)', color: '#fca5a5' }
                        : { borderColor: 'rgba(34,211,238,.55)', color: '#a5f3fc', background: 'rgba(34,211,238,.1)' }}>
                    {running ? <><Loader2 size={11} className="animate-spin" /> CANCEL</> : <><Ruler size={11} /> CALIBRATE</>}
                </button>
            </div>
            <p className="text-[9.5px] leading-snug" style={{ color: tone }}>
                {err ?? (cal && cal.state !== 'idle'
                    ? `${cal.reason ?? ''}${running ? ` (${cal.samples ?? 0}/10)` : ''}`
                    : 'Stand 3-8 m from the camera, whole body in view, then tap CALIBRATE.')}
            </p>
        </div>
    )
}

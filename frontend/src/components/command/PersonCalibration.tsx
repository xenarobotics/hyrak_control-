'use client'

// "Calibrate with a person" - the no-equipment depth calibration for the
// camera path. The person stands 3-8 m from the camera, whole body in view;
// the backend measures ~2 s of frames against their height and stores a
// scale for this camera (see backend person_ruler.py). Shown inside the
// Command window's video menu.

import { useEffect, useState } from 'react'
import { Loader2, Ruler } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'
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
    const tone = cal?.state === 'done' ? 'text-app-ok' : cal?.state === 'failed' || err ? 'text-app-danger' : 'text-app-text-muted'

    return (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
                <label className="text-[13px] text-app-text-muted" htmlFor="cal-h">Person height</label>
                <input id="cal-h" type="number" min={1} max={2.3} step={0.01} value={height} disabled={running}
                    onChange={e => setHeight(Number(e.target.value) || 1.7)}
                    className={cn('w-16 h-8 rounded-md border border-app-border-strong bg-app-surface px-1.5 text-[14px] text-app-text disabled:text-app-text-subtle disabled:border-dashed', FOCUS)} />
                <span className="text-[12px] text-app-text-muted">m</span>
                <button onClick={running ? () => { void cancelPersonCalibration(droneId) } : () => { void start() }}
                    className={cn('ml-auto h-8 px-2.5 rounded-md border text-[13px] font-bold flex items-center gap-1.5', FOCUS,
                        running ? 'border-app-danger text-app-danger hover:bg-app-danger-soft'
                            : 'border-app-accent text-app-accent bg-app-accent-soft hover:brightness-110')}>
                    {running ? <><Loader2 size={14} className="animate-spin" /> Cancel</> : <><Ruler size={14} /> Calibrate</>}
                </button>
            </div>
            <p className={cn('text-[13px] leading-snug', tone)}>
                {err ?? (cal && cal.state !== 'idle'
                    ? `${cal.reason ?? ''}${running ? ` (${cal.samples ?? 0}/10)` : ''}`
                    : 'Stand 3-8 m from the camera, whole body in view, then tap Calibrate.')}
            </p>
        </div>
    )
}

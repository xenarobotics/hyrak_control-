'use client'

// One line under the link picker while "Cloud simulator" is selected: what
// the server-side sim is doing, and a Stop once it runs. Start is the
// picker's own Connect; there is nothing else to set (one airframe, home
// at the workspace's operating area). docs/ACCESS_MODEL.md 8c.

import { useCloudSimStore, stopCloudSim, cloudSimErrorText } from '@/store/cloudSim'
import { CLOUD_SIM_PREMIUM_NOTE } from '@/hooks/useTelemetryLink'

export function CloudSimNote({ className, entitled }: { className?: string; entitled: boolean }) {
    const s = useCloudSimStore(st => st.status)
    if (!entitled) return <p className={className}>{CLOUD_SIM_PREMIUM_NOTE}</p>
    const err = cloudSimErrorText(s)
    let text = 'Starts a simulated quadcopter on the HYRAK server for this session (about 15-30 s).'
    if (s?.state === 'starting') text = 'Starting the simulator on the server...'
    else if (s?.state === 'ready') {
        const mins = Math.round(s.idle_minutes ?? 15)
        text = `Simulator running${s.linked ? '' : ' (not linked)'}. It stops after ${mins} min on the ground or when this session ends.`
    } else if (s?.state === 'stopping') text = 'Stopping the simulator...'
    else if (s?.ended === 'idle') text = 'The simulator stopped after being idle. Connect to start a new one.'
    return (
        <div className={className}>
            <p>{err ?? text}</p>
            {(s?.state === 'ready' || s?.state === 'starting') && (
                <button type="button" onClick={() => stopCloudSim()} className="underline underline-offset-2 mt-1">
                    Stop simulator
                </button>
            )}
        </div>
    )
}

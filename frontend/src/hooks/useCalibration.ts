'use client'

import { useCallback, useEffect, useState } from 'react'

import { getSocket } from '@/lib/socket'
import { useDrone } from '@/hooks/useDrone'
import type { CalibrationState } from '@/types/calibration'

const IDLE: CalibrationState = { sensor: '', phase: 'idle', sides: {} }

export function useCalibration() {
    const { sendAction } = useDrone()
    const [state, setState] = useState<CalibrationState>(IDLE)
    // The refusal is a REPLY, not a state: it belongs to the press that earned
    // it and must not outlive a later successful start.
    const [refusal, setRefusal] = useState<string | null>(null)

    useEffect(() => {
        const socket = getSocket()
        const onState = (s: CalibrationState) => {
            setState(s?.phase ? s : IDLE)
            if (s?.phase === 'starting' || s?.phase === 'running') setRefusal(null)
        }
        const onResult = (r: { action?: string; ok?: boolean; error?: string }) => {
            if (r?.action !== 'start_calibration') return
            if (r.ok) { setRefusal(null); return }
            // BACK TO IDLE, not just "show the reason". The optimistic start
            // switched the panel to the stage view, and the reason is rendered
            // on the picker - so a refusal left the operator watching "asking
            // the autopilot…" forever with the explanation on a screen they
            // could no longer see.
            setRefusal(r.error || 'The drone refused to start the calibration')
            setState(IDLE)
        }
        socket.on('calibration_state', onState)
        socket.on('action_result', onResult)
        return () => {
            socket.off('calibration_state', onState)
            socket.off('action_result', onResult)
        }
    }, [])

    const start = useCallback((sensor: string) => {
        setRefusal(null)
        // Optimistic ONLY as far as "asked". The phase stays 'starting' until
        // the aircraft says otherwise, and every side stays pending - nothing
        // here is allowed to show progress the autopilot has not reported.
        setState({ sensor, phase: 'starting', sides: {}, instruction: 'Asking the autopilot…' })
        sendAction('start_calibration', { sensor })
    }, [sendAction])

    const cancel = useCallback(() => sendAction('cancel_calibration'), [sendAction])
    const dismiss = useCallback(() => {
        setState(IDLE)
        setRefusal(null)
        sendAction('dismiss_calibration')
    }, [sendAction])

    const busy = state.phase === 'starting' || state.phase === 'running'
    return { state, refusal, busy, start, cancel, dismiss }
}

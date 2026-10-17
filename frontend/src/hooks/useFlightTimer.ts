'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'

/** Flight time: runs while the aircraft is armed, holds while disarmed, so
 *  a re-arm continues the count. reset() starts from zero. */
export function useFlightTimer() {
    const [elapsed, setElapsed] = useState(0)
    // The count carried across arm cycles, readable from the effect without
    // making `elapsed` a dependency (which would restart the interval every
    // second).
    const elapsedRef = useRef(0)
    const telemetry = useDroneStore(s => s.telemetry)
    const armed = telemetry?.flight_mode.is_armed ?? false

    useEffect(() => {
        if (!armed) return
        const start = Date.now() - elapsedRef.current * 1000
        const id = setInterval(() => {
            const e = Math.floor((Date.now() - start) / 1000)
            elapsedRef.current = e
            setElapsed(e)
        }, 1000)
        return () => clearInterval(id)
    }, [armed])

    const reset = useCallback(() => {
        elapsedRef.current = 0
        setElapsed(0)
    }, [])

    return { elapsed, running: armed, reset }
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'

export function useFlightTimer() {
    const [elapsed, setElapsed] = useState(0)
    const [running, setRunning] = useState(false)
    const intervalRef = useRef<NodeJS.Timeout | null>(null)
    const startTimeRef = useRef<number>(0)
    const telemetry = useDroneStore(s => s.telemetry)
    const armed = telemetry?.flight_mode.is_armed ?? false

    useEffect(() => {
        if (armed && !running) {
            // Drone just armed — start timer
            startTimeRef.current = Date.now() - elapsed * 1000
            setRunning(true)
            intervalRef.current = setInterval(() => {
                setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
            }, 1000)
        } else if (!armed && running) {
            // Drone disarmed — stop timer but keep elapsed
            setRunning(false)
            if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
            }
        }

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current)
        }
    }, [armed])

    const reset = () => {
        setElapsed(0)
        setRunning(false)
        if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
    }

    return { elapsed, running, reset }
}
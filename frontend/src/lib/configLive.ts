'use client'

// Raw readings for Config > Sensors and Radio & RC, off the session's OWN
// link (backend app/events/config_live_events.py). Passive: the backend only
// listens; nothing is sent to the aircraft. Every customer can use it, unlike
// the staff-only RC monitor on a shared server port.
//
// The request is a lease the page renews every few seconds, so a closed tab
// cannot leave the backend listening.

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

type Msg<T> = T & { age: number }

export interface ConfigLive {
    RC_CHANNELS?: Msg<{ chancount: number; rssi: number } & Record<string, number>>
    SCALED_PRESSURE?: Msg<{ press_abs?: number; temperature?: number }>
    ESTIMATOR_STATUS?: Msg<{ flags?: number; vel_ratio?: number; pos_horiz_ratio?: number; pos_vert_ratio?: number; mag_ratio?: number; hagl_ratio?: number; tas_ratio?: number; pos_horiz_accuracy?: number; pos_vert_accuracy?: number }>
    VIBRATION?: Msg<{ vibration_x?: number; vibration_y?: number; vibration_z?: number; clipping_0?: number; clipping_1?: number; clipping_2?: number }>
    SYS_STATUS?: Msg<{ onboard_control_sensors_present?: number; onboard_control_sensors_enabled?: number; onboard_control_sensors_health?: number; load?: number }>
    HIGHRES_IMU?: Msg<{ xacc?: number; yacc?: number; zacc?: number; xgyro?: number; ygyro?: number; zgyro?: number; xmag?: number; ymag?: number; zmag?: number; abs_pressure?: number; temperature?: number }>
    SCALED_IMU?: Msg<{ xacc?: number; yacc?: number; zacc?: number; xgyro?: number; ygyro?: number; zgyro?: number; xmag?: number; ymag?: number; zmag?: number }>
    error?: string
}

const RENEW_MS = 8000

/** Latest raw readings while `enabled` and a drone is linked. `at` is when the
 *  last batch arrived (0 = nothing yet), so callers can tell "no feed" apart
 *  from "feed, but this message is not streamed". */
export function useConfigLive(enabled = true): { data: ConfigLive; at: number } {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const [state, setState] = useState<{ data: ConfigLive; at: number }>({ data: {}, at: 0 })
    const on = enabled && connected
    // Forget the last aircraft's readings when the feed turns off (render-time).
    const [wasOn, setWasOn] = useState(on)
    if (wasOn !== on) {
        setWasOn(on)
        if (!on) setState({ data: {}, at: 0 })
    }

    useEffect(() => {
        if (!on) return
        const socket = getSocket()
        const onData = (d: ConfigLive) => setState({ data: d ?? {}, at: Date.now() })
        socket.on('config_live_data', onData)
        const ask = () => socket.emit('config_live', { on: true })
        ask()
        const t = setInterval(ask, RENEW_MS)
        return () => {
            clearInterval(t)
            socket.off('config_live_data', onData)
            socket.emit('config_live', { on: false })
        }
    }, [on])

    return state
}

/** Channel values (µs, 0 = unused) from an RC_CHANNELS message. */
export function rcChannels(m: ConfigLive['RC_CHANNELS']): number[] {
    if (!m) return []
    const n = Math.max(8, Math.min(18, m.chancount || 0))
    return Array.from({ length: n }, (_, i) => Number(m[`chan${i + 1}_raw`] ?? 0))
}

/** MAV_SYS_STATUS_SENSOR bits the Sensors page shows. */
export const SYS_SENSOR = {
    gyro: 1 << 0, accel: 1 << 1, mag: 1 << 2, baro: 1 << 3, diffPressure: 1 << 4, gps: 1 << 5,
    rcReceiver: 1 << 16, ahrs: 1 << 21, prearm: 1 << 28,
} as const

/** 'ok' | 'fault' | 'absent' for one SYS_STATUS sensor bit, or null with no data. */
export function sysSensor(m: ConfigLive['SYS_STATUS'], bit: number): 'ok' | 'fault' | 'absent' | null {
    if (!m || m.onboard_control_sensors_present == null) return null
    if (!(m.onboard_control_sensors_present & bit)) return 'absent'
    return (m.onboard_control_sensors_health ?? 0) & bit ? 'ok' : 'fault'
}

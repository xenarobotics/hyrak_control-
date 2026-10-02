'use client'

// What the aircraft is doing, in words anyone understands - the single source
// for Normal mode's status band, its action panel and its alerts. Everything
// here is derived from the same stores the Dev screens read; nothing new is
// fetched.

import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import type { AvoidanceStatus } from '@/lib/avoidance'

export type Tone = 'good' | 'attention' | 'stop' | 'neutral'

export type Phase =
    | 'no-server'       // browser cannot reach HYRAK
    | 'no-drone'        // HYRAK is fine, no drone link yet
    | 'connecting'
    | 'lost'            // link to the drone dropped
    | 'ground'          // on the ground, motors off
    | 'armed'           // on the ground, motors on
    | 'flying'

export interface FlightState {
    phase: Phase
    tone: Tone
    headline: string          // one plain sentence
    detail?: string           // optional second line
    mode: string              // PX4 mode, upper case
    armed: boolean
    inAir: boolean
    battery: number | null
    altitude: number | null
    routeStops: number
    routeIndex: number        // -1 = not flying the route
    routeFinished: boolean
    indoor: boolean
    gpsOk: boolean
}

const BATTERY_WARN = 30
const BATTERY_LOW = 20

export function useFlightState(avoid: AvoidanceStatus | null): FlightState {
    const t = useDroneStore(s => s.telemetry)
    const cloud = useDroneStore(s => s.connectionStatus)
    const link = useDroneStore(s => s.telemetryStatus)
    const stops = useMissionStore(s => s.waypoints.length)

    const mode = (t?.flight_mode.mode ?? '').toUpperCase()
    const armed = t?.flight_mode.is_armed ?? false
    const inAir = t?.flight_mode.is_in_air ?? false
    const battery = t ? Math.round(t.battery.remaining_percent) : null
    const altitude = t ? t.position.relative_altitude_m : null
    const idx = t?.mission_current_index ?? -1
    const finished = t?.mission_finished ?? false
    const indoor = avoid?.env === 'indoor'
    const gpsOk = indoor || (t?.gps.fix_type ?? 0) >= 3
    const base = {
        mode, armed, inAir, battery, altitude, indoor, gpsOk,
        routeStops: stops, routeIndex: idx, routeFinished: finished,
    }

    if (cloud !== 'connected') {
        return { ...base, phase: 'no-server', tone: 'stop',
            headline: cloud === 'reconnecting' ? 'Reconnecting to HYRAK…' : 'Can’t reach HYRAK.',
            detail: 'Check this computer’s internet connection. The drone keeps following its safety plan meanwhile.' }
    }
    if (link === 'connecting') {
        return { ...base, phase: 'connecting', tone: 'neutral', headline: 'Connecting to the drone…' }
    }
    if (link !== 'connected' || !t) {
        return { ...base, phase: 'no-drone', tone: 'neutral', headline: 'No drone connected yet.',
            detail: 'Turn the drone on, then press Connect the drone.' }
    }
    if (t.link_ok === false) {
        const s = Math.round(t.link_lost_s ?? 0)
        return { ...base, phase: 'lost', tone: 'stop',
            headline: `Lost contact with the drone ${s > 0 ? `${s} s ago` : ''}.`.replace(' .', '.'),
            detail: 'It follows its own safety plan until contact comes back. Keep this screen open.' }
    }

    if (!inAir) {
        if (armed) {
            return { ...base, phase: 'armed', tone: 'attention', headline: 'Motors are running. Stay clear of the propellers.' }
        }
        if (!gpsOk) {
            return { ...base, phase: 'ground', tone: 'attention', headline: 'Waiting for GPS.',
                detail: 'Keep the drone outside with a clear view of the sky. Flying indoors? Switch on I\u2019m flying indoors.' }
        }
        return { ...base, phase: 'ground', tone: 'good', headline: 'Ready to fly.',
            detail: 'Choose how high, then press Take off.' }
    }

    // In the air
    if (battery != null && battery <= BATTERY_LOW && !mode.includes('RETURN') && mode !== 'LAND') {
        return { ...base, phase: 'flying', tone: 'stop', headline: `Battery low (${battery}%). Bring the drone home now.` }
    }
    const steering = avoid?.state === 'avoiding' || avoid?.state === 'climbing' || avoid?.guarding
    let headline = 'Flying.'
    let tone: Tone = 'good'
    let detail: string | undefined
    if (steering) {
        tone = 'attention'
        headline = avoid?.state === 'climbing' ? 'Climbing over something in the way.' : 'Moving around something in the way.'
        detail = 'The drone is steering itself. You don’t need to do anything.'
    } else if (avoid?.state === 'holding') {
        tone = 'attention'
        headline = 'Stopped: something is in the way.'
        detail = 'Choose Come back home or Land here if it does not find a way around.'
    } else if (mode === 'MISSION') {
        headline = finished ? 'Route finished. The drone is waiting in the air.'
            : stops > 0 && idx >= 0 ? `Flying the route: stop ${Math.min(idx + 1, stops)} of ${stops}.` : 'Flying the route.'
    } else if (mode === 'HOLD' || mode === 'LOITER') {
        headline = 'Hovering in place.'
    } else if (mode.includes('RETURN') || mode === 'RTL') {
        headline = 'Coming back home.'
    } else if (mode === 'LAND') {
        headline = 'Landing.'
    } else if (mode === 'TAKEOFF') {
        headline = 'Taking off.'
    } else if (mode === 'OFFBOARD') {
        headline = avoid?.following ? 'Following the target.' : 'Flying under HYRAK control.'
    } else if (['POSCTL', 'POSITION', 'ALTCTL', 'ALTITUDE', 'STABILIZED', 'MANUAL', 'ACRO'].includes(mode)) {
        headline = 'Being flown with the remote control.'
    }
    if (tone === 'good' && battery != null && battery <= BATTERY_WARN) {
        tone = 'attention'
        detail = `Battery ${battery}%. Plan to come home soon.`
    }
    return { ...base, phase: 'flying', tone, headline, detail }
}

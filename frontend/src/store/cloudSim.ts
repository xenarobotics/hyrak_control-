'use client'

// The session's cloud simulator (docs/ACCESS_MODEL.md 8b): a premium PX4 +
// Gazebo instance on the server, started per session. The customer's
// default simulator is still their own PX4 / Gazebo through the desktop
// app's "SITL" link; this is the optional extra.
//
// The server owns everything: it picks the ports, launches the sim, links
// this session's telemetry to it when ready, and pushes cloud_sim_status
// on every change. The client only asks to start, stop, or for the status.

import { create } from 'zustand'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export type CloudSimState = 'none' | 'starting' | 'ready' | 'stopping' | 'error'

export interface CloudSimStatus {
    state: CloudSimState
    enabled: boolean
    entitled: boolean
    message?: string
    error?: string
    code?: string
    ended?: string
    linked?: boolean
    boot_s?: number
    idle_minutes?: number
    idle_stop_in_s?: number
    home?: { lat: number; lon: number; source: string }
    quota?: { workspace_used: number; workspace_max: number; global_used: number; global_max: number }
}

interface CloudSimStore {
    status: CloudSimStatus | null
    setStatus: (s: CloudSimStatus) => void
}

export const useCloudSimStore = create<CloudSimStore>(set => ({
    status: null,
    setStatus: status => set({ status }),
}))

/** Plain-language reason for a refusal or failure, from the server's code. */
export function cloudSimErrorText(s: CloudSimStatus | null): string | null {
    if (!s) return null
    if (s.state === 'error') return s.error || 'The cloud simulator could not be started.'
    return null
}

let listening = false

/** One socket listener for the whole app, installed on first use. While a
 *  start is pending the telemetry pill shows "connecting"; a refusal or a
 *  failed boot turns that into the telemetry error every picker shows. */
export function ensureCloudSimListener(): void {
    if (listening || typeof window === 'undefined') return
    listening = true
    // A new or resumed session: ask again (the sim belongs to the session).
    getSocket().on('session_ready', () => { getSocket().emit('cloud_sim_status') })
    getSocket().on('cloud_sim_status', (s: CloudSimStatus) => {
        useCloudSimStore.getState().setStatus(s)
        const drone = useDroneStore.getState()
        if (s.state === 'error' && drone.telemetryStatus === 'connecting') {
            drone.setTelemetryError(cloudSimErrorText(s) ?? 'The cloud simulator could not be started.')
            drone.setTelemetryStatus('error')
        }
        if (s.state === 'none' && drone.telemetryStatus === 'connecting') {
            drone.setTelemetryStatus('disconnected')
        }
    })
}

export function requestCloudSimStatus(): void {
    ensureCloudSimListener()
    getSocket().emit('cloud_sim_status')
}

export function startCloudSim(): void {
    ensureCloudSimListener()
    const drone = useDroneStore.getState()
    drone.setTelemetryError(null)
    drone.setTelemetryStatus('connecting')
    getSocket().emit('start_cloud_sim', {})
}

export function stopCloudSim(): void {
    ensureCloudSimListener()
    getSocket().emit('stop_cloud_sim')
}

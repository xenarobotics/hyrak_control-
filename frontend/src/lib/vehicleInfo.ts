'use client'

// What the connected flight controller says about itself: firmware, board,
// hardware UID, flight stack, system ids and the link's last-message age.
// One copy per link, shared by Config > Vehicle and Config > Connection,
// read through the `vehicle_info` socket event (backend
// app/telemetry/vehicle_info.py). The firmware facts are cached on the server
// for the link; the link facts (message age, rates) are fresh on every read,
// so the Connection page polls while it is open.

import { create } from 'zustand'
import { useEffect } from 'react'
import { getSocket } from '@/lib/socket'
import { useDroneStore } from '@/store/drone'

export interface VehicleInfo {
    ok: boolean
    error?: string
    /** False when AUTOPILOT_VERSION never answered (the link facts still do). */
    info_ok?: boolean
    firmware?: string
    release?: string
    git_hash?: string
    os_version?: string
    os_git_hash?: string
    vendor_id?: number | null
    vendor_name?: string
    product_id?: number | null
    product_name?: string
    hardware_uid?: string
    autopilot?: string
    vehicle_type?: string
    mav_type?: number | null
    vehicle_sysid?: number | null
    gcs_sysid?: number
    address?: string
    link_kind?: string
    last_rx_age_s?: number | null
    rates?: Record<string, number>
}

interface InfoState {
    info: VehicleInfo | null
    loading: boolean
    /** Local time the last answer arrived, to age the message-age figure. */
    at: number
}

export const useVehicleInfoStore = create<InfoState>(() => ({ info: null, loading: false, at: 0 }))

let wired = false
function wire() {
    if (wired || typeof window === 'undefined') return
    wired = true
    getSocket().on('vehicle_info_result', (d: VehicleInfo) => {
        useVehicleInfoStore.setState({ info: d, loading: false, at: Date.now() })
    })
}

export function requestVehicleInfo() {
    wire()
    useVehicleInfoStore.setState({ loading: true })
    getSocket().emit('vehicle_info', {})
}

/** The flight controller's facts, read once per link. `pollMs` re-reads
 *  while the caller is mounted (the Connection page's live link health). */
export function useVehicleInfo(pollMs?: number) {
    const connected = useDroneStore(s => s.telemetryStatus) === 'connected'
    const state = useVehicleInfoStore()
    useEffect(() => {
        wire()
        if (!connected) { useVehicleInfoStore.setState({ info: null, loading: false, at: 0 }); return }
        requestVehicleInfo()
        // The identity read races the first heartbeat on a fresh link; one
        // early retry fills in what the first answer lacked.
        const retry = setTimeout(() => {
            if (!useVehicleInfoStore.getState().info?.info_ok) requestVehicleInfo()
        }, 4000)
        const poll = pollMs ? setInterval(() => { if (document.visibilityState === 'visible') requestVehicleInfo() }, pollMs) : null
        return () => { clearTimeout(retry); if (poll) clearInterval(poll) }
    }, [connected, pollMs])
    return { ...state, connected }
}

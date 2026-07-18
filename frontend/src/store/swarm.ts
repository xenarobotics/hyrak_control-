import { create } from 'zustand'
import type { TelemetrySnapshot } from '@/types/telemetry'
import { FLEET_COLORS, colorForDrone } from '@/lib/fleet'
import { getSocket } from '@/lib/socket'

// Re-export for existing imports; canonical list lives in lib/fleet.ts
export const DRONE_COLORS = FLEET_COLORS

export interface DroneEntry {
    id: number
    name: string
    color: string
    connected: boolean
    telemetry: TelemetrySnapshot | null
}

export type ScanStatus = 'idle' | 'scanning' | 'done'

export interface GroupResult {
    action: string
    okCount: number
    total: number
    at: number
}

// Supervisor alerts (fleet_alert events): low battery, auto-RTL, link loss,
// separation, fleet completion. Shown in the fleet panels — never map popups.
export interface FleetAlert {
    droneId: number
    kind: string
    severity: 'info' | 'warn' | 'critical'
    msg: string
    at: number
}

// Persist swarm-enabled flag so it survives page reload within the same browser session.
// Drones themselves are NOT persisted — they're repopulated by auto-scan on reconnect.
const SESSION_KEY = 'hyrak_swarm_enabled'
function readPersistedEnabled(): boolean {
    if (typeof window === 'undefined') return false
    return sessionStorage.getItem(SESSION_KEY) === 'true'
}
function writePersistedEnabled(v: boolean) {
    if (typeof window === 'undefined') return
    sessionStorage.setItem(SESSION_KEY, String(v))
}

interface SwarmStore {
    enabled: boolean
    drones: Record<number, DroneEntry>
    activeDroneId: number | null
    scanStatus: ScanStatus
    // Multi-select for group commands. Empty = group commands target ALL connected.
    selectedIds: number[]
    lastGroupResult: GroupResult | null
    alerts: FleetAlert[]
    pushAlert: (a: FleetAlert) => void

    setEnabled: (v: boolean) => void
    setActiveDrone: (id: number | null) => void
    setScanStatus: (s: ScanStatus) => void
    addDrone: (id: number, name: string, color: string) => void
    removeDrone: (id: number) => void
    clearFleet: () => void
    setDroneConnected: (id: number, connected: boolean, name?: string, color?: string) => void
    updateDroneTelemetry: (id: number, t: TelemetrySnapshot) => void
    updateFleetTelemetry: (map: Record<string, TelemetrySnapshot>) => void
    toggleSelected: (id: number) => void
    setSelected: (ids: number[]) => void
    setGroupResult: (r: GroupResult | null) => void
}

// Shared upsert used by every path telemetry/status can arrive through —
// scan events, per-drone status, and batched fleet telemetry all race each
// other, so any of them may see a drone id before the store knows it.
function upsertEntry(drones: Record<number, DroneEntry>, id: number): DroneEntry {
    return drones[id] ?? {
        id,
        name: `Drone ${id}`,
        color: colorForDrone(id),
        connected: false,
        telemetry: null,
    }
}

export const useSwarmStore = create<SwarmStore>((set) => ({
    enabled: readPersistedEnabled(),
    drones: {},
    activeDroneId: null,
    scanStatus: 'idle',
    selectedIds: [],
    lastGroupResult: null,
    alerts: [],

    pushAlert: (a) => set((s) => ({ alerts: [a, ...s.alerts].slice(0, 20) })),

    setEnabled: (v) => {
        writePersistedEnabled(v)
        // Tell the backend: on disable it releases every fleet manager +
        // mavsdk_server, so re-enabling always reconnects from a clean slate.
        try {
            getSocket().emit('set_swarm_mode', { enabled: v })
        } catch { /* socket not up yet — backend cleans on disconnect anyway */ }
        set((s) => ({
            enabled: v,
            drones: v ? s.drones : {},
            activeDroneId: v ? s.activeDroneId : null,
            scanStatus: v ? s.scanStatus : 'idle',
            selectedIds: v ? s.selectedIds : [],
            lastGroupResult: null,
            alerts: v ? s.alerts : [],
        }))
    },

    setActiveDrone: (id) => set({ activeDroneId: id }),

    setScanStatus: (s) => set({ scanStatus: s }),

    // Clear stale drone entries — called when socket reconnects so the
    // auto-rescan can repopulate with fresh connections.
    clearFleet: () => set({ drones: {}, activeDroneId: null, scanStatus: 'idle', selectedIds: [] }),

    addDrone: (id, name, color) => set((s) => {
        // Don't overwrite an existing connected drone
        if (s.drones[id]) return {}
        return {
            drones: {
                ...s.drones,
                [id]: { id, name, color, connected: false, telemetry: null },
            },
            activeDroneId: s.activeDroneId ?? id,
        }
    }),

    removeDrone: (id) => set((s) => {
        const drones = { ...s.drones }
        delete drones[id]
        const ids = Object.keys(drones).map(Number)
        return {
            drones,
            activeDroneId: s.activeDroneId === id ? (ids[0] ?? null) : s.activeDroneId,
            selectedIds: s.selectedIds.filter(i => i !== id),
        }
    }),

    setDroneConnected: (id, connected, name, color) => set((s) => {
        const entry = upsertEntry(s.drones, id)
        return {
            drones: {
                ...s.drones,
                [id]: {
                    ...entry,
                    connected,
                    ...(name  ? { name  } : {}),
                    ...(color ? { color } : {}),
                },
            },
            // Auto-select the first connected drone, matching addDrone's behavior
            activeDroneId: s.activeDroneId ?? (connected ? id : null),
        }
    }),

    updateDroneTelemetry: (id, t) => set((s) => {
        const entry = upsertEntry(s.drones, id)
        return {
            drones: { ...s.drones, [id]: { ...entry, connected: true, telemetry: t } },
            activeDroneId: s.activeDroneId ?? id,
        }
    }),

    // Batched fleet telemetry — ONE store update per fleet_telemetry event,
    // regardless of fleet size. Per-drone updates at 3 Hz each re-render the
    // whole UI 30×/s with 10 drones; this caps it at the emit rate (~3×/s).
    updateFleetTelemetry: (map) => set((s) => {
        const ids = Object.keys(map).map(Number)
        if (ids.length === 0) return {}
        const drones = { ...s.drones }
        for (const id of ids) {
            const entry = upsertEntry(drones, id)
            drones[id] = { ...entry, connected: true, telemetry: map[String(id)] }
        }
        return {
            drones,
            activeDroneId: s.activeDroneId ?? Math.min(...ids),
        }
    }),

    toggleSelected: (id) => set((s) => ({
        selectedIds: s.selectedIds.includes(id)
            ? s.selectedIds.filter(i => i !== id)
            : [...s.selectedIds, id],
    })),

    setSelected: (ids) => set({ selectedIds: ids }),

    setGroupResult: (r) => set({ lastGroupResult: r }),
}))

// Fleet-wide constants shared across swarm UI, stores and socket handlers.
// Must stay in sync with backend app/events/swarm_events.py.

// 20 visually distinct colors; wraps beyond that (fleet size is unbounded).
export const FLEET_COLORS = [
    '#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#ef4444',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#6366f1',
    '#14b8a6', '#eab308', '#f43f5e', '#0ea5e9', '#22c55e',
    '#d946ef', '#fb923c', '#8b5cf6', '#2dd4bf', '#dc2626',
]

export const colorForDrone = (id: number) =>
    FLEET_COLORS[(((id - 1) % FLEET_COLORS.length) + FLEET_COLORS.length) % FLEET_COLORS.length]

// PX4 SITL instance i → offboard UDP 14540+i, except 14550 (QGC broadcast
// port) is skipped, so instances 10+ shift up by one. Drone id == instance id.
export const portForDrone = (id: number) => (id > 9 ? 14541 + id : 14540 + id)

// How many drone ids the auto-scan probes (1..N). Testing cap — the
// architecture itself has no fleet-size limit.
export const FLEET_SCAN_COUNT = 30

// Default fleet altitude target (m) for the SET ALT command.
export const GROUP_TAKEOFF_ALT = 10

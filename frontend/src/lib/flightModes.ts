export const FLIGHT_MODES = [
    { value: 'HOLD', label: 'Hold', description: 'Hover in place' },
    { value: 'POSITION', label: 'Position', description: 'GPS hold, hover in place' },
    { value: 'STABILIZED', label: 'Stabilized', description: 'Self-levels, no GPS hold' },
    { value: 'MISSION', label: 'Mission', description: 'Follow uploaded waypoints' },
    { value: 'RETURN', label: 'Return to Launch', description: 'Fly home and land' },
    { value: 'LAND', label: 'Land', description: 'Descend and land now' },
    { value: 'OFFBOARD', label: 'Offboard', description: 'AI / software control' },
]

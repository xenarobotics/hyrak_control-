// The mode menu.
//
// THIS LIST AND THE BACKEND USED TO DISAGREE. Seven modes were offered and
// four were implemented: STABILIZED, MISSION and OFFBOARD fell through to an
// "Unknown flight mode" warning, so selecting them did nothing and said
// nothing. POSITION was worse - it was silently aliased to HOLD, so the one
// mode that appeared to work was reporting a mode nobody had asked for.
//
// Every entry here is now sent for real and confirmed against telemetry before
// the UI calls it done. OFFBOARD is deliberately NOT offered: PX4 rejects it
// unless setpoints are already streaming, so it can only ever be entered by
// the AI tracking modes that produce them - a menu item for it could not do
// anything but fail.

export interface FlightModeOption {
    value: string
    label: string
    description: string
    /** Shown when the mode needs something the operator can check first.
     *  PX4 refuses a mode whose preconditions are not met and does not say
     *  why, so the condition belongs in front of the choice, not after it. */
    requires?: string
}

export const FLIGHT_MODES: FlightModeOption[] = [
    {
        value: 'HOLD', label: 'Hold',
        description: 'Hover in place, holding position and altitude',
        requires: 'GPS position',
    },
    {
        value: 'POSITION', label: 'Position',
        description: 'Manual sticks with GPS position and altitude assist',
        requires: 'GPS position, and RC for stick input',
    },
    {
        value: 'ALTITUDE', label: 'Altitude',
        description: 'Manual sticks with altitude hold, no position hold',
        requires: 'RC for stick input - it will drift with the wind',
    },
    {
        value: 'STABILIZED', label: 'Stabilized',
        description: 'Self-levels only. No position or altitude hold',
        requires: 'RC for stick input',
    },
    {
        value: 'MISSION', label: 'Mission',
        description: 'Fly the uploaded waypoints',
        requires: 'a mission uploaded, and armed',
    },
    {
        value: 'RETURN', label: 'Return to Launch',
        description: 'Fly home and land',
        requires: 'a home position',
    },
    { value: 'LAND', label: 'Land', description: 'Descend and land here' },
]

/** What telemetry reports, mapped back to the option that produced it.
 *
 *  The menu had no idea what mode the aircraft was actually in - its trigger
 *  said "Change flight mode..." forever. So selecting Position and landing in
 *  Hold looked identical to selecting Position and getting Position, and the
 *  only way to notice was to read the separate mode chip and know that POSCTL
 *  and HOLD are different things. Showing the live mode in the control that
 *  sets it makes a refusal or a substitution self-evident.
 */
const REPORTED_AS: Record<string, string> = {
    HOLD: 'HOLD',
    POSCTL: 'POSITION',
    ALTCTL: 'ALTITUDE',
    STABILIZED: 'STABILIZED',
    MISSION: 'MISSION',
    RETURN_TO_LAUNCH: 'RETURN',
    LAND: 'LAND',
}

export function modeOptionFor(reported: string | undefined | null): string {
    if (!reported) return ''
    return REPORTED_AS[reported.toUpperCase()] ?? ''
}

/** The live mode as a label, including the ones that are NOT selectable -
 *  Offboard, Takeoff, Manual, Acro, Ready. Those are real states the aircraft
 *  reports and the operator needs to see; they are simply not things this
 *  menu can put it into. */
export function modeLabel(reported: string | undefined | null): string {
    if (!reported) return '-'
    const opt = FLIGHT_MODES.find(m => m.value === modeOptionFor(reported))
    if (opt) return opt.label
    const pretty: Record<string, string> = {
        OFFBOARD: 'Offboard (AI)', TAKEOFF: 'Taking off', MANUAL: 'Manual',
        ACRO: 'Acro', READY: 'Ready', RATTITUDE: 'Rattitude',
        FOLLOW_ME: 'Follow Me', UNKNOWN: 'Unknown',
    }
    return pretty[reported.toUpperCase()] ?? reported
}

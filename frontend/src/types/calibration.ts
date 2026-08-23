/** Sensor calibration, as the backend sends it.
 *
 *  Sent WHOLE on every change rather than as deltas - a calibration is a few
 *  dozen events over half a minute, so there is nothing to save by diffing,
 *  and a panel rebuilt from a full state cannot drift out of step with the
 *  aircraft the way one accumulating patches can. On this screen that drift
 *  would mean showing a side as finished that the autopilot is still waiting
 *  for, which the operator has no way to detect. */

export type CalSide = 'down' | 'up' | 'left' | 'right' | 'front' | 'back'
export type SideState = 'pending' | 'active' | 'done'
export type CalPhase = 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled'

export interface CalibrationState {
    sensor: string
    label?: string
    phase: CalPhase
    progress?: number
    /** side -> state. Empty for sensors with no orientations (gyro, level). */
    sides: Partial<Record<CalSide, SideState>>
    /** PX4's own order, sent rather than hardcoded here so a change on the
     *  backend cannot silently renumber the instructions on screen. */
    side_order?: CalSide[]
    /** What to do NOW, in words that need no knowledge of PX4. */
    instruction?: string
    /** The autopilot's own last line, kept beside our translation of it so a
     *  wording change the parser missed is still visible rather than hidden. */
    detail?: string
    ok?: boolean | null
    error?: string
    active_side?: CalSide | null
}

/** The sensors the aircraft can be asked to calibrate, and what each one is
 *  for. Order is the order they are offered - gyro first because it is the
 *  quickest and the most often needed, level last because it is a trim rather
 *  than a calibration. */
export const CAL_SENSORS: {
    key: string; label: string; blurb: string; oriented: boolean; mins: string
}[] = [
    {
        key: 'gyro', label: 'Gyroscope', oriented: false, mins: '~10 s',
        blurb: 'Zeroes the rate sensors. Needs the aircraft completely still - nothing to rotate, and touching it during the count is what makes it fail.',
    },
    {
        key: 'accel', label: 'Accelerometer', oriented: true, mins: '~2 min',
        blurb: 'Six positions in turn. This is what tells the autopilot which way gravity points, so a bad one shows up as drift in every mode.',
    },
    {
        key: 'mag', label: 'Compass', oriented: true, mins: '~2 min',
        blurb: 'Rotate the aircraft about each axis PX4 asks for. Do it outdoors and away from metal, cars and reinforced concrete - indoors it will pass and then be wrong.',
    },
    {
        key: 'level', label: 'Level Horizon', oriented: false, mins: '~5 s',
        blurb: 'Sets what "level" means. Do it with the airframe genuinely level, not merely on a flat-looking surface - this is the one that fixes a drone that drifts in a stable hover.',
    },
    {
        key: 'gimbal', label: 'Gimbal Accelerometer', oriented: false, mins: '~15 s',
        blurb: 'Only for a gimbal that reports its own IMU. Harmless to skip if none is fitted - the autopilot will simply refuse it.',
    },
]

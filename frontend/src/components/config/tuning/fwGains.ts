// PX4 fixed-wing controller gains (PX4 1.15-1.17 names), shared by Config >
// Tuning > Fixed-wing and the live chart's gains column when the aircraft
// flies as a plane (fixed-wing or VTOL). Older names are given as `alt`.

import type { ParamSpec } from '@/components/config/kit'
import type { Axis, Loop } from '@/lib/tuningStream'

export type FwCell = { key: string; def: number }
export const FW_RATE: { axis: string; cells: FwCell[] }[] = [
    { axis: 'Roll', cells: [{ key: 'FW_RR_P', def: 0.05 }, { key: 'FW_RR_I', def: 0.1 }, { key: 'FW_RR_D', def: 0 }, { key: 'FW_RR_FF', def: 0.5 }, { key: 'FW_RR_IMAX', def: 0.2 }] },
    { axis: 'Pitch', cells: [{ key: 'FW_PR_P', def: 0.08 }, { key: 'FW_PR_I', def: 0.1 }, { key: 'FW_PR_D', def: 0 }, { key: 'FW_PR_FF', def: 0.5 }, { key: 'FW_PR_IMAX', def: 0.4 }] },
    { axis: 'Yaw', cells: [{ key: 'FW_YR_P', def: 0.05 }, { key: 'FW_YR_I', def: 0.1 }, { key: 'FW_YR_D', def: 0 }, { key: 'FW_YR_FF', def: 0.3 }, { key: 'FW_YR_IMAX', def: 0.2 }] },
]
export const FW_RATE_COLS = ['P', 'I', 'D', 'Feed-forward', 'I limit']

export const FW_ATT: ParamSpec[] = [
    { key: 'FW_R_TC', label: 'Roll time constant', unit: 's', def: 0.4, min: 0.2, max: 1, decimals: 2, tip: 'How quickly the roll angle follows its setpoint. Lower is snappier.' },
    { key: 'FW_P_TC', label: 'Pitch time constant', unit: 's', def: 0.4, min: 0.2, max: 1, decimals: 2, tip: 'How quickly the pitch angle follows its setpoint. Lower is snappier.' },
    { key: 'FW_R_RMAX', label: 'Max roll rate', unit: '°/s', def: 70, min: 0, max: 180, decimals: 0 },
    { key: 'FW_P_RMAX_POS', label: 'Max pitch-up rate', unit: '°/s', def: 60, min: 0, max: 180, decimals: 0 },
    { key: 'FW_P_RMAX_NEG', label: 'Max pitch-down rate', unit: '°/s', def: 60, min: 0, max: 180, decimals: 0 },
    { key: 'FW_Y_RMAX', label: 'Max yaw rate', unit: '°/s', def: 50, min: 0, max: 180, decimals: 0 },
    { key: 'FW_R_LIM', label: 'Max bank angle', unit: '°', def: 50, min: 35, max: 65, decimals: 0, tip: 'Steepest bank in assisted and automatic modes.' },
    { key: 'FW_P_LIM_MAX', label: 'Max pitch up', unit: '°', def: 30, min: 0, max: 60, decimals: 0 },
    { key: 'FW_P_LIM_MIN', label: 'Max pitch down', unit: '°', def: -30, min: -60, max: 0, decimals: 0 },
    { key: 'FW_PSP_OFF', label: 'Pitch trim offset', unit: '°', def: 0, min: -90, max: 90, decimals: 1, tip: 'Pitch angle the aircraft holds to fly level at trim airspeed.' },
]

export const FW_TECS: ParamSpec[] = [
    { key: 'FW_T_CLMB_MAX', label: 'Max climb rate', unit: 'm/s', def: 5, min: 1, max: 15, decimals: 1, tip: 'Fastest climb at trim airspeed and full throttle. Measure it in flight; too high and TECS stalls the climb.' },
    { key: 'FW_T_SINK_MAX', label: 'Max sink rate', unit: 'm/s', def: 5, min: 1, max: 15, decimals: 1, tip: 'Steepest descent TECS will command at trim airspeed.' },
    { key: 'FW_T_SINK_MIN', label: 'Min sink rate', unit: 'm/s', def: 2, min: 1, max: 5, decimals: 1, tip: 'Sink rate at trim airspeed with the throttle at minimum (gliding).' },
    { key: 'FW_T_ALT_TC', label: 'Altitude time constant', unit: 's', def: 5, min: 2, decimals: 1, tip: 'How quickly height errors are corrected. Lower is tighter.' },
    { key: 'FW_T_TAS_TC', label: 'Airspeed time constant', unit: 's', def: 5, min: 2, decimals: 1, tip: 'How quickly airspeed errors are corrected. Lower is tighter.' },
    { key: 'FW_T_THR_DAMPING', alt: ['FW_T_THR_DAMP'], label: 'Throttle damping', def: 0.05, min: 0, max: 1, decimals: 3, tip: 'Raise it if the throttle surges up and down; lower it if speed is slow to settle.' },
    { key: 'FW_T_THR_INTEG', alt: ['FW_T_I_GAIN_THR'], label: 'Throttle integrator', def: 0.02, min: 0, max: 1, decimals: 3 },
    { key: 'FW_T_I_GAIN_PIT', label: 'Pitch integrator', def: 0.1, min: 0, max: 2, decimals: 2 },
    { key: 'FW_T_PTCH_DAMP', label: 'Pitch damping', def: 0.1, min: 0, max: 2, decimals: 2 },
    { key: 'FW_T_SPDWEIGHT', label: 'Speed weight', def: 1, min: 0, max: 2, decimals: 1, tip: '0 = hold height first, 2 = hold airspeed first (gliders), 1 = both equally.' },
    { key: 'FW_T_VERT_ACC', label: 'Max vertical acceleration', unit: 'm/s²', def: 7, min: 1, max: 10, decimals: 1 },
    { key: 'FW_T_RLL2THR', label: 'Bank to throttle', def: 15, min: 0, max: 20, decimals: 1, tip: 'Extra throttle in a turn to make up for the lost lift.' },
    { key: 'FW_T_HRATE_FF', label: 'Climb feed-forward', def: 0.3, min: 0, max: 1, decimals: 2 },
]

export const FW_GUIDANCE: ParamSpec[] = [
    { key: 'NPFG_PERIOD', alt: ['FW_L1_PERIOD'], label: 'Path period', unit: 's', def: 10, min: 1, max: 100, decimals: 1, tip: 'How tightly the aircraft tracks the path. Lower is tighter; too low and it weaves.' },
    { key: 'NPFG_DAMPING', alt: ['FW_L1_DAMPING'], label: 'Path damping', def: 0.7, min: 0.1, max: 1, decimals: 2, tip: 'Damping of path tracking. 0.7 suits most aircraft.' },
    { key: 'NPFG_ROLL_TC', label: 'Roll time constant', unit: 's', def: 0.5, min: 0, max: 3, decimals: 2, tip: 'How quickly guidance expects the roll to follow. Match it to the roll loop.' },
    { key: 'NPFG_SW_DST_MLT', label: 'Waypoint switch distance', def: 0.32, min: 0, max: 1, decimals: 2, tip: 'How early the aircraft turns toward the next waypoint, as a fraction of the turn distance.' },
    { key: 'NAV_LOITER_RAD', label: 'Loiter radius', unit: 'm', def: 80, min: -10000, max: 10000, decimals: 0, tip: 'Default orbit radius. Negative orbits anti-clockwise.' },
]

export const FW_SPEED: ParamSpec[] = [
    { key: 'FW_AIRSPD_STALL', label: 'Stall airspeed', unit: 'm/s', def: 7, min: 0.5, max: 40, decimals: 1, tip: 'The speed the wing stops flying at. Must be below minimum.' },
    { key: 'FW_AIRSPD_MIN', label: 'Minimum airspeed', unit: 'm/s', def: 10, min: 0.5, max: 40, decimals: 1 },
    { key: 'FW_AIRSPD_TRIM', label: 'Cruise airspeed', unit: 'm/s', def: 15, min: 0.5, max: 40, decimals: 1, tip: 'The default airspeed setpoint (trim).' },
    { key: 'FW_AIRSPD_MAX', label: 'Maximum airspeed', unit: 'm/s', def: 20, min: 0.5, max: 40, decimals: 1 },
    { key: 'FW_USE_AIRSPD', label: 'Use the airspeed sensor', def: 1, options: [{ value: 0, label: 'No' }, { value: 1, label: 'Yes' }], tip: 'Without an airspeed sensor (or with it off) PX4 flies on throttle trim and groundspeed.' },
    // PX4 1.15 and older: the same switch, the other way round.
    { key: 'FW_ARSP_MODE', label: 'Use the airspeed sensor', def: 0, options: [{ value: 0, label: 'Yes' }, { value: 1, label: 'No' }], tip: 'Without an airspeed sensor (or with it off) PX4 flies on throttle trim and groundspeed.' },
]

export const FW_THROTTLE: ParamSpec[] = [
    { key: 'FW_THR_TRIM', label: 'Cruise throttle', unit: '%', scale: 100, def: 0.6, min: 0, max: 100, decimals: 0, tip: 'Throttle needed to fly level at cruise airspeed.' },
    { key: 'FW_THR_MIN', label: 'Minimum throttle', unit: '%', scale: 100, def: 0, min: 0, max: 100, decimals: 0 },
    { key: 'FW_THR_MAX', label: 'Maximum throttle', unit: '%', scale: 100, def: 1, min: 0, max: 100, decimals: 0 },
    { key: 'FW_THR_IDLE', label: 'Idle throttle', unit: '%', scale: 100, def: 0, min: 0, max: 40, decimals: 0, tip: 'Throttle while armed and gliding. Keeps a pusher turning on some ESCs.' },
    { key: 'FW_THR_SLEW_MAX', label: 'Throttle slew limit', unit: '/s', def: 0, min: 0, max: 1, decimals: 2, tip: 'Fastest throttle change per second. 0 = no limit.' },
]

const pick = (list: ParamSpec[], ...keys: string[]) => keys.map(k => list.find(s => s.key === k)!).filter(Boolean)

/** Fixed-wing gains for one loop and axis, for the live chart's gains
 *  column. Velocity and position have no fixed-wing equivalent here. */
export function fwGainsFor(loop: Loop, axis: Axis): ParamSpec[] {
    if (loop === 'rate') {
        return FW_RATE[axis].cells.map((c, i) => ({ key: c.key, label: `FW ${FW_RATE_COLS[i]}`, def: c.def, min: 0, max: 10, decimals: 3 }))
    }
    if (loop === 'attitude') {
        return [
            pick(FW_ATT, 'FW_R_TC', 'FW_R_RMAX'),
            pick(FW_ATT, 'FW_P_TC', 'FW_P_RMAX_POS', 'FW_P_RMAX_NEG'),
            pick(FW_ATT, 'FW_Y_RMAX'),
        ][axis]
    }
    return []
}

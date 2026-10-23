// PX4 multicopter controller gains, shared by Config > Tuning's gain tables
// and the live chart's "gains for this loop" column.

import type { ParamSpec } from '@/components/config/kit'
import type { Axis, Loop } from '@/lib/tuningStream'

export type Cell = { key: string; def: number }
export const RATE: { axis: string; cells: Cell[] }[] = [
    { axis: 'Roll', cells: [{ key: 'MC_ROLLRATE_K', def: 1 }, { key: 'MC_ROLLRATE_P', def: 0.15 }, { key: 'MC_ROLLRATE_I', def: 0.2 }, { key: 'MC_ROLLRATE_D', def: 0.003 }, { key: 'MC_ROLLRATE_FF', def: 0 }] },
    { axis: 'Pitch', cells: [{ key: 'MC_PITCHRATE_K', def: 1 }, { key: 'MC_PITCHRATE_P', def: 0.15 }, { key: 'MC_PITCHRATE_I', def: 0.2 }, { key: 'MC_PITCHRATE_D', def: 0.003 }, { key: 'MC_PITCHRATE_FF', def: 0 }] },
    { axis: 'Yaw', cells: [{ key: 'MC_YAWRATE_K', def: 1 }, { key: 'MC_YAWRATE_P', def: 0.2 }, { key: 'MC_YAWRATE_I', def: 0.1 }, { key: 'MC_YAWRATE_D', def: 0 }, { key: 'MC_YAWRATE_FF', def: 0 }] },
]
export const RATE_COLS = ['Gain K', 'P', 'I', 'D', 'Feed-forward']

export const ATT: ParamSpec[] = [
    { key: 'MC_ROLL_P', label: 'Roll angle gain', def: 6.5, min: 0, max: 12, decimals: 2 },
    { key: 'MC_PITCH_P', label: 'Pitch angle gain', def: 6.5, min: 0, max: 12, decimals: 2 },
    { key: 'MC_YAW_P', label: 'Yaw angle gain', def: 2.8, min: 0, max: 5, decimals: 2 },
    { key: 'MC_YAW_WEIGHT', label: 'Yaw weight', def: 0.4, min: 0, max: 1, decimals: 2, tip: 'How much yaw error counts against roll and pitch error.' },
    { key: 'MC_ROLLRATE_MAX', label: 'Max roll rate', unit: '°/s', def: 220, min: 0, max: 1800, decimals: 0 },
    { key: 'MC_PITCHRATE_MAX', label: 'Max pitch rate', unit: '°/s', def: 220, min: 0, max: 1800, decimals: 0 },
    { key: 'MC_YAWRATE_MAX', label: 'Max yaw rate', unit: '°/s', def: 200, min: 0, max: 1800, decimals: 0 },
]
export const VEL: ParamSpec[] = [
    { key: 'MPC_XY_VEL_P_ACC', label: 'Horizontal P', def: 1.8, min: 1.2, max: 5, decimals: 2 },
    { key: 'MPC_XY_VEL_I_ACC', label: 'Horizontal I', def: 0.4, min: 0, max: 60, decimals: 2 },
    { key: 'MPC_XY_VEL_D_ACC', label: 'Horizontal D', def: 0.2, min: 0.1, max: 2, decimals: 2 },
    { key: 'MPC_Z_VEL_P_ACC', label: 'Vertical P', def: 4, min: 2, max: 15, decimals: 2 },
    { key: 'MPC_Z_VEL_I_ACC', label: 'Vertical I', def: 2, min: 0.2, max: 3, decimals: 2 },
    { key: 'MPC_Z_VEL_D_ACC', label: 'Vertical D', def: 0, min: 0, max: 2, decimals: 2 },
]
export const POS: ParamSpec[] = [
    { key: 'MPC_XY_P', label: 'Horizontal position gain', def: 0.95, min: 0, max: 2, decimals: 2 },
    { key: 'MPC_Z_P', label: 'Vertical position gain', def: 1, min: 0.1, max: 1.5, decimals: 2 },
]

const by = (list: ParamSpec[], ...keys: string[]) => keys.map(k => list.find(s => s.key === k)!).filter(Boolean)

/** The gains that shape one loop on one axis, for editing beside the chart. */
export function gainsFor(loop: Loop, axis: Axis): ParamSpec[] {
    if (loop === 'rate') {
        return RATE[axis].cells.map((c, i) => ({
            key: c.key, label: RATE_COLS[i], def: c.def, min: 0,
            max: c.key.endsWith('_K') ? 5 : 2, decimals: c.key.endsWith('_D') ? 4 : 3,
        }))
    }
    if (loop === 'attitude') {
        return [
            by(ATT, 'MC_ROLL_P', 'MC_ROLLRATE_MAX'),
            by(ATT, 'MC_PITCH_P', 'MC_PITCHRATE_MAX'),
            by(ATT, 'MC_YAW_P', 'MC_YAW_WEIGHT', 'MC_YAWRATE_MAX'),
        ][axis]
    }
    if (loop === 'velocity') return axis === 2 ? VEL.slice(3) : VEL.slice(0, 3)
    return axis === 2 ? by(POS, 'MPC_Z_P') : by(POS, 'MPC_XY_P')
}

/** One line of advice for reading the chart of this loop. */
export const LOOP_ADVICE: Record<Loop, string> = {
    rate: 'Overshoot or ringing after a stick flick: lower P or raise D a little. Slow, soft follow: raise P. A slow drift to the target: raise I.',
    attitude: 'Angle lags the setpoint: raise the angle gain. Overshoots and bounces: lower it, or tune the rate loop first.',
    velocity: 'Speed overshoots when you let go of the stick: lower P or raise D. Never quite reaches the setpoint: raise I.',
    position: 'Overshoots the hold point: lower the position gain. Wanders slowly back: raise it.',
}

// PX4 1.14+ control allocation and output metadata used by Config > Actuators.

export const AIRFRAME_OPTS = [
    { value: 0, label: 'Multirotor' },
    { value: 1, label: 'Fixed-wing' },
    { value: 2, label: 'Standard VTOL' },
    { value: 3, label: 'Tiltrotor VTOL' },
    { value: 4, label: 'Tailsitter VTOL' },
    { value: 5, label: 'Rover (Ackermann)' },
    { value: 6, label: 'Rover (differential)' },
    { value: 7, label: 'Motors (6 DOF)' },
    { value: 8, label: 'Multirotor with tilt' },
    { value: 9, label: 'Custom' },
    { value: 10, label: 'Helicopter (tail ESC)' },
    { value: 11, label: 'Helicopter (tail servo)' },
    { value: 12, label: 'Helicopter (coaxial)' },
]

/** Airframes whose geometry is a list of rotors at positions. */
export const ROTOR_AIRFRAMES = new Set([0, 2, 3, 4, 7, 8, 9])
/** Airframes with control surfaces. */
export const SURFACE_AIRFRAMES = new Set([1, 2, 3, 4, 9])

export const SURFACE_TYPE_OPTS = [
    { value: 0, label: 'Not set' },
    { value: 1, label: 'Left aileron' }, { value: 2, label: 'Right aileron' },
    { value: 3, label: 'Elevator' }, { value: 4, label: 'Rudder' },
    { value: 5, label: 'Left elevon' }, { value: 6, label: 'Right elevon' },
    { value: 7, label: 'Left V-tail' }, { value: 8, label: 'Right V-tail' },
    { value: 9, label: 'Left flap' }, { value: 10, label: 'Right flap' },
    { value: 11, label: 'Airbrake' }, { value: 12, label: 'Custom' },
    { value: 13, label: 'Left A-tail' }, { value: 14, label: 'Right A-tail' },
    { value: 15, label: 'Single channel aileron' }, { value: 16, label: 'Steering wheel' },
    { value: 17, label: 'Left spoiler' }, { value: 18, label: 'Right spoiler' },
]

/** PX4 output functions (PWM_MAIN_FUNCn and friends). */
export function functionOptions(motors = 12, servos = 8) {
    return [
        { value: 0, label: 'Disabled' },
        { value: 1, label: 'Constant min' },
        { value: 2, label: 'Constant max' },
        ...Array.from({ length: motors }, (_, i) => ({ value: 101 + i, label: `Motor ${i + 1}` })),
        ...Array.from({ length: servos }, (_, i) => ({ value: 201 + i, label: `Servo ${i + 1}` })),
        ...Array.from({ length: 6 }, (_, i) => ({ value: 301 + i, label: `Offboard actuator ${i + 1}` })),
        { value: 400, label: 'Landing gear' },
        { value: 401, label: 'Parachute' },
        { value: 402, label: 'RC roll' }, { value: 403, label: 'RC pitch' }, { value: 404, label: 'RC throttle' },
        { value: 405, label: 'RC yaw' }, { value: 406, label: 'RC flaps' },
        ...Array.from({ length: 6 }, (_, i) => ({ value: 407 + i, label: `RC AUX ${i + 1}` })),
        { value: 420, label: 'Gimbal roll' }, { value: 421, label: 'Gimbal pitch' }, { value: 422, label: 'Gimbal yaw' },
        { value: 430, label: 'Gripper' },
        { value: 440, label: 'Landing gear wheel' },
        { value: 2000, label: 'Camera trigger' },
        { value: 2032, label: 'Camera capture' },
        { value: 2064, label: 'PPS input' },
        { value: 2070, label: 'RPM input' },
    ]
}

export function functionLabel(v: number): string {
    if (v >= 101 && v <= 112) return `Motor ${v - 100}`
    if (v >= 201 && v <= 208) return `Servo ${v - 200}`
    return functionOptions().find(o => o.value === v)?.label ?? `Function ${v}`
}

export const isMotorFn = (v: number) => v >= 101 && v <= 112
export const isServoFn = (v: number) => v >= 201 && v <= 208

/** Output buses PX4 exposes as <PREFIX>_FUNCn parameters. */
export interface Bus { id: string; label: string; prefix: string; timers?: string; hint?: string }
export const BUSES: Bus[] = [
    { id: 'main', label: 'PWM MAIN', prefix: 'PWM_MAIN', timers: 'PWM_MAIN_TIM', hint: 'IO board or main outputs. Set a timer group to DShot for digital ESCs.' },
    { id: 'aux', label: 'PWM AUX', prefix: 'PWM_AUX', timers: 'PWM_AUX_TIM', hint: 'FMU outputs on boards with an IO co-processor.' },
    { id: 'uavcan', label: 'UAVCAN ESC', prefix: 'UAVCAN_EC', hint: 'DroneCAN ESCs. Needs UAVCAN_ENABLE set to 3.' },
    { id: 'uavcansv', label: 'UAVCAN servo', prefix: 'UAVCAN_SV' },
    { id: 'simgz', label: 'SITL ESC', prefix: 'SIM_GZ_EC', hint: 'Gazebo simulator motors.' },
    { id: 'simgzsv', label: 'SITL servo', prefix: 'SIM_GZ_SV', hint: 'Gazebo simulator servos.' },
    { id: 'hil', label: 'HITL / SIH', prefix: 'HIL_ACT' },
    { id: 'pca', label: 'PCA9685', prefix: 'PCA9685' },
    { id: 'voxl', label: 'VOXL2 IO', prefix: 'VOXL2_IO' },
    { id: 'tap', label: 'TAP ESC', prefix: 'TAP_ESC' },
]

/** Timer group rates (PWM_MAIN_TIMn). Negative = digital protocols. */
export const TIMER_OPTS = [
    { value: -5, label: 'DShot150' },
    { value: -4, label: 'DShot300' },
    { value: -3, label: 'DShot600' },
    { value: -2, label: 'DShot1200' },
    { value: -1, label: 'OneShot125' },
    { value: 50, label: 'PWM 50 Hz' },
    { value: 100, label: 'PWM 100 Hz' },
    { value: 200, label: 'PWM 200 Hz' },
    { value: 400, label: 'PWM 400 Hz' },
]
export const isDshotRate = (v: number | null) => v != null && v <= -2

/** PX4's generic quad X, shown when no drone is connected. */
export const DEMO_ROTORS = [
    { px: 0.25, py: 0.25, pz: 0, km: 0.05 },
    { px: -0.25, py: -0.25, pz: 0, km: 0.05 },
    { px: 0.25, py: -0.25, pz: 0, km: -0.05 },
    { px: -0.25, py: 0.25, pz: 0, km: -0.05 },
]

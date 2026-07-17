// PX4 parameter metadata — enriches raw param names/values from the drone
// with plain-English descriptions, units, min/max and grouping.
// Source: PX4 firmware parameter metadata (public domain)
// Params not in this file will still appear in the browser — just without
// descriptions or unit labels.

export type PX4Group =
  | 'Commander'
  | 'EKF2'
  | 'Multicopter Rate'
  | 'Position Control'
  | 'Navigation'
  | 'Return to Launch'
  | 'Battery'
  | 'Geofence'
  | 'Mission'
  | 'System'
  | 'MAVLink'
  | 'PWM / ESC'
  | 'Motors'
  | 'Control Allocator'
  | 'Logging'
  | 'Circuit Breakers'
  | 'Sensors'
  | 'RC Channels'
  | 'Land Detector'
  | 'VTOL'
  | 'Failure Detector'
  | 'Attitude Estimator'
  | 'Other'

export interface PX4Meta {
  name: string        // human-readable label
  group: PX4Group
  desc: string        // plain-English description
  unit?: string
  min?: number
  max?: number
  step?: number
  opts?: Record<number, string>   // enum option labels
  danger?: boolean                // show warning when editing
  expert?: boolean                // hide in beginner mode
}

export const PX4_META: Record<string, PX4Meta> = {

  // ── COMMANDER ────────────────────────────────────────────────────────────
  COM_ARM_WO_GPS: {
    name: 'Arm Without GPS',
    group: 'Commander',
    desc: 'Allow arming when no GPS fix is available. Only use indoors or if GPS is not needed — very dangerous outdoors.',
    opts: { 0: 'Require GPS fix', 1: 'Allow without GPS' },
    danger: true,
  },
  COM_ARM_EKF_POS: {
    name: 'EKF Position Arming Check',
    group: 'Commander',
    desc: 'Block arming if the EKF position estimate quality is below threshold. Strongly recommended to leave enabled.',
    min: 0, max: 1,
  },
  COM_ARM_EKF_VEL: {
    name: 'EKF Velocity Arming Check',
    group: 'Commander',
    desc: 'Block arming if the EKF velocity estimate quality is too poor.',
    min: 0, max: 1,
  },
  COM_ARM_EKF_HGT: {
    name: 'EKF Height Arming Check',
    group: 'Commander',
    desc: 'Block arming if the EKF height estimate quality is too poor.',
    min: 0, max: 1,
  },
  COM_ARM_EKF_YAW: {
    name: 'EKF Yaw Arming Check',
    group: 'Commander',
    desc: 'Block arming if the EKF yaw (heading) estimate quality is too poor.',
    min: 0, max: 1,
  },
  COM_ARM_IMU_ACC: {
    name: 'IMU Accel Arming Check',
    group: 'Commander',
    desc: 'Maximum allowed IMU accelerometer inconsistency before arming is blocked. Lower = stricter check.',
    unit: 'm/s²', min: 0.1, max: 1.0, step: 0.05,
  },
  COM_ARM_IMU_GYR: {
    name: 'IMU Gyro Arming Check',
    group: 'Commander',
    desc: 'Maximum allowed gyro inconsistency between redundant IMUs. Lower = stricter.',
    unit: 'rad/s', min: 0.02, max: 0.3, step: 0.01,
  },
  COM_ARM_MAG_ANG: {
    name: 'Compass Angle Arming Check',
    group: 'Commander',
    desc: 'Maximum angle difference between compass and EKF yaw estimate before arming is blocked. -1 = disabled.',
    unit: '°', min: -1, max: 90, step: 1,
  },
  COM_DISARM_LAND: {
    name: 'Auto-Disarm After Landing',
    group: 'Commander',
    desc: 'Seconds after landing detection before motors automatically disarm. 0 = never auto-disarm.',
    unit: 's', min: 0, max: 20, step: 0.5,
  },
  COM_DISARM_PRFLT: {
    name: 'Pre-Flight Disarm Timeout',
    group: 'Commander',
    desc: 'If armed but no takeoff detected within this many seconds, automatically disarm. -1 = disabled.',
    unit: 's', min: -1, max: 100, step: 1,
  },
  COM_RC_LOSS_T: {
    name: 'RC Signal Loss Timeout',
    group: 'Commander',
    desc: 'Seconds after RC signal drops before the RC loss failsafe activates.',
    unit: 's', min: 0, max: 35, step: 0.1,
  },
  COM_RC_IN_MODE: {
    name: 'RC Input Mode',
    group: 'Commander',
    desc: 'Whether RC input is required, optional, or disabled.',
    opts: { 0: 'RC required', 1: 'RC optional (joystick allowed)', 2: 'RC disabled', 3: 'Stick input disabled', 4: 'RC and joystick disabled' },
  },
  COM_RC_OVERRIDE: {
    name: 'RC Override in Auto Modes',
    group: 'Commander',
    desc: 'Bitmask controlling which autonomous modes can be overridden by moving the RC sticks.',
    min: 0, max: 3, expert: true,
  },
  COM_RC_STICK_OV: {
    name: 'RC Override Stick Threshold',
    group: 'Commander',
    desc: 'How far you must push the sticks (as a fraction 0–1) to trigger an RC override.',
    min: 0.05, max: 0.5, step: 0.01,
  },
  COM_RCL_EXCEPT: {
    name: 'Disable RC Loss in Mission',
    group: 'Commander',
    desc: 'If set, RC loss failsafe will not trigger during an autonomous mission. Useful for long-range missions with deliberate RC off.',
    opts: { 0: 'RC loss always triggers', 1: 'Disable during mission' },
  },
  COM_DL_LOSS_T: {
    name: 'Data Link Loss Timeout',
    group: 'Commander',
    desc: 'Seconds after GCS telemetry link drops before the data-link loss failsafe triggers.',
    unit: 's', min: 5, max: 300, step: 1,
  },
  COM_OBL_ACT: {
    name: 'Offboard Link Loss Action',
    group: 'Commander',
    desc: 'What the drone does if the offboard control link is lost while in Offboard mode.',
    opts: { '-1': 'Land', 0: 'Hold position', 1: 'Return to Launch', 2: 'Land', 3: 'Terminate', 4: 'Lockdown' },
    danger: true,
  },
  COM_OBL_RCACT: {
    name: 'RC Action on Offboard Loss',
    group: 'Commander',
    desc: 'What the drone does if RC becomes available after losing the offboard link.',
    opts: { 0: 'Position mode', 1: 'Altitude mode', 2: 'Manual mode', 3: 'Return to Launch', 4: 'Land' },
  },
  COM_LOW_BAT_ACT: {
    name: 'Low Battery Action',
    group: 'Commander',
    desc: 'Sequence of automatic actions as the battery drains through warning and critical thresholds.',
    opts: { 0: 'Warning only', 1: 'RTL at warning', 2: 'RTL at critical', 3: 'RTL at warning, land at critical' },
  },
  COM_TAKEOFF_ACT: {
    name: 'Post-Takeoff Behaviour',
    group: 'Commander',
    desc: 'What the drone does when an automated takeoff command completes.',
    opts: { 0: 'Loiter in place', 1: 'Start mission' },
  },
  COM_HOME_H_T: {
    name: 'Home Detection Radius',
    group: 'Commander',
    desc: 'Horizontal radius within which the drone is considered back at the home position.',
    unit: 'm', min: 2, max: 15, step: 0.5,
  },
  COM_HOME_V_T: {
    name: 'Home Detection Altitude Band',
    group: 'Commander',
    desc: 'Vertical band around the home altitude within which the drone is considered at home height.',
    unit: 'm', min: 1, max: 10, step: 0.5,
  },
  COM_HOME_IN_AIR: {
    name: 'Set Home While Airborne',
    group: 'Commander',
    desc: 'Allow the home position to be updated while the drone is flying.',
    opts: { 0: 'Home only set on ground', 1: 'Allow home update in air' },
  },
  COM_KILL_DISARM: {
    name: 'Kill Switch Disarms',
    group: 'Commander',
    desc: 'Whether the kill switch immediately disarms (cuts motors) or only terminates.',
    opts: { 0: 'Terminates flight', 1: 'Disarms motors' },
    danger: true,
  },
  COM_POSCTL_NAVL: {
    name: 'Position Mode on Nav Loss',
    group: 'Commander',
    desc: 'What Position mode does if navigation (GPS/EKF) is lost mid-flight.',
    opts: { 0: 'Altitude mode fallback', 1: 'Land immediately' },
    danger: true,
  },
  COM_OF_LOSS_T: {
    name: 'Optical Flow Loss Timeout',
    group: 'Commander',
    desc: 'Seconds after optical flow data disappears before a position failsafe is triggered.',
    unit: 's', min: 0.1, max: 5, step: 0.1,
  },
  COM_IMB_PROP_ACT: {
    name: 'Imbalanced Propeller Action',
    group: 'Commander',
    desc: 'Action taken if a motor imbalance (likely broken prop) is detected in flight.',
    opts: { '-1': 'Disabled', 0: 'Warning only', 1: 'RTL', 2: 'Land' },
  },

  // ── EKF2 ─────────────────────────────────────────────────────────────────
  EKF2_AID_MASK: {
    name: 'Sensor Fusion Flags',
    group: 'EKF2',
    desc: 'Bitmask of which sensors the EKF fuses for position and velocity: bit 0=GPS, bit 1=optical flow, bit 2=vision pose, bit 3=vision yaw, bit 4=external vision height, bit 5=mag heading, bit 7=GNSS yaw.',
    min: 0, max: 511, expert: true, danger: true,
  },
  EKF2_HGT_MODE: {
    name: 'Primary Height Source',
    group: 'EKF2',
    desc: 'Which sensor the EKF uses as the primary reference for altitude estimation.',
    opts: { 0: 'Barometer', 1: 'GPS', 2: 'Range finder', 3: 'Vision pose' },
    expert: true,
  },
  EKF2_MAG_TYPE: {
    name: 'Compass Fusion Mode',
    group: 'EKF2',
    desc: 'How the magnetometer is incorporated into the EKF attitude/heading estimate.',
    opts: { 0: 'Automatic', 1: 'Full 3D', 2: 'Heading only', 3: 'None — disabled', 4: 'Indoor (no declination)' },
    expert: true,
  },
  EKF2_BARO_NOISE: {
    name: 'Barometer Noise Level',
    group: 'EKF2',
    desc: 'Expected noise in the barometer reading. Higher = EKF trusts baro less and relies more on GPS height.',
    unit: 'm', min: 0.01, max: 15, step: 0.1, expert: true,
  },
  EKF2_GPS_DELAY: {
    name: 'GPS Measurement Latency',
    group: 'EKF2',
    desc: 'Time from when the GPS samples to when the EKF receives the data. Match to your GPS unit spec sheet.',
    unit: 'ms', min: 0, max: 300, step: 1, expert: true,
  },
  EKF2_GPS_CHECK: {
    name: 'GPS Pre-flight Quality Checks',
    group: 'EKF2',
    desc: 'Bitmask of GPS quality requirements that must pass before arming is allowed.',
    min: 0, max: 511, expert: true,
  },
  EKF2_GPS_V_NOISE: {
    name: 'GPS Velocity Noise',
    group: 'EKF2',
    desc: 'Assumed noise in GPS velocity measurements. Increase if your GPS is noisy.',
    unit: 'm/s', min: 0.01, max: 0.5, step: 0.01, expert: true,
  },
  EKF2_GPS_P_NOISE: {
    name: 'GPS Position Noise',
    group: 'EKF2',
    desc: 'Assumed noise in GPS position measurements.',
    unit: 'm', min: 0.01, max: 10, step: 0.1, expert: true,
  },
  EKF2_MAG_DECL: {
    name: 'Magnetic Declination Override',
    group: 'EKF2',
    desc: 'Manually set magnetic declination. Leave at 0 and enable auto-declination unless you have a reason to override.',
    unit: '°', min: -90, max: 90, step: 0.1, expert: true,
  },
  EKF2_MAG_DECL_A: {
    name: 'Auto Magnetic Declination',
    group: 'EKF2',
    desc: 'Let the EKF automatically determine magnetic declination from the GPS location.',
    opts: { 0: 'Disabled', 1: 'Enabled (recommended)' },
    expert: true,
  },
  EKF2_MAG_NOISE: {
    name: 'Compass Noise Level',
    group: 'EKF2',
    desc: 'Expected noise in the magnetometer. Increase if the compass is near interference sources.',
    unit: 'Gauss', min: 0.0001, max: 1.0, step: 0.0001, expert: true,
  },
  EKF2_RNG_AID: {
    name: 'Range Finder for Height',
    group: 'EKF2',
    desc: 'Use range finder (lidar/sonar) as a secondary height source when close to the ground.',
    opts: { 0: 'Disabled', 1: 'Enabled as secondary' },
    expert: true,
  },
  EKF2_EV_DELAY: {
    name: 'Vision Pose Latency',
    group: 'EKF2',
    desc: 'Delay between external vision system measurement and EKF receipt. Tune for your vision pipeline.',
    unit: 'ms', min: 0, max: 300, step: 1, expert: true,
  },
  EKF2_OF_DELAY: {
    name: 'Optical Flow Latency',
    group: 'EKF2',
    desc: 'Delay between optical flow sensor measurement and EKF receipt.',
    unit: 'ms', min: 0, max: 300, step: 1, expert: true,
  },
  EKF2_ABIAS_INIT: {
    name: 'Accel Bias Initial Uncertainty',
    group: 'EKF2',
    desc: 'Initial uncertainty for accelerometer bias estimate in the EKF. Smaller = more aggressive bias correction at startup.',
    unit: 'm/s²', min: 0.0001, max: 0.5, step: 0.001, expert: true,
  },
  EKF2_GBIAS_INIT: {
    name: 'Gyro Bias Initial Uncertainty',
    group: 'EKF2',
    desc: 'Initial uncertainty for gyroscope bias estimate.',
    unit: 'rad/s', min: 0.0001, max: 0.1, step: 0.001, expert: true,
  },

  // ── MULTICOPTER RATE (PIDs) ────────────────────────────────────────────
  MC_ROLL_P: {
    name: 'Roll Angle P Gain',
    group: 'Multicopter Rate',
    desc: 'How aggressively the FC corrects roll angle errors. Too high → oscillation; too low → sluggish.',
    min: 1, max: 12, step: 0.1, expert: true, danger: true,
  },
  MC_PITCH_P: {
    name: 'Pitch Angle P Gain',
    group: 'Multicopter Rate',
    desc: 'How aggressively the FC corrects pitch angle errors. Match roll P on symmetric quads.',
    min: 1, max: 12, step: 0.1, expert: true, danger: true,
  },
  MC_YAW_P: {
    name: 'Yaw Angle P Gain',
    group: 'Multicopter Rate',
    desc: 'Yaw heading correction strength. Lower than roll/pitch is normal — yaw authority is weaker.',
    min: 0.5, max: 5, step: 0.1, expert: true,
  },
  MC_ROLLRATE_P: {
    name: 'Roll Rate P',
    group: 'Multicopter Rate',
    desc: 'Proportional gain for roll rate controller. Increase for sharper roll response. Oscillation = too high.',
    min: 0.01, max: 0.5, step: 0.005, expert: true, danger: true,
  },
  MC_ROLLRATE_I: {
    name: 'Roll Rate I',
    group: 'Multicopter Rate',
    desc: 'Integral gain eliminates steady-state roll error that P alone cannot fix.',
    min: 0, max: 0.5, step: 0.005, expert: true,
  },
  MC_ROLLRATE_D: {
    name: 'Roll Rate D',
    group: 'Multicopter Rate',
    desc: 'Derivative gain damps overshoot. Too high → high-frequency buzz; too low → ringing.',
    min: 0, max: 0.05, step: 0.001, expert: true, danger: true,
  },
  MC_ROLLRATE_FF: {
    name: 'Roll Rate Feedforward',
    group: 'Multicopter Rate',
    desc: 'Feedforward term added directly to roll output. Improves tracking of rapid roll commands.',
    min: 0, max: 0.5, step: 0.01, expert: true,
  },
  MC_PITCHRATE_P: {
    name: 'Pitch Rate P',
    group: 'Multicopter Rate',
    desc: 'Proportional gain for pitch rate controller.',
    min: 0.01, max: 0.5, step: 0.005, expert: true, danger: true,
  },
  MC_PITCHRATE_I: {
    name: 'Pitch Rate I',
    group: 'Multicopter Rate',
    desc: 'Integral gain for pitch rate — eliminates steady-state pitch error.',
    min: 0, max: 0.5, step: 0.005, expert: true,
  },
  MC_PITCHRATE_D: {
    name: 'Pitch Rate D',
    group: 'Multicopter Rate',
    desc: 'Derivative gain for pitch rate — damps oscillations.',
    min: 0, max: 0.05, step: 0.001, expert: true, danger: true,
  },
  MC_PITCHRATE_FF: {
    name: 'Pitch Rate Feedforward',
    group: 'Multicopter Rate',
    desc: 'Feedforward term for pitch rate — improves command tracking.',
    min: 0, max: 0.5, step: 0.01, expert: true,
  },
  MC_YAWRATE_P: {
    name: 'Yaw Rate P',
    group: 'Multicopter Rate',
    desc: 'Proportional gain for yaw rate controller.',
    min: 0, max: 0.6, step: 0.01, expert: true,
  },
  MC_YAWRATE_I: {
    name: 'Yaw Rate I',
    group: 'Multicopter Rate',
    desc: 'Integral gain for yaw rate — corrects steady yaw drift.',
    min: 0, max: 0.5, step: 0.01, expert: true,
  },
  MC_YAWRATE_D: {
    name: 'Yaw Rate D',
    group: 'Multicopter Rate',
    desc: 'Derivative gain for yaw rate.',
    min: 0, max: 0.05, step: 0.001, expert: true,
  },
  MC_YAWRATE_FF: {
    name: 'Yaw Rate Feedforward',
    group: 'Multicopter Rate',
    desc: 'Feedforward for yaw rate.',
    min: 0, max: 0.5, step: 0.01, expert: true,
  },
  MC_ROLLRATE_MAX: {
    name: 'Max Roll Rate',
    group: 'Multicopter Rate',
    desc: 'Maximum roll angular rate. Higher = more agile; lower = safer for cameras.',
    unit: '°/s', min: 0, max: 1800, step: 5,
  },
  MC_PITCHRATE_MAX: {
    name: 'Max Pitch Rate',
    group: 'Multicopter Rate',
    desc: 'Maximum pitch angular rate.',
    unit: '°/s', min: 0, max: 1800, step: 5,
  },
  MC_YAWRATE_MAX: {
    name: 'Max Yaw Rate',
    group: 'Multicopter Rate',
    desc: 'Maximum yaw angular rate.',
    unit: '°/s', min: 0, max: 1800, step: 5,
  },
  MC_AIRMODE: {
    name: 'Airmode',
    group: 'Multicopter Rate',
    desc: 'Airmode keeps motors above idle at low throttle to maintain attitude control authority. Good for acro; can cause unexpected motion on ground.',
    opts: { 0: 'Disabled', 1: 'Roll/Pitch', 2: 'Roll/Pitch/Yaw' },
    expert: true,
  },
  MC_YAW_WEIGHT: {
    name: 'Yaw Control Weight',
    group: 'Multicopter Rate',
    desc: 'Relative weight of yaw control vs roll/pitch when motor saturation occurs.',
    min: 0, max: 1, step: 0.05, expert: true,
  },

  // ── POSITION CONTROL ──────────────────────────────────────────────────
  MPC_XY_VEL_MAX: {
    name: 'Max Horizontal Speed',
    group: 'Position Control',
    desc: 'Fastest the drone moves horizontally in Position and Mission modes.',
    unit: 'm/s', min: 0.5, max: 25, step: 0.5,
  },
  MPC_Z_VEL_MAX_UP: {
    name: 'Max Climb Rate',
    group: 'Position Control',
    desc: 'Maximum ascent speed. Lower for smoother camera flights.',
    unit: 'm/s', min: 0.5, max: 8, step: 0.25,
  },
  MPC_Z_VEL_MAX_DN: {
    name: 'Max Descent Rate',
    group: 'Position Control',
    desc: 'Maximum descent speed. Too fast risks propwash instability.',
    unit: 'm/s', min: 0.2, max: 4, step: 0.1,
  },
  MPC_XY_CRUISE: {
    name: 'Mission Cruise Speed',
    group: 'Position Control',
    desc: 'Target forward speed during autonomous waypoint missions.',
    unit: 'm/s', min: 1, max: 20, step: 0.5,
  },
  MPC_TILTMAX_AIR: {
    name: 'Max Tilt Angle in Air',
    group: 'Position Control',
    desc: 'Maximum lean angle during flight. Higher = faster flight but less stability margin.',
    unit: '°', min: 5, max: 85, step: 1,
  },
  MPC_TILTMAX_LND: {
    name: 'Max Tilt During Landing',
    group: 'Position Control',
    desc: 'Maximum lean angle allowed when landing. Smaller = more cautious landing.',
    unit: '°', min: 5, max: 25, step: 1,
  },
  MPC_LAND_SPEED: {
    name: 'Auto-Land Descent Speed',
    group: 'Position Control',
    desc: 'Descent rate during the final automated landing phase. Keep low for gentle touchdowns.',
    unit: 'm/s', min: 0.1, max: 2, step: 0.05,
  },
  MPC_LAND_ALT1: {
    name: 'Landing Slowdown Altitude 1',
    group: 'Position Control',
    desc: 'Altitude above ground at which the drone starts slowing from cruise to landing speed.',
    unit: 'm', min: 0, max: 30, step: 0.5,
  },
  MPC_LAND_ALT2: {
    name: 'Landing Slowdown Altitude 2',
    group: 'Position Control',
    desc: 'Altitude above ground at which the drone reaches the minimum landing descent speed.',
    unit: 'm', min: 0, max: 10, step: 0.25,
  },
  MPC_TKO_SPEED: {
    name: 'Auto-Takeoff Climb Speed',
    group: 'Position Control',
    desc: 'How fast the drone climbs during an automated takeoff.',
    unit: 'm/s', min: 0.1, max: 5, step: 0.1,
  },
  MPC_TKO_RAMP_T: {
    name: 'Takeoff Throttle Ramp Time',
    group: 'Position Control',
    desc: 'Time to ramp throttle from idle to takeoff thrust. Longer = smoother spin-up.',
    unit: 's', min: 0, max: 5, step: 0.1,
  },
  MPC_JERK_MAX: {
    name: 'Max Jerk (Manual)',
    group: 'Position Control',
    desc: 'How quickly the drone can change acceleration in manual Position mode. Low = smooth; high = snappy.',
    unit: 'm/s³', min: 0, max: 20, step: 0.5, expert: true,
  },
  MPC_JERK_AUTO: {
    name: 'Max Jerk (Autonomous)',
    group: 'Position Control',
    desc: 'Jerk limit during autonomous missions.',
    unit: 'm/s³', min: 1, max: 80, step: 1, expert: true,
  },
  MPC_ACC_HOR: {
    name: 'Horizontal Acceleration',
    group: 'Position Control',
    desc: 'Maximum horizontal acceleration when tracking stick inputs.',
    unit: 'm/s²', min: 2, max: 15, step: 0.5,
  },
  MPC_ACC_HOR_MAX: {
    name: 'Max Horizontal Deceleration',
    group: 'Position Control',
    desc: 'Maximum deceleration used to stop or reverse direction.',
    unit: 'm/s²', min: 2, max: 15, step: 0.5,
  },
  MPC_ACC_UP_MAX: {
    name: 'Max Upward Acceleration',
    group: 'Position Control',
    desc: 'Maximum vertical acceleration upward.',
    unit: 'm/s²', min: 2, max: 15, step: 0.5,
  },
  MPC_ACC_DOWN_MAX: {
    name: 'Max Downward Acceleration',
    group: 'Position Control',
    desc: 'Maximum vertical acceleration downward.',
    unit: 'm/s²', min: 2, max: 15, step: 0.5,
  },
  MPC_XY_P: {
    name: 'XY Position P Gain',
    group: 'Position Control',
    desc: 'Outer loop proportional gain for horizontal position correction.',
    min: 0.5, max: 2, step: 0.05, expert: true, danger: true,
  },
  MPC_Z_P: {
    name: 'Z Position P Gain',
    group: 'Position Control',
    desc: 'Outer loop proportional gain for altitude position correction.',
    min: 0.1, max: 1.5, step: 0.05, expert: true, danger: true,
  },
  MPC_MAN_TILT_MAX: {
    name: 'Manual Max Tilt',
    group: 'Position Control',
    desc: 'Max lean angle when flying in manual Stabilize or Altitude Hold mode.',
    unit: '°', min: 5, max: 70, step: 1,
  },
  MPC_MAN_Y_MAX: {
    name: 'Manual Max Yaw Rate',
    group: 'Position Control',
    desc: 'Maximum yaw rotation rate when the yaw stick is fully deflected.',
    unit: '°/s', min: 0, max: 400, step: 5,
  },
  MPC_HOLD_MAX_XY: {
    name: 'Position Hold Max Speed',
    group: 'Position Control',
    desc: 'When flying below this horizontal speed, the drone will switch into position hold.',
    unit: 'm/s', min: 0, max: 3, step: 0.1,
  },
  MPC_HOLD_DZ: {
    name: 'Stick Deadzone in Hold',
    group: 'Position Control',
    desc: 'Fraction of stick travel that is ignored to prevent accidental position drift.',
    min: 0, max: 1, step: 0.01,
  },
  MPC_ALT_MODE: {
    name: 'Altitude Control Mode',
    group: 'Position Control',
    desc: 'Whether the throttle stick directly controls velocity or terrain-following altitude.',
    opts: { 0: 'Altitude setpoint (default)', 1: 'Terrain following', 2: 'Altitude+terrain combined' },
  },

  // ── NAVIGATION ──────────────────────────────────────────────────────────
  NAV_ACC_RAD: {
    name: 'Waypoint Acceptance Radius',
    group: 'Navigation',
    desc: 'How close the drone must get to a waypoint before counting it as reached.',
    unit: 'm', min: 0.05, max: 200, step: 0.5,
  },
  NAV_LOITER_RAD: {
    name: 'Loiter Circle Radius',
    group: 'Navigation',
    desc: 'Radius of holding pattern during loiter (mainly fixed-wing). Multirotors loiter in place.',
    unit: 'm', min: 10, max: 1000, step: 5,
  },
  NAV_RCL_ACT: {
    name: 'RC Loss Action',
    group: 'Navigation',
    desc: 'What the autopilot does when RC signal is lost.',
    opts: { 0: 'Disabled (not recommended)', 1: 'Loiter', 2: 'Return to Home', 3: 'Land immediately', 5: '⚠ Terminate (cuts motors!)' },
    danger: true,
  },
  NAV_DLL_ACT: {
    name: 'Data Link Loss Action',
    group: 'Navigation',
    desc: 'What happens when the GCS / telemetry link is lost mid-flight.',
    opts: { 0: 'Disabled', 1: 'Loiter', 2: 'Return to Home', 3: 'Land', 4: 'Continue mission' },
  },
  NAV_GPSF_LT: {
    name: 'GPS Loss Loiter Time',
    group: 'Navigation',
    desc: 'How long the drone loiters after GPS fix is lost before taking the GPS loss action.',
    unit: 's', min: 0, max: 3600, step: 10,
  },
  NAV_TRAFF_AVOID: {
    name: 'ADS-B Traffic Avoidance',
    group: 'Navigation',
    desc: 'How to respond to ADS-B traffic conflict alerts.',
    opts: { 0: 'Disabled', 1: 'Warn only', 2: 'Return to Home', 3: 'Land' },
  },

  // ── RETURN TO LAUNCH ───────────────────────────────────────────────────
  RTL_TYPE: {
    name: 'RTL Type',
    group: 'Return to Launch',
    desc: 'Which return-to-home strategy to use.',
    opts: { 0: 'Climb then fly home', 1: 'Use mission safe-point', 2: 'Mission path in reverse', 3: 'Closest safe point' },
  },
  RTL_RETURN_ALT: {
    name: 'RTL Cruise Altitude',
    group: 'Return to Launch',
    desc: 'Altitude the drone climbs to (above home) before flying home. Must clear all obstacles.',
    unit: 'm', min: 0, max: 150, step: 5,
  },
  RTL_DESCEND_ALT: {
    name: 'RTL Approach Altitude',
    group: 'Return to Launch',
    desc: 'Altitude above home at which the drone switches from cruise to final descent.',
    unit: 'm', min: 0, max: 150, step: 5,
  },
  RTL_LAND_DELAY: {
    name: 'Hover Before Landing (RTL)',
    group: 'Return to Launch',
    desc: 'How long the drone hovers above home before beginning final descent. -1 = no hover.',
    unit: 's', min: -1, max: 300, step: 1,
  },
  RTL_MIN_DIST: {
    name: 'RTL Minimum Distance',
    group: 'Return to Launch',
    desc: 'If the drone is closer than this to home, it descends immediately instead of doing the full RTL climb.',
    unit: 'm', min: 0.5, max: 100, step: 1,
  },
  RTL_CONE_ANG: {
    name: 'RTL Safety Cone Half-Angle',
    group: 'Return to Launch',
    desc: 'Defines a cone above home. If the drone is inside this cone, it descends directly instead of climbing first.',
    unit: '°', min: 0, max: 90, step: 1, expert: true,
  },
  RTL_LOITER_RAD: {
    name: 'RTL Loiter Radius',
    group: 'Return to Launch',
    desc: 'Loiter circle radius used during RTL descent (mostly for fixed-wing).',
    unit: 'm', min: 10, max: 1000, step: 5, expert: true,
  },

  // ── BATTERY ──────────────────────────────────────────────────────────────
  BAT_N_CELLS: {
    name: 'Cell Count (S)',
    group: 'Battery',
    desc: 'Number of lithium cells in series. CRITICAL — wrong value causes completely incorrect battery readings.',
    unit: 'S', min: 1, max: 14, step: 1, danger: true,
  },
  BAT_CAPACITY: {
    name: 'Pack Capacity',
    group: 'Battery',
    desc: 'Total energy in the battery pack. Used to estimate remaining flight time and mAh consumed.',
    unit: 'mAh', min: 100, max: 100000, step: 100,
  },
  BAT_V_CHARGED: {
    name: 'Full-Charge Cell Voltage',
    group: 'Battery',
    desc: 'Voltage per cell when fully charged. 4.20 V for standard LiPo, 4.35 V for HV LiPo, 3.65 V for LiFe.',
    unit: 'V', min: 3.5, max: 4.4, step: 0.01, expert: true,
  },
  BAT_V_EMPTY: {
    name: 'Empty Cell Voltage',
    group: 'Battery',
    desc: 'Cell voltage at which the battery is considered depleted. Land before reaching this.',
    unit: 'V', min: 2.5, max: 3.7, step: 0.01, expert: true,
  },
  BAT_V_LOAD_DROP: {
    name: 'Voltage Drop Under Load',
    group: 'Battery',
    desc: 'How much the cell voltage sags under full load. Used to correct the state-of-charge estimate.',
    unit: 'V', min: 0, max: 0.3, step: 0.01, expert: true,
  },
  BAT_LOW_THR: {
    name: 'Low Battery Threshold',
    group: 'Battery',
    desc: 'Battery remaining percentage that triggers a low-battery warning.',
    min: 0.01, max: 0.4, step: 0.01,
  },
  BAT_CRIT_THR: {
    name: 'Critical Battery Threshold',
    group: 'Battery',
    desc: 'Battery remaining percentage that triggers the critical failsafe action.',
    min: 0.01, max: 0.3, step: 0.01,
  },
  BAT_EMERGEN_THR: {
    name: 'Emergency Land Threshold',
    group: 'Battery',
    desc: 'Battery level at which the drone immediately lands, overriding all commands.',
    min: 0.01, max: 0.15, step: 0.01, danger: true,
  },
  BAT_SOURCE: {
    name: 'Battery Monitoring Source',
    group: 'Battery',
    desc: 'Where the battery voltage/current comes from.',
    opts: { 0: 'Power module', 1: 'External (ESC telemetry)', 2: 'External + power module' },
    expert: true,
  },

  // ── GEOFENCE ─────────────────────────────────────────────────────────────
  GF_ACTION: {
    name: 'Geofence Breach Action',
    group: 'Geofence',
    desc: 'What the drone does when it flies past the geofence boundary.',
    opts: { 0: 'None (warn only)', 1: 'Return to Home', 2: 'Land at fence', 3: 'Loiter at fence', 4: 'Terminate' },
    danger: true,
  },
  GF_ALTMODE: {
    name: 'Geofence Altitude Mode',
    group: 'Geofence',
    desc: 'Whether the geofence altitude is relative to home or absolute (AMSL).',
    opts: { 0: 'Relative to WGS84', 1: 'Relative to home' },
  },
  GF_MAX_HOR_DIST: {
    name: 'Max Horizontal Distance',
    group: 'Geofence',
    desc: 'Maximum distance from home before the geofence breach action is triggered. 0 = unlimited.',
    unit: 'm', min: 0, max: 10000, step: 50,
  },
  GF_MAX_VER_DIST: {
    name: 'Max Altitude Ceiling',
    group: 'Geofence',
    desc: 'Maximum altitude above the geofence reference point. 0 = unlimited.',
    unit: 'm', min: 0, max: 10000, step: 10,
  },
  GF_SOURCE: {
    name: 'Geofence Position Source',
    group: 'Geofence',
    desc: 'Which position estimate is used to check geofence boundaries.',
    opts: { 0: 'Autopilot GPS', 1: 'External GPS' },
    expert: true,
  },

  // ── MISSION ──────────────────────────────────────────────────────────────
  MIS_DIST_1WP: {
    name: 'Max First Waypoint Distance',
    group: 'Mission',
    desc: 'Safety check — rejects a mission if the first waypoint is further than this from home.',
    unit: 'm', min: 0, max: 10000, step: 50,
  },
  MIS_DIST_WPS: {
    name: 'Max Between-Waypoint Distance',
    group: 'Mission',
    desc: 'Rejects missions with consecutive waypoints further apart than this. 0 = unlimited.',
    unit: 'm', min: 0, max: 10000, step: 50,
  },
  MIS_TAKEOFF_ALT: {
    name: 'Mission Takeoff Altitude',
    group: 'Mission',
    desc: 'Default takeoff altitude if the mission does not include a takeoff waypoint.',
    unit: 'm', min: 0, max: 100, step: 1,
  },
  MIS_YAWMODE: {
    name: 'Mission Yaw Mode',
    group: 'Mission',
    desc: 'How the drone orients its yaw heading during mission flight.',
    opts: { 0: 'None — pilot controls yaw', 1: 'Face next waypoint', 2: 'Face next waypoint (ROI-only)', 3: 'Follow fixed heading' },
  },
  MIS_ALTMODE: {
    name: 'Mission Altitude Reference',
    group: 'Mission',
    desc: 'Whether mission altitudes are relative to home or absolute (MSL).',
    opts: { 0: 'Relative to home (AGL)', 1: 'MSL altitude', 2: 'Terrain (AMSL from terrain data)' },
  },
  MIS_LTRMIN_ALT: {
    name: 'Min Loiter Altitude',
    group: 'Mission',
    desc: 'Minimum altitude for loiter waypoints in missions. Prevents dangerously low holds.',
    unit: 'm', min: -1, max: 80, step: 1,
  },

  // ── SYSTEM ────────────────────────────────────────────────────────────────
  SYS_AUTOSTART: {
    name: 'Airframe Preset ID',
    group: 'System',
    desc: 'PX4 airframe preset loaded at next boot. Changes mixer, outputs, and control parameters for the whole vehicle type.',
    min: 0, max: 99999, step: 1, danger: true, expert: true,
  },
  SYS_AUTOCONFIG: {
    name: 'Reset Config at Boot',
    group: 'System',
    desc: 'If set to 1, loads default parameters for the current airframe at next reboot, then resets itself.',
    opts: { 0: 'No reset', 1: 'Reset at next boot' },
    danger: true, expert: true,
  },
  SYS_MC_EST_GROUP: {
    name: 'State Estimator',
    group: 'System',
    desc: 'Which position and attitude estimator to use. EKF2 is recommended for all modern setups.',
    opts: { 1: 'Q-estimator (legacy)', 2: 'EKF2 (recommended)' },
    expert: true,
  },
  SYS_RESTART_TYPE: {
    name: 'Restart Type',
    group: 'System',
    desc: 'Type of in-flight restart the vehicle performs when commanded.',
    opts: { 0: 'Disabled', 1: 'Gyro calibration only', 2: 'Full sensor calibration' },
    expert: true,
  },
  SYS_USE_IO: {
    name: 'Use IO Co-Processor',
    group: 'System',
    desc: 'Whether PX4 uses the IO co-processor for RC input and motor output.',
    opts: { 0: 'Disabled (FMU direct)', 1: 'IO co-processor used' },
    expert: true, danger: true,
  },
  SYS_FAILURE_EN: {
    name: 'Failure Injection',
    group: 'System',
    desc: 'Enables artificial failure injection for hardware-in-the-loop testing only. Never use in flight.',
    opts: { 0: 'Disabled', 1: 'Enabled (HIL testing only!)' },
    danger: true, expert: true,
  },

  // ── MAVLINK ────────────────────────────────────────────────────────────────
  MAV_SYS_ID: {
    name: 'MAVLink System ID',
    group: 'MAVLink',
    desc: 'Unique ID for this vehicle on the MAVLink network. Change if running multiple drones on the same link.',
    min: 1, max: 255, step: 1,
  },
  MAV_COMP_ID: {
    name: 'MAVLink Component ID',
    group: 'MAVLink',
    desc: 'Component ID within the system. 1 = autopilot.',
    min: 1, max: 255, step: 1, expert: true,
  },
  MAV_TYPE: {
    name: 'Vehicle Type for MAVLink',
    group: 'MAVLink',
    desc: 'MAVLink vehicle type reported to GCS. Must match physical vehicle.',
    opts: { 0: 'Generic', 1: 'Fixed Wing', 2: 'Quadrotor', 3: 'Coaxial', 13: 'Hexarotor', 14: 'Octorotor', 22: 'VTOL Quadrotor' },
    expert: true,
  },
  MAV_PROTO_VER: {
    name: 'MAVLink Protocol Version',
    group: 'MAVLink',
    desc: 'Which MAVLink protocol version to use on all links.',
    opts: { 0: 'Version 1 only', 1: 'Version 2 if supported', 2: 'Version 2 always' },
    expert: true,
  },
  MAV_RADIO_ID: {
    name: 'Telemetry Radio System ID',
    group: 'MAVLink',
    desc: 'SysID of the SiK telemetry radio module. Used for RSSI reporting and radio passthrough.',
    min: 0, max: 255, step: 1, expert: true,
  },
  MAV_FWDEXTSP: {
    name: 'Forward External Setpoints',
    group: 'MAVLink',
    desc: 'If enabled, external setpoints (from a companion computer) are forwarded to the autopilot.',
    opts: { 0: 'Disabled', 1: 'Enabled' },
    expert: true,
  },

  // ── PWM / ESC ─────────────────────────────────────────────────────────────
  PWM_MAIN_MIN: {
    name: 'Main PWM Minimum',
    group: 'PWM / ESC',
    desc: 'Minimum PWM pulse sent to main ESCs — corresponds to lowest throttle. Must match ESC calibration.',
    unit: 'μs', min: 800, max: 1400, step: 10, danger: true,
  },
  PWM_MAIN_MAX: {
    name: 'Main PWM Maximum',
    group: 'PWM / ESC',
    desc: 'Maximum PWM pulse — full throttle. Must match ESC calibration.',
    unit: 'μs', min: 1600, max: 2200, step: 10, danger: true,
  },
  PWM_MAIN_DISARM: {
    name: 'Disarmed PWM',
    group: 'PWM / ESC',
    desc: 'PWM sent while disarmed — must be below PWM_MAIN_MIN so ESCs stay stopped.',
    unit: 'μs', min: 0, max: 2200, step: 10, danger: true,
  },
  PWM_MAIN_RATE: {
    name: 'Main PWM Update Rate',
    group: 'PWM / ESC',
    desc: 'Update rate for main PWM outputs. 400 Hz for digital ESCs, 50 Hz for traditional servos.',
    unit: 'Hz', min: 0, max: 400, step: 50, expert: true,
  },
  PWM_MAIN_REV: {
    name: 'Motor Direction Reversal',
    group: 'PWM / ESC',
    desc: 'Bitmask of motors to reverse direction. Bit 0 = motor 1, bit 1 = motor 2, etc.',
    min: 0, max: 4095, step: 1, expert: true, danger: true,
  },
  PWM_AUX_MIN: {
    name: 'Aux PWM Minimum',
    group: 'PWM / ESC',
    desc: 'Minimum PWM for auxiliary outputs (servos, camera gimbal, etc.).',
    unit: 'μs', min: 800, max: 1400, step: 10, expert: true,
  },
  PWM_AUX_MAX: {
    name: 'Aux PWM Maximum',
    group: 'PWM / ESC',
    desc: 'Maximum PWM for auxiliary outputs.',
    unit: 'μs', min: 1600, max: 2200, step: 10, expert: true,
  },

  // ── MOTORS ────────────────────────────────────────────────────────────────
  MOT_SPIN_MIN: {
    name: 'Minimum Motor Spin',
    group: 'Motors',
    desc: 'Lowest throttle that keeps all motors spinning. Prevents unexpected stalls at low throttle.',
    min: 0, max: 0.4, step: 0.01, expert: true,
  },
  MOT_SPIN_MAX: {
    name: 'Maximum Motor Spin',
    group: 'Motors',
    desc: 'Maximum throttle limit sent to motors. 1.0 = full.',
    min: 0.9, max: 1.0, step: 0.01, expert: true,
  },
  MOT_SPIN_ARMED: {
    name: 'Motor Spin When Armed',
    group: 'Motors',
    desc: 'Throttle sent to motors when armed but not yet flying. 0 = completely stopped.',
    min: 0, max: 0.2, step: 0.01,
  },
  MOT_ORDERING: {
    name: 'Motor Numbering Scheme',
    group: 'Motors',
    desc: 'Which numbering convention the FC uses for motor 1–4 assignment.',
    opts: { 0: 'PX4 standard', 1: 'Betaflight / CleanFlight' },
    danger: true,
  },
  MOT_SLEW_MAX: {
    name: 'Max Motor Slew Rate',
    group: 'Motors',
    desc: 'Maximum rate of change of motor output per second. Limits rapid throttle spikes.',
    min: 0, max: 1, step: 0.01, expert: true,
  },
  THR_MDL_FAC: {
    name: 'Thrust Curve Factor',
    group: 'Motors',
    desc: 'Linearises throttle → thrust. 0 = linear (start here); tune up if throttle response feels nonlinear.',
    min: 0, max: 1, step: 0.01, expert: true,
  },

  // ── CONTROL ALLOCATOR ─────────────────────────────────────────────────────
  CA_AIRFRAME: {
    name: 'Airframe Type',
    group: 'Control Allocator',
    desc: 'Physical vehicle geometry used by the control allocator for motor mixing.',
    opts: { 0: 'Multirotor', 1: 'Standard VTOL', 2: 'Tiltrotor VTOL' },
    expert: true, danger: true,
  },
  CA_ROTOR_COUNT: {
    name: 'Rotor Count',
    group: 'Control Allocator',
    desc: 'Number of rotors on the vehicle. Must match physical hardware.',
    min: 1, max: 12, step: 1, danger: true,
  },
  CA_METHOD: {
    name: 'Control Allocation Method',
    group: 'Control Allocator',
    desc: 'Algorithm used to convert desired torques/thrust into individual motor commands.',
    opts: { 0: 'Pseudo-inverse', 1: 'Sequential least-squares' },
    expert: true,
  },

  // ── LOGGING ──────────────────────────────────────────────────────────────
  SDLOG_MODE: {
    name: 'Log Recording Mode',
    group: 'Logging',
    desc: 'When the flight log starts and stops recording to the SD card.',
    opts: { '-1': 'Disabled', 0: 'From boot', 1: 'Arm → Disarm', 2: 'Arm → Shutdown' },
  },
  SDLOG_UTC_OFFSET: {
    name: 'UTC Time Offset',
    group: 'Logging',
    desc: 'Local time zone offset from UTC applied to log file timestamps.',
    unit: 'min', min: -1000, max: 1000, step: 30, expert: true,
  },
  SDLOG_DIRS_MAX: {
    name: 'Max Log Directories',
    group: 'Logging',
    desc: 'Maximum number of flight log directories to keep on the SD card. Oldest deleted first.',
    min: 0, max: 1024, step: 1,
  },
  SDLOG_PROFILE: {
    name: 'Logging Profile',
    group: 'Logging',
    desc: 'Which set of topics to log. Higher profiles include more data but use more SD space.',
    opts: { 1: 'Default', 3: 'Default + estimator', 5: 'Default + GPS', 7: 'Default + actuators', 65: 'High-rate (rate tuning)', 131: 'Very verbose' },
    expert: true,
  },
  SDLOG_MISSION: {
    name: 'Mission Log',
    group: 'Logging',
    desc: 'Create a reduced mission-only log alongside the full flight log.',
    opts: { 0: 'Disabled', 1: 'Waypoints only', 2: 'Geotagging data' },
  },

  // ── CIRCUIT BREAKERS ────────────────────────────────────────────────────
  CBRK_AIRSPD_CHK: {
    name: 'Disable Airspeed Check',
    group: 'Circuit Breakers',
    desc: 'Bypass the airspeed sensor requirement for arming. Set to 162128 to skip (fixed-wing only without airspeed sensor).',
    min: 0, max: 162128, step: 162128, expert: true, danger: true,
  },
  CBRK_FLIGHTTERM: {
    name: 'Disable Flight Termination',
    group: 'Circuit Breakers',
    desc: 'Bypass the flight termination system. 121212 = disabled. Only for bench testing.',
    min: 0, max: 121212, step: 121212, expert: true, danger: true,
  },
  CBRK_GPSFAIL: {
    name: 'Disable GPS Failure Failsafe',
    group: 'Circuit Breakers',
    desc: 'Bypass the GPS failure triggered emergency action.',
    min: 0, max: 240024, step: 240024, expert: true, danger: true,
  },
  CBRK_IO_SAFETY: {
    name: 'Skip Safety Switch',
    group: 'Circuit Breakers',
    desc: 'Bypass the hardware safety switch requirement. Set to 22027 to skip (useful for boards without a safety button).',
    min: 0, max: 22027, step: 22027, expert: true,
  },
  CBRK_SUPPLY_CHK: {
    name: 'Disable Power Supply Check',
    group: 'Circuit Breakers',
    desc: 'Bypass the power supply voltage check at arming.',
    min: 0, max: 894281, step: 894281, expert: true, danger: true,
  },
  CBRK_USB_CHK: {
    name: 'Disable USB Check',
    group: 'Circuit Breakers',
    desc: 'Allow arming while USB is connected. Set to 197848 to skip the USB plug check.',
    min: 0, max: 197848, step: 197848, expert: true,
  },

  // ── LAND DETECTOR ────────────────────────────────────────────────────────
  LNDMC_ALT_MAX: {
    name: 'Max Altitude for Land Detection',
    group: 'Land Detector',
    desc: 'Maximum altitude above ground at which the land detector will decide "landed". Above this the drone is always considered airborne.',
    unit: 'm', min: -1, max: 20, step: 0.5,
  },
  LNDMC_FFALL_THR: {
    name: 'Freefall Threshold',
    group: 'Land Detector',
    desc: 'Acceleration below which the drone is considered in freefall. Used for parachute deployment.',
    unit: 'm/s²', min: 0.1, max: 10, step: 0.1, expert: true,
  },
  LNDMC_LOW_T_THR: {
    name: 'Low Throttle Threshold',
    group: 'Land Detector',
    desc: 'Throttle below which the drone may be considered close to landing.',
    min: 0.1, max: 0.5, step: 0.01, expert: true,
  },
  LNDMC_Z_VEL_MAX: {
    name: 'Land Detect Max Z Velocity',
    group: 'Land Detector',
    desc: 'Maximum vertical velocity (m/s) that is still consistent with being landed.',
    unit: 'm/s', min: 0.1, max: 0.5, step: 0.01, expert: true,
  },

  // ── SENSORS ────────────────────────────────────────────────────────────────
  CAL_MAG_SIDES: {
    name: 'Compass Cal Orientations',
    group: 'Sensors',
    desc: 'How many different orientations to hold during compass calibration. More = more accurate.',
    min: 1, max: 63, step: 1,
  },
  CAL_ACC_PRIME: {
    name: 'Primary Accelerometer',
    group: 'Sensors',
    desc: 'Device ID of the primary accelerometer to use.',
    expert: true,
  },
  CAL_GYRO_PRIME: {
    name: 'Primary Gyroscope',
    group: 'Sensors',
    desc: 'Device ID of the primary gyroscope to use.',
    expert: true,
  },
  CAL_MAG_PRIME: {
    name: 'Primary Magnetometer',
    group: 'Sensors',
    desc: 'Device ID of the primary compass/magnetometer to use.',
    expert: true,
  },
  SENS_BOARD_ROT: {
    name: 'Flight Controller Rotation',
    group: 'Sensors',
    desc: 'Physical rotation of the FC board relative to the vehicle frame. Critical if mounted non-standard.',
    opts: {
      0: 'No rotation', 1: 'Yaw 45°', 2: 'Yaw 90°', 3: 'Yaw 135°',
      4: 'Yaw 180°', 5: 'Yaw 225°', 6: 'Yaw 270°', 7: 'Yaw 315°',
      8: 'Roll 180°', 9: 'Roll 180°, Yaw 45°', 10: 'Roll 180°, Yaw 90°',
    },
    danger: true,
  },
  SENS_DPRES_OFF: {
    name: 'Differential Pressure Offset',
    group: 'Sensors',
    desc: 'Manual calibration offset for the differential pressure (airspeed) sensor.',
    unit: 'Pa', min: -300, max: 300, step: 1, expert: true,
  },
  SENS_EN_BARO: {
    name: 'Enable Barometer',
    group: 'Sensors',
    desc: 'Whether the barometer is used for altitude estimation.',
    opts: { 0: 'Disabled', 1: 'Enabled (default)' },
  },

  // ── RC CHANNELS ──────────────────────────────────────────────────────────
  RC_MAP_ROLL: {
    name: 'Roll Channel',
    group: 'RC Channels',
    desc: 'RC channel mapped to roll (left-right tilt).',
    min: 0, max: 18, step: 1,
  },
  RC_MAP_PITCH: {
    name: 'Pitch Channel',
    group: 'RC Channels',
    desc: 'RC channel mapped to pitch (forward-backward tilt).',
    min: 0, max: 18, step: 1,
  },
  RC_MAP_YAW: {
    name: 'Yaw Channel',
    group: 'RC Channels',
    desc: 'RC channel mapped to yaw (heading rotation).',
    min: 0, max: 18, step: 1,
  },
  RC_MAP_THROTTLE: {
    name: 'Throttle Channel',
    group: 'RC Channels',
    desc: 'RC channel mapped to throttle (up-down power).',
    min: 0, max: 18, step: 1,
  },
  RC_MAP_FLTMODE: {
    name: 'Flight Mode Channel',
    group: 'RC Channels',
    desc: 'RC channel used to select between flight modes on the switch.',
    min: 0, max: 18, step: 1,
  },
  RC_MAP_KILL_SW: {
    name: 'Kill Switch Channel',
    group: 'RC Channels',
    desc: 'RC channel assigned as the emergency kill switch. Cuts motors immediately.',
    min: 0, max: 18, step: 1, danger: true,
  },
  RC_MAP_ARM_SW: {
    name: 'Arm/Disarm Switch Channel',
    group: 'RC Channels',
    desc: 'RC channel for a dedicated arm/disarm switch (alternative to stick arming).',
    min: 0, max: 18, step: 1,
  },
  RC1_MIN: { name: 'RC Channel 1 Min', group: 'RC Channels', desc: 'Minimum PWM value from your transmitter for channel 1.', unit: 'μs', min: 800, max: 1500, step: 5, expert: true },
  RC1_MAX: { name: 'RC Channel 1 Max', group: 'RC Channels', desc: 'Maximum PWM value from your transmitter for channel 1.', unit: 'μs', min: 1500, max: 2200, step: 5, expert: true },
  RC1_TRIM: { name: 'RC Channel 1 Trim', group: 'RC Channels', desc: 'Neutral / center PWM value for channel 1.', unit: 'μs', min: 800, max: 2200, step: 5, expert: true },
  RC1_REV: { name: 'RC Channel 1 Reversed', group: 'RC Channels', desc: 'Reverse direction of channel 1.', opts: { 1: 'Normal', '-1': 'Reversed' }, expert: true },
  RC2_MIN: { name: 'RC Channel 2 Min', group: 'RC Channels', desc: 'Minimum PWM for channel 2.', unit: 'μs', min: 800, max: 1500, step: 5, expert: true },
  RC2_MAX: { name: 'RC Channel 2 Max', group: 'RC Channels', desc: 'Maximum PWM for channel 2.', unit: 'μs', min: 1500, max: 2200, step: 5, expert: true },
  RC2_TRIM: { name: 'RC Channel 2 Trim', group: 'RC Channels', desc: 'Neutral PWM for channel 2.', unit: 'μs', min: 800, max: 2200, step: 5, expert: true },
  RC3_MIN: { name: 'RC Channel 3 Min', group: 'RC Channels', desc: 'Minimum PWM for channel 3 (usually throttle).', unit: 'μs', min: 800, max: 1500, step: 5, expert: true },
  RC3_MAX: { name: 'RC Channel 3 Max', group: 'RC Channels', desc: 'Maximum PWM for channel 3.', unit: 'μs', min: 1500, max: 2200, step: 5, expert: true },
  RC3_TRIM: { name: 'RC Channel 3 Trim', group: 'RC Channels', desc: 'Neutral PWM for channel 3.', unit: 'μs', min: 800, max: 2200, step: 5, expert: true },
  RC4_MIN: { name: 'RC Channel 4 Min', group: 'RC Channels', desc: 'Minimum PWM for channel 4.', unit: 'μs', min: 800, max: 1500, step: 5, expert: true },
  RC4_MAX: { name: 'RC Channel 4 Max', group: 'RC Channels', desc: 'Maximum PWM for channel 4.', unit: 'μs', min: 1500, max: 2200, step: 5, expert: true },
  RC4_TRIM: { name: 'RC Channel 4 Trim', group: 'RC Channels', desc: 'Neutral PWM for channel 4.', unit: 'μs', min: 800, max: 2200, step: 5, expert: true },

  // ── VTOL ─────────────────────────────────────────────────────────────────
  VT_TYPE: {
    name: 'VTOL Type',
    group: 'VTOL',
    desc: 'Type of VTOL airframe.',
    opts: { 0: 'Tailsitter', 1: 'Tiltrotor', 2: 'Standard (pusher)' },
    expert: true,
  },
  VT_F_TRANS_DUR: {
    name: 'Forward Transition Duration',
    group: 'VTOL',
    desc: 'Maximum time allowed for the VTOL forward transition from hover to fixed-wing mode.',
    unit: 's', min: 0, max: 20, step: 0.5, expert: true,
  },
  VT_B_TRANS_DUR: {
    name: 'Back Transition Duration',
    group: 'VTOL',
    desc: 'Duration of back-transition from fixed-wing to hover mode.',
    unit: 's', min: 0, max: 20, step: 0.5, expert: true,
  },
  VT_ARSP_TRANS: {
    name: 'Transition Airspeed',
    group: 'VTOL',
    desc: 'Airspeed at which the VTOL completes the forward transition into fixed-wing mode.',
    unit: 'm/s', min: 0, max: 30, step: 0.5, expert: true,
  },

  // ── BATTERY (additional params not covered above) ─────────────────────────
  BAT_EMERCY_THR: {
    name: 'Emergency Battery Level',
    group: 'Battery',
    desc: 'Battery percentage that triggers an immediate forced landing regardless of what the drone is doing.',
    unit: '%', min: 0.03, max: 0.15, step: 0.01, danger: true,
  },
  BAT_R_INTERNAL: {
    name: 'Pack Internal Resistance',
    group: 'Battery',
    desc: 'Internal resistance of the battery pack. Measured automatically if a current sensor is present, or set manually. Affects SoC accuracy under load.',
    unit: 'Ω', min: -1, max: 0.2, step: 0.001, expert: true,
  },
  BAT1_LOW_THR: {
    name: 'Low Battery Warning (BAT1)',
    group: 'Battery',
    desc: 'Low battery warning threshold for the first battery (modern BAT1_ naming). Mirrors BAT_LOW_THR on single-battery setups.',
    unit: '%', min: 0.12, max: 0.5, step: 0.01,
  },
  BAT1_CRIT_THR: {
    name: 'Critical Battery Level (BAT1)',
    group: 'Battery',
    desc: 'Critical battery action trigger for BAT1.',
    unit: '%', min: 0.05, max: 0.3, step: 0.01, danger: true,
  },
  BAT1_EMERCY_THR: {
    name: 'Emergency Battery Level (BAT1)',
    group: 'Battery',
    desc: 'Forced-land trigger for BAT1.',
    unit: '%', min: 0.03, max: 0.15, step: 0.01, danger: true,
  },
  BAT1_N_CELLS: {
    name: 'Battery 1 Cell Count',
    group: 'Battery',
    desc: 'Cell count (S) of battery 1.',
    opts: { 0: 'Auto', 1: '1S', 2: '2S', 3: '3S', 4: '4S', 5: '5S', 6: '6S', 7: '7S', 8: '8S', 12: '12S', 14: '14S' },
  },
  BAT1_CAPACITY: {
    name: 'Battery 1 Capacity',
    group: 'Battery',
    desc: 'mAh capacity of battery 1.',
    unit: 'mAh', min: -1, max: 100000, step: 50,
  },
  BAT1_V_EMPTY: {
    name: 'Battery 1 Empty Voltage',
    group: 'Battery',
    desc: 'Per-cell voltage considered empty for battery 1.',
    unit: 'V', min: 2.5, max: 4.0, step: 0.01,
  },
  BAT1_V_CHARGED: {
    name: 'Battery 1 Full Voltage',
    group: 'Battery',
    desc: 'Per-cell full-charge voltage for battery 1.',
    unit: 'V', min: 4.0, max: 4.4, step: 0.01,
  },
  BAT1_V_LOAD_DROP: {
    name: 'Battery 1 Load Voltage Drop',
    group: 'Battery',
    desc: 'Expected per-cell voltage sag under full throttle for battery 1.',
    unit: 'V', min: 0, max: 0.3, step: 0.01, expert: true,
  },
  BAT1_R_INTERNAL: {
    name: 'Battery 1 Internal Resistance',
    group: 'Battery',
    desc: 'Internal resistance of battery pack 1.',
    unit: 'Ω', min: -1, max: 0.2, step: 0.001, expert: true,
  },
  BAT1_SOURCE: {
    name: 'Battery 1 Current Source',
    group: 'Battery',
    desc: 'Current sensor source for battery 1.',
    opts: { 0: 'Power module', 1: 'ESC telemetry', 2: 'External CAN' },
  },
  BAT1_OCHARGED: {
    name: 'Battery 1 Overcurrent Threshold',
    group: 'Battery',
    desc: 'Current at which overcharge protection triggers for battery 1. Set to 0 to disable.',
    unit: 'A', min: 0, max: 400, step: 1, expert: true,
  },

  // ── FAILURE DETECTOR ─────────────────────────────────────────────────────
  FD_ACT_EN: {
    name: 'Failure Detector Enable',
    group: 'Failure Detector',
    desc: 'Enable the automatic failure detector. When armed, it continuously monitors for attitude/rate anomalies that indicate a crash or motor failure.',
    opts: { 0: 'Disabled', 1: 'Enabled (recommended)' },
    danger: true,
  },
  FD_ACT_TIME: {
    name: 'Failure Trigger Time',
    group: 'Failure Detector',
    desc: 'How long the failure condition must persist before the detector activates. Very short times may cause false alarms.',
    unit: 'ms', min: 10, max: 500, step: 10, expert: true,
  },
  FD_ESCS_EN: {
    name: 'ESC Failure Detection',
    group: 'Failure Detector',
    desc: 'Detect ESC failures via CAN/UAVCAN telemetry. Requires ESCs that report status. Triggers emergency action when an ESC fails in flight.',
    opts: { 0: 'Disabled', 1: 'Enabled' },
    expert: true,
  },
  FD_IMB_VEL_THR: {
    name: 'Imbalance Velocity Threshold',
    group: 'Failure Detector',
    desc: 'Horizontal velocity deviation that hints at a broken propeller. Failure action triggers if exceeded for the set duration.',
    unit: 'm/s', min: 0, max: 30, step: 0.5, expert: true,
  },
  FD_IMB_ANG_THR: {
    name: 'Imbalance Angle Threshold',
    group: 'Failure Detector',
    desc: 'Roll/pitch angle at which motor imbalance (likely a broken prop) is flagged.',
    unit: '°', min: 0, max: 180, step: 1, expert: true,
  },
  FD_EXT_ATS_EN: {
    name: 'External Failure Trigger Input',
    group: 'Failure Detector',
    desc: 'Listen for a kill/failure signal from an external automatic termination system (ATS) — used in some competition and commercial setups.',
    opts: { 0: 'Disabled', 1: 'Enabled' },
    expert: true,
  },
  FD_EXT_ATS_TRIG: {
    name: 'External ATS Trigger Level',
    group: 'Failure Detector',
    desc: 'PWM level from the ATS input channel that activates the kill signal.',
    unit: 'µs', min: 900, max: 2100, step: 10, expert: true,
  },
  FD_FAIL_P: {
    name: 'Max Pitch Before Failure',
    group: 'Failure Detector',
    desc: 'Maximum pitch angle beyond which the failure detector considers the flight unrecoverable and triggers the action.',
    unit: '°', min: 60, max: 180, step: 1, expert: true, danger: true,
  },
  FD_FAIL_R: {
    name: 'Max Roll Before Failure',
    group: 'Failure Detector',
    desc: 'Maximum roll angle beyond which the failure detector triggers. Should be wider than your normal max roll.',
    unit: '°', min: 60, max: 180, step: 1, expert: true, danger: true,
  },

  // ── ATTITUDE ESTIMATOR (simple complementary filter, alternative to EKF2) ─
  ATT_W_ACC: {
    name: 'Accelerometer Weight',
    group: 'Attitude Estimator',
    desc: 'How much the complementary filter trusts the accelerometer for attitude correction. Higher = more responsive to accel data, noisier during manoeuvres.',
    min: 0, max: 1, step: 0.01, expert: true,
  },
  ATT_W_GYRO_BIAS: {
    name: 'Gyro Bias Correction Weight',
    group: 'Attitude Estimator',
    desc: 'Rate at which the estimator corrects gyro bias. Higher = faster bias convergence but more susceptible to noise.',
    min: 0, max: 1, step: 0.001, expert: true,
  },
  ATT_W_MAG: {
    name: 'Magnetometer Weight',
    group: 'Attitude Estimator',
    desc: 'How strongly the compass corrects yaw heading in the complementary filter.',
    min: 0, max: 1, step: 0.01, expert: true,
  },
  ATT_W_EXT_HDG: {
    name: 'External Heading Weight',
    group: 'Attitude Estimator',
    desc: 'Weight given to an external heading source (e.g. GPS course, vision) for yaw correction.',
    min: 0, max: 1, step: 0.01, expert: true,
  },
  ATT_MAG_DECL: {
    name: 'Manual Magnetic Declination',
    group: 'Attitude Estimator',
    desc: 'Magnetic declination in degrees. Positive east. Used when auto-declination is disabled.',
    unit: '°', min: -3.14159, max: 3.14159, step: 0.01, expert: true,
  },
  ATT_MAG_DECL_A: {
    name: 'Auto Magnetic Declination',
    group: 'Attitude Estimator',
    desc: 'Automatically determine magnetic declination from GPS position at startup.',
    opts: { 0: 'Disabled', 1: 'Enabled' },
    expert: true,
  },
  ATT_EXT_HDG_M: {
    name: 'External Heading Mode',
    group: 'Attitude Estimator',
    desc: 'Choose which external source provides the yaw heading reference.',
    opts: { 0: 'None (use compass)', 1: 'GPS course over ground', 2: 'External vision' },
    expert: true,
  },
  ATT_BIAS_MAX: {
    name: 'Max Gyro Bias Estimate',
    group: 'Attitude Estimator',
    desc: 'Upper bound on the gyroscope bias estimate. Values above this are clamped to prevent bias runaway.',
    unit: 'rad/s', min: 0, max: 0.08, step: 0.001, expert: true,
  },

  // ── LAND DETECTOR (additional params) ────────────────────────────────────
  LNDMC_ROT_MAX: {
    name: 'Max Rotation Rate for Landed',
    group: 'Land Detector',
    desc: 'Maximum angular rotation rate (any axis) to still classify the vehicle as landed. Higher = more permissive.',
    unit: '°/s', min: 0, max: 40, step: 0.5, expert: true,
  },
  LNDMC_XY_VEL_MAX: {
    name: 'Max Horizontal Speed for Landed',
    group: 'Land Detector',
    desc: 'Maximum horizontal velocity to still consider the vehicle landed.',
    unit: 'm/s', min: 0, max: 2, step: 0.05, expert: true,
  },
  LNDMC_FFALL_TTRI: {
    name: 'Free Fall Trigger Duration',
    group: 'Land Detector',
    desc: 'How long the free-fall condition must persist before the free-fall state is declared.',
    unit: 's', min: 0.1, max: 5, step: 0.1, expert: true,
  },
  LNDMC_TRIG_TIME: {
    name: 'Landed State Trigger Time',
    group: 'Land Detector',
    desc: 'How long all landing conditions (low thrust, low rotation, etc.) must be satisfied before declaring "landed".',
    unit: 's', min: 0.1, max: 5, step: 0.1, expert: true,
  },
  LNDMC_POS_UPTHR: {
    name: 'Hovering Thrust Check',
    group: 'Land Detector',
    desc: 'Minimum collective thrust (fraction of hover thrust) that is taken as evidence the vehicle is trying to fly.',
    unit: 'norm', min: 0.1, max: 0.9, step: 0.05, expert: true,
  },

  // ── MORE POSITION CONTROL (velocity PIDs and new params not already defined) ─
  MPC_XY_VEL_P_ACC: {
    name: 'Horizontal Velocity P Gain',
    group: 'Position Control',
    desc: 'P gain for horizontal velocity controller. Higher → faster response to velocity errors but possible oscillation.',
    min: 0.1, max: 3, step: 0.05, expert: true, danger: true,
  },
  MPC_XY_VEL_I_ACC: {
    name: 'Horizontal Velocity I Gain',
    group: 'Position Control',
    desc: 'I gain for horizontal velocity. Eliminates steady-state drift in position hold.',
    min: 0, max: 4, step: 0.1, expert: true,
  },
  MPC_XY_VEL_D_ACC: {
    name: 'Horizontal Velocity D Gain',
    group: 'Position Control',
    desc: 'D gain for horizontal velocity controller. Helps damp horizontal oscillation.',
    min: 0, max: 2, step: 0.01, expert: true, danger: true,
  },
  MPC_Z_VEL_P_ACC: {
    name: 'Vertical Velocity P Gain',
    group: 'Position Control',
    desc: 'P gain for vertical (altitude) velocity controller.',
    min: 0.1, max: 3, step: 0.05, expert: true, danger: true,
  },
  MPC_Z_VEL_I_ACC: {
    name: 'Vertical Velocity I Gain',
    group: 'Position Control',
    desc: 'I gain for altitude velocity — corrects steady hover height error.',
    min: 0, max: 3, step: 0.1, expert: true,
  },
  MPC_Z_VEL_D_ACC: {
    name: 'Vertical Velocity D Gain',
    group: 'Position Control',
    desc: 'D gain for altitude velocity — damps vertical bouncing.',
    min: 0, max: 1.5, step: 0.01, expert: true,
  },
  MPC_LAND_VXMAX: {
    name: 'Max Horizontal Speed While Landing',
    group: 'Position Control',
    desc: 'Maximum allowed horizontal drift while landing. Very low value forces the drone to hover almost perfectly still before descending.',
    unit: 'm/s', min: 0, max: 5, step: 0.1,
  },
  MPC_HOLD_MAX_Z: {
    name: 'Altitude Hold Velocity Gate',
    group: 'Position Control',
    desc: 'Vertical stick dead zone for altitude hold. Vertical movement below this threshold keeps altitude locked.',
    unit: 'm/s', min: 0, max: 1, step: 0.05,
  },
  MPC_SPOOLUP_TIME: {
    name: 'Motor Spool-Up Time',
    group: 'Position Control',
    desc: 'Time from arming to beginning of takeoff sequence — gives motors time to spin up before lift commands.',
    unit: 's', min: 0, max: 30, step: 0.5,
  },

  // ── MORE MULTICOPTER RATE (acro and scaling params) ──────────────────────
  MC_BAT_SCALE_EN: {
    name: 'Battery Voltage Scaling',
    group: 'Multicopter Rate',
    desc: 'Scale motor outputs by current battery voltage so attitude control authority stays constant as the battery discharges.',
    opts: { 0: 'Disabled', 1: 'Enabled' },
    expert: true,
  },
  MC_ACRO_R_MAX: {
    name: 'Acro Roll Rate Maximum',
    group: 'Multicopter Rate',
    desc: 'Maximum roll rate in Acro mode at full stick deflection.',
    unit: '°/s', min: 0, max: 1800, step: 5, expert: true,
  },
  MC_ACRO_P_MAX: {
    name: 'Acro Pitch Rate Maximum',
    group: 'Multicopter Rate',
    desc: 'Maximum pitch rate in Acro mode at full stick deflection.',
    unit: '°/s', min: 0, max: 1800, step: 5, expert: true,
  },
  MC_ACRO_Y_MAX: {
    name: 'Acro Yaw Rate Maximum',
    group: 'Multicopter Rate',
    desc: 'Maximum yaw rate in Acro mode.',
    unit: '°/s', min: 0, max: 1800, step: 5, expert: true,
  },
  MC_ACRO_EXPO: {
    name: 'Acro Roll/Pitch Expo',
    group: 'Multicopter Rate',
    desc: 'Expo curve applied to Acro roll/pitch sticks. 0 = linear; 1 = maximum expo for a centre-sensitive feel.',
    min: 0, max: 1, step: 0.05, expert: true,
  },
  MC_ACRO_EXPO_Y: {
    name: 'Acro Yaw Expo',
    group: 'Multicopter Rate',
    desc: 'Expo curve applied to Acro yaw stick.',
    min: 0, max: 1, step: 0.05, expert: true,
  },
  MC_RATT_TH: {
    name: 'Rattitude Threshold',
    group: 'Multicopter Rate',
    desc: 'Stick deflection fraction above which Rattitude mode switches from stabilised to rate (Acro) behaviour.',
    min: 0, max: 1, step: 0.05, expert: true,
  },
}

// Derive a display group from a parameter key when it is not in PX4_META
export function getGroupFromKey(key: string): PX4Group {
  if (key.startsWith('EKF2_'))   return 'EKF2'
  if (key.startsWith('SDLOG_'))  return 'Logging'
  if (key.startsWith('LNDMC_') || key.startsWith('LNDFW_')) return 'Land Detector'
  if (key.startsWith('CBRK_'))   return 'Circuit Breakers'
  if (key.startsWith('UAVCAN_')) return 'Other'
  if (key.startsWith('VT_'))     return 'VTOL'
  if (key.startsWith('BAT1_') || key.startsWith('BAT2_')) return 'Battery'
  if (key.startsWith('ATT_'))    return 'Attitude Estimator'
  if (key.startsWith('FD_'))     return 'Failure Detector'
  if (key.startsWith('FW_'))     return 'Other'

  const prefix = key.split('_')[0]
  const map: Record<string, PX4Group> = {
    COM: 'Commander', MC: 'Multicopter Rate', MPC: 'Position Control',
    NAV: 'Navigation', RTL: 'Return to Launch', BAT: 'Battery', GF: 'Geofence',
    MIS: 'Mission', SYS: 'System', MAV: 'MAVLink', PWM: 'PWM / ESC',
    MOT: 'Motors', CA: 'Control Allocator', THR: 'Motors',
    SENS: 'Sensors', CAL: 'Sensors', RC: 'RC Channels',
    LAND: 'Land Detector', ASPD: 'Other',
    MIXER: 'Control Allocator', OSD: 'Other',
    TC: 'Sensors', TRIM: 'Position Control',
  }
  return map[prefix] ?? 'Other'
}

// ── Key humanizer ─────────────────────────────────────────────────────────────
// Converts a raw PX4 param key into a readable name when the key is not in
// PX4_META. Used in the UI so the top line is always a human description.
const KEY_WORDS: Record<string, string> = {
  P: 'P Gain', I: 'I Gain', D: 'D Gain', FF: 'Feedforward',
  MAX: 'Maximum', MIN: 'Minimum', EN: 'Enable', DIS: 'Disable',
  THR: 'Throttle', ALT: 'Altitude', VEL: 'Velocity', POS: 'Position',
  ANG: 'Angle', ANGL: 'Angle', ACCEL: 'Acceleration', ACC: 'Accelerometer',
  GYRO: 'Gyroscope', BARO: 'Barometer', MAG: 'Magnetometer', GPS: 'GPS',
  IMU: 'IMU', ROLL: 'Roll', PITCH: 'Pitch', YAW: 'Yaw',
  TKO: 'Takeoff', LND: 'Landing', HOVER: 'Hover', MAN: 'Manual',
  AUTO: 'Auto', CTRL: 'Control', RATE: 'Rate', SPD: 'Speed',
  HDG: 'Heading', ACT: 'Action', DIST: 'Distance', RAD: 'Radius',
  TIMEOUT: 'Timeout', TIME: 'Time', LOCK: 'Lock', BIAS: 'Bias',
  FFALL: 'Free Fall', CELLS: 'Cells', NCELLS: 'Cell Count',
  CRIT: 'Critical', EMERG: 'Emergency', EMERCY: 'Emergency',
  WRN: 'Warning', LOW: 'Low', SRC: 'Source', SOURCE: 'Source',
  V: 'Voltage', R: 'Resistance', INTERNAL: 'Internal', LOAD: 'Load',
  DROP: 'Droop', CAPACITY: 'Capacity', CHARGED: 'Full Voltage',
  OCHARGED: 'Overcurrent', EMPTY: 'Empty Voltage', FUSE: 'Fusion',
  FLOW: 'Optical Flow', ROT: 'Rotation', XY: 'Horizontal', Z: 'Vertical',
  TRIG: 'Trigger', INTERVAL: 'Interval', DPRES: 'Diff. Pressure',
  ESC: 'ESC', ESCS: 'ESCs', EXT: 'External', IMB: 'Imbalance',
  AIRMODE: 'Airmode', AIRSPD: 'Airspeed', ASPD: 'Airspeed',
  SCALE: 'Scale', BAT: 'Battery', BATT: 'Battery', PACK: 'Pack',
  ACRO: 'Acro', EXPO: 'Expo', SUPEXPO: 'Super-Expo', RATT: 'Rattitude',
  JERK: 'Jerk', SPOOLUP: 'Spool-Up', TILTMAX: 'Max Tilt',
  HOLD: 'Hold', MODE: 'Mode', MD: 'Mode', CHECK: 'Check',
  NOISE: 'Noise', DELAY: 'Latency', DECL: 'Declination', TYPE: 'Type',
  MASK: 'Mask', AID: 'Aid', HGT: 'Height', RNG: 'Range Finder',
  OFD: 'Optical Flow', EV: 'Vision', OF: 'Optical Flow',
  ABIAS: 'Accel Bias', GBIAS: 'Gyro Bias', ANGERR: 'Angle Error',
  MINHGT: 'Min Height', MAXHGT: 'Max Height', MAXR: 'Max Rate',
  BOARD: 'Board', QNH: 'QNH Pressure', OFF: 'Offset', W: 'Weight',
  N: 'Count', T: 'Time', A: 'Auto', TRIP: 'Trip', RAMP: 'Ramp',
  LAND: 'Land', AIR: 'Air', CELL: 'Cell', SCAL: 'Scale',
  ROLLRATE: 'Roll Rate', PITCHRATE: 'Pitch Rate', YAWRATE: 'Yaw Rate',
  ROLLSP: 'Roll Setpoint', PITCHSP: 'Pitch Setpoint', YAWSP: 'Yaw Setpoint',
  POSXY: 'Horizontal Position', POSUP: 'Upward Position',
  UPTHR: 'Hover Thrust', TTRI: 'Trigger Time', SCALER: 'Scaler',
  UUID: 'Flight ID', GRACE: 'Grace Period', REARM: 'Rearm',
  MAN_Y: 'Manual Yaw', VEL_P: 'Velocity P',
}

const KEY_PREFIXES_TO_STRIP: string[] = [
  'EKF2', 'LNDMC', 'LNDFW', 'SDLOG', 'CBRK', 'BAT1', 'BAT2', 'BAT',
  'COM', 'MPC', 'MOT', 'MC', 'NAV', 'RTL', 'GF', 'MIS', 'SYS', 'MAV',
  'PWM', 'CA', 'VT', 'ATT', 'FD', 'FW', 'SENS', 'CAL', 'RC', 'GND',
  'TRIG', 'ASPD', 'TC', 'TRIM', 'MIXER', 'UAVCAN', 'LAND',
]

export function humanizeParamKey(key: string): string {
  const parts = key.split('_')
  let startIdx = 1
  for (const prefix of KEY_PREFIXES_TO_STRIP) {
    if (key === prefix) return key
    if (key.startsWith(prefix + '_')) {
      startIdx = prefix.split('_').length
      break
    }
  }
  const rest = startIdx >= parts.length ? parts : parts.slice(startIdx)
  if (rest.length === 0) return key

  const expanded = rest.map(p => {
    const up = p.toUpperCase()
    if (KEY_WORDS[up]) return KEY_WORDS[up]
    // Compound word check (e.g. ROLLRATE → Roll Rate)
    for (const [kw, label] of Object.entries(KEY_WORDS)) {
      if (up === kw) return label
    }
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
  })
  return expanded.join(' ')
}

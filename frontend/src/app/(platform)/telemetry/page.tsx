'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useDroneStore } from '@/store/drone'
import { useMissionStore } from '@/store/mission'
import { getSocket } from '@/lib/socket'
import {
    Radio, Wifi, WifiOff, Check, RotateCcw,
    Plane, Gauge, SlidersHorizontal, Battery, Shield, Navigation,
    Terminal, Lock, Info, ChevronLeft,
    Search, AlertTriangle, Cpu, Move, Zap,
    Download, Upload, Power,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PX4_META, getGroupFromKey, humanizeParamKey, type PX4Group, type PX4Meta } from '@/lib/px4-params-meta'

function ls<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
    if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(val))
}
function hColor(pct: number, locked = false) {
    if (locked) return '#4b5563'
    if (pct >= 100) return '#4ade80'
    if (pct >= 65)  return '#22d3ee'
    if (pct >= 35)  return '#fbbf24'
    return '#f87171'
}

type SectionId = 'connection' | 'vehicle' | 'sensors' | 'radio' | 'power' | 'safety' | 'flight' | 'parameters'
type VehicleProfile = { name: string; airframe: string; firmware: string; frameId: string }
type PowerProfile   = { cells: string; capacity: string; warnPct: number; critPct: number; critAction: string }
type SafetyProfile  = { signalLoss: string; maxAltEnabled: boolean; maxAlt: number; maxDistEnabled: boolean; maxDist: number; rthAlt: number }
type FlightProfile  = { takeoffAlt: number; loiterRadius: number; rthMode: string }
type RadioProfile   = { rcMode: string; modes: string[] }

type ParamType = 'float' | 'int' | 'bool' | 'enum'
interface Param {
    key: string; name: string; desc: string; cat: string
    type: ParamType; val: number; def: number
    unit?: string; min?: number; max?: number; step?: number
    opts?: { v: number; l: string }[]
    expert?: boolean; danger?: boolean
}

const AIRFRAME_LABELS: Record<string, string> = {
    'quad-x': 'Quadrotor X', 'quad-plus': 'Quadrotor +', 'hex': 'Hexarotor',
    'octo': 'Octorotor', 'coaxial': 'Coaxial (custom)',
    'vtol-tilt': 'VTOL Tilt-Wing', 'vtol-tailsit': 'VTOL Tailsitter',
    'fixedwing': 'Fixed Wing', 'other': 'Custom',
}
const FLIGHT_MODES_LIST = ['Stabilize', 'Altitude Hold', 'Position', 'Mission', 'RTL', 'Loiter', 'Acro', 'Hold', 'Land']
const MAV_PRESETS = [
    { label: 'PX4 SITL (UDP)',        addr: 'udpin://0.0.0.0:14540' },
    { label: 'ArduPilot SITL',        addr: 'udpin://0.0.0.0:14550' },
    { label: 'USB / Telemetry Radio', addr: 'serial:///dev/ttyUSB0:57600' },
    { label: 'TCP (companion)',        addr: 'tcp://192.168.1.1:5760' },
]
const DOMAIN_META: { id: SectionId; label: string; icon: React.ElementType; desc: string }[] = [
    { id: 'connection', label: 'Connection',  icon: Radio,             desc: 'MAVLink link to your drone or SITL simulator' },
    { id: 'vehicle',    label: 'Vehicle',     icon: Plane,             desc: 'Drone identity, airframe type, and firmware' },
    { id: 'sensors',    label: 'Sensors',     icon: Gauge,             desc: 'Sensor health and EKF fusion pipeline' },
    { id: 'radio',      label: 'Radio & RC',  icon: SlidersHorizontal, desc: 'Stick layout and flight mode channel assignments' },
    { id: 'power',      label: 'Power',       icon: Battery,           desc: 'Battery pack configuration and failsafe thresholds' },
    { id: 'safety',     label: 'Safety',      icon: Shield,            desc: 'Failsafes, terrain following, and geofence limits' },
    { id: 'flight',     label: 'Flight',      icon: Navigation,        desc: 'Altitude defaults and return-to-home behaviour' },
    { id: 'parameters', label: 'Advanced',     icon: Terminal,          desc: '50+ PX4 parameters across 8 subsystems — search, browse, and edit' },
]

const PARAM_CATS = [
    { id: 'system',    label: 'System',           icon: Cpu,              color: '#22d3ee', desc: 'Core identity and MAVLink' },
    { id: 'position',  label: 'Position',         icon: Move,             color: '#4ade80', desc: 'Speed and position limits' },
    { id: 'attitude',  label: 'Attitude & PIDs',  icon: RotateCcw,        color: '#f97316', desc: 'Rate controllers and gains' },
    { id: 'battery',   label: 'Battery',          icon: Battery,          color: '#fbbf24', desc: 'Cell count and thresholds' },
    { id: 'safety',    label: 'Safety',           icon: Shield,           color: '#f87171', desc: 'Failsafes and geofence' },
    { id: 'nav',       label: 'Navigation',       icon: Navigation,       color: '#c084fc', desc: 'Mission waypoints' },
    { id: 'sensors',   label: 'Sensors & EKF',    icon: Gauge,            color: '#60a5fa', desc: 'Fusion weights and flags' },
    { id: 'actuators', label: 'Actuators',        icon: SlidersHorizontal,color: '#fb923c', desc: 'Motors and PWM outputs' },
]

const PARAMS_DB: Param[] = [
    // SYSTEM
    { key: 'SYS_AUTOSTART',    name: 'Airframe Preset ID',       desc: 'PX4 airframe preset loaded at boot. Changing this resets the entire mixer and output mapping to a new vehicle type.',  cat: 'system',    type: 'int',   val: 4302, def: 4001, min: 0,    max: 99999, step: 1,    expert: true,  danger: true },
    { key: 'MAV_SYS_ID',       name: 'MAVLink System ID',        desc: 'Unique identifier for this vehicle on the MAVLink network. Only change if running multiple drones on the same link.',     cat: 'system',    type: 'int',   val: 1,    def: 1,    min: 1,    max: 255,   step: 1 },
    { key: 'COM_ARM_EKF_POS',  name: 'EKF Position Arming Check',desc: 'Prevent arming if the EKF position estimate quality is below threshold. Strongly recommended to keep on.',              cat: 'system',    type: 'bool',  val: 1,    def: 1 },
    { key: 'CBRK_IO_SAFETY',   name: 'Skip Safety Switch',       desc: 'Bypass the hardware safety button. Set to 22027 to skip it entirely — useful for bench testing without a physical switch.', cat: 'system', type: 'int',   val: 0,    def: 0,    min: 0,    max: 22027, step: 22027, expert: true, danger: true },
    { key: 'SDLOG_MODE',        name: 'Log Recording Mode',       desc: 'When the flight log starts and stops recording to the SD card.',                                                           cat: 'system',    type: 'enum',  val: 1,    def: 1,    opts: [{ v: -1, l: 'Disabled' }, { v: 0, l: 'From boot' }, { v: 1, l: 'Arm → Disarm' }, { v: 2, l: 'Arm → Shutdown' }] },
    { key: 'SYS_MC_EST_GROUP', name: 'State Estimator',          desc: 'Which position and attitude estimator to use. EKF2 is recommended for all modern setups.',                                cat: 'system',    type: 'enum',  val: 2,    def: 2,    opts: [{ v: 1, l: 'Q-estimator (legacy)' }, { v: 2, l: 'EKF2 (recommended)' }], expert: true },
    { key: 'COM_RC_LOSS_T',    name: 'RC Signal Timeout',        desc: 'How many seconds after RC signal drops before the RC loss failsafe kicks in. Lower = faster response.',                   cat: 'system',    type: 'float', val: 0.5,  def: 0.5,  min: 0,    max: 35,    step: 0.1,  unit: 's' },

    // POSITION CONTROL
    { key: 'MPC_XY_VEL_MAX',   name: 'Max Horizontal Speed',     desc: 'Fastest the drone will move sideways or forwards in Position mode and autonomous missions. Reducing this makes the drone calmer.', cat: 'position', type: 'float', val: 12.0, def: 12.0, min: 0.5,  max: 25,    step: 0.5,  unit: 'm/s' },
    { key: 'MPC_Z_VEL_MAX_UP', name: 'Max Climb Rate',           desc: 'How fast the drone can ascend. Lower for smoother camera flights, higher for racing or quick altitude changes.',            cat: 'position',  type: 'float', val: 3.0,  def: 3.0,  min: 0.5,  max: 8,     step: 0.25, unit: 'm/s' },
    { key: 'MPC_Z_VEL_MAX_DN', name: 'Max Sink Rate',            desc: 'How fast the drone descends. Too fast risks propwash instability. Stay under 2 m/s for most setups.',                      cat: 'position',  type: 'float', val: 1.5,  def: 1.5,  min: 0.2,  max: 4,     step: 0.1,  unit: 'm/s' },
    { key: 'MPC_XY_CRUISE',    name: 'Mission Cruise Speed',     desc: 'Target forward speed used when flying autonomous waypoint missions.',                                                       cat: 'position',  type: 'float', val: 5.0,  def: 5.0,  min: 1,    max: 20,    step: 0.5,  unit: 'm/s' },
    { key: 'MPC_TILTMAX_AIR',  name: 'Max Lean Angle',           desc: 'How far the drone leans during fast movements. Higher angles allow faster flight but reduce stability margin.',             cat: 'position',  type: 'float', val: 35.0, def: 35.0, min: 5,    max: 85,    step: 1,    unit: '°' },
    { key: 'MPC_LAND_SPEED',   name: 'Auto-Land Speed',          desc: 'Descent rate during the final automatic landing phase. Keep low for gentle landings.',                                     cat: 'position',  type: 'float', val: 0.7,  def: 0.7,  min: 0.1,  max: 2,     step: 0.05, unit: 'm/s' },
    { key: 'MPC_TKO_SPEED',    name: 'Auto-Takeoff Speed',       desc: 'Ascent rate during automated takeoff. Lower = smoother departure.',                                                        cat: 'position',  type: 'float', val: 1.5,  def: 1.5,  min: 0.1,  max: 5,     step: 0.1,  unit: 'm/s' },
    { key: 'MPC_JERK_MAX',     name: 'Max Jerk',                 desc: 'How quickly the drone changes acceleration. Low = smooth (ideal for camera work). High = snappy. 0 to disable the limit.', cat: 'position', type: 'float', val: 8.0,  def: 8.0,  min: 0,    max: 20,    step: 0.5,  unit: 'm/s³', expert: true },

    // ATTITUDE & PIDs
    { key: 'MC_ROLL_P',        name: 'Roll Angle Gain',          desc: 'How aggressively the flight controller corrects roll angle. Too high causes oscillation; too low feels sluggish.',          cat: 'attitude',  type: 'float', val: 6.5,  def: 6.5,  min: 1,    max: 12,    step: 0.1,  expert: true, danger: true },
    { key: 'MC_PITCH_P',       name: 'Pitch Angle Gain',         desc: 'Strength of pitch correction. Should normally match roll gain on symmetric quads.',                                        cat: 'attitude',  type: 'float', val: 6.5,  def: 6.5,  min: 1,    max: 12,    step: 0.1,  expert: true, danger: true },
    { key: 'MC_YAW_P',         name: 'Yaw Angle Gain',           desc: 'Yaw heading correction strength. Lower than roll/pitch is normal since yaw authority is weaker.',                          cat: 'attitude',  type: 'float', val: 2.8,  def: 2.8,  min: 0.5,  max: 5,     step: 0.1,  expert: true },
    { key: 'MC_ROLLRATE_P',    name: 'Roll Rate P',              desc: 'Proportional gain for the roll rate loop. Increase for sharper roll response. Oscillation = too high.',                    cat: 'attitude',  type: 'float', val: 0.15, def: 0.15, min: 0.01, max: 0.5,   step: 0.01, expert: true, danger: true },
    { key: 'MC_PITCHRATE_P',   name: 'Pitch Rate P',             desc: 'Proportional gain for the pitch rate loop.',                                                                               cat: 'attitude',  type: 'float', val: 0.15, def: 0.15, min: 0.01, max: 0.5,   step: 0.01, expert: true, danger: true },
    { key: 'MC_YAWRATE_P',     name: 'Yaw Rate P',               desc: 'Proportional gain for the yaw rate loop.',                                                                                 cat: 'attitude',  type: 'float', val: 0.2,  def: 0.2,  min: 0.0,  max: 0.6,   step: 0.01, expert: true },
    { key: 'MC_ROLLRATE_I',    name: 'Roll Rate Integrator',     desc: 'Integral gain corrects steady-state roll errors that P alone cannot eliminate.',                                           cat: 'attitude',  type: 'float', val: 0.2,  def: 0.2,  min: 0.0,  max: 0.5,   step: 0.01, expert: true },
    { key: 'MPC_MAN_TILT_MAX', name: 'Manual Max Tilt',          desc: 'Max lean angle allowed when flying manually in Stabilize or Altitude Hold mode.',                                          cat: 'attitude',  type: 'float', val: 35.0, def: 35.0, min: 5,    max: 70,    step: 1,    unit: '°' },

    // BATTERY
    { key: 'BAT_N_CELLS',      name: 'Battery Cell Count (S)',   desc: 'Number of lithium cells wired in series. Critical — a wrong value causes incorrect voltage readings and false battery warnings.', cat: 'battery', type: 'int',  val: 4,    def: 4,    min: 1,    max: 14,    step: 1,    unit: 'S',   danger: true },
    { key: 'BAT_CAPACITY',     name: 'Pack Capacity',            desc: 'Total energy in the battery. Used to estimate remaining flight time and power consumed.',                                   cat: 'battery',   type: 'float', val: 5000, def: 5000, min: 100,  max: 100000,step: 100,  unit: 'mAh' },
    { key: 'BAT_LOW_THR',      name: 'Low Battery Warning',      desc: 'Percentage at which you get a low battery alert. Plan your return flight to land before this level.',                       cat: 'battery',   type: 'int',   val: 15,   def: 15,   min: 1,    max: 40,    step: 1,    unit: '%' },
    { key: 'BAT_CRIT_THR',    name: 'Critical Battery Level',   desc: 'Percentage at which the critical failsafe action triggers (usually auto-RTL).',                                            cat: 'battery',   type: 'int',   val: 7,    def: 7,    min: 1,    max: 30,    step: 1,    unit: '%' },
    { key: 'BAT_EMERGEN_THR', name: 'Emergency Land Level',     desc: 'Percentage at which the drone immediately lands regardless of what it was doing. Last resort.',                             cat: 'battery',   type: 'int',   val: 5,    def: 5,    min: 1,    max: 15,    step: 1,    unit: '%',   danger: true },
    { key: 'BAT_V_CHARGED',   name: 'Full-Charge Cell Voltage', desc: 'Voltage per cell when the battery is fully charged. 4.20V for standard LiPo, 4.35V for HV LiPo.',                        cat: 'battery',   type: 'float', val: 4.05, def: 4.05, min: 3.5,  max: 4.4,   step: 0.01, unit: 'V',   expert: true },
    { key: 'BAT_V_EMPTY',     name: 'Empty Cell Voltage',       desc: 'Minimum safe cell voltage. The battery is considered empty at this level.',                                                  cat: 'battery',   type: 'float', val: 3.5,  def: 3.5,  min: 2.5,  max: 3.7,   step: 0.01, unit: 'V',   expert: true },

    // SAFETY
    { key: 'NAV_RCL_ACT',     name: 'RC Signal Loss Action',    desc: 'What the autopilot does automatically when RC signal is lost. RTL is recommended for most pilots.',                         cat: 'safety',    type: 'enum',  val: 2,    def: 2,    opts: [{ v: 0, l: 'Disabled (not recommended)' }, { v: 1, l: 'Loiter in place' }, { v: 2, l: 'Return to Home (RTL)' }, { v: 3, l: 'Land immediately' }, { v: 5, l: '⚠ Terminate (cuts motors)' }], danger: true },
    { key: 'NAV_DLL_ACT',     name: 'Telemetry Loss Action',    desc: 'What happens if the GCS / telemetry link is lost mid-flight. Usually safe to leave disabled if you have RC.',               cat: 'safety',    type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'Disabled' }, { v: 1, l: 'Loiter' }, { v: 2, l: 'Return to Home' }, { v: 3, l: 'Land' }] },
    { key: 'GF_ACTION',       name: 'Geofence Breach Action',   desc: 'What happens when the drone flies past the geofence boundary.',                                                             cat: 'safety',    type: 'enum',  val: 1,    def: 1,    opts: [{ v: 0, l: 'None (warn only)' }, { v: 1, l: 'Return to Home' }, { v: 2, l: 'Land at fence' }, { v: 3, l: 'Loiter at fence' }] },
    { key: 'GF_MAX_HOR_DIST', name: 'Geofence Radius',          desc: 'Maximum horizontal distance from the home point. Set 0 to disable. Works with GF_ACTION above.',                           cat: 'safety',    type: 'float', val: 0,    def: 0,    min: 0,    max: 10000, step: 50,   unit: 'm' },
    { key: 'GF_MAX_VER_DIST', name: 'Geofence Altitude Ceiling',desc: 'Maximum altitude above home. 0 = no limit. Helps comply with local airspace rules.',                                       cat: 'safety',    type: 'float', val: 0,    def: 0,    min: 0,    max: 10000, step: 10,   unit: 'm' },
    { key: 'COM_DISARM_LAND', name: 'Auto-Disarm After Landing', desc: 'Seconds after landing is detected before motors automatically disarm. 0 = never auto-disarm.',                            cat: 'safety',    type: 'float', val: 2.0,  def: 2.0,  min: 0,    max: 20,    step: 0.5,  unit: 's' },
    { key: 'COM_LOW_BAT_ACT', name: 'Low Battery Behaviour',    desc: 'Sequence of actions as battery drains through low and critical thresholds.',                                               cat: 'safety',    type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'Warn only' }, { v: 1, l: 'RTL at low battery' }, { v: 2, l: 'RTL at critical' }, { v: 3, l: 'RTL at low, land at critical' }] },

    // NAVIGATION
    { key: 'NAV_ACC_RAD',     name: 'Waypoint Acceptance Radius',desc: 'How close the drone must get to a waypoint before it counts as reached and moves to the next one.',                        cat: 'nav',       type: 'float', val: 10.0, def: 10.0, min: 0.05, max: 200,   step: 0.5,  unit: 'm' },
    { key: 'NAV_LOITER_RAD',  name: 'Loiter Circle Radius',     desc: 'Radius of the holding pattern during loiter. Mainly relevant for fixed-wing. Multirotor loiters in place.',               cat: 'nav',       type: 'float', val: 50.0, def: 50.0, min: 10,   max: 1000,  step: 5,    unit: 'm' },
    { key: 'MIS_DIST_1WP',    name: 'Max First Waypoint Dist',  desc: 'Safety check — prevents uploading a mission whose first waypoint is further than this from the home position.',            cat: 'nav',       type: 'float', val: 900.0,def: 900.0,min: 0,    max: 10000, step: 50,   unit: 'm' },
    { key: 'MIS_TAKEOFF_ALT', name: 'Mission Takeoff Altitude', desc: 'Default height the drone climbs to at mission start if no explicit takeoff waypoint is in the plan.',                      cat: 'nav',       type: 'float', val: 10.0, def: 10.0, min: 0,    max: 100,   step: 1,    unit: 'm' },
    { key: 'RTL_RETURN_ALT',  name: 'RTL Cruise Altitude',      desc: 'Altitude the drone flies at when returning home during RTL. Must clear all obstacles along the return path.',              cat: 'nav',       type: 'float', val: 60.0, def: 60.0, min: 0,    max: 150,   step: 5,    unit: 'm' },
    { key: 'RTL_LAND_DELAY',  name: 'RTL Hover Before Landing', desc: 'Seconds the drone hovers above home before beginning its final descent. -1 = no hover, land immediately.',                 cat: 'nav',       type: 'float', val: -1.0, def: -1.0, min: -1,   max: 300,   step: 1,    unit: 's' },
    { key: 'COM_TAKEOFF_ACT', name: 'Post-Takeoff Behaviour',   desc: 'What the drone does after a commanded auto-takeoff completes.',                                                             cat: 'nav',       type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'Loiter in place' }, { v: 1, l: 'Begin mission' }] },

    // SENSORS & EKF
    { key: 'EKF2_AID_MASK',   name: 'Sensor Fusion Flags',      desc: 'Bitmask controlling which sensors feed the EKF. Bit 0 = GPS, bit 1 = optical flow, bit 2 = vision pose. Each bit enables a source.', cat: 'sensors', type: 'int', val: 1, def: 1, min: 0, max: 511, step: 1, expert: true, danger: true },
    { key: 'EKF2_MAG_TYPE',   name: 'Compass Fusion Mode',      desc: 'How the magnetometer reading is incorporated into the EKF position estimate.',                                             cat: 'sensors',   type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'Automatic' }, { v: 1, l: 'Full 3D fusion' }, { v: 2, l: 'Heading only' }, { v: 3, l: 'Disabled' }], expert: true },
    { key: 'EKF2_BARO_NOISE', name: 'Barometer Noise Level',    desc: 'How noisy you expect the barometer data to be. Higher = EKF trusts baro less and relies more on GPS altitude.',           cat: 'sensors',   type: 'float', val: 3.5,  def: 3.5,  min: 0.01, max: 15,    step: 0.1,  unit: 'm',   expert: true },
    { key: 'EKF2_GPS_DELAY',  name: 'GPS Data Latency',         desc: 'Time delay between when GPS samples position and when the EKF receives that data. Match to your GPS unit spec.',           cat: 'sensors',   type: 'float', val: 110.0,def: 110.0,min: 0,    max: 300,   step: 1,    unit: 'ms',  expert: true },
    { key: 'EKF2_HGT_MODE',   name: 'Primary Altitude Source',  desc: 'Which sensor the EKF uses as the primary source for height / altitude estimation.',                                        cat: 'sensors',   type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'Barometer' }, { v: 1, l: 'GPS' }, { v: 2, l: 'Range Finder' }, { v: 3, l: 'Vision Pose' }], expert: true },
    { key: 'EKF2_GPS_CHECK',  name: 'GPS Arming Checks',        desc: 'Bitmask of GPS quality requirements that must be met before arming is allowed.',                                           cat: 'sensors',   type: 'int',   val: 245,  def: 245,  min: 0,    max: 511,   step: 1,     expert: true },
    { key: 'CAL_MAG_SIDES',   name: 'Compass Cal Orientations', desc: 'How many different orientations to hold the drone in during compass calibration. More sides = more accurate calibration.',  cat: 'sensors',   type: 'int',   val: 34,   def: 34,   min: 1,    max: 63,    step: 1 },

    // ACTUATORS
    { key: 'PWM_MAIN_MIN',    name: 'Motor PWM Minimum',        desc: 'Minimum pulse width sent to ESCs. Should match what your ESC recognises as the lowest throttle point. Test carefully.',    cat: 'actuators', type: 'int',   val: 1000, def: 1000, min: 800,  max: 1400,  step: 10,   unit: 'μs',  danger: true },
    { key: 'PWM_MAIN_MAX',    name: 'Motor PWM Maximum',        desc: 'Maximum pulse width sent to ESCs. Should match your ESC\'s full-throttle calibration point.',                              cat: 'actuators', type: 'int',   val: 2000, def: 2000, min: 1600, max: 2200,  step: 10,   unit: 'μs',  danger: true },
    { key: 'PWM_MAIN_DISARM', name: 'Disarmed PWM Signal',      desc: 'Pulse sent to ESCs while disarmed. Typically below PWM_MAIN_MIN so motors stay stopped.',                                 cat: 'actuators', type: 'int',   val: 900,  def: 900,  min: 0,    max: 2200,  step: 10,   unit: 'μs',  danger: true },
    { key: 'MOT_SPIN_MIN',    name: 'Minimum Motor Spin',       desc: 'Lowest throttle level that keeps all motors spinning. Prevents unexpected motor stalls near zero throttle.',              cat: 'actuators', type: 'float', val: 0.12, def: 0.12, min: 0,    max: 0.4,   step: 0.01, expert: true },
    { key: 'THR_MDL_FAC',     name: 'Thrust Curve Factor',      desc: 'Linearises the throttle→thrust relationship. 0 = linear (default). Tune for your motor + propeller combination.',         cat: 'actuators', type: 'float', val: 0.0,  def: 0.0,  min: 0,    max: 1,     step: 0.01, expert: true },
    { key: 'MOT_ORDERING',    name: 'Motor Numbering Convention',desc: 'Motor numbering scheme. Must match what is printed or labeled on your flight controller board.',                           cat: 'actuators', type: 'enum',  val: 0,    def: 0,    opts: [{ v: 0, l: 'PX4 standard' }, { v: 1, l: 'Betaflight / CleanFlight' }], danger: true },
    { key: 'CA_ROTOR_COUNT',  name: 'Number of Rotors',         desc: 'Physical rotor count on the vehicle. Must match the airframe geometry — a mismatch will prevent correct mixing.',          cat: 'actuators', type: 'int',   val: 4,    def: 4,    min: 1,    max: 12,    step: 1,     danger: true },
]

// ── Base SVG ──────────────────────────────────────────────────────────────────

function DroneSVG({ airframe, size = 56 }: { airframe: string; size?: number }) {
    const s = size, c = s / 2
    if (airframe === 'coaxial') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            <circle cx={c} cy={c} r={s*0.32} stroke="#22d3ee" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.35} />
            <circle cx={c} cy={c} r={s*0.16} fill="#22d3ee" opacity={0.15} stroke="#22d3ee" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.06} fill="#22d3ee" opacity={0.9} />
            <line x1={c} y1={c} x2={c} y2={s*0.22} stroke="#22d3ee" strokeWidth={2} opacity={0.5} />
            <polygon points={`${c},${s*0.14} ${c-s*0.055},${s*0.25} ${c+s*0.055},${s*0.25}`} fill="#22d3ee" opacity={0.8} />
        </svg>
    )
    if (airframe === 'hex') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            {[0,60,120,180,240,300].map((deg, i) => {
                const rad = (deg - 90) * Math.PI / 180, r = s * 0.34
                const x = c + r * Math.cos(rad), y = c + r * Math.sin(rad)
                return <g key={i}><line x1={c} y1={c} x2={x} y2={y} stroke="#22d3ee" strokeWidth={1.5} opacity={0.4} /><circle cx={x} cy={y} r={s*0.1} fill="#22d3ee" opacity={0.1} stroke="#22d3ee" strokeWidth={1.2} /></g>
            })}
            <circle cx={c} cy={c} r={s*0.13} fill="#22d3ee" opacity={0.15} stroke="#22d3ee" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.055} fill="#22d3ee" opacity={0.9} />
            <polygon points={`${c},${c-s*0.12} ${c-s*0.055},${c-s*0.02} ${c+s*0.055},${c-s*0.02}`} fill="#22d3ee" opacity={0.8} />
        </svg>
    )
    if (airframe === 'vtol-tilt') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            <ellipse cx={c} cy={c} rx={s*0.07} ry={s*0.22} fill="#22d3ee" opacity={0.18} stroke="#22d3ee" strokeWidth={1.3} />
            <ellipse cx={s*0.25} cy={c} rx={s*0.18} ry={s*0.055} fill="#22d3ee" opacity={0.1} stroke="#22d3ee" strokeWidth={1} />
            <ellipse cx={s*0.75} cy={c} rx={s*0.18} ry={s*0.055} fill="#22d3ee" opacity={0.1} stroke="#22d3ee" strokeWidth={1} />
            {[s*0.14, s*0.37, s*0.63, s*0.86].map((x, i) => <circle key={i} cx={x} cy={s*0.38} r={s*0.08} fill="#22d3ee" opacity={0.1} stroke="#22d3ee" strokeWidth={1} />)}
            <polygon points={`${c},${s*0.28} ${c-s*0.055},${s*0.4} ${c+s*0.055},${s*0.4}`} fill="#22d3ee" opacity={0.8} />
        </svg>
    )
    return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            {[[s*0.21,s*0.21],[s*0.79,s*0.21],[s*0.21,s*0.79],[s*0.79,s*0.79]].map(([x,y],i) => (
                <g key={i}><line x1={c} y1={c} x2={x} y2={y} stroke="#22d3ee" strokeWidth={1.8} opacity={0.4} /><circle cx={x} cy={y} r={s*0.14} fill="#22d3ee" opacity={0.1} stroke="#22d3ee" strokeWidth={1.5} /></g>
            ))}
            <circle cx={c} cy={c} r={s*0.14} fill="#22d3ee" opacity={0.18} stroke="#22d3ee" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.063} fill="#22d3ee" opacity={0.9} />
            <polygon points={`${c},${c-s*0.15} ${c-s*0.055},${c-s*0.05} ${c+s*0.055},${c-s*0.05}`} fill="#22d3ee" opacity={0.8} />
        </svg>
    )
}

function StatusRing({ pct, color, size = 44 }: { pct: number; color: string; size?: number }) {
    const r = (size - 7) / 2, circ = 2 * Math.PI * r
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(128,128,128,0.15)" strokeWidth={3.5} />
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={3.5} strokeDasharray={`${circ * pct / 100} ${circ}`} strokeLinecap="round" />
        </svg>
    )
}

// ── Visual instruments ────────────────────────────────────────────────────────

function NetworkTopology({ connected, address }: { connected: boolean; address: string }) {
    const proto = address.split('://')[0]?.toUpperCase() ?? 'UDP'
    const host  = address.split('://')[1]?.split(':')[0] ?? '—'
    const lc = connected ? '#22d3ee' : 'rgba(75,85,99,0.6)'
    const lc2 = connected ? '#4ade80' : 'rgba(75,85,99,0.6)'
    return (
        <svg viewBox="0 0 340 64" style={{ width: '100%', display: 'block', overflow: 'visible' }}>
            {/* GCS */}
            <rect x={2} y={18} width={60} height={28} rx={6} fill="rgba(34,211,238,0.08)" stroke="#22d3ee" strokeWidth={1.5} />
            <text x={32} y={30} textAnchor="middle" fontSize={9} fontFamily="monospace" fontWeight="700" fill="#22d3ee">GCS</text>
            <text x={32} y={42} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(255,255,255,0.3)">hyrak</text>
            {/* Line 1 */}
            <line x1={62} y1={32} x2={118} y2={32} stroke={lc} strokeWidth={1.5} strokeDasharray={connected ? undefined : '4 3'} />
            {connected && <circle r={2.5} fill="#22d3ee"><animateMotion dur="1.4s" repeatCount="indefinite" path="M 62,32 L 118,32" /></circle>}
            {/* Link node */}
            <rect x={118} y={18} width={84} height={28} rx={6} fill={connected ? 'rgba(34,211,238,0.06)' : 'rgba(75,85,99,0.06)'} stroke={lc} strokeWidth={1.5} />
            <text x={160} y={30} textAnchor="middle" fontSize={9} fontFamily="monospace" fontWeight="700" fill={lc}>{proto}</text>
            <text x={160} y={42} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(255,255,255,0.25)">{host}</text>
            {/* Line 2 */}
            <line x1={202} y1={32} x2={258} y2={32} stroke={lc2} strokeWidth={1.5} strokeDasharray={connected ? undefined : '4 3'} />
            {connected && <circle r={2.5} fill="#4ade80"><animateMotion dur="1.4s" repeatCount="indefinite" path="M 202,32 L 258,32" begin="0.7s" /></circle>}
            {/* FC */}
            <rect x={258} y={18} width={60} height={28} rx={6} fill={connected ? 'rgba(74,222,128,0.08)' : 'rgba(75,85,99,0.06)'} stroke={lc2} strokeWidth={1.5} />
            <text x={288} y={30} textAnchor="middle" fontSize={9} fontFamily="monospace" fontWeight="700" fill={lc2}>FC</text>
            <text x={288} y={42} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(255,255,255,0.25)">autopilot</text>
            {/* Labels */}
            <text x={90} y={14} textAnchor="middle" fontSize={7} fontFamily="monospace" fill={connected ? 'rgba(34,211,238,0.6)' : 'rgba(75,85,99,0.5)'}>MAVLink</text>
            <text x={230} y={14} textAnchor="middle" fontSize={7} fontFamily="monospace" fill={connected ? 'rgba(74,222,128,0.6)' : 'rgba(75,85,99,0.5)'}>MAVSDK</text>
        </svg>
    )
}

function EKFFlow({ states }: { states: { gps: boolean|null; imu: boolean|null; mag: boolean|null; baro: boolean|null } }) {
    const sensors: { key: keyof typeof states; label: string; y: number }[] = [
        { key: 'gps',  label: 'GPS',  y: 6  },
        { key: 'imu',  label: 'IMU',  y: 24 },
        { key: 'mag',  label: 'MAG',  y: 42 },
        { key: 'baro', label: 'BARO', y: 60 },
    ]
    return (
        <svg viewBox="0 0 340 80" style={{ width: '100%', display: 'block' }}>
            {sensors.map(s => {
                const ok = states[s.key]
                const c = ok === null ? '#4b5563' : ok ? '#4ade80' : '#f87171'
                return (
                    <g key={s.key}>
                        <rect x={2} y={s.y} width={48} height={14} rx={4} fill={`${c}18`} stroke={c} strokeWidth={1} />
                        <text x={26} y={s.y+10} textAnchor="middle" fontSize={8} fontFamily="monospace" fontWeight="700" fill={c}>{s.label}</text>
                        <line x1={50} y1={s.y+7} x2={118} y2={38} stroke={c} strokeWidth={0.8} opacity={0.4} />
                    </g>
                )
            })}
            {/* EKF */}
            <rect x={118} y={22} width={56} height={32} rx={6} fill="rgba(34,211,238,0.1)" stroke="#22d3ee" strokeWidth={1.5} />
            <text x={146} y={35} textAnchor="middle" fontSize={9} fontFamily="monospace" fontWeight="700" fill="#22d3ee">EKF</text>
            <text x={146} y={47} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(34,211,238,0.5)">FUSION</text>
            {/* EKF → POS */}
            <line x1={174} y1={38} x2={226} y2={38} stroke="#22d3ee" strokeWidth={1.5} opacity={0.5} />
            <polygon points="226,34 234,38 226,42" fill="#22d3ee" opacity={0.5} />
            {/* POS ESTIM */}
            <rect x={234} y={22} width={56} height={32} rx={6} fill="rgba(251,191,36,0.08)" stroke="#fbbf24" strokeWidth={1} />
            <text x={262} y={35} textAnchor="middle" fontSize={9} fontFamily="monospace" fontWeight="700" fill="#fbbf24">POS</text>
            <text x={262} y={47} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(251,191,36,0.5)">ESTIM</text>
            {/* POS → FC */}
            <line x1={290} y1={38} x2={320} y2={38} stroke="#fbbf24" strokeWidth={1.5} opacity={0.4} />
            <polygon points="320,34 328,38 320,42" fill="#fbbf24" opacity={0.4} />
            <rect x={328} y={26} width={10} height={24} rx={3} fill="rgba(74,222,128,0.1)" stroke="#4ade80" strokeWidth={1} />
        </svg>
    )
}

function CompassGauge({ heading, size = 96 }: { heading: number | null; size?: number }) {
    const c = size / 2, r = c - 6
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={c} cy={c} r={r} fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
            {Array.from({ length: 36 }, (_, i) => {
                const deg = i * 10, rad = (deg - 90) * Math.PI / 180
                const isMaj = deg % 90 === 0, len = isMaj ? 8 : 4
                return <line key={deg} x1={c+(r-len)*Math.cos(rad)} y1={c+(r-len)*Math.sin(rad)} x2={c+r*Math.cos(rad)} y2={c+r*Math.sin(rad)} stroke={isMaj ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)'} strokeWidth={isMaj ? 1.5 : 0.8} />
            })}
            {([['N',0,'#f87171'],['E',90,'rgba(255,255,255,0.35)'],['S',180,'rgba(255,255,255,0.35)'],['W',270,'rgba(255,255,255,0.35)']] as const).map(([l,d,col]) => {
                const rad = (d-90)*Math.PI/180
                return <text key={l} x={c+(r-13)*Math.cos(rad)} y={c+(r-13)*Math.sin(rad)+3} textAnchor="middle" fontSize={7} fontFamily="monospace" fontWeight="700" fill={col}>{l}</text>
            })}
            {heading !== null ? (
                <g transform={`rotate(${heading} ${c} ${c})`}>
                    <polygon points={`${c},${c-r+12} ${c-4},${c+10} ${c},${c+6} ${c+4},${c+10}`} fill="#f87171" opacity={0.9} />
                    <polygon points={`${c},${c+r-12} ${c-4},${c-10} ${c},${c-6} ${c+4},${c-10}`} fill="rgba(255,255,255,0.15)" />
                </g>
            ) : null}
            <circle cx={c} cy={c} r={3} fill="hsl(var(--app-surface))" stroke="rgba(255,255,255,0.3)" strokeWidth={1.2} />
            <text x={c} y={size-4} textAnchor="middle" fontSize={8} fontFamily="monospace" fill={heading !== null ? '#22d3ee' : 'rgba(255,255,255,0.2)'}>{heading !== null ? `${heading.toFixed(0)}°` : '—'}</text>
        </svg>
    )
}

function AltBar({ alt, label }: { alt: number | null; label: string }) {
    const pct = alt !== null ? Math.min(Math.max((alt / 150) * 100, 0), 100) : 0
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <div style={{ position: 'relative', width: 18, height: 72, borderRadius: 5, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${pct}%`, background: 'linear-gradient(to top, #22d3ee, rgba(34,211,238,0.3))', transition: 'height 0.5s ease' }} />
                {[25,50,75].map(p => <div key={p} style={{ position: 'absolute', left: 0, right: 0, bottom: `${p}%`, height: 1, background: 'rgba(255,255,255,0.06)' }} />)}
            </div>
            <span style={{ fontSize: 9, fontFamily: 'monospace', color: alt !== null ? '#22d3ee' : '#4b5563', fontWeight: 600 }}>{alt !== null ? `${alt.toFixed(0)}m` : '—'}</span>
            <span style={{ fontSize: 8, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.05em' }}>{label}</span>
        </div>
    )
}

function BatteryCellsViz({ cells, totalV }: { cells: string; totalV?: number }) {
    const n = Math.min(parseInt(cells) || 4, 12)
    const estV = totalV ? totalV / n : 4.1
    const fillPct = Math.min(Math.max(((estV - 3.0) / (4.2 - 3.0)) * 100, 0), 100)
    const cellColor = fillPct > 60 ? '#22d3ee' : fillPct > 30 ? '#fbbf24' : '#f87171'
    return (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
            <div style={{ width: 6, height: 22, background: 'rgba(255,255,255,0.12)', borderRadius: 2, alignSelf: 'center' }} />
            {Array.from({ length: n }, (_, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <div style={{ width: 8, height: 5, background: `${cellColor}60`, borderRadius: '2px 2px 0 0' }} />
                    <div style={{ width: 20, height: 52, borderRadius: 3, background: 'rgba(0,0,0,0.4)', border: `1.5px solid ${cellColor}40`, position: 'relative', overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${fillPct}%`, background: `linear-gradient(to top, ${cellColor}, ${cellColor}40)` }} />
                        <span style={{ position: 'absolute', bottom: 2, left: 0, right: 0, textAlign: 'center', fontSize: 6, fontFamily: 'monospace', color: 'rgba(255,255,255,0.5)', lineHeight: 1 }}>{estV.toFixed(1)}</span>
                    </div>
                    <span style={{ fontSize: 7, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)' }}>S{i+1}</span>
                </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <div style={{ width: 8, height: 8, background: '#4ade80', borderRadius: 1, opacity: 0.7 }} />
                <div style={{ width: 6, height: 18, background: 'rgba(255,255,255,0.12)', borderRadius: 2 }} />
            </div>
        </div>
    )
}

function DischargeCurve({ warnPct, critPct }: { warnPct: number; critPct: number }) {
    const W = 200, H = 72
    const warnX = (1 - warnPct / 100) * W
    const critX = (1 - critPct / 100) * W
    const curve = `M 0,${H*0.04} C ${W*0.12},${H*0.08} ${W*0.35},${H*0.18} ${W*0.62},${H*0.24} C ${W*0.78},${H*0.3} ${W*0.88},${H*0.56} ${W},${H*0.97}`
    return (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
            <defs><clipPath id="dcc"><rect x={0} y={0} width={W} height={H} /></clipPath></defs>
            <rect x={0} y={0} width={critX} height={H} fill="rgba(248,113,113,0.07)" clipPath="url(#dcc)" />
            <rect x={critX} y={0} width={warnX-critX} height={H} fill="rgba(251,191,36,0.06)" clipPath="url(#dcc)" />
            <rect x={warnX} y={0} width={W-warnX} height={H} fill="rgba(74,222,128,0.04)" clipPath="url(#dcc)" />
            <path d={`${curve} L ${W},${H} L 0,${H} Z`} fill="rgba(34,211,238,0.05)" />
            <path d={curve} fill="none" stroke="#22d3ee" strokeWidth={1.8} opacity={0.7} />
            <line x1={warnX} y1={0} x2={warnX} y2={H} stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={warnX-3} y={10} textAnchor="end" fontSize={7} fontFamily="monospace" fill="#fbbf24">{warnPct}%</text>
            <line x1={critX} y1={0} x2={critX} y2={H} stroke="#f87171" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={critX-3} y={10} textAnchor="end" fontSize={7} fontFamily="monospace" fill="#f87171">{critPct}%</text>
            <text x={1} y={H-2} fontSize={6} fontFamily="monospace" fill="rgba(255,255,255,0.18)">100% · 4.2V</text>
            <text x={W-1} y={H-2} textAnchor="end" fontSize={6} fontFamily="monospace" fill="rgba(255,255,255,0.18)">0% · 3.0V</text>
        </svg>
    )
}

function GeofenceMap({ maxDist, maxDistEnabled, rthAlt }: { maxDist: number; maxDistEnabled: boolean; rthAlt: number }) {
    const labels: [string, number, string][] = [['N',0,'#f87171'],['E',90,'rgba(255,255,255,0.3)'],['S',180,'rgba(255,255,255,0.3)'],['W',270,'rgba(255,255,255,0.3)']]
    return (
        <svg viewBox="-112 -112 224 224" style={{ width: '100%', display: 'block' }}>
            <defs>
                <radialGradient id="gfbg" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="rgba(34,211,238,0.04)" />
                    <stop offset="100%" stopColor="rgba(0,0,0,0)" />
                </radialGradient>
            </defs>
            <circle r={106} fill="#090e14" />
            <circle r={106} fill="url(#gfbg)" />
            {[-80,-60,-40,-20,0,20,40,60,80].map(v => (
                <g key={v}>
                    <line x1={v} y1={-100} x2={v} y2={100} stroke="rgba(255,255,255,0.025)" strokeWidth={0.5} />
                    <line x1={-100} y1={v} x2={100} y2={v} stroke="rgba(255,255,255,0.025)" strokeWidth={0.5} />
                </g>
            ))}
            <circle r={100} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} />
            {[30,60,90,120,150,180,210,240,270,300,330,0].map(d => {
                const rad=(d-90)*Math.PI/180
                return <line key={d} x1={96*Math.cos(rad)} y1={96*Math.sin(rad)} x2={100*Math.cos(rad)} y2={100*Math.sin(rad)} stroke="rgba(255,255,255,0.12)" strokeWidth={d%90===0?1.5:0.5} />
            })}
            {labels.map(([l,d,col]) => {
                const rad=(d-90)*Math.PI/180
                return <text key={l} x={82*Math.cos(rad)} y={82*Math.sin(rad)+3} textAnchor="middle" fontSize={8} fontFamily="monospace" fontWeight="700" fill={col}>{l}</text>
            })}
            {/* Safe zone */}
            <circle r={48} fill="rgba(74,222,128,0.03)" stroke="rgba(74,222,128,0.15)" strokeWidth={1} strokeDasharray="2 5" />
            {/* Max distance fence */}
            {maxDistEnabled ? (
                <>
                    <circle r={78} fill="rgba(248,113,113,0.04)" stroke="#f87171" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.7} />
                    <text x={80} y={-3} fontSize={7} fontFamily="monospace" fill="#f87171">{maxDist}m</text>
                </>
            ) : (
                <circle r={78} fill="none" stroke="rgba(75,85,99,0.2)" strokeWidth={1} strokeDasharray="4 4" />
            )}
            {/* RTH circle (indicates RTH altitude conceptually) */}
            <circle r={28} fill="none" stroke="rgba(34,211,238,0.12)" strokeWidth={0.8} strokeDasharray="2 5" />
            {/* Home */}
            <circle r={5} fill="#22d3ee" opacity={0.9} />
            <line x1={0} y1={0} x2={0} y2={-10} stroke="#22d3ee" strokeWidth={1.5} opacity={0.7} />
            <text x={7} y={-8} fontSize={7} fontFamily="monospace" fill="#22d3ee">H</text>
            <text x={0} y={-31} textAnchor="middle" fontSize={6} fontFamily="monospace" fill="rgba(34,211,238,0.45)">RTH {rthAlt}m</text>
        </svg>
    )
}

function AltitudeProfile({ takeoffAlt, rthAlt, maxAlt, maxAltEnabled }: { takeoffAlt: number; rthAlt: number; maxAlt: number; maxAltEnabled: boolean }) {
    const H = 90, W = 260
    const ceiling = maxAltEnabled ? Math.max(maxAlt, rthAlt * 1.2) : Math.max(rthAlt * 1.4, 60)
    const py = (alt: number) => H - (alt / ceiling) * H * 0.88
    const ty = py(takeoffAlt), ry = py(rthAlt), my = maxAltEnabled ? py(maxAlt) : 0
    return (
        <svg viewBox={`0 0 ${W} ${H+22}`} style={{ width: '100%', display: 'block' }}>
            {/* Sky gradient */}
            <defs>
                <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(34,211,238,0.06)" />
                    <stop offset="100%" stopColor="rgba(34,211,238,0)" />
                </linearGradient>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="url(#sky)" />
            {/* Ceiling */}
            {maxAltEnabled && <>
                <rect x={0} y={0} width={W} height={my} fill="rgba(248,113,113,0.04)" />
                <line x1={0} y1={my} x2={W} y2={my} stroke="#f87171" strokeWidth={1.5} strokeDasharray="6 3" />
                <text x={W-4} y={my-4} textAnchor="end" fontSize={7} fontFamily="monospace" fill="#f87171">{maxAlt}m ceiling</text>
            </>}
            {/* RTH altitude */}
            <line x1={0} y1={ry} x2={W} y2={ry} stroke="#22d3ee" strokeWidth={1} strokeDasharray="6 4" opacity={0.45} />
            <text x={W-4} y={ry-4} textAnchor="end" fontSize={7} fontFamily="monospace" fill="rgba(34,211,238,0.6)">RTH {rthAlt}m</text>
            {/* Takeoff */}
            <line x1={44} y1={H} x2={44} y2={ty} stroke="#4ade80" strokeWidth={2.5} opacity={0.7} />
            <polygon points={`${44},${ty-9} ${40},${ty} ${48},${ty}`} fill="#4ade80" opacity={0.8} />
            <circle cx={44} cy={ty} r={3.5} fill="#4ade80" />
            <text x={50} y={ty+4} fontSize={7} fontFamily="monospace" fill="#4ade80">{takeoffAlt}m</text>
            {/* RTH flight path */}
            <path d={`M 110,${ty} L 110,${ry} L 200,${ry}`} fill="none" stroke="#22d3ee" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.35} />
            <text x={204} y={ry+4} fontSize={7} fontFamily="monospace" fill="rgba(34,211,238,0.45)">→ H</text>
            {/* Ground */}
            <rect x={0} y={H} width={W} height={22} fill="rgba(74,222,128,0.06)" />
            <line x1={0} y1={H} x2={W} y2={H} stroke="rgba(74,222,128,0.4)" strokeWidth={1.5} />
            <text x={44} y={H+15} textAnchor="middle" fontSize={8} fontFamily="monospace" fill="rgba(255,255,255,0.25)">H</text>
            <text x={W-4} y={H+15} textAnchor="end" fontSize={7} fontFamily="monospace" fill="rgba(255,255,255,0.15)">0m AGL</text>
        </svg>
    )
}

// ── Primitives ────────────────────────────────────────────────────────────────

function Tip({ text }: { text: string }) {
    return (
        <Tooltip>
            <TooltipTrigger style={{ background: 'none', border: 'none', padding: 0, cursor: 'help', display: 'flex' }}><Info size={11} style={{ color: 'hsl(var(--app-text-muted))' }} /></TooltipTrigger>
            <TooltipContent style={{ maxWidth: 220, fontSize: 11, lineHeight: 1.5 }}>{text}</TooltipContent>
        </Tooltip>
    )
}
function Label({ text, tip }: { text: string; tip?: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em', color: 'hsl(var(--app-text-muted))' }}>{text}</span>
            {tip && <Tip text={tip} />}
        </div>
    )
}
function Field({ label, tip, children, span2 }: { label: string; tip?: string; children: React.ReactNode; span2?: boolean }) {
    return <div style={span2 ? { gridColumn: 'span 2' } : {}}><Label text={label} tip={tip} />{children}</div>
}
function AppInput({ value, onChange, placeholder, disabled }: { value: string; onChange?: (v: string) => void; placeholder?: string; disabled?: boolean }) {
    return <input value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder} disabled={disabled} style={{ width: '100%', padding: '9px 11px', borderRadius: 8, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: disabled ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', outline: 'none', opacity: disabled ? 0.6 : 1, boxSizing: 'border-box' }} />
}
function AppSelect<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
    return <select value={value} onChange={e => onChange(e.target.value as T)} disabled={disabled} style={{ width: '100%', padding: '9px 11px', borderRadius: 8, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text))', fontSize: 12, fontFamily: 'monospace', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, outline: 'none' }}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
}
function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
    return <div onClick={disabled ? undefined : onChange} style={{ width: 40, height: 22, borderRadius: 11, cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0, background: value ? '#22d3ee' : 'hsl(var(--app-border))', position: 'relative', transition: 'background 0.18s', opacity: disabled ? 0.5 : 1 }}><div style={{ position: 'absolute', top: 4, width: 14, height: 14, borderRadius: '50%', background: 'white', left: value ? 22 : 4, transition: 'left 0.18s' }} /></div>
}
function LockedNote({ text }: { text: string }) {
    return <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 12px', borderRadius: 8, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.18)' }}><Lock size={11} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }} /><span style={{ fontSize: 11, fontFamily: 'monospace', color: '#fbbf24', lineHeight: 1.5 }}>{text}</span></div>
}

// ── Layout shells ─────────────────────────────────────────────────────────────

// A dark instrument panel block (no card border — feels embedded rather than floating)
function Panel({ title, children, accent }: { title?: string; children: React.ReactNode; accent?: string }) {
    return (
        <div style={{ borderRadius: 10, background: '#0b1019', border: `1px solid ${accent ? `${accent}22` : 'rgba(255,255,255,0.06)'}`, overflow: 'hidden' }}>
            {title && <div style={{ padding: '7px 14px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.12em', color: accent ?? 'rgba(255,255,255,0.25)', borderBottom: `1px solid ${accent ? `${accent}18` : 'rgba(255,255,255,0.05)'}` }}>{title}</div>}
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
        </div>
    )
}
// Light surface card for settings/form content
function Card({ title, children }: { title?: string; children: React.ReactNode }) {
    return (
        <div style={{ borderRadius: 10, border: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface-2))', overflow: 'hidden' }}>
            {title && <div style={{ padding: '8px 14px', fontSize: 10, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.1em', color: 'hsl(var(--app-text-muted))', borderBottom: '1px solid hsl(var(--app-border))' }}>{title}</div>}
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
        </div>
    )
}
function G2({ children, gap = 14 }: { children: React.ReactNode; gap?: number }) {
    return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap, alignItems: 'start' }}>{children}</div>
}

// ── Domain Card ───────────────────────────────────────────────────────────────

function DomainCard({ id, label, icon: Icon, pct, color, metrics, locked, onClick }: {
    id: SectionId; label: string; icon: React.ElementType
    pct: number; color: string; metrics: { k: string; v: string }[]
    locked?: boolean; onClick: () => void
}) {
    return (
        <button onClick={onClick} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', borderRadius: 12, textAlign: 'left', cursor: 'pointer', width: '100%', border: '1.5px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface-2))', transition: 'all 0.15s', opacity: locked ? 0.5 : 1 }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = `${color}80`; el.style.background = 'hsl(var(--app-surface))' }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'hsl(var(--app-border))'; el.style.background = 'hsl(var(--app-surface-2))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Icon size={13} style={{ color }} />
                    <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.1em', color: 'hsl(var(--app-text-muted))' }}>{label}</span>
                </div>
                <StatusRing pct={pct} color={color} size={36} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {metrics.map((m, i) => (
                    <div key={i} style={{ display: 'flex', gap: 5 }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', flexShrink: 0 }}>{m.k}</span>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text))', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.v}</span>
                    </div>
                ))}
            </div>
        </button>
    )
}

// ── Vehicle Banner ────────────────────────────────────────────────────────────

function VehicleBanner({ vehicle, readiness, telStatus, address }: { vehicle: VehicleProfile; readiness: number; telStatus: string; address: string }) {
    const connected = telStatus === 'connected', rc = hColor(readiness)
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 20px', borderBottom: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface-2))', flexShrink: 0 }}>
            <DroneSVG airframe={vehicle.airframe} size={50} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>{vehicle.name}</span>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>{AIRFRAME_LABELS[vehicle.airframe] ?? vehicle.airframe}</span>
                    {vehicle.frameId && <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#22d3ee', background: 'rgba(6,182,212,0.12)', padding: '1px 7px', borderRadius: 5, border: '1px solid rgba(6,182,212,0.25)' }}>#{vehicle.frameId}</span>}
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', background: 'hsl(var(--app-surface))', padding: '1px 7px', borderRadius: 5, border: '1px solid hsl(var(--app-border))' }}>{vehicle.firmware.toUpperCase()}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#4ade80' : '#6b7280' }} />
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: connected ? '#4ade80' : 'hsl(var(--app-text-muted))' }}>{connected ? 'Connected' : 'Disconnected'}</span>
                    {connected && <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', opacity: 0.5 }}>· {address}</span>}
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <StatusRing pct={readiness} color={rc} size={48} />
                    <span style={{ position: 'absolute', fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: rc }}>{readiness.toFixed(0)}%</span>
                </div>
                <span style={{ fontSize: 8, fontFamily: 'monospace', letterSpacing: '0.12em', color: 'hsl(var(--app-text-muted))' }}>READY</span>
            </div>
        </div>
    )
}

// ── Section Tab Bar ───────────────────────────────────────────────────────────

function SectionTabBar({ current, onSelect, onBack, tabs }: {
    current: SectionId; onSelect: (id: SectionId) => void; onBack: () => void
    tabs: { id: SectionId; label: string; icon: React.ElementType; color: string }[]
}) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', borderTop: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface-2))', flexShrink: 0, overflowX: 'auto' }}>
            <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px', background: 'none', border: 'none', borderRight: '1px solid hsl(var(--app-border))', cursor: 'pointer', color: 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap', flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'hsl(var(--app-text))' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'hsl(var(--app-text-muted))' }}>
                <ChevronLeft size={13} /> Overview
            </button>
            {tabs.map(t => {
                const active = t.id === current, Icon = t.icon
                return (
                    <button key={t.id} onClick={() => onSelect(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 12px', background: active ? `${t.color}12` : 'none', border: 'none', borderBottom: active ? `2px solid ${t.color}` : '2px solid transparent', cursor: 'pointer', color: active ? t.color : 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap', transition: 'all 0.12s' }}
                        onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'hsl(var(--app-text))' }}
                        onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'hsl(var(--app-text-muted))' }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                        <Icon size={12} />{t.label}
                    </button>
                )
            })}
        </div>
    )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHead({ meta, pct }: { meta: typeof DOMAIN_META[0]; pct: number }) {
    const color = hColor(pct, meta.id === 'parameters')
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22, paddingBottom: 18, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ width: 42, height: 42, borderRadius: 11, background: `${color}14`, border: `1.5px solid ${color}35`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <meta.icon size={19} style={{ color }} />
            </div>
            <div style={{ flex: 1 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0 }}>{meta.label}</h2>
                <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>{meta.desc}</p>
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <StatusRing pct={pct} color={color} size={44} />
                <span style={{ position: 'absolute', fontSize: 10, fontFamily: 'monospace', fontWeight: 700, color }}>{pct.toFixed(0)}%</span>
            </div>
        </div>
    )
}

// ── CONNECTION ────────────────────────────────────────────────────────────────

function ConnectionWorkspace({ address, setAddress }: { address: string; setAddress: (v: string) => void }) {
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const telemetry = useDroneStore(s => s.telemetry)
    const [showPresets, setShowPresets] = useState(false)
    const connected = telStatus === 'connected'
    const connect    = useCallback(() => { lsSet('hyrak-mav-address', address); getSocket().emit('connect_telemetry', { address }) }, [address])
    const disconnect = useCallback(() => getSocket().emit('disconnect_telemetry'), [])
    const pos = telemetry?.position, bat = telemetry?.battery, fm = telemetry?.flight_mode, att = telemetry?.attitude

    const mavMsgs = connected ? [
        pos && 'GLOBAL_POSITION_INT', att && 'ATTITUDE', bat && 'BATTERY_STATUS',
        fm && 'HEARTBEAT', telemetry?.heading_deg != null && 'VFR_HUD', 'SYS_STATUS',
    ].filter(Boolean) as string[] : []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Topology diagram */}
            <Panel title="NETWORK TOPOLOGY" accent="#22d3ee">
                <NetworkTopology connected={connected} address={address} />
            </Panel>

            <G2>
                {/* Left: link setup */}
                <Card title="LINK SETUP">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, fontSize: 11, fontFamily: 'monospace', fontWeight: 700, background: connected ? 'rgba(74,222,128,0.1)' : 'rgba(107,114,128,0.08)', border: `1px solid ${connected ? 'rgba(74,222,128,0.3)' : 'rgba(107,114,128,0.2)'}`, color: connected ? '#4ade80' : '#9ca3af' }}>
                            {connected ? <Check size={11} /> : <WifiOff size={11} />}
                            {connected ? 'Connected' : 'No link'}
                        </div>
                    </div>
                    {!connected && (
                        <Field label="MAVLINK ADDRESS" tip="Connection string for your autopilot.">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <AppInput value={address} onChange={setAddress} placeholder="udpin://0.0.0.0:14540" />
                                    <button onClick={() => setShowPresets(s => !s)} style={{ padding: '9px 10px', borderRadius: 8, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', whiteSpace: 'nowrap' }}>Presets</button>
                                </div>
                                {showPresets && (
                                    <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid hsl(var(--app-border))' }}>
                                        {MAV_PRESETS.map(p => (
                                            <button key={p.addr} onClick={() => { setAddress(p.addr); setShowPresets(false) }} style={{ width: '100%', display: 'flex', flexDirection: 'column', padding: '9px 12px', background: 'hsl(var(--app-surface))', border: 'none', borderBottom: '1px solid hsl(var(--app-border))', cursor: 'pointer', textAlign: 'left' }}
                                                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'hsl(var(--app-surface-2))' }}
                                                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'hsl(var(--app-surface))' }}>
                                                <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>{p.label}</span>
                                                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', marginTop: 2 }}>{p.addr}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </Field>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={connected ? disconnect : connect} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 8, cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, border: '1px solid', ...(connected ? { background: 'rgba(248,113,113,.08)', borderColor: 'rgba(248,113,113,.35)', color: '#fca5a5' } : { background: 'rgba(74,222,128,.08)', borderColor: 'rgba(74,222,128,.35)', color: '#4ade80' }) }}>
                            {connected ? <WifiOff size={14} /> : <Wifi size={14} />}
                            {connected ? 'Disconnect' : 'Connect'}
                        </button>
                        {connected && <button onClick={() => { disconnect(); setTimeout(connect, 600) }} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}><RotateCcw size={14} /></button>}
                    </div>
                </Card>

                {/* Right: live telemetry or MAVLink stream */}
                {connected ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Panel title="LIVE TELEMETRY" accent="#4ade80">
                            {[
                                { k: 'Flight Mode', v: fm?.mode ?? '—', hi: !!fm?.is_armed },
                                { k: 'Armed',       v: fm?.is_armed ? 'YES' : 'no' },
                                { k: 'Battery',     v: bat ? `${bat.remaining_percent?.toFixed(0)}%  ·  ${bat.voltage_v?.toFixed(2)}V` : '—', hi: (bat?.remaining_percent ?? 100) < 20 },
                                { k: 'Altitude AGL',v: pos ? `${pos.relative_altitude_m?.toFixed(2)} m` : '—' },
                                { k: 'Lat / Lon',   v: pos ? `${pos.latitude_deg?.toFixed(5)}° / ${pos.longitude_deg?.toFixed(5)}°` : '—' },
                                { k: 'Roll / Pitch',v: att ? `${att.roll_deg?.toFixed(1)}° / ${att.pitch_deg?.toFixed(1)}°` : '—' },
                                { k: 'Heading',     v: telemetry?.heading_deg != null ? `${telemetry.heading_deg.toFixed(1)}°` : '—' },
                            ].map(r => (
                                <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>{r.k}</span>
                                    <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 600, color: r.hi ? '#f87171' : '#e2e8f0' }}>{r.v}</span>
                                </div>
                            ))}
                        </Panel>
                        <Panel title="MAVLINK STREAM" accent="#22d3ee">
                            {mavMsgs.map(m => (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#22d3ee', flexShrink: 0 }}>
                                        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
                                        <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#22d3ee', animation: 'pulse 2s infinite' }} />
                                    </div>
                                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#4ade80' }}>{m}</span>
                                </div>
                            ))}
                        </Panel>
                    </div>
                ) : (
                    <Panel title="PROTOCOL REFERENCE">
                        {[
                            { badge: 'PX4', color: '#60a5fa', text: 'MAVSDK over UDP. Default SITL port: 14540. Physical radio: serial:///dev/ttyUSB0:57600' },
                            { badge: 'ArduPilot', color: '#4ade80', text: 'Compatible via MAVLink dialect. Default SITL port: 14550. Set TERRAIN_ENABLE=1 for terrain follow.' },
                            { badge: 'TCP', color: '#c084fc', text: 'For companion computer bridge: tcp://192.168.x.x:5760. Set GCS_TCP_PORT on the flight controller.' },
                        ].map(p => (
                            <div key={p.badge} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                                <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 9, fontFamily: 'monospace', fontWeight: 700, background: `${p.color}18`, color: p.color, flexShrink: 0, marginTop: 1 }}>{p.badge}</span>
                                <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', lineHeight: 1.6, margin: 0 }}>{p.text}</p>
                            </div>
                        ))}
                    </Panel>
                )}
            </G2>
        </div>
    )
}

// ── VEHICLE ───────────────────────────────────────────────────────────────────

function VehicleWorkspace({ v, onUpdate }: { v: VehicleProfile; onUpdate: (p: Partial<VehicleProfile>) => void }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Identity hero */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '20px 24px', borderRadius: 14, background: '#090e14', border: '1px solid rgba(34,211,238,0.12)' }}>
                <DroneSVG airframe={v.airframe} size={96} />
                <div>
                    <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>{v.name}</h2>
                    <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: '4px 0 0' }}>
                        {AIRFRAME_LABELS[v.airframe] ?? v.airframe} · {v.firmware.toUpperCase()}{v.frameId ? ` · Frame #${v.frameId}` : ''}
                    </p>
                </div>
            </div>
            <G2>
                <Card title="IDENTITY">
                    <Field label="VEHICLE NAME">
                        <AppInput value={v.name} onChange={name => onUpdate({ name })} placeholder="My Drone" />
                    </Field>
                    <Field label="CUSTOM FRAME ID" tip="PX4: SYS_AUTOSTART (e.g. 4302). ArduPilot: FRAME_TYPE.">
                        <AppInput value={v.frameId} onChange={frameId => onUpdate({ frameId })} placeholder="e.g. 4302" />
                    </Field>
                </Card>
                <Card title="HARDWARE">
                    <Field label="AIRFRAME TYPE">
                        <AppSelect value={v.airframe as any} onChange={airframe => onUpdate({ airframe })} options={Object.entries(AIRFRAME_LABELS).map(([k, l]) => ({ value: k as any, label: l }))} />
                    </Field>
                    <Field label="AUTOPILOT FIRMWARE">
                        <AppSelect value={v.firmware as any} onChange={firmware => onUpdate({ firmware })} options={[{ value: 'px4', label: 'PX4' }, { value: 'ardupilot', label: 'ArduPilot' }, { value: 'other', label: 'Other / Unknown' }]} />
                    </Field>
                </Card>
            </G2>
        </div>
    )
}

// ── SENSORS ───────────────────────────────────────────────────────────────────

function SensorsWorkspace() {
    const telemetry = useDroneStore(s => s.telemetry)
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const connected = telStatus === 'connected'
    const gpsOk  = connected && (telemetry?.position?.latitude_deg ?? 0) !== 0
    const imuOk  = connected && telemetry?.attitude != null
    const magOk  = connected && (telemetry?.heading_deg ?? 0) !== 0
    const baroOk = connected && (telemetry?.position?.relative_altitude_m ?? 0) !== 0
    const states = { gps: connected ? gpsOk : null, imu: connected ? imuOk : null, mag: connected ? magOk : null, baro: connected ? baroOk : null }
    const healthy = Object.values(states).filter(v => v === true).length

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* EKF pipeline diagram */}
            <Panel title="EKF SENSOR FUSION PIPELINE" accent="#22d3ee">
                <EKFFlow states={states} />
                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.2)', margin: 0, lineHeight: 1.6 }}>
                    The Extended Kalman Filter fuses all sensor inputs to produce a single best-estimate of position, velocity, and attitude. All four sensors feed the same EKF.
                </p>
            </Panel>

            <G2>
                {/* Left: sensor health instruments */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* GPS */}
                    <Panel accent={states.gps === null ? undefined : states.gps ? '#4ade80' : '#f87171'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: states.gps ? 'rgba(74,222,128,0.12)' : 'rgba(75,85,99,0.12)', border: `1.5px solid ${states.gps ? '#4ade80' : '#4b5563'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <div style={{ width: 14, height: 14, borderRadius: '50%', background: states.gps === null ? '#4b5563' : states.gps ? '#4ade80' : '#f87171' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>GPS / GNSS</p>
                                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: '2px 0 0' }}>{connected && telemetry?.position ? `${telemetry.position.latitude_deg?.toFixed(6)}° / ${telemetry.position.longitude_deg?.toFixed(6)}°` : 'Global position fix'}</p>
                            </div>
                            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: states.gps === null ? '#4b5563' : states.gps ? '#4ade80' : '#f87171' }}>{states.gps === null ? 'N/A' : states.gps ? 'FIX' : 'NO FIX'}</span>
                        </div>
                    </Panel>
                    {/* IMU */}
                    <Panel accent={states.imu === null ? undefined : states.imu ? '#4ade80' : '#f87171'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: states.imu ? 'rgba(74,222,128,0.12)' : 'rgba(75,85,99,0.12)', border: `1.5px solid ${states.imu ? '#4ade80' : '#4b5563'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <div style={{ width: 14, height: 14, borderRadius: 3, background: states.imu === null ? '#4b5563' : states.imu ? '#4ade80' : '#f87171' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>IMU (Accel + Gyro)</p>
                                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: '2px 0 0' }}>
                                    {connected && telemetry?.attitude ? `R ${telemetry.attitude.roll_deg?.toFixed(1)}° P ${telemetry.attitude.pitch_deg?.toFixed(1)}° Y ${telemetry.attitude.yaw_deg?.toFixed(1)}°` : 'Roll, pitch, yaw rates'}
                                </p>
                            </div>
                            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: states.imu === null ? '#4b5563' : states.imu ? '#4ade80' : '#f87171' }}>{states.imu === null ? 'N/A' : states.imu ? 'OK' : 'ERR'}</span>
                        </div>
                    </Panel>
                    {/* Compass */}
                    <Panel accent={states.mag === null ? undefined : states.mag ? '#4ade80' : '#f87171'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <CompassGauge heading={telemetry?.heading_deg ?? null} size={72} />
                            <div style={{ flex: 1 }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>Compass / Mag</p>
                                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: '2px 0 0' }}>Magnetometer heading reference</p>
                            </div>
                            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: states.mag === null ? '#4b5563' : states.mag ? '#4ade80' : '#f87171' }}>{states.mag === null ? 'N/A' : states.mag ? 'OK' : 'ERR'}</span>
                        </div>
                    </Panel>
                    {/* Baro */}
                    <Panel accent={states.baro === null ? undefined : states.baro ? '#4ade80' : '#f87171'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <AltBar alt={connected && telemetry?.position ? telemetry.position.relative_altitude_m ?? null : null} label="ALT AGL" />
                            <div style={{ flex: 1 }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>Barometer</p>
                                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: '2px 0 0' }}>Pressure altimeter — AGL estimate</p>
                            </div>
                            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: states.baro === null ? '#4b5563' : states.baro ? '#4ade80' : '#f87171' }}>{states.baro === null ? 'N/A' : states.baro ? 'OK' : 'ERR'}</span>
                        </div>
                    </Panel>
                </div>

                {/* Right: calibration */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ padding: '11px 14px', borderRadius: 10, background: connected ? 'rgba(74,222,128,0.06)' : 'rgba(75,85,99,0.08)', border: `1px solid ${connected ? 'rgba(74,222,128,0.2)' : 'rgba(75,85,99,0.2)'}` }}>
                        <p style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: connected ? '#4ade80' : '#6b7280', margin: '0 0 2px' }}>{connected ? `${healthy}/4 sensors reporting` : 'No drone connected'}</p>
                        <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)', margin: 0 }}>{connected ? (healthy === 4 ? 'All sensors healthy — pre-flight check passed' : 'Some sensors not reporting — check wiring') : 'Connect via the Connection section to see live sensor health'}</p>
                    </div>
                    <Card title="CALIBRATION">
                        {['Compass', 'Accelerometer', 'Gyroscope', 'Level Horizon', 'Airspeed (if fitted)'].map((name, i, arr) => (
                            <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: i < arr.length - 1 ? 12 : 0, borderBottom: i < arr.length - 1 ? '1px solid hsl(var(--app-border))' : 'none', marginBottom: i < arr.length - 1 ? 12 : 0 }}>
                                <div>
                                    <p style={{ fontSize: 12, fontWeight: 500, color: 'hsl(var(--app-text))', margin: 0 }}>{name}</p>
                                    <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>Status: not calibrated</p>
                                </div>
                                <button disabled style={{ padding: '5px 12px', borderRadius: 7, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', cursor: 'not-allowed', opacity: 0.4 }}>Start</button>
                            </div>
                        ))}
                    </Card>
                    <LockedNote text="Calibration wizard requires MAVLink parameter write — coming in a future update" />
                </div>
            </G2>
        </div>
    )
}

// ── RADIO ─────────────────────────────────────────────────────────────────────

const RC_MODE_MAP: Record<string, { left: [string, string]; right: [string, string] }> = {
    '1': { left: ['Pitch ↑↓', 'Roll ←→'],     right: ['Throttle ↑↓', 'Yaw ←→'] },
    '2': { left: ['Throttle ↑↓', 'Yaw ←→'],   right: ['Pitch ↑↓', 'Roll ←→'] },
    '3': { left: ['Pitch ↑↓', 'Yaw ←→'],      right: ['Throttle ↑↓', 'Roll ←→'] },
    '4': { left: ['Throttle ↑↓', 'Roll ←→'],  right: ['Pitch ↑↓', 'Yaw ←→'] },
}

function RadioWorkspace({ r, onUpdate }: { r: RadioProfile; onUpdate: (p: Partial<RadioProfile>) => void }) {
    const m = RC_MODE_MAP[r.rcMode] ?? RC_MODE_MAP['2']
    function Stick({ axes, label }: { axes: [string, string]; label: string }) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 80, height: 80, borderRadius: 14, background: '#060b10', border: '1px solid rgba(255,255,255,0.08)', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: 'rgba(255,255,255,0.05)' }} />
                    <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'rgba(255,255,255,0.05)' }} />
                    <div style={{ position: 'absolute', top: 6, left: 0, right: 0, textAlign: 'center', fontSize: 8, fontFamily: 'monospace', color: '#22d3ee', opacity: 0.7 }}>{axes[0].split(' ')[0]}</div>
                    <div style={{ position: 'absolute', bottom: 6, left: 0, right: 0, textAlign: 'center', fontSize: 8, fontFamily: 'monospace', color: '#22d3ee', opacity: 0.7 }}>{axes[1].split(' ')[0]}</div>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#22d3ee', opacity: 0.85, boxShadow: '0 0 10px rgba(34,211,238,0.4)', zIndex: 1 }} />
                </div>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em' }}>{label.toUpperCase()} STICK</span>
            </div>
        )
    }
    // 6-position switch visualization
    const switchColors = ['#4ade80','#22d3ee','#fbbf24','#f97316','#c084fc','#f87171']

    return (
        <G2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Card title="STICK LAYOUT">
                    <Field label="RC MODE">
                        <AppSelect value={r.rcMode as any} onChange={rcMode => onUpdate({ rcMode })} options={[
                            { value: '1', label: 'Mode 1 — Pitch/Roll L, Throttle/Yaw R' },
                            { value: '2', label: 'Mode 2 — Throttle/Yaw L, Pitch/Roll R' },
                            { value: '3', label: 'Mode 3 — Pitch/Yaw L, Throttle/Roll R' },
                            { value: '4', label: 'Mode 4 — Throttle/Roll L, Pitch/Yaw R' },
                        ]} />
                    </Field>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 28, paddingTop: 6 }}>
                        <Stick axes={m.left} label="Left" />
                        <Stick axes={m.right} label="Right" />
                    </div>
                </Card>
                <Panel title="CHANNEL 5 — FLIGHT MODE SWITCH" accent="#fbbf24">
                    <div style={{ display: 'flex', gap: 6 }}>
                        {r.modes.slice(0,6).map((mode, i) => (
                            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                                <div style={{ width: 10, height: 24, borderRadius: 3, background: `${switchColors[i]}25`, border: `1.5px solid ${switchColors[i]}60` }} />
                                <span style={{ fontSize: 7, fontFamily: 'monospace', color: switchColors[i], textAlign: 'center', lineHeight: 1.2, writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 48, overflow: 'hidden' }}>{mode}</span>
                            </div>
                        ))}
                    </div>
                    <p style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.2)', margin: 0, lineHeight: 1.5 }}>Each column = one switch position on your transmitter. Assign up to 6 modes.</p>
                </Panel>
            </div>

            <Card title="FLIGHT MODE SLOTS">
                <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '0 0 4px', lineHeight: 1.6 }}>Assign a flight mode to each switch position. Matches Ch 5/6 positions on most transmitters.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {r.modes.map((mode, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 26, height: 26, borderRadius: 7, background: `${switchColors[i]}18`, border: `1.5px solid ${switchColors[i]}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, color: switchColors[i] }}>{i+1}</span>
                            </div>
                            <div style={{ flex: 1 }}>
                                <AppSelect value={mode as any} options={FLIGHT_MODES_LIST.map(f => ({ value: f, label: f }))} onChange={v => onUpdate({ modes: r.modes.map((x, j) => j === i ? v : x) })} />
                            </div>
                        </div>
                    ))}
                </div>
            </Card>
        </G2>
    )
}

// ── POWER ─────────────────────────────────────────────────────────────────────

function PowerWorkspace({ p, onUpdate }: { p: PowerProfile; onUpdate: (patch: Partial<PowerProfile>) => void }) {
    const telemetry = useDroneStore(s => s.telemetry)
    const n = parseInt(p.cells) || 4
    const totalV = telemetry?.battery?.voltage_v
    const nomV = (n * 3.7).toFixed(1), fullV = (n * 4.2).toFixed(1), minV = (n * 3.0).toFixed(1)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Battery hero panel */}
            <Panel title="BATTERY PACK" accent="#22d3ee">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
                    <BatteryCellsViz cells={p.cells} totalV={totalV} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div>
                            <span style={{ fontSize: 28, fontFamily: 'monospace', fontWeight: 700, color: '#22d3ee', lineHeight: 1 }}>{p.cells}S</span>
                            <span style={{ fontSize: 13, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', marginLeft: 8 }}>{p.capacity} mAh</span>
                        </div>
                        {[
                            { label: 'Full charge', val: `${fullV} V` },
                            { label: 'Nominal',     val: `${nomV} V` },
                            { label: 'Min safe',    val: `${minV} V` },
                            ...(totalV ? [{ label: 'Live voltage', val: `${totalV.toFixed(2)} V` }] : []),
                        ].map(r => (
                            <div key={r.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)', width: 80 }}>{r.label}</span>
                                <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600, color: r.label === 'Live voltage' ? '#4ade80' : '#e2e8f0' }}>{r.val}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </Panel>

            <G2>
                <Card title="PACK CONFIG">
                    <Field label="CELL COUNT (S)">
                        <AppSelect value={p.cells as any} onChange={cells => onUpdate({ cells })} options={['2','3','4','5','6','8','10','12'].map(v => ({ value: v as any, label: `${v}S  ·  ${(+v*4.2).toFixed(1)}V full` }))} />
                    </Field>
                    <Field label="CAPACITY (mAh)">
                        <AppInput value={p.capacity} onChange={capacity => onUpdate({ capacity })} placeholder="5000" />
                    </Field>
                    <Field label="CRITICAL ACTION" tip="What autopilot does at critical battery level.">
                        <AppSelect value={p.critAction as any} onChange={critAction => onUpdate({ critAction })} options={[
                            { value: 'warn',   label: 'Warning only — pilot decides' },
                            { value: 'land',   label: 'Land immediately' },
                            { value: 'rtl',    label: 'Return to Launch (RTL)' },
                            { value: 'disarm', label: 'Disarm (ground only)' },
                        ]} />
                    </Field>
                </Card>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <Panel title="DISCHARGE CURVE" accent="#fbbf24">
                        <DischargeCurve warnPct={p.warnPct} critPct={p.critPct} />
                        <p style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.2)', margin: 0 }}>Typical LiPo curve — flat to ~20%, then rapid voltage drop</p>
                    </Panel>
                    <Card title="THRESHOLDS">
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <Label text={`WARNING — ${p.warnPct}%`} tip="Triggers a warning alert. Fly home well before this." />
                                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#fbbf24' }}>{p.warnPct}%</span>
                            </div>
                            <input type="range" min={10} max={40} step={5} value={p.warnPct} onChange={e => onUpdate({ warnPct: +e.target.value })} style={{ width: '100%', accentColor: '#fbbf24' }} />
                        </div>
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <Label text={`CRITICAL — ${p.critPct}%`} tip="Triggers the action below." />
                                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#f87171' }}>{p.critPct}%</span>
                            </div>
                            <input type="range" min={5} max={20} step={1} value={p.critPct} onChange={e => onUpdate({ critPct: +e.target.value })} style={{ width: '100%', accentColor: '#f87171' }} />
                        </div>
                    </Card>
                </div>
            </G2>
        </div>
    )
}

// ── SAFETY ────────────────────────────────────────────────────────────────────

function SafetyWorkspace({ s, onUpdate }: { s: SafetyProfile; onUpdate: (p: Partial<SafetyProfile>) => void }) {
    const terrainFollow    = useMissionStore(st => st.terrainFollow)
    const setTerrainFollow = useMissionStore(st => st.setTerrainFollow)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <G2>
                {/* Left: geofence map */}
                <Panel title="AIRSPACE — TOP DOWN VIEW" accent="#22d3ee">
                    <GeofenceMap maxDist={s.maxDist} maxDistEnabled={s.maxDistEnabled} rthAlt={s.rthAlt} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {[
                            { color: '#f87171', label: `Max distance fence — ${s.maxDistEnabled ? s.maxDist + 'm' : 'disabled'}` },
                            { color: '#4ade80', label: 'Safe operating zone (estimated)' },
                            { color: '#22d3ee', label: `RTH altitude — ${s.rthAlt}m` },
                        ].map(l => (
                            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                <div style={{ width: 20, height: 1.5, background: l.color, flexShrink: 0 }} />
                                <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>{l.label}</span>
                            </div>
                        ))}
                    </div>
                </Panel>

                {/* Right: controls */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Terrain follow — functional, prominent */}
                    <div style={{ padding: '14px 16px', borderRadius: 10, background: terrainFollow ? 'rgba(34,211,238,0.07)' : '#090e14', border: `1.5px solid ${terrainFollow ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.06)'}`, transition: 'all 0.2s' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: terrainFollow ? '#22d3ee' : '#e2e8f0' }}>Terrain Following</span>
                            <Toggle value={terrainFollow} onChange={() => setTerrainFollow(!terrainFollow)} />
                        </div>
                        <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)', margin: 0, lineHeight: 1.6 }}>
                            {terrainFollow ? 'Active — missions export with TERRAIN_ALT frame. Drone holds constant AGL over hills.' : 'Off — mission altitudes are relative to home point.'}
                        </p>
                    </div>
                    <Card title="FAILSAFE ACTIONS">
                        <Field label="SIGNAL LOSS ACTION" tip="What the autopilot does if RC or telemetry link drops.">
                            <AppSelect value={s.signalLoss as any} onChange={signalLoss => onUpdate({ signalLoss })} options={[
                                { value: 'rtl',      label: 'Return to Launch (RTL)' },
                                { value: 'land',     label: 'Land immediately' },
                                { value: 'hold',     label: 'Hold position (loiter)' },
                                { value: 'continue', label: 'Continue current mission' },
                            ]} />
                        </Field>
                    </Card>
                    <Card title="LIMITS">
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <Label text={`RTH ALT — ${s.rthAlt}m`} tip="Drone climbs to this before flying home." />
                            </div>
                            <input type="range" min={10} max={150} step={5} value={s.rthAlt} onChange={e => onUpdate({ rthAlt: +e.target.value })} style={{ width: '100%', accentColor: '#22d3ee' }} />
                        </div>
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <Label text={`MAX ALT — ${s.maxAltEnabled ? s.maxAlt + 'm' : 'unlimited'}`} />
                                <Toggle value={s.maxAltEnabled} onChange={() => onUpdate({ maxAltEnabled: !s.maxAltEnabled })} />
                            </div>
                            {s.maxAltEnabled && <input type="range" min={20} max={500} step={10} value={s.maxAlt} onChange={e => onUpdate({ maxAlt: +e.target.value })} style={{ width: '100%', accentColor: '#f87171' }} />}
                        </div>
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <Label text={`MAX DIST — ${s.maxDistEnabled ? s.maxDist + 'm' : 'unlimited'}`} />
                                <Toggle value={s.maxDistEnabled} onChange={() => onUpdate({ maxDistEnabled: !s.maxDistEnabled })} />
                            </div>
                            {s.maxDistEnabled && <input type="range" min={50} max={5000} step={50} value={s.maxDist} onChange={e => onUpdate({ maxDist: +e.target.value })} style={{ width: '100%', accentColor: '#f87171' }} />}
                        </div>
                    </Card>
                    <LockedNote text="Limit parameters saved locally — autopilot upload requires parameter write access" />
                </div>
            </G2>
        </div>
    )
}

// ── FLIGHT ────────────────────────────────────────────────────────────────────

function FlightWorkspace({ f, onUpdate, rthAlt, maxAlt, maxAltEnabled }: { f: FlightProfile; onUpdate: (p: Partial<FlightProfile>) => void; rthAlt: number; maxAlt: number; maxAltEnabled: boolean }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Panel title="ALTITUDE PROFILE — SIDE VIEW" accent="#4ade80">
                <AltitudeProfile takeoffAlt={f.takeoffAlt} rthAlt={rthAlt} maxAlt={maxAlt} maxAltEnabled={maxAltEnabled} />
                <div style={{ display: 'flex', gap: 16 }}>
                    {[
                        { color: '#4ade80', label: `Takeoff — ${f.takeoffAlt}m` },
                        { color: '#22d3ee', label: `RTH altitude — ${rthAlt}m` },
                        ...(maxAltEnabled ? [{ color: '#f87171', label: `Max altitude — ${maxAlt}m` }] : []),
                    ].map(l => (
                        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 16, height: 2, background: l.color }} />
                            <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>{l.label}</span>
                        </div>
                    ))}
                </div>
            </Panel>
            <G2>
                <Card title="ALTITUDE DEFAULTS">
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Label text="DEFAULT TAKEOFF" tip="Height for automated takeoff commands." />
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#4ade80' }}>{f.takeoffAlt} m</span>
                        </div>
                        <input type="range" min={2} max={50} step={1} value={f.takeoffAlt} onChange={e => onUpdate({ takeoffAlt: +e.target.value })} style={{ width: '100%', accentColor: '#4ade80' }} />
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Label text="LOITER RADIUS" tip="Circle radius in loiter/hold. Mostly for fixed-wing." />
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#22d3ee' }}>{f.loiterRadius} m</span>
                        </div>
                        <input type="range" min={10} max={200} step={10} value={f.loiterRadius} onChange={e => onUpdate({ loiterRadius: +e.target.value })} style={{ width: '100%', accentColor: '#22d3ee' }} />
                    </div>
                </Card>
                <Card title="RETURN TO HOME">
                    <Field label="RTH MODE" tip="What the drone does when RTL triggers.">
                        <AppSelect value={f.rthMode as any} onChange={rthMode => onUpdate({ rthMode })} options={[
                            { value: 'ascend',  label: 'Climb to RTH alt → fly home → land' },
                            { value: 'current', label: 'Fly home at current altitude → land' },
                            { value: 'mission', label: 'Finish waypoint → return' },
                        ]} />
                    </Field>
                    <LockedNote text="Flight parameters saved locally — autopilot upload in a future update" />
                </Card>
            </G2>
        </div>
    )
}

// ── ADVANCED (Parameter Browser) ──────────────────────────────────────────────

// Live param entry coming from the drone
interface LiveParam { value: number; type: string }

// Merged view for display: drone value + PX4 metadata
interface DisplayParam {
    key: string
    meta: PX4Meta | null
    group: PX4Group
    liveValue: number
    paramType: string   // 'int' | 'float'
    defaultValue: number | null
}

// Group colour / icon map
const GROUP_STYLE: Record<PX4Group, { color: string; icon: React.ElementType }> = {
    'Commander':         { color: '#f87171', icon: Shield },
    'EKF2':              { color: '#60a5fa', icon: Gauge },
    'Multicopter Rate':  { color: '#f97316', icon: RotateCcw },
    'Position Control':  { color: '#4ade80', icon: Move },
    'Navigation':        { color: '#c084fc', icon: Navigation },
    'Return to Launch':  { color: '#22d3ee', icon: ChevronLeft },
    'Battery':           { color: '#fbbf24', icon: Battery },
    'Geofence':          { color: '#f87171', icon: Shield },
    'Mission':           { color: '#a78bfa', icon: Navigation },
    'System':            { color: '#22d3ee', icon: Cpu },
    'MAVLink':           { color: '#22d3ee', icon: Radio },
    'PWM / ESC':         { color: '#fb923c', icon: Zap },
    'Motors':            { color: '#fb923c', icon: SlidersHorizontal },
    'Control Allocator': { color: '#94a3b8', icon: SlidersHorizontal },
    'Logging':           { color: '#94a3b8', icon: Terminal },
    'Circuit Breakers':  { color: '#f87171', icon: AlertTriangle },
    'Sensors':           { color: '#60a5fa', icon: Gauge },
    'RC Channels':       { color: '#a78bfa', icon: Radio },
    'Land Detector':     { color: '#4ade80', icon: Plane },
    'VTOL':              { color: '#e879f9', icon: Plane },
    'Failure Detector':  { color: '#f87171', icon: AlertTriangle },
    'Attitude Estimator':{ color: '#818cf8', icon: Gauge },
    'Other':             { color: '#6b7280', icon: Terminal },
}

// ── Demo mode ParamCard (uses hardcoded PARAMS_DB) ─────────────────────────

function ParamCard({ p, currentVal, catColor, isSearching, onSet, onRevert }: {
    p: Param; currentVal: number; catColor: string; isSearching: boolean
    onSet: (key: string, v: number) => void; onRevert: (key: string) => void
}) {
    const modified = currentVal !== p.def
    const valLabel = p.type === 'bool'
        ? (currentVal ? 'Enabled' : 'Disabled')
        : p.type === 'enum'
        ? (p.opts?.find(o => o.v === currentVal)?.l ?? String(currentVal))
        : `${currentVal}${p.unit ? ` ${p.unit}` : ''}`
    const defLabel = p.type === 'bool'
        ? (p.def ? 'enabled' : 'disabled')
        : p.type === 'enum'
        ? (p.opts?.find(o => o.v === p.def)?.l ?? String(p.def))
        : `${p.def}${p.unit ? ` ${p.unit}` : ''}`

    const borderAccent = p.danger ? 'rgba(248,113,113,0.22)' : modified ? 'rgba(251,191,36,0.28)' : `${catColor}1a`
    const leftBorder   = p.danger ? '#f87171' : modified ? '#fbbf24' : catColor

    return (
        <div style={{ borderRadius: 10, background: '#0b1019', border: `1px solid ${borderAccent}`, borderLeft: `3px solid ${leftBorder}`, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '11px 13px 0' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', lineHeight: 1.3 }}>{p.name}</span>
                            {p.danger   && <AlertTriangle size={9} style={{ color: '#f87171', flexShrink: 0 }} />}
                            {modified   && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />}
                        </div>
                        <span style={{ fontSize: 9, fontFamily: 'monospace', color: catColor, opacity: 0.65 }}>{p.key}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {isSearching && (
                            <span style={{ fontSize: 8, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.22)' }}>
                                {PARAM_CATS.find(c => c.id === p.cat)?.label}
                            </span>
                        )}
                        <span style={{ fontSize: 8, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 4, background: `${catColor}14`, color: catColor, opacity: 0.75 }}>
                            {p.type.toUpperCase()}
                        </span>
                    </div>
                </div>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '5px 0 0', lineHeight: 1.5 }}>{p.desc}</p>
            </div>

            {/* Control */}
            <div style={{ padding: '10px 13px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {p.type === 'bool' && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 14, fontFamily: 'monospace', fontWeight: 700, color: currentVal ? '#4ade80' : '#6b7280' }}>{valLabel}</span>
                        <Toggle value={!!currentVal} onChange={() => onSet(p.key, currentVal ? 0 : 1)} />
                    </div>
                )}
                {p.type === 'enum' && p.opts && (
                    <select value={currentVal} onChange={e => onSet(p.key, +e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 7, background: 'rgba(0,0,0,0.35)', border: `1px solid ${catColor}28`, color: '#e2e8f0', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', outline: 'none' }}>
                        {p.opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                )}
                {(p.type === 'float' || p.type === 'int') && p.min !== undefined && p.max !== undefined && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.18)' }}>{p.min}{p.unit ? ` ${p.unit}` : ''}</span>
                            <span style={{ fontSize: 15, fontFamily: 'monospace', fontWeight: 700, color: p.danger ? '#f87171' : catColor }}>{currentVal}{p.unit ? ` ${p.unit}` : ''}</span>
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.18)' }}>{p.max}{p.unit ? ` ${p.unit}` : ''}</span>
                        </div>
                        <input type="range" min={p.min} max={p.max} step={p.step ?? (p.type === 'int' ? 1 : 0.01)} value={currentVal}
                            onChange={e => onSet(p.key, +e.target.value)}
                            style={{ width: '100%', accentColor: p.danger ? '#f87171' : catColor }} />
                    </div>
                )}

                {/* Footer: default + revert */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                    <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.16)' }}>default: {defLabel}</span>
                    {modified && (
                        <button onClick={() => onRevert(p.key)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 5, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.28)', color: '#fbbf24', fontSize: 9, fontFamily: 'monospace', cursor: 'pointer' }}>
                            <RotateCcw size={8} /> revert
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

// ── Sidebar nav item (used in both live and demo modes) ────────────────────

function ParamSidebarItem({ label, count, color, Icon, active, onClick }: {
    label: string; count: number; color: string; Icon: React.ElementType; active: boolean; onClick: () => void
}) {
    return (
        <button onClick={onClick}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 10px', borderRadius: 7, border: 'none', borderLeft: `3px solid ${active ? color : 'transparent'}`, background: active ? `${color}12` : 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
            <Icon size={13} style={{ color: active ? color : '#64748b', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, color: active ? '#f1f5f9' : '#94a3b8', fontWeight: active ? 600 : 400, lineHeight: 1.2 }}>{label}</span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: active ? color : '#475569', minWidth: 18, textAlign: 'right' }}>{count}</span>
        </button>
    )
}

// ── Live param card ────────────────────────────────────────────────────────

function LiveParamCard({ dp, localVal, pending, lastOk, expert, originalVal, onSet, onRevert }: {
    dp: DisplayParam; localVal: number | undefined; pending: boolean; lastOk: boolean | null
    expert: boolean; originalVal: number | undefined
    onSet: (key: string, v: number, type: string) => void
    onRevert: (key: string) => void
}) {
    const val      = localVal ?? dp.liveValue
    const meta     = dp.meta
    const color    = GROUP_STYLE[dp.group]?.color ?? '#22d3ee'
    // modified = param has drifted from the value we loaded from drone (original snapshot)
    const modified = originalVal !== undefined && dp.liveValue !== originalVal
    const isDanger = meta?.danger ?? false
    const isExpert = meta?.expert ?? false

    if (isExpert && !expert) return null

    const accentColor = isDanger ? '#f87171' : color
    const borderL     = isDanger ? '#f87171' : modified ? '#fbbf24' : `${color}55`

    const hasRange  = meta?.min !== undefined && meta?.max !== undefined
    const hasOpts   = !!(meta?.opts && Object.keys(meta.opts).length > 0)
    const optEntries = hasOpts ? Object.entries(meta!.opts!) : []
    const isTwoOpt  = hasOpts && optEntries.length === 2
    const isIntType = dp.paramType === 'int'
    // bool: no opts, no range, int type, live value is 0 or 1
    const isBool    = !hasOpts && !hasRange && isIntType && (dp.liveValue === 0 || dp.liveValue === 1)

    const displayVal = hasOpts
        ? (meta!.opts![val] ?? `${val}`)
        : `${isIntType ? Math.round(val) : Number(val.toFixed(4))}${meta?.unit ? ` ${meta.unit}` : ''}`

    return (
        <div style={{ borderRadius: 10, background: '#0d1520', border: '1px solid #1e293b', borderLeft: `3px solid ${borderL}`, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '11px 13px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9', lineHeight: 1.3 }}>
                                {meta?.name ?? humanizeParamKey(dp.key)}
                            </span>
                            {isDanger && <AlertTriangle size={10} style={{ color: '#f87171', flexShrink: 0 }} />}
                            {modified  && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />}
                            {pending   && <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#60a5fa', flexShrink: 0 }} />}
                        </div>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: accentColor, letterSpacing: '0.02em' }}>{dp.key}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginTop: 1 }}>
                        {lastOk === true  && !pending && <span style={{ fontSize: 11, color: '#4ade80' }}>✓</span>}
                        {lastOk === false && !pending && <AlertTriangle size={10} style={{ color: '#f87171' }} />}
                        {isExpert && <span style={{ fontSize: 9, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 3, background: 'rgba(251,191,36,0.1)', color: '#fbbf24', letterSpacing: '0.04em' }}>EXPERT</span>}
                    </div>
                </div>
                {meta?.desc && (
                    <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.5 }}>{meta.desc}</p>
                )}
            </div>

            {/* Control */}
            <div style={{ padding: '0 13px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {isBool && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2 }}>
                        <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: val ? '#4ade80' : '#475569' }}>{val ? 'Enabled' : 'Disabled'}</span>
                        <Toggle value={!!val} onChange={() => onSet(dp.key, val ? 0 : 1, dp.paramType)} />
                    </div>
                )}
                {/* 2-option enum → segmented pill (no dropdown) */}
                {isTwoOpt && (
                    <div style={{ display: 'flex', gap: 4, paddingTop: 2 }}>
                        {optEntries.map(([k, l]) => {
                            const kNum = +k
                            const isActive = Math.round(val) === kNum
                            return (
                                <button key={k} onClick={() => onSet(dp.key, kNum, dp.paramType)}
                                    style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${isActive ? accentColor : '#1e293b'}`, background: isActive ? `${accentColor}22` : '#060d18', color: isActive ? '#f1f5f9' : '#64748b', fontSize: 11, cursor: 'pointer', fontWeight: isActive ? 600 : 400, transition: 'all 0.12s' }}>
                                    {l as string}
                                </button>
                            )
                        })}
                    </div>
                )}
                {/* 3+ option enum → dropdown */}
                {hasOpts && !isTwoOpt && (
                    <select value={val} onChange={e => onSet(dp.key, +e.target.value, dp.paramType)}
                        style={{ width: '100%', padding: '7px 10px', borderRadius: 7, background: '#060d18', border: `1px solid ${accentColor}30`, color: '#f1f5f9', fontSize: 11, cursor: 'pointer', outline: 'none' }}>
                        {optEntries.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                )}
                {hasRange && !hasOpts && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#475569' }}>{meta!.min}{meta?.unit ? ` ${meta.unit}` : ''}</span>
                            <span style={{ fontSize: 16, fontFamily: 'monospace', fontWeight: 700, color: accentColor }}>{displayVal}</span>
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#475569' }}>{meta!.max}{meta?.unit ? ` ${meta.unit}` : ''}</span>
                        </div>
                        <input type="range" min={meta!.min} max={meta!.max} step={meta?.step ?? (isIntType ? 1 : 0.01)} value={val}
                            onChange={e => onSet(dp.key, +e.target.value, dp.paramType)}
                            style={{ width: '100%', accentColor }} />
                    </div>
                )}
                {!hasOpts && !hasRange && !isBool && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="number" value={localVal ?? dp.liveValue} step={isIntType ? 1 : 'any'}
                            onChange={e => { const n = +e.target.value; if (!isNaN(n)) onSet(dp.key, n, dp.paramType) }}
                            style={{ flex: 1, padding: '7px 10px', borderRadius: 7, background: '#060d18', border: `1px solid ${accentColor}30`, color: '#f1f5f9', fontSize: 12, fontFamily: 'monospace', outline: 'none' }} />
                        {meta?.unit && <span style={{ fontSize: 11, color: '#64748b' }}>{meta.unit}</span>}
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#334155' }}>
                        drone: {dp.liveValue}{meta?.unit ? ` ${meta.unit}` : ''}
                        {originalVal !== undefined && originalVal !== dp.liveValue
                            ? ` · was: ${isIntType ? Math.round(originalVal) : Number(originalVal.toFixed(4))}${meta?.unit ? ` ${meta.unit}` : ''}`
                            : ''}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {pending   && <span style={{ fontSize: 10, color: '#60a5fa' }}>saving…</span>}
                        {!pending && lastOk === true  && <span style={{ fontSize: 10, color: '#4ade80' }}>saved</span>}
                        {!pending && lastOk === false && <span style={{ fontSize: 10, color: '#f87171' }}>failed</span>}
                        {modified && !pending && (
                            <button onClick={() => onRevert(dp.key)} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 4, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', fontSize: 9, fontFamily: 'monospace', cursor: 'pointer' }}>
                                <RotateCcw size={8} /> revert
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

// ── ParametersWorkspace ─────────────────────────────────────────────────────

function ParametersWorkspace() {
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const connected = telStatus === 'connected'

    // live param map: key → {value, type} from drone
    const [liveParams,       setLiveParams]       = useState<Record<string, LiveParam> | null>(null)
    // snapshot of values at fetch time — used for "revert to original"
    const [originalSnapshot, setOriginalSnapshot] = useState<Record<string, number>>({})
    const [loading,          setLoading]          = useState(false)
    const [fetchError,       setFetchError]       = useState<string | null>(null)
    // local edits (optimistic UI while set_param is in-flight)
    const [localEdits,  setLocalEdits]  = useState<Record<string, number>>({})
    // which keys are in-flight to the drone
    const [pending,     setPending]     = useState<Record<string, boolean>>({})
    // last ack result per key (true=ok, false=failed)
    const [ackStatus,   setAckStatus]   = useState<Record<string, boolean | null>>({})

    // UI state
    const [query,           setQuery]           = useState('')
    const [activeGroup,     setActiveGroup]     = useState<PX4Group>('Commander')
    const [expert,          setExpert]          = useState(false)
    const [modifiedOnly,    setModifiedOnly]    = useState(false)

    // ── Socket listeners ──────────────────────────────────────────────────
    useEffect(() => {
        const sock = getSocket()

        const onResult = (data: { ok: boolean | null; loading?: boolean; params?: Record<string, LiveParam>; count?: number; error?: string }) => {
            if (data.loading) { setLoading(true); setFetchError(null); return }
            setLoading(false)
            if (data.ok === true && data.params) {
                setLiveParams(data.params)
                // Record original snapshot for revert-to-original
                const snap: Record<string, number> = {}
                Object.entries(data.params).forEach(([k, lp]) => { snap[k] = lp.value })
                setOriginalSnapshot(snap)
                setLocalEdits({})
                setPending({})
                setAckStatus({})
                setFetchError(null)
            } else if (data.ok === false) {
                setFetchError(data.error ?? 'Unknown error')
            }
        }

        const onAck = (data: { key: string; ok: boolean; value: number }) => {
            setPending(prev => { const n = { ...prev }; delete n[data.key]; return n })
            setAckStatus(prev => ({ ...prev, [data.key]: data.ok }))
            if (data.ok) {
                // Update live value with confirmed value from drone
                setLiveParams(prev => prev ? { ...prev, [data.key]: { ...prev[data.key], value: data.value } } : prev)
                setLocalEdits(prev => { const n = { ...prev }; delete n[data.key]; return n })
                // Clear success indicator after 2 s
                setTimeout(() => setAckStatus(prev => { const n = { ...prev }; delete n[data.key]; return n }), 2000)
            }
        }

        sock.on('params_result',  onResult)
        sock.on('param_set_ack',  onAck)
        return () => { sock.off('params_result', onResult); sock.off('param_set_ack', onAck) }
    }, [])

    const fetchParams = useCallback(() => {
        setFetchError(null)
        getSocket().emit('fetch_params')
    }, [])

    const sendParam = useCallback((key: string, value: number, paramType: string) => {
        setLocalEdits(prev => ({ ...prev, [key]: value }))
        setPending(prev => ({ ...prev, [key]: true }))
        setAckStatus(prev => { const n = { ...prev }; delete n[key]; return n })
        getSocket().emit('set_param', { key, value, param_type: paramType })
    }, [])

    // Revert a single param to the value it had when we last fetched from drone
    const revertParam = useCallback((key: string) => {
        if (!liveParams || originalSnapshot[key] === undefined) return
        const lp = liveParams[key]
        if (!lp) return
        sendParam(key, originalSnapshot[key], lp.type)
    }, [liveParams, originalSnapshot, sendParam])

    // Revert all modified params back to original snapshot values
    const revertAll = useCallback(() => {
        if (!liveParams) return
        const toRevert = Object.entries(liveParams).filter(([k, lp]) => originalSnapshot[k] !== undefined && lp.value !== originalSnapshot[k])
        if (toRevert.length === 0) return
        if (!window.confirm(`Revert ${toRevert.length} parameter${toRevert.length !== 1 ? 's' : ''} back to loaded values?`)) return
        toRevert.forEach(([k, lp]) => sendParam(k, originalSnapshot[k], lp.type))
    }, [liveParams, originalSnapshot, sendParam])

    // Export current live params as PX4 .params file
    const downloadParams = useCallback(() => {
        if (!liveParams) return
        const lines = ['# Onboard parameters for Vehicle 1', '#', '# Vehicle-Id\tComponent-Id\tName\tValue\tType']
        Object.entries(liveParams).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, lp]) => {
            const type  = lp.type === 'int' ? 6 : 9
            const value = lp.type === 'int' ? Math.round(lp.value) : lp.value.toFixed(6)
            lines.push(`1\t1\t${key}\t${value}\t${type}`)
        })
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href = url; a.download = 'parameters.params'; a.click()
        URL.revokeObjectURL(url)
    }, [liveParams])

    // Parse and apply a PX4 .params file
    const importFileRef = useRef<HTMLInputElement>(null)
    const importParams = useCallback((file: File) => {
        const reader = new FileReader()
        reader.onload = e => {
            const text = e.target?.result as string
            const entries: { key: string; value: number; type: string }[] = []
            text.split('\n').forEach(line => {
                const t = line.trim()
                if (!t || t.startsWith('#')) return
                const parts = t.split(/\s+/)
                if (parts.length < 5) return
                const [, , key, valueStr, typeStr] = parts
                const value = parseFloat(valueStr)
                if (!isNaN(value)) entries.push({ key, value, type: typeStr === '6' ? 'int' : 'float' })
            })
            if (entries.length === 0) { alert('No parameters found in file'); return }
            if (!window.confirm(`Import and apply ${entries.length} parameters from file? This will overwrite current values.`)) return
            entries.forEach(({ key, value, type }) => sendParam(key, value, type))
        }
        reader.readAsText(file)
    }, [sendParam])

    const rebootFC = useCallback(() => {
        if (!window.confirm('Reboot the flight controller? The drone will restart and lose connection briefly.')) return
        getSocket().emit('drone_action', { action: 'reboot' })
    }, [])

    // ── Derive display params from live data ──────────────────────────────
    const displayParams = useMemo<DisplayParam[]>(() => {
        if (!liveParams) return []
        return Object.entries(liveParams).map(([key, lp]) => {
            const meta = PX4_META[key] ?? null
            return {
                key,
                meta,
                group: meta?.group ?? getGroupFromKey(key),
                liveValue: lp.value,
                paramType: lp.type,
                defaultValue: null,
            }
        })
    }, [liveParams])

    // Available groups (with counts)
    const groupCounts = useMemo(() => {
        const counts: Partial<Record<PX4Group, number>> = {}
        displayParams.forEach(dp => {
            if (!expert && dp.meta?.expert) return
            counts[dp.group] = (counts[dp.group] ?? 0) + 1
        })
        return counts
    }, [displayParams, expert])

    const availableGroups = useMemo(() =>
        (Object.keys(groupCounts) as PX4Group[]).sort(), [groupCounts])

    const modifiedCount = Object.keys(localEdits).length + Object.values(pending).filter(Boolean).length
    // params that differ from original snapshot (persistent changes sent to drone)
    const originalModCount = liveParams
        ? Object.entries(liveParams).filter(([k, lp]) => originalSnapshot[k] !== undefined && lp.value !== originalSnapshot[k]).length
        : 0

    const isSearching = query.trim().length > 0

    const filteredLive = useMemo(() => {
        let ps = displayParams
        if (!expert) ps = ps.filter(dp => !dp.meta?.expert)
        if (modifiedOnly) ps = ps.filter(dp => localEdits[dp.key] !== undefined || pending[dp.key])
        if (isSearching) {
            const q = query.toLowerCase()
            return ps.filter(dp =>
                dp.key.toLowerCase().includes(q) ||
                (dp.meta?.name ?? humanizeParamKey(dp.key)).toLowerCase().includes(q) ||
                (dp.meta?.desc ?? '').toLowerCase().includes(q)
            )
        }
        if (modifiedOnly) return ps
        return ps.filter(dp => dp.group === activeGroup)
    }, [displayParams, expert, modifiedOnly, localEdits, pending, isSearching, query, activeGroup])

    // ── Demo mode (not connected / not fetched) ───────────────────────────
    const [demoQuery,       setDemoQuery]       = useState('')
    const [demoActiveCat,   setDemoActiveCat]   = useState('system')
    const [demoExpert,      setDemoExpert]       = useState(false)
    const [demoOverrides,   setDemoOverrides]   = useState<Record<string, number>>({})

    const getDemoVal    = (key: string) => demoOverrides[key] ?? (PARAMS_DB.find(p => p.key === key)?.val ?? 0)
    const setDemoVal    = (key: string, v: number) => setDemoOverrides(prev => ({ ...prev, [key]: v }))
    const revertDemo    = (key: string) => setDemoOverrides(prev => { const n = { ...prev }; delete n[key]; return n })
    const demoModCount  = PARAMS_DB.filter(p => getDemoVal(p.key) !== p.def).length
    const isDemoSearching = demoQuery.trim().length > 0

    const demoFiltered = (() => {
        let ps = PARAMS_DB
        if (!demoExpert) ps = ps.filter(p => !p.expert)
        if (isDemoSearching) {
            const q = demoQuery.toLowerCase()
            return ps.filter(p => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q))
        }
        return ps.filter(p => p.cat === demoActiveCat)
    })()

    // ── RENDER ────────────────────────────────────────────────────────────
    const isExpertOn  = liveParams ? expert : demoExpert
    const isSearching_combined = liveParams ? isSearching : isDemoSearching

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

            {/* ── Toolbar ── */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                    {liveParams
                        ? <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search all ${displayParams.length} parameters…`}
                            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 9, background: '#0d1520', border: '1.5px solid #1e293b', color: '#f1f5f9', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                            onFocus={e => { (e.target as HTMLInputElement).style.borderColor = '#334155' }}
                            onBlur={e =>  { (e.target as HTMLInputElement).style.borderColor = '#1e293b' }} />
                        : <input value={demoQuery} onChange={e => setDemoQuery(e.target.value)} placeholder="Search demo parameters — connect drone to see live values…"
                            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 9, background: '#0d1520', border: '1.5px solid #1e293b', color: '#f1f5f9', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                            onFocus={e => { (e.target as HTMLInputElement).style.borderColor = '#334155' }}
                            onBlur={e =>  { (e.target as HTMLInputElement).style.borderColor = '#1e293b' }} />
                    }
                </div>
                <button onClick={() => liveParams ? setExpert(e => !e) : setDemoExpert(e => !e)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 13px', borderRadius: 8, border: `1.5px solid ${isExpertOn ? '#ca8a04' : '#1e293b'}`, background: isExpertOn ? 'rgba(202,138,4,0.1)' : '#0d1520', color: isExpertOn ? '#fbbf24' : '#64748b', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: isExpertOn ? 600 : 400 }}>
                    <Zap size={12} />{isExpertOn ? 'Expert on' : 'Beginner'}
                </button>
                {(originalModCount > 0 || modifiedCount > 0) && liveParams && (
                    <>
                        <button onClick={() => setModifiedOnly(m => !m)} style={{ padding: '7px 11px', borderRadius: 7, background: modifiedOnly ? 'rgba(251,191,36,0.15)' : 'rgba(251,191,36,0.08)', border: `1px solid ${modifiedOnly ? 'rgba(251,191,36,0.5)' : 'rgba(251,191,36,0.25)'}`, fontSize: 12, fontWeight: 600, color: '#fbbf24', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                            {originalModCount > 0 ? originalModCount : modifiedCount} modified{modifiedOnly ? ' ✕' : ' →'}
                        </button>
                        {originalModCount > 0 && (
                            <button onClick={revertAll} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 11px', borderRadius: 7, background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.2)', fontSize: 12, color: '#92400e', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                <RotateCcw size={11} /> Revert all
                            </button>
                        )}
                    </>
                )}
                {liveParams
                    ? <button onClick={fetchParams} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 13px', borderRadius: 8, border: '1px solid #1e293b', background: '#0d1520', color: '#64748b', fontSize: 12, cursor: 'pointer' }}>
                        <RotateCcw size={12} /> Refresh
                      </button>
                    : connected && !loading
                    ? <button onClick={fetchParams} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 8, border: '1.5px solid rgba(74,222,128,0.35)', background: 'rgba(74,222,128,0.08)', color: '#4ade80', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                        <Wifi size={12} /> Load from Drone
                      </button>
                    : null
                }
            </div>

            {/* ── Expert warning ── */}
            {isExpertOn && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)' }}>
                    <AlertTriangle size={13} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0, lineHeight: 1.55 }}>
                        <span style={{ color: '#f87171', fontWeight: 600 }}>Expert mode — </span>
                        parameters marked ⚠ can destabilise the drone. Change PIDs in steps of 0.01 max. Always hover-test after any change.
                    </p>
                </div>
            )}

            {/* ── Loading ── */}
            {loading && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '64px 0' }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', border: '3px solid #1e293b', borderTop: '3px solid #22d3ee', animation: 'spin 0.8s linear infinite' }} />
                    <div style={{ textAlign: 'center' }}>
                        <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>Downloading parameters from drone…</p>
                        <p style={{ fontSize: 12, color: '#475569', margin: '5px 0 0' }}>This takes 5–30 s on a fresh MAVLink connection</p>
                    </div>
                </div>
            )}

            {/* ── Error ── */}
            {fetchError && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}>
                    <AlertTriangle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 13, color: '#f87171', margin: 0, fontWeight: 600 }}>Download failed</p>
                        <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>{fetchError}</p>
                    </div>
                    <button onClick={fetchParams} style={{ padding: '6px 14px', borderRadius: 7, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: 12, cursor: 'pointer' }}>Retry</button>
                </div>
            )}

            {/* ── Demo banner ── */}
            {!liveParams && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.15)' }}>
                    <Info size={13} style={{ color: '#22d3ee', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 12, color: '#22d3ee', margin: 0, fontWeight: 600 }}>Demo mode — example parameters only</p>
                        <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>
                            {connected ? 'Drone is connected — click "Load from Drone" to read real values' : 'Connect your drone, then click "Load from Drone" to browse and edit live parameters'}
                        </p>
                    </div>
                </div>
            )}

            {/* ── Live status bar ── */}
            {liveParams && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.15)' }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 600 }}>{displayParams.length} parameters from drone</span>
                    <span style={{ fontSize: 11, color: '#475569' }}>
                        · {Object.keys(PX4_META).filter(k => liveParams[k]).length} with descriptions
                        · {displayParams.filter(d => !d.meta).length} raw (no metadata)
                    </span>
                </div>
            )}

            {/* ── Main two-pane layout: sidebar + content ── */}
            {!loading && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>

                    {/* ── Left sidebar nav (hidden while searching or in modified-only view) ── */}
                    {!isSearching_combined && !modifiedOnly && (
                        <>
                            <nav style={{ width: 196, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {liveParams
                                    ? availableGroups.map(grp => {
                                        const s = GROUP_STYLE[grp] ?? GROUP_STYLE['Other']
                                        return (
                                            <ParamSidebarItem key={grp} label={grp} count={groupCounts[grp] ?? 0}
                                                color={s.color} Icon={s.icon} active={grp === activeGroup}
                                                onClick={() => setActiveGroup(grp)} />
                                        )
                                    })
                                    : PARAM_CATS.map(cat => {
                                        const cnt = (demoExpert ? PARAMS_DB : PARAMS_DB.filter(p => !p.expert)).filter(p => p.cat === cat.id).length
                                        return (
                                            <ParamSidebarItem key={cat.id} label={cat.label} count={cnt}
                                                color={cat.color} Icon={cat.icon} active={cat.id === demoActiveCat}
                                                onClick={() => setDemoActiveCat(cat.id)} />
                                        )
                                    })
                                }
                            </nav>
                            <div style={{ width: 1, alignSelf: 'stretch', background: '#1e293b', margin: '0 14px', flexShrink: 0 }} />
                        </>
                    )}

                    {/* ── Right content area ── */}
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

                        {/* Content header */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 22 }}>
                            {modifiedOnly && liveParams ? (
                                <span style={{ fontSize: 12, color: '#fbbf24' }}>
                                    {filteredLive.length} modified parameter{filteredLive.length !== 1 ? 's' : ''} across all groups
                                </span>
                            ) : isSearching_combined ? (
                                <span style={{ fontSize: 12, color: '#94a3b8' }}>
                                    {liveParams
                                        ? `${filteredLive.length} result${filteredLive.length !== 1 ? 's' : ''} for "${query}" across all groups`
                                        : `${demoFiltered.length} result${demoFiltered.length !== 1 ? 's' : ''} for "${demoQuery}"`
                                    }
                                </span>
                            ) : liveParams ? (
                                <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: GROUP_STYLE[activeGroup]?.color ?? '#22d3ee', flexShrink: 0 }} />
                                        <span style={{ fontSize: 12, color: '#94a3b8' }}>
                                            {activeGroup} — {groupCounts[activeGroup] ?? 0} parameter{(groupCounts[activeGroup] ?? 0) !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    {!expert && displayParams.filter(d => d.group === activeGroup && d.meta?.expert).length > 0 && (
                                        <button onClick={() => setExpert(true)} style={{ fontSize: 11, color: '#ca8a04', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                            +{displayParams.filter(d => d.group === activeGroup && d.meta?.expert).length} expert params →
                                        </button>
                                    )}
                                </>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                                        {PARAM_CATS.find(c => c.id === demoActiveCat)?.label} — {demoFiltered.length} example parameters
                                    </span>
                                    {demoModCount > 0 && <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>{demoModCount} modified</span>}
                                </div>
                            )}
                        </div>

                        {/* ── Param grid ── */}
                        {liveParams ? (
                            filteredLive.length > 0 ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                                    {filteredLive.map(dp => (
                                        <LiveParamCard key={dp.key} dp={dp}
                                            localVal={localEdits[dp.key]} pending={!!pending[dp.key]}
                                            lastOk={ackStatus[dp.key] ?? null} expert={expert}
                                            originalVal={originalSnapshot[dp.key]}
                                            onSet={sendParam} onRevert={revertParam} />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '56px 0', color: '#475569', fontSize: 13 }}>
                                    {isSearching ? `No parameters match "${query}"` : 'No parameters in this group'}
                                </div>
                            )
                        ) : (
                            demoFiltered.length > 0 ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                                    {demoFiltered.map(p => (
                                        <ParamCard key={p.key} p={p} currentVal={getDemoVal(p.key)}
                                            catColor={PARAM_CATS.find(c => c.id === p.cat)?.color ?? '#22d3ee'}
                                            isSearching={isDemoSearching} onSet={setDemoVal} onRevert={revertDemo} />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '56px 0', color: '#475569', fontSize: 13 }}>
                                    No parameters match your search
                                </div>
                            )
                        )}
                    </div>
                </div>
            )}

            {/* ── Footer action bar ── */}
            <input ref={importFileRef} type="file" accept=".params,.txt" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) { importParams(f); e.target.value = '' } }} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
                {/* Export */}
                <button onClick={downloadParams} disabled={!liveParams}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 9, background: '#0d1520', border: '1px solid #1e293b', cursor: liveParams ? 'pointer' : 'default', opacity: liveParams ? 1 : 0.35, textAlign: 'left', width: '100%' }}>
                    <Download size={14} style={{ color: '#60a5fa', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', margin: 0 }}>Export .params</p>
                        <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>Download backup file</p>
                    </div>
                </button>
                {/* Import */}
                <button onClick={() => liveParams && importFileRef.current?.click()} disabled={!liveParams}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 9, background: '#0d1520', border: '1px solid #1e293b', cursor: liveParams ? 'pointer' : 'default', opacity: liveParams ? 1 : 0.35, textAlign: 'left', width: '100%' }}>
                    <Upload size={14} style={{ color: '#c084fc', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', margin: 0 }}>Import .params</p>
                        <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>Apply from backup file</p>
                    </div>
                </button>
                {/* Reboot FC */}
                <button onClick={connected ? rebootFC : undefined} disabled={!connected}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 9, background: '#0d1520', border: `1px solid ${connected ? 'rgba(248,113,113,0.2)' : '#1e293b'}`, cursor: connected ? 'pointer' : 'default', opacity: connected ? 1 : 0.35, textAlign: 'left', width: '100%' }}>
                    <Power size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', margin: 0 }}>Reboot FC</p>
                        <p style={{ fontSize: 10, color: '#475569', margin: 0 }}>Restart flight controller</p>
                    </div>
                </button>
            </div>
        </div>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConfigPage() {
    const telStatus    = useDroneStore(s => s.telemetryStatus)
    const telemetry    = useDroneStore(s => s.telemetry)
    const terrainFollow = useMissionStore(s => s.terrainFollow)

    const [view, setView]       = useState<'grid' | 'workspace'>('grid')
    const [section, setSection] = useState<SectionId>('connection')
    const [address, setAddress] = useState(() => ls('hyrak-mav-address', 'udpin://0.0.0.0:14540'))

    const [vehicle, setVehicle] = useState<VehicleProfile>(() => ls('hyrak-vehicle', { name: 'My Drone', airframe: 'quad-x', firmware: 'px4', frameId: '' }))
    const [power,   setPower]   = useState<PowerProfile>(()   => ls('hyrak-power',   { cells: '4', capacity: '5000', warnPct: 25, critPct: 10, critAction: 'rtl' }))
    const [safety,  setSafety]  = useState<SafetyProfile>(()  => ls('hyrak-safety',  { signalLoss: 'rtl', maxAltEnabled: false, maxAlt: 120, maxDistEnabled: false, maxDist: 500, rthAlt: 50 }))
    const [flight,  setFlight]  = useState<FlightProfile>(()  => ls('hyrak-flight',  { takeoffAlt: 10, loiterRadius: 50, rthMode: 'ascend' }))
    const [radio,   setRadio]   = useState<RadioProfile>(()   => ls('hyrak-radio',   { rcMode: '2', modes: ['Stabilize', 'Altitude Hold', 'Position'] }))

    const upV = useCallback((p: Partial<VehicleProfile>) => setVehicle(prev => { const n={...prev,...p}; lsSet('hyrak-vehicle',n); return n }), [])
    const upP = useCallback((p: Partial<PowerProfile>)   => setPower(prev =>   { const n={...prev,...p}; lsSet('hyrak-power',  n); return n }), [])
    const upS = useCallback((p: Partial<SafetyProfile>)  => setSafety(prev =>  { const n={...prev,...p}; lsSet('hyrak-safety', n); return n }), [])
    const upF = useCallback((p: Partial<FlightProfile>)  => setFlight(prev =>  { const n={...prev,...p}; lsSet('hyrak-flight', n); return n }), [])
    const upR = useCallback((p: Partial<RadioProfile>)   => setRadio(prev =>   { const n={...prev,...p}; lsSet('hyrak-radio',  n); return n }), [])

    const connected = telStatus === 'connected'
    const sensorOK = [
        connected && (telemetry?.position?.latitude_deg ?? 0) !== 0,
        connected && telemetry?.attitude != null,
        connected && (telemetry?.heading_deg ?? 0) !== 0,
        connected && (telemetry?.position?.relative_altitude_m ?? 0) !== 0,
    ].filter(Boolean).length

    const domainPcts: Record<SectionId, number> = {
        connection:  connected ? 100 : 30,
        vehicle:     [vehicle.name !== 'My Drone', !!vehicle.airframe, !!vehicle.firmware].filter(Boolean).length * 33.3,
        sensors:     connected ? (sensorOK / 4) * 100 : 0,
        radio:       75,
        power:       power.capacity ? 100 : 50,
        safety:      100,
        flight:      100,
        parameters:  80,
    }
    const readiness = Math.round(DOMAIN_META.slice(0, 7).reduce((s, d) => s + domainPcts[d.id], 0) / 7)
    const tabs = DOMAIN_META.map(d => ({ ...d, color: hColor(domainPcts[d.id], d.id === 'parameters'), pct: domainPcts[d.id] }))

    // ── Two-finger swipe back interception ────────────────────────────────────
    const viewRef        = useRef(view)
    const navBackRef     = useRef(false)
    viewRef.current      = view

    useEffect(() => {
        if (view === 'workspace') {
            window.history.pushState({ hyrakConfig: true }, '')
        }
    }, [view])

    useEffect(() => {
        const handle = () => {
            if (navBackRef.current) { navBackRef.current = false; return }
            if (viewRef.current === 'workspace') setView('grid')
        }
        window.addEventListener('popstate', handle)
        return () => window.removeEventListener('popstate', handle)
    }, [])

    const goToGrid = useCallback(() => {
        navBackRef.current = true
        setView('grid')
        if (window.history.state?.hyrakConfig) window.history.back()
    }, [])

    const openSection = (id: SectionId) => { setSection(id); setView('workspace') }
    const inGrid = view === 'grid'
    const meta = DOMAIN_META.find(d => d.id === section) ?? DOMAIN_META[0]

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <VehicleBanner vehicle={vehicle} readiness={readiness} telStatus={telStatus ?? 'disconnected'} address={address} />

            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {/* ── Grid overview ──────────────────────────────────────── */}
                <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '16px 20px', opacity: inGrid ? 1 : 0, transform: inGrid ? 'scale(1)' : 'scale(0.97)', transition: 'opacity 0.2s ease, transform 0.2s ease', pointerEvents: inGrid ? 'auto' : 'none' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                        {DOMAIN_META.map(d => (
                            <DomainCard key={d.id} id={d.id} label={d.label} icon={d.icon}
                                pct={domainPcts[d.id]} color={hColor(domainPcts[d.id], d.id === 'parameters')}
                                metrics={
                                    d.id === 'connection'  ? [{ k: 'status', v: connected ? 'Connected' : 'Disconnected' }, { k: 'link', v: address.split('//')[1]?.split(':')[0] ?? '—' }]
                                  : d.id === 'vehicle'     ? [{ k: 'name', v: vehicle.name }, { k: 'frame', v: AIRFRAME_LABELS[vehicle.airframe] ?? vehicle.airframe }]
                                  : d.id === 'sensors'     ? [{ k: 'health', v: connected ? `${sensorOK}/4 OK` : 'No data' }]
                                  : d.id === 'radio'       ? [{ k: 'mode', v: `Mode ${radio.rcMode}` }, { k: 'slots', v: `${radio.modes.length} configured` }]
                                  : d.id === 'power'       ? [{ k: 'pack', v: `${power.cells}S · ${power.capacity}mAh` }, { k: 'critical', v: `${power.critAction.toUpperCase()} @ ${power.critPct}%` }]
                                  : d.id === 'safety'      ? [{ k: 'terrain', v: terrainFollow ? 'Follow ON' : 'Follow OFF' }, { k: 'loss', v: `${safety.signalLoss.toUpperCase()} on loss` }]
                                  : d.id === 'flight'      ? [{ k: 'takeoff', v: `${flight.takeoffAlt}m` }, { k: 'RTH', v: `${safety.rthAlt}m` }]
                                  : [{ k: 'params', v: `${PARAMS_DB.length} available` }, { k: 'subsystems', v: `${PARAM_CATS.length} sections` }]
                                }
                                onClick={() => openSection(d.id)} />
                        ))}
                    </div>
                </div>

                {/* ── Workspace ──────────────────────────────────────────── */}
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', opacity: !inGrid ? 1 : 0, transform: !inGrid ? 'scale(1)' : 'scale(1.015)', transition: 'opacity 0.2s ease, transform 0.2s ease', pointerEvents: !inGrid ? 'auto' : 'none' }}>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 16px' }}>
                        <SectionHead meta={meta} pct={domainPcts[section]} />
                        {section === 'connection' && <ConnectionWorkspace address={address} setAddress={v => { setAddress(v); lsSet('hyrak-mav-address', v) }} />}
                        {section === 'vehicle'    && <VehicleWorkspace v={vehicle} onUpdate={upV} />}
                        {section === 'sensors'    && <SensorsWorkspace />}
                        {section === 'radio'      && <RadioWorkspace r={radio} onUpdate={upR} />}
                        {section === 'power'      && <PowerWorkspace p={power} onUpdate={upP} />}
                        {section === 'safety'     && <SafetyWorkspace s={safety} onUpdate={upS} />}
                        {section === 'flight'     && <FlightWorkspace f={flight} onUpdate={upF} rthAlt={safety.rthAlt} maxAlt={safety.maxAlt} maxAltEnabled={safety.maxAltEnabled} />}
                        {section === 'parameters' && <ParametersWorkspace />}
                    </div>
                    <SectionTabBar current={section} onSelect={setSection} onBack={goToGrid} tabs={tabs} />
                </div>
            </div>
        </div>
    )
}

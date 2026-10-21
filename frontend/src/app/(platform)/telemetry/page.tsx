'use client'

import { useAccess } from '@/hooks/useAccess'
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useDroneStore } from '@/store/drone'
import { useCalibration } from '@/hooks/useCalibration'
import { CalibrationStage } from '@/components/config/CalibrationStage'
import { CAL_SENSORS } from '@/types/calibration'
import { useMissionStore } from '@/store/mission'
import { getSocket } from '@/lib/socket'
import {
    Radio, Wifi, WifiOff, Check, RotateCcw,
    Plane, Gauge, SlidersHorizontal, Battery, Shield, Navigation,
    Terminal, Lock, Info, ChevronLeft, ChevronRight, LayoutList,
    Search, AlertTriangle, Cpu, Move, Zap,
    Download, Upload, Power,
    Satellite, Compass as CompassIcon, Activity, Mountain,
    Move3d, Camera, AlignCenterHorizontal, RotateCw, Loader, Package,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PX4_META, getGroupFromKey, humanizeParamKey, type PX4Group, type PX4Meta } from '@/lib/px4-params-meta'
import { getRfDownlinkPort, setRfDownlinkPort, getRfUplinkPort, setRfUplinkPort, getRfUplinkHost, setRfUplinkHost } from '@/lib/rfBridge'
import { useLiveScope } from '@/hooks/useLiveScope'
import { disconnectTelemetryLink } from '@/hooks/useDrone'
import { ViewOnlyFence } from '@/components/layout/ViewOnly'
import { AttachmentsSection } from '@/components/attachments/AttachmentsConfig'
import { useSessionAttachments } from '@/lib/attachments'
import { useUiMode } from '@/hooks/useUiMode'
import { OptionSelect } from '@/components/config/OptionSelect'

function ls<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
    if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(val))
}
/** A colour (hex or var()) at an alpha, for tints of theme tokens. */
function mix(c: string, pct: number) {
    return `color-mix(in srgb, ${c} ${pct}%, transparent)`
}
function hColor(pct: number, locked = false) {
    if (locked) return 'hsl(var(--app-text-muted))'
    if (pct >= 100) return 'var(--app-ok)'
    if (pct >= 65)  return 'var(--app-accent)'
    if (pct >= 35)  return 'var(--app-warn)'
    return 'var(--app-danger)'
}

type SectionId = 'connection' | 'vehicle' | 'sensors' | 'radio' | 'power' | 'safety' | 'flight' | 'parameters' | 'attachments'
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
// Sentinel address for the wfb-ng air-unit preset - ConnectionWorkspace's
// connect() special-cases this to fire 'connect_rf_bridge' instead of a
// plain 'connect_telemetry', since the RF link needs the split-port bridge
// in app/telemetry/rf_bridge.py rather than a direct MAVSDK udpin:// connect.
const RF_BRIDGE_ADDR = 'rfbridge://wfb-ng'

const MAV_PRESETS = [
    { label: 'PX4 SITL (UDP)',        addr: 'udpin://0.0.0.0:14540' },
    { label: 'ArduPilot SITL',        addr: 'udpin://0.0.0.0:14550' },
    { label: 'Custom RF air unit (wfb-ng)', addr: RF_BRIDGE_ADDR },
    { label: 'USB / Telemetry Radio', addr: 'serial:///dev/ttyUSB0:57600' },
    { label: 'TCP (companion)',        addr: 'tcp://192.168.1.1:5760' },
]
const DOMAIN_META: { id: SectionId; label: string; icon: React.ElementType; desc: string }[] = [
    { id: 'connection', label: 'Connection',  icon: Radio,             desc: 'MAVLink link to your drone or SITL simulator' },
    { id: 'vehicle',    label: 'Vehicle',     icon: Plane,             desc: 'Drone identity, airframe type, and firmware' },
    { id: 'sensors',    label: 'Sensors',     icon: Gauge,             desc: 'Live sensor health and calibration' },
    { id: 'radio',      label: 'Radio & RC',  icon: SlidersHorizontal, desc: 'Stick layout and flight mode channel assignments' },
    { id: 'power',      label: 'Power',       icon: Battery,           desc: 'Battery pack configuration and failsafe thresholds' },
    { id: 'safety',     label: 'Safety',      icon: Shield,            desc: 'Failsafes, terrain following, and geofence limits' },
    { id: 'flight',     label: 'Flight',      icon: Navigation,        desc: 'Altitude defaults and return-to-home behaviour' },
    { id: 'parameters', label: 'Advanced',     icon: Terminal,          desc: '50+ PX4 parameters across 8 subsystems - search, browse, and edit' },
    { id: 'attachments', label: 'Attachments', icon: Package,           desc: 'What is fitted to the drone: drop hook, gripper, winch, light, speaker, sprayer' },
]

const PARAM_CATS = [
    { id: 'system',    label: 'System',           icon: Cpu,              color: 'var(--app-accent)', desc: 'Core identity and MAVLink' },
    { id: 'position',  label: 'Position',         icon: Move,             color: 'var(--app-ok)', desc: 'Speed and position limits' },
    { id: 'attitude',  label: 'Attitude & PIDs',  icon: RotateCcw,        color: 'light-dark(#c2410c, #f97316)', desc: 'Rate controllers and gains' },
    { id: 'battery',   label: 'Battery',          icon: Battery,          color: 'var(--app-warn)', desc: 'Cell count and thresholds' },
    { id: 'safety',    label: 'Safety',           icon: Shield,           color: 'var(--app-danger)', desc: 'Failsafes and geofence' },
    { id: 'nav',       label: 'Navigation',       icon: Navigation,       color: 'light-dark(#7e22ce, #c084fc)', desc: 'Mission waypoints' },
    { id: 'sensors',   label: 'Sensors & EKF',    icon: Gauge,            color: 'light-dark(#1d4ed8, #60a5fa)', desc: 'Fusion weights and flags' },
    { id: 'actuators', label: 'Actuators',        icon: SlidersHorizontal,color: 'light-dark(#c2410c, #fb923c)', desc: 'Motors and PWM outputs' },
]

const PARAMS_DB: Param[] = [
    // SYSTEM
    { key: 'SYS_AUTOSTART',    name: 'Airframe Preset ID',       desc: 'PX4 airframe preset loaded at boot. Changing this resets the entire mixer and output mapping to a new vehicle type.',  cat: 'system',    type: 'int',   val: 4302, def: 4001, min: 0,    max: 99999, step: 1,    expert: true,  danger: true },
    { key: 'MAV_SYS_ID',       name: 'MAVLink System ID',        desc: 'Unique identifier for this vehicle on the MAVLink network. Only change if running multiple drones on the same link.',     cat: 'system',    type: 'int',   val: 1,    def: 1,    min: 1,    max: 255,   step: 1 },
    { key: 'COM_ARM_EKF_POS',  name: 'EKF Position Arming Check',desc: 'Prevent arming if the EKF position estimate quality is below threshold. Strongly recommended to keep on.',              cat: 'system',    type: 'bool',  val: 1,    def: 1 },
    { key: 'CBRK_IO_SAFETY',   name: 'Skip Safety Switch',       desc: 'Bypass the hardware safety button. Set to 22027 to skip it entirely - useful for bench testing without a physical switch.', cat: 'system', type: 'int',   val: 0,    def: 0,    min: 0,    max: 22027, step: 22027, expert: true, danger: true },
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
    { key: 'BAT_N_CELLS',      name: 'Battery Cell Count (S)',   desc: 'Number of lithium cells wired in series. Critical - a wrong value causes incorrect voltage readings and false battery warnings.', cat: 'battery', type: 'int',  val: 4,    def: 4,    min: 1,    max: 14,    step: 1,    unit: 'S',   danger: true },
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
    { key: 'MIS_DIST_1WP',    name: 'Max First Waypoint Dist',  desc: 'Safety check - prevents uploading a mission whose first waypoint is further than this from the home position.',            cat: 'nav',       type: 'float', val: 900.0,def: 900.0,min: 0,    max: 10000, step: 50,   unit: 'm' },
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
    { key: 'CA_ROTOR_COUNT',  name: 'Number of Rotors',         desc: 'Physical rotor count on the vehicle. Must match the airframe geometry - a mismatch will prevent correct mixing.',          cat: 'actuators', type: 'int',   val: 4,    def: 4,    min: 1,    max: 12,    step: 1,     danger: true },
]

// ── Base SVG ──────────────────────────────────────────────────────────────────

// ── Diagram labels at a fixed reading size ──────────────────────────────────
//
// The setup diagrams are SVGs in viewBox units, so their text used to scale
// with the panel: 9 px on a phone, 36 px on a wide screen. This measures the
// rendered width and hands back a font size in viewBox units that lands on
// 12-16 px on screen, whatever the panel width.
function useSvgPx(viewBoxWidth: number) {
    const ref = useRef<SVGSVGElement>(null)
    const [scale, setScale] = useState(1)
    useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width ?? 0
            if (w > 0) setScale(w / viewBoxWidth)
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [viewBoxWidth])
    const px = useCallback((size: number) => Math.min(16, Math.max(12, size)) / scale, [scale])
    return [ref, px] as const
}

function DroneSVG({ airframe, size = 56 }: { airframe: string; size?: number }) {
    const s = size, c = s / 2
    if (airframe === 'coaxial') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            <circle cx={c} cy={c} r={s*0.32} stroke="var(--app-accent)" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.35} />
            <circle cx={c} cy={c} r={s*0.16} fill="var(--app-accent)" opacity={0.15} stroke="var(--app-accent)" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.06} fill="var(--app-accent)" opacity={0.9} />
            <line x1={c} y1={c} x2={c} y2={s*0.22} stroke="var(--app-accent)" strokeWidth={2} opacity={0.5} />
            <polygon points={`${c},${s*0.14} ${c-s*0.055},${s*0.25} ${c+s*0.055},${s*0.25}`} fill="var(--app-accent)" opacity={0.8} />
        </svg>
    )
    if (airframe === 'hex') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            {[0,60,120,180,240,300].map((deg, i) => {
                const rad = (deg - 90) * Math.PI / 180, r = s * 0.34
                const x = c + r * Math.cos(rad), y = c + r * Math.sin(rad)
                return <g key={i}><line x1={c} y1={c} x2={x} y2={y} stroke="var(--app-accent)" strokeWidth={1.5} opacity={0.4} /><circle cx={x} cy={y} r={s*0.1} fill="var(--app-accent)" opacity={0.1} stroke="var(--app-accent)" strokeWidth={1.2} /></g>
            })}
            <circle cx={c} cy={c} r={s*0.13} fill="var(--app-accent)" opacity={0.15} stroke="var(--app-accent)" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.055} fill="var(--app-accent)" opacity={0.9} />
            <polygon points={`${c},${c-s*0.12} ${c-s*0.055},${c-s*0.02} ${c+s*0.055},${c-s*0.02}`} fill="var(--app-accent)" opacity={0.8} />
        </svg>
    )
    if (airframe === 'vtol-tilt') return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            <ellipse cx={c} cy={c} rx={s*0.07} ry={s*0.22} fill="var(--app-accent)" opacity={0.18} stroke="var(--app-accent)" strokeWidth={1.3} />
            <ellipse cx={s*0.25} cy={c} rx={s*0.18} ry={s*0.055} fill="var(--app-accent)" opacity={0.1} stroke="var(--app-accent)" strokeWidth={1} />
            <ellipse cx={s*0.75} cy={c} rx={s*0.18} ry={s*0.055} fill="var(--app-accent)" opacity={0.1} stroke="var(--app-accent)" strokeWidth={1} />
            {[s*0.14, s*0.37, s*0.63, s*0.86].map((x, i) => <circle key={i} cx={x} cy={s*0.38} r={s*0.08} fill="var(--app-accent)" opacity={0.1} stroke="var(--app-accent)" strokeWidth={1} />)}
            <polygon points={`${c},${s*0.28} ${c-s*0.055},${s*0.4} ${c+s*0.055},${s*0.4}`} fill="var(--app-accent)" opacity={0.8} />
        </svg>
    )
    return (
        <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
            {[[s*0.21,s*0.21],[s*0.79,s*0.21],[s*0.21,s*0.79],[s*0.79,s*0.79]].map(([x,y],i) => (
                <g key={i}><line x1={c} y1={c} x2={x} y2={y} stroke="var(--app-accent)" strokeWidth={1.8} opacity={0.4} /><circle cx={x} cy={y} r={s*0.14} fill="var(--app-accent)" opacity={0.1} stroke="var(--app-accent)" strokeWidth={1.5} /></g>
            ))}
            <circle cx={c} cy={c} r={s*0.14} fill="var(--app-accent)" opacity={0.18} stroke="var(--app-accent)" strokeWidth={1.5} />
            <circle cx={c} cy={c} r={s*0.063} fill="var(--app-accent)" opacity={0.9} />
            <polygon points={`${c},${c-s*0.15} ${c-s*0.055},${c-s*0.05} ${c+s*0.055},${c-s*0.05}`} fill="var(--app-accent)" opacity={0.8} />
        </svg>
    )
}

function StatusRing({ pct, color, size = 44, stroke = 3.5 }: { pct: number; color: string; size?: number; stroke?: number }) {
    const r = (size - stroke * 2) / 2, circ = 2 * Math.PI * r
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }} aria-hidden>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="hsl(var(--app-border))" strokeWidth={stroke} />
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${circ * pct / 100} ${circ}`} strokeLinecap="round" />
        </svg>
    )
}

/** A readiness ring with its value inside; a check at 100 so 3 digits never
 *  overflow the ring. Only rendered for values that are measured. */
function ReadinessRing({ pct, color, size = 52 }: { pct: number; color: string; size?: number }) {
    return (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            role="img" aria-label={`${pct.toFixed(0)}% ready`}>
            <StatusRing pct={pct} color={color} size={size} stroke={4} />
            <span style={{ position: 'absolute', fontSize: size >= 52 ? 14 : 12, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {pct >= 100 ? <Check size={size >= 52 ? 20 : 16} strokeWidth={3} /> : <>{pct.toFixed(0)}<span style={{ fontSize: 12, fontWeight: 700 }}>%</span></>}
            </span>
        </div>
    )
}

// ── Visual instruments ────────────────────────────────────────────────────────

function NetworkTopology({ connected, address }: { connected: boolean; address: string }) {
    const proto = address.split('://')[0]?.toUpperCase() ?? 'UDP'
    const host  = address.split('://')[1]?.split(':')[0] ?? '-'
    const lc = connected ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'
    const lc2 = connected ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))'
    const [ref, px] = useSvgPx(340)
    return (
        <svg ref={ref} viewBox="0 0 340 64" style={{ width: '100%', maxWidth: 480, display: 'block', overflow: 'visible', margin: '0 auto' }} role="img" aria-label="Ground station to link to autopilot">
            {/* GCS */}
            <rect x={2} y={18} width={60} height={28} rx={6} fill="color-mix(in srgb, var(--app-accent) 8%, transparent)" stroke="var(--app-accent)" strokeWidth={1.5} />
            <text x={32} y={30} textAnchor="middle" fontSize={px(13)} fontFamily="inherit" fontWeight="700" fill="var(--app-accent)">GCS</text>
            <text x={32} y={42} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">hyrak</text>
            {/* Line 1 */}
            <line x1={62} y1={32} x2={118} y2={32} stroke={lc} strokeWidth={1.5} strokeDasharray={connected ? undefined : '4 3'} />
            {connected && <circle r={2.5} fill="var(--app-accent)"><animateMotion dur="1.4s" repeatCount="indefinite" path="M 62,32 L 118,32" /></circle>}
            {/* Link node */}
            <rect x={118} y={18} width={84} height={28} rx={6} fill={connected ? 'color-mix(in srgb, var(--app-accent) 6%, transparent)' : 'hsl(var(--app-text-subtle) / 0.06)'} stroke={lc} strokeWidth={1.5} />
            <text x={160} y={30} textAnchor="middle" fontSize={px(13)} fontFamily="inherit" fontWeight="700" fill={lc}>{proto}</text>
            <text x={160} y={42} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">{host}</text>
            {/* Line 2 */}
            <line x1={202} y1={32} x2={258} y2={32} stroke={lc2} strokeWidth={1.5} strokeDasharray={connected ? undefined : '4 3'} />
            {connected && <circle r={2.5} fill="var(--app-ok)"><animateMotion dur="1.4s" repeatCount="indefinite" path="M 202,32 L 258,32" begin="0.7s" /></circle>}
            {/* FC */}
            <rect x={258} y={18} width={60} height={28} rx={6} fill={connected ? 'color-mix(in srgb, var(--app-ok) 8%, transparent)' : 'hsl(var(--app-text-subtle) / 0.06)'} stroke={lc2} strokeWidth={1.5} />
            <text x={288} y={30} textAnchor="middle" fontSize={px(13)} fontFamily="inherit" fontWeight="700" fill={lc2}>FC</text>
            <text x={288} y={42} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">autopilot</text>
            {/* Labels */}
            <text x={90} y={14} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill={connected ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'}>MAVLink</text>
            <text x={230} y={14} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill={connected ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))'}>MAVSDK</text>
        </svg>
    )
}


function BatteryCellsViz({ cells, totalV }: { cells: string; totalV?: number }) {
    const n = Math.min(parseInt(cells) || 4, 12)
    const estV = totalV ? totalV / n : 4.1
    const fillPct = Math.min(Math.max(((estV - 3.0) / (4.2 - 3.0)) * 100, 0), 100)
    const cellColor = fillPct > 60 ? 'var(--app-accent)' : fillPct > 30 ? 'var(--app-warn)' : 'var(--app-danger)'
    return (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
            <div style={{ width: 6, height: 22, background: 'hsl(var(--app-text) / 0.12)', borderRadius: 2, alignSelf: 'center' }} />
            {Array.from({ length: n }, (_, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <div style={{ width: 8, height: 5, background: `${mix(cellColor, 38)}`, borderRadius: '2px 2px 0 0' }} />
                    <div style={{ width: 20, height: 52, borderRadius: 3, background: 'hsl(var(--app-surface-2))', border: `1.5px solid ${mix(cellColor, 25)}`, position: 'relative', overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${fillPct}%`, background: `linear-gradient(to top, ${cellColor}, ${mix(cellColor, 25)})` }} />
                    </div>
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>S{i+1}</span>
                </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <div style={{ width: 8, height: 8, background: 'var(--app-ok)', borderRadius: 1, opacity: 0.7 }} />
                <div style={{ width: 6, height: 18, background: 'hsl(var(--app-text) / 0.12)', borderRadius: 2 }} />
            </div>
        </div>
    )
}

function DischargeCurve({ warnPct, critPct }: { warnPct: number; critPct: number }) {
    const W = 200, H = 72
    const warnX = (1 - warnPct / 100) * W
    const critX = (1 - critPct / 100) * W
    const curve = `M 0,${H*0.04} C ${W*0.12},${H*0.08} ${W*0.35},${H*0.18} ${W*0.62},${H*0.24} C ${W*0.78},${H*0.3} ${W*0.88},${H*0.56} ${W},${H*0.97}`
    const [ref, px] = useSvgPx(W)
    return (
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 420, display: 'block' }} role="img" aria-label="Battery discharge curve with warning and critical levels">
            <defs><clipPath id="dcc"><rect x={0} y={0} width={W} height={H} /></clipPath></defs>
            <rect x={0} y={0} width={critX} height={H} fill="color-mix(in srgb, var(--app-danger) 7%, transparent)" clipPath="url(#dcc)" />
            <rect x={critX} y={0} width={warnX-critX} height={H} fill="color-mix(in srgb, var(--app-warn) 6%, transparent)" clipPath="url(#dcc)" />
            <rect x={warnX} y={0} width={W-warnX} height={H} fill="color-mix(in srgb, var(--app-ok) 4%, transparent)" clipPath="url(#dcc)" />
            <path d={`${curve} L ${W},${H} L 0,${H} Z`} fill="color-mix(in srgb, var(--app-accent) 5%, transparent)" />
            <path d={curve} fill="none" stroke="var(--app-accent)" strokeWidth={1.8} opacity={0.7} />
            <line x1={warnX} y1={0} x2={warnX} y2={H} stroke="var(--app-warn)" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={warnX-3} y={px(12)} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="var(--app-warn)">{warnPct}%</text>
            <line x1={critX} y1={0} x2={critX} y2={H} stroke="var(--app-danger)" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={critX-3} y={px(12)} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="var(--app-danger)">{critPct}%</text>
            <text x={1} y={H-2} fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">100%, 4.2 V</text>
            <text x={W-1} y={H-2} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">0%, 3.0 V</text>
        </svg>
    )
}

function GeofenceMap({ maxDist, maxDistEnabled, rthAlt }: { maxDist: number; maxDistEnabled: boolean; rthAlt: number }) {
    const labels: [string, number, string][] = [['N',0,'var(--app-danger)'],['E',90,'hsl(var(--app-text-muted))'],['S',180,'hsl(var(--app-text-muted))'],['W',270,'hsl(var(--app-text-muted))']]
    const [ref, px] = useSvgPx(224)
    return (
        <svg ref={ref} viewBox="-112 -112 224 224" style={{ width: '100%', display: 'block' }} role="img" aria-label="Top-down view of the distance fence and return altitude">
            <defs>
                <radialGradient id="gfbg" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="color-mix(in srgb, var(--app-accent) 4%, transparent)" />
                    <stop offset="100%" stopColor="rgba(0,0,0,0)" />
                </radialGradient>
            </defs>
            <circle r={106} fill="hsl(var(--app-surface-2))" />
            <circle r={106} fill="url(#gfbg)" />
            {[-80,-60,-40,-20,0,20,40,60,80].map(v => (
                <g key={v}>
                    <line x1={v} y1={-100} x2={v} y2={100} stroke="hsl(var(--app-text) / 0.025)" strokeWidth={0.5} />
                    <line x1={-100} y1={v} x2={100} y2={v} stroke="hsl(var(--app-text) / 0.025)" strokeWidth={0.5} />
                </g>
            ))}
            <circle r={100} fill="none" stroke="hsl(var(--app-text) / 0.06)" strokeWidth={0.8} />
            {[30,60,90,120,150,180,210,240,270,300,330,0].map(d => {
                const rad=(d-90)*Math.PI/180
                return <line key={d} x1={96*Math.cos(rad)} y1={96*Math.sin(rad)} x2={100*Math.cos(rad)} y2={100*Math.sin(rad)} stroke="hsl(var(--app-text) / 0.12)" strokeWidth={d%90===0?1.5:0.5} />
            })}
            {labels.map(([l,d,col]) => {
                const rad=(d-90)*Math.PI/180
                return <text key={l} x={82*Math.cos(rad)} y={82*Math.sin(rad)+3} textAnchor="middle" fontSize={px(13)} fontFamily="inherit" fontWeight="700" fill={col}>{l}</text>
            })}
            {/* Safe zone */}
            <circle r={48} fill="color-mix(in srgb, var(--app-ok) 3%, transparent)" stroke="color-mix(in srgb, var(--app-ok) 45%, transparent)" strokeWidth={1} strokeDasharray="2 5" />
            {/* Max distance fence */}
            {maxDistEnabled ? (
                <>
                    <circle r={78} fill="color-mix(in srgb, var(--app-danger) 4%, transparent)" stroke="var(--app-danger)" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.7} />
                    <text x={80} y={-3} fontSize={px(12)} fontFamily="inherit" fill="var(--app-danger)">{maxDist} m</text>
                </>
            ) : (
                <circle r={78} fill="none" stroke="hsl(var(--app-text-subtle) / 0.2)" strokeWidth={1} strokeDasharray="4 4" />
            )}
            {/* RTH circle (indicates RTH altitude conceptually) */}
            <circle r={28} fill="none" stroke="color-mix(in srgb, var(--app-accent) 45%, transparent)" strokeWidth={0.8} strokeDasharray="2 5" />
            {/* Home */}
            <circle r={5} fill="var(--app-accent)" opacity={0.9} />
            <line x1={0} y1={0} x2={0} y2={-10} stroke="var(--app-accent)" strokeWidth={1.5} opacity={0.7} />
            <text x={7} y={-8} fontSize={px(12)} fontFamily="inherit" fill="var(--app-accent)">H</text>
            <text x={0} y={-31} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="var(--app-accent)">Return {rthAlt} m</text>
        </svg>
    )
}

function AltitudeProfile({ takeoffAlt, rthAlt, maxAlt, maxAltEnabled }: { takeoffAlt: number; rthAlt: number; maxAlt: number; maxAltEnabled: boolean }) {
    const H = 90, W = 260
    const ceiling = maxAltEnabled ? Math.max(maxAlt, rthAlt * 1.2) : Math.max(rthAlt * 1.4, 60)
    const py = (alt: number) => H - (alt / ceiling) * H * 0.88
    const ty = py(takeoffAlt), ry = py(rthAlt), my = maxAltEnabled ? py(maxAlt) : 0
    const [ref, px] = useSvgPx(W)
    return (
        <svg ref={ref} viewBox={`0 0 ${W} ${H+22}`} style={{ width: '100%', maxWidth: 480, display: 'block' }} role="img" aria-label="Side view of takeoff and return altitudes">
            {/* Sky gradient */}
            <defs>
                <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="color-mix(in srgb, var(--app-accent) 6%, transparent)" />
                    <stop offset="100%" stopColor="color-mix(in srgb, var(--app-accent) 0%, transparent)" />
                </linearGradient>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="url(#sky)" />
            {/* Ceiling */}
            {maxAltEnabled && <>
                <rect x={0} y={0} width={W} height={my} fill="color-mix(in srgb, var(--app-danger) 4%, transparent)" />
                <line x1={0} y1={my} x2={W} y2={my} stroke="var(--app-danger)" strokeWidth={1.5} strokeDasharray="6 3" />
                <text x={W-4} y={my-4} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="var(--app-danger)">{maxAlt} m ceiling</text>
            </>}
            {/* RTH altitude */}
            <line x1={0} y1={ry} x2={W} y2={ry} stroke="var(--app-accent)" strokeWidth={1} strokeDasharray="6 4" opacity={0.45} />
            <text x={W-4} y={ry-4} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="var(--app-accent)">Return {rthAlt} m</text>
            {/* Takeoff */}
            <line x1={44} y1={H} x2={44} y2={ty} stroke="var(--app-ok)" strokeWidth={2.5} opacity={0.7} />
            <polygon points={`${44},${ty-9} ${40},${ty} ${48},${ty}`} fill="var(--app-ok)" opacity={0.8} />
            <circle cx={44} cy={ty} r={3.5} fill="var(--app-ok)" />
            <text x={50} y={ty+4} fontSize={px(12)} fontFamily="inherit" fill="var(--app-ok)">{takeoffAlt} m</text>
            {/* RTH flight path */}
            <path d={`M 110,${ty} L 110,${ry} L 200,${ry}`} fill="none" stroke="var(--app-accent)" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.35} />
            <text x={204} y={ry + px(12) + 3} fontSize={px(12)} fontFamily="inherit" fill="var(--app-accent)">Home</text>
            {/* Ground */}
            <rect x={0} y={H} width={W} height={22} fill="color-mix(in srgb, var(--app-ok) 6%, transparent)" />
            <line x1={0} y1={H} x2={W} y2={H} stroke="color-mix(in srgb, var(--app-ok) 40%, transparent)" strokeWidth={1.5} />
            <text x={44} y={H+15} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">Home</text>
            <text x={W-4} y={H+15} textAnchor="end" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">0 m AGL</text>
        </svg>
    )
}

// ── Primitives ────────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)]'

function Tip({ text }: { text: string }) {
    return (
        <Tooltip>
            <TooltipTrigger aria-label="More info" className={'rounded-full bg-transparent text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors ' + FOCUS_RING} style={{ border: 'none', padding: 5, margin: -3, cursor: 'help', display: 'flex' }}><Info size={14} /></TooltipTrigger>
            <TooltipContent style={{ maxWidth: 240, fontSize: 13, lineHeight: 1.45 }}>{text}</TooltipContent>
        </Tooltip>
    )
}
function Label({ text, tip }: { text: string; tip?: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>{text}</span>
            {tip && <Tip text={tip} />}
        </div>
    )
}
function Field({ label, tip, children, span2 }: { label: string; tip?: string; children: React.ReactNode; span2?: boolean }) {
    return <div style={span2 ? { gridColumn: 'span 2' } : {}}><Label text={label} tip={tip} />{children}</div>
}
const INPUT_STYLE = (disabled?: boolean): React.CSSProperties => ({
    width: '100%', height: 36, padding: '0 11px', borderRadius: 6, boxSizing: 'border-box', outline: 'none',
    background: disabled ? 'hsl(var(--app-surface-2))' : 'hsl(var(--app-surface))',
    border: `1px solid hsl(var(${disabled ? '--app-border' : '--app-border-strong'}))`,
    color: disabled ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))',
    fontSize: 14, fontVariantNumeric: 'tabular-nums', cursor: disabled ? 'not-allowed' : undefined,
})
function AppInput({ value, onChange, placeholder, disabled }: { value: string; onChange?: (v: string) => void; placeholder?: string; disabled?: boolean }) {
    return <input value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder} disabled={disabled} className={FOCUS_RING} style={INPUT_STYLE(disabled)} />
}
function AppSelect<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
    return <OptionSelect value={value} onChange={onChange} disabled={disabled} options={options} />
}
function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
    return (
        <button type="button" role="switch" aria-checked={value} disabled={disabled} onClick={disabled ? undefined : onChange}
            className={FOCUS_RING}
            style={{ width: 40, height: 24, borderRadius: 999, cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0, padding: 0,
                background: value ? 'var(--app-accent)' : 'hsl(var(--app-border-strong))', border: disabled ? '1px solid hsl(var(--app-border))' : 'none',
                position: 'relative', transition: 'background-color var(--dur) var(--ease-out)' }}>
            <span style={{ position: 'absolute', top: 4, left: 4, width: 16, height: 16, borderRadius: '50%', background: '#fff',
                transform: `translateX(${value ? 16 : 0}px)`, transition: 'transform var(--dur) var(--ease-out)' }} />
        </button>
    )
}
function LockedNote({ text }: { text: string }) {
    return <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 6, background: 'var(--app-warn-soft)', border: '1px solid color-mix(in srgb, var(--app-warn) 30%, transparent)' }}><Lock size={14} style={{ color: 'var(--app-warn)', flexShrink: 0, marginTop: 2 }} /><span style={{ fontSize: 13, color: 'hsl(var(--app-text))', lineHeight: 1.45 }}>{text}</span></div>
}

// ── Layout shells ─────────────────────────────────────────────────────────────

const PANEL_TITLE: React.CSSProperties = { padding: '14px 16px 0', fontSize: 14, fontWeight: 700, margin: 0 }

// An instrument panel or a form group: one quiet surface, a sentence-case
// title, no shadow (cards are for real groups, not decoration).
function Panel({ title, children }: { title?: string; children: React.ReactNode; accent?: string }) {
    return (
        <section style={{ borderRadius: 10, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', minWidth: 0 }}>
            {title && <h3 style={{ ...PANEL_TITLE, color: 'hsl(var(--app-text))' }}>{title}</h3>}
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
        </section>
    )
}
function Card({ title, children }: { title?: string; children: React.ReactNode }) {
    return (
        <section style={{ borderRadius: 10, border: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', minWidth: 0 }}>
            {title && <h3 style={{ ...PANEL_TITLE, color: 'hsl(var(--app-text))' }}>{title}</h3>}
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>
        </section>
    )
}
function G2({ children, gap = 16 }: { children: React.ReactNode; gap?: number }) {
    return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap, alignItems: 'start' }}>{children}</div>
}

// ── Readiness checklist ─────────────────────────────────────────────────────

type RowState = 'ok' | 'warn' | 'idle' | 'none'

/** One line of the overview: a state mark, the section, what it is set to,
 *  and at most one action. The whole row opens the section. */
function ReadinessRow({ label, icon: Icon, state, value, action, onClick }: {
    label: string; icon: React.ElementType; state: RowState; value: string
    action?: string; onClick: () => void
}) {
    const mark = state === 'ok' ? <Check size={16} strokeWidth={2.75} style={{ color: 'var(--app-ok)' }} aria-label="Set" />
        : state === 'warn' ? <AlertTriangle size={16} style={{ color: 'var(--app-warn)' }} aria-label="Needs attention" />
        : state === 'idle' ? <span aria-label="Not checked" style={{ width: 10, height: 2, borderRadius: 1, background: 'hsl(var(--app-text-subtle))' }} />
        : <span aria-hidden style={{ width: 10 }} />
    return (
        <li style={{ listStyle: 'none' }}>
            <button type="button" onClick={onClick}
                className={'group w-full text-left bg-transparent hover:bg-app-surface-2 active:bg-app-surface-2 transition-colors ' + FOCUS_RING}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', minHeight: 52, border: 'none', cursor: 'pointer' }}>
                <span style={{ width: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{mark}</span>
                <Icon size={16} aria-hidden style={{ color: 'hsl(var(--app-text-muted))', flexShrink: 0 }} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="sm:w-[150px] sm:shrink-0" style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>{label}</span>
                    <span className="sm:truncate" style={{ minWidth: 0, fontSize: 14, color: state === 'idle' ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                </span>
                <span className="text-app-text-muted group-hover:text-app-text transition-colors" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {action && <span className="max-sm:hidden">{action}</span>}
                    <ChevronRight size={16} aria-hidden />
                </span>
            </button>
        </li>
    )
}

// ── Vehicle Banner ────────────────────────────────────────────────────────────

function VehicleBanner({ vehicle, readiness, telStatus, address }: { vehicle: VehicleProfile; readiness: number | null; telStatus: string; address: string }) {
    const connected = telStatus === 'connected'
    const chip: React.CSSProperties = { fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--app-text-muted))', background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))' }
    return (
        <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px clamp(16px, 3vw, 24px)', borderBottom: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', flexShrink: 0, flexWrap: 'wrap' }}>
            <DroneSVG airframe={vehicle.airframe} size={40} />
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0, lineHeight: 1.25 }}>{vehicle.name}</h1>
                    <span style={chip}>{AIRFRAME_LABELS[vehicle.airframe] ?? vehicle.airframe}</span>
                    <span style={chip}>{vehicle.firmware === 'ardupilot' ? 'ArduPilot' : vehicle.firmware.toUpperCase()}</span>
                    {vehicle.frameId && <span style={chip}>Frame #{vehicle.frameId}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 }}>
                    {connected ? <Wifi size={14} style={{ color: 'var(--app-ok)', flexShrink: 0 }} /> : <WifiOff size={14} style={{ color: 'hsl(var(--app-text-muted))', flexShrink: 0 }} />}
                    <span style={{ fontSize: 13, fontWeight: 600, color: connected ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))' }}>{connected ? 'Connected' : 'Not connected'}</span>
                    {connected && <span className="font-code" style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</span>}
                </div>
            </div>
            {readiness != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}
                    title="Sensor health measured on the connected drone (GPS, gyro and accel, compass, baro)">
                    <ReadinessRing pct={readiness} color={hColor(readiness)} size={44} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>Ready</span>
                </div>
            )}
        </header>
    )
}

// ── Section navigation ──────────────────────────────────────────────────────

type NavId = SectionId | 'overview'

/** Setup sections, always visible on the left (a select at phone width). */
function SectionNav({ current, onSelect, items }: {
    current: NavId; onSelect: (id: NavId) => void
    items: { id: NavId; label: string; icon: React.ElementType }[]
}) {
    return (
        <nav role="tablist" aria-label="Setup sections" aria-orientation="vertical"
            className="max-md:hidden flex flex-col"
            style={{ width: 216, flexShrink: 0, gap: 2, padding: '16px 10px', borderRight: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', overflowY: 'auto' }}>
            {items.map((t, i) => {
                const active = t.id === current, Icon = t.icon
                return (
                    <React.Fragment key={t.id}>
                        {i === 1 && <div aria-hidden style={{ height: 1, background: 'hsl(var(--app-border))', margin: '6px 8px' }} />}
                        <button role="tab" aria-selected={active} onClick={() => onSelect(t.id)}
                            className={(active ? 'bg-app-accent-soft text-app-selected-ink' : 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2') + ' transition-colors ' + FOCUS_RING}
                            style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', minHeight: 38, borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 700 : 600, textAlign: 'left', whiteSpace: 'nowrap' }}>
                            <span aria-hidden style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, background: 'var(--app-accent)', opacity: active ? 1 : 0, transition: 'opacity var(--dur) var(--ease-out)' }} />
                            <Icon size={16} style={{ color: active ? 'var(--app-accent)' : undefined, flexShrink: 0 }} />{t.label}
                        </button>
                    </React.Fragment>
                )
            })}
        </nav>
    )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHead({ meta, pct }: { meta: { label: string; desc: string }; pct: number | null }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0, lineHeight: 1.3 }}>{meta.label}</h2>
                <p style={{ fontSize: 14, color: 'hsl(var(--app-text-muted))', margin: '4px 0 0' }}>{meta.desc}</p>
            </div>
            {pct != null && <ReadinessRing pct={pct} color={hColor(pct)} size={48} />}
        </div>
    )
}

// ── LINK THROUGHPUT ───────────────────────────────────────────────────────────
//
// WHAT A LINK CAN CARRY IS NOT KNOWABLE FROM HERE, SO IT IS MEASURED.
//
// A 3DR/SiK radio's ceiling is set by AIR_SPEED and ECC - parameters on the
// RADIO, not on the autopilot, and invisible to this application. The serial
// baud printed on the box (57600) is the wire between the computer and the
// radio and says nothing about the air link, which is half-duplex and shared
// with the uplink.
//
// So the request rate is only ever a request. What matters is whether the
// arrivals follow it: ask for more, and if the measured figure stops rising,
// that is the ceiling. This panel is that experiment.

function rateTone(measured: number, asked: number): string {
    if (!asked) return 'hsl(var(--app-text-muted))'
    const ratio = measured / asked
    if (ratio >= 0.85) return 'var(--app-ok)'      // the link is keeping up
    if (ratio >= 0.55) return 'var(--app-warn)'      // partially - near the ceiling
    return 'var(--app-danger)'                          // asking for far more than arrives
}

function LinkThroughput() {
    const measured = useDroneStore(s => s.telemetry?.measured_rates)
    if (!measured || Object.keys(measured).length === 0) return null

    // The rates this build requests. Kept beside the measurement rather than
    // shown alone, because a bare "3.2 Hz" cannot tell you whether the link is
    // saturated or simply was not asked for more.
    const asked: Record<string, number> = { position: 8, attitude: 10 }

    return (
        <Panel title="Link throughput" accent="light-dark(#6d28d9, #a78bfa)">
            {Object.entries(measured).map(([k, v]) => {
                const want = asked[k] ?? 0
                return (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{k}</span>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: rateTone(v as number, want) }}>
                            {(v as number).toFixed(1)} Hz
                            {want > 0 && <span style={{ color: 'hsl(var(--app-text-muted))' }}> / {want} asked</span>}
                        </span>
                    </div>
                )
            })}
            <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: '4px 0 0' }}>
                Green means the link is delivering what was asked. If it stays
                amber or red, the radio is at its ceiling - raise AIR_SPEED or
                turn ECC off on the radio, not here.
            </p>
        </Panel>
    )
}

// ── CONNECTION ────────────────────────────────────────────────────────────────

function ConnectionWorkspace({ address, setAddress }: { address: string; setAddress: (v: string) => void }) {
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const telemetry = useDroneStore(s => s.telemetry)
    const [showPresets, setShowPresets] = useState(false)
    const [downlinkPort, setDownlinkPort] = useState(() => getRfDownlinkPort())
    const [uplinkPort, setUplinkPort] = useState(() => getRfUplinkPort())
    const [uplinkHost, setUplinkHost] = useState(() => getRfUplinkHost())
    // A typed MAVLink address or the RF bridge makes the SERVER bind a port:
    // staff-only (docs/ACCESS_MODEL.md section 8a). Customers connect from
    // the Fly tab through a relay on their own device.
    const { customer } = useLiveScope()
    const [uiMode] = useUiMode()
    const connected = telStatus === 'connected'
    const connect    = useCallback(() => {
        lsSet('hyrak-mav-address', address)
        if (address === RF_BRIDGE_ADDR) {
            getSocket().emit('connect_rf_bridge', { downlinkPort, uplinkPort, uplinkHost })
        } else {
            getSocket().emit('connect_telemetry', { address })
        }
    }, [address, downlinkPort, uplinkPort, uplinkHost])
    const disconnect = useCallback(() => getSocket().emit('disconnect_telemetry'), [])
    const pos = telemetry?.position, bat = telemetry?.battery, fm = telemetry?.flight_mode, att = telemetry?.attitude

    const mavMsgs = connected ? [
        pos && 'GLOBAL_POSITION_INT', att && 'ATTITUDE', bat && 'BATTERY_STATUS',
        fm && 'HEARTBEAT', telemetry?.heading_deg != null && 'VFR_HUD', 'SYS_STATUS',
    ].filter(Boolean) as string[] : []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <G2>
                {/* Left: link setup */}
                <Card title="Link setup">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, background: connected ? 'color-mix(in srgb, var(--app-ok) 10%, transparent)' : 'hsl(var(--app-text-subtle) / 0.08)', border: `1px solid ${connected ? 'color-mix(in srgb, var(--app-ok) 30%, transparent)' : 'hsl(var(--app-text-subtle) / 0.2)'}`, color: connected ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))' }}>
                            {connected ? <Check size={11} /> : <WifiOff size={11} />}
                            {connected ? 'Connected' : 'No link'}
                        </div>
                    </div>
                    {customer && !connected && (
                        <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: 0 }}>
                            Connect your drone from the Fly tab: a radio plugged into this device, or SITL
                            through the HYRAK desktop app.
                        </p>
                    )}
                    {!connected && !customer && (
                        <Field label="MAVLink address" tip="Connection string for your autopilot.">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <AppInput value={address} onChange={setAddress} placeholder="udpin://0.0.0.0:14540" />
                                    <button onClick={() => setShowPresets(s => !s)} className={'hover:bg-app-surface-2 ' + FOCUS_RING} style={{ padding: '0 12px', height: 36, borderRadius: 6, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border-strong))', color: 'hsl(var(--app-text))', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>Presets</button>
                                </div>
                                {showPresets && (
                                    <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid hsl(var(--app-border))' }}>
                                        {MAV_PRESETS.map(p => (
                                            <button key={p.addr} onClick={() => { setAddress(p.addr); setShowPresets(false) }} style={{ width: '100%', display: 'flex', flexDirection: 'column', padding: '9px 12px', background: 'hsl(var(--app-surface))', border: 'none', borderBottom: '1px solid hsl(var(--app-border))', cursor: 'pointer', textAlign: 'left' }}
                                                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'hsl(var(--app-surface-2))' }}
                                                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'hsl(var(--app-surface))' }}>
                                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text))' }}>{p.label}</span>
                                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', marginTop: 2 }}>{p.addr}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </Field>
                    )}
                    {/* Shown while CONNECTED too, read-only. The uplink host
                        is the one setting whose wrong value is invisible in
                        operation - telemetry looks perfect and commands vanish
                        - so "what is it actually using?" has to be answerable
                        without disconnecting first. */}
                    {address === RF_BRIDGE_ADDR && !customer && (
                        <Field label="RF bridge ports" tip="UDP ports the ground station's wfb_rx/wfb_tx use - see communication/start-gs.sh. The uplink HOST matters once the decoder is not on this machine: downlink arrives from anywhere (we bind 0.0.0.0), but the uplink is sent to a fixed listener, so leaving it on 127.0.0.1 with an off-box decoder gives perfect telemetry and no commands.">
                            <div style={{ display: 'flex', gap: 6 }}>
                                <div style={{ flex: 1 }}>
                                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>Downlink (video/mavlink dn)</span>
                                    <input
                                        type="number" min={1} max={65535}
                                        value={downlinkPort}
                                        disabled={connected}
                                        onChange={e => { const v = Number(e.target.value); setDownlinkPort(v); if (v > 0 && v < 65536) setRfDownlinkPort(v) }}
                                        className={FOCUS_RING} style={{ ...INPUT_STYLE(connected), marginTop: 4 }}
                                    />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>Uplink (mavlink up)</span>
                                    <input
                                        type="number" min={1} max={65535}
                                        value={uplinkPort}
                                        disabled={connected}
                                        onChange={e => { const v = Number(e.target.value); setUplinkPort(v); if (v > 0 && v < 65536) setRfUplinkPort(v) }}
                                        className={FOCUS_RING} style={{ ...INPUT_STYLE(connected), marginTop: 4 }}
                                    />
                                </div>
                            </div>
                            {/* Uplink HOST. Separate row because it is the one
                                field here that is not symmetric with the
                                downlink: we bind 0.0.0.0 to receive, so
                                downlink needs no host at all, while the uplink
                                is sent to a specific listener. Loopback is only
                                right while the decoder runs on this machine. */}
                            <div style={{ marginTop: 6 }}>
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>
                                    Uplink host (where wfb_tx / the decoder runs)
                                </span>
                                <input
                                    type="text"
                                    value={uplinkHost}
                                    placeholder="127.0.0.1"
                                    disabled={connected}
                                    onChange={e => { const v = e.target.value; setUplinkHost(v); setRfUplinkHost(v) }}
                                    className={FOCUS_RING} style={{ ...INPUT_STYLE(connected), marginTop: 4 }}
                                />
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', display: 'block', marginTop: 4, lineHeight: 1.5 }}>
                                    Commands go to <b>{uplinkHost}:{uplinkPort}</b>.
                                    Use 127.0.0.1 only if the RF decoder runs on
                                    this machine - with the decoder on its own
                                    board, telemetry still reads correctly while
                                    every command is dropped into local loopback.
                                </span>
                            </div>
                        </Field>
                    )}
                    {/* Customers only release a link here; it is made on the Fly tab. */}
                    {customer ? (connected && (
                        <button onClick={() => { void disconnectTelemetryLink() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 6, cursor: 'pointer', fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 700, border: '1px solid', background: 'color-mix(in srgb, var(--app-danger) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--app-danger) 35%, transparent)', color: 'var(--app-danger)' }}>
                            <WifiOff size={14} /> Disconnect
                        </button>
                    )) : <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={connected ? disconnect : connect} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 6, cursor: 'pointer', fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 700, border: '1px solid', ...(connected ? { background: 'color-mix(in srgb, var(--app-danger) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--app-danger) 35%, transparent)', color: 'var(--app-danger)' } : { background: 'color-mix(in srgb, var(--app-ok) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--app-ok) 35%, transparent)', color: 'var(--app-ok)' }) }}>
                            {connected ? <WifiOff size={14} /> : <Wifi size={14} />}
                            {connected ? 'Disconnect' : 'Connect'}
                        </button>
                        {connected && <button onClick={() => { disconnect(); setTimeout(connect, 600) }} style={{ padding: '10px 12px', borderRadius: 6, cursor: 'pointer', background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}><RotateCcw size={14} /></button>}
                    </div>}
                </Card>

                {/* Right: live telemetry or MAVLink stream */}
                {connected ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Panel title="Live telemetry" accent="var(--app-ok)">
                            {[
                                { k: 'Flight mode', v: fm?.mode ?? '-', hi: !!fm?.is_armed },
                                { k: 'Armed',       v: fm?.is_armed ? 'Yes' : 'No' },
                                { k: 'Battery',     v: bat ? `${bat.remaining_percent?.toFixed(0)}%, ${bat.voltage_v?.toFixed(2)} V` : '-', hi: (bat?.remaining_percent ?? 100) < 20 },
                                { k: 'Altitude AGL',v: pos ? `${pos.relative_altitude_m?.toFixed(2)} m` : '-' },
                                { k: 'Lat / Lon',   v: pos ? `${pos.latitude_deg?.toFixed(5)}° / ${pos.longitude_deg?.toFixed(5)}°` : '-' },
                                { k: 'Roll / Pitch',v: att ? `${att.roll_deg?.toFixed(1)}° / ${att.pitch_deg?.toFixed(1)}°` : '-' },
                                { k: 'Heading',     v: telemetry?.heading_deg != null ? `${telemetry.heading_deg.toFixed(1)}°` : '-' },
                            ].map(r => (
                                <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{r.k}</span>
                                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: r.hi ? 'var(--app-danger)' : 'hsl(var(--app-text))' }}>{r.v}</span>
                                </div>
                            ))}
                        </Panel>
                        <Panel title="MAVLink stream" accent="var(--app-accent)">
                            {mavMsgs.map(m => (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--app-accent)', flexShrink: 0 }}>
                                        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
                                        <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--app-accent)', animation: 'pulse 2s infinite' }} />
                                    </div>
                                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-ok)' }}>{m}</span>
                                </div>
                            ))}
                        </Panel>
                        <LinkThroughput />
                    </div>
                ) : null}
            </G2>

            {/* Engineering detail: how the link is wired, and the address
                formats per autopilot. Dev mode only, folded by default. */}
            {uiMode === 'dev' && (
                <details className="group" style={{ borderRadius: 10, border: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))' }}>
                    <summary className={'flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-4 py-3 text-app-text hover:bg-app-surface-2 transition-colors ' + FOCUS_RING} style={{ fontSize: 14, fontWeight: 700 }}>
                        <ChevronRight size={16} aria-hidden className="text-app-text-muted transition-transform duration-200 group-open:rotate-90" />
                        Details
                        <span style={{ fontSize: 13, fontWeight: 400, color: 'hsl(var(--app-text-muted))' }}>Network topology and address formats</span>
                    </summary>
                    <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <NetworkTopology connected={connected} address={address} />

                        {[
                            { badge: 'PX4', color: 'light-dark(#1e40af, #60a5fa)', text: 'MAVSDK over UDP. Default SITL port: 14540. Physical radio: serial:///dev/ttyUSB0:57600' },
                            { badge: 'ArduPilot', color: 'var(--app-ok)', text: 'Compatible via MAVLink dialect. Default SITL port: 14550. Set TERRAIN_ENABLE=1 for terrain follow.' },
                            { badge: 'TCP', color: 'light-dark(#6b21a8, #c084fc)', text: 'For companion computer bridge: tcp://192.168.x.x:5760. Set GCS_TCP_PORT on the flight controller.' },
                        ].map(p => (
                            <div key={p.badge} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                                <span style={{ padding: '2px 6px', borderRadius: 6, fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, background: `${mix(p.color, 9)}`, color: p.color, flexShrink: 0, marginTop: 1 }}>{p.badge}</span>
                                <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', lineHeight: 1.6, margin: 0 }}>{p.text}</p>
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </div>
    )
}

// ── VEHICLE ───────────────────────────────────────────────────────────────────

function VehicleWorkspace({ v, onUpdate }: { v: VehicleProfile; onUpdate: (p: Partial<VehicleProfile>) => void }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <G2>
                <Card title="Identity">
                    <Field label="Vehicle name">
                        <AppInput value={v.name} onChange={name => onUpdate({ name })} placeholder="My Drone" />
                    </Field>
                    <Field label="Custom frame ID" tip="PX4: SYS_AUTOSTART (e.g. 4302). ArduPilot: FRAME_TYPE.">
                        <AppInput value={v.frameId} onChange={frameId => onUpdate({ frameId })} placeholder="e.g. 4302" />
                    </Field>
                </Card>
                <Card title="Hardware">
                    <Field label="Airframe type">
                        <AppSelect value={v.airframe} onChange={airframe => onUpdate({ airframe })} options={Object.entries(AIRFRAME_LABELS).map(([k, l]) => ({ value: k, label: l }))} />
                    </Field>
                    <Field label="Autopilot firmware">
                        <AppSelect value={v.firmware} onChange={firmware => onUpdate({ firmware })} options={[{ value: 'px4', label: 'PX4' }, { value: 'ardupilot', label: 'ArduPilot' }, { value: 'other', label: 'Other / Unknown' }]} />
                    </Field>
                </Card>
            </G2>
        </div>
    )
}

// ── SENSORS ───────────────────────────────────────────────────────────────────

// ── CALIBRATION ───────────────────────────────────────────────────────────────
//
// This used to be five disabled buttons under "Status: not calibrated" and a
// note saying a wizard needed parameter write access. The note was wrong about
// the mechanism - calibration is a COMMAND (MAV_CMD_PREFLIGHT_CALIBRATION),
// not a parameter write, and MAVSDK has had a plugin for it all along - and
// the hardcoded status was worse than no status: an aircraft that had been
// calibrated ten minutes earlier still read "not calibrated".
//
// It says nothing about calibration state at rest now, for the same reason.
// PX4 exposes no "is the accelerometer calibrated" flag a ground station can
// read; what it exposes is a PREFLIGHT FAILURE when one is missing, which is
// already in the message log and on the arming refusal. Inventing a green tick
// here would be inventing a fact.

// ── SENSORS ──────────────────────────────────────────────────────────────────
//
// TWO KINDS OF CARD, DELIBERATELY DIFFERENT SHAPES. The status cards say what
// each sensor is REPORTING right now; the calibration cards say what you can
// DO about it. The first version mixed the two in one column and the operator
// had to read each row to know whether it was a fact or a button.
//
// EVERY VERDICT COMES FROM THE AUTOPILOT. "Calibrated" is PX4's health flag
// (the same bits QGC shows), never inferred from the data - the old page
// declared the compass broken whenever the aircraft happened to face magnetic
// north, because heading !== 0 was the "check".

type SensorStatus = 'ok' | 'warn' | 'off'
const STATUS_COLOUR: Record<SensorStatus, string> = {
    ok: 'var(--app-ok)', warn: 'var(--app-warn)', off: 'hsl(var(--app-text-muted))',
}

const GPS_FIX_LABEL: Record<number, string> = {
    0: 'No fix', 1: 'No fix', 2: '2D fix', 3: '3D fix',
    4: 'DGPS', 5: 'RTK float', 6: 'RTK fixed',
}

function SectionHeader({ title, hint, right }: {
    title: string; hint?: string; right?: React.ReactNode
}) {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10, rowGap: 2, padding: '2px 2px 0' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0, whiteSpace: 'nowrap' }}>
                {title}
            </h3>
            {hint && (
                <span style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))' }}>{hint}</span>
            )}
            {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
        </div>
    )
}

function StatusChip({ status, text }: { status: SensorStatus; text: string }) {
    const c = STATUS_COLOUR[status]
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', borderRadius: 999, flexShrink: 0,
            background: `${mix(c, 8)}`, border: `1px solid ${mix(c, 23)}`,
            fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: c,
            whiteSpace: 'nowrap',
        }}>
            {status === 'ok' ? <Check size={12} strokeWidth={3} aria-hidden /> : status === 'warn' ? <AlertTriangle size={12} aria-hidden /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />}
            {text}
        </span>
    )
}

/** One live reading. The border carries the state so the grid can be read
 *  as four coloured edges before any text is. */
function SensorCard({ icon, title, status, statusText, value, sub }: {
    icon: React.ReactNode; title: string
    status: SensorStatus; statusText: string
    value: string; sub?: string
}) {
    const c = STATUS_COLOUR[status]
    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
            padding: '11px 12px', borderRadius: 10,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${status === 'off' ? 'hsl(var(--app-border))' : `${mix(c, 26)}`}`,
            boxShadow: status === 'warn' ? `inset 3px 0 0 ${c}` : status === 'ok' ? `inset 3px 0 0 ${mix(c, 33)}` : undefined,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                    width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `${mix(c, 8)}`, color: c,
                }}>
                    {icon}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', flex: 1, minWidth: 0 }}>
                    {title}
                </span>
                <StatusChip status={status} text={statusText} />
            </div>
            <div>
                <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: status === 'off' ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {value}
                </p>
                {sub && (
                    <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {sub}
                    </p>
                )}
            </div>
        </div>
    )
}

/** Which PX4 health flag answers "is this one calibrated". Level and gimbal
 *  have no flag - PX4 does not report a verdict for them, and inventing one
 *  is exactly the kind of guess this page no longer makes. */
const CAL_HEALTH_FLAG: Record<string, 'gyro_cal_ok' | 'accel_cal_ok' | 'mag_cal_ok'> = {
    gyro: 'gyro_cal_ok', accel: 'accel_cal_ok', mag: 'mag_cal_ok',
}

const CAL_ICON: Record<string, React.ElementType> = {
    gyro: RotateCw, accel: Move3d, mag: CompassIcon,
    level: AlignCenterHorizontal, gimbal: Camera,
}

/** One calibration on offer. The whole row is compact - the what-and-why
 *  text lives behind the info dot, because five always-open paragraphs made
 *  the list taller than the screen and nobody re-reads them per flight. The
 *  border is the state: amber while running or owed, green once the
 *  autopilot (or this session's completed run) says the offsets are good,
 *  neutral where PX4 keeps no verdict. */
function CalCard({ sensor, verdict, connected, busy, isActive, phase, progress, onStart }: {
    sensor: (typeof CAL_SENSORS)[number]
    verdict: boolean | null
    connected: boolean
    busy: boolean
    isActive: boolean
    phase: string
    progress: number
    onStart: () => void
}) {
    const Icon = CAL_ICON[sensor.key] ?? Gauge
    const running = isActive && (phase === 'running' || phase === 'starting')
    const border = running ? 'var(--app-warn)'
        : verdict === false ? 'var(--app-warn)'
        : verdict === true ? 'var(--app-ok)'
        : null
    const chip = running ? <StatusChip status="warn" text={`Running ${progress}%`} />
        : verdict === false ? <StatusChip status="warn" text="Needs calibration" />
        : verdict === true ? <StatusChip status="ok" text="Calibrated" />
        : null
    const clickable = connected && !busy
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 12px', borderRadius: 10,
            background: running ? 'color-mix(in srgb, var(--app-warn) 5%, transparent)' : 'hsl(var(--app-surface-2))',
            border: `1px solid ${border ? `${mix(border, 29)}` : 'hsl(var(--app-border))'}`,
            boxShadow: border ? `inset 3px 0 0 ${border}${verdict === true && !running ? '55' : ''}` : undefined,
            transition: 'border-color var(--dur-slow) var(--ease-out), background-color var(--dur-slow) var(--ease-out)',
        }}>
            <span style={{
                width: 28, height: 28, borderRadius: 6, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: border ? `${mix(border, 8)}` : 'hsl(var(--app-surface))',
                color: border ?? 'hsl(var(--app-text-muted))',
            }}>
                {running ? <Loader size={14} className="animate-spin" /> : <Icon size={14} />}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>
                    {sensor.label}
                </span>
                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>
                    {sensor.mins}
                </span>
                <Tip text={sensor.blurb} />
                {chip}
            </div>
            <button
                onClick={onStart}
                disabled={!clickable}
                title={connected ? `Start ${sensor.label} calibration` : 'Connect to the drone first'}
                style={{
                    padding: '5px 13px', borderRadius: 6, flexShrink: 0,
                    background: 'transparent',
                    border: `1px solid ${clickable ? 'color-mix(in srgb, var(--app-accent) 45%, transparent)' : clickable || running ? 'hsl(var(--app-border-strong))' : 'hsl(var(--app-border))'}`,
                    color: clickable ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                    cursor: clickable ? 'pointer' : 'not-allowed',
                    minHeight: 32,
                }}
            >
                {running ? 'Running'
                    : isActive && phase === 'done' ? 'Done'
                    : isActive && phase === 'failed' ? 'Retry'
                    : verdict === false ? 'Calibrate'
                    : 'Start'}
            </button>
        </div>
    )
}

// ── Mount orientation ────────────────────────────────────────────────────────
//
// QGC's "set orientations" step. Two parameters say how the autopilot board
// and the external compass are physically turned relative to the airframe;
// calibrating with either wrong produces offsets that pass and then fly
// wrong. Applied at BOOT, hence the reboot prompt on change.
//
// THREE AXES, THREE DROPDOWNS. PX4 stores one enum (MAV_SENSOR_ORIENTATION),
// but nobody mounts a board in enum values - they mount it rolled, pitched
// or yawed. So the operator picks Roll / Pitch / Yaw and the enum is looked
// up; a combination PX4 has no value for says so instead of writing garbage.

const MOUNT_PARAMS = [
    { key: 'SENS_BOARD_ROT', label: 'Autopilot board', tip: 'How the flight controller is physically rotated relative to the airframe. All zeros = its arrow points at the nose, component side up.' },
    { key: 'CAL_MAG0_ROT', label: 'External compass', tip: 'How the compass module is rotated relative to the airframe. AUTO lets PX4 detect it during compass calibration - the right choice unless detection has failed.' },
] as const

/** Every rotation MAV_SENSOR_ORIENTATION defines (except #38, a device-
 *  specific oddity), as the roll/pitch/yaw it is composed of. */
const ROT_TABLE: { r: number; p: number; y: number; v: number }[] = [
    { r: 0, p: 0, y: 0, v: 0 }, { r: 0, p: 0, y: 45, v: 1 }, { r: 0, p: 0, y: 90, v: 2 },
    { r: 0, p: 0, y: 135, v: 3 }, { r: 0, p: 0, y: 180, v: 4 }, { r: 0, p: 0, y: 225, v: 5 },
    { r: 0, p: 0, y: 270, v: 6 }, { r: 0, p: 0, y: 315, v: 7 },
    { r: 180, p: 0, y: 0, v: 8 }, { r: 180, p: 0, y: 45, v: 9 }, { r: 180, p: 0, y: 90, v: 10 },
    { r: 180, p: 0, y: 135, v: 11 }, { r: 0, p: 180, y: 0, v: 12 }, { r: 180, p: 0, y: 225, v: 13 },
    { r: 180, p: 0, y: 270, v: 14 }, { r: 180, p: 0, y: 315, v: 15 },
    { r: 90, p: 0, y: 0, v: 16 }, { r: 90, p: 0, y: 45, v: 17 }, { r: 90, p: 0, y: 90, v: 18 },
    { r: 90, p: 0, y: 135, v: 19 }, { r: 270, p: 0, y: 0, v: 20 }, { r: 270, p: 0, y: 45, v: 21 },
    { r: 270, p: 0, y: 90, v: 22 }, { r: 270, p: 0, y: 135, v: 23 },
    { r: 0, p: 90, y: 0, v: 24 }, { r: 0, p: 270, y: 0, v: 25 },
    { r: 0, p: 180, y: 90, v: 26 }, { r: 0, p: 180, y: 270, v: 27 },
    { r: 90, p: 90, y: 0, v: 28 }, { r: 180, p: 90, y: 0, v: 29 }, { r: 270, p: 90, y: 0, v: 30 },
    { r: 90, p: 180, y: 0, v: 31 }, { r: 270, p: 180, y: 0, v: 32 },
    { r: 90, p: 270, y: 0, v: 33 }, { r: 180, p: 270, y: 0, v: 34 }, { r: 270, p: 270, y: 0, v: 35 },
    { r: 90, p: 180, y: 90, v: 36 }, { r: 90, p: 0, y: 270, v: 37 },
    { r: 0, p: 315, y: 0, v: 39 }, { r: 90, p: 315, y: 0, v: 40 },
]

const ROLL_OPTS = [0, 90, 180, 270]
const PITCH_OPTS = [0, 90, 180, 270, 315]
const YAW_OPTS = [0, 45, 90, 135, 180, 225, 270, 315]

type Rpy = { r: number; p: number; y: number }

function rpyOf(v: number): Rpy | null {
    return ROT_TABLE.find(e => e.v === v) ?? null
}

function rotationLabel(v: number | null): string {
    if (v === null) return '…'
    if (v === -1) return 'Auto'
    const d = rpyOf(v)
    if (!d) return `#${v}`
    if (d.r === 0 && d.p === 0 && d.y === 0) return 'None (level, nose forward)'
    return [d.r ? `Roll ${d.r}°` : '', d.p ? `Pitch ${d.p}°` : '', d.y ? `Yaw ${d.y}°` : '']
        .filter(Boolean).join(', ')
}

function MountOrientation({ connected }: { connected: boolean }) {
    // null = not read yet. Values are the aircraft's ACTUAL settings,
    // fetched one param at a time - not the 30 s everything-download.
    const [values, setValues] = useState<Record<string, number | null>>({ SENS_BOARD_ROT: null, CAL_MAG0_ROT: null })
    // What the dropdowns show while a combination is being assembled. A
    // half-changed pick (roll set, yaw not yet) may be a combination PX4
    // has no value for - that must sit visibly un-saved, not be written.
    const [drafts, setDrafts] = useState<Record<string, Rpy | null>>({ SENS_BOARD_ROT: null, CAL_MAG0_ROT: null })
    const [rebootNeeded, setRebootNeeded] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Forget the aircraft's values on the edge where the link drops (during
    // render, so a reconnect never shows the previous aircraft's numbers).
    const [linked, setLinked] = useState(connected)
    if (connected !== linked) {
        setLinked(connected)
        if (!connected) {
            setValues({ SENS_BOARD_ROT: null, CAL_MAG0_ROT: null })
            setDrafts({ SENS_BOARD_ROT: null, CAL_MAG0_ROT: null })
            setRebootNeeded(false)
        }
    }

    useEffect(() => {
        if (!connected) return
        const socket = getSocket()
        const onGet = (r: { key: string; ok: boolean; value: number | null }) => {
            if (r.key !== 'SENS_BOARD_ROT' && r.key !== 'CAL_MAG0_ROT') return
            if (r.ok) setValues(v => ({ ...v, [r.key]: r.value }))
        }
        const onSet = (r: { key: string; ok: boolean; value: number; error?: string }) => {
            if (r.key !== 'SENS_BOARD_ROT' && r.key !== 'CAL_MAG0_ROT') return
            if (r.ok) {
                setValues(v => ({ ...v, [r.key]: r.value }))
                setDrafts(d => ({ ...d, [r.key]: null }))
                setRebootNeeded(true)
                setError(null)
            } else {
                setError(r.error || `The aircraft did not accept ${r.key}`)
            }
        }
        socket.on('param_get_ack', onGet)
        socket.on('param_set_ack', onSet)
        for (const p of MOUNT_PARAMS) socket.emit('get_param', { key: p.key, param_type: 'int' })
        return () => { socket.off('param_get_ack', onGet); socket.off('param_set_ack', onSet) }
    }, [connected])

    const pick = (key: string, shown: Rpy, axis: 'r' | 'p' | 'y', deg: number) => {
        const next = { ...shown, [axis]: deg }
        const entry = ROT_TABLE.find(e => e.r === next.r && e.p === next.p && e.y === next.y)
        if (entry) {
            setError(null)
            setDrafts(d => ({ ...d, [key]: next }))
            getSocket().emit('set_param', { key, value: entry.v, param_type: 'int' })
        } else {
            // Shown but not written: the operator can finish assembling a
            // valid combination, or read why this one cannot exist.
            setDrafts(d => ({ ...d, [key]: next }))
            setError(`PX4 defines no rotation for roll ${next.r}°, pitch ${next.p}°, yaw ${next.y}°. Adjust one axis.`)
        }
    }

    const axisSelect = (key: string, shown: Rpy, axis: 'r' | 'p' | 'y', label: string, opts: number[], enabled: boolean) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 76 }}>
            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', fontWeight: 600 }}>{label}</span>
            <OptionSelect size="sm" aria-label={label}
                value={shown[axis]}
                disabled={!enabled}
                onChange={d => pick(key, shown, axis, d)}
                options={opts.map(d => ({ value: d, label: `${d}°` }))}
            />
        </label>
    )

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            padding: '11px 12px', borderRadius: 10,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${rebootNeeded ? 'color-mix(in srgb, var(--app-warn) 40%, transparent)' : 'hsl(var(--app-border))'}`,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>Mount orientation</span>
                <Tip text="Set these BEFORE calibrating: offsets computed with a wrong mount rotation pass the calibration and then fly wrong. Applied at boot - changing either needs a reboot." />
            </div>
            {MOUNT_PARAMS.map(pm => {
                const v = values[pm.key]
                const known = v !== null
                const isAuto = v === -1
                const enabled = connected && known
                // Dropdowns show the draft while one is being assembled,
                // otherwise the decoded actual value.
                const shown: Rpy = drafts[pm.key] ?? (known && !isAuto ? rpyOf(v) : null) ?? { r: 0, p: 0, y: 0 }
                return (
                    <div key={pm.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>
                            {pm.label} <Tip text={pm.tip} />
                            <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: known ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))' }}>
                                {connected ? (known ? rotationLabel(v) : 'reading…') : '-'}
                            </span>
                        </span>
                        <div style={{ display: 'flex', gap: 7, alignItems: 'flex-end' }}>
                            {pm.key === 'CAL_MAG0_ROT' && (
                                <button
                                    onClick={() => {
                                        if (!enabled) return
                                        setError(null)
                                        setDrafts(d => ({ ...d, [pm.key]: null }))
                                        getSocket().emit('set_param', { key: pm.key, value: -1, param_type: 'int' })
                                    }}
                                    disabled={!enabled}
                                    title="Let PX4 detect the compass rotation during calibration"
                                    style={{
                                        padding: '6px 10px', borderRadius: 6, marginBottom: 0,
                                        background: isAuto ? 'color-mix(in srgb, var(--app-accent) 14%, transparent)' : 'transparent',
                                        border: `1px solid ${isAuto ? 'color-mix(in srgb, var(--app-accent) 60%, transparent)' : 'hsl(var(--app-border))'}`,
                                        color: isAuto ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
                                        fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                                        cursor: enabled ? 'pointer' : 'not-allowed',
                                    }}
                                >
                                    Auto
                                </button>
                            )}
                            {axisSelect(pm.key, shown, 'r', 'Roll', ROLL_OPTS, enabled)}
                            {axisSelect(pm.key, shown, 'p', 'Pitch', PITCH_OPTS, enabled)}
                            {axisSelect(pm.key, shown, 'y', 'Yaw', YAW_OPTS, enabled)}
                        </div>
                    </div>
                )
            })}
            {error && (
                <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-danger)', margin: 0, lineHeight: 1.5 }}>{error}</p>
            )}
            {rebootNeeded && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-warn)', margin: 0, flex: 1, lineHeight: 1.5 }}>
                        Saved - applied at boot. Reboot the FC, then recalibrate.
                    </p>
                    <button
                        onClick={() => { getSocket().emit('drone_action', { action: 'reboot' }); setRebootNeeded(false) }}
                        style={{
                            padding: '4px 12px', borderRadius: 6, background: 'transparent',
                            border: '1px solid color-mix(in srgb, var(--app-warn) 50%, transparent)', color: 'var(--app-warn)',
                            fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, cursor: 'pointer',
                        }}
                        title="Restarts the flight controller. Only works while disarmed - the link will drop and reconnect."
                    >
                        Reboot FC
                    </button>
                </div>
            )}
        </div>
    )
}

function SensorsWorkspace() {
    const { state: cal, refusal, busy, start, cancel, dismiss } = useCalibration()
    const telemetry = useDroneStore(s => s.telemetry)
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const connected = telStatus === 'connected'

    // COMPLETED THIS SESSION. PX4 keeps no health flag for level horizon or
    // the gimbal, so their cards had no way to ever turn green - a level
    // calibration finished successfully and the card sat there unchanged,
    // which reads as "it didn't work". The plugin's own success verdict is
    // just as authoritative as a health flag, so a run that finished OK
    // paints the card green for the rest of the session (and bridges the
    // second or two before a fresh health message confirms the others).
    // Both updates happen during render on the transition itself.
    const [doneSession, setDoneSession] = useState<Record<string, boolean>>({})
    if (cal.phase === 'done' && cal.sensor && !doneSession[cal.sensor]) {
        setDoneSession(d => ({ ...d, [cal.sensor]: true }))
    }
    const [calLinked, setCalLinked] = useState(connected)
    if (connected !== calLinked) {
        setCalLinked(connected)
        if (!connected) setDoneSession({})
    }

    // PX4's own health flags, or null until the first health message - the
    // difference between "the autopilot says not calibrated" and "nobody has
    // said anything yet", which must not paint the same colour.
    const health = connected && telemetry?.health?.received ? telemetry.health : null

    const fix = telemetry?.gps?.fix_type ?? 0
    const sats = telemetry?.gps?.satellites_visible ?? 0
    const att = telemetry?.attitude

    const gpsStatus: SensorStatus = !connected ? 'off' : fix >= 3 ? 'ok' : 'warn'
    // A run that just finished OK counts as calibrated even while the health
    // flag is still the pre-calibration one - the flag catches up within a
    // second, and the status card disagreeing with the freshly green
    // calibration card below it reads as a bug.
    const imuStatus: SensorStatus = !connected ? 'off'
        : health ? ((health.gyro_cal_ok || doneSession.gyro) && (health.accel_cal_ok || doneSession.accel) ? 'ok' : 'warn')
        : att ? 'ok' : 'warn'
    const magStatus: SensorStatus = !connected ? 'off'
        : health ? (health.mag_cal_ok || doneSession.mag ? 'ok' : 'warn')
        : 'ok'
    // PX4 keeps no baro verdict - it re-zeroes at boot. "Reporting" is the
    // honest claim, and the live altitude beside it is the actual check.
    const baroStatus: SensorStatus = connected ? 'ok' : 'off'

    const statuses = [gpsStatus, imuStatus, magStatus, baroStatus]
    const healthyCount = statuses.filter(v => v === 'ok').length

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SectionHeader
                    title="Sensor status"
                    hint="live from the autopilot"
                    right={
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: connected ? (healthyCount === 4 ? 'var(--app-ok)' : 'var(--app-warn)') : 'hsl(var(--app-text-muted))' }}>
                            {connected ? `${healthyCount} of 4 healthy` : 'Not connected'}
                        </span>
                    }
                />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 168px), 1fr))', gap: 8 }}>
                    <SensorCard
                        icon={<Satellite size={14} />} title="GPS"
                        status={gpsStatus}
                        statusText={!connected ? 'Off' : GPS_FIX_LABEL[fix] ?? `Fix ${fix}`}
                        value={connected ? `${sats} satellites` : '-'}
                        sub={connected && telemetry?.position && fix >= 2
                            ? `${telemetry.position.latitude_deg?.toFixed(5)}°, ${telemetry.position.longitude_deg?.toFixed(5)}°`
                            : 'Global position'}
                    />
                    <SensorCard
                        icon={<Activity size={14} />} title="IMU"
                        status={imuStatus}
                        statusText={!connected ? 'Off' : imuStatus === 'ok' ? 'OK' : health ? 'Needs calibration' : 'No data'}
                        value={connected && att
                            ? `R ${att.roll_deg?.toFixed(1)}°  P ${att.pitch_deg?.toFixed(1)}°`
                            : '-'}
                        sub="Accelerometer + gyroscope"
                    />
                    <SensorCard
                        icon={<CompassIcon size={14} />} title="Compass"
                        status={magStatus}
                        statusText={!connected ? 'Off' : magStatus === 'ok' ? 'OK' : 'Needs calibration'}
                        value={connected && telemetry?.heading_deg != null
                            ? `${telemetry.heading_deg.toFixed(0)}° heading`
                            : '-'}
                        sub="Magnetic heading"
                    />
                    <SensorCard
                        icon={<Mountain size={14} />} title="Barometer"
                        status={baroStatus}
                        statusText={connected ? 'Reporting' : 'Off'}
                        value={connected && telemetry?.position
                            ? `${(telemetry.position.relative_altitude_m ?? 0).toFixed(1)} m AGL`
                            : '-'}
                        sub="Pressure altitude, zeroed at boot"
                    />
                </div>

                <SectionHeader
                    title="Calibration"
                    hint={connected ? 'watch the model on the right' : 'connect to enable'}
                    right={<Tip text="No barometer or GPS calibration exists in PX4: the barometer is zeroed at every boot and the GNSS receiver calibrates itself - the live readout above IS the check. Airspeed applies to fixed-wing only." />}
                />
                <MountOrientation connected={connected} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {CAL_SENSORS.map(sensor => (
                        <CalCard
                            key={sensor.key}
                            sensor={sensor}
                            verdict={doneSession[sensor.key] ? true
                                : health && CAL_HEALTH_FLAG[sensor.key] ? health[CAL_HEALTH_FLAG[sensor.key]]
                                : null}
                            connected={connected}
                            busy={busy}
                            isActive={cal.sensor === sensor.key && cal.phase !== 'idle'}
                            phase={cal.phase}
                            progress={Math.max(0, Math.min(100, cal.progress ?? 0))}
                            onStart={() => start(sensor.key)}
                        />
                    ))}
                </div>
                {/* The refusal belongs where the button was pressed. The
                    autopilot answers "no, the vehicle is armed" in a sentence,
                    and dropping it would leave a button that looks broken. */}
                {refusal && (
                    <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-danger)', margin: 0, lineHeight: 1.6 }}>
                        {refusal}
                    </p>
                )}
            </div>

            {/* ONE VIEW, NOT TWO. Starting a calibration used to replace the
                page, so the options vanished the moment one was chosen. The
                aircraft sits here permanently - following live attitude even
                when nothing is running, which is a useful instrument in its
                own right - while the cards on the left carry the choices. */}
            <CalibrationStage
                state={cal}
                onCancel={cancel}
                onDismiss={dismiss}
                onRetry={() => start(cal.sensor)}
                onReboot={() => getSocket().emit('drone_action', { action: 'reboot' })}
            />
        </div>
    )
}

// ── RADIO ─────────────────────────────────────────────────────────────────────

// ── RADIO & RC ───────────────────────────────────────────────────────────────
//
// QGC's Radio setup, in our shape: everything the transmitter does to the
// aircraft is decided by PX4 parameters, and every control here reads and
// writes THOSE - nothing on this page is app-local preference dressed up as
// configuration (the previous version stored a mode list in localStorage
// that no aircraft ever saw).
//
// Live channel data comes from the backend's RC monitor, which listens to
// the raw MAVLink stream - MAVSDK itself does not expose channels. That
// feed exists on UDP links (SITL, the RF bridge); a USB-serial FC cannot
// share its port, and the page SAYS so instead of showing dead bars.

/** COM_FLTMODE1..6 values, PX4's commander mode slots. */
const FLTMODE_OPTS: { v: number; l: string }[] = [
    { v: -1, l: 'Unassigned' },
    { v: 0, l: 'Manual' }, { v: 8, l: 'Stabilized' }, { v: 6, l: 'Acro' },
    { v: 1, l: 'Altitude' }, { v: 2, l: 'Position' },
    { v: 3, l: 'Mission' }, { v: 4, l: 'Hold' }, { v: 5, l: 'Return' },
    { v: 7, l: 'Offboard' }, { v: 10, l: 'Takeoff' }, { v: 11, l: 'Land' },
    { v: 12, l: 'Follow Me' }, { v: 14, l: 'Orbit' },
]

const SWITCH_PARAMS = [
    { key: 'RC_MAP_ARM_SW', label: 'Arm switch', tip: 'Arms and disarms on a switch instead of the stick gesture. 0 = unassigned.' },
    { key: 'RC_MAP_KILL_SW', label: 'Kill switch', tip: 'Immediately stops the motors. Assign this one - it is the hardware answer to a flyaway.' },
    { key: 'RC_MAP_RETURN_SW', label: 'Return switch', tip: 'Triggers Return-to-Launch.' },
    { key: 'RC_MAP_OFFB_SW', label: 'Offboard switch', tip: 'Hands control to the companion app (this one) and takes it back.' },
    { key: 'RC_MAP_LOITER_SW', label: 'Hold switch', tip: 'Parks the aircraft where it is.' },
] as const

const AXIS_PARAMS = ['RC_MAP_ROLL', 'RC_MAP_PITCH', 'RC_MAP_THROTTLE', 'RC_MAP_YAW'] as const

const RC_PARAM_KEYS: string[] = [
    'RC_MAP_FLTMODE', ...SWITCH_PARAMS.map(p => p.key), ...AXIS_PARAMS,
]

/** Which physical stick carries which axis, per transmitter mode. x/y name
 *  the axis on that gimbal; throttle has no centring spring so its value
 *  maps bottom-to-top rather than around centre. */
const STICK_LAYOUT: Record<string, { left: { x: string; y: string }; right: { x: string; y: string } }> = {
    '1': { left: { x: 'yaw', y: 'pitch' }, right: { x: 'roll', y: 'throttle' } },
    '2': { left: { x: 'yaw', y: 'throttle' }, right: { x: 'roll', y: 'pitch' } },
    '3': { left: { x: 'roll', y: 'pitch' }, right: { x: 'yaw', y: 'throttle' } },
    '4': { left: { x: 'roll', y: 'throttle' }, right: { x: 'yaw', y: 'pitch' } },
}

const AXIS_SHORT: Record<string, string> = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw', throttle: 'Throttle' }

/** Which mode slots a physical switch can actually reach. PX4 splits the
 *  channel into six equal bands; a 3-position switch lands in bands 1, 4
 *  and 6, a 2-position in 1 and 6. Slots a switch cannot reach are shown
 *  dimmed instead of silently accepting a mode that will never engage. */
const SWITCH_REACH: Record<string, Record<number, string>> = {
    '2': { 1: 'Low', 6: 'High' },
    '3': { 1: 'Low', 4: 'Mid', 6: 'High' },
    '6': { 1: 'Pos 1', 2: 'Pos 2', 3: 'Pos 3', 4: 'Pos 4', 5: 'Pos 5', 6: 'Pos 6' },
}

/** Which slot a channel value selects: PX4's six-band split. */
function slotForValue(v: number): number {
    if (v <= 0) return 0
    const frac = Math.max(0, Math.min(1, (v - 1000) / 1000))
    return Math.min(Math.floor(frac * 6) + 1, 6)
}

type WizPhase = 'idle' | 'capturing' | 'review' | 'writing' | 'done'

function RadioWorkspace() {
    const telemetry = useDroneStore(s => s.telemetry)
    const telStatus = useDroneStore(s => s.telemetryStatus)
    const connected = telStatus === 'connected'
    const armed = telemetry?.flight_mode?.is_armed ?? false
    const rc = telemetry?.rc

    // ── PX4 parameters: the actual configuration ─────────────────────────
    const [params, setParams] = useState<Record<string, number | null>>({})
    const [paramErr, setParamErr] = useState<string | null>(null)
    // Forget the previous aircraft's values on the link-drop edge (render-time).
    const [paramsLinked, setParamsLinked] = useState(connected)
    if (connected !== paramsLinked) {
        setParamsLinked(connected)
        if (!connected) setParams({})
    }

    useEffect(() => {
        if (!connected) return
        const socket = getSocket()
        const keys = new Set([...RC_PARAM_KEYS, ...Array.from({ length: 6 }, (_, i) => `COM_FLTMODE${i + 1}`)])
        const onGet = (r: { key: string; ok: boolean; value: number | null }) => {
            if (keys.has(r.key) && r.ok) setParams(v => ({ ...v, [r.key]: r.value }))
        }
        const onSet = (r: { key: string; ok: boolean; value: number; error?: string }) => {
            if (!keys.has(r.key)) return
            if (r.ok) { setParams(v => ({ ...v, [r.key]: r.value })); setParamErr(null) }
            else setParamErr(r.error || `The aircraft did not accept ${r.key}`)
        }
        socket.on('param_get_ack', onGet)
        socket.on('param_set_ack', onSet)
        for (const k of keys) socket.emit('get_param', { key: k, param_type: 'int' })
        return () => { socket.off('param_get_ack', onGet); socket.off('param_set_ack', onSet) }
    }, [connected])

    const writeParam = (key: string, value: number) => {
        setParamErr(null)
        getSocket().emit('set_param', { key, value, param_type: 'int' })
    }

    // ── Live channels from the backend RC monitor ────────────────────────
    const [channels, setChannels] = useState<number[]>([])
    const [chanCount, setChanCount] = useState(0)
    const [monitor, setMonitor] = useState<{ listening: boolean; port: number } | null>(null)
    // Both as state, not a ref plus Date.now() in render: the live light is a
    // pure function of when the last frame came and what time it is now.
    const [lastFrameAt, setLastFrameAt] = useState(0)
    const [now, setNow] = useState(0)
    // The RC monitor binds one server port for the whole server, so it is a
    // staff tool (socket_classes: STAFF); a customer asking for it only got
    // a refusal toast.
    const { isStaff } = useAccess()

    useEffect(() => {
        if (!isStaff) return
        const socket = getSocket()
        const onChans = (p: { channels: number[]; count: number }) => {
            const t = Date.now()
            setLastFrameAt(t)
            setNow(t)
            setChannels(p.channels)
            setChanCount(p.count)
        }
        const onStatus = (st: { listening: boolean; port: number }) => setMonitor(st)
        socket.on('rc_channels', onChans)
        socket.on('rc_monitor_status', onStatus)
        socket.emit('start_rc_monitor')
        // The "live" light must go OUT when frames stop - poll the recency.
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => { socket.off('rc_channels', onChans); socket.off('rc_monitor_status', onStatus); clearInterval(t) }
    }, [isStaff])

    const live = lastFrameAt > 0 && now - lastFrameAt < 3000 && channels.length > 0

    // ── Stick calibration wizard ─────────────────────────────────────────
    const [wiz, setWiz] = useState<WizPhase>('idle')
    const [wizErr, setWizErr] = useState<string | null>(null)
    const ranges = useRef<{ min: number; max: number }[]>([])
    const [trims, setTrims] = useState<number[]>([])
    // The ranges as they stood when capture finished. The ref accumulates at
    // the RC frame rate; review renders from this snapshot instead.
    const [captured, setCaptured] = useState<{ min: number; max: number }[]>([])
    const [writeProgress, setWriteProgress] = useState('')

    useEffect(() => {
        if (wiz !== 'capturing' || !live) return
        const r = ranges.current
        channels.forEach((v, i) => {
            if (v <= 0) return
            if (!r[i]) r[i] = { min: v, max: v }
            else { r[i].min = Math.min(r[i].min, v); r[i].max = Math.max(r[i].max, v) }
        })
    }, [channels, wiz, live])

    const startCapture = () => {
        ranges.current = []
        setCaptured([])
        setTrims([])
        setWizErr(null)
        setWiz('capturing')
    }
    const finishCapture = () => {
        // The position everything is LEFT in becomes the trim - which is why
        // the instruction ends "…finish centred, throttle down".
        setTrims([...channels])
        setCaptured(ranges.current.map(r => r && { ...r }))
        setWiz('review')
    }
    const writeCalibration = async () => {
        setWiz('writing')
        const socket = getSocket()
        const rows = calRows()
        for (const row of rows) {
            setWriteProgress(`CH${row.ch}…`)
            socket.emit('set_param', { key: `RC${row.ch}_MIN`, value: row.min, param_type: 'float' })
            socket.emit('set_param', { key: `RC${row.ch}_TRIM`, value: row.trim, param_type: 'float' })
            socket.emit('set_param', { key: `RC${row.ch}_MAX`, value: row.max, param_type: 'float' })
            // Sequenced politely: three writes per channel is plenty for a
            // serial link to swallow at once.
            await new Promise(res => setTimeout(res, 350))
        }
        setWriteProgress('')
        setWiz('done')
    }
    const calRows = () => captured
        .map((r, i) => r ? {
            ch: i + 1, min: r.min, max: r.max,
            trim: Math.max(r.min, Math.min(r.max, trims[i] ?? Math.round((r.min + r.max) / 2))),
            moved: r.max - r.min >= 300,
        } : null)
        .filter((x): x is NonNullable<typeof x> => x !== null && x.moved)

    // ── Stick positions for the transmitter drawing ──────────────────────
    const [visualMode, setVisualMode] = useState<string>(() => ls('hyrak-rc-visual-mode', '2'))
    const [switchType, setSwitchType] = useState<string>(() => ls('hyrak-rc-switch-type', '3'))
    const layout = STICK_LAYOUT[visualMode] ?? STICK_LAYOUT['2']
    const axisChannel = (axis: string): number => {
        const key = axis === 'roll' ? 'RC_MAP_ROLL' : axis === 'pitch' ? 'RC_MAP_PITCH'
            : axis === 'yaw' ? 'RC_MAP_YAW' : 'RC_MAP_THROTTLE'
        return params[key] ?? 0
    }
    const axisValue = (axis: string): number => {
        const ch = axisChannel(axis)
        if (!live || ch < 1 || ch > channels.length) return axis === 'throttle' ? -1 : 0
        const raw = channels[ch - 1]
        if (raw <= 0) return 0
        return Math.max(-1, Math.min(1, (raw - 1500) / 400))
    }

    const modeChannel = params['RC_MAP_FLTMODE'] ?? null
    const liveModeValue = live && (modeChannel ?? 0) >= 1 ? channels[(modeChannel ?? 1) - 1] ?? 0 : 0
    const activeSlot = slotForValue(liveModeValue)
    const reach = SWITCH_REACH[switchType] ?? SWITCH_REACH['3']

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16, alignItems: 'start' }}>
            {/* LEFT - what the transmitter is WIRED to do */}
            <div className="rc-rise" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SectionHeader
                    title="RC link"
                    hint="as the autopilot sees it"
                    right={<StatusChip
                        status={!connected ? 'off' : rc?.available ? 'ok' : 'warn'}
                        text={!connected ? 'Off' : rc?.available ? `Receiver OK${rc.signal_pct > 0 ? `, ${rc.signal_pct.toFixed(0)}%` : ''}` : rc?.was_available ? 'Signal lost' : 'No receiver'}
                    />}
                />
                {/* The honest line about live channels. */}
                <div style={{
                    padding: '9px 12px', borderRadius: 10, fontSize: 12, fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1.6, color: 'hsl(var(--app-text-muted))',
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                }}>
                    {live
                        ? <>Live channel data is flowing - the transmitter drawing and the bars on the right are your real sticks.</>
                        : monitor?.listening
                            ? <>Listening for raw RC channels on udp/{monitor.port} - nothing arriving. A USB-serial FC cannot share its port; connect via UDP (SITL or the RF air unit) for live sticks and calibration. Mode and switch assignment below work on any link.</>
                            : <>The backend could not open the RC channel listener. Mode and switch assignment below still work.</>}
                </div>

                <SectionHeader
                    title="Flight modes"
                    hint="written to the aircraft, not stored in the app"
                />
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 8,
                    padding: '11px 12px', borderRadius: 10,
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', flex: 1 }}>Mode switch channel</span>
                        <Tip text="The transmitter channel your mode switch sends on (RC_MAP_FLTMODE)." />
                        <OptionSelect size="sm" aria-label="Mode switch channel" className={SEL_CLS}
                            value={modeChannel}
                            placeholder={connected ? 'Loading' : 'No link'}
                            disabled={!connected || modeChannel === null}
                            onChange={ch => writeParam('RC_MAP_FLTMODE', ch)}
                            options={[{ value: 0, label: 'Unassigned' }, ...Array.from({ length: 18 }, (_, i) => ({ value: i + 1, label: `CH${i + 1}` }))]}
                        />
                    </div>
                    {/* WHICH SLOTS YOUR SWITCH CAN REACH. PX4 has six slots
                        but a 3-position switch only ever lands in 1, 4 and 6;
                        assigning a mode to slot 2 on one is a setting that
                        can never engage. Pick the switch type and the
                        unreachable slots dim; with live data the slot your
                        switch is on RIGHT NOW is ringed. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', flex: 1 }}>Switch type</span>
                        {['2', '3', '6'].map(t => (
                            <button key={t} onClick={() => { setSwitchType(t); lsSet('hyrak-rc-switch-type', t) }} style={{
                                padding: '0 10px', minHeight: 32, borderRadius: 6,
                                background: switchType === t ? 'color-mix(in srgb, var(--app-accent) 14%, transparent)' : 'transparent',
                                border: `1px solid ${switchType === t ? 'var(--app-accent)' : 'hsl(var(--app-border-strong))'}`,
                                color: switchType === t ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
                                fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, cursor: 'pointer',
                                transition: 'border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
                            }}>{t}-pos</button>
                        ))}
                    </div>
                    {Array.from({ length: 6 }, (_, i) => {
                        const key = `COM_FLTMODE${i + 1}`
                        const v = params[key]
                        const posLabel = reach[i + 1]
                        const reachable = posLabel !== undefined
                        const isActive = live && activeSlot === i + 1
                        const enabled = connected && v !== null && v !== undefined && (modeChannel ?? 0) > 0 && reachable
                        return (
                            <div key={key} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                            }}>
                                {/* Unreachable slots read as quiet, not faded:
                                    muted ink on the panel still passes 4.5:1. */}
                                <span style={{
                                    width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                                    background: isActive ? 'var(--app-ok-soft)' : reachable ? 'hsl(var(--app-surface))' : 'transparent',
                                    color: isActive ? 'hsl(var(--app-text))' : reachable ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
                                    border: `1px ${reachable ? 'solid' : 'dashed'} ${isActive ? 'var(--app-ok)' : 'hsl(var(--app-border-strong))'}`,
                                    boxShadow: isActive ? '0 0 0 3px color-mix(in srgb, var(--app-ok) 15%, transparent)' : 'none',
                                    transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out), color var(--dur) var(--ease-out)',
                                }}>{i + 1}</span>
                                <span style={{ width: 42, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: isActive ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))', transition: 'color var(--dur) var(--ease-out)' }}>
                                    {reachable ? posLabel : ''}
                                </span>
                                <OptionSelect size="sm" aria-label={`Flight mode for slot ${i + 1}`} className={SEL_CLS + ' flex-1 w-auto'}
                                    value={v}
                                    placeholder={connected ? 'Loading' : 'No link'}
                                    disabled={!enabled}
                                    onChange={m => writeParam(key, m)}
                                    title={reachable ? undefined : `A ${switchType}-position switch never lands on this slot`}
                                    options={FLTMODE_OPTS.map(o => ({ value: o.v, label: o.l }))}
                                />
                            </div>
                        )
                    })}
                    {(modeChannel ?? 0) === 0 && modeChannel !== null && (
                        <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', margin: 0 }}>
                            Slots stay disabled until a mode switch channel is assigned.
                        </p>
                    )}
                </div>

                <SectionHeader title="Switches" hint="one channel each, 0 = unassigned" />
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 7,
                    padding: '11px 12px', borderRadius: 10,
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                }}>
                    {SWITCH_PARAMS.map(sw => {
                        const v = params[sw.key]
                        const enabled = connected && v !== null && v !== undefined
                        return (
                            <div key={sw.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 12, color: 'hsl(var(--app-text))', flex: 1 }}>{sw.label}</span>
                                <Tip text={sw.tip} />
                                <OptionSelect size="sm" aria-label={sw.label} className={SEL_CLS}
                                    value={v}
                                    placeholder={connected ? 'Loading' : 'No link'}
                                    disabled={!enabled}
                                    onChange={ch => writeParam(sw.key, ch)}
                                    options={[{ value: 0, label: 'Unassigned' }, ...Array.from({ length: 18 }, (_, i) => ({ value: i + 1, label: `CH${i + 1}` }))]}
                                />
                            </div>
                        )
                    })}
                </div>
                {paramErr && (
                    <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-danger)', margin: 0, lineHeight: 1.5 }}>{paramErr}</p>
                )}
            </div>

            {/* RIGHT - the transmitter, drawn */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="rc-rise" style={{
                    padding: 14, borderRadius: 10, animationDelay: '60ms',
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', flex: 1 }}>
                            Transmitter {live && <span className="rc-pulse" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-ok)', marginLeft: 6 }}>Live</span>}
                        </span>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>Stick layout</span>
                        {['1', '2', '3', '4'].map(m => (
                            <button key={m} onClick={() => { setVisualMode(m); lsSet('hyrak-rc-visual-mode', m) }} style={{
                                width: 32, height: 32, borderRadius: 6, padding: 0,
                                background: visualMode === m ? 'color-mix(in srgb, var(--app-accent) 14%, transparent)' : 'transparent',
                                border: `1px solid ${visualMode === m ? 'var(--app-accent)' : 'hsl(var(--app-border-strong))'}`,
                                color: visualMode === m ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))',
                                fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 700, cursor: 'pointer',
                            }}>{m}</button>
                        ))}
                    </div>
                    <TransmitterSvg
                        layout={layout}
                        axisValue={axisValue}
                        live={live}
                        modeChannel={modeChannel ?? 0}
                        modeValue={liveModeValue}
                        switchType={switchType}
                        flightMode={telemetry?.flight_mode?.mode ?? 'NO LINK'}
                    />
                    {/* Channel bars - only when the data is real. */}
                    {live && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))', gap: 6, marginTop: 10 }}>
                            {channels.slice(0, Math.max(chanCount, 8)).map((v, i) => {
                                const pct = v > 0 ? Math.max(0, Math.min(100, ((v - 1000) / 1000) * 100)) : 0
                                return (
                                    <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <div style={{ height: 5, borderRadius: 3, background: 'hsl(var(--app-surface))', overflow: 'hidden' }}>
                                            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--app-accent)', transition: 'width 80ms linear' }} />
                                        </div>
                                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>
                                            Ch {i + 1}: {v > 0 ? v : '-'}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>

                {/* Stick calibration */}
                <div className="rc-rise" style={{
                    display: 'flex', flexDirection: 'column', gap: 8,
                    padding: '12px 14px', borderRadius: 10, animationDelay: '120ms',
                    background: wiz === 'capturing' ? 'color-mix(in srgb, var(--app-warn) 5%, transparent)' : 'hsl(var(--app-surface-2))',
                    border: `1px solid ${wiz === 'capturing' ? 'color-mix(in srgb, var(--app-warn) 45%, transparent)' : 'color-mix(in srgb, var(--app-accent) 35%, transparent)'}`,
                    boxShadow: wiz === 'capturing' ? 'none' : 'inset 3px 0 0 color-mix(in srgb, var(--app-accent) 45%, transparent)',
                    transition: 'border-color var(--dur-slow) var(--ease-out)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                            width: 26, height: 26, borderRadius: 6,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'color-mix(in srgb, var(--app-accent) 12%, transparent)', color: 'var(--app-accent)',
                        }}>
                            <SlidersHorizontal size={14} />
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', flex: 1 }}>Stick calibration</span>
                        <Tip text="Teaches PX4 each channel's real endpoints and centre (RCn_MIN / TRIM / MAX). Channels that move less than 300µs during capture are left untouched, so an idle knob cannot be miscalibrated by accident." />
                    </div>
                    {wiz === 'idle' && (
                        <>
                            <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.6 }}>
                                {!live ? 'Needs live channel data. See the RC link note.'
                                    : armed ? 'Refused while armed.'
                                    : 'Records your sticks\' real endpoints while you move them, then writes the result to the aircraft.'}
                            </p>
                            <button onClick={startCapture} disabled={!live || armed} style={wizBtn(live && !armed, 'var(--app-accent)')}>
                                Start capture
                            </button>
                        </>
                    )}
                    {wiz === 'capturing' && (
                        <>
                            <p style={{ fontSize: 13, color: 'hsl(var(--app-text))', margin: 0, lineHeight: 1.6, fontWeight: 600 }}>
                                Move BOTH sticks through their full range - corners included - and flip every switch both ways.
                            </p>
                            <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.6 }}>
                                Finish with everything centred and the throttle all the way DOWN - that final position becomes the trim - then press done.
                            </p>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button onClick={finishCapture} style={wizBtn(true, 'var(--app-ok)')}>Review capture</button>
                                <button onClick={() => setWiz('idle')} style={wizBtn(true, 'var(--app-danger)')}>Cancel</button>
                            </div>
                        </>
                    )}
                    {(wiz === 'review' || wiz === 'writing' || wiz === 'done') && (
                        <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: '3px 12px', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>Ch</span>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>Min</span>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>Trim</span>
                                <span style={{ color: 'hsl(var(--app-text-muted))' }}>Max</span>
                                {calRows().map(r => (
                                    <React.Fragment key={r.ch}>
                                        <span style={{ color: 'var(--app-accent)', fontWeight: 700 }}>{r.ch}</span>
                                        <span style={{ color: 'hsl(var(--app-text))' }}>{r.min}</span>
                                        <span style={{ color: 'hsl(var(--app-text))' }}>{r.trim}</span>
                                        <span style={{ color: 'hsl(var(--app-text))' }}>{r.max}</span>
                                    </React.Fragment>
                                ))}
                            </div>
                            {calRows().length === 0 && (
                                <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-warn)', margin: 0 }}>
                                    Nothing moved more than 300µs - there is nothing to write.
                                </p>
                            )}
                            {wiz === 'review' && (
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button onClick={writeCalibration} disabled={calRows().length === 0 || armed}
                                        style={wizBtn(calRows().length > 0 && !armed, 'var(--app-ok)')}>
                                        Write to aircraft
                                    </button>
                                    <button onClick={startCapture} style={wizBtn(true, 'var(--app-warn)')}>Capture again</button>
                                    <button onClick={() => setWiz('idle')} style={wizBtn(true, 'var(--app-danger)')}>Discard</button>
                                </div>
                            )}
                            {wiz === 'writing' && (
                                <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-warn)', margin: 0 }}>
                                    Writing {writeProgress}
                                </p>
                            )}
                            {wiz === 'done' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-ok)', margin: 0, flex: 1 }}>
                                        Written. Verify on the bars above: full stick = full bar, centred = middle.
                                    </p>
                                    <button onClick={() => setWiz('idle')} style={wizBtn(true, 'var(--app-accent)')}>Done</button>
                                </div>
                            )}
                        </>
                    )}
                    {wizErr && <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--app-danger)', margin: 0 }}>{wizErr}</p>}
                </div>
            </div>
        </div>
    )
}

// Channel and mode pickers on Radio & RC: compact, at least 92px wide.
const SEL_CLS = 'w-auto min-w-[104px] text-[13px] tabular-nums data-[size=sm]:h-8'


function wizBtn(enabled: boolean, colour: string): React.CSSProperties {
    return {
        padding: '6px 14px', borderRadius: 6, background: 'transparent',
        border: `1px solid ${enabled ? mix(colour, 47) : 'hsl(var(--app-border))'}`,
        color: enabled ? colour : 'hsl(var(--app-text-muted))', minHeight: 32,
        fontSize: 13, fontWeight: 700,
        cursor: enabled ? 'pointer' : 'not-allowed',
    }
}

/** The transmitter, drawn - QGC shows photos of one; a drawing can move.
 *  When live channel data flows the sticks ARE the operator's sticks;
 *  without it they rest centred (throttle down) as a wiring diagram.
 *
 *  MOTION IS CSS, NOT FRAMES. The feed arrives at 10 Hz; setting positions
 *  raw renders as ticks. Each moving part sits in a group whose transform
 *  transitions over ~one frame interval, so the browser interpolates the
 *  gaps and the stick glides the way the real one does. */
function TransmitterSvg({ layout, axisValue, live, modeChannel, modeValue, switchType, flightMode }: {
    layout: { left: { x: string; y: string }; right: { x: string; y: string } }
    axisValue: (axis: string) => number
    live: boolean
    modeChannel: number
    modeValue: number
    switchType: string
    flightMode: string
}) {
    const [svgRef, px] = useSvgPx(420)
    const R = 30
    const stickOffset = (ax: { x: string; y: string }) => ({
        dx: axisValue(ax.x) * R,
        dy: -axisValue(ax.y) * R,
    })
    const L = stickOffset(layout.left)
    const Rk = stickOffset(layout.right)
    const stickCol = live ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'
    // The mode switch, drawn as what it is: a lever with 2/3/6 detents.
    const positions = Number(switchType) === 2 ? 2 : Number(switchType) === 6 ? 6 : 3
    const slot = slotForValue(modeValue)
    const detent = slot === 0 ? 0
        : Math.round(((slot - 1) / 5) * (positions - 1))
    return (
        // Never drawn larger than its own 420 units: text then stays at 12px
        // or more in user units too, and the drawing does not balloon.
        <svg ref={svgRef} viewBox="0 0 420 240" style={{ width: '100%', maxWidth: 420, height: 'auto', display: 'block', margin: '0 auto', overflow: 'visible' }} role="img" aria-label="Transmitter stick layout">
            <defs>
                <linearGradient id="tx-body" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="hsl(var(--app-surface))" />
                    <stop offset="1" stopColor="hsl(var(--app-surface-2))" />
                </linearGradient>
                <radialGradient id="tx-well" cx="0.5" cy="0.42" r="0.75">
                    <stop offset="0" stopColor="hsl(var(--app-bg))" />
                    <stop offset="1" stopColor="hsl(var(--app-surface-2))" />
                </radialGradient>
                <filter id="tx-shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="3" stdDeviation="5" floodOpacity="0.25" />
                </filter>
            </defs>
            {/* body */}
            <rect x={20} y={40} width={380} height={172} rx={28}
                fill="url(#tx-body)" stroke="hsl(var(--app-border))" strokeWidth={1.5} filter="url(#tx-shadow)" />
            {/* antenna */}
            <line x1={54} y1={46} x2={24} y2={10} stroke="hsl(var(--app-text-muted))" strokeWidth={4} strokeLinecap="round" />
            <circle cx={22} cy={8} r={4.5} fill="hsl(var(--app-text-muted))" />
            {/* plain shoulder switches on the left */}
            {[104, 158].map(x => (
                <rect key={x} x={x - 11} y={28} width={22} height={12} rx={4}
                    fill="hsl(var(--app-surface))" stroke="hsl(var(--app-border))" strokeWidth={1.2} />
            ))}
            {/* THE MODE SWITCH: a lever with real detents, one per position
                of the selected switch type. The marker slides between them
                (CSS transition), so flipping the real switch visibly clicks
                through LOW / MID / HIGH on screen. */}
            <g>
                <text x={318} y={17} textAnchor="middle" fontSize={px(12)} fontFamily="inherit"
                    fill={modeChannel > 0 ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'}>
                    {modeChannel > 0 ? `Mode ch${modeChannel}` : 'Mode (unassigned)'}
                </text>
                <rect x={288} y={26} width={60} height={16} rx={6}
                    fill={modeChannel > 0 ? 'color-mix(in srgb, var(--app-accent) 10%, transparent)' : 'hsl(var(--app-surface))'}
                    stroke={modeChannel > 0 ? 'color-mix(in srgb, var(--app-accent) 55%, transparent)' : 'hsl(var(--app-border))'} strokeWidth={1.2} />
                {Array.from({ length: positions }, (_, i) => (
                    <circle key={i} cx={296 + (i / (positions - 1)) * 44} cy={34} r={1.6}
                        fill="hsl(var(--app-text-muted))" opacity={0.6} />
                ))}
                <g style={{
                    transform: `translate(${296 + (detent / Math.max(positions - 1, 1)) * 44}px, 34px)`,
                    transition: 'transform 160ms ease-out',
                }}>
                    <circle r={5.5} fill={live && modeChannel > 0 ? 'var(--app-accent)' : 'hsl(var(--app-text-muted))'} />
                    <circle r={2.2} fill="hsl(var(--app-surface))" />
                </g>
            </g>
            {/* gimbal wells + sticks */}
            {[{ cx: 118, off: L, ax: layout.left }, { cx: 302, off: Rk, ax: layout.right }].map(({ cx, off, ax }, i) => (
                <g key={i}>
                    <circle cx={cx} cy={130} r={46} fill="url(#tx-well)" stroke="hsl(var(--app-border))" strokeWidth={1.5} />
                    <circle cx={cx} cy={130} r={34} fill="none" stroke="hsl(var(--app-border))" strokeWidth={0.7} opacity={0.7} />
                    <line x1={cx - 36} y1={130} x2={cx + 36} y2={130} stroke="hsl(var(--app-border))" strokeWidth={0.7} opacity={0.7} />
                    <line x1={cx} y1={94} x2={cx} y2={166} stroke="hsl(var(--app-border))" strokeWidth={0.7} opacity={0.7} />
                    {/* the stick: root fixed, knob glides */}
                    <g style={{ transform: `translate(${cx + off.dx}px, ${130 + off.dy}px)`, transition: 'transform 110ms linear' }}>
                        <line x1={-off.dx} y1={-off.dy} x2={0} y2={0} stroke={stickCol} strokeWidth={4.5} strokeLinecap="round" opacity={0.75} />
                        <circle r={12.5} fill={stickCol} />
                        <circle r={6} fill="hsl(var(--app-surface))" />
                        <circle cx={-3} cy={-3.5} r={2.2} fill="hsl(var(--app-text-muted))" />
                    </g>
                    <text x={cx} y={192} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">
                        <tspan x={cx}>{AXIS_SHORT[ax.y]} ↕</tspan>
                        <tspan x={cx} dy={px(12) * 1.2}>{AXIS_SHORT[ax.x]} ↔</tspan>
                    </text>
                </g>
            ))}
            {/* screen: the mode the AIRCRAFT reports, which is the whole
                point of a mode switch */}
            <rect x={174} y={96} width={72} height={34} rx={6} fill="hsl(var(--app-bg))" stroke="hsl(var(--app-border))" strokeWidth={1.2} />
            {flightMode === 'NO LINK' ? (
                // Nothing to report: one word, not "No RC" over "No link".
                <text x={210} y={117} textAnchor="middle" fontSize={px(12)} fontFamily="inherit" fill="hsl(var(--app-text-muted))">
                    {live ? 'RC live' : 'No RC'}
                </text>
            ) : (
                <>
                    <text x={210} y={110} textAnchor="middle" fontSize={px(12)} fontFamily="inherit"
                        fill={live ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))'}>
                        {live ? 'RC live' : 'No RC'}
                    </text>
                    <text x={210} y={124} textAnchor="middle" fontSize={px(13)} fontFamily="inherit" fontWeight="700" fill="var(--app-accent)">
                        {flightMode.slice(0, 9)}
                    </text>
                </>
            )}
        </svg>
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
            <Panel title="Battery pack" accent="var(--app-accent)">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
                    <BatteryCellsViz cells={p.cells} totalV={totalV} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div>
                            <span style={{ fontSize: 28, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'var(--app-accent)', lineHeight: 1 }}>{p.cells}S</span>
                            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', marginLeft: 8 }}>{p.capacity} mAh</span>
                        </div>
                        {[
                            { label: 'Full charge', val: `${fullV} V` },
                            { label: 'Nominal',     val: `${nomV} V` },
                            { label: 'Min safe',    val: `${minV} V` },
                            ...(totalV ? [{ label: 'Per cell', val: `${(totalV / n).toFixed(2)} V` }] : []),
                            ...(totalV ? [{ label: 'Live voltage', val: `${totalV.toFixed(2)} V` }] : []),
                        ].map(r => (
                            <div key={r.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', width: 92 }}>{r.label}</span>
                                <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: r.label === 'Live voltage' ? 'var(--app-ok)' : 'hsl(var(--app-text))' }}>{r.val}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </Panel>

            <G2>
                <Card title="Pack config">
                    <Field label="Cell count (S)">
                        <AppSelect value={p.cells} onChange={cells => onUpdate({ cells })} options={['2','3','4','5','6','8','10','12'].map(v => ({ value: v, label: `${v}S, ${(+v*4.2).toFixed(1)} V full` }))} />
                    </Field>
                    <Field label="Capacity (mAh)">
                        <AppInput value={p.capacity} onChange={capacity => onUpdate({ capacity })} placeholder="5000" />
                    </Field>
                    <Field label="Critical action" tip="What autopilot does at critical battery level.">
                        <AppSelect value={p.critAction} onChange={critAction => onUpdate({ critAction })} options={[
                            { value: 'warn',   label: 'Warning only - pilot decides' },
                            { value: 'land',   label: 'Land immediately' },
                            { value: 'rtl',    label: 'Return to Launch (RTL)' },
                            { value: 'disarm', label: 'Disarm (ground only)' },
                        ]} />
                    </Field>
                </Card>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <Panel title="Discharge curve" accent="var(--app-warn)">
                        <DischargeCurve warnPct={p.warnPct} critPct={p.critPct} />
                        <p style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))', margin: 0 }}>Typical LiPo curve - flat to ~20%, then rapid voltage drop</p>
                    </Panel>
                    <Card title="Thresholds">
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <Label text="Warning level" tip="Triggers a warning alert. Fly home well before this." />
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-warn)' }}>{p.warnPct}%</span>
                            </div>
                            <input type="range" min={10} max={40} step={5} value={p.warnPct} onChange={e => onUpdate({ warnPct: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-warn)' }} />
                        </div>
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <Label text="Critical level" tip="Triggers the action below." />
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-danger)' }}>{p.critPct}%</span>
                            </div>
                            <input type="range" min={5} max={20} step={1} value={p.critPct} onChange={e => onUpdate({ critPct: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-danger)' }} />
                        </div>
                    </Card>
                </div>
            </G2>
        </div>
    )
}

// ── SAFETY ────────────────────────────────────────────────────────────────────

/** A limit: label left, the value large in tabular numerals right, an optional switch. */
function LimitRow({ label, tip, value, unit, toggle }: { label: string; tip?: string; value: string; unit?: string; toggle?: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>{label}</span>
                {tip && <Tip text={tip} />}
            </div>
            <span style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {value}{unit && <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))', marginLeft: 3 }}>{unit}</span>}
            </span>
            {toggle}
        </div>
    )
}

function SafetyWorkspace({ s, onUpdate }: { s: SafetyProfile; onUpdate: (p: Partial<SafetyProfile>) => void }) {
    const terrainFollow    = useMissionStore(st => st.terrainFollow)
    const setTerrainFollow = useMissionStore(st => st.setTerrainFollow)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <G2>
                {/* Left: geofence map */}
                <Panel title="Airspace, top-down">
                    <div style={{ width: '100%', maxWidth: 340, margin: '0 auto' }}>
                        <GeofenceMap maxDist={s.maxDist} maxDistEnabled={s.maxDistEnabled} rthAlt={s.rthAlt} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {[
                            { color: 'var(--app-danger)', label: `Distance fence: ${s.maxDistEnabled ? s.maxDist + ' m' : 'off'}` },
                            { color: 'var(--app-ok)', label: 'Safe zone (estimate)' },
                            { color: 'var(--app-accent)', label: `Return altitude: ${s.rthAlt} m` },
                        ].map(l => (
                            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                <div style={{ width: 20, height: 3, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                                <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text))' }}>{l.label}</span>
                            </div>
                        ))}
                    </div>
                </Panel>

                {/* Right: controls */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Terrain follow - functional, prominent */}
                    <div style={{ padding: '14px 16px', borderRadius: 10, background: terrainFollow ? 'color-mix(in srgb, var(--app-accent) 7%, transparent)' : 'hsl(var(--app-surface-2))', border: `1px solid ${terrainFollow ? 'color-mix(in srgb, var(--app-accent) 40%, transparent)' : 'hsl(var(--app-border))'}`, transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span style={{ fontSize: 16, fontWeight: 700, color: 'hsl(var(--app-text))' }}>Terrain following</span>
                            <Toggle value={terrainFollow} onChange={() => setTerrainFollow(!terrainFollow)} />
                        </div>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.45 }}
                            title={terrainFollow ? 'Missions export with the TERRAIN_ALT frame.' : undefined}>
                            {terrainFollow ? 'On: holds the same height above the ground over hills.' : 'Off: mission heights are measured from the home point.'}
                        </p>
                    </div>
                    <Card title="Failsafe">
                        <Field label="If the link is lost" tip="What the autopilot does if the RC or telemetry link drops.">
                            <AppSelect value={s.signalLoss} onChange={signalLoss => onUpdate({ signalLoss })} options={[
                                { value: 'rtl',      label: 'Return to Launch (RTL)' },
                                { value: 'land',     label: 'Land immediately' },
                                { value: 'hold',     label: 'Hold position (loiter)' },
                                { value: 'continue', label: 'Continue current mission' },
                            ]} />
                        </Field>
                    </Card>
                    <Card title="Limits">
                        <div>
                            <LimitRow label="Return altitude" tip="The drone climbs to this before flying home." value={`${s.rthAlt}`} unit="m" />
                            <input type="range" min={10} max={150} step={5} value={s.rthAlt} onChange={e => onUpdate({ rthAlt: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-accent)' }} />
                        </div>
                        <div>
                            <LimitRow label="Max altitude" value={s.maxAltEnabled ? `${s.maxAlt}` : 'No limit'} unit={s.maxAltEnabled ? 'm' : undefined}
                                toggle={<Toggle value={s.maxAltEnabled} onChange={() => onUpdate({ maxAltEnabled: !s.maxAltEnabled })} />} />
                            {s.maxAltEnabled && <input type="range" min={20} max={500} step={10} value={s.maxAlt} onChange={e => onUpdate({ maxAlt: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-danger)' }} />}
                        </div>
                        <div>
                            <LimitRow label="Max distance" value={s.maxDistEnabled ? `${s.maxDist}` : 'No limit'} unit={s.maxDistEnabled ? 'm' : undefined}
                                toggle={<Toggle value={s.maxDistEnabled} onChange={() => onUpdate({ maxDistEnabled: !s.maxDistEnabled })} />} />
                            {s.maxDistEnabled && <input type="range" min={50} max={5000} step={50} value={s.maxDist} onChange={e => onUpdate({ maxDist: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-danger)' }} />}
                        </div>
                    </Card>
                    <LockedNote text="Saved on this device only. Sending limits to the autopilot needs parameter write access." />
                </div>
            </G2>
        </div>
    )
}

// ── FLIGHT ────────────────────────────────────────────────────────────────────

function FlightWorkspace({ f, onUpdate, rthAlt, maxAlt, maxAltEnabled }: { f: FlightProfile; onUpdate: (p: Partial<FlightProfile>) => void; rthAlt: number; maxAlt: number; maxAltEnabled: boolean }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <G2>
                <Panel title="Altitude profile, side view" accent="var(--app-ok)">
                    <AltitudeProfile takeoffAlt={f.takeoffAlt} rthAlt={rthAlt} maxAlt={maxAlt} maxAltEnabled={maxAltEnabled} />
                    <div style={{ display: 'flex', gap: '6px 16px', flexWrap: 'wrap' }}>
                        {[
                            { color: 'var(--app-ok)', label: `Takeoff ${f.takeoffAlt} m` },
                            { color: 'var(--app-accent)', label: `Return altitude ${rthAlt} m` },
                            ...(maxAltEnabled ? [{ color: 'var(--app-danger)', label: `Max altitude ${maxAlt} m` }] : []),
                        ].map(l => (
                            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 16, height: 2, background: l.color }} />
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{l.label}</span>
                            </div>
                        ))}
                    </div>
                </Panel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card title="Altitude defaults">
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Label text="Default takeoff" tip="Height for automated takeoff commands." />
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-ok)' }}>{f.takeoffAlt} m</span>
                        </div>
                        <input type="range" min={2} max={50} step={1} value={f.takeoffAlt} onChange={e => onUpdate({ takeoffAlt: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-ok)' }} />
                    </div>
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Label text="Loiter radius" tip="Circle radius in loiter/hold. Mostly for fixed-wing." />
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--app-accent)' }}>{f.loiterRadius} m</span>
                        </div>
                        <input type="range" min={10} max={200} step={10} value={f.loiterRadius} onChange={e => onUpdate({ loiterRadius: +e.target.value })} style={{ width: '100%', accentColor: 'var(--app-accent)' }} />
                    </div>
                </Card>
                <Card title="Return to home">
                    <Field label="Return mode" tip="What the drone does when RTL triggers.">
                        <AppSelect value={f.rthMode} onChange={rthMode => onUpdate({ rthMode })} options={[
                            { value: 'ascend',  label: 'Climb to RTH alt → fly home → land' },
                            { value: 'current', label: 'Fly home at current altitude → land' },
                            { value: 'mission', label: 'Finish waypoint → return' },
                        ]} />
                    </Field>
                    <LockedNote text="Saved on this device only. Sending these to the autopilot comes in a later update." />
                </Card>
                </div>
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
    'Commander':         { color: 'var(--app-danger)', icon: Shield },
    'EKF2':              { color: 'light-dark(#1d4ed8, #60a5fa)', icon: Gauge },
    'Multicopter Rate':  { color: 'light-dark(#c2410c, #f97316)', icon: RotateCcw },
    'Position Control':  { color: 'var(--app-ok)', icon: Move },
    'Navigation':        { color: 'light-dark(#7e22ce, #c084fc)', icon: Navigation },
    'Return to Launch':  { color: 'var(--app-accent)', icon: ChevronLeft },
    'Battery':           { color: 'var(--app-warn)', icon: Battery },
    'Geofence':          { color: 'var(--app-danger)', icon: Shield },
    'Mission':           { color: 'light-dark(#6d28d9, #a78bfa)', icon: Navigation },
    'System':            { color: 'var(--app-accent)', icon: Cpu },
    'MAVLink':           { color: 'var(--app-accent)', icon: Radio },
    'PWM / ESC':         { color: 'light-dark(#c2410c, #fb923c)', icon: Zap },
    'Motors':            { color: 'light-dark(#c2410c, #fb923c)', icon: SlidersHorizontal },
    'Control Allocator': { color: 'hsl(var(--app-text-muted))', icon: SlidersHorizontal },
    'Logging':           { color: 'hsl(var(--app-text-muted))', icon: Terminal },
    'Circuit Breakers':  { color: 'var(--app-danger)', icon: AlertTriangle },
    'Sensors':           { color: 'light-dark(#1d4ed8, #60a5fa)', icon: Gauge },
    'RC Channels':       { color: 'light-dark(#6d28d9, #a78bfa)', icon: Radio },
    'Land Detector':     { color: 'var(--app-ok)', icon: Plane },
    'VTOL':              { color: 'light-dark(#a21caf, #e879f9)', icon: Plane },
    'Failure Detector':  { color: 'var(--app-danger)', icon: AlertTriangle },
    'Attitude Estimator':{ color: 'light-dark(#4338ca, #818cf8)', icon: Gauge },
    'Other':             { color: 'hsl(var(--app-text-muted))', icon: Terminal },
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

    const borderAccent = p.danger ? 'color-mix(in srgb, var(--app-danger) 22%, transparent)' : modified ? 'color-mix(in srgb, var(--app-warn) 28%, transparent)' : `${mix(catColor, 10)}`
    const leftBorder   = p.danger ? 'var(--app-danger)' : modified ? 'var(--app-warn)' : catColor

    return (
        <div style={{ borderRadius: 10, background: 'hsl(var(--app-surface))', border: `1px solid ${borderAccent}`, borderLeft: `3px solid ${leftBorder}`, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '11px 13px 0' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', lineHeight: 1.3 }}>{p.name}</span>
                            {p.danger   && <AlertTriangle size={9} style={{ color: 'var(--app-danger)', flexShrink: 0 }} />}
                            {modified   && <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--app-warn)', flexShrink: 0 }} />}
                        </div>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }} className="font-code">{p.key}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {isSearching && (
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', padding: '1px 5px', borderRadius: 6, background: 'hsl(var(--app-text) / 0.04)', color: 'hsl(var(--app-text-muted))' }}>
                                {PARAM_CATS.find(c => c.id === p.cat)?.label}
                            </span>
                        )}
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', padding: '1px 5px', borderRadius: 6, background: `${mix(catColor, 8)}`, color: catColor }}>
                            {p.type}
                        </span>
                    </div>
                </div>
                <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '5px 0 0', lineHeight: 1.5 }}>{p.desc}</p>
            </div>

            {/* Control */}
            <div style={{ padding: '10px 13px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {p.type === 'bool' && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: currentVal ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))' }}>{valLabel}</span>
                        <Toggle value={!!currentVal} onChange={() => onSet(p.key, currentVal ? 0 : 1)} />
                    </div>
                )}
                {p.type === 'enum' && p.opts && (
                    <OptionSelect aria-label={p.name} value={currentVal} onChange={n => onSet(p.key, n)}
                        options={p.opts.map(o => ({ value: o.v, label: o.l }))} />
                )}
                {(p.type === 'float' || p.type === 'int') && p.min !== undefined && p.max !== undefined && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{p.min}{p.unit ? ` ${p.unit}` : ''}</span>
                            <span style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: p.danger ? 'var(--app-danger)' : catColor }}>{currentVal}{p.unit ? ` ${p.unit}` : ''}</span>
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{p.max}{p.unit ? ` ${p.unit}` : ''}</span>
                        </div>
                        <input type="range" min={p.min} max={p.max} step={p.step ?? (p.type === 'int' ? 1 : 0.01)} value={currentVal}
                            onChange={e => onSet(p.key, +e.target.value)}
                            style={{ width: '100%', accentColor: p.danger ? 'var(--app-danger)' : catColor }} />
                    </div>
                )}

                {/* Footer: default + revert */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>default: {defLabel}</span>
                    {modified && (
                        <button onClick={() => onRevert(p.key)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-warn) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--app-warn) 28%, transparent)', color: 'var(--app-warn)', fontSize: 13, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
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
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 10px', borderRadius: 6, border: 'none', borderLeft: `3px solid ${active ? color : 'transparent'}`, background: active ? `${mix(color, 7)}` : 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
            <Icon size={13} style={{ color: active ? color : 'hsl(var(--app-text-muted))', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, color: active ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))', fontWeight: active ? 600 : 400, lineHeight: 1.2 }}>{label}</span>
            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: active ? color : 'hsl(var(--app-text-muted))', minWidth: 18, textAlign: 'right' }}>{count}</span>
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
    const color    = GROUP_STYLE[dp.group]?.color ?? 'var(--app-accent)'
    // modified = param has drifted from the value we loaded from drone (original snapshot)
    const modified = originalVal !== undefined && dp.liveValue !== originalVal
    const isDanger = meta?.danger ?? false
    const isExpert = meta?.expert ?? false

    if (isExpert && !expert) return null

    const accentColor = isDanger ? 'var(--app-danger)' : color
    const borderL     = isDanger ? 'var(--app-danger)' : modified ? 'var(--app-warn)' : `${mix(color, 33)}`

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
        <div style={{ borderRadius: 10, background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))', borderLeft: `3px solid ${borderL}`, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '11px 13px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text))', lineHeight: 1.3 }}>
                                {meta?.name ?? humanizeParamKey(dp.key)}
                            </span>
                            {isDanger && <AlertTriangle size={10} style={{ color: 'var(--app-danger)', flexShrink: 0 }} />}
                            {modified  && <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--app-warn)', flexShrink: 0 }} />}
                            {pending   && <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'light-dark(#1d4ed8, #60a5fa)', flexShrink: 0 }} />}
                        </div>
                        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }} className="font-code">{dp.key}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginTop: 1 }}>
                        {lastOk === true  && !pending && <span style={{ fontSize: 12, color: 'var(--app-ok)' }}>✓</span>}
                        {lastOk === false && !pending && <AlertTriangle size={10} style={{ color: 'var(--app-danger)' }} />}
                        {isExpert && <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', padding: '1px 5px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-warn) 10%, transparent)', color: 'var(--app-warn)' }}>Expert</span>}
                    </div>
                </div>
                {meta?.desc && (
                    <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.5 }}>{meta.desc}</p>
                )}
            </div>

            {/* Control */}
            <div style={{ padding: '0 13px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {isBool && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2 }}>
                        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: val ? 'var(--app-ok)' : 'hsl(var(--app-text-muted))' }}>{val ? 'Enabled' : 'Disabled'}</span>
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
                                    style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${isActive ? accentColor : 'hsl(var(--app-border))'}`, background: isActive ? `${mix(accentColor, 13)}` : 'hsl(var(--app-surface-2))', color: isActive ? 'hsl(var(--app-text))' : 'hsl(var(--app-text-muted))', fontSize: 12, cursor: 'pointer', fontWeight: isActive ? 600 : 400, transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)' }}>
                                    {l as string}
                                </button>
                            )
                        })}
                    </div>
                )}
                {/* 3+ option enum → dropdown */}
                {hasOpts && !isTwoOpt && (
                    <OptionSelect aria-label={dp.key} value={val} onChange={n => onSet(dp.key, n, dp.paramType)}
                        options={optEntries.map(([v, l]) => ({ value: +v, label: l }))} />
                )}
                {hasRange && !hasOpts && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{meta!.min}{meta?.unit ? ` ${meta.unit}` : ''}</span>
                            <span style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: accentColor }}>{displayVal}</span>
                            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>{meta!.max}{meta?.unit ? ` ${meta.unit}` : ''}</span>
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
                            style={{ flex: 1, padding: '7px 10px', borderRadius: 6, background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border-strong))', color: 'hsl(var(--app-text))', fontSize: 13, fontVariantNumeric: 'tabular-nums', outline: 'none' }} />
                        {meta?.unit && <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>{meta.unit}</span>}
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--app-text-muted))' }}>
                        drone: {dp.liveValue}{meta?.unit ? ` ${meta.unit}` : ''}
                        {originalVal !== undefined && originalVal !== dp.liveValue
                            ? `, was ${isIntType ? Math.round(originalVal) : Number(originalVal.toFixed(4))}${meta?.unit ? ` ${meta.unit}` : ''}`
                            : ''}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {pending   && <span style={{ fontSize: 12, color: 'light-dark(#1d4ed8, #60a5fa)' }}>saving…</span>}
                        {!pending && lastOk === true  && <span style={{ fontSize: 12, color: 'var(--app-ok)' }}>saved</span>}
                        {!pending && lastOk === false && <span style={{ fontSize: 12, color: 'var(--app-danger)' }}>failed</span>}
                        {modified && !pending && (
                            <button onClick={() => onRevert(dp.key)} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-warn) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--app-warn) 25%, transparent)', color: 'var(--app-warn)', fontSize: 13, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
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
    // snapshot of values at fetch time - used for "revert to original"
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

        // A socket drop mid-download means params_result never arrives:
        // without this the spinner spun forever.
        const onDisconnect = () => {
            setLoading(false)
            setFetchError('Connection to HYRAK dropped during the download - fetch again once it reconnects')
        }

        sock.on('params_result',  onResult)
        sock.on('param_set_ack',  onAck)
        sock.on('disconnect',     onDisconnect)
        return () => {
            sock.off('params_result', onResult)
            sock.off('param_set_ack', onAck)
            sock.off('disconnect', onDisconnect)
        }
    }, [])

    // Backstop for every other way a download can go quiet (the backend
    // restarting, a dead MAVLink link that never answers).
    useEffect(() => {
        if (!loading) return
        const t = setTimeout(() => {
            setLoading(false)
            setFetchError('Parameter download timed out after 60 s')
        }, 60_000)
        return () => clearTimeout(t)
    }, [loading])

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
                    <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'hsl(var(--app-text-muted))', pointerEvents: 'none' }} />
                    {liveParams
                        ? <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search all ${displayParams.length} parameters…`}
                            aria-label="Search parameters" className={FOCUS_RING}
                            style={{ ...INPUT_STYLE(), height: 40, paddingLeft: 36 }} />
                        : <input value={demoQuery} onChange={e => setDemoQuery(e.target.value)} placeholder="Search demo parameters - connect drone to see live values…"
                            aria-label="Search parameters" className={FOCUS_RING}
                            style={{ ...INPUT_STYLE(), height: 40, paddingLeft: 36 }} />
                    }
                </div>
                <button onClick={() => liveParams ? setExpert(e => !e) : setDemoExpert(e => !e)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 13px', borderRadius: 6, border: `1px solid ${isExpertOn ? 'var(--app-warn)' : 'hsl(var(--app-border-strong))'}`, background: isExpertOn ? 'color-mix(in srgb, var(--app-warn) 10%, transparent)' : 'hsl(var(--app-surface))', color: isExpertOn ? 'var(--app-warn)' : 'hsl(var(--app-text-muted))', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: isExpertOn ? 600 : 400 }}>
                    <Zap size={12} />{isExpertOn ? 'Expert on' : 'Beginner'}
                </button>
                {(originalModCount > 0 || modifiedCount > 0) && liveParams && (
                    <>
                        <button onClick={() => setModifiedOnly(m => !m)} style={{ padding: '7px 11px', borderRadius: 6, background: modifiedOnly ? 'color-mix(in srgb, var(--app-warn) 15%, transparent)' : 'color-mix(in srgb, var(--app-warn) 8%, transparent)', border: `1px solid ${modifiedOnly ? 'color-mix(in srgb, var(--app-warn) 50%, transparent)' : 'color-mix(in srgb, var(--app-warn) 25%, transparent)'}`, fontSize: 13, fontWeight: 600, color: 'var(--app-warn)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                            {originalModCount > 0 ? originalModCount : modifiedCount} modified{modifiedOnly ? ' ✕' : ' →'}
                        </button>
                        {originalModCount > 0 && (
                            <button onClick={revertAll} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 11px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-warn) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--app-warn) 20%, transparent)', fontSize: 13, color: 'var(--app-warn)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                <RotateCcw size={11} /> Revert all
                            </button>
                        )}
                    </>
                )}
                {liveParams
                    ? <button onClick={fetchParams} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 13px', borderRadius: 6, border: '1px solid hsl(var(--app-border-strong))', background: 'hsl(var(--app-surface))', color: 'hsl(var(--app-text-muted))', fontSize: 13, cursor: 'pointer' }}>
                        <RotateCcw size={12} /> Refresh
                      </button>
                    : connected && !loading
                    ? <button onClick={fetchParams} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 15px', borderRadius: 6, border: '1.5px solid color-mix(in srgb, var(--app-ok) 35%, transparent)', background: 'color-mix(in srgb, var(--app-ok) 8%, transparent)', color: 'var(--app-ok)', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
                        <Wifi size={12} /> Load from drone
                      </button>
                    : null
                }
            </div>

            {/* ── Expert warning ── */}
            {isExpertOn && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 18%, transparent)' }}>
                    <AlertTriangle size={13} style={{ color: 'var(--app-danger)', flexShrink: 0, marginTop: 1 }} />
                    <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0, lineHeight: 1.55 }}>
                        <span style={{ color: 'var(--app-danger)', fontWeight: 600 }}>Expert mode - </span>
                        parameters marked ⚠ can destabilise the drone. Change PIDs in steps of 0.01 max. Always hover-test after any change.
                    </p>
                </div>
            )}

            {/* ── Loading ── */}
            {loading && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '64px 0' }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', border: '3px solid hsl(var(--app-border))', borderTop: '3px solid var(--app-accent)', animation: 'spin 0.8s linear infinite' }} />
                    <div style={{ textAlign: 'center' }}>
                        <p style={{ fontSize: 14, color: 'hsl(var(--app-text-muted))', margin: 0 }}>Downloading parameters from drone…</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '5px 0 0' }}>This takes 5-30 s on a fresh MAVLink connection</p>
                    </div>
                </div>
            )}

            {/* ── Error ── */}
            {fetchError && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 20%, transparent)' }}>
                    <AlertTriangle size={14} style={{ color: 'var(--app-danger)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 13, color: 'var(--app-danger)', margin: 0, fontWeight: 600 }}>Download failed</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>{fetchError}</p>
                    </div>
                    <button onClick={fetchParams} style={{ padding: '6px 14px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--app-danger) 25%, transparent)', color: 'var(--app-danger)', fontSize: 13, cursor: 'pointer' }}>Retry</button>
                </div>
            )}

            {/* ── Demo banner ── */}
            {!liveParams && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-accent) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--app-accent) 15%, transparent)' }}>
                    <Info size={13} style={{ color: 'var(--app-accent)', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 13, color: 'var(--app-accent)', margin: 0, fontWeight: 600 }}>Demo mode - example parameters only</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>
                            {connected ? 'Drone is connected. Select "Load from drone" to read real values.' : 'Connect your drone, then select "Load from drone" to browse and edit live parameters.'}
                        </p>
                    </div>
                </div>
            )}

            {/* ── Live status bar ── */}
            {liveParams && !loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, background: 'color-mix(in srgb, var(--app-ok) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--app-ok) 15%, transparent)' }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--app-ok)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--app-ok)', fontWeight: 600 }}>{displayParams.length} parameters from drone</span>
                    <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                        {Object.keys(PX4_META).filter(k => liveParams[k]).length} with descriptions, {displayParams.filter(d => !d.meta).length} without
                    </span>
                </div>
            )}

            {/* ── Main two-pane layout: sidebar + content ── */}
            {!loading && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, flexWrap: 'wrap' }}>

                    {/* ── Left sidebar nav (hidden while searching or in modified-only view) ── */}
                    {!isSearching_combined && !modifiedOnly && (
                        <>
                            <nav style={{ flex: '0 1 196px', minWidth: 160, display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                            <div style={{ width: 1, alignSelf: 'stretch', background: 'hsl(var(--app-border))', margin: '0 14px', flexShrink: 0 }} />
                        </>
                    )}

                    {/* ── Right content area ── */}
                    <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

                        {/* Content header */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 22 }}>
                            {modifiedOnly && liveParams ? (
                                <span style={{ fontSize: 12, color: 'var(--app-warn)' }}>
                                    {filteredLive.length} modified parameter{filteredLive.length !== 1 ? 's' : ''} across all groups
                                </span>
                            ) : isSearching_combined ? (
                                <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                                    {liveParams
                                        ? `${filteredLive.length} result${filteredLive.length !== 1 ? 's' : ''} for "${query}" across all groups`
                                        : `${demoFiltered.length} result${demoFiltered.length !== 1 ? 's' : ''} for "${demoQuery}"`
                                    }
                                </span>
                            ) : liveParams ? (
                                <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: GROUP_STYLE[activeGroup]?.color ?? 'var(--app-accent)', flexShrink: 0 }} />
                                        <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                                            {activeGroup} - {groupCounts[activeGroup] ?? 0} parameter{(groupCounts[activeGroup] ?? 0) !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    {!expert && displayParams.filter(d => d.group === activeGroup && d.meta?.expert).length > 0 && (
                                        <button onClick={() => setExpert(true)} style={{ fontSize: 13, color: 'var(--app-warn)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                            +{displayParams.filter(d => d.group === activeGroup && d.meta?.expert).length} expert params →
                                        </button>
                                    )}
                                </>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>
                                        {PARAM_CATS.find(c => c.id === demoActiveCat)?.label} - {demoFiltered.length} example parameters
                                    </span>
                                    {demoModCount > 0 && <span style={{ fontSize: 12, color: 'var(--app-warn)', fontWeight: 600 }}>{demoModCount} modified</span>}
                                </div>
                            )}
                        </div>

                        {/* ── Param grid ── */}
                        {liveParams ? (
                            filteredLive.length > 0 ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 10 }}>
                                    {filteredLive.map(dp => (
                                        <LiveParamCard key={dp.key} dp={dp}
                                            localVal={localEdits[dp.key]} pending={!!pending[dp.key]}
                                            lastOk={ackStatus[dp.key] ?? null} expert={expert}
                                            originalVal={originalSnapshot[dp.key]}
                                            onSet={sendParam} onRevert={revertParam} />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '56px 0', color: 'hsl(var(--app-text-muted))', fontSize: 13 }}>
                                    {isSearching ? `No parameters match "${query}"` : 'No parameters in this group'}
                                </div>
                            )
                        ) : (
                            demoFiltered.length > 0 ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 10 }}>
                                    {demoFiltered.map(p => (
                                        <ParamCard key={p.key} p={p} currentVal={getDemoVal(p.key)}
                                            catColor={PARAM_CATS.find(c => c.id === p.cat)?.color ?? 'var(--app-accent)'}
                                            isSearching={isDemoSearching} onSet={setDemoVal} onRevert={revertDemo} />
                                    ))}
                                </div>
                            ) : (
                                <div style={{ textAlign: 'center', padding: '56px 0', color: 'hsl(var(--app-text-muted))', fontSize: 13 }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, paddingTop: 4, borderTop: '1px solid hsl(var(--app-border))' }}>
                {/* Export */}
                <button onClick={downloadParams} disabled={!liveParams} title={liveParams ? undefined : 'Load the parameters first'}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 6, background: 'hsl(var(--app-surface))', border: `1px solid hsl(var(${liveParams ? '--app-border-strong' : '--app-border'}))`, cursor: liveParams ? 'pointer' : 'not-allowed', textAlign: 'left', width: '100%' }}>
                    <Download size={14} style={{ color: 'light-dark(#1d4ed8, #60a5fa)', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text))', margin: 0 }}>Export .params</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0 }}>Download backup file</p>
                    </div>
                </button>
                {/* Import */}
                <button onClick={() => liveParams && importFileRef.current?.click()} disabled={!liveParams} title={liveParams ? undefined : 'Load the parameters first'}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 6, background: 'hsl(var(--app-surface))', border: `1px solid hsl(var(${liveParams ? '--app-border-strong' : '--app-border'}))`, cursor: liveParams ? 'pointer' : 'not-allowed', textAlign: 'left', width: '100%' }}>
                    <Upload size={14} style={{ color: 'light-dark(#7e22ce, #c084fc)', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text))', margin: 0 }}>Import .params</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0 }}>Apply from backup file</p>
                    </div>
                </button>
                {/* Reboot FC */}
                <button onClick={connected ? rebootFC : undefined} disabled={!connected} title={connected ? undefined : 'Connect a drone first'}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 13px', borderRadius: 6, background: 'hsl(var(--app-surface))', border: `1px solid ${connected ? 'color-mix(in srgb, var(--app-danger) 35%, transparent)' : 'hsl(var(--app-border))'}`, cursor: connected ? 'pointer' : 'not-allowed', textAlign: 'left', width: '100%' }}>
                    <Power size={14} style={{ color: 'var(--app-danger)', flexShrink: 0 }} />
                    <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text))', margin: 0 }}>Reboot FC</p>
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0 }}>Restart flight controller</p>
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
    const fitted = useSessionAttachments()

    const [section, setSection] = useState<NavId>('overview')
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
    // Same verdicts as the Sensors workspace - PX4's health flags where they
    // exist, never inferred from the data (heading !== 0 declared the compass
    // broken whenever the aircraft faced magnetic north).
    const hlth = connected && telemetry?.health?.received ? telemetry.health : null
    const sensorOK = [
        connected && (telemetry?.gps?.fix_type ?? 0) >= 3,
        connected && (hlth ? hlth.gyro_cal_ok && hlth.accel_cal_ok : telemetry?.attitude != null),
        connected && (hlth ? hlth.mag_cal_ok : true),
        connected,  // baro: PX4 keeps no verdict - reporting is the claim
    ].filter(Boolean).length

    // Readiness only where something is measured from the drone. Sections
    // that hold local settings (radio, power, safety, flight, parameters,
    // attachments) have no ring: a percentage there would be invented.
    const domainPcts: Record<SectionId, number | null> = {
        connection:  null,
        vehicle:     null,
        sensors:     connected ? (sensorOK / 4) * 100 : null,
        radio:       null,
        power:       null,
        safety:      null,
        flight:      null,
        parameters:  null,
        attachments: null,
    }
    const readiness = connected ? Math.round((sensorOK / 4) * 100) : null

    // ── Two-finger swipe back interception ────────────────────────────────────
    // Opening a section from the overview pushes a history entry, so the
    // browser's back gesture returns to the overview instead of leaving.
    const view = section === 'overview' ? 'grid' : 'workspace'
    const viewRef        = useRef(view)
    const navBackRef     = useRef(false)
    useEffect(() => { viewRef.current = view }, [view])

    useEffect(() => {
        if (view === 'workspace') {
            window.history.pushState({ hyrakConfig: true }, '')
        }
    }, [view])

    useEffect(() => {
        const handle = () => {
            if (navBackRef.current) { navBackRef.current = false; return }
            if (viewRef.current === 'workspace') setSection('overview')
        }
        window.addEventListener('popstate', handle)
        return () => window.removeEventListener('popstate', handle)
    }, [])

    const select = useCallback((id: NavId) => {
        if (id === 'overview' && viewRef.current === 'workspace') {
            navBackRef.current = true
            setSection('overview')
            if (window.history.state?.hyrakConfig) window.history.back()
            return
        }
        setSection(id)
    }, [])

    const navItems: { id: NavId; label: string; icon: React.ElementType }[] = [
        { id: 'overview', label: 'Overview', icon: LayoutList },
        ...DOMAIN_META.filter(d => d.id !== 'parameters'),
        ...DOMAIN_META.filter(d => d.id === 'parameters'),
    ]
    const meta = section === 'overview'
        ? { label: 'Overview', desc: 'Is the drone ready to fly? Open any line to change it.' }
        : (DOMAIN_META.find(d => d.id === section) ?? DOMAIN_META[0])

    const ACTION_WORD: Record<string, string> = { rtl: 'RTL', land: 'Land', hold: 'Hold', continue: 'Continue mission', warn: 'Warn only', disarm: 'Disarm' }
    const attachmentsValue = !fitted.droneId ? 'Needs a drone' : fitted.attachments.length ? fitted.attachments.map(x => x.name).join(', ') : 'None fitted'
    const rows: { id: SectionId; state: RowState; value: string; action?: string }[] = [
        { id: 'vehicle',     state: 'ok', value: `${vehicle.name}, ${AIRFRAME_LABELS[vehicle.airframe] ?? vehicle.airframe}` },
        { id: 'connection',  state: connected ? 'ok' : 'idle', value: connected ? 'Connected' : 'Not connected', action: connected ? undefined : 'Connect' },
        { id: 'sensors',     state: !connected ? 'idle' : sensorOK === 4 ? 'ok' : 'warn', value: !connected ? 'Needs a drone' : `${sensorOK} of 4 healthy`, action: connected && sensorOK < 4 ? 'Calibrate' : undefined },
        { id: 'radio',       state: 'ok', value: `Mode ${radio.rcMode}, ${radio.modes.length} modes set` },
        { id: 'power',       state: 'ok', value: `${power.cells}S ${power.capacity} mAh, ${ACTION_WORD[power.critAction] ?? power.critAction} at ${power.critPct}%` },
        { id: 'safety',      state: 'ok', value: `Link loss: ${ACTION_WORD[safety.signalLoss] ?? safety.signalLoss}, terrain ${terrainFollow ? 'on' : 'off'}` },
        { id: 'flight',      state: 'ok', value: `Takeoff ${flight.takeoffAlt} m, return ${safety.rthAlt} m` },
        { id: 'attachments', state: fitted.droneId ? 'ok' : 'idle', value: attachmentsValue },
        { id: 'parameters',  state: 'none', value: `${PARAMS_DB.length} parameters`, action: 'Open' },
    ]

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <VehicleBanner vehicle={vehicle} readiness={readiness} telStatus={telStatus ?? 'disconnected'} address={address} />

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <SectionNav current={section} onSelect={select} items={navItems} />

                <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
                    <div style={{ maxWidth: 1024, padding: '24px clamp(16px, 3vw, 32px) 40px' }}>
                        {/* Phone width: the section list becomes a select. */}
                        <div className="flex flex-col md:hidden" style={{ gap: 6, marginBottom: 20 }}>
                            <span id="cfg-section-label" style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--app-text-muted))' }}>Section</span>
                            <OptionSelect aria-labelledby="cfg-section-label" value={section} onChange={select}
                                className="data-[size=default]:h-11 text-[15px] font-semibold"
                                options={navItems.map(n => ({ value: n.id, label: n.label }))} />
                        </div>

                        <div key={section} role="tabpanel" className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                            <SectionHead meta={meta} pct={section === 'overview' ? null : domainPcts[section]} />

                            {section === 'overview' && (
                                <section aria-label="Readiness" style={{ borderRadius: 10, border: '1px solid hsl(var(--app-border))', background: 'hsl(var(--app-surface))', overflow: 'hidden' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid hsl(var(--app-border))' }}>
                                        <h3 style={{ fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))', margin: 0, flex: 1 }}>Readiness</h3>
                                        {!connected && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'hsl(var(--app-text-muted))' }}><WifiOff size={14} aria-hidden /> Connect a drone to check sensors</span>}
                                    </div>
                                    <ul style={{ margin: 0, padding: 0 }} className="divide-y divide-app-border">
                                        {rows.map(r => {
                                            const d = DOMAIN_META.find(x => x.id === r.id)!
                                            return <ReadinessRow key={r.id} label={d.label} icon={d.icon} state={r.state} value={r.value} action={r.action} onClick={() => select(r.id)} />
                                        })}
                                    </ul>
                                </section>
                            )}

                            {/* Parameter writes, calibration and reboots are
                                commands: a workspace viewer reads this page only. */}
                            {section !== 'overview' && section !== 'attachments' && (
                                <ViewOnlyFence>
                                {section === 'connection' && <ConnectionWorkspace address={address} setAddress={v => { setAddress(v); lsSet('hyrak-mav-address', v) }} />}
                                {section === 'vehicle'    && <VehicleWorkspace v={vehicle} onUpdate={upV} />}
                                {section === 'sensors'    && <SensorsWorkspace />}
                                {section === 'radio'      && <RadioWorkspace />}
                                {section === 'power'      && <PowerWorkspace p={power} onUpdate={upP} />}
                                {section === 'safety'     && <SafetyWorkspace s={safety} onUpdate={upS} />}
                                {section === 'flight'     && <FlightWorkspace f={flight} onUpdate={upF} rthAlt={safety.rthAlt} maxAlt={safety.maxAlt} maxAltEnabled={safety.maxAltEnabled} />}
                                {section === 'parameters' && <ParametersWorkspace />}
                                </ViewOnlyFence>
                            )}
                            {/* Reads for everyone; owners and admins edit (the server says who). */}
                            {section === 'attachments' && <AttachmentsSection />}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

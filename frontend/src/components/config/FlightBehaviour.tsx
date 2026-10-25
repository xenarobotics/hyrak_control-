'use client'

// Config > Flight behaviour. QGroundControl 4.4's Flight Behavior page on
// PX4's parameters: how fast and how smoothly the aircraft flies in Position
// mode, missions and HYRAK's automatic flight, takeoff and landing heights,
// mission acceptance, weathervane and pilot override. Failsafe actions,
// the Offboard-loss action and the final landing speed live on Safety; the
// controller gains on Tuning. Only parameters the aircraft has are listed.

import React from 'react'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Grid, Note, Panel, ParamSourceBar, ReloadButton, T, type ParamSpec } from '@/components/config/kit'
import { BitmaskRow, SpecRows, WriteLog, useVehicleClass } from '@/components/config/setupKit'

const SPEEDS: ParamSpec[] = [
    { key: 'MPC_XY_VEL_MAX', label: 'Max horizontal speed', unit: 'm/s', def: 12, min: 0, max: 20, decimals: 1, tip: 'Fastest the aircraft moves in Position mode and missions.' },
    { key: 'MPC_XY_CRUISE', label: 'Mission cruise speed', unit: 'm/s', def: 5, min: 3, max: 20, decimals: 1, tip: 'Default speed between mission waypoints, Return and Go to.' },
    { key: 'MPC_VEL_MANUAL', label: 'Position mode stick speed', unit: 'm/s', def: 10, min: 3, max: 20, decimals: 1, tip: 'Speed at full stick in Position mode.' },
    { key: 'MPC_Z_VEL_MAX_UP', label: 'Max climb rate', unit: 'm/s', def: 3, min: 0.5, max: 8, decimals: 1 },
    { key: 'MPC_Z_VEL_MAX_DN', label: 'Max descent rate', unit: 'm/s', def: 1.5, min: 0.5, max: 4, decimals: 1, tip: 'Above 2 m/s risks descending through its own propwash.' },
    { key: 'MPC_Z_V_AUTO_UP', label: 'Climb rate in missions', unit: 'm/s', def: 3, min: 0.5, max: 8, decimals: 1 },
    { key: 'MPC_Z_V_AUTO_DN', label: 'Descent rate in missions', unit: 'm/s', def: 1.5, min: 0.5, max: 4, decimals: 1 },
    { key: 'MPC_TILTMAX_AIR', label: 'Max tilt', unit: '°', def: 45, min: 20, max: 89, decimals: 0, tip: 'Steepest lean in any automatic or assisted mode.' },
    { key: 'MPC_MAN_Y_MAX', label: 'Max stick yaw rate', unit: '°/s', def: 150, min: 0, max: 400, decimals: 0 },
]

const SMOOTH: ParamSpec[] = [
    { key: 'MPC_ACC_HOR', label: 'Horizontal acceleration', unit: 'm/s²', def: 3, min: 2, max: 15, decimals: 1, tip: 'How briskly it speeds up and slows down in automatic flight.' },
    { key: 'MPC_ACC_HOR_MAX', label: 'Max stick acceleration', unit: 'm/s²', def: 5, min: 2, max: 15, decimals: 1 },
    { key: 'MPC_ACC_UP_MAX', label: 'Max upward acceleration', unit: 'm/s²', def: 4, min: 2, max: 15, decimals: 1 },
    { key: 'MPC_ACC_DOWN_MAX', label: 'Max downward acceleration', unit: 'm/s²', def: 3, min: 2, max: 15, decimals: 1 },
    { key: 'MPC_JERK_AUTO', label: 'Jerk limit in missions', unit: 'm/s³', def: 4, min: 1, max: 80, decimals: 1, tip: 'How fast acceleration may change. Lower is smoother (better video), higher is more agile.' },
    { key: 'MPC_JERK_MAX', label: 'Jerk limit on the sticks', unit: 'm/s³', def: 8, min: 0.5, max: 500, decimals: 0 },
    { key: 'MPC_POS_MODE', label: 'Position mode feel', def: 4, options: [{ value: 0, label: 'Direct velocity' }, { value: 4, label: 'Acceleration based (smooth)' }], tip: 'Acceleration based glides to a stop; direct velocity stops at once and is used for tuning.' },
    { key: 'MPC_YAWRAUTO_MAX', label: 'Yaw rate in missions', unit: '°/s', def: 60, min: 5, max: 360, decimals: 0, tip: 'How fast the aircraft turns to face its heading in automatic flight.' },
    { key: 'MPC_YAWRAUTO_ACC', label: 'Yaw acceleration in missions', unit: '°/s²', def: 20, min: 5, max: 360, decimals: 0 },
]

const TAKEOFF_LAND: ParamSpec[] = [
    { key: 'MIS_TAKEOFF_ALT', label: 'Takeoff height', unit: 'm', def: 2.5, min: 0, max: 100, decimals: 1, tip: 'Height an automatic takeoff climbs to.' },
    { key: 'MPC_TKO_SPEED', label: 'Takeoff climb rate', unit: 'm/s', def: 1.5, min: 1, max: 5, decimals: 1 },
    { key: 'MPC_TKO_RAMP_T', label: 'Takeoff ramp time', unit: 's', def: 3, min: 0, max: 5, decimals: 1, tip: 'How gently the motors spool up for takeoff.' },
    { key: 'MPC_LAND_ALT1', label: 'Slow down below', unit: 'm', def: 10, min: 0, max: 122, decimals: 1, tip: 'Below this height a landing starts slowing toward the final landing speed.' },
    { key: 'MPC_LAND_ALT2', label: 'Final speed below', unit: 'm', def: 5, min: 0, max: 122, decimals: 1, tip: 'Below this height a landing descends at the final landing speed (set on Safety).' },
    { key: 'MPC_LAND_CRWL', label: 'Crawl speed near the ground', unit: 'm/s', def: 0.3, min: 0.1, decimals: 1, tip: 'Used in the last metre when a distance sensor sees the ground.' },
    { key: 'MPC_LAND_RC_HELP', label: 'Let the pilot nudge a landing', bool: true, def: 0, tip: 'Sticks move and yaw the aircraft during an automatic landing.' },
]

const MISSION: ParamSpec[] = [
    { key: 'NAV_ACC_RAD', label: 'Waypoint radius', unit: 'm', def: 2, min: 0.05, max: 200, decimals: 2, tip: 'How close counts as reaching a waypoint.' },
    { key: 'NAV_MC_ALT_RAD', label: 'Waypoint height tolerance', unit: 'm', def: 0.8, min: 0.05, max: 200, decimals: 1 },
    { key: 'NAV_FW_ALT_RAD', label: 'Waypoint height tolerance (plane)', unit: 'm', def: 10, min: 0.05, max: 200, decimals: 1 },
    { key: 'MPC_YAW_MODE', label: 'Heading in missions', def: 0, options: [
        { value: 0, label: 'Toward the next waypoint' }, { value: 1, label: 'Toward home' }, { value: 2, label: 'Away from home' },
        { value: 3, label: 'Along the path' }, { value: 4, label: 'Toward waypoint, turn first' }, { value: 5, label: 'Fixed' },
    ] },
    { key: 'MIS_DIST_1WP', label: 'Warn if the first waypoint is further than', unit: 'm', def: 10000, min: -1, max: 100000, decimals: 0, tip: 'PX4 warns when a mission starts further than this from home. 0 or less = no warning.' },
    { key: 'MIS_YAW_TMT', label: 'Wait for heading', unit: 's', def: -1, min: -1, max: 20, decimals: 1, tip: 'How long to wait at a waypoint for the heading to be reached. -1 = do not wait.' },
]

const WEATHERVANE: ParamSpec[] = [
    { key: 'WV_EN', label: 'Turn into the wind', bool: true, def: 0, tip: 'Weathervane: in missions the aircraft yaws into the wind. Mostly for VTOLs and large frames.' },
    { key: 'WV_GAIN', label: 'How strongly', def: 1, min: 0, max: 3, decimals: 2 },
    { key: 'WV_YRATE_MAX', label: 'Max turn rate', unit: '°/s', def: 90, min: 0, max: 120, decimals: 0 },
]

export function FlightBehaviour() {
    const vp = useVehicleParams()
    const vc = useVehicleClass()
    const a1 = vp.get('MPC_LAND_ALT1'), a2 = vp.get('MPC_LAND_ALT2')
    const vxy = vp.get('MPC_XY_VEL_MAX'), cruise = vp.get('MPC_XY_CRUISE')
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="flight behaviour" /></div>
                <ReloadButton />
            </div>
            {vp.ready && a1 != null && a2 != null && a2 > a1 && <Note tone="warn">The final-speed height ({a2} m) is above the slow-down height ({a1} m). PX4 needs it lower.</Note>}
            {vp.ready && vxy != null && cruise != null && cruise > vxy && <Note tone="warn">Mission cruise speed ({cruise} m/s) is above the max horizontal speed ({vxy} m/s); PX4 caps it at the max.</Note>}
            <Grid min={360}>
                <Panel title="Speeds" hint="Position mode, missions and HYRAK's automatic flight"><SpecRows specs={SPEEDS} /></Panel>
                <Panel title="Smoothness" hint="acceleration, jerk and turning"><SpecRows specs={SMOOTH} /></Panel>
                <Panel title="Takeoff and landing" hint="final landing speed is on Safety"><SpecRows specs={TAKEOFF_LAND} /></Panel>
                <Panel title="Missions"><SpecRows specs={MISSION.filter(s => s.key !== 'NAV_FW_ALT_RAD' || vc.fw)} /></Panel>
                <Panel title="Weathervane"><SpecRows specs={WEATHERVANE} empty={<p style={{ margin: 0, fontSize: 13, color: T.muted }}>This firmware has no weathervane.</p>} /></Panel>
                <Panel title="Pilot override" hint="sticks take over from automatic flight">
                    <BitmaskRow k="COM_RC_OVERRIDE" label="Moving the sticks takes over in" bits={[[0, 'Missions and Return'], [1, 'Offboard (HYRAK tracking, follow)']]}
                        tip="Moving the sticks past the threshold switches to Position mode. Offboard is how HYRAK flies tracking, follow and avoidance." />
                </Panel>
            </Grid>
            <WriteLog />
        </div>
    )
}

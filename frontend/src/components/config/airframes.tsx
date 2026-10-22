'use client'

// PX4 airframes by SYS_AUTOSTART number, grouped the way QGroundControl's
// Airframe page groups them, with a plain line drawing per frame type.
// Only common, long-standing numbers are listed; any other airframe is
// entered by number (PX4's full list: docs.px4.io, Airframe reference).

import React from 'react'

export type FrameKind =
    | 'quad-x' | 'quad-plus' | 'hex-x' | 'hex-plus' | 'octo-x' | 'octo-plus'
    | 'coax-mono' | 'coax-y6' | 'coax-x8'
    | 'vtol-standard' | 'vtol-tilt' | 'vtol-tailsitter'
    | 'plane' | 'wing' | 'rover'

export type FrameCategory = 'Quadrotor' | 'Hexarotor' | 'Octorotor' | 'Coaxial' | 'VTOL' | 'Fixed wing' | 'Rover'

export interface Airframe { id: number; name: string; kind: FrameKind; cat: FrameCategory; note?: string }

export const AIRFRAMES: Airframe[] = [
    { id: 4001, name: 'Generic quadcopter', kind: 'quad-x', cat: 'Quadrotor', note: 'Also the Gazebo x500 in SITL' },
    { id: 4014, name: 'Holybro S500', kind: 'quad-x', cat: 'Quadrotor' },
    { id: 4019, name: 'Holybro X500 V2', kind: 'quad-x', cat: 'Quadrotor' },
    { id: 4050, name: 'Generic 250 racer', kind: 'quad-x', cat: 'Quadrotor' },
    { id: 5001, name: 'Generic quadcopter +', kind: 'quad-plus', cat: 'Quadrotor' },
    { id: 6001, name: 'Generic hexacopter X', kind: 'hex-x', cat: 'Hexarotor' },
    { id: 7001, name: 'Generic hexacopter +', kind: 'hex-plus', cat: 'Hexarotor' },
    { id: 8001, name: 'Generic octocopter X', kind: 'octo-x', cat: 'Octorotor' },
    { id: 9001, name: 'Generic octocopter +', kind: 'octo-plus', cat: 'Octorotor' },
    { id: 4302, name: 'HYRAK mono-coaxial', kind: 'coax-mono', cat: 'Coaxial', note: 'HYRAK custom airframe' },
    { id: 11001, name: 'Generic hexa coaxial (Y6)', kind: 'coax-y6', cat: 'Coaxial' },
    { id: 12001, name: 'Generic octo coaxial (X8)', kind: 'coax-x8', cat: 'Coaxial' },
    { id: 13000, name: 'Generic standard VTOL', kind: 'vtol-standard', cat: 'VTOL' },
    { id: 13100, name: 'Generic tiltrotor VTOL', kind: 'vtol-tilt', cat: 'VTOL' },
    { id: 13200, name: 'Generic tailsitter VTOL', kind: 'vtol-tailsitter', cat: 'VTOL' },
    { id: 4303, name: 'HYRAK tandem tilt-wing', kind: 'vtol-tilt', cat: 'VTOL', note: 'HYRAK custom airframe' },
    { id: 2100, name: 'Standard plane', kind: 'plane', cat: 'Fixed wing' },
    { id: 3000, name: 'Generic flying wing', kind: 'wing', cat: 'Fixed wing' },
    { id: 50000, name: 'Generic ground rover', kind: 'rover', cat: 'Rover' },
]

export const FRAME_CATEGORIES: FrameCategory[] = ['Quadrotor', 'Hexarotor', 'Octorotor', 'Coaxial', 'VTOL', 'Fixed wing', 'Rover']

export const airframeById = (id: number | null | undefined) => (id == null ? undefined : AIRFRAMES.find(a => a.id === id))

/** A frame kind from the HEARTBEAT's MAV_TYPE, for the banner icon when the
 *  airframe number is not in the list. */
export function kindFromMavType(t: number | null | undefined): FrameKind | null {
    switch (t) {
        case 1: return 'plane'
        case 2: return 'quad-x'
        case 3: return 'coax-mono'
        case 10: return 'rover'
        case 13: return 'hex-x'
        case 14: return 'octo-x'
        case 19: case 20: case 23: return 'vtol-tailsitter'
        case 21: case 24: return 'vtol-tilt'
        case 22: return 'vtol-standard'
        default: return null
    }
}

/** A frame kind from the SYS_AUTOSTART number's range when it is not listed
 *  (PX4 numbers airframes by class: 4xxx quad X, 6xxx hex X, 13xxx VTOL...). */
export function kindFromAutostart(id: number | null | undefined): FrameKind | null {
    if (id == null || id <= 0) return null
    const a = airframeById(id)
    if (a) return a.kind
    if (id >= 50000) return 'rover'
    if (id >= 13000 && id < 14000) return 'vtol-standard'
    if (id >= 12000 && id < 13000) return 'coax-x8'
    if (id >= 11000 && id < 12000) return 'coax-y6'
    if (id >= 9000 && id < 10000) return 'octo-plus'
    if (id >= 8000 && id < 9000) return 'octo-x'
    if (id >= 7000 && id < 8000) return 'hex-plus'
    if (id >= 6000 && id < 7000) return 'hex-x'
    if (id >= 5000 && id < 6000) return 'quad-plus'
    if (id >= 4000 && id < 5000) return 'quad-x'
    if (id >= 3000 && id < 4000) return 'wing'
    if (id >= 2000 && id < 3000) return 'plane'
    return null
}

const ring = (n: number, r: number, start: number) =>
    Array.from({ length: n }, (_, i) => {
        const a = (start + (360 / n) * i) * Math.PI / 180
        return [24 + r * Math.cos(a), 24 + r * Math.sin(a)] as const
    })

function Rotors({ pts, r, coax }: { pts: readonly (readonly [number, number])[]; r: number; coax?: boolean }) {
    return (
        <>
            {pts.map(([x, y], i) => (
                <g key={i}>
                    <line x1={24} y1={24} x2={x} y2={y} />
                    <circle cx={x} cy={y} r={r} />
                    {coax && <circle cx={x} cy={y} r={r * 0.5} />}
                </g>
            ))}
            <circle cx={24} cy={24} r={3.5} />
        </>
    )
}

/** A top-down line drawing of a frame type, in currentColor. */
export function FrameIcon({ kind, size = 48, strokeWidth = 1.5 }: { kind: FrameKind; size?: number; strokeWidth?: number }) {
    let body: React.ReactNode
    switch (kind) {
        case 'quad-x': body = <Rotors pts={ring(4, 14, 45)} r={6.5} />; break
        case 'quad-plus': body = <Rotors pts={ring(4, 15, -90)} r={6} />; break
        case 'hex-x': body = <Rotors pts={ring(6, 16, 0)} r={5} />; break
        case 'hex-plus': body = <Rotors pts={ring(6, 16, -90)} r={5} />; break
        case 'octo-x': body = <Rotors pts={ring(8, 17, 22.5)} r={4} />; break
        case 'octo-plus': body = <Rotors pts={ring(8, 17, -90)} r={4} />; break
        case 'coax-y6': body = <Rotors pts={ring(3, 15, -90)} r={6.5} coax />; break
        case 'coax-x8': body = <Rotors pts={ring(4, 14, 45)} r={6.5} coax />; break
        case 'coax-mono': body = (
            <>
                <ellipse cx={24} cy={13} rx={17} ry={3.5} />
                <ellipse cx={24} cy={21} rx={17} ry={3.5} />
                <line x1={24} y1={13} x2={24} y2={29} />
                <rect x={18} y={29} width={12} height={9} rx={3} />
                <line x1={19} y1={38} x2={15} y2={42} /><line x1={29} y1={38} x2={33} y2={42} />
            </>
        ); break
        case 'plane': body = (
            <>
                <path d="M24 6 C26 8 26 12 26 16 L26 36 L24 42 L22 36 L22 16 C22 12 22 8 24 6 Z" />
                <path d="M22 18 L5 25 L5 28 L22 25 M26 18 L43 25 L43 28 L26 25" />
                <path d="M22.5 35 L16 39 L16 41 L24 39.5 L32 41 L32 39 L25.5 35" />
            </>
        ); break
        case 'wing': body = <path d="M24 9 L44 33 L38 36 L24 30 L10 36 L4 33 Z M24 30 L24 22" />; break
        case 'vtol-standard': body = (
            <>
                <path d="M24 6 L26 14 L26 36 L24 42 L22 36 L22 14 Z" />
                <path d="M22 20 L5 25 L5 28 L22 26 M26 20 L43 25 L43 28 L26 26" />
                <line x1={11} y1={13} x2={11} y2={35} /><line x1={37} y1={13} x2={37} y2={35} />
                <circle cx={11} cy={13} r={4} /><circle cx={11} cy={35} r={4} />
                <circle cx={37} cy={13} r={4} /><circle cx={37} cy={35} r={4} />
            </>
        ); break
        case 'vtol-tilt': body = (
            <>
                <path d="M24 8 L26 14 L26 38 L24 42 L22 38 L22 14 Z" />
                <path d="M22 17 L5 21 L5 25 L22 23 M26 17 L43 21 L43 25 L26 23" />
                <path d="M22 34 L13 37 L13 40 L22 38 M26 34 L35 37 L35 40 L26 38" />
                <circle cx={10} cy={17} r={4.5} /><circle cx={38} cy={17} r={4.5} />
            </>
        ); break
        case 'vtol-tailsitter': body = (
            <>
                <path d="M24 12 L44 30 L38 33 L24 27 L10 33 L4 30 Z" />
                <line x1={14} y1={21} x2={14} y2={10} /><line x1={34} y1={21} x2={34} y2={10} />
                <ellipse cx={14} cy={9} rx={6} ry={2} /><ellipse cx={34} cy={9} rx={6} ry={2} />
            </>
        ); break
        case 'rover': body = (
            <>
                <rect x={15} y={9} width={18} height={30} rx={4} />
                <rect x={8} y={11} width={5} height={10} rx={1.5} /><rect x={35} y={11} width={5} height={10} rx={1.5} />
                <rect x={8} y={27} width={5} height={10} rx={1.5} /><rect x={35} y={27} width={5} height={10} rx={1.5} />
                <path d="M21 15 L24 12 L27 15" />
            </>
        ); break
    }
    return (
        <svg viewBox="0 0 48 48" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, display: 'block' }}>
            {body}
        </svg>
    )
}

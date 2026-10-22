'use client'

// Gamepad / joystick setup, shared by Config > Joystick and (later) the Fly
// page. Read through the browser Gamepad API; settings are stored per user in
// this browser only. Nothing in this file talks to the drone.

import { useEffect, useRef, useState } from 'react'

export type StickAxis = 'roll' | 'pitch' | 'yaw' | 'throttle'
export const STICK_AXES: StickAxis[] = ['roll', 'pitch', 'yaw', 'throttle']

/** What a button can do. Names match drone_action / set_mode on the backend,
 *  so whoever wires the Fly page sends exactly these. */
export const JOY_ACTIONS = [
    { id: '', label: 'Nothing' },
    { id: 'hold', label: 'Hold' },
    { id: 'return', label: 'Return home' },
    { id: 'land', label: 'Land' },
    { id: 'takeoff', label: 'Take off' },
    { id: 'arm', label: 'Arm' },
    { id: 'disarm', label: 'Disarm' },
    { id: 'mode:POSITION', label: 'Position mode' },
    { id: 'mode:ALTITUDE', label: 'Altitude mode' },
    { id: 'mode:STABILIZED', label: 'Stabilized mode' },
    { id: 'mode:MISSION', label: 'Mission mode' },
] as const
export type JoyActionId = (typeof JOY_ACTIONS)[number]['id']

export interface AxisCal { index: number; reverse: boolean; min: number; center: number; max: number }
export interface JoystickConfig {
    enabled: boolean
    /** The gamepad's id string, so a different pad does not inherit a mapping. */
    padId: string
    axes: Record<StickAxis, AxisCal>
    /** 0..0.5 of the stick travel ignored around centre. */
    deadzone: number
    /** 0..1, 0 = linear. Softens small movements around centre. */
    expo: number
    /** 'center': throttle stick springs to centre = hold altitude.
     *  'full': throttle stick bottom = zero. */
    throttleMode: 'center' | 'full'
    buttons: Record<number, JoyActionId>
}

const DEFAULT_AXIS = (index: number, reverse = false): AxisCal => ({ index, reverse, min: -1, center: 0, max: 1 })

/** Standard-mapping gamepads (Xbox / PlayStation layout) in Mode 2. */
export const DEFAULT_JOYSTICK: JoystickConfig = {
    enabled: false,
    padId: '',
    axes: { yaw: DEFAULT_AXIS(0), throttle: DEFAULT_AXIS(1, true), roll: DEFAULT_AXIS(2), pitch: DEFAULT_AXIS(3, true) },
    deadzone: 0.08,
    expo: 0.3,
    throttleMode: 'center',
    buttons: {},
}

const key = (userId: string | number | null | undefined) => `hyrak-joystick:${userId ?? 'anon'}`

export function loadJoystick(userId: string | number | null | undefined): JoystickConfig {
    if (typeof window === 'undefined') return DEFAULT_JOYSTICK
    try {
        const raw = localStorage.getItem(key(userId))
        if (!raw) return DEFAULT_JOYSTICK
        const j = JSON.parse(raw) as Partial<JoystickConfig>
        return { ...DEFAULT_JOYSTICK, ...j, axes: { ...DEFAULT_JOYSTICK.axes, ...(j.axes ?? {}) }, buttons: { ...(j.buttons ?? {}) } }
    } catch { return DEFAULT_JOYSTICK }
}

export function saveJoystick(userId: string | number | null | undefined, cfg: JoystickConfig) {
    try { localStorage.setItem(key(userId), JSON.stringify(cfg)) } catch { /* storage blocked: the page still works this visit */ }
}

/** Raw axis value (-1..1) through the calibration, deadzone and expo.
 *  Sticks come out -1..1; throttle in 'full' mode 0..1. */
export function shapeAxis(raw: number, cal: AxisCal, cfg: Pick<JoystickConfig, 'deadzone' | 'expo' | 'throttleMode'>, isThrottle: boolean): number {
    let v = raw >= cal.center
        ? (raw - cal.center) / Math.max(1e-3, cal.max - cal.center)
        : (raw - cal.center) / Math.max(1e-3, cal.center - cal.min)
    v = Math.max(-1, Math.min(1, v))
    if (cal.reverse) v = -v
    if (isThrottle && cfg.throttleMode === 'full') return (v + 1) / 2
    const dz = Math.max(0, Math.min(0.5, cfg.deadzone))
    const a = Math.abs(v)
    if (a <= dz) return 0
    const lin = (a - dz) / (1 - dz)
    const e = Math.max(0, Math.min(1, cfg.expo))
    return Math.sign(v) * ((1 - e) * lin + e * lin * lin * lin)
}

export interface PadSnapshot { index: number; id: string; mapping: string; axes: number[]; buttons: boolean[] }

/** Connected gamepads, re-read every animation frame while mounted. The
 *  browser only reveals a pad after a button is pressed on it. */
export function useGamepads(): PadSnapshot[] {
    const [pads, setPads] = useState<PadSnapshot[]>([])
    const last = useRef('')
    useEffect(() => {
        if (typeof navigator === 'undefined' || !navigator.getGamepads) return
        let raf = 0
        const read = () => {
            const list: PadSnapshot[] = []
            for (const g of navigator.getGamepads()) {
                if (!g || !g.connected) continue
                list.push({ index: g.index, id: g.id, mapping: g.mapping, axes: [...g.axes], buttons: g.buttons.map(b => b.pressed) })
            }
            // Only re-render when something moved, quantised to drop sensor noise.
            const sig = JSON.stringify(list.map(p => [p.index, p.axes.map(a => Math.round(a * 200)), p.buttons]))
            if (sig !== last.current) { last.current = sig; setPads(list) }
            raf = requestAnimationFrame(read)
        }
        raf = requestAnimationFrame(read)
        const wake = () => { last.current = '' }
        window.addEventListener('gamepadconnected', wake)
        window.addEventListener('gamepaddisconnected', wake)
        return () => { cancelAnimationFrame(raf); window.removeEventListener('gamepadconnected', wake); window.removeEventListener('gamepaddisconnected', wake) }
    }, [])
    return pads
}

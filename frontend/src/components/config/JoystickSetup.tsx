'use client'

// Config > Joystick: QGroundControl's Joystick page for a browser gamepad.
//
// SETUP ONLY. This page sends nothing to the drone: moving a stick or pressing
// a button here only moves the on-screen preview and names the action that
// button would trigger. Settings live in this browser, per signed-in user
// (lib/joystick.ts). HYRAK's Fly page has no stick control yet; these are the
// settings it will read when it does.

import React, { useEffect, useRef, useState } from 'react'
import { Gamepad2, Check } from 'lucide-react'
import { useAccess } from '@/hooks/useAccess'
import { OptionSelect } from '@/components/config/OptionSelect'
import { Btn, Chip, Note, Panel, T, Tip, Toggle, mix } from '@/components/config/kit'
import {
    DEFAULT_JOYSTICK, JOY_ACTIONS, STICK_AXES, loadJoystick, saveJoystick, shapeAxis, useGamepads,
    type JoyActionId, type JoystickConfig, type StickAxis,
} from '@/lib/joystick'

const AXIS_LABEL: Record<StickAxis, string> = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw', throttle: 'Throttle' }

type Cal = { phase: 'idle' } | { phase: 'move' } | { phase: 'center' }

export function JoystickSetup() {
    const { user } = useAccess()
    const uid = user?.id ?? null
    const [cfg, setCfg] = useState<JoystickConfig>(DEFAULT_JOYSTICK)
    const [loadedFor, setLoadedFor] = useState<string | number | null | undefined>(undefined)
    if (loadedFor !== uid) { setLoadedFor(uid); setCfg(loadJoystick(uid)) }
    const update = (patch: Partial<JoystickConfig>) => setCfg(c => { const n = { ...c, ...patch }; saveJoystick(uid, n); return n })

    const pads = useGamepads()
    const [padIdx, setPadIdx] = useState<number | null>(null)
    const pad = pads.find(p => p.index === padIdx) ?? pads.find(p => p.id === cfg.padId) ?? pads[0] ?? null
    const supported = typeof navigator !== 'undefined' && !!navigator.getGamepads

    // ── Calibration: record each axis's extremes, then its rest position ──
    const [cal, setCal] = useState<Cal>({ phase: 'idle' })
    const ext = useRef<{ min: number; max: number }[]>([])
    useEffect(() => {
        if (cal.phase !== 'move' || !pad) return
        pad.axes.forEach((v, i) => {
            const e = ext.current[i]
            ext.current[i] = e ? { min: Math.min(e.min, v), max: Math.max(e.max, v) } : { min: v, max: v }
        })
    }, [pad, cal.phase])
    const finishCal = () => {
        if (!pad) return
        const axes = { ...cfg.axes }
        for (const a of STICK_AXES) {
            const i = axes[a].index
            const e = ext.current[i]
            if (!e || e.max - e.min < 0.5) continue // not moved: keep the old numbers
            axes[a] = { ...axes[a], min: e.min, max: e.max, center: a === 'throttle' && cfg.throttleMode === 'full' ? (e.min + e.max) / 2 : pad.axes[i] ?? 0 }
        }
        update({ axes, padId: pad.id })
        setCal({ phase: 'idle' })
    }

    // ── Detect: the axis that moved the most since the button was pressed ──
    const [detect, setDetect] = useState<{ axis: StickAxis; base: number[] } | null>(null)
    useEffect(() => {
        if (!detect || !pad) return
        let best = -1, bestD = 0.5
        pad.axes.forEach((v, i) => { const d = Math.abs(v - (detect.base[i] ?? 0)); if (d > bestD) { bestD = d; best = i } })
        if (best >= 0) {
            const t = setTimeout(() => {
                update({ axes: { ...cfg.axes, [detect.axis]: { ...cfg.axes[detect.axis], index: best } }, padId: pad.id })
                setDetect(null)
            }, 0)
            return () => clearTimeout(t)
        }
    }, [pad, detect]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── Button test preview: what a press WOULD do, nothing sent ──
    const [lastPress, setLastPress] = useState<{ b: number; at: number } | null>(null)
    const prevButtons = useRef<boolean[]>([])
    useEffect(() => {
        if (!pad) return
        const i = pad.buttons.findIndex((p, k) => p && !prevButtons.current[k])
        prevButtons.current = pad.buttons
        if (i < 0) return
        const t = setTimeout(() => setLastPress({ b: i, at: Date.now() }), 0)
        return () => clearTimeout(t)
    }, [pad])

    const out = (a: StickAxis) => pad ? shapeAxis(pad.axes[cfg.axes[a].index] ?? 0, cfg.axes[a], cfg, a === 'throttle') : 0
    const axisOpts = Array.from({ length: Math.max(pad?.axes.length ?? 4, 4) }, (_, i) => ({ value: i, label: `Axis ${i}` }))
    const actionLabel = (id: JoyActionId | undefined) => JOY_ACTIONS.find(a => a.id === (id ?? ''))?.label ?? 'Nothing'

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Note>
                Set up a gamepad or USB joystick. This page only previews: nothing you press here is sent to the drone. Settings are saved in this browser for your account. The Fly page does not fly with a gamepad yet; these settings are ready for when it does.
            </Note>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16, alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                    <Panel title="Gamepad" right={pad ? <Chip tone="ok">Connected</Chip> : <Chip tone="off">None found</Chip>}>
                        {!supported ? <Note tone="warn">This browser does not support gamepads. Use a current Chrome, Edge or Firefox.</Note>
                            : pads.length === 0 ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <Gamepad2 size={28} style={{ color: T.muted, flexShrink: 0 }} aria-hidden />
                                    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: T.muted }}>Plug in a gamepad and press any button on it. Browsers only show a gamepad after a button press.</p>
                                </div>
                            ) : (
                                <>
                                    <OptionSelect aria-label="Gamepad" value={pad?.index ?? null} onChange={i => setPadIdx(i)}
                                        options={pads.map(p => ({ value: p.index, label: p.id.replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').trim() || `Gamepad ${p.index}` }))} />
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Use this gamepad for flying</span>
                                        <Toggle label="Use gamepad" value={cfg.enabled} onChange={v => update({ enabled: v, padId: pad?.id ?? cfg.padId })} />
                                    </div>
                                    {pad && pad.mapping !== 'standard' && <Note tone="warn">This device has no standard layout. Use Detect below to find each stick.</Note>}
                                </>
                            )}
                    </Panel>

                    <Panel title="Sticks" hint="which axis drives what"
                        right={<Tip text="Detect: press it, then move that stick fully. The axis that moves the most is picked." />}>
                        {STICK_AXES.map(a => {
                            const c = cfg.axes[a]
                            const raw = pad?.axes[c.index] ?? 0
                            const det = detect?.axis === a
                            return (
                                <div key={a} style={{ display: 'grid', gridTemplateColumns: '72px 1fr auto auto auto', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 14, fontWeight: 600 }}>{AXIS_LABEL[a]}</span>
                                    <Bar v={raw} />
                                    <OptionSelect size="sm" aria-label={`${AXIS_LABEL[a]} axis`} className="w-auto min-w-[96px] text-[13px] data-[size=sm]:h-8"
                                        value={c.index} onChange={i => update({ axes: { ...cfg.axes, [a]: { ...c, index: i } } })} options={axisOpts} />
                                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: T.muted }}>
                                        <Toggle label={`Reverse ${AXIS_LABEL[a]}`} value={c.reverse} onChange={v => update({ axes: { ...cfg.axes, [a]: { ...c, reverse: v } } })} />
                                        Rev
                                    </label>
                                    <Btn onClick={() => setDetect(det ? null : { axis: a, base: pad?.axes ?? [] })} disabled={!pad}
                                        style={det ? { borderColor: T.warn, color: T.warn } : undefined}>{det ? 'Move it' : 'Detect'}</Btn>
                                </div>
                            )
                        })}
                    </Panel>

                    <Panel title="Calibrate" right={<Tip text="Records each stick's real end points and rest position, so a pad that does not quite reach 100 % still gives full deflection." />}>
                        {cal.phase === 'idle' && (
                            <>
                                <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5 }}>Two steps: move every stick to all its ends, then let them rest.</p>
                                <div><Btn kind="primary" disabled={!pad} onClick={() => { ext.current = []; setCal({ phase: 'move' }) }}>Start calibration</Btn></div>
                            </>
                        )}
                        {cal.phase === 'move' && (
                            <>
                                <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>1. Move both sticks around their full circle</p>
                                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Corners included, a few times. Then press Next.</p>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <Btn kind="primary" onClick={() => setCal({ phase: 'center' })}>Next</Btn>
                                    <Btn kind="danger" onClick={() => setCal({ phase: 'idle' })}>Cancel</Btn>
                                </div>
                            </>
                        )}
                        {cal.phase === 'center' && (
                            <>
                                <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>2. Let go of the sticks</p>
                                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>{cfg.throttleMode === 'full' ? 'Leave the sticks at rest.' : 'Let both sticks spring back to centre.'} Then press Save.</p>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <Btn kind="primary" onClick={finishCal}><Check size={15} /> Save</Btn>
                                    <Btn kind="danger" onClick={() => setCal({ phase: 'idle' })}>Cancel</Btn>
                                </div>
                            </>
                        )}
                    </Panel>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                    <Panel title="Preview" hint="what HYRAK would read" right={pad ? <Chip tone="accent">Test only</Chip> : undefined}>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 28, flexWrap: 'wrap' }}>
                            <StickBox label="Left stick" x={out('yaw')} y={cfg.throttleMode === 'full' ? out('throttle') * 2 - 1 : out('throttle')} xl="Yaw" yl="Throttle" />
                            <StickBox label="Right stick" x={out('roll')} y={out('pitch')} xl="Roll" yl="Pitch" />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 52px', gap: '6px 10px', alignItems: 'center', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                            {STICK_AXES.map(a => (
                                <React.Fragment key={a}>
                                    <span style={{ color: T.muted, fontWeight: 600 }}>{AXIS_LABEL[a]}</span>
                                    <Bar v={a === 'throttle' && cfg.throttleMode === 'full' ? out(a) * 2 - 1 : out(a)} />
                                    <span style={{ textAlign: 'right', color: T.text }}>{Math.round(out(a) * 100)} %</span>
                                </React.Fragment>
                            ))}
                        </div>
                    </Panel>

                    <Panel title="Feel" right={<Tip text="Deadzone ignores small movements around centre. Expo makes small movements gentler while keeping full deflection at the ends." />}>
                        <Slider label="Deadzone" value={cfg.deadzone} max={0.3} onChange={v => update({ deadzone: v })} />
                        <Slider label="Expo" value={cfg.expo} max={1} onChange={v => update({ expo: v })} />
                        <Curve deadzone={cfg.deadzone} expo={cfg.expo} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Throttle stick</span>
                            <OptionSelect size="sm" aria-label="Throttle stick" className="w-auto min-w-[200px] text-[13px] data-[size=sm]:h-8" value={cfg.throttleMode}
                                onChange={v => update({ throttleMode: v })}
                                options={[{ value: 'center', label: 'Centre holds altitude' }, { value: 'full', label: 'Bottom is zero' }]} />
                        </div>
                    </Panel>

                    <Panel title="Buttons" hint="press one to test" right={lastPress ? <Chip tone="accent">Button {lastPress.b}: {actionLabel(cfg.buttons[lastPress.b])}</Chip> : undefined}>
                        {!pad ? <p style={{ margin: 0, fontSize: 14, color: T.muted }}>Connect a gamepad to assign its buttons.</p> : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                                {pad.buttons.map((pressed, i) => (
                                    <div key={i} style={{
                                        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 8,
                                        background: pressed ? mix('var(--app-accent)', 12) : 'transparent',
                                        border: `1px solid ${pressed ? T.accent : 'transparent'}`, transition: 'background-color var(--dur-fast) var(--ease-out)',
                                    }}>
                                        <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
                                            background: pressed ? T.accent : T.surface2, color: pressed ? 'var(--app-accent-ink)' : T.text, border: `1px solid ${T.borderStrong}` }}>{i}</span>
                                        <OptionSelect size="sm" aria-label={`Button ${i} action`} className="flex-1 text-[13px] data-[size=sm]:h-8"
                                            value={cfg.buttons[i] ?? ''} onChange={v => update({ buttons: { ...cfg.buttons, [i]: v } })}
                                            options={JOY_ACTIONS.map(a => ({ value: a.id, label: a.label }))} />
                                    </div>
                                ))}
                            </div>
                        )}
                        {pad && Object.values(cfg.buttons).some(v => v === 'arm') && (
                            <Note tone="warn">Arm on a single button is easy to press by accident. Prefer a shoulder button and keep the arm check on the Fly page.</Note>
                        )}
                    </Panel>
                </div>
            </div>
        </div>
    )
}

function Bar({ v }: { v: number }) {
    const p = Math.max(-1, Math.min(1, v))
    return (
        <span style={{ position: 'relative', height: 8, borderRadius: 4, background: T.surface2, border: `1px solid ${T.border}`, minWidth: 60 }}>
            <span style={{ position: 'absolute', top: -2, bottom: -2, left: '50%', width: 1, background: T.borderStrong }} />
            <span style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: T.accent,
                left: p >= 0 ? '50%' : `${50 + p * 50}%`, width: `${Math.abs(p) * 50}%` }} />
        </span>
    )
}

function StickBox({ label, x, y, xl, yl }: { label: string; x: number; y: number; xl: string; yl: string }) {
    const S = 120, r = 46
    return (
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-label={`${label}: ${xl} ${Math.round(x * 100)} %, ${yl} ${Math.round(y * 100)} %`} role="img">
                <rect x={4} y={4} width={S - 8} height={S - 8} rx={14} fill="hsl(var(--app-surface-2))" stroke="hsl(var(--app-border))" />
                <line x1={S / 2} y1={10} x2={S / 2} y2={S - 10} stroke="hsl(var(--app-border))" />
                <line x1={10} y1={S / 2} x2={S - 10} y2={S / 2} stroke="hsl(var(--app-border))" />
                <circle cx={S / 2 + x * r} cy={S / 2 - y * r} r={10} fill="var(--app-accent)" />
            </svg>
            <figcaption style={{ fontSize: 12, color: T.muted }}>{label}: {yl} / {xl}</figcaption>
        </figure>
    )
}

function Slider({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
    return (
        <label style={{ display: 'grid', gridTemplateColumns: '90px 1fr 48px', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
            <input type="range" min={0} max={max} step={0.01} value={value} onChange={e => onChange(Number(e.target.value))}
                style={{ accentColor: 'var(--app-accent)', width: '100%' }} />
            <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(value * 100)} %</span>
        </label>
    )
}

/** The stick-to-output curve with the current deadzone and expo. */
function Curve({ deadzone, expo }: { deadzone: number; expo: number }) {
    const W = 220, H = 110
    const pts = Array.from({ length: 41 }, (_, i) => {
        const x = -1 + i / 20
        const y = shapeAxis(x, { index: 0, reverse: false, min: -1, center: 0, max: 1 }, { deadzone, expo, throttleMode: 'center' }, false)
        return `${(x + 1) / 2 * W},${H / 2 - y * (H / 2 - 4)}`
    }).join(' ')
    return (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 300, height: 'auto', alignSelf: 'center' }} role="img" aria-label="Response curve">
            <rect x={0} y={0} width={W} height={H} rx={8} fill="hsl(var(--app-surface-2))" />
            <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="hsl(var(--app-border))" />
            <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="hsl(var(--app-border))" />
            <line x1={0} y1={H - 4} x2={W} y2={4} stroke="hsl(var(--app-border-strong))" strokeDasharray="3 3" />
            <polyline points={pts} fill="none" stroke="var(--app-accent)" strokeWidth={2.5} strokeLinejoin="round" />
        </svg>
    )
}

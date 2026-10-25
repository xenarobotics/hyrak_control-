'use client'

// Config > Analyze > Vibration: QGroundControl's Vibration page. PX4's
// VIBRATION message, read passively off the session's own link
// (lib/configLive): vibration level per axis against PX4's guidance, and
// how often each accelerometer has clipped (hit the end of its range).

import React, { useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { WifiOff } from 'lucide-react'
import { Chip, Grid, Note, Panel, T } from '@/components/config/kit'
import { useConfigLive } from '@/lib/configLive'
import { LevelBar, LevelScale, levelOf } from './LevelBar'

const WARN = 30, BAD = 60, MAX = 90

export function VibrationPanel() {
    const { data, at } = useConfigLive(true)
    const v = data.VIBRATION
    const connected = useDroneStore(st => st.telemetryStatus === 'connected')
    // Clipping counters run since boot; what matters is whether they grow
    // while this page is open (a reboot resets the baseline).
    const [base, setBase] = useState<number[] | null>(null)
    const counts = v ? [v.clipping_0 ?? 0, v.clipping_1 ?? 0, v.clipping_2 ?? 0] : null
    if (counts && (!base || counts.some((n, i) => n < base[i]))) setBase(counts)
    const grew = counts && base ? counts.map((n, i) => Math.max(0, n - base[i])) : [0, 0, 0]

    if (!connected) {
        return (
            <Note icon={<WifiOff size={15} style={{ color: T.muted, flexShrink: 0, marginTop: 2 }} />}>
                <b>No drone connected.</b> Connect one from the Fly tab to read its vibration levels.
            </Note>
        )
    }
    const worst = v ? Math.max(v.vibration_x ?? 0, v.vibration_y ?? 0, v.vibration_z ?? 0) : null
    const lvl = levelOf(worst, WARN, BAD)
    const clips = v ? [v.clipping_0, v.clipping_1, v.clipping_2] : []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {at > 0 && !v && (
                <Note>This drone does not send the VIBRATION message. PX4 sends it by default on most links; check the MAVLink Inspector tab to see what arrives.</Note>
            )}
            <Grid min={340}>
                <Panel title="Vibration levels" hint="m/s², what PX4 measures on the accelerometer"
                    right={v ? <Chip tone={lvl === 'ok' ? 'ok' : lvl === 'warn' ? 'warn' : 'danger'}>{lvl === 'ok' ? 'Fine to fly' : lvl === 'warn' ? 'High, check mounting' : 'Too high'}</Chip> : undefined}>
                    <LevelBar label="X (forward)" value={v?.vibration_x} max={MAX} warnAt={WARN} badAt={BAD} unit="m/s²" />
                    <LevelBar label="Y (right)" value={v?.vibration_y} max={MAX} warnAt={WARN} badAt={BAD} unit="m/s²" />
                    <LevelBar label="Z (down)" value={v?.vibration_z} max={MAX} warnAt={WARN} badAt={BAD} unit="m/s²" />
                    <LevelScale max={MAX} warnAt={WARN} badAt={BAD} unit="m/s²" />
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Below {WARN} is good. {WARN} to {BAD} can work but hurts position hold and altitude. Above {BAD} the estimator can fail: fix it before flying.
                        Read these while hovering, not on the ground with motors off.
                    </p>
                </Panel>
                <Panel title="Accelerometer clipping" hint="times a reading hit the end of the sensor's range">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                        {[0, 1, 2].map(i => {
                            const n = clips[i]
                            const bad = grew[i] > 0
                            return (
                                <div key={i} style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${bad ? 'color-mix(in srgb, var(--app-danger) 40%, transparent)' : T.border}`, background: T.surface2 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: T.muted }}>Accel {i + 1}</div>
                                    <div style={{ fontSize: 22, fontWeight: 700, color: n == null ? T.muted : bad ? T.danger : T.text, fontVariantNumeric: 'tabular-nums' }}>{n == null ? '-' : n.toLocaleString()}</div>
                                    <div style={{ fontSize: 12, color: bad ? T.danger : T.muted, fontWeight: bad ? 700 : 500 }}>{n == null ? 'No data' : bad ? `+${grew[i]} while open` : 'Not growing'}</div>
                                </div>
                            )
                        })}
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Counted since the flight controller started. A count that grows in flight means vibration is saturating the sensor: balance the propellers and soften the flight controller mount.
                    </p>
                </Panel>
            </Grid>
        </div>
    )
}

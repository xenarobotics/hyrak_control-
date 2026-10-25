'use client'

// Config > Payload. PX4's gripper (payload deliverer): whether it is set up,
// which output drives it, its timing, and a bench test that opens or closes
// it. The test is a MAV_CMD_DO_GRIPPER sent only to a connected, disarmed
// aircraft on the ground, after a confirmation, and the page shows the
// aircraft's acknowledgement (backend app/telemetry/payload_cmd.py). Drop
// hooks, winches and lights HYRAK drives itself are on Attachments.

import React from 'react'
import { useVehicleParams } from '@/lib/vehicleParams'
import { Chip, Grid, Note, Panel, ParamSourceBar, ReloadButton, T, type ParamSpec } from '@/components/config/kit'
import { ConfirmCommand, SpecRows, WriteLog } from '@/components/config/setupKit'

/** PX4 output function number for "Gripper". */
const FN_GRIPPER = 430

const GRIPPER: ParamSpec[] = [
    { key: 'PD_GRIPPER_EN', label: 'Gripper enabled', bool: true, def: 0, tip: 'PX4 1.14 and older: turns the payload deliverer\'s gripper on. Needs a reboot.' },
    { key: 'PD_GRIPPER_TYPE', label: 'Gripper type', options: [{ value: -1, label: 'None' }, { value: 0, label: 'Servo' }], def: 0, tip: 'Servo: an output set to "Gripper" on the Actuators page drives it. Needs a reboot.' },
    { key: 'PD_GRIPPER_TO', label: 'Time to open or close', unit: 's', def: 1, min: 0, max: 30, decimals: 1, tip: 'With no feedback sensor PX4 waits this long, then reports the gripper as open or closed.' },
]

export function PayloadSetup() {
    const vp = useVehicleParams()
    const outputs = vp.params ? Object.entries(vp.params).filter(([k, p]) => /_FUNC\d+$/.test(k) && p.value === FN_GRIPPER).map(([k]) => k) : []
    const hasModule = !vp.ready || vp.has('PD_GRIPPER_TYPE') || vp.has('PD_GRIPPER_EN')
    const enabled = !vp.ready || ((vp.get('PD_GRIPPER_TYPE') ?? -1) >= 0 && (vp.get('PD_GRIPPER_EN') ?? 1) !== 0)
    const timeout = vp.get('PD_GRIPPER_TO') ?? 1
    const why = !vp.ready ? null : !hasModule ? 'This firmware has no gripper support' : !enabled ? 'Enable the gripper first' : outputs.length === 0 ? 'Set an output to Gripper on the Actuators page first' : null
    const body = (verb: string) => (
        <>
            <Note tone="warn">The gripper will {verb}. Keep fingers clear and hold or remove the payload so it cannot drop.</Note>
            <p style={{ margin: 0, fontSize: 14, color: T.text, lineHeight: 1.5 }}>
                HYRAK sends MAV_CMD_DO_GRIPPER ({verb}) to the aircraft. It is refused unless the aircraft is disarmed and on the ground.
            </p>
        </>
    )
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}><ParamSourceBar what="payload settings" /></div>
                <ReloadButton />
            </div>
            <Grid min={360}>
                <Panel title="Gripper" hint="PX4 payload deliverer"
                    right={vp.ready ? <Chip tone={why ? 'warn' : 'ok'}>{why ? 'Not ready' : 'Ready'}</Chip> : undefined}>
                    {!hasModule ? <Note>This firmware build has no payload deliverer (PD_GRIPPER_* missing).</Note> : <SpecRows specs={GRIPPER} />}
                    {vp.ready && hasModule && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: T.text, flex: '1 1 160px' }}>Output</span>
                            {outputs.length ? outputs.map(o => <Chip key={o} tone="ok">{o.replace(/_FUNC(\d+)$/, ' $1')}</Chip>) : <Chip tone="warn">No output set to Gripper</Chip>}
                        </div>
                    )}
                </Panel>
                <Panel title="Test the gripper" hint="on the bench, disarmed">
                    <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                        Opens or closes the gripper once. PX4 reports done after {timeout} s (the time to open or close).
                    </p>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <ConfirmCommand label="Open" title="Open the gripper" body={body('open')} confirmLabel="Open gripper"
                            action="gripper_test" data={{ gripper: 'open', timeout_s: timeout }} disabledWhy={why} timeoutMs={(timeout + 6) * 1000} />
                        <ConfirmCommand label="Close" title="Close the gripper" body={body('close')} confirmLabel="Close gripper"
                            action="gripper_test" data={{ gripper: 'close', timeout_s: timeout }} disabledWhy={why} timeoutMs={(timeout + 6) * 1000} />
                    </div>
                </Panel>
            </Grid>
            <Note>Drop hooks, winches, lights and speakers that HYRAK drives itself are set up on the Attachments page.</Note>
            <WriteLog />
        </div>
    )
}

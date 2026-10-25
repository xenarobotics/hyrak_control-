'use client'

// Config > Radio & RC > Channels: QGroundControl's Spektrum Bind. Sends
// MAV_CMD_START_RX_PAIR (Spektrum, DSM2 / DSMX / DSMX8) to a connected,
// disarmed aircraft after a confirmation; PX4 power-cycles the satellite
// receiver into bind mode on boards that support it, and its answer is shown
// (backend app/telemetry/payload_cmd.py).

import React, { useState } from 'react'
import { Note, Panel, T, Tip } from '@/components/config/kit'
import { Segmented } from '@/components/ui/segmented'
import { ConfirmCommand } from '@/components/config/setupKit'

type Mode = 'dsm2' | 'dsmx' | 'dsmx8'

export function SpektrumBind() {
    const [mode, setMode] = useState<Mode>('dsmx')
    return (
        <Panel title="Spektrum bind" right={<Tip text="Puts a Spektrum satellite receiver on the flight controller into bind mode (MAV_CMD_START_RX_PAIR). Only boards that can power-cycle the receiver support it; PX4 answers 'unsupported' otherwise." />}>
            <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5 }}>
                Pick the protocol your transmitter uses, start, then turn the transmitter on in bind mode within a few seconds.
            </p>
            <Segmented<Mode> ariaLabel="Spektrum protocol" value={mode} onChange={setMode} options={[
                { value: 'dsm2', label: 'DSM2' }, { value: 'dsmx', label: 'DSMX' }, { value: 'dsmx8', label: 'DSMX 8+ channels' },
            ]} />
            <div>
                <ConfirmCommand label="Start bind" title="Bind a Spektrum receiver" confirmLabel="Start bind" action="rx_pair" data={{ mode }}
                    body={<>
                        <Note>The receiver loses its current binding. The drone must stay disarmed until the transmitter is bound again.</Note>
                        <p style={{ margin: 0, fontSize: 14, color: T.text, lineHeight: 1.5 }}>Protocol: {mode === 'dsmx8' ? 'DSMX, 8 or more channels' : mode.toUpperCase()}.</p>
                    </>} />
            </div>
        </Panel>
    )
}

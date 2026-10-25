'use client'

// Config > Analyze: QGroundControl's Analyze tools. Live views of the
// connected drone (MAVLink Inspector, Vibration, Health) and tools that
// work on a flight log saved from Config > Logs (Log viewer, GeoTag).
// Everything here only reads; the one thing that can reach the drone is the
// inspector's opt-in "Faster updates", which the server allows only for a
// session that may fly it.

import React, { useState } from 'react'
import { SubTabs } from '@/components/config/kit'
import { MavlinkInspector } from './MavlinkInspector'
import { VibrationPanel } from './VibrationPanel'
import { HealthPanel } from './HealthPanel'
import { LogViewer } from './LogViewer'
import { GeoTag } from './GeoTag'

type Tab = 'inspector' | 'vibration' | 'health' | 'log' | 'geotag'

const TABS: { id: Tab; label: string }[] = [
    { id: 'inspector', label: 'MAVLink Inspector' },
    { id: 'vibration', label: 'Vibration' },
    { id: 'health', label: 'Health' },
    { id: 'log', label: 'Log viewer' },
    { id: 'geotag', label: 'GeoTag' },
]

export function AnalyzeSetup() {
    const [tab, setTab] = useState<Tab>('inspector')
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SubTabs label="Analyze tools" value={tab} onChange={setTab} tabs={TABS} />
            {/* Log tools keep their files while you look at live views. */}
            <div hidden={tab !== 'log'}><LogViewer /></div>
            <div hidden={tab !== 'geotag'}><GeoTag /></div>
            {tab === 'inspector' && <MavlinkInspector />}
            {tab === 'vibration' && <VibrationPanel />}
            {tab === 'health' && <HealthPanel />}
        </div>
    )
}

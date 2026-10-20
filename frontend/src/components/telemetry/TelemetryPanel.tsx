'use client'

import { useState, useMemo } from 'react'
import { useDroneStore } from '@/store/drone'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
    Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from '@/components/controls/flightStyles'

interface TelemetryField {
    key: string
    label: string
    value: string
    unit?: string
}

interface TelemetryGroup {
    name: string
    fields: TelemetryField[]
}

function fmt(v: unknown, decimals = 2): string {
    if (v === null || v === undefined) return '-'
    if (typeof v === 'boolean') return v ? 'Yes' : 'No'
    if (typeof v === 'number') return isNaN(v) ? '-' : v.toFixed(decimals)
    return String(v)
}

export function TelemetryPanel() {
    const telemetry = useDroneStore(s => s.telemetry)
    const [search, setSearch] = useState('')
    const [openGroups, setOpenGroups] = useState<Set<string>>(
        new Set(['Attitude', 'Position', 'Battery', 'Flight'])
    )

    const groups: TelemetryGroup[] = useMemo(() => {
        if (!telemetry) return []
        return [
            {
                name: 'Flight',
                fields: [
                    { key: 'mode', label: 'Mode', value: telemetry.flight_mode.mode },
                    { key: 'armed', label: 'Armed', value: telemetry.flight_mode.is_armed ? 'Yes' : 'No' },
                    { key: 'in_air', label: 'In air', value: telemetry.flight_mode.is_in_air ? 'Yes' : 'No' },
                    { key: 'heading', label: 'Heading', value: fmt(telemetry.heading_deg, 1), unit: '°' },
                    { key: 'groundspeed', label: 'Groundspeed', value: fmt(telemetry.groundspeed_m_s, 2), unit: 'm/s' },
                    { key: 'home_dist', label: 'Home distance', value: fmt(telemetry.home_distance_m, 1), unit: 'm' },
                ],
            },
            {
                name: 'Attitude',
                fields: [
                    { key: 'roll', label: 'Roll', value: fmt(telemetry.attitude.roll_deg, 2), unit: '°' },
                    { key: 'pitch', label: 'Pitch', value: fmt(telemetry.attitude.pitch_deg, 2), unit: '°' },
                    { key: 'yaw', label: 'Yaw', value: fmt(telemetry.attitude.yaw_deg, 2), unit: '°' },
                    { key: 'rollspeed', label: 'Roll rate', value: fmt(telemetry.attitude.rollspeed, 3), unit: 'rad/s' },
                    { key: 'pitchspeed', label: 'Pitch rate', value: fmt(telemetry.attitude.pitchspeed, 3), unit: 'rad/s' },
                    { key: 'yawspeed', label: 'Yaw rate', value: fmt(telemetry.attitude.yawspeed, 3), unit: 'rad/s' },
                ],
            },
            {
                name: 'Position',
                fields: [
                    { key: 'lat', label: 'Latitude', value: fmt(telemetry.position.latitude_deg, 6), unit: '°' },
                    { key: 'lon', label: 'Longitude', value: fmt(telemetry.position.longitude_deg, 6), unit: '°' },
                    { key: 'alt_rel', label: 'Alt (relative)', value: fmt(telemetry.position.relative_altitude_m, 2), unit: 'm' },
                    { key: 'alt_abs', label: 'Alt (absolute)', value: fmt(telemetry.position.absolute_altitude_m, 2), unit: 'm' },
                ],
            },
            {
                name: 'Velocity',
                fields: [
                    { key: 'vel_n', label: 'North', value: fmt(telemetry.velocity.north_m_s, 2), unit: 'm/s' },
                    { key: 'vel_e', label: 'East', value: fmt(telemetry.velocity.east_m_s, 2), unit: 'm/s' },
                    { key: 'vel_d', label: 'Down', value: fmt(telemetry.velocity.down_m_s, 2), unit: 'm/s' },
                ],
            },
            {
                name: 'Battery',
                fields: [
                    { key: 'bat_pct', label: 'Remaining', value: fmt(telemetry.battery.remaining_percent, 1), unit: '%' },
                    { key: 'bat_v', label: 'Voltage', value: fmt(telemetry.battery.voltage_v, 2), unit: 'V' },
                ],
            },
            {
                name: 'GPS',
                fields: [
                    { key: 'gps_fix', label: 'Fix type', value: fmt(telemetry.gps.fix_type, 0) },
                    { key: 'gps_sats', label: 'Satellites', value: fmt(telemetry.gps.satellites_visible, 0) },
                ],
            },
        ]
    }, [telemetry])

    const filtered = useMemo(() => {
        if (!search) return groups
        const q = search.toLowerCase()
        return groups
            .map(g => ({
                ...g,
                fields: g.fields.filter(
                    f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)
                ),
            }))
            .filter(g => g.fields.length > 0)
    }, [groups, search])

    const toggleGroup = (name: string) => {
        setOpenGroups(prev => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name); else next.add(name)
            return next
        })
    }

    if (!telemetry) {
        return (
            <div className="flex items-center justify-center h-24 text-app-text-muted text-[13px]">
                No telemetry yet. Connect a drone.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2 h-full">
            {/* Search */}
            <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-app-text-muted" />
                <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search fields"
                    aria-label="Search telemetry fields"
                    className="h-8 pl-8 text-[14px] bg-app-surface border-app-border-strong rounded-md"
                />
            </div>

            {/* Groups */}
            <ScrollArea className="flex-1">
                <div className="space-y-1 pr-2">
                    {filtered.map(group => (
                        <Collapsible
                            key={group.name}
                            open={openGroups.has(group.name)}
                            onOpenChange={() => toggleGroup(group.name)}
                        >
                            <CollapsibleTrigger className={cn('flex items-center justify-between w-full min-h-8 px-2 py-1.5 rounded-md hover:bg-app-surface-2 transition-colors duration-[var(--dur-fast)] group', FOCUS)}>
                                <span className="text-[13px] font-semibold text-app-text-muted group-hover:text-app-text">
                                    {group.name}
                                </span>
                                <ChevronDown
                                    size={14}
                                    className={cn(
                                        'text-app-text-muted transition-transform duration-[var(--dur)]',
                                        openGroups.has(group.name) && 'rotate-180'
                                    )}
                                />
                            </CollapsibleTrigger>

                            <CollapsibleContent>
                                <div className="pb-1">
                                    {group.fields.map(field => (
                                        <div
                                            key={field.key}
                                            className="flex justify-between items-center gap-3 px-2 py-1 rounded-md hover:bg-app-surface-2"
                                        >
                                            <span className="text-[13px] text-app-text-muted">{field.label}</span>
                                            <span className="text-[14px] font-semibold text-app-text tabular-nums">
                                                {field.value}
                                                {field.unit && (
                                                    <span className="text-app-text-muted font-normal ml-1 text-[12px]">{field.unit}</span>
                                                )}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </CollapsibleContent>
                        </Collapsible>
                    ))}
                </div>
            </ScrollArea>
        </div>
    )
}
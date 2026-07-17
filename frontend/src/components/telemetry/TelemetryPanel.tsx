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
    if (v === null || v === undefined) return '—'
    if (typeof v === 'boolean') return v ? 'YES' : 'NO'
    if (typeof v === 'number') return isNaN(v) ? '—' : v.toFixed(decimals)
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
                    { key: 'armed', label: 'Armed', value: telemetry.flight_mode.is_armed ? 'YES' : 'NO' },
                    { key: 'in_air', label: 'In Air', value: telemetry.flight_mode.is_in_air ? 'YES' : 'NO' },
                    { key: 'heading', label: 'Heading', value: fmt(telemetry.heading_deg, 1), unit: '°' },
                    { key: 'groundspeed', label: 'Groundspeed', value: fmt(telemetry.groundspeed_m_s, 2), unit: 'm/s' },
                    { key: 'home_dist', label: 'Home Dist', value: fmt(telemetry.home_distance_m, 1), unit: 'm' },
                ],
            },
            {
                name: 'Attitude',
                fields: [
                    { key: 'roll', label: 'Roll', value: fmt(telemetry.attitude.roll_deg, 2), unit: '°' },
                    { key: 'pitch', label: 'Pitch', value: fmt(telemetry.attitude.pitch_deg, 2), unit: '°' },
                    { key: 'yaw', label: 'Yaw', value: fmt(telemetry.attitude.yaw_deg, 2), unit: '°' },
                    { key: 'rollspeed', label: 'Roll Rate', value: fmt(telemetry.attitude.rollspeed, 3), unit: 'rad/s' },
                    { key: 'pitchspeed', label: 'Pitch Rate', value: fmt(telemetry.attitude.pitchspeed, 3), unit: 'rad/s' },
                    { key: 'yawspeed', label: 'Yaw Rate', value: fmt(telemetry.attitude.yawspeed, 3), unit: 'rad/s' },
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
                    { key: 'gps_fix', label: 'Fix Type', value: fmt(telemetry.gps.fix_type, 0) },
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
            next.has(name) ? next.delete(name) : next.add(name)
            return next
        })
    }

    if (!telemetry) {
        return (
            <div className="flex items-center justify-center h-32 text-zinc-600 text-xs font-mono">
                NO TELEMETRY
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2 h-full">
            {/* Search */}
            <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search fields..."
                    className="h-7 pl-7 text-xs font-mono bg-zinc-900 border-zinc-700"
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
                            <CollapsibleTrigger className="flex items-center justify-between w-full px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors group">
                                <span className="text-xs font-mono font-medium text-zinc-400 group-hover:text-zinc-200">
                                    {group.name.toUpperCase()}
                                </span>
                                <ChevronDown
                                    size={12}
                                    className={cn(
                                        'text-zinc-600 transition-transform',
                                        openGroups.has(group.name) && 'rotate-180'
                                    )}
                                />
                            </CollapsibleTrigger>

                            <CollapsibleContent>
                                <div className="pb-1">
                                    {group.fields.map(field => (
                                        <div
                                            key={field.key}
                                            className="flex justify-between items-center px-2 py-1 rounded hover:bg-zinc-800/50"
                                        >
                                            <span className="text-xs text-zinc-500">{field.label}</span>
                                            <span className="text-xs font-mono text-zinc-200 tabular-nums">
                                                {field.value}
                                                {field.unit && (
                                                    <span className="text-zinc-600 ml-0.5 text-[10px]">{field.unit}</span>
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
'use client'

import { useMemo, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Search, Timer } from 'lucide-react'

// Icon mapping for common COCO classes
const CLASS_EMOJI: Record<string, string> = {
    person: '🧍', bicycle: '🚲', car: '🚗', motorcycle: '🏍',
    airplane: '✈️', bus: '🚌', train: '🚆', truck: '🚛',
    boat: '⛵', 'traffic light': '🚦', 'fire hydrant': '🚒',
    'stop sign': '🛑', bench: '🪑', bird: '🐦', cat: '🐱',
    dog: '🐶', horse: '🐴', cow: '🐄', elephant: '🐘',
    backpack: '🎒', umbrella: '☂️', handbag: '👜',
    bottle: '🍾', cup: '☕', fork: '🍴', knife: '🔪',
    bowl: '🥣', banana: '🍌', apple: '🍎', pizza: '🍕',
    chair: '🪑', couch: '🛋️', laptop: '💻', tv: '📺',
    'cell phone': '📱', book: '📖', clock: '🕐',
}

function ObjectCard({ name, count }: { name: string; count: number }) {
    const emoji = CLASS_EMOJI[name] ?? '📦'
    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 4,
            padding: '12px 8px',
            background: 'hsl(var(--app-surface-2))',
            border: '1px solid hsl(var(--app-border))',
            borderRadius: 10, textAlign: 'center',
        }}>
            <span style={{ fontSize: 22 }}>{emoji}</span>
            <span style={{
                fontSize: 20, fontWeight: 700,
                fontFamily: 'var(--font-geist-mono)',
                color: 'hsl(var(--app-text))',
            }}>
                {count}
            </span>
            <span style={{
                fontSize: 10, color: 'hsl(var(--app-text-muted))',
                textTransform: 'capitalize',
            }}>
                {name}
            </span>
        </div>
    )
}

export function ObjectDetectionPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const [search, setSearch] = useState('')

    const objects = useMemo(() => {
        if (!cvResults?.objects) return []
        return Object.entries(cvResults.objects)
            .map(([name, count]) => ({ name, count }))
            .filter(o => o.name.toLowerCase().includes(search.toLowerCase()))
            .sort((a, b) => b.count - a.count)
    }, [cvResults, search])

    const inferenceMs = cvResults?.analysis_time_ms ?? 0

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>

            {/* Stats row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    <Timer size={12} />
                    {inferenceMs.toFixed(0)}ms inference
                </div>
                <div style={{
                    padding: '4px 10px',
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    {cvResults?.total_count ?? 0} detected
                </div>
                {(cvResults?.person_count ?? 0) > 0 && (
                    <div style={{
                        padding: '4px 10px',
                        background: '#E6F1FB',
                        border: '1px solid #85B7EB',
                        borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
                        color: '#185FA5',
                    }}>
                        🧍 {cvResults?.person_count} person
                    </div>
                )}
            </div>

            {/* Search */}
            <div style={{ position: 'relative' }}>
                <Search size={12} style={{
                    position: 'absolute', left: 10, top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'hsl(var(--app-text-muted))',
                }} />
                <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Filter objects..."
                    className="h-8 text-xs font-mono"
                    style={{ paddingLeft: 28 }}
                />
            </div>

            {/* Grid */}
            <ScrollArea style={{ flex: 1 }}>
                {objects.length > 0 ? (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                        gap: 8, paddingRight: 4,
                    }}>
                        {objects.map(o => (
                            <ObjectCard key={o.name} name={o.name} count={o.count} />
                        ))}
                    </div>
                ) : (
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        height: 120, color: 'hsl(var(--app-text-muted))',
                        fontSize: 12, fontFamily: 'monospace',
                    }}>
                        {cvResults ? 'No objects detected' : 'Start stream to detect objects'}
                    </div>
                )}
            </ScrollArea>
        </div>
    )
}
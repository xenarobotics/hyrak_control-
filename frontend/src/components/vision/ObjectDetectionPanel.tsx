'use client'

import { useMemo, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useStableCounts, useEasedNumber } from '@/lib/panelSmoothing'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'
import { TILE, READOUT, SECONDARY, MUTED, chip, FOCUS, NUM } from './panelStyle'

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

function ObjectCard(
    { name, count, stale }: { name: string; count: number; stale?: boolean },
) {
    const emoji = CLASS_EMOJI[name] ?? '📦'
    return (
        <div style={{
            ...TILE,
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 4,
            padding: '12px 8px', textAlign: 'center',
            // Held past its last sighting: dimmed rather than removed, so the
            // grid keeps its shape while a detection flickers.
            opacity: stale ? 0.6 : 1,
            transition: 'opacity var(--dur) var(--ease-out)',
        }}>
            <span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden>{emoji}</span>
            <span style={READOUT}>{count}</span>
            <span style={{ ...SECONDARY, textTransform: 'capitalize', overflowWrap: 'anywhere' }}>
                {name}
            </span>
        </div>
    )
}

export function ObjectDetectionPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const [search, setSearch] = useState('')

    // Membership is held briefly so a detection flickering on the confidence
    // threshold does not make cards pop in and out of the grid; the filter is
    // applied after, so typing still responds instantly.
    const stable = useStableCounts(cvResults?.objects)
    const objects = useMemo(
        () => stable.filter(o => o.name.toLowerCase().includes(search.toLowerCase())),
        [stable, search],
    )

    // Timing is noisy by nature - a median ignores the occasional outlier
    // instead of dragging the readout around with it.
    const totalCount = useEasedNumber(cvResults?.total_count ?? 0)
    const personCount = useEasedNumber(cvResults?.person_count ?? 0)

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>

            {/* Stats row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={chip('muted')}>{totalCount} found</span>
                {personCount > 0 && (
                    <span style={chip('accent')}>
                        {personCount} {personCount === 1 ? 'person' : 'people'}
                    </span>
                )}
            </div>

            {/* Search */}
            <div style={{ position: 'relative' }}>
                <Search size={14} aria-hidden style={{
                    position: 'absolute', left: 10, top: '50%',
                    transform: 'translateY(-50%)',
                    color: MUTED,
                }} />
                <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Filter"
                    aria-label="Filter objects"
                    className={`h-8 text-[13px] ${FOCUS}`}
                    style={{ paddingLeft: 30 }}
                />
            </div>

            {/* Grid */}
            <ScrollArea style={{ flex: 1 }}>
                {objects.length > 0 ? (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
                        gap: 8, paddingRight: 4,
                    }}>
                        {objects.map(o => (
                            <ObjectCard key={o.name} name={o.name} count={o.count} stale={o.stale} />
                        ))}
                    </div>
                ) : (
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        height: 120, ...SECONDARY, ...NUM,
                    }}>
                        {cvResults ? 'Nothing found yet' : 'Waiting for video'}
                    </div>
                )}
            </ScrollArea>
        </div>
    )
}
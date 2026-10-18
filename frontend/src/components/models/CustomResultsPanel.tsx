'use client'

// Results of a running custom model, compact: what it finds with counts
// (detect), or its top 3 answers (classify), plus the alert rule's hits.
// The boxes themselves are drawn by CvOverlayCanvas, as for Objects.

import { useEffect, useMemo, useState } from 'react'
import { BellRing } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useStableCounts } from '@/lib/panelSmoothing'
import { customIdOf, type AlertRule, type CustomModel } from '@/lib/models'
import { useModelsStore } from '@/store/models'
import type { AlertHit, CVResult } from '@/types/vision'
import { cn } from '@/lib/utils'
import { css as s } from './ui'

const MAX_HITS = 6

function countsOf(r: CVResult | null): Record<string, number> | undefined {
    if (!r) return undefined
    if (r.objects) return r.objects
    if (!r.detections) return undefined
    const out: Record<string, number> = {}
    for (const d of r.detections) out[d.name] = (out[d.name] ?? 0) + 1
    return out
}

/** The frame's alert hits: the server's when it sends them, else the rule
 *  applied here to the detections' scores. */
function hitsOf(r: CVResult | null, rule: AlertRule | null): AlertHit[] {
    if (!r) return []
    if (r.alert_hits) return r.alert_hits
    if (!rule) return []
    const hits: AlertHit[] = []
    for (const d of r.detections ?? []) {
        if (d.name === rule.label && (d.score ?? 0) >= rule.min_score) hits.push({ label: d.name, score: d.score ?? 0 })
    }
    for (const p of r.predictions ?? []) {
        if (p.name === rule.label && p.score >= rule.min_score) hits.push({ label: p.name, score: p.score })
    }
    return hits
}

export function CustomResultsPanel({ mode }: { mode: string }) {
    const id = customIdOf(mode)
    const model = useModelsStore(st => st.workspace.find(m => m.id === id)
        ?? (st.hyrak.find(m => (m as CustomModel).id === id) as CustomModel | undefined) ?? null)
    const rule = model?.alert ?? null
    const cv = useDroneStore(st => st.cvResults)
    const stable = useStableCounts(countsOf(cv))
    const top = useMemo(() => [...(cv?.predictions ?? [])].sort((a, b) => b.score - a.score).slice(0, 3), [cv])
    const classify = model?.task === 'classify' || (!!cv?.predictions && !cv?.detections)

    // A short log of alert hits: one entry per second at most, newest first.
    const [log, setLog] = useState<{ label: string; score: number; at: number }[]>([])
    useEffect(() => useDroneStore.subscribe(st => {
        const hits = hitsOf(st.cvResults, rule)
        if (!hits.length) return
        const best = hits.reduce((a, b) => (b.score > a.score ? b : a))
        const now = Date.now()
        setLog(prev => (prev[0] && now - prev[0].at < 1000 && prev[0].label === best.label)
            ? prev : [{ label: best.label, score: best.score, at: now }, ...prev].slice(0, MAX_HITS))
    }), [rule])
    const seenNow = hitsOf(cv, rule).length > 0

    return (
        <div className={s.results}>
            {classify ? (
                <div className={s.section}>
                    <span className={s.label}>Top answers</span>
                    {top.length === 0 && <p className={s.muted}>Waiting for the first frame...</p>}
                    {top.map((p, i) => (
                        <div key={p.name} className={cn(s.inset, s.resRow)}>
                            <span style={{ fontWeight: i === 0 ? 650 : 400 }}>{p.name}</span>
                            <span className={s.mono}>{Math.round(p.score * 100)}%</span>
                            <span className={s.scoreBar}><i style={{ width: `${p.score * 100}%` }} /></span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className={s.section}>
                    <span className={s.label}>In view now</span>
                    {stable.length === 0 && <p className={s.muted}>{cv ? 'Nothing found in this frame.' : 'Waiting for the first frame...'}</p>}
                    {stable.map(o => (
                        <div key={o.name} className={cn(s.inset, s.resRow)} style={{ opacity: o.stale ? 0.5 : 1 }}>
                            <span style={{ textTransform: 'capitalize' }}>{o.name}</span>
                            <span className={s.resCount}>{o.count}</span>
                        </div>
                    ))}
                </div>
            )}

            {rule && (
                <div className={s.section}>
                    <span className={s.label}>Alert</span>
                    <p className={s.help}>When {rule.label} is seen above {Math.round(rule.min_score * 100)}% sure.</p>
                    {seenNow && (
                        <div className={s.hit} role="alert">
                            <BellRing size={14} aria-hidden style={{ color: 'var(--cm-warn)' }} />
                            <strong>{rule.label} seen now</strong>
                        </div>
                    )}
                    {log.length === 0 && !seenNow && <p className={s.muted}>No alerts yet.</p>}
                    {log.length > 0 && (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {log.map(h => (
                                <li key={h.at} className={s.help} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                    <span>{h.label} ({Math.round(h.score * 100)}%)</span>
                                    <span className={s.mono}>{new Date(h.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}

'use client'

// Results of a running custom model, compact: the active settings as chips
// (each opens that setting in the model's panel), what it finds with counts
// now and over the run (detect), or its answers (classify: every class when
// there are 10 or fewer, else the top 5, plus how often each was the top
// answer), plus the rules' live progress (RulesLive), or for a model with
// only the old single alert, its hits.
// The boxes themselves are drawn by CvOverlayCanvas, as for Objects.

import { useEffect, useMemo, useState } from 'react'
import { BellRing } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { useStableCounts } from '@/lib/panelSmoothing'
import { customIdOf, type AlertRule, type CustomModel } from '@/lib/models'
import { useModelsStore } from '@/store/models'
import type { AlertHit, CVResult } from '@/types/vision'
import { cn } from '@/lib/utils'
import { ModelDetailPanel } from './ModelDetailPanel'
import { SettingsChips, type SettingFocus } from './ModelSettings'
import { RulesLive } from './RulesLive'
import { useModelAccess } from './useModelLibrary'
import { css as s } from './ui'

/** The custom model fields of cv_results (runtime analyzer.py). */
type CustomCv = CVResult & {
    tiling?: string | null
    infer_ms?: number | null
    run_frames?: number
    run_counts?: Record<string, { peak: number; frames: number }>
}

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
    // The no-code rules; a model with only the old single alert keeps the
    // Alert block below until its rules are saved once.
    const rules = Array.isArray(model?.rules) ? model!.rules : []
    const rule = rules.length === 0 ? model?.alert ?? null : null
    const cv = useDroneStore(st => st.cvResults) as CustomCv | null
    const access = useModelAccess()
    const ours = useModelsStore(st => !!id && st.workspace.some(m => m.id === id))
    const [setting, setSetting] = useState<{ focus: SettingFocus; open: boolean; n: number } | null>(null)
    const runCounts = cv?.run_counts
    const runFrames = cv?.run_frames ?? 0
    const stable = useStableCounts(countsOf(cv))
    const top = useMemo(() => {
        const all = [...(cv?.predictions ?? [])].sort((a, b) => b.score - a.score)
        return all.length <= 10 ? all : all.slice(0, 5)
    }, [cv])
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
            {model && (
                <SettingsChips model={model} liveTiling={cv?.tiling ?? null} inferMs={cv?.infer_ms ?? null}
                    onOpen={focus => setSetting(p => ({ focus, open: true, n: (p?.n ?? 0) + 1 }))} />
            )}
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
                    {runCounts && runFrames > 0 && (
                        <>
                            <span className={s.label} style={{ marginTop: 6 }}>Top answer over this run</span>
                            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {Object.entries(runCounts).sort((a, b) => b[1].frames - a[1].frames).slice(0, 5).map(([name, t]) => (
                                    <li key={name} className={s.help} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                        <span>{name}</span>
                                        <span className={s.mono}>{Math.round((t.frames / runFrames) * 100)}% of frames</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            ) : (
                <CountsTable now={stable} run={runCounts} waiting={!cv} />
            )}

            {rules.length > 0 && <RulesLive rules={rules} cv={cv} />}

            {rule && rules.length === 0 && (
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

            {model && setting && (
                <ModelDetailPanel key={`${model.id}:${setting.n}`} modelId={model.id} open={setting.open}
                    onOpenChange={o => setSetting(p => p && { ...p, open: o })}
                    focus={setting.focus}
                    editable={access.canManage && ours} canPublish={false}
                    canRun={false} running onRun={() => undefined}
                    onDeleted={() => setSetting(null)} />
            )}
        </div>
    )
}

/** Per class: how many are in view now (smoothed) and the most seen at
 *  once since the model started. */
function CountsTable({ now, run, waiting }: {
    now: { name: string; count: number; stale: boolean }[]
    run?: Record<string, { peak: number; frames: number }>
    waiting: boolean
}) {
    const rows = useMemo(() => {
        const byName = new Map(now.map(o => [o.name, o]))
        const names = new Set([...now.map(o => o.name), ...Object.keys(run ?? {})])
        return [...names].map(name => ({
            name, now: byName.get(name)?.count ?? 0, stale: byName.get(name)?.stale ?? true,
            peak: Math.max(run?.[name]?.peak ?? 0, byName.get(name)?.count ?? 0),
        })).sort((a, b) => b.now - a.now || b.peak - a.peak || a.name.localeCompare(b.name))
    }, [now, run])
    return (
        <div className={s.section}>
            <span className={s.label}>What it finds</span>
            {rows.length === 0 && <p className={s.muted}>{waiting ? 'Waiting for the first frame...' : 'Nothing found yet.'}</p>}
            {rows.length > 0 && (
                <table className={s.counts}>
                    <thead>
                        <tr><th scope="col">Class</th><th scope="col">Now</th><th scope="col">Most at once</th></tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={r.name} style={r.now === 0 || r.stale ? { color: 'var(--cm-ink-2)' } : undefined}>
                                <th scope="row" style={{ textTransform: 'capitalize' }}>{r.name}</th>
                                <td className={s.resCount}>{r.now}</td>
                                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.peak}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

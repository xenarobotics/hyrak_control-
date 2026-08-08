'use client'

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getSocket } from '@/lib/socket'
import { getCrowdThresholds } from '@/lib/videoSettings'
import { fetchCrowdHistory, downloadSessionReport, clearHistory, toFileStamp, type CrowdSessionSummary, type CrowdAlertRow } from '@/lib/visionReports'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Users, Download, Trash2, MapPin } from 'lucide-react'
import { FollowControls } from '@/components/vision/FollowControls'

const LEVEL_STYLE: Record<string, { bg: string; border: string; fg: string; label: string }> = {
    green:  { bg: '#0f2e1a', border: '#22c55e', fg: '#4ade80', label: 'LIGHT' },
    orange: { bg: '#3a2408', border: '#f59e0b', fg: '#fbbf24', label: 'MODERATE' },
    red:    { bg: '#3a0f0f', border: '#ef4444', fg: '#f87171', label: 'DENSE' },
}

function StatTile({ label, value }: { label: string; value: number | string }) {
    return (
        <div style={{
            flex: 1, padding: '10px 8px', textAlign: 'center',
            background: 'hsl(var(--app-surface-2))',
            border: '1px solid hsl(var(--app-border))',
            borderRadius: 10,
        }}>
            <div style={{
                fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-geist-mono)',
                color: 'hsl(var(--app-text))',
            }}>
                {value}
            </div>
            <div style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', marginTop: 2 }}>{label}</div>
        </div>
    )
}

/** Headcount over time. A live number cannot tell a steady crowd from one
 *  that doubled in the last minute, and that difference is the entire reason
 *  to be watching. Plain SVG — no chart library for nine points of data. */
function TrendSpark({ history, trend }: {
    history: { t: number; n: number }[]
    trend: number | null | undefined
}) {
    if (history.length < 2) {
        return (
            <div style={{
                fontSize: 10, fontFamily: 'monospace', textAlign: 'center',
                color: 'hsl(var(--app-text-muted))', padding: '6px 0',
            }}>
                building trend…
            </div>
        )
    }
    const W = 240, H = 38
    const ns = history.map(h => h.n)
    const max = Math.max(...ns, 1)
    const pts = history.map((h, i) => {
        const x = (i / (history.length - 1)) * W
        const y = H - (h.n / max) * (H - 4) - 2
        return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const rising = (trend ?? 0) > 0.5
    const falling = (trend ?? 0) < -0.5
    const col = rising ? '#fbbf24' : falling ? '#4ade80' : 'hsl(var(--app-text-muted))'
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    Trend
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace', color: col }}>
                    {trend == null ? '—'
                        : `${trend > 0 ? '+' : ''}${trend.toFixed(0)}/min`}
                    {rising ? '  rising' : falling ? '  easing' : '  steady'}
                </span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
                 preserveAspectRatio="none" style={{ display: 'block' }}>
                <polyline points={pts} fill="none" stroke={col} strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke" />
            </svg>
            <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 9, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
            }}>
                <span>peak {max}</span>
                <span>{Math.round((history[history.length - 1].t - history[0].t) / 60)} min</span>
            </div>
        </div>
    )
}

/** Names for the nine cells. "North Gate is dense" is actionable over a
 *  radio; "section 4 is dense" has to be decoded first — and the backend
 *  puts whatever is set here straight into the alert text. */
function ZoneNames({ names, counts }: {
    names: Record<string, string>
    counts: Record<number, number> | undefined
}) {
    const [open, setOpen] = useState(false)
    const [draft, setDraft] = useState<Record<string, string>>(names)
    useEffect(() => { setDraft(names) }, [names])

    const save = (idx: number, v: string) => {
        const next = { ...draft, [String(idx)]: v }
        setDraft(next)
        getSocket().emit('set_zone_names', { names: next })
    }
    const named = Object.values(names).filter(Boolean).length

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: 0,
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
                    color: 'hsl(var(--app-text-muted))',
                }}
            >
                <MapPin size={11} />
                Zones {named > 0 && `(${named} named)`}
                <span style={{ marginLeft: 'auto' }}>{open ? '−' : '+'}</span>
            </button>
            {open && (
                <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4,
                }}>
                    {Array.from({ length: 9 }, (_, i) => (
                        <input
                            key={i}
                            value={draft[String(i)] ?? ''}
                            onChange={e => save(i, e.target.value)}
                            placeholder={`zone ${i}`}
                            title={`Grid cell ${i}${counts?.[i] ? ` — ${counts[i]} people now` : ''}`}
                            style={{
                                width: '100%', padding: '4px 6px', borderRadius: 6,
                                fontSize: 10, minWidth: 0,
                                border: `1px solid ${counts?.[i] ? '#22d3ee55' : 'hsl(var(--app-border))'}`,
                                background: 'hsl(var(--app-surface-2))',
                                color: 'hsl(var(--app-text))',
                            }}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

export function CrowdManagementPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const { isStreaming } = useWebRTCContext()
    const [sessions, setSessions] = useState<CrowdSessionSummary[]>([])
    const [alerts, setAlerts] = useState<CrowdAlertRow[]>([])

    // Apply the operator's saved density preset (Settings page) as soon as
    // this mode's analyzer is up — otherwise it only takes effect if they
    // happen to touch Settings while already streaming.
    useEffect(() => {
        const { lightMax, moderateMax } = getCrowdThresholds()
        getSocket().emit('set_crowd_thresholds', { light_max: lightMax, moderate_max: moderateMax })
    }, [])

    // ...and keep re-sending until the analyzer agrees.
    //
    // The mount emit alone was a race it usually LOST: the panel renders
    // before the stream negotiates, so the analyzer does not exist yet and the
    // handler silently no-ops. The operator then sees their custom numbers
    // ignored with nothing to indicate why. Comparing against what the backend
    // actually reports is self-healing — it converges as soon as the analyzer
    // is up, and costs nothing once the two agree.
    useEffect(() => {
        if (!cvResults) return
        const want = getCrowdThresholds()
        const live = { lightMax: cvResults.light_max, moderateMax: cvResults.moderate_max }
        if (live.lightMax === undefined) return
        if (live.lightMax !== want.lightMax || live.moderateMax !== want.moderateMax) {
            getSocket().emit('set_crowd_thresholds', {
                light_max: want.lightMax, moderate_max: want.moderateMax,
            })
        }
    }, [cvResults?.light_max, cvResults?.moderate_max, cvResults])

    const loadHistory = () => fetchCrowdHistory(10).then(d => { setSessions(d.sessions); setAlerts(d.alerts) })

    // Recent list is always visible (not behind a tab) and loads on mount.
    useEffect(() => { loadHistory() }, [])

    // Refresh it the moment a session stops, so the new entry shows up
    // without the operator having to do anything — give the last async DB
    // writes (fire-and-forget from stream_track.py) a moment to land first.
    const wasStreaming = useRef(false)
    useEffect(() => {
        if (wasStreaming.current && !isStreaming) {
            const t = setTimeout(loadHistory, 1200)
            wasStreaming.current = isStreaming
            return () => clearTimeout(t)
        }
        wasStreaming.current = isStreaming
    }, [isStreaming])

    const level = cvResults?.density_level ?? 'green'
    const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.green
    // Prefer the live value the analyzer is actually applying; fall back to
    // the locally saved preference before the first result arrives.
    const lightMax = cvResults?.light_max ?? getCrowdThresholds().lightMax
    const moderateMax = cvResults?.moderate_max ?? getCrowdThresholds().moderateMax

    // ── Follow one person out of the crowd ───────────────────────────────
    // Same tracker ids the count is built from, so picking someone costs no
    // extra perception and the crowd figures keep running underneath.
    const selectedId = cvResults?.selected_id ?? null
    const following = cvResults?.tracking ?? false
    const elevate = cvResults?.elevate ?? null
    const release = () => {
        getSocket().emit('set_tracking', { active: false })
        getSocket().emit('select_person', { person_id: null })
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>

            <TrendSpark history={cvResults?.count_history ?? []}
                        trend={cvResults?.trend_per_min} />
            <ZoneNames names={cvResults?.zone_names ?? {}}
                       counts={cvResults?.section_counts} />

            <FollowControls
                kind="person"
                selectedLabel={selectedId !== null ? `Person #${selectedId}` : null}
                lockState={cvResults?.lock_state}
                lockMessage={cvResults?.lock_message}
                altitudeMode={cvResults?.altitude_mode}
                targetRatio={cvResults?.target_distance_ratio}
                elevate={elevate}
                onRelease={release}
            />

            {/* ── Live (top half) ─────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflow: 'auto' }}>
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '14px 10px', borderRadius: 12,
                    background: style.bg, border: `1px solid ${style.border}`,
                }}>
                    <Users size={18} style={{ color: style.fg }} />
                    <span style={{
                        fontSize: 15, fontWeight: 700, letterSpacing: '0.06em',
                        fontFamily: 'var(--font-geist-mono)', color: style.fg,
                    }}>
                        {style.label}
                    </span>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                    <StatTile label="CURRENT" value={cvResults?.current_count ?? 0} />
                    <StatTile label="PEAK" value={cvResults?.peak_count ?? 0} />
                </div>

                    <div style={{
                    display: 'flex', justifyContent: 'space-between', fontSize: 10.5,
                    padding: '8px 10px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                    fontFamily: 'monospace',
                }}>
                    <span style={{ color: '#4ade80' }}>GREEN ≤{lightMax}</span>
                    <span style={{ color: '#fbbf24' }}>ORANGE ≤{moderateMax}</span>
                    <span style={{ color: '#f87171' }}>RED {moderateMax + 1}+</span>
                </div>

                <div style={{
                    fontSize: 10.5, color: 'hsl(var(--app-text-muted))', lineHeight: 1.5,
                    padding: '8px 10px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                }}>
                    Distinct tracks seen this session: <b>{cvResults?.distinct_tracks_seen ?? 0}</b>.
                    This can overcount if the drone revisits the same area — it is
                    not a certified footfall figure.
                </div>

                {!cvResults && (
                    <div style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'hsl(var(--app-text-muted))', fontSize: 12, fontFamily: 'monospace',
                    }}>
                        Start stream to begin monitoring
                    </div>
                )}
            </div>

            {/* ── Recent (bottom half) — always visible, no tab click ──── */}
            <div style={{
                flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6,
                borderTop: '1px solid hsl(var(--app-border))', paddingTop: 8,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace', margin: 0, letterSpacing: '0.06em' }}>
                        RECENT SESSIONS
                    </p>
                    <button
                        onClick={() => clearHistory('crowd-history').then(ok => { if (ok) loadHistory() })}
                        title="Clear all history"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--app-text-muted))', display: 'flex' }}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
                <ScrollArea style={{ flex: 1 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 4 }}>
                        {sessions.map(s => (
                            <div key={s.session_id} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '7px 10px', borderRadius: 8,
                                background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))' }}>
                                        {s.started ? new Date(s.started).toLocaleString() : '—'}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))' }}>peak {s.peak_count}</span>
                                </div>
                                <button
                                    onClick={() => downloadSessionReport(s.session_id, 'crowd-report', toFileStamp(s.started))}
                                    title="Download this session's report"
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--app-text-muted))', display: 'flex' }}
                                >
                                    <Download size={13} />
                                </button>
                            </div>
                        ))}
                        {alerts.slice(0, 8).map((a, i) => (
                            <div key={`a${i}`} style={{
                                padding: '6px 10px', borderRadius: 8, fontSize: 10, lineHeight: 1.4,
                                background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                color: 'hsl(var(--app-text-muted))',
                            }}>
                                <span style={{ color: '#f87171', fontFamily: 'monospace' }}>{a.t ? new Date(a.t).toLocaleTimeString() : ''}</span>
                                {' — '}{a.message}
                            </div>
                        ))}
                        {sessions.length === 0 && alerts.length === 0 && (
                            <div style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80,
                                color: 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', textAlign: 'center',
                            }}>
                                No previous sessions yet
                            </div>
                        )}
                    </div>
                </ScrollArea>
            </div>
        </div>
    )
}

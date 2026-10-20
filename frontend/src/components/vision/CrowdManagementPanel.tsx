'use client'

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getSocket } from '@/lib/socket'
import { getCrowdThresholds } from '@/lib/videoSettings'
import { fetchCrowdHistory, downloadSessionReport, clearHistory, canClearHistory, toFileStamp, type CrowdSessionSummary, type CrowdAlertRow } from '@/lib/visionReports'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Users, Download, Trash2, MapPin } from 'lucide-react'
import { FollowControls } from '@/components/vision/FollowControls'
import { TONE, LABEL, READOUT, SECONDARY, NUM, TILE, TEXT, MUTED, BORDER, FOCUS, type Tone } from '@/components/vision/panelStyle'

const LEVEL_TONE: Record<string, Tone> = { green: 'ok', orange: 'warn', red: 'danger' }
const LEVEL_STYLE: Record<string, { bg: string; border: string; fg: string; label: string }> = Object.fromEntries(
    Object.entries({ green: 'Light', orange: 'Moderate', red: 'Dense' }).map(([k, label]) => {
        const t = TONE[LEVEL_TONE[k]]
        return [k, { bg: t.bg, border: t.border, fg: t.fg, label }]
    }),
)

function StatTile({ label, value }: { label: string; value: number | string }) {
    return (
        <div style={{ ...TILE, flex: 1, padding: '12px 8px', textAlign: 'center' }}>
            <div style={READOUT}>{value}</div>
            <div style={{ ...LABEL, marginTop: 4 }}>{label}</div>
        </div>
    )
}

/** Headcount over time. A live number cannot tell a steady crowd from one
 *  that doubled in the last minute, and that difference is the entire reason
 *  to be watching. Plain SVG - no chart library for nine points of data. */
function TrendSpark({ history, trend }: {
    history: { t: number; n: number }[]
    trend: number | null | undefined
}) {
    if (history.length < 2) {
        return (
            <div style={{ ...SECONDARY, textAlign: 'center', padding: '6px 0' }}>
                Building the trend...
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
    const col = rising ? TONE.warn.fg : falling ? TONE.ok.fg : MUTED
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={LABEL}>Trend</span>
                <span style={{ ...NUM, marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: col }}>
                    {trend == null ? '-'
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
                ...NUM, display: 'flex', justifyContent: 'space-between',
                fontSize: 12, color: MUTED,
            }}>
                <span>Peak {max}</span>
                <span>{Math.round((history[history.length - 1].t - history[0].t) / 60)} min</span>
            </div>
        </div>
    )
}

/** Names for the nine cells. "North Gate is dense" is actionable over a
 *  radio; "section 4 is dense" has to be decoded first - and the backend
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
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className={FOCUS}
                style={{
                    ...LABEL, display: 'flex', alignItems: 'center', gap: 6, padding: 0,
                    minHeight: 28, borderRadius: 6,
                    background: 'none', border: 'none', cursor: 'pointer',
                }}
            >
                <MapPin size={12} aria-hidden />
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
                            title={`Grid cell ${i}${counts?.[i] ? ` - ${counts[i]} people now` : ''}`}
                            className={FOCUS}
                            style={{
                                width: '100%', minHeight: 32, padding: '4px 8px', borderRadius: 6,
                                fontSize: 13, minWidth: 0,
                                border: `1px solid ${counts?.[i] ? TONE.accent.border : BORDER}`,
                                background: 'hsl(var(--app-surface))',
                                color: TEXT,
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
    // this mode's analyzer is up - otherwise it only takes effect if they
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
    // actually reports is self-healing - it converges as soon as the analyzer
    // is up, and costs nothing once the two agree.
    //
    // Bounded, though: at most one re-send every 2 s, and it stops once a
    // full round trip came back unchanged - the analyzer has then heard us
    // and still disagrees (a backend clamp, say), and re-sending the same
    // numbers forever at cv_results rate is a loop, not a fix.
    const thresholdSync = useRef({ lastSentAt: 0, sentLight: NaN, sentModerate: NaN, givenUp: false })
    const liveLight = cvResults?.light_max
    const liveModerate = cvResults?.moderate_max
    useEffect(() => {
        if (liveLight === undefined) return
        const want = getCrowdThresholds()
        if (liveLight === want.lightMax && liveModerate === want.moderateMax) {
            thresholdSync.current.givenUp = false
            return
        }
        const t = thresholdSync.current
        if (t.givenUp) return
        const now = Date.now()
        if (now - t.lastSentAt < 2000) return
        // The same values went out before and the analyzer has since reported
        // (this is a later cv_results) without adopting them: stop.
        if (t.sentLight === want.lightMax && t.sentModerate === want.moderateMax) {
            t.givenUp = true
            return
        }
        t.lastSentAt = now
        t.sentLight = want.lightMax
        t.sentModerate = want.moderateMax
        getSocket().emit('set_crowd_thresholds', {
            light_max: want.lightMax, moderate_max: want.moderateMax,
        })
    }, [liveLight, liveModerate])

    const loadHistory = () => fetchCrowdHistory(10).then(d => { setSessions(d.sessions); setAlerts(d.alerts) })

    // Recent list is always visible (not behind a tab) and loads on mount.
    useEffect(() => { loadHistory() }, [])

    // Refresh it the moment a session stops, so the new entry shows up
    // without the operator having to do anything - give the last async DB
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
                    padding: '14px 10px', borderRadius: 10,
                    background: style.bg, border: `1px solid ${style.border}`,
                }}>
                    <Users size={20} style={{ color: style.fg }} aria-hidden />
                    <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1, color: style.fg }}>
                        {style.label}
                    </span>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                    <StatTile label="Now" value={cvResults?.current_count ?? 0} />
                    <StatTile label="Peak" value={cvResults?.peak_count ?? 0} />
                </div>

                <div style={{
                    ...TILE, ...NUM, display: 'flex', justifyContent: 'space-between', gap: 6,
                    fontSize: 12, fontWeight: 700, padding: '8px 10px',
                }} title="People per view for each level. Change it in Settings.">
                    <span style={{ color: TONE.ok.fg }}>Light ≤{lightMax}</span>
                    <span style={{ color: TONE.warn.fg }}>Moderate ≤{moderateMax}</span>
                    <span style={{ color: TONE.danger.fg }}>Dense {moderateMax + 1}+</span>
                </div>

                <div style={{ ...TILE, ...SECONDARY, padding: '8px 10px' }}
                    title="Can overcount if the drone flies over the same area again. Not a certified footfall figure.">
                    People seen this session: <b style={{ ...NUM, color: TEXT }}>{cvResults?.distinct_tracks_seen ?? 0}</b> (estimate)
                </div>

                {!cvResults && (
                    <div style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        ...SECONDARY,
                    }}>
                        Press Run to start counting
                    </div>
                )}
            </div>

            {/* ── Recent (bottom half) - always visible, no tab click ──── */}
            <div style={{
                flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6,
                borderTop: `1px solid ${BORDER}`, paddingTop: 8,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{ ...LABEL, margin: 0 }}>Recent sessions</p>
                    {canClearHistory() && <button
                        onClick={() => clearHistory('crowd-history').then(ok => { if (ok) loadHistory() })}
                        type="button"
                        title="Clear all history"
                        aria-label="Clear all history"
                        className={FOCUS}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6 }}
                    >
                        <Trash2 size={14} aria-hidden />
                    </button>}
                </div>
                <ScrollArea style={{ flex: 1 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 4 }}>
                        {sessions.map(s => (
                            <div key={s.session_id} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                ...TILE, padding: '8px 10px',
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                    <span style={{ ...NUM, fontSize: 13, fontWeight: 600, color: TEXT }}>
                                        {s.started ? new Date(s.started).toLocaleString() : '-'}
                                    </span>
                                    <span style={{ ...NUM, fontSize: 12, color: MUTED }}>Peak {s.peak_count}</span>
                                </div>
                                <button
                                    onClick={() => downloadSessionReport(s.session_id, 'crowd-report', toFileStamp(s.started))}
                                    type="button"
                                    title="Download this session's report"
                                    aria-label="Download this session's report"
                                    className={FOCUS}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, flexShrink: 0 }}
                                >
                                    <Download size={14} aria-hidden />
                                </button>
                            </div>
                        ))}
                        {alerts.slice(0, 8).map((a, i) => (
                            <div key={`a${i}`} style={{
                                ...TILE, ...SECONDARY, padding: '6px 10px',
                            }}>
                                <span style={{ ...NUM, color: TONE.danger.fg, fontWeight: 700 }}>{a.t ? new Date(a.t).toLocaleTimeString() : ''}</span>
                                {' - '}{a.message}
                            </div>
                        ))}
                        {sessions.length === 0 && alerts.length === 0 && (
                            <div style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80,
                                ...SECONDARY, textAlign: 'center',
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

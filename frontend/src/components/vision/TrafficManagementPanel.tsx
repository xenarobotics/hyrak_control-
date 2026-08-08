'use client'

// Traffic management — the composed vehicle module's panel.
//
// One list of vehicles carrying everything known about each: type, colour,
// plate, speed. Clicking a row locks onto that vehicle (the same action as
// clicking it on the video), and a separate Follow control arms the flight
// command, so locking and flying are two deliberate steps rather than one.

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getSocket } from '@/lib/socket'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertCircle, Download, Layers, Trash2 } from 'lucide-react'
import { FollowControls } from '@/components/vision/FollowControls'
import type { CVResult } from '@/types/vision'
import {
    fetchPlateHistory, downloadSessionReport, clearHistory, toFileStamp,
    type PlateHistoryRow,
} from '@/lib/visionReports'

const LABEL: React.CSSProperties = {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
    color: 'hsl(var(--app-text-muted))',
}

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'cyan' }) {
    return (
        <div style={{
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontFamily: 'monospace',
            background: 'hsl(var(--app-surface-2))',
            border: '1px solid hsl(var(--app-border))',
            color: tone === 'cyan' ? '#22d3ee' : 'hsl(var(--app-text-muted))',
        }}>
            {children}
        </div>
    )
}

const PROFILE_TONE: Record<string, string> = {
    survey: '#38bdf8',
    identify: '#4ade80',
    forensic: '#a78bfa',
}

/** What the current optics support, and the override that argues with it.
 *
 *  Shown as an override rather than a mode switch on purpose: an operator who
 *  forces plate OCR on at 40m should still be able to read that the plate is
 *  34px short of legible, so the automatic verdict stays visible next to the
 *  button that overrules it. */
function ProfileCard({ profile }: { profile: NonNullable<CVResult['profile']> }) {
    const tone = PROFILE_TONE[profile.name] ?? '#38bdf8'
    const set = (subject: string, mode: string) =>
        getSocket().emit('set_profile_override', { subject, mode })

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: '8px 10px', borderRadius: 8,
            background: 'hsl(var(--app-surface-2))',
            border: `1px solid ${tone}44`,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Layers size={12} style={{ color: tone }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: tone }}>
                    {profile.label}
                </span>
                <span style={{ ...LABEL, marginLeft: 'auto', textTransform: 'none' }}>
                    {profile.ocr_calls > 0 ? `${profile.ocr_calls} OCR/frame` : 'no OCR'}
                </span>
            </div>

            {profile.headline && (
                <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                    {profile.headline}
                </div>
            )}

            {profile.subjects.map(s => (
                <div key={s.subject} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                        width: 46, fontSize: 10, fontFamily: 'monospace',
                        textTransform: 'capitalize',
                        color: s.attempt ? '#4ade80' : 'hsl(var(--app-text-muted))',
                    }}>
                        {s.subject}
                    </span>
                    <span style={{
                        flex: 1, minWidth: 0, fontSize: 10, fontFamily: 'monospace',
                        color: 'hsl(var(--app-text-muted))',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={s.reason}>
                        {s.reason}
                    </span>
                    {s.status !== 'unavailable' && (
                        <div style={{ display: 'flex', gap: 2 }}>
                            {(['auto', 'on', 'off'] as const).map(m => {
                                const active = m === 'auto' ? !s.forced
                                    : s.forced && (m === 'on') === s.attempt
                                return (
                                    <button
                                        key={m}
                                        onClick={() => set(s.subject, m)}
                                        style={{
                                            padding: '1px 6px', borderRadius: 5, fontSize: 9,
                                            fontFamily: 'monospace', cursor: 'pointer',
                                            border: `1px solid ${active ? tone : 'hsl(var(--app-border))'}`,
                                            background: active ? `${tone}22` : 'transparent',
                                            color: active ? tone : 'hsl(var(--app-text-muted))',
                                        }}
                                    >
                                        {m}
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}

export function TrafficManagementPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const { isStreaming } = useWebRTCContext()
    const [history, setHistory] = useState<PlateHistoryRow[]>([])
    const [tracking, setTracking] = useState(false)

    const vehicles = cvResults?.vehicles ?? []
    const lockedId = cvResults?.locked_track_id ?? null
    // Which kind was locked comes FROM the backend: people and vehicles share
    // one track-id space, so the panel cannot know what was clicked until the
    // module has resolved the id against both lists.
    const lockedKind = cvResults?.locked_kind ?? 'vehicle'
    const lockedVehicleId = vehicles.find(v => v.track_id === lockedId)?.vehicle_id ?? null
    const lockedPlate = cvResults?.locked_plate ?? null
    const profile = cvResults?.profile ?? null
    const floorReason = cvResults?.altitude_floor_reason ?? null
    const lockState = cvResults?.lock_state ?? 'idle'
    const lockMessage = cvResults?.lock_message ?? ''
    const elevate = cvResults?.elevate ?? null
    const hasTelemetry = cvResults?.has_telemetry !== false
    const alprOk = cvResults?.alpr_available !== false
    const facesOk = cvResults?.faces_available !== false
    const identities = cvResults?.identities ?? []
    const viability = cvResults?.viability ?? []

    useEffect(() => {
        const socket = getSocket()
        const onTracking = (d: { active: boolean }) => setTracking(d.active)
        socket.on('vehicle_tracking_status', onTracking)
        return () => { socket.off('vehicle_tracking_status', onTracking) }
    }, [])

    const loadHistory = () => fetchPlateHistory(50).then(setHistory)
    useEffect(() => { loadHistory() }, [])

    // Refresh once a session stops so the last reads appear without the
    // operator doing anything — the final DB writes are fire-and-forget.
    const wasStreaming = useRef(false)
    useEffect(() => {
        if (wasStreaming.current && !isStreaming) {
            const t = setTimeout(loadHistory, 1200)
            wasStreaming.current = isStreaming
            return () => clearTimeout(t)
        }
        wasStreaming.current = isStreaming
    }, [isStreaming])

    const lock = (trackId: number | null) =>
        getSocket().emit('set_follow_vehicle', { track_id: trackId })
    const arm = (active: boolean) => {
        setTracking(active)
        getSocket().emit('set_vehicle_tracking', { active })
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>

            {/* ── Counts ──────────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Chip tone="cyan">
                    {cvResults?.vehicles_in_frame ?? 0} in frame
                </Chip>
                {/* Reported separately from "in frame" because they answer
                    different questions, and conflating them is how traffic
                    figures become fiction. */}
                <Chip>{cvResults?.vehicle_count_unique ?? 0} veh total</Chip>
                <Chip tone="cyan">{cvResults?.person_count ?? 0} people</Chip>
                <Chip>{cvResults?.plates_read ?? 0} plates</Chip>
                <Chip>{identities.length} identified</Chip>
            </div>

            {/* ── What is being ATTEMPTED, and why ─────────────────────
                Sits above the range readout because it is the actionable one:
                viability says what COULD resolve, this says what the frame
                budget is actually being spent on. A skipped plate read is
                otherwise indistinguishable from a failed one. */}
            {profile && <ProfileCard profile={profile} />}

            {/* ── What this altitude can resolve ──────────────────────
                The honest way to offer all five analytics in one mode: run
                everything, and say which subjects are actually in range. A
                refused plate read otherwise looks like a broken plate reader. */}
            {viability.length > 0 && (
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 3,
                    padding: '7px 9px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={LABEL}>In range now</span>
                        {cvResults?.slant_range_m != null && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                {cvResults.slant_range_m.toFixed(0)} m to frame centre
                            </span>
                        )}
                    </div>
                    {viability.map(v => {
                        const tone = v.status === 'good' ? '#4ade80'
                            : v.status === 'marginal' ? '#fbbf24'
                            : v.status === 'unknown' ? 'hsl(var(--app-text-muted))' : '#f87171'
                        return (
                            <div key={v.subject} style={{
                                display: 'flex', alignItems: 'baseline', gap: 6,
                                fontSize: 10, fontFamily: 'monospace', color: tone,
                            }}>
                                <span style={{ width: 52, textTransform: 'capitalize' }}>{v.subject}</span>
                                <span style={{ width: 70 }}>
                                    {v.px_on_target > 0 ? `${v.px_on_target.toFixed(0)}px` : '—'}
                                    <span style={{ opacity: 0.6 }}>/{v.px_needed}</span>
                                </span>
                                <span style={{ flex: 1, minWidth: 0 }}>{v.advice}</span>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* ── Degraded-capability notices ─────────────────────────── */}
            {!hasTelemetry && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
                    lineHeight: 1.5, color: '#fbbf24',
                }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>
                        No telemetry — speed needs altitude to convert pixels to
                        metres, so it is omitted rather than guessed.
                    </span>
                </div>
            )}
            {!alprOk && (
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: '#fbbf24' }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>Plate reader unavailable — counting and speed still work.</span>
                </div>
            )}
            {!facesOk && (
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: '#fbbf24' }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>Face recognition unavailable — the other analytics are unaffected.</span>
                </div>
            )}

            {/* ── Recognised people ───────────────────────────────────── */}
            {identities.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={LABEL}>Recognised ({identities.length})</span>
                    {identities.map(id => (
                        <div key={id.track_id} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '4px 9px', borderRadius: 7, fontSize: 11,
                            background: 'rgba(220,120,170,0.12)',
                            border: '1px solid rgba(220,120,170,0.35)',
                        }}>
                            <span style={{ fontWeight: 700, color: '#dc78aa' }}>{id.name}</span>
                            <span style={{
                                marginLeft: 'auto', fontFamily: 'monospace',
                                color: 'hsl(var(--app-text-muted))',
                            }}>
                                {id.similarity.toFixed(2)}
                                <span style={{ opacity: 0.6 }}> ·{id.votes}v</span>
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Crowd density ───────────────────────────────────────── */}
            {(cvResults?.person_count ?? 0) > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                    <span style={LABEL}>Density</span>
                    <span style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                        textTransform: 'uppercase',
                        background: cvResults?.density_level === 'red' ? 'rgba(230,0,0,0.18)'
                            : cvResults?.density_level === 'orange' ? 'rgba(255,165,0,0.18)'
                            : 'rgba(0,200,0,0.15)',
                        color: cvResults?.density_level === 'red' ? '#f87171'
                            : cvResults?.density_level === 'orange' ? '#fbbf24' : '#4ade80',
                    }}>
                        {cvResults?.density_level ?? 'green'}
                    </span>
                    <span style={{ ...LABEL, marginLeft: 'auto', fontFamily: 'monospace' }}>
                        peak {cvResults?.peak_count ?? 0} · {cvResults?.person_count_unique ?? 0} unique
                    </span>
                </div>
            )}

            {/* ── Lock + follow ───────────────────────────────────────────
                The SHARED control, so vehicles, people, crowds and person-ID
                all behave the same way — the inconsistency between four
                hand-rolled versions was itself the reliability problem.
                `kind` comes from the backend rather than being assumed here:
                one id space covers both, so what got clicked is only known
                after the module resolves it. */}
            <FollowControls
                kind={lockedKind}
                selectedLabel={lockedId === null ? null : [
                    lockedVehicleId ?? `#${lockedId}`,
                    lockedPlate,
                ].filter(Boolean).join('  ')}
                lockState={lockState}
                lockMessage={lockMessage}
                tracking={tracking}
                altitudeMode={cvResults?.altitude_mode}
                targetRatio={cvResults?.target_distance_ratio}
                actualFillPct={cvResults?.subject_fill_pct}
                elevate={elevate}
                onRelease={() => { arm(false); lock(null) }}
            />

            {/* The altitude floor is the reason a commanded descent stops. Left
                unsaid, a drone that will not come down reads as a broken
                controller — and its opposite, a descent nobody could see, is
                what put an aircraft into the ground. */}
            {floorReason && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 10, lineHeight: 1.5, color: '#fbbf24',
                }}>
                    <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>{floorReason}</span>
                </div>
            )}

            {/* ── Live vehicles ───────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={LABEL}>Vehicles</span>
                    {vehicles.length > 0 && (
                        <span style={{ fontSize: 9, color: 'hsl(var(--app-text-muted))' }}>
                            click to lock — or click it on the video
                        </span>
                    )}
                </div>
                <ScrollArea style={{ flex: 1 }}>
                    {vehicles.length === 0 ? (
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            height: 100, fontSize: 12, fontFamily: 'monospace',
                            color: 'hsl(var(--app-text-muted))', textAlign: 'center',
                        }}>
                            {cvResults ? 'No vehicles in frame' : 'Start stream to monitor traffic'}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 }}>
                            {vehicles.map((v, i) => {
                                const locked = v.track_id === lockedId
                                const showColour = v.color && v.color !== 'unknown'
                                    && (v.color_conf ?? 0) >= 0.35
                                return (
                                    <div
                                        // vehicle_id first: it is stable across
                                        // the track id resetting on occlusion.
                                        // Math.random() used to stand in here,
                                        // which gave every row a new key on
                                        // every frame — React tore down and
                                        // rebuilt the whole list ~15x a second.
                                        key={v.vehicle_id ?? v.track_id ?? `idx-${i}`}
                                        onClick={() => v.track_id != null
                                            && lock(locked ? null : v.track_id)}
                                        title={locked ? 'Click to release' : 'Click to lock onto this vehicle'}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '6px 9px', borderRadius: 7, cursor: 'pointer',
                                            background: locked ? 'rgba(34,211,238,0.12)' : 'hsl(var(--app-surface-2))',
                                            border: `1px solid ${locked ? 'rgba(34,211,238,0.45)' : 'transparent'}`,
                                        }}
                                    >
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                            <span style={{
                                                fontSize: 12, fontWeight: 700,
                                                fontFamily: 'var(--font-geist-mono)',
                                                letterSpacing: '0.04em',
                                                // Toned by STRENGTH, not by whether the read
                                                // was allowed to exist. Green means two
                                                // frames agreed; amber is a single-frame
                                                // read, which at drone standoff is often
                                                // the only read a passing vehicle gives —
                                                // shown, logged, and marked rather than
                                                // discarded.
                                                color: !v.plate ? 'hsl(var(--app-text-muted))'
                                                    : v.plate_strong ? '#4ade80'
                                                    : '#fbbf24',
                                            }}>
                                                {v.plate
                                                    ? `${v.plate}${v.plate_strong ? '' : '?'}`
                                                    : 'no plate'}
                                            </span>
                                            {/* How many pixels the reader actually got.
                                                The honest quality number now that width no
                                                longer rejects: a 40px read and a 300px read
                                                are both reported and are not equally
                                                trustworthy. */}
                                            {v.plate && (v.plate_px_w ?? 0) > 0 && (
                                                <span style={{
                                                    fontSize: 9, fontFamily: 'monospace',
                                                    color: 'hsl(var(--app-text-muted))',
                                                }}>
                                                    {v.plate_px_w}px across
                                                    {v.plate_grammar_ok === false && ' · unusual format'}
                                                </span>
                                            )}
                                            <span style={{
                                                fontSize: 10, textTransform: 'capitalize',
                                                color: 'hsl(var(--app-text-muted))',
                                            }}>
                                                {/* vehicle_id, not the track id, is the
                                                    identity worth showing: it survives the
                                                    tracker renumbering on occlusion and is
                                                    what the exported report is keyed by. */}
                                                {[showColour ? v.color : null, v.type]
                                                    .filter(Boolean).join(' ')}
                                                {' · '}{v.vehicle_id ?? `#${v.track_id}`}
                                            </span>
                                        </div>
                                        {v.speed_kmh != null && (
                                            <span style={{
                                                marginLeft: 'auto', fontSize: 11, fontFamily: 'monospace',
                                                color: v.speed_reliable ? '#4ade80' : '#fbbf24',
                                            }}>
                                                ~{Math.round(v.speed_kmh)} km/h{v.speed_reliable ? '' : '?'}
                                            </span>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </ScrollArea>
            </div>

            {/* ── Session breakdown ───────────────────────────────────── */}
            {(Object.keys(cvResults?.vehicle_types ?? {}).length > 0
              || Object.keys(cvResults?.vehicle_colors ?? {}).length > 0) && (
                <div style={{
                    fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6,
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    {Object.entries(cvResults?.vehicle_types ?? {})
                        .map(([k, n]) => `${n} ${k}`).join(' · ')}
                    {Object.keys(cvResults?.vehicle_colors ?? {}).length > 0 && (
                        <><br />{Object.entries(cvResults?.vehicle_colors ?? {})
                            .map(([k, n]) => `${n} ${k}`).join(' · ')}</>
                    )}
                </div>
            )}

            {/* ── History ─────────────────────────────────────────────── */}
            {history.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={LABEL}>Logged plates</span>
                        <button
                            onClick={() => downloadSessionReport(
                                history[0].session_id, 'plate-report',
                                toFileStamp(history[0].first_seen),
                            )}
                            style={{
                                marginLeft: 'auto', border: 'none', background: 'none',
                                cursor: 'pointer', color: 'hsl(var(--app-text-muted))',
                                display: 'flex', alignItems: 'center', gap: 4, fontSize: 10,
                            }}
                        >
                            <Download size={11} /> report
                        </button>
                        <button
                            onClick={async () => { await clearHistory('plate-history'); loadHistory() }}
                            style={{
                                border: 'none', background: 'none', cursor: 'pointer',
                                color: '#f87171', display: 'flex', alignItems: 'center', gap: 4,
                                fontSize: 10,
                            }}
                        >
                            <Trash2 size={11} /> clear
                        </button>
                    </div>
                    <div style={{ maxHeight: 96, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {history.slice(0, 12).map(ev => (
                            <div key={ev.id} style={{
                                display: 'flex', gap: 8, alignItems: 'center', fontSize: 10,
                                fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
                            }}>
                                <span style={{ color: '#4ade80', fontWeight: 700 }}>{ev.plate_text}</span>
                                <span style={{ textTransform: 'capitalize' }}>{ev.vehicle_type}</span>
                                {ev.speed_est_kmh != null && (
                                    <span style={{ marginLeft: 'auto' }}>
                                        ~{Math.round(ev.speed_est_kmh)} km/h
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

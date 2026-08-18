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
import { AlertCircle, Download, Layers, Trash2, TriangleAlert } from 'lucide-react'
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

/** One figure in the stat grid. Value first and large, label under it — the
 *  number is what gets read at a glance and the label only disambiguates. */
function Stat({ label, value, tone = 'muted' }: {
    label: string; value: number | string; tone?: 'muted' | 'cyan'
}) {
    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            padding: '5px 8px', borderRadius: 7,
            background: 'hsl(var(--app-surface-2))',
            border: '1px solid hsl(var(--app-border))',
        }}>
            <span style={{
                fontSize: 15, fontWeight: 700, lineHeight: 1.1,
                fontFamily: 'var(--font-geist-mono), monospace',
                color: tone === 'cyan' ? '#22d3ee' : 'hsl(var(--app-text))',
            }}>
                {value}
            </span>
            <span style={{
                fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5,
                color: 'hsl(var(--app-text-muted))',
            }}>
                {label}
            </span>
        </div>
    )
}

/** Compass point for a bearing. Eight of them, not sixteen: the heading is a
 *  ground-projection estimate, and "NNE" claims a precision it does not have. */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
function compass(deg: number): string {
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

/** How a vehicle is moving relative to the drone, in one glanceable phrase.
 *  The compass bearing answers "which way on the ground"; the direction
 *  answers "is it coming at us", and neither substitutes for the other. */
function directionLabel(heading?: number | null, direction?: string | null): string | null {
    if (heading == null && !direction) return null
    const parts: string[] = []
    if (heading != null) parts.push(`${compass(heading)} ${Math.round(heading)}°`)
    if (direction && direction !== 'crossing') parts.push(direction)
    return parts.join(' · ')
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

    // Wrong-way vehicles float to the top of the list. The backend orders by
    // apparent size, which is right for "what is nearest" and wrong for "what
    // needs attention" — a car driving into the traffic could otherwise sit
    // ninth in a list the operator has to scroll.
    const vehicles = [...(cvResults?.vehicles ?? [])].sort(
        (a, b) => Number(b.against_flow ?? false) - Number(a.against_flow ?? false)
    )
    const againstFlow = cvResults?.against_flow_count ?? 0
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

    // ── Multi-follow ─────────────────────────────────────────────────────
    // A member's chip is labelled from whatever identifies it best: a plate
    // for a vehicle, a recognised name for a person, the track id otherwise.
    // A group of bare "#7 #12 #19" is a group nobody can decide what to drop
    // from, which is the one decision the operator has to make when the
    // aircraft reports it cannot frame them all.
    const followMembers = cvResults?.follow_members ?? []
    const memberLabel = (id: number) => {
        const v = vehicles.find(x => x.track_id === id)
        if (v) return v.plate || v.vehicle_id || `#${id}`
        const named = identities.find(i => i.track_id === id)?.name
        return named || `#${id}`
    }


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
        getSocket().emit('set_vehicle_tracking', { active })
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>

            {/* ── Counts ──────────────────────────────────────────────────
                A 3-column grid rather than a wrapping row of chips. Chips
                reflowed differently at every panel width, so the same figure
                moved around between glances and nothing could be found by
                position. A grid puts each number in a fixed place.

                "In frame" and "total" are deliberately separate everywhere
                they appear: they answer different questions, and conflating
                them is how traffic figures turn into fiction. */}
            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6,
            }}>
                <Stat label="in frame" value={cvResults?.vehicles_in_frame ?? 0} tone="cyan" />
                <Stat label="vehicles" value={cvResults?.vehicle_count_unique ?? 0} />
                <Stat label="plates" value={cvResults?.plates_read ?? 0} />
                <Stat label="people" value={cvResults?.person_count ?? 0} tone="cyan" />
                <Stat label="unique" value={cvResults?.person_count_unique ?? 0} />
                <Stat label="named" value={identities.length} />
            </div>

            {/* ── Against the flow ────────────────────────────────────────
                Pinned above the scrolling region, because it is the only thing
                in this panel that is an ALERT rather than a reading — and an
                alert that has to be scrolled to has already failed.

                The wording is deliberately "the traffic around it" and not
                "wrong way": there is no map here and no declared road
                direction, so what was actually measured is opposition to the
                local flow. Claiming more than that would make the first false
                positive look like a bug rather than a limit. */}
            {againstFlow > 0 && (
                <div style={{
                    display: 'flex', gap: 7, alignItems: 'center',
                    padding: '6px 9px', borderRadius: 7, fontSize: 11,
                    background: 'rgba(230,0,0,0.14)',
                    border: '1px solid rgba(230,0,0,0.45)', color: '#f87171',
                }}>
                    <TriangleAlert size={13} style={{ flexShrink: 0 }} />
                    <span>
                        <b>{againstFlow}</b>{' '}
                        {againstFlow === 1 ? 'vehicle is' : 'vehicles are'} driving
                        against the traffic around {againstFlow === 1 ? 'it' : 'them'}
                    </span>
                </div>
            )}

            {/* ── What is being ATTEMPTED, and why ─────────────────────
                Sits above the range readout because it is the actionable one:
                viability says what COULD resolve, this says what the frame
                budget is actually being spent on. A skipped plate read is
                otherwise indistinguishable from a failed one. */}
            {profile && <ProfileCard profile={profile} />}

            {/* ── Degraded-capability notices ─────────────────────────────
                One line, not three stacked paragraphs. These are all the same
                shape of statement — "X is unavailable, here is what still
                works" — and three of them took more vertical space than the
                vehicle list they were pushing off screen. */}
            {(!hasTelemetry || !alprOk || !facesOk) && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 10, lineHeight: 1.45, color: '#fbbf24',
                }}>
                    <AlertCircle size={11} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span>
                        {[
                            !hasTelemetry && 'no telemetry (speed needs altitude to convert pixels to metres)',
                            !alprOk && 'plate reader not loaded',
                            !facesOk && 'face recognition not loaded',
                        ].filter(Boolean).join(' · ')}
                        {' — everything else is unaffected.'}
                    </span>
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

            {/* ── Everything below scrolls as ONE region ──────────────────
                The panel had six stacked sections all competing for a fixed
                height, so the vehicle list — the part actually worth looking
                at — got squeezed to a few rows and the history was cut off
                entirely. Splitting it puts what you ACT on (counts, profile,
                follow) permanently in view, and lets the detail scroll instead
                of being clipped. */}
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 6 }}>

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
                    {/* Unique lives in the stat grid now; repeating it here
                        made two figures for one fact that could disagree
                        mid-update. Peak is the only one this row adds. */}
                    <span style={{ ...LABEL, marginLeft: 'auto', fontFamily: 'monospace' }}>
                        peak {cvResults?.peak_count ?? 0}
                        {cvResults?.trend_per_min != null && (
                            ` · ${cvResults.trend_per_min > 0 ? '+' : ''}${cvResults.trend_per_min}/min`
                        )}
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
                altitudeMode={cvResults?.altitude_mode}
                targetRatio={cvResults?.target_distance_ratio}
                actualFillPct={cvResults?.subject_fill_pct}
                elevate={elevate}
                onRelease={() => { arm(false); lock(null) }}
                multi={{
                    enabled: cvResults?.multi_follow ?? false,
                    members: followMembers,
                    max: cvResults?.max_follow_members ?? 4,
                    framing: cvResults?.group_framing ?? null,
                    labelFor: memberLabel,
                }}
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={LABEL}>Vehicles</span>
                    {vehicles.length > 0 && (
                        <span style={{ fontSize: 9, color: 'hsl(var(--app-text-muted))' }}>
                            click to lock — or click it on the video
                        </span>
                    )}
                </div>
                <div>
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
                                const wrongWay = v.against_flow === true
                                const showColour = v.color && v.color !== 'unknown'
                                    && (v.color_conf ?? 0) >= 0.35
                                const heading = directionLabel(v.heading_deg, v.direction)
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
                                            // Against-flow outranks the lock
                                            // highlight — it is the state the
                                            // operator most needs to find.
                                            background: wrongWay ? 'rgba(230,0,0,0.13)'
                                                : locked ? 'rgba(34,211,238,0.12)'
                                                : 'hsl(var(--app-surface-2))',
                                            border: `1px solid ${
                                                wrongWay ? 'rgba(230,0,0,0.45)'
                                                : locked ? 'rgba(34,211,238,0.45)'
                                                : 'transparent'}`,
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
                                            {/* Direction of travel. Absent rather
                                                than zeroed below ~5km/h, where a
                                                heading is atan2 of box jitter —
                                                a blank is honest, "N 0°" is not. */}
                                            {heading && (
                                                <span style={{
                                                    fontSize: 9, fontFamily: 'monospace',
                                                    color: wrongWay ? '#f87171'
                                                        : 'hsl(var(--app-text-muted))',
                                                }}>
                                                    {wrongWay ? 'AGAINST FLOW · ' : ''}{heading}
                                                </span>
                                            )}
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
                </div>
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

              </div>
            </ScrollArea>

            {/* ── History, PINNED TO THE BOTTOM ───────────────────────────
                Not part of the scrolling region. It is the one thing here that
                is a running record rather than a live reading, so it should
                stay put and be glanceable while the vehicle list above it
                scrolls — rather than being pushed off the end by however many
                vehicles happen to be in frame. */}
            {history.length > 0 && (
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 4,
                    paddingTop: 8, borderTop: '1px solid hsl(var(--app-border))',
                }}>
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

'use client'

// Traffic management - the composed vehicle module's panel.
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
import { TONE, LABEL, SECONDARY, NUM, TILE, TEXT, MUTED, BORDER, FOCUS, type Tone } from '@/components/vision/panelStyle'
import {
    fetchPlateHistory, downloadSessionReport, clearHistory, canClearHistory, toFileStamp,
    type PlateHistoryRow,
} from '@/lib/visionReports'

/** One figure in the stat grid. Value first and large, label under it - the
 *  number is what gets read at a glance and the label only disambiguates. */
function Stat({ label, value, tone = 'muted' }: {
    label: string; value: number | string; tone?: 'muted' | 'cyan'
}) {
    return (
        <div style={{
            ...TILE, display: 'flex', flexDirection: 'column', gap: 2,
            padding: '8px 10px', minWidth: 0,
        }}>
            <span style={{
                ...NUM, fontSize: 22, fontWeight: 700, lineHeight: 1.1,
                color: tone === 'cyan' ? TONE.accent.fg : TEXT,
            }}>
                {value}
            </span>
            <span style={{ ...LABEL, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
    return parts.join(', ')
}

const PROFILE_TONE: Record<string, Tone> = {
    survey: 'accent',
    identify: 'ok',
    forensic: 'accent',
}

/** What the current optics support, and the override that argues with it.
 *
 *  Shown as an override rather than a mode switch on purpose: an operator who
 *  forces plate OCR on at 40m should still be able to read that the plate is
 *  34px short of legible, so the automatic verdict stays visible next to the
 *  button that overrules it. */
function ProfileCard({ profile }: { profile: NonNullable<CVResult['profile']> }) {
    const t = TONE[PROFILE_TONE[profile.name] ?? 'accent']
    const tone = t.fg
    const set = (subject: string, mode: string) =>
        getSocket().emit('set_profile_override', { subject, mode })

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            ...TILE, padding: '8px 10px',
            border: `1px solid ${t.border}`,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Layers size={14} style={{ color: tone }} aria-hidden />
                <span style={{ fontSize: 14, fontWeight: 700, color: tone }}>
                    {profile.label}
                </span>
                <span style={{ ...SECONDARY, ...NUM, marginLeft: 'auto' }}>
                    {profile.ocr_calls > 0 ? `${profile.ocr_calls} reads/frame` : 'No plate reads'}
                </span>
            </div>

            {profile.headline && (
                <div style={SECONDARY}>
                    {profile.headline}
                </div>
            )}

            {profile.subjects.map(s => (
                <div key={s.subject} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                        width: 52, fontSize: 13, fontWeight: 600,
                        textTransform: 'capitalize',
                        color: s.attempt ? TONE.ok.fg : MUTED,
                    }}>
                        {s.subject}
                    </span>
                    <span style={{
                        flex: 1, minWidth: 0, fontSize: 12,
                        color: MUTED,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={s.reason}>
                        {s.reason}
                    </span>
                    {s.status !== 'unavailable' && (
                        <div style={{ display: 'flex', gap: 2 }} role="group" aria-label={`${s.subject} reading`}>
                            {(['auto', 'on', 'off'] as const).map(m => {
                                const active = m === 'auto' ? !s.forced
                                    : s.forced && (m === 'on') === s.attempt
                                return (
                                    <button
                                        key={m}
                                        type="button"
                                        onClick={() => set(s.subject, m)}
                                        aria-pressed={active}
                                        className={FOCUS}
                                        style={{
                                            minHeight: 28, padding: '0 8px', borderRadius: 6, fontSize: 12,
                                            fontWeight: active ? 700 : 600, cursor: 'pointer',
                                            border: `1px solid ${active ? t.border : BORDER}`,
                                            background: active ? t.bg : 'transparent',
                                            color: active ? tone : MUTED,
                                            textTransform: 'capitalize',
                                            transition: 'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
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
    // needs attention" - a car driving into the traffic could otherwise sit
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
    // operator doing anything - the final DB writes are fire-and-forget.
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
                <Stat label="In frame" value={cvResults?.vehicles_in_frame ?? 0} tone="cyan" />
                <Stat label="Vehicles" value={cvResults?.vehicle_count_unique ?? 0} />
                <Stat label="Plates" value={cvResults?.plates_read ?? 0} />
                <Stat label="People" value={cvResults?.person_count ?? 0} tone="cyan" />
                <Stat label="Unique" value={cvResults?.person_count_unique ?? 0} />
                <Stat label="Named" value={identities.length} />
            </div>

            {/* ── Against the flow ────────────────────────────────────────
                Pinned above the scrolling region, because it is the only thing
                in this panel that is an ALERT rather than a reading - and an
                alert that has to be scrolled to has already failed.

                The wording is deliberately "the traffic around it" and not
                "wrong way": there is no map here and no declared road
                direction, so what was actually measured is opposition to the
                local flow. Claiming more than that would make the first false
                positive look like a bug rather than a limit. */}
            {againstFlow > 0 && (
                <div style={{
                    display: 'flex', gap: 8, alignItems: 'center',
                    padding: '8px 10px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                    background: TONE.danger.bg,
                    border: `1px solid ${TONE.danger.border}`, color: TONE.danger.fg,
                }} role="alert">
                    <TriangleAlert size={16} style={{ flexShrink: 0 }} aria-hidden />
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
                shape of statement - "X is unavailable, here is what still
                works" - and three of them took more vertical space than the
                vehicle list they were pushing off screen. */}
            {(!hasTelemetry || !alprOk || !facesOk) && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 13, lineHeight: '18px', fontWeight: 600, color: TONE.warn.fg,
                }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span>
                        {[
                            !hasTelemetry && 'No telemetry, so no speed',
                            !alprOk && 'plate reader off',
                            !facesOk && 'face recognition off',
                        ].filter(Boolean).join(', ')}
                        {'. The rest works.'}
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
                            padding: '6px 10px', borderRadius: 10, fontSize: 13,
                            background: TONE.accent.bg,
                            border: `1px solid ${TONE.accent.border}`,
                        }}>
                            <span style={{ fontWeight: 700, color: TEXT }}>{id.name}</span>
                            <span style={{ ...NUM, marginLeft: 'auto', fontSize: 12, color: MUTED }}
                                title="Match score and how many frames agreed">
                                {id.similarity.toFixed(2)}
                                <span>, {id.votes} votes</span>
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Everything below scrolls as ONE region ──────────────────
                The panel had six stacked sections all competing for a fixed
                height, so the vehicle list - the part actually worth looking
                at - got squeezed to a few rows and the history was cut off
                entirely. Splitting it puts what you ACT on (counts, profile,
                follow) permanently in view, and lets the detail scroll instead
                of being clipped. */}
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 6 }}>

            {/* ── Crowd density ───────────────────────────────────────── */}
            {(cvResults?.person_count ?? 0) > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={LABEL}>Density</span>
                    <span style={{
                        display: 'inline-flex', alignItems: 'center', minHeight: 24,
                        padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700,
                        ...(() => {
                            const t = TONE[cvResults?.density_level === 'red' ? 'danger'
                                : cvResults?.density_level === 'orange' ? 'warn' : 'ok']
                            return { background: t.bg, color: t.fg, border: `1px solid ${t.border}` }
                        })(),
                    }}>
                        {cvResults?.density_level === 'red' ? 'Dense'
                            : cvResults?.density_level === 'orange' ? 'Moderate' : 'Light'}
                    </span>
                    {/* Unique lives in the stat grid now; repeating it here
                        made two figures for one fact that could disagree
                        mid-update. Peak is the only one this row adds. */}
                    <span style={{ ...NUM, marginLeft: 'auto', fontSize: 13, color: MUTED }}>
                        Peak {cvResults?.peak_count ?? 0}
                        {cvResults?.trend_per_min != null && (
                            `, ${cvResults.trend_per_min > 0 ? '+' : ''}${cvResults.trend_per_min}/min`
                        )}
                    </span>
                </div>
            )}

            {/* ── Lock + follow ───────────────────────────────────────────
                The SHARED control, so vehicles, people, crowds and person-ID
                all behave the same way - the inconsistency between four
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
                controller - and its opposite, a descent nobody could see, is
                what put an aircraft into the ground. */}
            {floorReason && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start',
                    fontSize: 13, lineHeight: '18px', fontWeight: 600, color: TONE.warn.fg,
                }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span>{floorReason}</span>
                </div>
            )}

            {/* ── Live vehicles ───────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={LABEL}>Vehicles</span>
                    {vehicles.length > 0 && (
                        <span style={{ fontSize: 12, color: MUTED }}>
                            Tap one to lock on
                        </span>
                    )}
                </div>
                <div>
                    {vehicles.length === 0 ? (
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            height: 100, ...SECONDARY, textAlign: 'center',
                        }}>
                            {cvResults ? 'No vehicles in frame' : 'Press Run to watch traffic'}
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
                                        // every frame - React tore down and
                                        // rebuilt the whole list ~15x a second.
                                        key={v.vehicle_id ?? v.track_id ?? `idx-${i}`}
                                        onClick={() => v.track_id != null
                                            && lock(locked ? null : v.track_id)}
                                        onKeyDown={e => {
                                            if ((e.key === 'Enter' || e.key === ' ') && v.track_id != null) {
                                                e.preventDefault(); lock(locked ? null : v.track_id)
                                            }
                                        }}
                                        role="button"
                                        tabIndex={0}
                                        aria-pressed={locked}
                                        className={FOCUS}
                                        title={locked ? 'Click to release' : 'Click to lock onto this vehicle'}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                                            // Against-flow outranks the lock
                                            // highlight - it is the state the
                                            // operator most needs to find.
                                            background: wrongWay ? TONE.danger.bg
                                                : locked ? TONE.accent.bg
                                                : 'hsl(var(--app-surface-2))',
                                            border: `1px solid ${
                                                wrongWay ? TONE.danger.border
                                                : locked ? TONE.accent.border
                                                : BORDER}`,
                                            transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                            <span className={v.plate ? 'font-code' : undefined} style={{
                                                fontSize: 14, fontWeight: 700,
                                                letterSpacing: '0.04em',
                                                // Toned by STRENGTH, not by whether the read
                                                // was allowed to exist. Green means two
                                                // frames agreed; amber is a single-frame
                                                // read, which at drone standoff is often
                                                // the only read a passing vehicle gives -
                                                // shown, logged, and marked rather than
                                                // discarded.
                                                color: !v.plate ? MUTED
                                                    : v.plate_strong ? TONE.ok.fg
                                                    : TONE.warn.fg,
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
                                                <span style={{ ...NUM, fontSize: 12, color: MUTED }}>
                                                    {v.plate_px_w}px across
                                                    {v.plate_grammar_ok === false && ', unusual format'}
                                                </span>
                                            )}
                                            <span style={{
                                                fontSize: 13, textTransform: 'capitalize',
                                                color: MUTED,
                                            }}>
                                                {/* vehicle_id, not the track id, is the
                                                    identity worth showing: it survives the
                                                    tracker renumbering on occlusion and is
                                                    what the exported report is keyed by. */}
                                                {[showColour ? v.color : null, v.type]
                                                    .filter(Boolean).join(' ')}
                                                {' '}({v.vehicle_id ?? `#${v.track_id}`})
                                            </span>
                                            {/* Direction of travel. Absent rather
                                                than zeroed below ~5km/h, where a
                                                heading is atan2 of box jitter -
                                                a blank is honest, "N 0°" is not. */}
                                            {heading && (
                                                <span style={{
                                                    ...NUM, fontSize: 12, fontWeight: wrongWay ? 700 : 400,
                                                    color: wrongWay ? TONE.danger.fg : MUTED,
                                                }}>
                                                    {wrongWay ? 'Against flow, ' : ''}{heading}
                                                </span>
                                            )}
                                        </div>
                                        {v.speed_kmh != null && (
                                            <span style={{
                                                ...NUM, marginLeft: 'auto', fontSize: 14, fontWeight: 700, flexShrink: 0,
                                                color: v.speed_reliable ? TEXT : TONE.warn.fg,
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
                    ...SECONDARY, ...NUM, lineHeight: 1.6,
                }}>
                    {Object.entries(cvResults?.vehicle_types ?? {})
                        .map(([k, n]) => `${n} ${k}`).join(', ')}
                    {Object.keys(cvResults?.vehicle_colors ?? {}).length > 0 && (
                        <><br />{Object.entries(cvResults?.vehicle_colors ?? {})
                            .map(([k, n]) => `${n} ${k}`).join(', ')}</>
                    )}
                </div>
            )}

              </div>
            </ScrollArea>

            {/* ── History, PINNED TO THE BOTTOM ───────────────────────────
                Not part of the scrolling region. It is the one thing here that
                is a running record rather than a live reading, so it should
                stay put and be glanceable while the vehicle list above it
                scrolls - rather than being pushed off the end by however many
                vehicles happen to be in frame. */}
            {history.length > 0 && (
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 4,
                    paddingTop: 8, borderTop: `1px solid ${BORDER}`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={LABEL}>Logged plates</span>
                        <button
                            onClick={() => downloadSessionReport(
                                history[0].session_id, 'plate-report',
                                toFileStamp(history[0].first_seen),
                            )}
                            type="button"
                            className={FOCUS}
                            style={{
                                marginLeft: 'auto', border: 'none', background: 'none',
                                cursor: 'pointer', color: TEXT, minHeight: 32, padding: '0 6px', borderRadius: 6,
                                display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 600,
                            }}
                        >
                            <Download size={14} aria-hidden /> Report
                        </button>
                        {canClearHistory() && <button
                            onClick={async () => { await clearHistory('plate-history'); loadHistory() }}
                            type="button"
                            className={FOCUS}
                            style={{
                                border: 'none', background: 'none', cursor: 'pointer',
                                color: TONE.danger.fg, display: 'flex', alignItems: 'center', gap: 4,
                                fontSize: 13, fontWeight: 600, minHeight: 32, padding: '0 6px', borderRadius: 6,
                            }}
                        >
                            <Trash2 size={14} aria-hidden /> Clear
                        </button>}
                    </div>
                    <div style={{ maxHeight: 96, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {history.slice(0, 12).map(ev => (
                            <div key={ev.id} style={{
                                ...NUM, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13,
                                color: MUTED,
                            }}>
                                <span className="font-code" style={{ color: TEXT, fontWeight: 700 }}>{ev.plate_text}</span>
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

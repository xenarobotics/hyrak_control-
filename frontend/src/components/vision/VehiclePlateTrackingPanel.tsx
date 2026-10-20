'use client'

// Vehicle / number-plate tracking - identify, tag, and follow ONE vehicle.
//
// Every tracked vehicle carries a persistent vehicle_id (survives a
// ByteTrack id change via a re-read plate) plus whatever has been captured
// about it: plate, colour, type, speed. Clicking a row locks onto that
// vehicle (the same action as clicking it on the video), and a separate
// Follow control arms the flight command, so locking and flying are two
// deliberate steps rather than one.

import { useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getSocket } from '@/lib/socket'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertCircle, Download, Trash2 } from 'lucide-react'
import { FollowControls } from '@/components/vision/FollowControls'
import { fetchPlateHistory, plateImagePath, downloadSessionReport, clearHistory, canClearHistory, toFileStamp, shortLocation, type PlateHistoryRow } from '@/lib/visionReports'
import { useApiObjectUrl } from '@/hooks/useApiMedia'
import { TONE, LABEL, SECONDARY, NUM, TILE, TEXT, MUTED, BORDER, FOCUS, chip, btn } from '@/components/vision/panelStyle'

const DIST_DEFAULT = 0.22

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'cyan' }) {
    return (
        <div style={chip(tone === 'cyan' ? 'accent' : 'muted')}>
            {children}
        </div>
    )
}

export function VehiclePlateTrackingPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const { isStreaming } = useWebRTCContext()
    const [history, setHistory] = useState<PlateHistoryRow[]>([])

    const vehicles = cvResults?.vehicles ?? []
    const lockedTrackId = cvResults?.locked_track_id ?? null
    const lockedVehicleId = cvResults?.locked_vehicle_id ?? null
    const lockedPlate = cvResults?.locked_plate ?? null
    const lockState = cvResults?.lock_state ?? 'idle'
    const lockMessage = cvResults?.lock_message ?? ''
    const elevate = cvResults?.elevate ?? null
    const hasTelemetry = cvResults?.has_telemetry !== false
    const alprOk = cvResults?.alpr_available !== false
    const inFrame = cvResults?.vehicles_in_frame ?? 0
    const uniqueTotal = cvResults?.vehicle_count_unique ?? 0
    const vehicleTypes = cvResults?.vehicle_types ?? {}
    const vehicleColors = cvResults?.vehicle_colors ?? {}
    const actualFillPct = cvResults?.vehicle_fill_pct ?? null




    const loadHistory = () => fetchPlateHistory(50).then(setHistory)
    useEffect(() => { loadHistory() }, [])

    // Refresh the moment a session stops so the newest reads show up
    // without the operator doing anything - give the last async DB writes
    // (fire-and-forget from stream_track.py) a moment to land first.
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

    // One download button per SESSION, not per plate - shown on the first
    // (most recent) row belonging to that session, since `history` is
    // already ordered most-recent-first.
    const seenSessions = new Set<string>()
    const firstRowOfSession = new Set<string>()
    for (const ev of history) {
        if (!seenSessions.has(ev.session_id)) {
            seenSessions.add(ev.session_id)
            firstRowOfSession.add(ev.id)
        }
    }

    // Which session the top-level Report button exports: the live one while
    // streaming, otherwise the most recent one that actually has rows.
    const reportSession = cvResults?.session_id ?? history[0]?.session_id ?? null
    const reportStamp = cvResults?.session_id
        ? new Date().toISOString()
        : history[0]?.first_seen ?? null

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>

            {/* ── Counts + report ─────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip tone="cyan">{inFrame} in frame</Chip>
                {/* Reported separately from "in frame" because they answer
                    different questions, and conflating them is how traffic
                    figures become fiction. */}
                <Chip>{uniqueTotal} total</Chip>
                <Chip>{cvResults?.plate_count ?? 0} plates read</Chip>
                {/* Always offered, not hidden behind a history row: the ZIP
                    (photos + CSV) is the deliverable, and it was previously
                    only reachable via a per-session icon that never appeared
                    when no rows had been written. */}
                {reportSession && (
                    <button
                        onClick={() => downloadSessionReport(
                            reportSession, 'plate-report', toFileStamp(reportStamp),
                        )}
                        type="button"
                        title="Download photos + CSV for this session"
                        className={FOCUS}
                        style={{ ...btn(), marginLeft: 'auto' }}
                    >
                        <Download size={14} aria-hidden /> Report
                    </button>
                )}
            </div>

            {/* ── Degraded-capability notices ─────────────────────────── */}
            {cvResults?.speed_note && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13,
                    lineHeight: '18px', fontWeight: 600, color: TONE.warn.fg,
                }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span>No speed: {cvResults.speed_note}.</span>
                </div>
            )}
            {!hasTelemetry && !cvResults?.speed_note && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13,
                    lineHeight: '18px', fontWeight: 600, color: TONE.warn.fg,
                }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span title="Speed needs the drone's altitude to turn pixels into metres, so it is left out rather than guessed.">
                        No telemetry, so no speed.
                    </span>
                </div>
            )}
            {!alprOk && (
                <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: '18px', fontWeight: 600, color: TONE.warn.fg }}>
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
                    <span>Plate reader off. Tracking still works.</span>
                </div>
            )}

            <FollowControls
                kind="vehicle"
                selectedLabel={lockedTrackId !== null
                    ? `${lockedVehicleId ?? `#${lockedTrackId}`}${lockedPlate ? `  ${lockedPlate}` : ''}`
                    : null}
                lockState={lockState}
                lockMessage={lockMessage}
                altitudeMode={cvResults?.altitude_mode}
                targetRatio={cvResults?.target_distance_ratio}
                actualFillPct={actualFillPct}
                elevate={elevate}
                onRelease={() => { arm(false); lock(null) }}
            />

            {/* ── Live vehicles ───────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={LABEL}>Vehicles</span>
                    {vehicles.length > 0 && (
                        <span style={{ fontSize: 12, color: MUTED }}>
                            Tap one to lock on
                        </span>
                    )}
                </div>
                <ScrollArea style={{ flex: 1 }}>
                    {vehicles.length === 0 ? (
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            height: 100, ...SECONDARY, textAlign: 'center',
                        }}>
                            {cvResults ? 'No vehicles in frame' : 'Press Run to track vehicles'}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 }}>
                            {vehicles.map((v, i) => {
                                const locked = v.track_id === lockedTrackId
                                const showColour = v.color && v.color !== 'unknown'
                                    && (v.color_conf ?? 0) >= 0.35
                                return (
                                    <div
                                        // vehicle_id survives the tracker renumbering on
                                        // occlusion. Math.random() here gave every
                                        // row a new key each frame, so React tore the
                                        // list down and rebuilt it ~15x a second.
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
                                            background: locked ? TONE.accent.bg : 'hsl(var(--app-surface-2))',
                                            border: `1px solid ${locked ? TONE.accent.border : BORDER}`,
                                            transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                                {v.vehicle_id && (
                                                    <span className="font-code" style={{ fontSize: 12, color: MUTED }}>
                                                        {v.vehicle_id}
                                                    </span>
                                                )}
                                                <span className={v.plate ? 'font-code' : undefined} style={{
                                                    fontSize: 14, fontWeight: 700,
                                                    letterSpacing: '0.04em',
                                                    // Green once independent frames agree, amber on
                                                    // a single-frame read. Both are shown and both
                                                    // are logged - suppressing the amber ones
                                                    // discarded nearly every real plate this rig
                                                    // captures.
                                                    color: !v.plate ? MUTED
                                                        : v.plate_strong ? TONE.ok.fg : TONE.warn.fg,
                                                }}>
                                                    {v.plate
                                                        ? `${v.plate}${v.plate_strong ? '' : '?'}`
                                                        : 'no plate'}
                                                </span>
                                                {v.plate && (v.plate_px_w ?? 0) > 0 && (
                                                    // The honest quality number: a 40px read and a
                                                    // 300px read are not equally trustworthy.
                                                    <span style={{ ...NUM, fontSize: 12, color: MUTED }}
                                                        title="Plate width in pixels, and how many frames agreed">
                                                        {v.plate_px_w}px
                                                        {v.plate_votes ? ` · ${v.plate_votes} votes` : ''}
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{
                                                fontSize: 13, textTransform: 'capitalize',
                                                color: MUTED,
                                            }}>
                                                {[showColour ? v.color : null,
                                                  v.type !== 'unknown' ? v.type : null]
                                                    .filter(Boolean).join(' ') || 'vehicle'}
                                            </span>
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
                </ScrollArea>
            </div>

            {/* ── Session breakdown ───────────────────────────────────── */}
            {(Object.keys(vehicleTypes).length > 0
              || Object.keys(vehicleColors).length > 0) && (
                <div style={{
                    ...SECONDARY, ...NUM, lineHeight: 1.6,
                }}>
                    {Object.entries(vehicleTypes).map(([k, n]) => `${n} ${k}`).join(' · ')}
                    {Object.keys(vehicleColors).length > 0 && (
                        <><br />{Object.entries(vehicleColors)
                            .map(([k, n]) => `${n} ${k}`).join(' · ')}</>
                    )}
                </div>
            )}

            {/* ── Recent (bottom half) - always visible, no tab click ──── */}
            <div style={{
                flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6,
                borderTop: `1px solid ${BORDER}`, paddingTop: 8,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{ ...LABEL, margin: 0 }}>Recent vehicles</p>
                    {canClearHistory() && <button
                        onClick={() => clearHistory('plate-history').then(ok => { if (ok) loadHistory() })}
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
                    {history.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}>
                            {history.map(ev => {
                                const loc = shortLocation(ev.lat, ev.lng)
                                const isFirstOfSession = firstRowOfSession.has(ev.id)
                                return (
                                    <div key={ev.id} style={{
                                        ...TILE, display: 'flex', gap: 8, padding: 8,
                                    }}>
                                        <PlateThumb eventId={ev.image_path ? ev.id : null} alt={ev.plate_text || 'vehicle'} />
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                                {ev.vehicle_id && (
                                                    <span className="font-code" style={{ fontSize: 12, color: MUTED }}>
                                                        {ev.vehicle_id}
                                                    </span>
                                                )}
                                                {/* A row exists per VEHICLE now, so a blank plate is
                                                    a normal outcome - most vehicles never turn a
                                                    readable plate toward the camera. */}
                                                <span className={ev.plate_text ? 'font-code' : undefined} style={{
                                                    fontSize: 14, fontWeight: 700,
                                                    letterSpacing: '0.04em',
                                                    color: ev.plate_text ? TEXT : MUTED,
                                                }}>
                                                    {ev.plate_text || 'no plate'}
                                                </span>
                                                {ev.plate_text && ev.plate_px_w > 0 && (
                                                    <span style={{ ...NUM, fontSize: 12, color: MUTED }}>
                                                        {ev.plate_px_w}px
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{ ...NUM, fontSize: 13, color: MUTED, textTransform: 'capitalize' }}>
                                                {[ev.vehicle_color, ev.vehicle_type].filter(Boolean).join(' ') || 'unknown'}
                                                {ev.speed_est_kmh != null && ` · ~${Math.round(ev.speed_est_kmh)} km/h`}
                                            </span>
                                            <span style={{ ...NUM, fontSize: 12, color: MUTED }}>
                                                {ev.first_seen ? new Date(ev.first_seen).toLocaleString() : ''}
                                                {loc && ` · ${loc}`}
                                            </span>
                                        </div>
                                        {isFirstOfSession && (
                                            <button
                                                onClick={() => downloadSessionReport(ev.session_id, 'plate-report', toFileStamp(ev.first_seen))}
                                                type="button"
                                                title="Download this session's report"
                                                aria-label="Download this session's report"
                                                className={FOCUS}
                                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, flexShrink: 0, alignSelf: 'flex-start' }}
                                            >
                                                <Download size={14} aria-hidden />
                                            </button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80,
                            ...SECONDARY, textAlign: 'center',
                        }}>
                            No previous plates logged yet
                        </div>
                    )}
                </ScrollArea>
            </div>
        </div>
    )
}

/** The plate crop. The image route needs the bearer, which an <img> cannot
 *  send, so it is fetched into an object URL (revoked on unmount). */
function PlateThumb({ eventId, alt }: { eventId: string | null; alt: string }) {
    const src = useApiObjectUrl(eventId ? plateImagePath(eventId) : null)
    const box: React.CSSProperties = { width: 52, height: 40, borderRadius: 6, flexShrink: 0 }
    if (!src) return <div style={{ ...box, background: BORDER }} aria-hidden />
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} style={{ ...box, objectFit: 'cover' }} />
}

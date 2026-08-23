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
import { fetchPlateHistory, plateImageUrl, downloadSessionReport, clearHistory, toFileStamp, shortLocation, type PlateHistoryRow } from '@/lib/visionReports'

const LABEL: React.CSSProperties = {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6,
    color: 'hsl(var(--app-text-muted))',
}

const DIST_DEFAULT = 0.22

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
                        title="Download photos + CSV for this session"
                        style={{
                            marginLeft: 'auto', display: 'flex', alignItems: 'center',
                            gap: 5, padding: '4px 10px', borderRadius: 8, fontSize: 11,
                            cursor: 'pointer', border: '1px solid #22d3ee55',
                            background: 'rgba(34,211,238,0.12)', color: '#22d3ee',
                        }}
                    >
                        <Download size={12} /> Report
                    </button>
                )}
            </div>

            {/* ── Degraded-capability notices ─────────────────────────── */}
            {cvResults?.speed_note && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
                    lineHeight: 1.5, color: '#fbbf24',
                }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>Speed unavailable - {cvResults.speed_note}.</span>
                </div>
            )}
            {!hasTelemetry && !cvResults?.speed_note && (
                <div style={{
                    display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
                    lineHeight: 1.5, color: '#fbbf24',
                }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>
                        No telemetry - speed needs altitude to convert pixels to
                        metres, so it is omitted rather than guessed.
                    </span>
                </div>
            )}
            {!alprOk && (
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: '#fbbf24' }}>
                    <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>Plate reader unavailable - identification and tracking still work.</span>
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
                        <span style={{ fontSize: 9, color: 'hsl(var(--app-text-muted))' }}>
                            click to lock - or click it on the video
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
                            {cvResults ? 'No vehicles in frame' : 'Start stream to track vehicles'}
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
                                        title={locked ? 'Click to release' : 'Click to lock onto this vehicle'}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '6px 9px', borderRadius: 7, cursor: 'pointer',
                                            background: locked ? 'rgba(34,211,238,0.12)' : 'hsl(var(--app-surface-2))',
                                            border: `1px solid ${locked ? 'rgba(34,211,238,0.45)' : 'transparent'}`,
                                        }}
                                    >
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                                {v.vehicle_id && (
                                                    <span style={{
                                                        fontSize: 9.5, fontFamily: 'monospace',
                                                        color: 'hsl(var(--app-text-muted))',
                                                    }}>
                                                        {v.vehicle_id}
                                                    </span>
                                                )}
                                                <span style={{
                                                    fontSize: 12, fontWeight: 700,
                                                    fontFamily: 'var(--font-geist-mono)',
                                                    letterSpacing: '0.04em',
                                                    // Green once independent frames agree, amber on
                                                    // a single-frame read. Both are shown and both
                                                    // are logged - suppressing the amber ones
                                                    // discarded nearly every real plate this rig
                                                    // captures.
                                                    color: !v.plate ? 'hsl(var(--app-text-muted))'
                                                        : v.plate_strong ? '#4ade80' : '#fbbf24',
                                                }}>
                                                    {v.plate
                                                        ? `${v.plate}${v.plate_strong ? '' : '?'}`
                                                        : 'no plate'}
                                                </span>
                                                {v.plate && (v.plate_px_w ?? 0) > 0 && (
                                                    // The honest quality number: a 40px read and a
                                                    // 300px read are not equally trustworthy.
                                                    <span style={{
                                                        fontSize: 9, fontFamily: 'monospace',
                                                        color: 'hsl(var(--app-text-muted))',
                                                    }}>
                                                        {v.plate_px_w}px
                                                        {v.plate_votes ? ` ·${v.plate_votes}v` : ''}
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{
                                                fontSize: 10, textTransform: 'capitalize',
                                                color: 'hsl(var(--app-text-muted))',
                                            }}>
                                                {[showColour ? v.color : null,
                                                  v.type !== 'unknown' ? v.type : null]
                                                    .filter(Boolean).join(' ') || 'vehicle'}
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
            {(Object.keys(vehicleTypes).length > 0
              || Object.keys(vehicleColors).length > 0) && (
                <div style={{
                    fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6,
                    color: 'hsl(var(--app-text-muted))',
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
                borderTop: '1px solid hsl(var(--app-border))', paddingTop: 8,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{ fontSize: 10, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace', margin: 0, letterSpacing: '0.06em' }}>
                        RECENT VEHICLES
                    </p>
                    <button
                        onClick={() => clearHistory('plate-history').then(ok => { if (ok) loadHistory() })}
                        title="Clear all history"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--app-text-muted))', display: 'flex' }}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
                <ScrollArea style={{ flex: 1 }}>
                    {history.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}>
                            {history.map(ev => {
                                const loc = shortLocation(ev.lat, ev.lng)
                                const isFirstOfSession = firstRowOfSession.has(ev.id)
                                return (
                                    <div key={ev.id} style={{
                                        display: 'flex', gap: 8, padding: 8, borderRadius: 8,
                                        background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                                    }}>
                                        {ev.image_path ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={plateImageUrl(ev.id)}
                                                alt={ev.plate_text || 'vehicle'}
                                                style={{ width: 52, height: 40, objectFit: 'cover', borderRadius: 5, flexShrink: 0 }}
                                            />
                                        ) : (
                                            <div style={{ width: 52, height: 40, borderRadius: 5, background: 'hsl(var(--app-border))', flexShrink: 0 }} />
                                        )}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                                {ev.vehicle_id && (
                                                    <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                                        {ev.vehicle_id}
                                                    </span>
                                                )}
                                                {/* A row exists per VEHICLE now, so a blank plate is
                                                    a normal outcome - most vehicles never turn a
                                                    readable plate toward the camera. */}
                                                <span style={{
                                                    fontSize: 12.5, fontWeight: 700,
                                                    fontFamily: 'var(--font-geist-mono)',
                                                    letterSpacing: '0.04em',
                                                    color: ev.plate_text ? undefined : 'hsl(var(--app-text-muted))',
                                                }}>
                                                    {ev.plate_text || 'no plate'}
                                                </span>
                                                {ev.plate_text && ev.plate_px_w > 0 && (
                                                    <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                                        {ev.plate_px_w}px
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{ fontSize: 9.5, color: 'hsl(var(--app-text-muted))', textTransform: 'capitalize' }}>
                                                {[ev.vehicle_color, ev.vehicle_type].filter(Boolean).join(' ') || 'unknown'}
                                                {ev.speed_est_kmh != null && ` · ~${Math.round(ev.speed_est_kmh)} km/h`}
                                            </span>
                                            <span style={{ fontSize: 9, color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace' }}>
                                                {ev.first_seen ? new Date(ev.first_seen).toLocaleString() : ''}
                                                {loc && ` · ${loc}`}
                                            </span>
                                        </div>
                                        {isFirstOfSession && (
                                            <button
                                                onClick={() => downloadSessionReport(ev.session_id, 'plate-report', toFileStamp(ev.first_seen))}
                                                title="Download this session's report"
                                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--app-text-muted))', display: 'flex', alignSelf: 'flex-start' }}
                                            >
                                                <Download size={13} />
                                            </button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80,
                            color: 'hsl(var(--app-text-muted))', fontSize: 11, fontFamily: 'monospace', textAlign: 'center',
                        }}>
                            No previous plates logged yet
                        </div>
                    )}
                </ScrollArea>
            </div>
        </div>
    )
}

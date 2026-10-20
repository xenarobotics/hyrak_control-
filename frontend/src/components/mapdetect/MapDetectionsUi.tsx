'use client'

// The visible parts of "detections on the map" that are not markers:
//
//   SightingsLegend      on every live map: counts per class, Show toggle,
//                        Clear, the empty state and why nothing is placed
//   MapDetectionsControls in the AI results panel: Show on map, Record to
//                        map, the first-use line and the camera-angle prompt
//   FirstUseNote / CameraAnglePrompt   shared by both

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, Circle as Dot, MapPin } from 'lucide-react'
import {
    REASON_TEXT, clearLive, classColor, countsByLabel, setRecording, type Sighting,
} from '@/lib/mapSightings'
import { useCameraPref, useFirstUse, useLiveSightings } from './useLiveSightings'
import { SightingsLayer } from './SightingsLayer'
import { FOCUS, FOCUS_OVERLAY } from '@/components/mission/ui'

const SETTINGS_TAB_KEY = 'hyrak-settings-tab'

function openVideoSettings() {
    try { localStorage.setItem(SETTINGS_TAB_KEY, JSON.stringify('video')) } catch { /* the page opens on its default tab */ }
}

/** "Camera angle not set": only while neither a gimbal nor the operator
 *  has said where the camera points. */
export function CameraAnglePrompt({ tone = 'dark', short = false }: { tone?: 'dark' | 'app'; short?: boolean }) {
    const pref = useCameraPref()
    const { camera } = useLiveSightings()
    if (pref.set || camera?.gimbal) return null
    const color = tone === 'dark' ? 'var(--overlay-warn)' : 'var(--app-warn)'
    return (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color, fontWeight: 600 }}>
            {short
                ? 'Camera angle not set (assuming straight down). '
                : 'Camera angle not set: positions assume the camera points straight down with an 80° lens. '}
            <Link href="/settings" onClick={openVideoSettings} className={tone === 'dark' ? FOCUS_OVERLAY : FOCUS}
                style={{ color, textDecoration: 'underline', fontWeight: 600 }}>
                Set camera angle
            </Link>
        </p>
    )
}

export function FirstUseNote({ tone = 'dark', short = false }: { tone?: 'dark' | 'app'; short?: boolean }) {
    const [show, dismiss] = useFirstUse()
    const { nominalAccuracy } = useLiveSightings()
    if (!show) return null
    const acc = nominalAccuracy != null ? `, about +/- ${nominalAccuracy} m` : ''
    const text = short
        ? `Positions are estimates from GPS, height and camera angle${acc}.`
        : `Positions are estimated from the drone's GPS, height and camera angle${
            nominalAccuracy != null ? `, about +/- ${nominalAccuracy} m at the current height`
                : ': a few metres when low and looking straight down, more when high or looking ahead'}.`
    return (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45,
            color: tone === 'dark' ? 'var(--overlay-muted)' : 'hsl(var(--app-text-muted))' }}>
            {text}{' '}
            <button type="button" onClick={dismiss} className={tone === 'dark' ? FOCUS_OVERLAY : FOCUS}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'inherit', textDecoration: 'underline', font: 'inherit' }}>
                Hide tip
            </button>
        </p>
    )
}

function ClassRows({ list }: { list: Sighting[] }) {
    return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {countsByLabel(list).map(([label, n]) => (
                <li key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                        background: classColor(label), border: '1.5px solid var(--overlay-text)' }} />
                    <span style={{ textTransform: 'capitalize', flex: 1, minWidth: 0, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'var(--overlay-text)' }}>{n}</span>
                </li>
            ))}
        </ul>
    )
}

// Drawn on map tiles: the always-dark overlay set (same in both themes).
const BOX: React.CSSProperties = {
    background: 'var(--overlay-scrim)', border: '1px solid var(--overlay-border)', borderRadius: 10,
    color: 'var(--overlay-text)', fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
}

const SMALL_BTN: React.CSSProperties = {
    minHeight: 32, padding: '0 12px', borderRadius: 6, border: '1px solid var(--overlay-border)',
    background: 'rgba(255,255,255,0.06)', color: 'var(--overlay-text)', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
}

/**
 * On a live map. `compact` (a picture-in-picture minimap): a count chip only.
 * Hidden entirely while no model is running and nothing was placed.
 */
export function SightingsLegend({ compact = false, style }: { compact?: boolean; style?: React.CSSProperties }) {
    const s = useLiveSightings()
    const [collapsed, setCollapsed] = useState(false)
    const [clearing, setClearing] = useState(false)
    const [clearFailed, setClearFailed] = useState(false)
    if (!s.modelRunning && s.list.length === 0) return null

    if (compact) {
        if (!s.show || s.list.length === 0) return null
        return (
            <div style={{ ...BOX, position: 'absolute', zIndex: 1000, padding: '2px 8px', display: 'flex',
                alignItems: 'center', gap: 4, pointerEvents: 'none', fontSize: 12, fontWeight: 700, borderRadius: 999, ...style }}
                aria-label={`${s.list.length} detections on the map`}>
                <MapPin size={12} /> {s.list.length}
            </div>
        )
    }

    const clear = async () => {
        if (!s.sessionId) return
        setClearing(true)
        setClearFailed(false)
        const ok = await clearLive(s.sessionId)
        setClearing(false)
        setClearFailed(!ok)
    }

    return (
        <section aria-label="Detections on the map"
            style={{ ...BOX, position: 'absolute', zIndex: 1000, padding: '8px 8px 10px 12px', width: 236,
                maxWidth: 'calc(100% - 24px)', ...style }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 32,
                    fontWeight: 700, fontSize: 14, color: 'var(--overlay-text)', flex: 1 }}>
                    <input type="checkbox" checked={s.show} onChange={e => s.setShow(e.target.checked)}
                        className={FOCUS_OVERLAY}
                        style={{ accentColor: 'var(--overlay-accent)', cursor: 'pointer', width: 16, height: 16 }} />
                    Detections
                    {s.list.length > 0 && <span style={{ fontWeight: 700, fontSize: 12, padding: '0 7px', borderRadius: 999,
                        border: '1px solid var(--overlay-border)', color: 'var(--overlay-text)', fontVariantNumeric: 'tabular-nums' }}>{s.list.length}</span>}
                </label>
                {s.recording && (
                    <span title="Saved with the flight (Settings > Flights)"
                        style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--overlay-danger)', fontSize: 12, fontWeight: 700 }}>
                        <Dot size={8} fill="currentColor" /> Rec
                    </span>
                )}
                <button type="button" onClick={() => setCollapsed(c => !c)}
                    aria-label={collapsed ? 'Expand the detections legend' : 'Collapse the detections legend'}
                    aria-expanded={!collapsed}
                    className={FOCUS_OVERLAY}
                    style={{ background: 'none', border: 'none', color: 'var(--overlay-muted)', cursor: 'pointer', width: 32, height: 32,
                        borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
            </div>
            {!collapsed && s.show && (
                <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {s.list.length > 0 ? <ClassRows list={s.list} /> : (
                        <p style={{ margin: 0, lineHeight: 1.45, color: 'var(--overlay-muted)' }}>
                            {s.reason ? REASON_TEXT[s.reason] : 'No detections yet. Run a model and fly over the area.'}
                        </p>
                    )}
                    {s.list.length > 0 && s.reason && <p style={{ margin: 0, lineHeight: 1.45, fontWeight: 600, color: 'var(--overlay-warn)' }}>{REASON_TEXT[s.reason]}</p>}
                    {s.capped && (
                        <p style={{ margin: 0, lineHeight: 1.45, fontWeight: 600, color: 'var(--overlay-warn)' }}>
                            Map full (5000). Clear it to place new ones.
                        </p>
                    )}
                    <FirstUseNote short />
                    <CameraAnglePrompt short />
                    {s.list.length > 0 && s.mayEdit && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button type="button" onClick={() => void clear()} disabled={clearing}
                                aria-busy={clearing}
                                title={s.recording ? 'Empties this map. Recorded detections stay in Settings > Flights.' : 'Empties this map.'}
                                className={FOCUS_OVERLAY}
                                style={{ ...SMALL_BTN, cursor: clearing ? 'wait' : 'pointer', color: clearing ? 'var(--overlay-muted)' : SMALL_BTN.color }}>
                                {clearing ? 'Clearing...' : 'Clear map'}
                            </button>
                            {clearFailed && <span role="alert" style={{ color: 'var(--overlay-danger)', fontWeight: 600 }}>Not cleared. Try again.</span>}
                        </div>
                    )}
                </div>
            )}
        </section>
    )
}

/** In the AI results panel: the two toggles, first-use line and camera prompt. */
export function MapDetectionsControls() {
    const s = useLiveSightings()
    if (!s.modelRunning) return null
    const recordDisabled = !s.mayEdit || !s.canRecord || !s.sessionId
    const recordWhy = !s.mayEdit
        ? `Recording needs ${s.customer ? 'fly access on this workspace' : 'the operator role'}.`
        : !s.canRecord ? 'Recording is unavailable right now: the database is offline.' : undefined
    const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, minHeight: 32 }
    return (
        <section aria-label="Detections on the map"
            className="rounded-[10px] border border-app-border bg-app-surface-2 p-3 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.05em] text-app-text-muted">
                <MapPin size={13} /> Map
                {s.list.length > 0 && <span className="ml-auto normal-case tracking-normal text-[13px] font-semibold text-app-text tabular-nums">{s.list.length} placed</span>}
            </div>
            <label style={row}>
                <input type="checkbox" checked={s.show} onChange={e => s.setShow(e.target.checked)}
                    className={FOCUS} style={{ accentColor: 'var(--app-accent)', width: 16, height: 16 }} />
                <span style={{ color: 'hsl(var(--app-text))' }}>Show detections on map</span>
            </label>
            <label style={{ ...row, cursor: recordDisabled ? 'not-allowed' : 'pointer' }}
                title={recordWhy}>
                <input type="checkbox" checked={s.recording} disabled={recordDisabled}
                    onChange={e => setRecording(e.target.checked)} className={FOCUS}
                    style={{ accentColor: 'var(--app-danger)', width: 16, height: 16 }} />
                <span style={{ color: recordDisabled ? 'hsl(var(--app-text-muted))' : 'hsl(var(--app-text))' }}>Record to map</span>
                <span style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))' }}>
                    {s.recording ? 'saving with this flight' : 'saves them for later'}
                </span>
            </label>
            {recordWhy && <p style={{ margin: 0, fontSize: 13, color: 'hsl(var(--app-text-muted))' }}>{recordWhy}</p>}
            {s.reason && <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--app-warn)' }}>{REASON_TEXT[s.reason]}</p>}
            <FirstUseNote tone="app" />
            <CameraAnglePrompt tone="app" />
        </section>
    )
}

/** Inside a live <MapContainer>: the session's sightings, when shown. */
export function LiveSightingsLayer() {
    const s = useLiveSightings()
    if (!s.show || s.list.length === 0) return null
    return <SightingsLayer list={s.list} />
}

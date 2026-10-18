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

const SETTINGS_TAB_KEY = 'hyrak-settings-tab'

function openVideoSettings() {
    try { localStorage.setItem(SETTINGS_TAB_KEY, JSON.stringify('video')) } catch { /* the page opens on its default tab */ }
}

/** "Camera angle not set": only while neither a gimbal nor the operator
 *  has said where the camera points. */
export function CameraAnglePrompt({ tone = 'dark' }: { tone?: 'dark' | 'app' }) {
    const pref = useCameraPref()
    const { camera } = useLiveSightings()
    if (pref.set || camera?.gimbal) return null
    const color = tone === 'dark' ? '#fcd34d' : '#d97706'
    return (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color }}>
            Camera angle not set: positions assume the camera points straight down with an
            80° lens.{' '}
            <Link href="/settings" onClick={openVideoSettings}
                style={{ color, textDecoration: 'underline', fontWeight: 600 }}>
                Set camera angle
            </Link>
        </p>
    )
}

export function FirstUseNote({ tone = 'dark' }: { tone?: 'dark' | 'app' }) {
    const [show, dismiss] = useFirstUse()
    const { nominalAccuracy } = useLiveSightings()
    if (!show) return null
    const acc = nominalAccuracy != null
        ? `about +/- ${nominalAccuracy} m at the current height`
        : 'a few metres when low and straight down, more when high or looking ahead'
    return (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5,
            color: tone === 'dark' ? '#cbd5e1' : 'hsl(var(--app-text-muted))' }}>
            Positions are estimated from the drone&apos;s GPS, height and camera angle, {acc}.{' '}
            <button type="button" onClick={dismiss}
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
                    <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                        background: classColor(label), border: '1.5px solid #fff' }} />
                    <span style={{ textTransform: 'capitalize', flex: 1, minWidth: 0, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: '#e5e7eb' }}>{n}</span>
                </li>
            ))}
        </ul>
    )
}

const BOX: React.CSSProperties = {
    background: 'rgba(10,12,18,0.86)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8,
    color: '#cbd5e1', fontSize: 11, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    fontFamily: 'var(--font-geist-mono,monospace)',
}

const SMALL_BTN: React.CSSProperties = {
    padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.04)', color: '#e5e7eb', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 10.5, fontWeight: 600,
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
            <div style={{ ...BOX, position: 'absolute', zIndex: 1000, padding: '3px 7px', display: 'flex',
                alignItems: 'center', gap: 5, pointerEvents: 'none', ...style }}
                aria-label={`${s.list.length} detections on the map`}>
                <MapPin size={11} /> {s.list.length}
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
            style={{ ...BOX, position: 'absolute', zIndex: 1000, padding: '8px 10px', width: 214,
                maxWidth: 'calc(100% - 24px)', ...style }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    fontWeight: 700, color: '#e5e7eb', flex: 1 }}>
                    <input type="checkbox" checked={s.show} onChange={e => s.setShow(e.target.checked)}
                        style={{ accentColor: '#22d3ee', cursor: 'pointer' }} />
                    Detections
                    {s.list.length > 0 && <span style={{ fontWeight: 400, color: '#94a3b8' }}>{s.list.length}</span>}
                </label>
                {s.recording && (
                    <span title="Saved with the flight (Settings > Flights)"
                        style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#f87171', fontSize: 10 }}>
                        <Dot size={8} fill="#f87171" /> REC
                    </span>
                )}
                <button type="button" onClick={() => setCollapsed(c => !c)}
                    aria-label={collapsed ? 'Expand the detections legend' : 'Collapse the detections legend'}
                    aria-expanded={!collapsed}
                    style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 2, display: 'flex' }}>
                    {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
            </div>
            {!collapsed && s.show && (
                <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {s.list.length > 0 ? <ClassRows list={s.list} /> : (
                        <p style={{ margin: 0, lineHeight: 1.5 }}>
                            {s.reason ? REASON_TEXT[s.reason] : 'No detections yet - run a model and fly over the area.'}
                        </p>
                    )}
                    {s.list.length > 0 && s.reason && <p style={{ margin: 0, lineHeight: 1.5, color: '#fcd34d' }}>{REASON_TEXT[s.reason]}</p>}
                    {s.capped && (
                        <p style={{ margin: 0, lineHeight: 1.5, color: '#fcd34d' }}>
                            The map is full (5000 detections). Clear it to keep placing new ones.
                        </p>
                    )}
                    <FirstUseNote />
                    <CameraAnglePrompt />
                    {s.list.length > 0 && s.mayEdit && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button type="button" onClick={() => void clear()} disabled={clearing}
                                aria-busy={clearing}
                                title={s.recording ? 'Empties this map. Recorded detections stay in Settings > Flights.' : 'Empties this map.'}
                                style={{ ...SMALL_BTN, opacity: clearing ? 0.6 : 1 }}>
                                {clearing ? 'Clearing...' : 'Clear map'}
                            </button>
                            {clearFailed && <span role="alert" style={{ color: '#fca5a5' }}>Not cleared. Try again.</span>}
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
        ? 'Recording needs fly access on this workspace.'
        : !s.canRecord ? 'Recording is unavailable right now: the database is offline.' : undefined
    const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }
    return (
        <section aria-label="Detections on the map"
            className="rounded-lg border p-3 flex flex-col gap-2"
            style={{ borderColor: 'hsl(var(--app-border))', background: 'hsl(var(--app-surface-2) / 0.5)' }}>
            <div className="flex items-center gap-2 text-[11px] font-mono font-semibold tracking-wider"
                style={{ color: 'hsl(var(--app-text-muted))' }}>
                <MapPin size={12} /> MAP
                {s.list.length > 0 && <span className="ml-auto font-normal">{s.list.length} placed</span>}
            </div>
            <label style={row}>
                <input type="checkbox" checked={s.show} onChange={e => s.setShow(e.target.checked)}
                    style={{ accentColor: '#22d3ee' }} />
                <span style={{ color: 'hsl(var(--app-text))' }}>Show detections on map</span>
            </label>
            <label style={{ ...row, cursor: recordDisabled ? 'default' : 'pointer', opacity: recordDisabled ? 0.6 : 1 }}
                title={recordWhy}>
                <input type="checkbox" checked={s.recording} disabled={recordDisabled}
                    onChange={e => setRecording(e.target.checked)} style={{ accentColor: '#f87171' }} />
                <span style={{ color: 'hsl(var(--app-text))' }}>Record to map</span>
                <span style={{ fontSize: 10.5, color: 'hsl(var(--app-text-muted))' }}>
                    {s.recording ? 'saving with this flight' : 'saves them for later'}
                </span>
            </label>
            {recordWhy && <p style={{ margin: 0, fontSize: 11, color: 'hsl(var(--app-text-muted))' }}>{recordWhy}</p>}
            {s.reason && <p style={{ margin: 0, fontSize: 11, color: '#d97706' }}>{REASON_TEXT[s.reason]}</p>}
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

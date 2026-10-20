'use client'

// 3D RECONSTRUCTION results panel - lives in the AI tab's right column like
// every other mode's panel. The mode itself works like every other mode:
// the session's configured video source + Start Analysis. Frames flow
// browser/air-unit -> platform -> reconstruction engine; this panel shows
// the engine's live state (via cvResults), scan options for the NEXT run,
// and finished maps with download links + an offline best-quality reprocess.

import { apiDownload, apiFetch } from '@/lib/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useTicketedStream } from '@/hooks/useApiMedia'
import { getServerUrl } from '@/lib/server-url'
import { liveAuthHeaders } from '@/lib/auth'
import { visibleInterval } from '@/lib/poll'
import { Download, RefreshCw, Satellite, Sparkles, Loader } from 'lucide-react'
import {
    type Tone, TONE, LABEL, SECONDARY, NUM, TILE, TEXT, MUTED, BORDER, BORDER_STRONG, SURFACE_2,
    chip, btn, DISABLED, FOCUS,
} from './panelStyle'

const AUTH = liveAuthHeaders({ 'Content-Type': 'application/json' })
const api = (p: string) => `${getServerUrl()}/api/recon${p}`
const jsonOf = async (r: Response) => { try { return await r.json() } catch { return {} } }

type EngineT = {
    installed: boolean; running: boolean; presets: string[]
    options: { preset: string; imu_fuse: boolean }
}
type ResultT = {
    name: string; kind: 'live' | 'offline'
    files: { name: string; size_mb: number; path: string }[]
}

const TRACK_TONES: Record<string, Tone> = {
    tracking: 'ok', degraded: 'warn', lost: 'danger', initializing: 'accent',
}

const input: React.CSSProperties = {
    width: '100%', minHeight: 32, padding: '0 8px', borderRadius: 6, fontSize: 14,
    background: SURFACE_2, border: `1px solid ${BORDER_STRONG}`, color: TEXT,
}

export function Reconstruction3DPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const [engine, setEngine] = useState<EngineT | null>(null)
    const [results, setResults] = useState<ResultT[]>([])
    const [scanBusy, setScanBusy] = useState<string>('')   // session being reprocessed
    const [scanPhase, setScanPhase] = useState('')
    const [error, setError] = useState('')
    const [downloading, setDownloading] = useState('')
    const downloadResult = useCallback(async (path: string, name: string) => {
        setDownloading(path)
        try {
            const ok = await apiDownload(`/api/recon/download?path=${encodeURIComponent(path)}`, name)
            if (!ok) setError(`Could not download ${name}`)
        } catch {
            setError(`Could not download ${name}: the server did not answer`)
        } finally {
            setDownloading('')
        }
    }, [])

    const live = cvResults?.tracking_state !== undefined
    // MJPEG in an <img>: no header possible, so a 60 s URL ticket, asked
    // for only while the analysis runs (the feed exists only then).
    const depthStream = useTicketedStream(live ? '/api/recon/stream/depth' : null)
    const track = cvResults?.tracking_state ?? 'n/a'
    const trackTone: Tone = TRACK_TONES[track] ?? 'muted'

    const refreshEngine = useCallback(async () => {
        try { setEngine(await (await apiFetch(api('/engine'))).json()) }
        catch { setEngine(null) }
    }, [])
    const refreshResults = useCallback(async () => {
        try {
            const r = await apiFetch(api('/results'))
            if (r.ok) setResults(await r.json())
        } catch { /* engine down - keep last list */ }
    }, [])

    useEffect(() => {
        refreshEngine(); refreshResults()
        const stopEngine = visibleInterval(refreshEngine, 5000)
        const stopResults = visibleInterval(refreshResults, 8000)
        return () => { stopEngine(); stopResults() }
    }, [refreshEngine, refreshResults])

    // The instant a scan ends (live state disappears when Stop Analysis is
    // pressed), the engine is exporting the map - poll fast for a few seconds
    // so the finished scan pops into the list right away instead of on the
    // next slow tick. The mesh takes a moment, so we retry a handful of times.
    const wasLive = useRef(false)
    useEffect(() => {
        if (wasLive.current && !live) {
            let n = 0
            const t = setInterval(() => {
                refreshResults()
                if (++n >= 6) clearInterval(t)   // ~9 s of 1.5 s polls
            }, 1500)
            return () => clearInterval(t)
        }
        wasLive.current = !!live
    }, [live, refreshResults])

    // Offline reprocess progress
    useEffect(() => {
        if (!scanBusy) return
        const t = setInterval(async () => {
            try {
                const s = await (await apiFetch(api('/scan_status'))).json()
                setScanPhase(s.phase ?? s.state ?? '')
                if (s.state === 'done' || s.state === 'failed' || !s.running) {
                    setScanBusy(''); setScanPhase('')
                    refreshResults()
                }
            } catch { /* next tick */ }
        }, 2000)
        return () => clearInterval(t)
    }, [scanBusy, refreshResults])

    const setOption = async (body: Record<string, unknown>) => {
        setError('')
        try {
            const r = await apiFetch(api('/options'), {
                method: 'POST', headers: AUTH, body: JSON.stringify(body),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Option change failed')
            await refreshEngine()
        } catch { setError('Backend unreachable') }
    }

    const exportNow = async () => {
        setError('')
        try {
            const r = await apiFetch(api('/session/export'), { method: 'POST', headers: AUTH })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Export failed')
            await refreshResults()
        } catch { setError('Backend unreachable') }
    }

    const reprocess = async (session: string) => {
        setError(''); setScanBusy(session)
        try {
            const r = await apiFetch(api('/scan_session'), {
                method: 'POST', headers: AUTH, body: JSON.stringify({ session }),
            })
            if (!r.ok) { setError((await jsonOf(r)).detail ?? 'Reprocess failed'); setScanBusy('') }
        } catch { setError('Backend unreachable'); setScanBusy('') }
    }

    if (engine && !engine.installed) {
        return (
            <p style={SECONDARY}>
                The 3D engine is not installed on the server. Run
                <code className="font-code" style={{ fontSize: 12 }}> reconstruction/install.sh</code> there once.
            </p>
        )
    }

    const fuse = !!engine?.options?.imu_fuse
    const lowInput = (cvResults?.input_w ?? 0) < 1280

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Live state - only meaningful while the analysis is running */}
            {live ? (
                <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ ...chip(trackTone), textTransform: 'capitalize' }}>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} aria-hidden />
                            {track}
                        </span>
                        <span style={{ ...SECONDARY, ...NUM }}
                            title="Keyframes and landmarks in the map">
                            {cvResults?.keyframes ?? 0} frames, {cvResults?.landmarks ?? 0} points
                        </span>
                        {(cvResults?.input_w ?? 0) > 0 && (
                            <span style={{ ...SECONDARY, ...NUM, color: lowInput ? TONE.warn.fg : MUTED }}
                                title="Resolution reaching the reconstruction">
                                {cvResults?.input_w}x{cvResults?.input_h}
                            </span>
                        )}
                    </div>
                    <div style={{
                        borderRadius: 10, overflow: 'hidden', background: depthStream.src ? '#1A2129' : SURFACE_2,
                        border: `1px solid ${BORDER}`, aspectRatio: '16/9',
                    }}>
                        {/* Depth map - the network's per-frame view of the scene;
                            the full 3D map is the center pane. */}
                        {depthStream.src && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={depthStream.src} alt="depth"
                                onError={depthStream.onError} onLoad={depthStream.onLoad}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        )}
                    </div>
                    <button onClick={exportNow} className={FOCUS} style={btn()}
                        title="Save the map so far; scanning continues">
                        <Download size={14} aria-hidden /> Save snapshot
                    </button>
                    <p style={SECONDARY}>
                        Walk slowly, move sideways rather than turning, keep it lit, and
                        end where you started. Amber or red status: slow down.
                        Stopping saves the map.
                    </p>
                </>
            ) : (
                <>
                    <p style={SECONDARY}>
                        Press Run and move the camera through the space. These options
                        apply to the next scan.
                    </p>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={LABEL}>Quality</span>
                        <select className={FOCUS} style={input} value={engine?.options?.preset ?? 'indoor'}
                            onChange={e => void setOption({ preset: e.target.value })}>
                            {(engine?.presets ?? ['indoor']).map(p => (
                                <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                            ))}
                        </select>
                    </label>
                    <button
                        className={FOCUS}
                        aria-pressed={fuse}
                        onClick={() => void setOption({ imu_fuse: !engine?.options?.imu_fuse })}
                        title="Use flight controller data (MAVLink) for true scale. Needs an FC on the video link, not a plain webcam."
                        style={{
                            ...btn(), justifyContent: 'flex-start', gap: 8,
                            background: fuse ? TONE.ok.bg : SURFACE_2,
                            border: `1px solid ${fuse ? TONE.ok.border : BORDER_STRONG}`,
                            color: fuse ? TONE.ok.fg : TEXT,
                        }}>
                        <Satellite size={14} aria-hidden />
                        Drone sensor scale
                        <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{fuse ? 'On' : 'Off'}</span>
                    </button>
                </>
            )}

            {error && (
                <p role="alert" style={{ fontSize: 13, fontWeight: 600, color: TONE.danger.fg }}>
                    {error}
                </p>
            )}

            {/* Finished maps */}
            <div style={{ display: 'flex', alignItems: 'center',
                justifyContent: 'space-between' }}>
                <p style={LABEL}>Scans</p>
                <button onClick={refreshResults} title="Refresh" aria-label="Refresh scans" className={FOCUS}
                    style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', color: MUTED }}>
                    <RefreshCw size={14} aria-hidden />
                </button>
            </div>
            {results.length === 0 && (
                <p style={SECONDARY}>
                    {engine?.running
                        ? 'No scans yet. Finished maps appear here.'
                        : 'Engine idle. Scans appear here after the first run.'}
                </p>
            )}
            {results.map(r => (
                <div key={`${r.kind}-${r.name}`} style={{ ...TILE, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                        marginBottom: 4, minWidth: 0 }}>
                        <span style={chip(r.kind === 'live' ? 'accent' : 'ok')}>
                            {r.kind === 'live' ? 'Live' : 'Refined'}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, minWidth: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap' }} title={r.name}>{r.name}</span>
                        {r.kind === 'live' && (
                            <button onClick={() => void reprocess(r.name)}
                                className={FOCUS}
                                disabled={!!scanBusy}
                                title={scanBusy && scanBusy !== r.name
                                    ? 'Another scan is being refined'
                                    : 'Rebuild this scan at full quality (photogrammetry, 1-3 min)'}
                                style={{
                                    ...btn(), marginLeft: 'auto', minHeight: 28, padding: '0 8px', fontSize: 12,
                                    ...(scanBusy && scanBusy !== r.name ? DISABLED : {}),
                                    ...(scanBusy === r.name ? { cursor: 'wait' } : {}),
                                }}>
                                {scanBusy === r.name
                                    ? <Loader size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
                                    : <Sparkles size={12} aria-hidden />}
                                {scanBusy === r.name ? (scanPhase || 'Refining') : 'Refine'}
                            </button>
                        )}
                    </div>
                    {r.files.map(f => (
                        // A button, not <a href download>: the route needs the
                        // bearer, so the file is fetched into a blob first.
                        <button key={f.path} type="button"
                            className={FOCUS}
                            onClick={() => { void downloadResult(f.path, f.name) }}
                            disabled={downloading === f.path}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                                minHeight: 28, fontSize: 13, textAlign: 'left',
                                color: MUTED, background: 'none', borderRadius: 6,
                                border: 'none', cursor: downloading === f.path ? 'wait' : 'pointer',
                                textDecoration: 'none', padding: '2px 0',
                            }}>
                            <Download size={13} aria-hidden />
                            <span className="font-code" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap', color: TEXT }}>{f.name}</span>
                            <span style={{ marginLeft: 'auto', flexShrink: 0, ...NUM }}>
                                {downloading === f.path ? 'Downloading' : `${f.size_mb} MB`}
                            </span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    )
}

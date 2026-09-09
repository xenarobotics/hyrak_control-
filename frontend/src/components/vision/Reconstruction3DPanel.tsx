'use client'

// 3D RECONSTRUCTION results panel - lives in the AI tab's right column like
// every other mode's panel. The mode itself works like every other mode:
// the session's configured video source + Start Analysis. Frames flow
// browser/air-unit -> platform -> reconstruction engine; this panel shows
// the engine's live state (via cvResults), scan options for the NEXT run,
// and finished maps with download links + an offline best-quality reprocess.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { getServerUrl } from '@/lib/server-url'
import { Download, RefreshCw, Satellite, Sparkles, Loader } from 'lucide-react'

const TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || ''
const AUTH = { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' }
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

const TRACK_COLORS: Record<string, string> = {
    tracking: '#4ade80', degraded: '#fbbf24', lost: '#f87171',
    initializing: '#60a5fa',
}

const label: React.CSSProperties = {
    fontSize: 10, fontFamily: 'monospace', letterSpacing: '0.06em',
    color: 'hsl(var(--app-text-muted))', textTransform: 'uppercase',
}
const input: React.CSSProperties = {
    width: '100%', padding: '5px 8px', borderRadius: 8, fontSize: 11,
    fontFamily: 'monospace', background: 'hsl(var(--app-surface-2))',
    border: '1px solid hsl(var(--app-border))', color: 'hsl(var(--app-text))',
}

export function Reconstruction3DPanel() {
    const cvResults = useDroneStore(s => s.cvResults) as Record<string, unknown> | null
    const [engine, setEngine] = useState<EngineT | null>(null)
    const [results, setResults] = useState<ResultT[]>([])
    const [scanBusy, setScanBusy] = useState<string>('')   // session being reprocessed
    const [scanPhase, setScanPhase] = useState('')
    const [error, setError] = useState('')

    const live = cvResults && 'tracking_state' in cvResults
    const track = String((cvResults?.tracking_state as string) ?? 'n/a')
    const trackColor = TRACK_COLORS[track] ?? 'hsl(var(--app-text-muted))'

    const refreshEngine = useCallback(async () => {
        try { setEngine(await (await fetch(api('/engine'))).json()) }
        catch { setEngine(null) }
    }, [])
    const refreshResults = useCallback(async () => {
        try {
            const r = await fetch(api('/results'))
            if (r.ok) setResults(await r.json())
        } catch { /* engine down - keep last list */ }
    }, [])

    useEffect(() => {
        refreshEngine(); refreshResults()
        const a = setInterval(refreshEngine, 5000)
        const b = setInterval(refreshResults, 8000)
        return () => { clearInterval(a); clearInterval(b) }
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
                const s = await (await fetch(api('/scan_status'))).json()
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
            const r = await fetch(api('/options'), {
                method: 'POST', headers: AUTH, body: JSON.stringify(body),
            })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Option change failed')
            await refreshEngine()
        } catch { setError('Backend unreachable') }
    }

    const exportNow = async () => {
        setError('')
        try {
            const r = await fetch(api('/session/export'), { method: 'POST', headers: AUTH })
            if (!r.ok) setError((await jsonOf(r)).detail ?? 'Export failed')
            await refreshResults()
        } catch { setError('Backend unreachable') }
    }

    const reprocess = async (session: string) => {
        setError(''); setScanBusy(session)
        try {
            const r = await fetch(api('/scan_session'), {
                method: 'POST', headers: AUTH, body: JSON.stringify({ session }),
            })
            if (!r.ok) { setError((await jsonOf(r)).detail ?? 'Reprocess failed'); setScanBusy('') }
        } catch { setError('Backend unreachable'); setScanBusy('') }
    }

    if (engine && !engine.installed) {
        return (
            <p style={{ ...label, textTransform: 'none', lineHeight: 1.6 }}>
                Reconstruction engine is not installed on the server. Run
                <code> reconstruction/install.sh</code> there once, then this
                mode comes alive.
            </p>
        )
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Live state - only meaningful while the analysis is running */}
            {live ? (
                <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{
                            padding: '3px 8px', borderRadius: 6, fontSize: 10,
                            fontFamily: 'monospace', color: trackColor,
                            border: `1px solid ${trackColor}55`,
                            textTransform: 'uppercase',
                        }}>{track}</span>
                        <span style={{ ...label, alignSelf: 'center' }}>
                            KF {String(cvResults?.keyframes ?? 0)} · LM {String(cvResults?.landmarks ?? 0)}
                        </span>
                        {Number(cvResults?.input_w ?? 0) > 0 && (
                            <span style={{
                                ...label, alignSelf: 'center',
                                color: Number(cvResults?.input_w) < 1280
                                    ? '#fbbf24' : 'hsl(var(--app-text-muted))',
                            }}>
                                IN {String(cvResults?.input_w)}x{String(cvResults?.input_h)}
                            </span>
                        )}
                    </div>
                    <div style={{
                        borderRadius: 8, overflow: 'hidden', background: '#000',
                        border: '1px solid hsl(var(--app-border))', aspectRatio: '16/9',
                    }}>
                        {/* Depth map - the network's per-frame view of the scene;
                            the full 3D map is the center pane. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={api('/stream/depth')} alt="depth"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <button onClick={exportNow}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            gap: 6, padding: '6px 10px', borderRadius: 8, fontSize: 10,
                            fontFamily: 'monospace', cursor: 'pointer',
                            background: 'hsl(var(--app-surface-2))',
                            border: '1px solid hsl(var(--app-border))',
                            color: 'hsl(var(--app-text))',
                        }}>
                        EXPORT SNAPSHOT (keep scanning)
                    </button>
                    <p style={{ ...label, textTransform: 'none', lineHeight: 1.5 }}>
                        Move at walking pace, translate rather than pan, keep the
                        scene lit, finish where you started. Amber = pose degraded,
                        red = lost: slow down. Stopping the analysis saves the map.
                    </p>
                </>
            ) : (
                <>
                    <p style={{ ...label, textTransform: 'none', lineHeight: 1.5 }}>
                        Uses the session&apos;s video source like every other mode:
                        press START ANALYSIS and move the camera through the space.
                        Options below apply to the next scan.
                    </p>
                    <div>
                        <p style={{ ...label, marginBottom: 4 }}>QUALITY PRESET</p>
                        <select style={input} value={engine?.options?.preset ?? 'indoor'}
                            onChange={e => void setOption({ preset: e.target.value })}>
                            {(engine?.presets ?? ['indoor']).map(p => (
                                <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        onClick={() => void setOption({ imu_fuse: !engine?.options?.imu_fuse })}
                        title="Fuse flight-controller telemetry (MAVLink) to anchor true metric scale - needs an FC on the video link (air unit on a drone), not a plain webcam"
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px', borderRadius: 8, fontSize: 10,
                            fontFamily: 'monospace', cursor: 'pointer',
                            background: engine?.options?.imu_fuse ? '#34d39918' : 'hsl(var(--app-surface-2))',
                            border: `1px solid ${engine?.options?.imu_fuse ? '#34d39960' : 'hsl(var(--app-border))'}`,
                            color: engine?.options?.imu_fuse ? '#34d399' : 'hsl(var(--app-text-muted))',
                        }}>
                        <Satellite size={12} />
                        IMU / FC FUSE {engine?.options?.imu_fuse ? 'ON' : 'OFF'}
                        <span style={{ marginLeft: 'auto', fontSize: 9 }}>MAVLink scale</span>
                    </button>
                </>
            )}

            {error && (
                <p style={{ fontSize: 10, fontFamily: 'monospace', color: '#f87171' }}>
                    {error}
                </p>
            )}

            {/* Finished maps */}
            <div style={{ display: 'flex', alignItems: 'center',
                justifyContent: 'space-between' }}>
                <p style={label}>SCANS</p>
                <button onClick={refreshResults} title="refresh"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                        color: 'hsl(var(--app-text-muted))' }}>
                    <RefreshCw size={11} />
                </button>
            </div>
            {results.length === 0 && (
                <p style={{ ...label, textTransform: 'none' }}>
                    {engine?.running
                        ? 'No scans yet - finished maps appear here.'
                        : 'Engine idle - scans appear here after the first run.'}
                </p>
            )}
            {results.map(r => (
                <div key={`${r.kind}-${r.name}`} style={{
                    border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, padding: '7px 9px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6,
                        marginBottom: 4 }}>
                        <span style={{
                            fontSize: 9, fontFamily: 'monospace',
                            color: r.kind === 'live' ? '#22d3ee' : '#c084fc',
                        }}>{r.kind === 'live' ? 'LIVE' : 'OFFLINE'}</span>
                        <span style={{ fontSize: 10, fontFamily: 'monospace',
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap' }}>{r.name}</span>
                        {r.kind === 'live' && (
                            <button onClick={() => void reprocess(r.name)}
                                disabled={!!scanBusy}
                                title="Re-process this scan offline at maximum quality (COLMAP photogrammetry, 1-3 min)"
                                style={{
                                    marginLeft: 'auto', display: 'flex', alignItems: 'center',
                                    gap: 4, fontSize: 9, fontFamily: 'monospace',
                                    background: 'none', border: '1px solid #c084fc55',
                                    borderRadius: 6, padding: '2px 6px',
                                    color: '#c084fc', cursor: 'pointer',
                                    opacity: scanBusy ? 0.5 : 1,
                                }}>
                                {scanBusy === r.name
                                    ? <Loader size={9} className="animate-spin" />
                                    : <Sparkles size={9} />}
                                {scanBusy === r.name ? (scanPhase || 'processing') : 'REFINE'}
                            </button>
                        )}
                    </div>
                    {r.files.map(f => (
                        <a key={f.path}
                            href={api(`/download?path=${encodeURIComponent(f.path)}`)}
                            download={f.name}
                            target="_blank" rel="noopener noreferrer"
                            style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                fontSize: 10, fontFamily: 'monospace',
                                color: 'hsl(var(--app-text-muted))',
                                textDecoration: 'none', padding: '2px 0',
                            }}>
                            <Download size={10} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap' }}>{f.name}</span>
                            <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                                {f.size_mb} MB
                            </span>
                        </a>
                    ))}
                </div>
            ))}
        </div>
    )
}

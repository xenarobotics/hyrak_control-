'use client'

// Config > Logs: the flight controller's ULog files (QGroundControl's Log
// Download page) and HYRAK's own flight records.
//
// Socket events (backend app/events/config_events.py): log_list,
// log_download {id}, log_cancel, log_erase {confirm: "ERASE"}. The server
// pulls the log from the drone, reports progress, then sends a one-time
// link for this account; the browser saves it straight to disk through a
// URL ticket, so a 300 MB log never sits in page memory.

import React, { useCallback, useEffect, useState } from 'react'
import { Download, FileText, Loader, RefreshCw, Trash2, X } from 'lucide-react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { apiDownload, apiFetch, ticketedUrl } from '@/lib/api'
import { isCustomer } from '@/lib/auth'
import { Btn, Chip, Dialog, FOCUS_RING, Note, Panel, T } from '@/components/config/kit'

interface LogEntry { id: number; date: string; size_bytes: number }
interface Job { id: number; size: number; progress: number; state: 'running' | 'saving' | 'done' | 'failed'; error?: string }
interface FlightRow { id: string; drone_name?: string | null; started_at: string | null; duration_s: number; max_alt_m: number; distance_m: number; in_progress: boolean }

export function fmtBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return `${n} B`
}

/** PX4 dates a log from GPS time; with no fix it is 1970. */
function fmtLogDate(s: string): string | null {
    const d = new Date(s)
    if (!s || Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return null
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function fmtDur(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    if (s >= 60) return `${Math.floor(s / 60)} min ${Math.floor(s % 60)} s`
    return `${Math.floor(s)} s`
}

async function saveFromServer(path: string, name: string): Promise<boolean> {
    const url = await ticketedUrl(path)
    if (url) {
        const a = document.createElement('a')
        a.href = url; a.download = name; a.rel = 'noopener'
        document.body.appendChild(a); a.click(); a.remove()
        return true
    }
    return apiDownload(path, name)
}

export function LogsSetup() {
    const connected = useDroneStore(s => s.telemetryStatus === 'connected')
    const armed = useDroneStore(s => s.telemetry?.flight_mode?.is_armed ?? false)
    const inAir = useDroneStore(s => s.telemetry?.flight_mode?.is_in_air ?? false)
    const [logs, setLogs] = useState<LogEntry[] | null>(null)
    const [listing, setListing] = useState(false)
    const [listErr, setListErr] = useState<string | null>(null)
    const [job, setJob] = useState<Job | null>(null)
    const [erasing, setErasing] = useState(false)
    const grounded = connected && !armed && !inAir

    const refresh = useCallback(() => {
        setListing(true); setListErr(null)
        getSocket().emit('log_list')
    }, [])

    useEffect(() => {
        const s = getSocket()
        const onList = (d: { ok: boolean; logs?: LogEntry[]; error?: string }) => {
            setListing(false)
            if (d.ok) setLogs(d.logs ?? []); else setListErr(d.error ?? 'The drone did not list its logs')
        }
        const onAck = (d: { ok: boolean; id: number; size_bytes?: number; error?: string }) => {
            if (d.ok) setJob({ id: d.id, size: d.size_bytes ?? 0, progress: 0, state: 'running' })
            else setJob({ id: d.id, size: 0, progress: 0, state: 'failed', error: d.error ?? 'The download was refused' })
        }
        const onProgress = (d: { id: number; progress: number }) =>
            setJob(j => j && j.id === d.id && j.state === 'running' ? { ...j, progress: d.progress } : j)
        const onReady = async (d: { id: number; path: string }) => {
            setJob(j => j && j.id === d.id ? { ...j, progress: 1, state: 'saving' } : j)
            const ok = await saveFromServer(d.path, `log_${d.id}.ulg`)
            setJob(j => j && j.id === d.id ? { ...j, state: ok ? 'done' : 'failed', error: ok ? undefined : 'The server had the log but the browser could not fetch it. Download it again' } : j)
        }
        const onFailed = (d: { id: number; error: string; cancelled?: boolean }) =>
            setJob(j => d.cancelled ? null : { id: d.id, size: j?.size ?? 0, progress: j?.progress ?? 0, state: 'failed', error: d.error })
        s.on('log_list_result', onList)
        s.on('log_download_ack', onAck)
        s.on('log_progress', onProgress)
        s.on('log_ready', onReady)
        s.on('log_failed', onFailed)
        return () => {
            s.off('log_list_result', onList); s.off('log_download_ack', onAck); s.off('log_progress', onProgress)
            s.off('log_ready', onReady); s.off('log_failed', onFailed)
        }
    }, [])

    // List once per link, the way QGroundControl does when the page opens.
    useEffect(() => {
        if (!connected) return
        const t = setTimeout(refresh, 0)
        return () => clearTimeout(t)
    }, [connected, refresh])

    const running = job?.state === 'running' || job?.state === 'saving'
    const start = (e: LogEntry) => {
        setJob({ id: e.id, size: e.size_bytes, progress: 0, state: 'running' })
        getSocket().emit('log_download', { id: e.id })
    }
    const total = logs?.reduce((a, l) => a + l.size_bytes, 0) ?? 0

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {connected && (armed || inAir) && <Note tone="warn">The drone is {inAir ? 'in the air' : 'armed'}. You can list logs, but downloading and erasing wait until it is disarmed on the ground.</Note>}

            <Panel title="Logs on the drone" hint={logs ? `${logs.length} ${logs.length === 1 ? 'log' : 'logs'}, ${fmtBytes(total)}` : 'PX4 ULog files on the SD card'}
                right={<>
                    <Btn onClick={refresh} disabled={!connected || listing}><RefreshCw size={14} className={listing ? 'animate-spin' : undefined} /> Refresh</Btn>
                    <Btn kind="danger" onClick={() => setErasing(true)} disabled={!grounded || !logs?.length || running}
                        title={!grounded ? 'Disarm and land first' : undefined}><Trash2 size={14} /> Erase all</Btn>
                </>}>
                {!connected && <p style={{ margin: 0, padding: '8px 0', fontSize: 14, color: T.muted }}>Connect a drone to list the logs on its SD card. HYRAK&apos;s own flight records are below.</p>}
                {listErr && <Note tone="warn">{listErr}</Note>}
                {job?.state === 'failed' && <Note tone="danger">Log {job.id}: {job.error}</Note>}
                {listing && !logs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '20px 0', color: T.muted, fontSize: 14 }}>
                        <Loader size={15} className="animate-spin" style={{ color: T.accent }} /> Asking the drone for its log list. Over a telemetry radio this takes a few seconds.
                    </div>
                )}
                {logs && logs.length === 0 && <p style={{ margin: 0, padding: '16px 0', fontSize: 14, color: T.muted }}>No logs on the SD card. PX4 writes one each time the drone is armed.</p>}
                {logs && logs.length > 0 && (
                    <div style={{ overflowX: 'auto', margin: '0 -16px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 520 }}>
                            <thead>
                                <tr style={{ textAlign: 'left', color: T.muted, fontSize: 12 }}>
                                    <th style={{ padding: '6px 16px', fontWeight: 700 }}>Log</th>
                                    <th style={{ padding: '6px 8px', fontWeight: 700 }}>Date</th>
                                    <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Size</th>
                                    <th style={{ padding: '6px 16px', fontWeight: 700, textAlign: 'right', width: 1 }}><span className="sr-only">Download</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map(l => {
                                    const mine = job?.id === l.id ? job : null
                                    const date = fmtLogDate(l.date)
                                    return (
                                        <tr key={l.id} style={{ borderTop: `1px solid ${T.border}` }}>
                                            <td style={{ padding: '8px 16px', fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><FileText size={15} style={{ color: T.muted }} aria-hidden /> {l.id}</span>
                                            </td>
                                            <td style={{ padding: '8px', color: date ? T.text : T.muted, whiteSpace: 'nowrap' }}>{date ?? 'No date (no GPS time)'}</td>
                                            <td style={{ padding: '8px', textAlign: 'right', color: T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtBytes(l.size_bytes)}</td>
                                            <td style={{ padding: '6px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                {mine && (mine.state === 'running' || mine.state === 'saving') ? (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                                                        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150 }}>
                                                            <span role="progressbar" aria-label={`Log ${l.id} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mine.progress * 100)}
                                                                style={{ height: 6, borderRadius: 999, background: T.surface2, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                                                                <span style={{ display: 'block', height: '100%', width: `${Math.max(2, mine.progress * 100)}%`, background: 'var(--app-accent)', transition: 'width var(--dur) var(--ease-out)' }} />
                                                            </span>
                                                            <span style={{ fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums', textAlign: 'left' }}>
                                                                {mine.state === 'saving' ? 'Saving to your computer' : `${Math.round(mine.progress * 100)} %, ${fmtBytes(mine.progress * l.size_bytes)} of ${fmtBytes(l.size_bytes)}`}
                                                            </span>
                                                        </span>
                                                        {mine.state === 'running' && (
                                                            <button type="button" aria-label="Cancel download" onClick={() => getSocket().emit('log_cancel')}
                                                                className={FOCUS_RING + ' hover:bg-app-surface-2 transition-colors'}
                                                                style={{ width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                                                <X size={14} />
                                                            </button>
                                                        )}
                                                    </span>
                                                ) : (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                                        {mine?.state === 'done' && <Chip tone="ok">Saved</Chip>}
                                                        <Btn onClick={() => start(l)} disabled={!grounded || running} title={!grounded ? 'Disarm and land first' : running ? 'One download at a time' : undefined}>
                                                            <Download size={14} /> Download
                                                        </Btn>
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                <p style={{ margin: 0, fontSize: 12, color: T.muted, lineHeight: 1.5 }}>
                    Downloads run at the speed of the telemetry link: about 1 MB a minute over a 57600 baud radio, much faster over USB, Wi-Fi or SITL. Open .ulg files in PX4 Flight Review or PlotJuggler.
                </p>
            </Panel>

            <FlightRecords />

            {erasing && <EraseDialog count={logs?.length ?? 0} onClose={() => setErasing(false)} onDone={() => { setErasing(false); refresh() }} />}
        </div>
    )
}

function EraseDialog({ count, onClose, onDone }: { count: number; onClose: () => void; onDone: () => void }) {
    const [typed, setTyped] = useState('')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    useEffect(() => {
        const s = getSocket()
        const on = (d: { ok: boolean; error?: string | null }) => {
            setBusy(false)
            if (d.ok) onDone(); else setErr(d.error ?? 'The drone did not erase its logs')
        }
        s.on('log_erase_result', on)
        return () => { s.off('log_erase_result', on) }
    }, [onDone])
    return (
        <Dialog open onClose={onClose} title="Erase every log on the drone?" width={460}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: T.text }}>
                This deletes all {count} {count === 1 ? 'log' : 'logs'} from the SD card. They cannot be recovered. Download any you need first.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 13, color: T.text }}>Type <b className="font-code">ERASE</b> to confirm</span>
                <input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={FOCUS_RING + ' font-code'}
                    style={{ height: 38, padding: '0 10px', borderRadius: 8, outline: 'none', boxSizing: 'border-box', background: T.surface, border: `1px solid ${T.borderStrong}`, color: T.text, fontSize: 14 }} />
            </label>
            {err && <Note tone="danger">{err}</Note>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Btn onClick={onClose}>Cancel</Btn>
                <Btn kind="danger" disabled={typed !== 'ERASE' || busy}
                    onClick={() => { setBusy(true); setErr(null); getSocket().emit('log_erase', { confirm: 'ERASE' }) }}>
                    {busy ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />} Erase all logs
                </Btn>
            </div>
        </Dialog>
    )
}

function FlightRecords() {
    const droneId = useDroneStore(s => s.session?.drone?.id ?? null)
    const workspaceId = useDroneStore(s => s.session?.workspace_id ?? null)
    const [rows, setRows] = useState<FlightRow[] | null>(null)
    const [err, setErr] = useState(false)

    const load = useCallback(async () => {
        const q = new URLSearchParams({ limit: '20' })
        if (droneId) q.set('drone_id', droneId)
        if (isCustomer() && workspaceId) q.set('workspace_id', workspaceId)
        try {
            const r = await apiFetch(`/api/flights?${q}`)
            if (!r.ok) { setErr(true); setRows([]); return }
            setErr(false)
            setRows(((await r.json()).flights ?? []) as FlightRow[])
        } catch { setErr(true); setRows([]) }
    }, [droneId, workspaceId])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets state only after its fetch resolves
        void load()
    }, [load])

    return (
        <Panel title="HYRAK flight records" hint={droneId ? 'This drone, last 20 flights' : 'Your workspace, last 20 flights'}
            right={<Btn onClick={() => void load()}><RefreshCw size={14} /> Refresh</Btn>}>
            <p style={{ margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
                HYRAK records every flight it sees, armed to disarmed, at 1 Hz: position, height, speed, battery and mode. Kept on the server, so they survive an erased SD card.
            </p>
            {rows === null ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.muted, fontSize: 14 }}><Loader size={15} className="animate-spin" /> Loading flights</div>
            ) : err ? (
                <Note tone="warn">Flight records could not be loaded. The flight database may be offline.</Note>
            ) : rows.length === 0 ? (
                <p style={{ margin: 0, fontSize: 14, color: T.muted }}>No flights recorded yet.</p>
            ) : (
                <div style={{ overflowX: 'auto', margin: '0 -16px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 560 }}>
                        <thead>
                            <tr style={{ textAlign: 'left', color: T.muted, fontSize: 12 }}>
                                <th style={{ padding: '6px 16px', fontWeight: 700 }}>Started</th>
                                {!droneId && <th style={{ padding: '6px 8px', fontWeight: 700 }}>Drone</th>}
                                <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Duration</th>
                                <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Max height</th>
                                <th style={{ padding: '6px 8px', fontWeight: 700, textAlign: 'right' }}>Distance</th>
                                <th style={{ padding: '6px 16px', width: 1 }}><span className="sr-only">Download</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(f => (
                                <tr key={f.id} style={{ borderTop: `1px solid ${T.border}` }}>
                                    <td style={{ padding: '8px 16px', color: T.text, whiteSpace: 'nowrap' }}>
                                        {f.started_at ? new Date(f.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-'}
                                        {f.in_progress && <span style={{ marginLeft: 8 }}><Chip tone="accent">Flying</Chip></span>}
                                    </td>
                                    {!droneId && <td style={{ padding: '8px', color: T.text }}>{f.drone_name ?? '-'}</td>}
                                    <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.text, whiteSpace: 'nowrap' }}>{fmtDur(f.duration_s)}</td>
                                    <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.text }}>{f.max_alt_m.toFixed(1)} m</td>
                                    <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.text, whiteSpace: 'nowrap' }}>{f.distance_m >= 1000 ? `${(f.distance_m / 1000).toFixed(2)} km` : `${Math.round(f.distance_m)} m`}</td>
                                    <td style={{ padding: '6px 16px', textAlign: 'right' }}>
                                        <button type="button" onClick={() => { void apiDownload(`/api/flights/${f.id}/download`, `flight_${f.id}.csv`) }}
                                            className={FOCUS_RING + ' transition-colors hover:bg-app-surface-2'}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32, padding: '0 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                            <Download size={14} /> CSV
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <span style={{ fontSize: 12, color: T.muted }}>Replay a flight on the map from Settings, Flight history.</span>
        </Panel>
    )
}


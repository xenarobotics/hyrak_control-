'use client'

// Config > Analyze > GeoTag: QGroundControl's GeoTag Images. Pairs the
// photos a survey camera took with the shots the autopilot logged, in time
// order, and writes each shot's position into a copy of its photo (GPS
// EXIF). Everything runs in this browser: the log and the photos are never
// uploaded, and the originals are not changed. The tagged copies download
// as a zip (split into parts of about 1 GB).

import React, { useMemo, useState } from 'react'
import { AlertTriangle, Check, Download, Loader } from 'lucide-react'
import { Btn, Chip, Grid, NumberBox, Note, Panel, T } from '@/components/config/kit'
import { FilePick, fmtBytes } from './LogViewer'
import { parseULog, extractTriggers, type Trigger } from './ulog'
import { photoTime, withGps, ZipWriter } from './exif'

const HEAD_BYTES = 256 * 1024
const PART_BYTES = 1024 ** 3
const MAX_LOG = 1024 ** 3

interface Photo { file: File; time: number | null }

function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function fmtPhotoTime(ms: number | null): string {
    if (ms == null) return 'no time'
    const d = new Date(ms)
    return d.toISOString().slice(11, 19) + (ms % 1000 ? '.' + String(Math.round(ms % 1000)).padStart(3, '0').slice(0, 2) : '')
}

export function GeoTag() {
    const [logName, setLogName] = useState<string | null>(null)
    const [trig, setTrig] = useState<{ source: string | null; list: Trigger[] } | null>(null)
    const [photos, setPhotos] = useState<Photo[] | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [err, setErr] = useState<string | null>(null)
    const [skipT, setSkipT] = useState(0)
    const [skipP, setSkipP] = useState(0)
    const [progress, setProgress] = useState<{ done: number; total: number; failed: string[]; parts: number } | null>(null)

    const loadLog = async (f: File) => {
        setErr(null); setTrig(null); setProgress(null)
        if (f.size > MAX_LOG) { setErr(`This log is ${fmtBytes(f.size)}; GeoTag opens logs up to 1 GB.`); return }
        setBusy('Reading the log...')
        try {
            const log = parseULog(await f.arrayBuffer())
            setTrig(extractTriggers(log))
            setLogName(`${f.name}, ${fmtBytes(f.size)}`)
        } catch (e) {
            setErr(e instanceof Error ? e.message : 'This file could not be read as a flight log')
        } finally { setBusy(null) }
    }

    const loadPhotos = async (files: File[]) => {
        setErr(null); setProgress(null)
        const jpgs = files.filter(f => /\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg')
        if (!jpgs.length) { setErr('No JPEG photos in that selection. GeoTag works on .jpg files.'); return }
        setBusy(`Reading ${jpgs.length} photos...`)
        const out: Photo[] = []
        for (const file of jpgs) {
            let time: number | null = null
            try { time = photoTime(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())) } catch { time = null }
            out.push({ file, time })
        }
        // By capture time when every photo has one, else by file name (cameras number them in order).
        const allTimed = out.every(p => p.time != null)
        out.sort((a, b) => allTimed && a.time !== b.time ? (a.time as number) - (b.time as number) : a.file.name.localeCompare(b.file.name, undefined, { numeric: true }))
        setPhotos(out)
        setBusy(null)
    }

    const pairs = useMemo(() => {
        if (!trig || !photos) return []
        const t = trig.list.slice(skipT), p = photos.slice(skipP)
        const n = Math.min(t.length, p.length)
        return Array.from({ length: n }, (_, i) => {
            // Does the gap since the previous photo match the gap since the previous shot?
            let off: number | null = null
            if (i > 0 && p[i].time != null && p[i - 1].time != null) {
                off = ((p[i].time as number) - (p[i - 1].time as number)) / 1000 - (t[i].t - t[i - 1].t)
            }
            return { photo: p[i], trig: t[i], off, bad: off != null && Math.abs(off) > Math.max(1.5, 0.25 * (t[i].t - t[i - 1].t)) }
        })
    }, [trig, photos, skipT, skipP])
    const badCount = pairs.filter(x => x.bad).length
    const firstBad = pairs.findIndex(x => x.bad)
    const untimed = photos?.filter(p => p.time == null).length ?? 0

    const run = async () => {
        if (!pairs.length) return
        const failed: string[] = []
        let zip = new ZipWriter(), part = 1
        setProgress({ done: 0, total: pairs.length, failed, parts: 0 })
        const multi = pairs.reduce((a, x) => a + x.photo.file.size, 0) > PART_BYTES
        const name = (k: number) => multi ? `geotagged-part${k}.zip` : 'geotagged.zip'
        for (let i = 0; i < pairs.length; i++) {
            const { photo, trig: tr } = pairs[i]
            try {
                const tagged = withGps(new Uint8Array(await photo.file.arrayBuffer()), tr.lat, tr.lon, tr.alt)
                if (zip.count && zip.size + tagged.length > PART_BYTES) { saveBlob(zip.finish(), name(part)); part++; zip = new ZipWriter() }
                zip.add(photo.file.webkitRelativePath || photo.file.name, tagged, new Date(photo.file.lastModified || Date.now()))
            } catch (e) {
                failed.push(`${photo.file.name}: ${e instanceof Error ? e.message : 'could not be tagged'}`)
            }
            setProgress({ done: i + 1, total: pairs.length, failed: [...failed], parts: part - 1 })
        }
        if (zip.count) saveBlob(zip.finish(), name(part)); else part--
        setProgress({ done: pairs.length, total: pairs.length, failed: [...failed], parts: part })
    }

    const running = progress != null && progress.done < progress.total

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Note>Adds the drone&apos;s position to each survey photo. Pick the flight log and the photos from that flight. Photo number one is paired with the first shot the log recorded, and so on, so the two lists must start together. Your files stay on this computer; the originals are not changed.</Note>
            <Grid min={320}>
                <Panel title="1. Flight log" hint="the .ulg from Config > Logs">
                    <FilePick label={trig ? 'Pick another log' : 'Pick the log'} accept=".ulg" onFiles={f => loadLog(f[0])} name={logName} busy={!!busy} />
                    {trig && (trig.list.length
                        ? <span style={{ fontSize: 14, color: T.text }}><b>{trig.list.length}</b> shots logged{trig.source === 'camera_trigger' ? ', positions taken from the flight path at each trigger' : ''}.</span>
                        : <Note tone="warn">This log has no camera shots (no camera_capture or camera_trigger messages). Set up the camera trigger in Config &gt; Camera &amp; gimbal and fly the survey with logging on.</Note>)}
                </Panel>
                <Panel title="2. Photos" hint="JPEG files from the camera">
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <FilePick label="Pick photos" accept=".jpg,.jpeg,image/jpeg" multiple onFiles={loadPhotos} busy={!!busy} />
                        <FilePick label="Pick a folder" folder onFiles={loadPhotos} busy={!!busy} />
                    </div>
                    {photos && <span style={{ fontSize: 14, color: T.text }}><b>{photos.length}</b> photos, {fmtBytes(photos.reduce((a, p) => a + p.file.size, 0))}{untimed ? `, ${untimed} without a capture time (sorted by file name)` : ', sorted by capture time'}.</span>}
                </Panel>
            </Grid>
            {busy && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.muted }}><Loader size={14} className="animate-spin" /> {busy}</span>}
            {err && <Note tone="warn">{err}</Note>}

            {trig && trig.list.length > 0 && photos && (
                <Panel title="3. Check the pairing" hint={`${pairs.length} pairs`}
                    right={badCount ? <Chip tone="warn">{badCount} timing mismatch{badCount === 1 ? '' : 'es'}</Chip> : pairs.length > 1 && untimed === 0 ? <Chip tone="ok">Timing matches</Chip> : undefined}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.text }}>Skip first logged shots
                            <NumberBox label="Skip first logged shots" value={skipT} min={0} max={Math.max(0, trig.list.length - 1)} decimals={0} width={72} onCommit={v => setSkipT(Math.round(v))} /></span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.text }}>Skip first photos
                            <NumberBox label="Skip first photos" value={skipP} min={0} max={Math.max(0, photos.length - 1)} decimals={0} width={72} onCommit={v => setSkipP(Math.round(v))} /></span>
                    </div>
                    {trig.list.length - skipT !== photos.length - skipP && (
                        <Note tone="warn">{trig.list.length - skipT} shots and {photos.length - skipP} photos: the extra {Math.abs((trig.list.length - skipT) - (photos.length - skipP))} at the end will be left out. If the camera missed a shot or took a test photo, skip it above so the lists line up.</Note>
                    )}
                    {firstBad >= 0 && (
                        <Note tone="warn">From pair {firstBad + 1} the gap between photos does not match the gap between logged shots. A photo is probably missing or extra just before it.</Note>
                    )}
                    <div style={{ maxHeight: 360, overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 560 }}>
                            <thead>
                                <tr style={{ position: 'sticky', top: 0, background: T.surface2, color: T.muted, textAlign: 'left' }}>
                                    {['#', 'Photo', 'Taken', 'Shot at', 'Latitude', 'Longitude', 'Altitude', 'Timing'].map(h => <th key={h} style={{ padding: '6px 8px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {pairs.map((x, i) => (
                                    <tr key={i} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                                        <td style={{ padding: '5px 8px', color: T.muted }}>{i + 1}</td>
                                        <td style={{ padding: '5px 8px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.photo.file.name}</td>
                                        <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{fmtPhotoTime(x.photo.time)}</td>
                                        <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{x.trig.t.toFixed(1)} s</td>
                                        <td style={{ padding: '5px 8px' }}>{x.trig.lat.toFixed(7)}</td>
                                        <td style={{ padding: '5px 8px' }}>{x.trig.lon.toFixed(7)}</td>
                                        <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{x.trig.alt.toFixed(1)} m</td>
                                        <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', color: x.bad ? T.warn : T.muted }}>
                                            {x.off == null ? '-' : x.bad ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700 }}><AlertTriangle size={13} /> {x.off > 0 ? '+' : ''}{x.off.toFixed(1)} s</span>
                                                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} style={{ color: T.ok }} /> {x.off > 0 ? '+' : ''}{x.off.toFixed(1)} s</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: T.muted }}>Timing compares the gap since the previous photo (camera clock) with the gap since the previous logged shot. Altitude is above sea level, as the autopilot logged it.</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <Btn kind="primary" onClick={run} disabled={!pairs.length || running}><Download size={14} /> Tag {pairs.length} photos and download</Btn>
                        {progress && (
                            <span style={{ fontSize: 13, color: T.text }}>
                                {running ? `Tagging ${progress.done} of ${progress.total}...` : `Done: ${progress.total - progress.failed.length} photos tagged${progress.parts > 1 ? ` in ${progress.parts} zip files` : ''}.`}
                            </span>
                        )}
                    </div>
                    {progress && (
                        <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} style={{ height: 6, borderRadius: 999, background: T.surface2, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, background: 'var(--app-accent)', transition: 'width 200ms var(--ease-out)' }} />
                        </div>
                    )}
                    {progress && progress.failed.length > 0 && (
                        <Note tone="warn">Not tagged ({progress.failed.length}): {progress.failed.slice(0, 5).join('; ')}{progress.failed.length > 5 ? '; ...' : ''}</Note>
                    )}
                </Panel>
            )}
        </div>
    )
}

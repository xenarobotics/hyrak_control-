'use client'

// Desktop-app-only update prompt. The native shell checks for updates on
// launch (see desktop/src/updater.ts) but never downloads or installs
// anything without explicit authorization here - this is that
// authorization step, not a status display. Renders nothing in the
// browser build (isDesktopApp() is false there, and window.hyrakNative
// doesn't exist).

import { useEffect, useRef, useState } from 'react'
import { Download, RotateCw, X, AlertTriangle } from 'lucide-react'
import { isDesktopApp, nativeUpdater, type UpdaterEvent } from '@/lib/nativeBridge'
import { formatBytes, formatRate, formatEta } from '@/lib/formatBytes'

type Stage = 'hidden' | 'available' | 'downloading' | 'ready' | 'failed'

// If authorizing a download produces no progress event at all within this
// window, something upstream is wrong (dead feed, no write permission, an
// unpacked build). Saying so beats a progress bar parked at 0% indefinitely.
const NO_PROGRESS_TIMEOUT_MS = 20000

interface Progress {
    percent: number
    transferred?: number
    total?: number
    bytesPerSecond?: number
}

export function UpdatePrompt() {
    const [stage, setStage] = useState<Stage>('hidden')
    const [version, setVersion] = useState('')
    const [progress, setProgress] = useState<Progress>({ percent: 0 })
    const [errorMsg, setErrorMsg] = useState('')
    const [dismissed, setDismissed] = useState(false)
    const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const clearStall = () => {
        if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null }
    }

    useEffect(() => {
        if (!isDesktopApp()) return
        const updater = nativeUpdater()
        if (!updater) return

        const onEvent = (event: UpdaterEvent) => {
            if (event.type === 'available') {
                setVersion(event.version ?? '')
                setStage('available')
            } else if (event.type === 'download-progress') {
                clearStall()
                setProgress({
                    percent: Math.round(event.percent ?? 0),
                    transferred: event.transferred,
                    total: event.total,
                    bytesPerSecond: event.bytesPerSecond,
                })
                setStage('downloading')
            } else if (event.type === 'downloaded') {
                clearStall()
                if (event.version) setVersion(event.version)
                setStage('ready')
            } else if (event.type === 'error') {
                // Previously ignored here on the grounds that a background
                // CHECK failing is not worth interrupting anyone for. True -
                // but the same event also carries DOWNLOAD failures, and
                // swallowing those left this panel stuck on "Downloading… 0%"
                // forever with no way to tell that it had died. Only surface
                // it once a download is actually in flight.
                setStage(prev => {
                    if (prev !== 'downloading' && prev !== 'available') return prev
                    clearStall()
                    setErrorMsg(event.message || 'Update failed')
                    return 'failed'
                })
            }
            // 'checking' / 'not-available' - nothing to show for a background
            // check; Settings → About surfaces those.
        }
        const unsubscribe = updater.onEvent(onEvent)
        return () => { unsubscribe(); clearStall() }
    }, [])

    if (!isDesktopApp() || stage === 'hidden' || dismissed) return null

    const handleUpdateNow = () => {
        setProgress({ percent: 0 })
        setErrorMsg('')
        setStage('downloading')
        clearStall()
        stallTimer.current = setTimeout(() => {
            setStage(prev => {
                if (prev !== 'downloading') return prev
                setErrorMsg('No response from the updater after 20s - the download never started.')
                return 'failed'
            })
        }, NO_PROGRESS_TIMEOUT_MS)
        void nativeUpdater()?.authorizeDownload()
    }
    const handleRestart = () => {
        void nativeUpdater()?.install()
    }

    // Byte counts are the honest signal when percent is unavailable (no
    // Content-Length) or moving too slowly to look alive.
    const detail = [
        progress.transferred !== undefined && progress.total
            ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`
            : progress.transferred !== undefined ? formatBytes(progress.transferred) : null,
        progress.bytesPerSecond ? formatRate(progress.bytesPerSecond) : null,
    ].filter(Boolean).join(' · ')

    return (
        <div
            className="fixed bottom-4 right-4 z-[3000] w-72 rounded-xl shadow-2xl font-mono text-xs"
            style={{
                background: 'hsl(var(--app-surface))',
                border: '1px solid hsl(var(--app-border))',
                color: 'hsl(var(--app-text))',
            }}
        >
            <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'hsl(var(--app-border))' }}>
                <div className="flex items-center gap-1.5 font-semibold">
                    <Download size={12} style={{ color: stage === 'failed' ? '#f59e0b' : '#22d3ee' }} />
                    {stage === 'ready' ? 'Update ready' : stage === 'failed' ? 'Update failed' : stage === 'downloading' ? 'Updating' : 'Update available'}
                </div>
                {stage !== 'downloading' && (
                    <button onClick={() => setDismissed(true)} title="Dismiss">
                        <X size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                    </button>
                )}
            </div>

            <div className="px-3 py-2.5 flex flex-col gap-2">
                {stage === 'available' && (
                    <>
                        <p style={{ color: 'hsl(var(--app-text-muted))' }}>
                            HYRAK {version} is available. Nothing downloads until you say so.
                        </p>
                        <div className="flex gap-1.5">
                            <button
                                onClick={handleUpdateNow}
                                className="flex-1 py-1.5 rounded font-semibold transition-colors"
                                style={{ background: '#22d3ee', color: 'black' }}
                            >
                                Update now
                            </button>
                            <button
                                onClick={() => setDismissed(true)}
                                className="px-2.5 py-1.5 rounded border transition-colors"
                                style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                            >
                                Later
                            </button>
                        </div>
                    </>
                )}

                {stage === 'downloading' && (
                    <>
                        <div className="flex items-baseline justify-between gap-2">
                            <span style={{ color: 'hsl(var(--app-text-muted))' }}>
                                {progress.transferred === undefined ? 'Starting download…' : `Downloading… ${progress.percent}%`}
                            </span>
                            {progress.total && progress.bytesPerSecond ? (
                                <span style={{ color: 'hsl(var(--app-text-muted))', fontSize: 10 }}>
                                    {formatEta(progress.transferred ?? 0, progress.total, progress.bytesPerSecond)}
                                </span>
                            ) : null}
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'hsl(var(--app-surface-2))' }}>
                            {/* No bytes yet means no honest percentage to draw - an
                                indeterminate sweep says "working" without claiming 0%. */}
                            <div
                                className={progress.transferred === undefined ? 'h-full w-1/3 animate-pulse rounded-full' : 'h-full rounded-full transition-all'}
                                style={{
                                    width: progress.transferred === undefined ? '33%' : `${progress.percent}%`,
                                    background: '#22d3ee',
                                }}
                            />
                        </div>
                        {detail && (
                            <p style={{ color: 'hsl(var(--app-text-muted))', fontSize: 10 }}>{detail}</p>
                        )}
                    </>
                )}

                {stage === 'failed' && (
                    <>
                        <div className="flex items-start gap-1.5">
                            <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
                            <p style={{ color: 'hsl(var(--app-text-muted))' }}>{errorMsg}</p>
                        </div>
                        <div className="flex gap-1.5">
                            <button
                                onClick={handleUpdateNow}
                                className="flex-1 py-1.5 rounded border font-semibold transition-colors"
                                style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text))' }}
                            >
                                Try again
                            </button>
                            <button
                                onClick={() => setDismissed(true)}
                                className="px-2.5 py-1.5 rounded border transition-colors"
                                style={{ borderColor: 'hsl(var(--app-border))', color: 'hsl(var(--app-text-muted))' }}
                            >
                                Dismiss
                            </button>
                        </div>
                    </>
                )}

                {stage === 'ready' && (
                    <>
                        <p style={{ color: 'hsl(var(--app-text-muted))' }}>
                            HYRAK {version} downloaded. Restart to apply - takes a few seconds.
                        </p>
                        <button
                            onClick={handleRestart}
                            className="flex items-center justify-center gap-1.5 py-1.5 rounded font-semibold transition-colors"
                            style={{ background: '#22d3ee', color: 'black' }}
                        >
                            <RotateCw size={11} />
                            Restart & install
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}

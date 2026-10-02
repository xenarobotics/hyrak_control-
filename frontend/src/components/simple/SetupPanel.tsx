'use client'

// Getting ready, as three steps that really are a sequence: connect the drone,
// turn on its camera, then fly. Each step says what to press and shows the
// connection it will use, with a plain "Change" list for the rare case.

import { useState } from 'react'
import { useTelemetryLink } from '@/hooks/useTelemetryLink'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { getVideoSource, setVideoSource, needsCameraSelection, VIDEO_SOURCES, type VideoSource } from '@/lib/videoSource'

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) {
    return (
        <li className="flex gap-3">
            <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[17px] font-bold"
                style={done ? { background: 'var(--s-green)', color: '#fff' } : { background: 'var(--s-blue-soft)', color: 'var(--s-blue)' }}
                aria-hidden="true">{done ? '✓' : n}</span>
            <div className="flex-1 min-w-0 flex flex-col gap-2 pt-1">
                <p className="text-[19px] font-bold leading-tight">{title}</p>
                {children}
            </div>
        </li>
    )
}

function Choice<T extends string>({ value, options, onPick, onClose }: {
    value: T; options: { value: T; label: string }[]; onPick: (v: T) => void; onClose: () => void
}) {
    return (
        <div className="flex flex-col gap-1.5 rounded-xl border p-2" style={{ borderColor: 'var(--s-line)', background: 'var(--s-panel)' }}>
            {options.map(o => (
                <button key={o.value} type="button" onClick={() => { onPick(o.value); onClose() }}
                    className="min-h-[48px] rounded-lg px-3 text-left text-[16px]"
                    style={o.value === value ? { background: 'var(--s-blue-soft)', fontWeight: 700 } : {}}>
                    {o.label}
                </button>
            ))}
            <button type="button" onClick={onClose} className="min-h-[44px] text-[15px]" style={{ color: 'var(--s-ink-2)' }}>Close</button>
        </div>
    )
}

export function SetupPanel() {
    const cloud = useDroneStore(s => s.connectionStatus)
    const { options, source, setSource, connect, isConnected, isConnecting, sitlNeedsDesktop, telemetryError } = useTelemetryLink()
    const { isStreaming, isLoading, startStream, selectedCameraId } = useWebRTCContext()
    const [pick, setPick] = useState<'drone' | 'camera' | null>(null)
    const [src, setSrc] = useState<VideoSource>(() => getVideoSource())

    const droneLabel = options.find(o => o.value === source)?.label ?? source
    const camLabel = VIDEO_SOURCES.find(v => v.value === src)?.label ?? src
    const camBlocked = needsCameraSelection(src) && !selectedCameraId

    if (cloud !== 'connected') {
        return (
            <p className="text-[17px]" style={{ color: 'var(--s-ink-2)' }}>
                This computer is not reaching HYRAK. Check the internet connection; this screen reconnects by itself.
            </p>
        )
    }
    return (
        <ol className="flex flex-col gap-6" aria-label="Getting ready">
            <Step n={1} done={isConnected} title={isConnected ? 'Drone connected' : 'Connect the drone'}>
                {!isConnected && (
                    <>
                        <button type="button" onClick={() => connect()} disabled={isConnecting || sitlNeedsDesktop}
                            className="min-h-[60px] rounded-[var(--s-radius)] px-4 text-[20px] font-bold disabled:opacity-50"
                            style={{ background: 'var(--s-blue)', color: 'var(--s-blue-ink)' }}>
                            {isConnecting ? 'Connecting…' : 'Connect the drone'}
                        </button>
                        <p className="text-[14px]" style={{ color: 'var(--s-ink-2)' }}>
                            Using: {droneLabel}.{' '}
                            <button type="button" className="underline underline-offset-4 inline-flex items-center min-h-[44px] px-1" onClick={() => setPick(pick === 'drone' ? null : 'drone')}>Change connection</button>
                        </p>
                        {pick === 'drone' && <Choice value={source} options={options} onPick={setSource} onClose={() => setPick(null)} />}
                        {sitlNeedsDesktop && <p className="text-[14px]" style={{ color: '#7A140D' }}>This connection needs the HYRAK desktop app.</p>}
                        {telemetryError && <p className="text-[14px]" style={{ color: '#7A140D' }}>{telemetryError}</p>}
                    </>
                )}
            </Step>
            <Step n={2} done={isStreaming} title={isStreaming ? 'Camera on' : 'Turn on the camera'}>
                {!isStreaming && (
                    <>
                        <button type="button" onClick={() => startStream()} disabled={isLoading || camBlocked}
                            className="min-h-[56px] rounded-[var(--s-radius)] border-2 px-4 text-[19px] font-bold disabled:opacity-50"
                            style={{ borderColor: 'var(--s-blue)', color: 'var(--s-blue)', background: 'var(--s-panel)' }}>
                            {isLoading ? 'Starting…' : 'Turn on the camera'}
                        </button>
                        <p className="text-[14px]" style={{ color: 'var(--s-ink-2)' }}>
                            Using: {camLabel}.{' '}
                            <button type="button" className="underline underline-offset-4 inline-flex items-center min-h-[44px] px-1" onClick={() => setPick(pick === 'camera' ? null : 'camera')}>Change camera</button>
                        </p>
                        {pick === 'camera' && (
                            <Choice value={src} options={VIDEO_SOURCES.map(v => ({ value: v.value, label: v.label }))}
                                onPick={v => { setSrc(v); setVideoSource(v) }} onClose={() => setPick(null)} />
                        )}
                        {camBlocked && <p className="text-[14px]" style={{ color: 'var(--s-ink-2)' }}>Pick which camera in Settings first.</p>}
                    </>
                )}
            </Step>
            <Step n={3} done={false} title="Fly">
                <p className="text-[15px]" style={{ color: 'var(--s-ink-2)' }}>The flying buttons appear here once the drone is connected.</p>
            </Step>
        </ol>
    )
}

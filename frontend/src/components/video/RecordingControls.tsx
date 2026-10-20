'use client'

import { useRecorder } from '@/hooks/useRecorder'
import { Camera, Circle, Pause, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'

interface Props {
    videoRef: React.RefObject<HTMLVideoElement | null>
    isStreaming: boolean
}

export function RecordingControls({ videoRef, isStreaming }: Props) {
    const { state, elapsed, formatElapsed, start, pause, resume, stop, snapshot } = useRecorder(videoRef)

    if (!isStreaming) return null

    return (
        <div className="flex items-center gap-1.5 pointer-events-auto">
            {/* Recording status */}
            {state !== 'idle' && (
                <div className={cn(
                    'flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[13px] font-bold tabular-nums',
                    'bg-overlay-scrim backdrop-blur-[6px] border',
                    state === 'recording'
                        ? 'border-[var(--overlay-danger)] text-[var(--overlay-danger)]'
                        : 'border-[var(--overlay-warn)] text-[var(--overlay-warn)]'
                )}>
                    <Circle
                        size={8}
                        className={cn(
                            'fill-current',
                            state === 'recording' && 'animate-pulse'
                        )}
                    />
                    {formatElapsed(elapsed)}
                </div>
            )}

            {/* Snapshot */}
            <button
                onClick={snapshot}
                title="Save snapshot (PNG)"
                aria-label="Save snapshot"
                className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0')}
            >
                <Camera size={14} />
            </button>

            {/* Record / Pause / Stop */}
            {state === 'idle' && (
                <button
                    onClick={start}
                    title="Start recording"
                    aria-label="Start recording"
                    className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0 border-[var(--overlay-danger)] text-[var(--overlay-danger)]')}
                >
                    <Circle size={14} className="fill-current" />
                </button>
            )}

            {state === 'recording' && (
                <>
                    <button
                        onClick={pause}
                        title="Pause recording"
                        aria-label="Pause recording"
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0 text-[var(--overlay-warn)]')}
                    >
                        <Pause size={14} />
                    </button>
                    <button
                        onClick={stop}
                        title="Stop and download"
                        aria-label="Stop and download"
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0')}
                    >
                        <Square size={14} />
                    </button>
                </>
            )}

            {state === 'paused' && (
                <>
                    <button
                        onClick={resume}
                        title="Resume recording"
                        aria-label="Resume recording"
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0 text-[var(--overlay-ok)]')}
                    >
                        <Play size={14} />
                    </button>
                    <button
                        onClick={stop}
                        title="Stop and download"
                        aria-label="Stop and download"
                        className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'w-8 px-0')}
                    >
                        <Square size={14} />
                    </button>
                </>
            )}
        </div>
    )
}
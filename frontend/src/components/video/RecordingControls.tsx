'use client'

import { useRecorder } from '@/hooks/useRecorder'
import { Camera, Circle, Pause, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

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
                    'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-mono',
                    'bg-black/50 backdrop-blur-sm border',
                    state === 'recording'
                        ? 'border-red-500/50 text-red-400'
                        : 'border-yellow-500/50 text-yellow-400'
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
                className={cn(
                    'p-1.5 rounded-lg text-xs transition-colors',
                    'bg-black/40 backdrop-blur-sm border border-white/10',
                    'text-white/60 hover:text-white hover:bg-black/60'
                )}
            >
                <Camera size={14} />
            </button>

            {/* Record / Pause / Stop */}
            {state === 'idle' && (
                <button
                    onClick={start}
                    title="Start recording"
                    className="p-1.5 rounded-lg bg-red-900/60 backdrop-blur-sm border border-red-500/40 text-red-400 hover:text-red-300 hover:bg-red-900/80 transition-colors"
                >
                    <Circle size={14} className="fill-current" />
                </button>
            )}

            {state === 'recording' && (
                <>
                    <button
                        onClick={pause}
                        title="Pause recording"
                        className="p-1.5 rounded-lg bg-black/40 backdrop-blur-sm border border-yellow-500/30 text-yellow-400 hover:text-yellow-300 transition-colors"
                    >
                        <Pause size={14} />
                    </button>
                    <button
                        onClick={stop}
                        title="Stop and download"
                        className="p-1.5 rounded-lg bg-black/40 backdrop-blur-sm border border-white/10 text-white/60 hover:text-white transition-colors"
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
                        className="p-1.5 rounded-lg bg-black/40 backdrop-blur-sm border border-green-500/30 text-green-400 hover:text-green-300 transition-colors"
                    >
                        <Play size={14} />
                    </button>
                    <button
                        onClick={stop}
                        title="Stop and download"
                        className="p-1.5 rounded-lg bg-black/40 backdrop-blur-sm border border-white/10 text-white/60 hover:text-white transition-colors"
                    >
                        <Square size={14} />
                    </button>
                </>
            )}
        </div>
    )
}
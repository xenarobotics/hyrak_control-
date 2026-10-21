'use client'

// The Command window's AI drawer: an "AI models" button at the stage's top
// left (under the view switch) that slides open a panel of the AI modules - the same model library as the AI
// tab (useModelLibrary: HYRAK models, then our own Ready models), one tile
// each, icon + name + one line. Tap starts the module, tap the running one
// stops it. Closes on a tap outside or Esc.

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { useModelAccess, useModelLibrary, type LibraryEntry } from '@/components/models/useModelLibrary'

export function AiDrawer({ open, onOpen, onClose, mode, onToggle }: {
    open: boolean; onOpen: () => void; onClose: () => void
    mode: string; onToggle: (m: string) => void
}) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('pointerdown', down)
        window.addEventListener('keydown', key)
        return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key) }
    }, [open, onClose])

    const { entries } = useModelLibrary()
    const { canRun } = useModelAccess()
    const hyrak = entries.filter(e => e.group === 'hyrak')
    const ours = entries.filter(e => e.group === 'ours')
    const running = entries.find(e => e.mode === mode)

    const tile = (m: LibraryEntry) => {
        const Icon = m.icon
        const active = m.mode === mode
        const ready = m.status === 'ready'
        const disabled = !ready || !canRun
        const line = !canRun ? 'view only' : m.status === 'checking' ? 'being checked'
            : m.status === 'failed' ? 'needs attention' : active ? 'running - tap to stop' : m.blurb
        return (
            <button key={m.key} disabled={disabled}
                onClick={() => { onToggle(m.mode); onClose() }}
                title={disabled ? line : active ? `Stop ${m.name}` : `Run ${m.name} - ${m.blurb}`}
                className={cn('min-h-[72px] rounded-md border flex flex-col items-center justify-center gap-1 px-1.5 text-center transition-colors duration-[140ms] active:scale-[.98]',
                    !active && 'bg-[color-mix(in_srgb,var(--overlay-text)_4%,transparent)] hover:bg-[color-mix(in_srgb,var(--overlay-text)_10%,transparent)]',
                    'disabled:cursor-not-allowed', FOCUS_OVERLAY)}
                style={{
                    background: active ? `${m.color}22` : undefined,
                    borderColor: active ? `${m.color}99` : 'var(--overlay-border)',
                }}>
                <Icon size={20} style={{ color: active ? m.color : disabled ? 'var(--overlay-muted)' : 'var(--overlay-text)' }} />
                <span className="text-[13px] font-bold leading-tight line-clamp-1"
                    style={{ color: active ? m.color : disabled ? 'var(--overlay-muted)' : 'var(--overlay-text)' }}>{m.name}</span>
                <span className="text-[12px] leading-tight text-overlay-muted line-clamp-2">{line}</span>
            </button>
        )
    }

    return (
        <div ref={ref} className="absolute left-0 top-0 bottom-0 z-[1700] flex pointer-events-none">
            {open && (
                <div className="pointer-events-auto h-full w-[248px] flex flex-col border-r border-overlay-border bg-overlay-scrim backdrop-blur-[10px] animate-in fade-in-0 slide-in-from-left-2 duration-[220ms] ease-[var(--ease-out)]">
                    <div className="flex items-center justify-between px-3 h-11 shrink-0 border-b border-overlay-border">
                        <span className="text-[14px] font-bold text-overlay-text">AI models</span>
                        <button onClick={onClose} aria-label="Close AI drawer" title="Close"
                            className={cn('w-8 h-8 rounded-md flex items-center justify-center text-overlay-muted hover:text-overlay-text', FOCUS_OVERLAY)}>
                            <ChevronLeft size={16} />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-1.5 content-start">{hyrak.map(tile)}</div>
                        {ours.length > 0 && (
                            <>
                                <span className="px-1 pt-1 text-[13px] font-semibold text-overlay-muted">Our models</span>
                                <div className="grid grid-cols-2 gap-1.5 content-start">{ours.map(tile)}</div>
                            </>
                        )}
                    </div>
                </div>
            )}
            {/* Closed: one labelled overlay button under the stage's view
                switch, not a rotated side tab. */}
            {!open && (
                <button onClick={onOpen} aria-label="Open AI models"
                    title={running ? `AI: ${running.name} running` : 'AI models'}
                    className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'pointer-events-auto self-start mt-[52px] ml-2 h-9 w-9 px-0 md:w-auto md:px-3 text-[13px]')}>
                    <Cpu size={15} style={running ? { color: running.color } : undefined} />
                    <span className="hidden md:inline">AI models</span>
                    <ChevronRight size={14} className="hidden md:inline text-overlay-muted" />
                </button>
            )}
        </div>
    )
}

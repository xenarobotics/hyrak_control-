'use client'

// The Command window's AI drawer: a slim tab on the stage's left edge that
// slides open a panel of the AI modules - the same model library as the AI
// tab (useModelLibrary: HYRAK models, then our own Ready models), one tile
// each, icon + name + one line. Tap starts the module, tap the running one
// stops it. Closes on a tap outside or Esc.

import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Cpu } from 'lucide-react'
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
                className="min-h-[72px] rounded-lg border flex flex-col items-center justify-center gap-1 px-1.5 text-center transition-colors disabled:opacity-35 hover:brightness-125"
                style={{
                    background: active ? `${m.color}22` : 'rgba(255,255,255,.03)',
                    borderColor: active ? `${m.color}99` : 'rgba(255,255,255,.08)',
                }}>
                <Icon size={20} style={{ color: active ? m.color : '#d4d4d8' }} />
                <span className="text-[11px] font-semibold leading-tight line-clamp-1"
                    style={{ color: active ? m.color : '#e4e4e7' }}>{m.name}</span>
                <span className="text-[9px] leading-tight text-zinc-500 line-clamp-2">{line}</span>
            </button>
        )
    }

    return (
        <div ref={ref} className="absolute left-0 top-0 bottom-0 z-[1700] flex pointer-events-none">
            {open && (
                <div className="pointer-events-auto h-full w-[248px] flex flex-col border-r border-white/10 font-mono"
                    style={{ background: 'rgba(9,11,16,.94)', backdropFilter: 'blur(10px)' }}>
                    <div className="flex items-center justify-between px-3 h-11 shrink-0 border-b border-white/10">
                        <span className="text-[10px] tracking-[0.2em] text-zinc-400">AI MODELS</span>
                        <button onClick={onClose} aria-label="Close AI drawer"
                            className="w-8 h-8 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-100">
                            <ChevronLeft size={16} />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-1.5 content-start">{hyrak.map(tile)}</div>
                        {ours.length > 0 && (
                            <>
                                <span className="px-1 pt-1 text-[9px] tracking-[0.2em] text-zinc-500">OUR MODELS</span>
                                <div className="grid grid-cols-2 gap-1.5 content-start">{ours.map(tile)}</div>
                            </>
                        )}
                    </div>
                </div>
            )}
            {!open && (
                <button onClick={onOpen} aria-label="Open AI models"
                    title={running ? `AI: ${running.name} running` : 'AI models'}
                    className="pointer-events-auto self-center w-7 h-24 rounded-r-lg border border-l-0 border-white/15 flex flex-col items-center justify-center gap-1.5 text-zinc-300 hover:text-zinc-100"
                    style={{ background: 'rgba(9,11,16,.85)' }}>
                    <Cpu size={14} style={running ? { color: running.color } : undefined} />
                    <span className="text-[9px] font-mono tracking-widest [writing-mode:vertical-rl]">AI</span>
                    <ChevronRight size={12} />
                </button>
            )}
        </div>
    )
}

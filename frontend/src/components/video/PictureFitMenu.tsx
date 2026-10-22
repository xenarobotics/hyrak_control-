'use client'

// The picture setting for video drawn over a flight screen (Fly, Command):
// Fill, Source, 16:9, 4:3, 1:1. One button showing the current choice opens
// a small list; the choice is saved (lib/videoSettings.ts) and every video
// pane listening for VIDEO_FIT_EVENT follows it.
//
// Drawn in place rather than in a portal: it has to sit over the stage's own
// layers (the map sits at z 400+) and keep working in browser fullscreen,
// where only the fullscreen element's subtree is shown.

import { useEffect, useId, useRef, useState } from 'react'
import { Ratio, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_OVERLAY, OVERLAY_BTN } from '@/components/controls/flightStyles'
import { ASPECT_OPTIONS, getVideoAspect, setVideoAspect, VIDEO_FIT_EVENT, type VideoAspect } from '@/lib/videoSettings'
import { useClientValueOn } from '@/hooks/useClientValue'

/** The saved picture setting, re-read whenever any pane changes it. */
export function useVideoAspect(): VideoAspect {
    return useClientValueOn(VIDEO_FIT_EVENT, getVideoAspect, 'fill')
}

export function PictureFitMenu({ placement = 'below', className }: {
    placement?: 'below' | 'above'; className?: string
}) {
    const aspect = useVideoAspect()
    const [open, setOpen] = useState(false)
    // Room to the edge of the clipping pane (a phone's stage is ~220 px
    // tall), so the list scrolls inside it instead of being cut off.
    const [maxH, setMaxH] = useState<number | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const listId = useId()
    const current = ASPECT_OPTIONS.find(o => o.id === aspect) ?? ASPECT_OPTIONS[0]

    useEffect(() => {
        if (!open) return
        // Focus the chosen option, so arrows and Enter work straight away.
        listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
        const onDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus() }
        }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
    }, [open])

    const toggle = () => {
        const trigger = triggerRef.current
        if (!open && trigger) {
            let clip: HTMLElement | null = trigger.parentElement
            while (clip && getComputedStyle(clip).overflow === 'visible') clip = clip.parentElement
            const t = trigger.getBoundingClientRect()
            const c = clip?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
            setMaxH(Math.max(120, placement === 'below' ? c.bottom - t.bottom - 12 : t.top - c.top - 12))
        }
        setOpen(o => !o)
    }

    const pick = (v: VideoAspect) => {
        setVideoAspect(v)
        setOpen(false)
        triggerRef.current?.focus()
    }

    const onListKey = (e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[n]?.focus()
    }

    return (
        <div ref={rootRef} className={cn('relative', className)}>
            <button ref={triggerRef} onClick={toggle}
                aria-haspopup="menu" aria-expanded={open} aria-controls={open ? listId : undefined}
                title={`Picture: ${current.label}. ${current.hint}`} aria-label={`Picture: ${current.label}`}
                className={cn(OVERLAY_BTN, FOCUS_OVERLAY, 'h-8')}>
                <Ratio size={14} aria-hidden />
                <span>{current.label}</span>
            </button>
            {open && (
                <div ref={listRef} id={listId} role="menu" aria-label="Picture" onKeyDown={onListKey}
                    style={maxH ? { maxHeight: maxH } : undefined}
                    className={cn('absolute right-0 z-[1700] w-56 sm:w-64 p-1 overflow-y-auto overscroll-contain rounded-[10px] border border-overlay-border bg-overlay-scrim backdrop-blur-[10px] shadow-[var(--app-shadow)]',
                        'animate-in fade-in-0 duration-150 motion-reduce:animate-none',
                        placement === 'below' ? 'top-[calc(100%+6px)]' : 'bottom-[calc(100%+6px)]')}>
                    <p className="px-2 pt-1.5 pb-1 text-[12px] font-bold text-overlay-muted">Picture</p>
                    {ASPECT_OPTIONS.map(o => (
                        <button key={o.id} role="menuitemradio" aria-checked={o.id === aspect} onClick={() => pick(o.id)} title={o.hint}
                            className={cn('w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors duration-[140ms]', FOCUS_OVERLAY,
                                'hover:bg-[color-mix(in_srgb,var(--overlay-text)_10%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--overlay-text)_10%,transparent)]')}>
                            <span className="w-4 pt-0.5 shrink-0 text-[var(--overlay-accent)]">
                                {o.id === aspect && <Check size={14} aria-hidden />}
                            </span>
                            <span className="flex flex-col min-w-0">
                                <span className={cn('text-[13px] font-bold', o.id === aspect ? 'text-overlay-selected-ink' : 'text-overlay-text')}>{o.label}</span>
                                <span className="max-sm:hidden text-[12px] text-overlay-muted leading-snug">{o.hint}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

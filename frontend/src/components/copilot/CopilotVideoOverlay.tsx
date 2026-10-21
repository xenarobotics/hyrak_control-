'use client'

// Copilot's marks over the live video:
//   choose card open      every candidate box with a big number, the same
//                         numbers as the card's chips (tap one to choose it)
//   copilot_target        the box HYRAK is tracking or following, magenta
//                         with its label (cv_results.copilot_target)
// Boxes are in source-frame pixels (frame_w x frame_h); they are mapped with
// the same object-fit as the video under them. The area round live video is
// always dark slate, so the night palette is used in every theme.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useDroneStore } from '@/store/drone'
import { useCopilotStore, latestOpenCard, chooseCandidate, toMs, type CopilotCandidate, type FrameBox } from '@/lib/copilot'
import type { VideoFit } from '@/lib/videoSettings'
import { useWebRTCContext } from '@/contexts/WebRTCContext'

const MAGENTA = '#E08AF5'
const CYAN = '#4FD1E0'
const SCRIM = 'rgba(18,23,30,0.82)'

function mapper(rectW: number, rectH: number, W: number, H: number, fit: VideoFit) {
    const scale = fit === 'fit' ? Math.min(rectW / W, rectH / H) : Math.max(rectW / W, rectH / H)
    const ox = (rectW - W * scale) / 2, oy = (rectH - H * scale) / 2
    return {
        box: (b: FrameBox): [number, number, number, number] =>
            [ox + b[0] * scale, oy + b[1] * scale, ox + b[2] * scale, oy + b[3] * scale],
        toSource: (x: number, y: number) => ({ x: (x - ox) / scale, y: (y - oy) / scale }),
    }
}

function font(px: number, weight = 800): string {
    const family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
    return `${weight} ${px}px ${family}`
}

function roundRect(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, r: number) {
    ctx.beginPath()
    ctx.roundRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1), r)
}

/** A label chip above (or inside, at the top edge) a box. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, maxW: number) {
    ctx.font = font(14, 700)
    let t = text
    while (t.length > 3 && ctx.measureText(t).width > maxW - 20) t = t.slice(0, -2)
    if (t !== text) t = t.trimEnd() + '...'
    const w = ctx.measureText(t).width + 16, h = 24
    const top = y - h - 6 < 4 ? y + 6 : y - h - 6
    ctx.fillStyle = SCRIM
    roundRect(ctx, x, top, x + w, top + h, 7); ctx.fill()
    ctx.strokeStyle = color; ctx.lineWidth = 1
    roundRect(ctx, x + .5, top + .5, x + w - .5, top + h - .5, 7); ctx.stroke()
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.fillText(t, x + 8, top + h / 2 + 1)
}

export function CopilotVideoOverlay({ fit = 'fill', interactive = false }: { fit?: VideoFit; interactive?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    // Boxes come from the server's frames: nothing to draw them on otherwise.
    const { isStreaming } = useWebRTCContext()
    const target = useDroneStore(s => s.cvResults?.copilot_target ?? null)
    const frameW = useDroneStore(s => s.cvResults?.frame_w ?? 1280)
    const frameH = useDroneStore(s => s.cvResults?.frame_h ?? 720)
    // Re-checked every second so an expired card's boxes go away on time.
    const [now, setNow] = useState(() => Date.now())
    const card = useCopilotStore(s => latestOpenCard(s, c => c.kind === 'choose' && !!c.candidates?.length))
    useEffect(() => {
        if (!card) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [card])
    const candidates = useMemo<CopilotCandidate[]>(
        () => (card && now < toMs(card.expires_at) ? card.candidates ?? [] : []), [card, now])
    const picked = useCopilotStore(s => (card ? s.answered[card.token] : undefined))

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const draw = () => {
            const ctx = canvas.getContext('2d')
            if (!ctx) return
            const rect = canvas.getBoundingClientRect()
            const dpr = Math.min(3, window.devicePixelRatio || 1)
            const bw = Math.round(rect.width * dpr), bh = Math.round(rect.height * dpr)
            if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, rect.width, rect.height)
            if (!rect.width || !rect.height) return

            if (target?.box) {
                const m = mapper(rect.width, rect.height, frameW, frameH, fit)
                const [x1, y1, x2, y2] = m.box(target.box)
                ctx.strokeStyle = MAGENTA; ctx.lineWidth = 3
                roundRect(ctx, x1, y1, x2, y2, 6); ctx.stroke()
                ctx.globalAlpha = 0.12; ctx.fillStyle = MAGENTA
                roundRect(ctx, x1, y1, x2, y2, 6); ctx.fill()
                ctx.globalAlpha = 1
                if (target.label) label(ctx, target.label, x1, y1, MAGENTA, Math.max(120, rect.width - x1))
            }

            for (const c of candidates) {
                const m = mapper(rect.width, rect.height, c.frame_w || frameW, c.frame_h || frameH, fit)
                const [x1, y1, x2, y2] = m.box(c.box)
                const sel = picked === c.index
                ctx.strokeStyle = CYAN; ctx.lineWidth = sel ? 4 : 2.5
                roundRect(ctx, x1, y1, x2, y2, 6); ctx.stroke()
                ctx.globalAlpha = sel ? 0.22 : 0.1; ctx.fillStyle = CYAN
                roundRect(ctx, x1, y1, x2, y2, 6); ctx.fill()
                ctx.globalAlpha = 1
                // The number: a big disc on the box's top-left corner, kept
                // inside the picture.
                const r = Math.max(16, Math.min(26, (x2 - x1) * 0.22))
                const cx = Math.max(r + 4, Math.min(rect.width - r - 4, x1 + r * 0.6))
                const cy = Math.max(r + 4, Math.min(rect.height - r - 4, y1 + r * 0.6))
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
                ctx.fillStyle = CYAN; ctx.fill()
                ctx.lineWidth = 2; ctx.strokeStyle = '#06171B'; ctx.stroke()
                ctx.fillStyle = '#06171B'
                ctx.font = font(Math.round(r * 1.2))
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
                ctx.fillText(String(c.index), cx, cy + 1)
                ctx.textAlign = 'left'
            }
        }
        draw()
        const ro = new ResizeObserver(draw)
        ro.observe(canvas)
        return () => ro.disconnect()
    }, [target, candidates, picked, fit, frameW, frameH])

    const clickable = interactive && candidates.length > 0 && picked === undefined
    const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!clickable || !card) return
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left, y = e.clientY - rect.top
        // Smallest box under the finger wins (a person in front of a car).
        let best: CopilotCandidate | null = null, bestArea = Infinity
        for (const c of candidates) {
            const [x1, y1, x2, y2] = mapper(rect.width, rect.height, c.frame_w || frameW, c.frame_h || frameH, fit).box(c.box)
            const area = (x2 - x1) * (y2 - y1)
            if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && area < bestArea) { best = c; bestArea = area }
        }
        if (best) chooseCandidate(card.token, best.index)
    }

    if (!isStreaming || (!target && candidates.length === 0)) return null
    return (
        <canvas ref={canvasRef} onClick={onClick}
            aria-label={candidates.length ? `${candidates.length} possible targets, numbered` : `Copilot target: ${target?.label ?? ''}`}
            role="img"
            style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 5,
                pointerEvents: clickable ? 'auto' : 'none', cursor: clickable ? 'pointer' : 'default',
            }} />
    )
}

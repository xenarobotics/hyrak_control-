'use client'

import { useEffect, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import type { CVResult } from '@/types/vision'

// Canvas twin of the backend's overlay drawing (vision/drawing.py + each
// module's draw_overlay): in client-overlay feed mode the browser shows the
// LOCAL camera stream and draws the latest cv_results on top, so the video
// itself never round-trips through the server encoder. Box coordinates are
// in source-frame pixels; the canvas uses the same intrinsic size and the
// same object-fit as the video element, so everything lines up.
//
// Colors are the backend's BGR tuples converted to RGB.

const C = {
    dim:      'rgb(90,90,90)',
    dimmer:   'rgb(55,55,55)',
    white:    'rgb(255,255,255)',
    lightGray:'rgb(200,200,200)',
    person:   'rgb(220,220,220)',
    object:   'rgb(150,150,150)',
    search:   'rgb(0,165,255)',    // human tracker SEARCHING badge
    active:   'rgb(50,220,200)',   // person tracker FOLLOWING
    locked:   'rgb(255,190,30)',   // person tracker PERSON FOUND
    scan:     'rgb(60,130,200)',   // person tracker corner status
    badgeBg:  'rgb(10,10,10)',
}

// Search phase thresholds — keep in sync with the tracker modules
const PHASE_HOLD = 90
const PHASE_SWEEP = 180

function drawBrackets(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string, thickness = 1, ratio = 0.22, radius = 5,
) {
    const lx = Math.max(12, (x2 - x1) * ratio)
    const ly = Math.max(12, (y2 - y1) * ratio)
    const r = Math.min(radius, lx / 2, ly / 2)
    ctx.strokeStyle = color
    ctx.lineWidth = thickness
    ctx.beginPath()
    // top-left
    ctx.moveTo(x1 + lx, y1); ctx.lineTo(x1 + r, y1)
    ctx.arcTo(x1, y1, x1, y1 + r, r)
    ctx.lineTo(x1, y1 + ly)
    // top-right
    ctx.moveTo(x2 - lx, y1); ctx.lineTo(x2 - r, y1)
    ctx.arcTo(x2, y1, x2, y1 + r, r)
    ctx.lineTo(x2, y1 + ly)
    // bottom-left
    ctx.moveTo(x1, y2 - ly); ctx.lineTo(x1, y2 - r)
    ctx.arcTo(x1, y2, x1 + r, y2, r)
    ctx.lineTo(x1 + lx, y2)
    // bottom-right
    ctx.moveTo(x2, y2 - ly); ctx.lineTo(x2, y2 - r)
    ctx.arcTo(x2, y2, x2 - r, y2, r)
    ctx.lineTo(x2 - lx, y2)
    ctx.stroke()
}

function drawBadge(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    fg = C.white, bg = C.badgeBg,
) {
    const pad = 4
    const m = ctx.measureText(text)
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
    ctx.fillStyle = bg
    ctx.fillRect(x, y - th - pad, m.width + pad * 2, th + pad * 2)
    ctx.fillStyle = fg
    ctx.fillText(text, x + pad, y)
}

function drawPill(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
) {
    const pad = 6
    const m = ctx.measureText(text)
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
    const w = m.width + pad * 2
    const h = th + pad * 2
    const py = Math.max(4, y - h - 6)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, py, w, h, h / 2)
    ctx.fill()
    ctx.fillStyle = 'rgb(10,10,10)'
    ctx.fillText(text, x + pad, py + pad + m.actualBoundingBoxAscent)
}

function drawCrosshair(
    ctx: CanvasRenderingContext2D, tx: number, ty: number,
    color: string, ringR: number, arm: number,
) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(tx, ty, ringR, 0, Math.PI * 2)
    ctx.moveTo(tx - arm, ty); ctx.lineTo(tx + arm, ty)
    ctx.moveTo(tx, ty - arm); ctx.lineTo(tx, ty + arm)
    ctx.stroke()
}

function drawObjectDetection(ctx: CanvasRenderingContext2D, r: CVResult) {
    for (const det of r.detections ?? []) {
        const [x1, y1, x2, y2] = det.box
        const isPerson = det.name === 'person'
        drawBrackets(ctx, x1, y1, x2, y2, isPerson ? C.person : C.object, isPerson ? 2 : 1)
        drawBadge(ctx, det.name, x1, Math.max(16, y1 - 4))
    }
}

function drawHumanTracking(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    const persons = r.persons ?? []
    const selectedId = r.selected_id
    const tracking = r.tracking ?? false

    for (const p of persons) {
        if (p.id === selectedId) continue
        const [x1, y1, x2, y2] = p.box
        drawBrackets(ctx, x1, y1, x2, y2, C.dim, 1)
    }

    const target = persons.find(p => p.id === selectedId)
    if (target) {
        const [x1, y1, x2, y2] = target.box
        const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
        const cx = W / 2, cy = H / 2
        if (tracking) {
            drawBrackets(ctx, x1, y1, x2, y2, C.white, 2)
            ctx.strokeStyle = C.lightGray
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke()
            drawCrosshair(ctx, tx, ty, C.white, 8, 12)
            ctx.fillStyle = 'rgb(180,180,180)'
            ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill()
            drawBadge(ctx, `#${selectedId}  TRACKING`, x1, Math.max(16, y1 - 4))
        } else {
            drawBrackets(ctx, x1, y1, x2, y2, C.lightGray, 1)
            drawBadge(ctx, `#${selectedId}  SELECTED`, x1, Math.max(16, y1 - 4), C.lightGray)
        }
    }

    if (r.searching) {
        const fl = r.frames_lost ?? 0
        const label = fl > PHASE_SWEEP ? `HOVERING  #${selectedId}`
            : fl > PHASE_HOLD ? `SWEEPING  #${selectedId}`
                : `SEARCHING  #${selectedId}`
        drawBadge(ctx, label, W - 220, 28, C.search)
    }
}

function drawPersonTracking(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    const persons = r.persons ?? []
    const targetId = r.target_id
    const tracking = r.tracking ?? false
    const faceConfirmed = r.face_confirmed ?? false

    if (faceConfirmed) {
        for (const p of persons) {
            if (p.id === targetId) continue
            const [x1, y1, x2, y2] = p.box
            drawBrackets(ctx, x1, y1, x2, y2, C.dimmer, 1)
        }
    }

    const target = persons.find(p => p.id === targetId)
    if (target) {
        const [x1, y1, x2, y2] = target.box
        const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
        const cx = W / 2, cy = H / 2
        if (tracking) {
            drawBrackets(ctx, x1, y1, x2, y2, C.active, 3)
            ctx.fillStyle = C.active
            for (const [px, py] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]) {
                ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill()
            }
            ctx.strokeStyle = C.active
            ctx.lineWidth = 1
            ctx.globalAlpha = 0.4
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke()
            ctx.globalAlpha = 1
            ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill()
            drawCrosshair(ctx, tx, ty, C.active, 10, 15)
            drawPill(ctx, 'FOLLOWING', x1, y1, C.active)
        } else {
            drawBrackets(ctx, x1, y1, x2, y2, C.locked, 2)
            drawCrosshair(ctx, tx, ty, C.locked, 6, 10)
            drawPill(ctx, 'PERSON FOUND', x1, y1, C.locked)
        }
    }

    let status: string | null = null
    if (r.searching) {
        const fl = r.frames_lost ?? 0
        status = fl > PHASE_SWEEP ? 'Hovering...'
            : fl > PHASE_HOLD ? 'Sweeping...' : 'Searching...'
    } else if (faceConfirmed && !target) {
        status = 'Looking for person...'
    }
    if (status) {
        ctx.save()
        ctx.font = `${Math.max(13, Math.round(H * 0.016))}px monospace`
        const m = ctx.measureText(status)
        drawBadge(ctx, status, W - m.width - 24, 28, C.scan)
        ctx.restore()
    }
}

export function CvOverlayCanvas() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const cvResults = useDroneStore(s => s.cvResults)
    const mode = useDroneStore(s => s.mode)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const W = cvResults?.frame_w ?? 1280
        const H = cvResults?.frame_h ?? 720
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W
            canvas.height = H
        }
        ctx.clearRect(0, 0, W, H)
        if (!cvResults) return

        ctx.font = `${Math.max(13, Math.round(H * 0.016))}px monospace`
        ctx.textBaseline = 'alphabetic'

        switch (mode) {
            case 'object-detection': drawObjectDetection(ctx, cvResults); break
            case 'human-tracking': drawHumanTracking(ctx, cvResults, W, H); break
            case 'person-tracking': drawPersonTracking(ctx, cvResults, W, H); break
        }
    }, [cvResults, mode])

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                objectFit: 'cover',        // must match the video element
                pointerEvents: 'none',
            }}
        />
    )
}

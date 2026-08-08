'use client'

import { useEffect, useRef } from 'react'
import { useDroneStore } from '@/store/drone'
import type { CVResult } from '@/types/vision'
import { OverlaySmoothers } from '@/lib/overlaySmoothing'
import { getSocket } from '@/lib/socket'
import type { VideoFit } from '@/lib/videoSettings'

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
    // Recognised from the face database but NOT being followed. Matches
    // person_tracker.py's _C_IDENT so the two overlay paths agree.
    ident:    'rgb(220,120,170)',
    badgeBg:  'rgb(10,10,10)',
    // Crowd management density levels + vehicle-plate tracking
    green:    'rgb(0,200,0)',
    orange:   'rgb(255,165,0)',
    red:      'rgb(230,0,0)',
    vehicle:  'rgb(150,150,150)',
    // Hover / pending-selection accent. Distinct from every
    // module colour so it never reads as a detection state.
    hover:    'rgb(56,160,255)',
}

const LEVEL_COLOR: Record<string, string> = { green: C.green, orange: C.orange, red: C.red }

function densityLevel(count: number, lightMax: number, moderateMax: number): 'green' | 'orange' | 'red' {
    if (count <= lightMax) return 'green'
    if (count <= moderateMax) return 'orange'
    return 'red'
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

function roundRectPath(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number, r = 10,
) {
    const rr = Math.min(r, (x2 - x1) / 2, (y2 - y1) / 2)
    ctx.beginPath()
    ctx.roundRect(x1, y1, x2 - x1, y2 - y1, rr)
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

// Per-item opacity from the smoother. Items that never went through one
// (or a mode with no smoothed list) read as fully opaque, so this is safe to
// apply unconditionally.
function alphaOf(item: unknown): number {
    const a = (item as { _a?: number })._a
    return typeof a === 'number' ? a : 1
}

function drawObjectDetection(ctx: CanvasRenderingContext2D, r: CVResult) {
    for (const det of r.detections ?? []) {
        const [x1, y1, x2, y2] = det.box
        const isPerson = det.name === 'person'
        ctx.globalAlpha = alphaOf(det)
        drawBrackets(ctx, x1, y1, x2, y2, isPerson ? C.person : C.object, isPerson ? 2 : 1)
        drawBadge(ctx, det.name, x1, Math.max(16, y1 - 4))
    }
    ctx.globalAlpha = 1
}

function drawHumanTracking(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    const persons = r.persons ?? []
    const selectedId = r.selected_id
    const tracking = r.tracking ?? false

    for (const p of persons) {
        if (p.id === selectedId) continue
        const [x1, y1, x2, y2] = p.box
        ctx.globalAlpha = alphaOf(p)
        drawBrackets(ctx, x1, y1, x2, y2, C.dim, 1)
    }
    ctx.globalAlpha = 1

    const target = persons.find(p => p.id === selectedId)
    if (target) {
        const [x1, y1, x2, y2] = target.box
        ctx.globalAlpha = alphaOf(target)
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

    ctx.globalAlpha = 1

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

    // Name EVERY recognised person, not just the followed one. Showing a name
    // is the point of face recognition — a box labelled "PERSON FOUND" tells an
    // operator nothing they could not already see. Distinct colour from the
    // target so "recognised" and "being chased" are separable at a glance.
    const byTrack = new Map((r.identities ?? []).map(i => [i.track_id, i]))
    for (const p of persons) {
        if (p.id === targetId) continue          // richer label below
        const ident = byTrack.get(p.id)
        const [x1, y1, x2, y2] = p.box
        ctx.globalAlpha = alphaOf(p)
        if (ident) {
            // A recognised person gets a SOLID rounded ring; an unrecognised
            // one gets thin dashed brackets. The two states have to be
            // separable at a glance across a busy frame, and "same brackets,
            // different colour" is not — colour alone disappears against a
            // varied background.
            ctx.save()
            ctx.shadowColor = C.ident
            ctx.shadowBlur = 10
            ctx.strokeStyle = C.ident
            ctx.lineWidth = 2.5
            roundRectPath(ctx, x1, y1, x2, y2); ctx.stroke()
            ctx.restore()
            drawPill(
                ctx,
                `${ident.name.toUpperCase()}  ${ident.similarity.toFixed(2)}`,
                x1, y1, C.ident,
            )
        } else if (faceConfirmed) {
            drawBrackets(ctx, x1, y1, x2, y2, C.dimmer, 1)
        }
    }
    ctx.globalAlpha = 1

    const target = persons.find(p => p.id === targetId)
    if (target) {
        const [x1, y1, x2, y2] = target.box
        ctx.globalAlpha = alphaOf(target)
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
            drawPill(
                ctx,
                r.person_name ? `FOLLOWING ${r.person_name.toUpperCase()}` : 'FOLLOWING',
                x1, y1, C.active,
            )
        } else {
            drawBrackets(ctx, x1, y1, x2, y2, C.locked, 2)
            drawCrosshair(ctx, tx, ty, C.locked, 6, 10)
            // A named match replaces the generic label — this is the
            // "PERSON FOUND" the operator asked to see replaced by a name.
            drawPill(
                ctx,
                r.person_name
                    ? `${r.person_name.toUpperCase()}  ${(r.similarity ?? 0).toFixed(2)}`
                    : 'PERSON FOUND',
                x1, y1, C.locked,
            )
        }
    }

    ctx.globalAlpha = 1

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

function drawCrowdManagement(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    const [rows, cols] = r.section_grid ?? [3, 3]
    const sectionCounts = r.section_counts ?? {}
    const lightMax = r.light_max ?? 8
    const moderateMax = r.moderate_max ?? 20
    // The grid is ALWAYS drawn while this mode is active.
    //
    // It used to be gated on more than one occupied cell, which made the whole
    // sectional view vanish in the most ordinary case — a few people standing
    // together, or an empty frame. "Which zone is busiest" is the reason the
    // grid exists, and a density map that only appears once the crowd has
    // already spread out is no use to an operator.
    //
    // Occupied cells only, tinted by THEIR OWN density and labelled. No
    // separator lines and nothing at all for an empty cell: the lattice that
    // used to be drawn read as a mesh laid over the scene rather than as heat
    // on the regions that matter, and an empty frame became pure wireframe.
    // The coloured regions ARE the boundary.
    const cellW = W / cols, cellH = H / rows
    for (let row = 0; row < rows; row++) {
        for (let c = 0; c < cols; c++) {
            const idx = row * cols + c
            const cnt = sectionCounts[idx]
            const x = c * cellW, y = row * cellH
            if (!cnt) continue
            // Each zone's own density, not the whole-frame level.
            const secColor = LEVEL_COLOR[densityLevel(cnt, lightMax, moderateMax)]
            ctx.globalAlpha = 0.16
            ctx.fillStyle = secColor
            ctx.fillRect(x, y, cellW, cellH)
            ctx.globalAlpha = 1
            drawBadge(ctx, String(cnt), x + 6, y + 22, secColor)
        }
    }

    const sel = r.selected_id
    const crowdTracking = r.tracking ?? false
    for (const p of r.people ?? []) {
        if (p.id === sel) continue          // drawn last, above the crowd
        const [x1, y1, x2, y2] = p.box
        ctx.globalAlpha = alphaOf(p)
        drawBrackets(ctx, x1, y1, x2, y2, C.person, 1)
    }
    ctx.globalAlpha = 1

    // The followed person — on top, so the crowd never hides them.
    const followed = (r.people ?? []).find(p => p.id === sel)
    if (followed) {
        const [x1, y1, x2, y2] = followed.box
        const col = crowdTracking ? C.active : C.lightGray
        drawLockedRing(ctx, x1, y1, x2, y2, col)
        drawBadge(ctx, `#${sel}  ${crowdTracking ? 'TRACKING' : 'SELECTED'}`,
                  x1, Math.max(16, y1 - 4), col)
        if (crowdTracking) {
            const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
            ctx.strokeStyle = C.lightGray
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(tx, ty); ctx.stroke()
            drawCrosshair(ctx, tx, ty, C.white, 8, 12)
            ctx.fillStyle = 'rgb(180,180,180)'
            ctx.beginPath(); ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2); ctx.fill()
        }
    }

    // No top HUD bar / COUNT-PEAK-LEVEL badges on the video itself — that
    // lives in the results panel now, feed stays clean.
}

/** The locked/followed subject, drawn so it is unmistakable among a dozen
 *  identical boxes: a solid rounded ring plus a soft outer glow. Brackets
 *  alone are not enough once the frame is busy — which is exactly when
 *  knowing which one the drone is chasing matters most. */
function drawLockedRing(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number, color: string,
) {
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 18
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    roundRectPath(ctx, x1, y1, x2, y2); ctx.stroke()
    ctx.restore()
    ctx.globalAlpha = 0.10
    ctx.fillStyle = color
    roundRectPath(ctx, x1, y1, x2, y2); ctx.fill()
    ctx.globalAlpha = 1
}

function drawVehicleTracking(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    // One vehicle, one identity: this module attaches plate/colour/type/speed
    // to a persistent vehicle_id rather than a raw tracker id — same unified
    // list shape as traffic-management's vehicle drawing, without the
    // crowd/face parts that module also carries.
    //
    // Counts, telemetry and ALPR availability live in the side panel — this
    // canvas draws only vehicles, their plates, and the follow guide.
    const tracking = r.tracking ?? false
    for (const v of r.vehicles ?? []) {
        const [x1, y1, x2, y2] = v.box
        const locked = v.locked
        ctx.globalAlpha = alphaOf(v)
        if (locked) drawLockedRing(ctx, x1, y1, x2, y2, C.active)
        else drawBrackets(ctx, x1, y1, x2, y2, C.vehicle, 1)

        const bits: string[] = []
        if (v.vehicle_id) bits.push(v.vehicle_id)
        if (v.color && v.color !== 'unknown' && (v.color_conf ?? 0) >= 0.35) bits.push(v.color)
        if (v.type && v.type !== 'unknown') bits.push(v.type)
        let label = bits.join(' ')
        if (v.plate) {
            // A trailing "?" marks a reading only one frame has produced —
            // visible, but visibly weaker. It is still shown AND still logged:
            // at drone standoff a single-frame read is often the only read a
            // passing vehicle will ever give.
            label = `${v.plate}${v.plate_strong ? '' : '?'}  ${label}`
        }
        if (v.speed_kmh != null) {
            // "~" and a trailing "?" are load-bearing: a ground-sample
            // estimate must not be mistaken for a calibrated reading.
            label += `  ~${Math.round(v.speed_kmh)}km/h${v.speed_reliable ? '' : '?'}`
        }
        drawBadge(ctx, label, x1, Math.max(16, y1 - 4), locked ? C.active : C.vehicle)

        if (v.plate_box) {
            const [px1, py1, px2, py2] = v.plate_box
            // Green once corroborated across frames, amber on a single read.
            drawBrackets(ctx, px1, py1, px2, py2, v.plate_strong ? C.green : C.orange, 2)
        }

        // Recentering guide for the locked, actively-followed vehicle — same
        // shape as human-tracking's: a line from frame centre to the target,
        // so which way (and how far) it sits off-centre is visible at a
        // glance rather than something to infer from the PD command alone.
        if (locked && tracking) {
            const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
            const cx = W / 2, cy = H / 2
            ctx.strokeStyle = C.lightGray
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke()
            drawCrosshair(ctx, tx, ty, C.white, 8, 12)
            ctx.fillStyle = 'rgb(180,180,180)'
            ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill()
        }
    }
    ctx.globalAlpha = 1
}

// Which list each mode draws, so payloads can be routed to a smoother
// without the draw functions needing to know smoothing exists.
const SMOOTHED_FIELD: Record<string, string> = {
    'object-detection':      'detections',
    'human-tracking':        'persons',
    'person-tracking':       'persons',
    'crowd-management':      'people',
    'vehicle-plate-tracking': 'vehicles',
    'traffic-management':     'vehicles',
}

// Modes where clicking a person on the video means something. Elsewhere the
// canvas stays pointer-transparent so it cannot swallow clicks meant for the
// controls underneath it.
const CLICK_TO_SELECT: Record<string, true> = {
    'human-tracking': true,
    'person-tracking': true,
    'traffic-management': true,
    'vehicle-plate-tracking': true,
    // Crowd management follows one person out of the crowd with the same
    // tracker ids it counts with — selection is the same click.
    'crowd-management': true,
}

// Modes whose click target is a VEHICLE (keyed by track_id) rather than a
// person (keyed by id). Both traffic-management and vehicle-plate-tracking
// follow a vehicle the same way — same event, same payload shape.
const VEHICLE_CLICK_MODES: Record<string, true> = {
    'traffic-management': true,
    'vehicle-plate-tracking': true,
}

/**
 * Screen coordinates -> SOURCE FRAME coordinates.
 *
 * The canvas is laid out with `object-fit: cover`, so its intrinsic WxH is
 * scaled up until it covers the element box and the overflow is cropped
 * symmetrically. Inverting that is the whole trick: without it a click lands
 * further from the box the nearer it is to the frame edge, which reads as
 * "clicking sometimes works" rather than as a coordinate bug.
 */
function toSourceCoords(
    canvas: HTMLCanvasElement, clientX: number, clientY: number, fit: VideoFit,
): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    const W = canvas.width, H = canvas.height
    // cover => the LARGER scale wins and the excess is cropped.
    // contain => the SMALLER scale wins and the remainder is letterboxed.
    // Getting this wrong does not fail loudly: clicks simply land further from
    // the box the nearer they are to the frame edge, which reads as "clicking
    // sometimes works" rather than as a coordinate bug.
    const scale = fit === 'fit'
        ? Math.min(rect.width / W, rect.height / H)
        : Math.max(rect.width / W, rect.height / H)
    const offsetX = (rect.width - W * scale) / 2
    const offsetY = (rect.height - H * scale) / 2
    return {
        x: (clientX - rect.left - offsetX) / scale,
        y: (clientY - rect.top - offsetY) / scale,
    }
}

/** Smallest box containing the point — smallest, because a person standing in
 *  front of a larger overlapping box is the one being pointed at. */
function hitTest(
    boxes: { id: number; box: [number, number, number, number] }[],
    x: number, y: number,
): number | null {
    let best: number | null = null
    let bestArea = Infinity
    for (const b of boxes) {
        const [x1, y1, x2, y2] = b.box
        if (x < x1 || x > x2 || y < y1 || y > y2) continue
        const area = (x2 - x1) * (y2 - y1)
        if (area < bestArea) { bestArea = area; best = b.id }
    }
    return best
}


function drawTrafficManagement(ctx: CanvasRenderingContext2D, r: CVResult, W: number, H: number) {
    // ── Crowd grid, always visible while people are present ──────────────
    // Same 3x3 layout and per-zone colouring as crowd-management, so an
    // operator reads it identically in both modes.
    const [rows, cols] = r.section_grid ?? [3, 3]
    const sections = r.section_counts ?? {}
    if (r.person_count) {
        const cellW = W / cols, cellH = H / rows
        for (let row = 0; row < rows; row++) {
            for (let c = 0; c < cols; c++) {
                const cnt = sections[row * cols + c]
                const x = c * cellW, y = row * cellH
                if (!cnt) {
                    ctx.globalAlpha = 0.24
                    ctx.strokeStyle = '#5a5a5a'
                    ctx.lineWidth = 1
                    ctx.strokeRect(x, y, cellW, cellH)
                    ctx.globalAlpha = 1
                    continue
                }
                const col = LEVEL_COLOR[densityLevel(cnt, r.light_max ?? 8, r.moderate_max ?? 20)]
                ctx.globalAlpha = 0.10
                ctx.fillStyle = col
                ctx.fillRect(x, y, cellW, cellH)
                ctx.globalAlpha = 1
                drawBadge(ctx, String(cnt), x + 6, y + 22, col)
            }
        }
    }

    // ── People, named where recognised ───────────────────────────────────
    const byTrack = new Map((r.identities ?? []).map(i => [i.track_id, i]))
    for (const p of r.people ?? []) {
        const [x1, y1, x2, y2] = p.box
        const ident = byTrack.get(p.id)
        ctx.globalAlpha = alphaOf(p)
        if (ident) {
            drawBrackets(ctx, x1, y1, x2, y2, C.ident, 2)
            drawPill(ctx, `${ident.name.toUpperCase()}  ${ident.similarity.toFixed(2)}`,
                     x1, y1, C.ident)
        } else {
            drawBrackets(ctx, x1, y1, x2, y2, C.person, 1)
        }
    }
    ctx.globalAlpha = 1

    for (const v of r.vehicles ?? []) {
        const [x1, y1, x2, y2] = v.box
        const locked = v.locked
        ctx.globalAlpha = alphaOf(v)
        drawBrackets(ctx, x1, y1, x2, y2, locked ? C.active : C.vehicle, locked ? 3 : 1)

        // Built from what is actually KNOWN, so a vehicle with no plate still
        // reads usefully instead of showing empty fields.
        const bits: string[] = []
        if (v.color && v.color !== 'unknown' && (v.color_conf ?? 0) >= 0.35) bits.push(v.color)
        bits.push(v.type)
        let label = bits.join(' ')
        if (v.plate) {
            label = `${v.plate}  ${label}`
        } else if (v.plate_provisional) {
            // A read in progress, marked so it cannot be mistaken for a
            // result. Reads like this are never logged.
            label = `${v.plate_provisional}?  ${label}`
        }
        if (v.speed_kmh != null) {
            // "~" and a trailing "?" are load-bearing: a ground-sample estimate
            // must not be mistaken for a calibrated reading.
            label += `  ~${Math.round(v.speed_kmh)}km/h${v.speed_reliable ? '' : '?'}`
        }
        drawBadge(ctx, label, x1, Math.max(16, y1 - 4), locked ? C.active : C.vehicle)

        if (v.plate_box) {
            const [px1, py1, px2, py2] = v.plate_box
            drawBrackets(ctx, px1, py1, px2, py2, C.green, 2)
        }
    }
    ctx.globalAlpha = 1

    drawBadge(
        ctx,
        `${r.vehicles_in_frame ?? 0} veh / ${r.person_count ?? 0} ppl`
        + ` / ${r.plates_read ?? 0} plates`,
        12, 28, 'rgb(90,220,220)',
    )
    let y = 52
    // Naming what the altitude cannot resolve is the difference between "the
    // plate reader is broken" and "descend to read plates".
    if (r.viability_headline) {
        drawBadge(ctx, r.viability_headline.slice(0, 78), 12, y, C.orange)
        y += 24
    }
    // Speed silently absent is indistinguishable from speed zero, so say why.
    if (r.has_telemetry === false) {
        drawBadge(ctx, 'no telemetry - speed unavailable', 12, y, C.orange); y += 24
    }
    if (r.alpr_available === false) {
        drawBadge(ctx, 'plate reader unavailable', 12, y, C.orange)
    }
}

export function CvOverlayCanvas({ fit = 'fill' }: { fit?: VideoFit } = {}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const cvResults = useDroneStore(s => s.cvResults)
    const mode = useDroneStore(s => s.mode)
    // Read by the render loop to draw a hover ring, so clicking is
    // discoverable rather than a hidden feature.
    const hovered = useRef<number | null>(null)
    // Optimistic selection feedback — see the draw block.
    const pending = useRef<{ box: [number, number, number, number]; at: number } | null>(null)
    const clickable = !!CLICK_TO_SELECT[mode]

    // The newest payload, read by the render loop. Kept in a ref rather than
    // used as an effect dependency: rendering is driven by the DISPLAY, not by
    // socket arrivals. That decoupling is the whole point — it is what lets a
    // 12Hz detector drive a 60Hz overlay, and what stops one dropped detection
    // from blanking the frame.
    const latest = useRef<CVResult | null>(null)
    const smoothers = useRef(new OverlaySmoothers())
    const lastPayload = useRef<CVResult | null>(null)

    useEffect(() => {
        if (!cvResults) return
        latest.current = cvResults
        const field = SMOOTHED_FIELD[mode]
        if (field) {
            smoothers.current.ingest(
                field, cvResults[field as keyof CVResult] as never,
            )
        }
        lastPayload.current = cvResults
    }, [cvResults, mode])

    // Switching modes must not carry tracks across — the lists mean different
    // things and the ids do not correspond.
    useEffect(() => {
        smoothers.current.reset()
        // Box hold is per mode: a stale box is noise in a crowd but a false
        // claim in person-ID. See MODE_HOLD_MS.
        smoothers.current.setMode(mode)
        latest.current = null
    }, [mode])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        let raf = 0
        const frame = () => {
            raf = requestAnimationFrame(frame)
            const r = latest.current
            const W = r?.frame_w ?? 1280
            const H = r?.frame_h ?? 720
            if (canvas.width !== W || canvas.height !== H) {
                canvas.width = W
                canvas.height = H
            }
            ctx.clearRect(0, 0, W, H)
            if (!r) return

            const field = SMOOTHED_FIELD[mode]
            // Replace the raw list with the interpolated, faded one. Every
            // other field passes through untouched, so status badges and
            // counts keep reporting exactly what the server said.
            const view: CVResult = field
                ? { ...r, [field]: smoothers.current.sample(field) } as CVResult
                : r

            ctx.font = `${Math.max(13, Math.round(H * 0.016))}px monospace`
            ctx.textBaseline = 'alphabetic'

            switch (mode) {
                case 'object-detection': drawObjectDetection(ctx, view); break
                case 'human-tracking': drawHumanTracking(ctx, view, W, H); break
                case 'person-tracking': drawPersonTracking(ctx, view, W, H); break
                case 'crowd-management': drawCrowdManagement(ctx, view, W, H); break
                case 'vehicle-plate-tracking': drawVehicleTracking(ctx, view, W, H); break
                case 'traffic-management': drawTrafficManagement(ctx, view, W, H); break
            }

            // Hover affordance, drawn last so it sits over the module's own
            // boxes. Only in modes where a click does something.
            // Hover / touch affordance: a rounded highlight and nothing else.
            // No caption — the operator already knows what tapping a target
            // does once, and a label on every hover is noise over the picture.
            if (CLICK_TO_SELECT[mode] && hovered.current !== null) {
                const p = VEHICLE_CLICK_MODES[mode]
                    ? (view.vehicles ?? []).find(q => q.track_id === hovered.current)
                    : mode === 'crowd-management'
                        ? (view.people ?? []).find(q => q.id === hovered.current)
                        : (view.persons ?? []).find(q => q.id === hovered.current)
                if (p) {
                    const [x1, y1, x2, y2] = p.box
                    ctx.globalAlpha = 0.18
                    ctx.fillStyle = C.hover
                    roundRectPath(ctx, x1, y1, x2, y2); ctx.fill()
                    ctx.globalAlpha = 0.95
                    ctx.strokeStyle = C.hover
                    ctx.lineWidth = 2
                    roundRectPath(ctx, x1, y1, x2, y2); ctx.stroke()
                    ctx.globalAlpha = 1
                }
            }

            // A click that has not round-tripped to the server yet. Without
            // this the ONLY feedback is the next payload, so any failure
            // anywhere in the chain is indistinguishable from a dead control —
            // which is exactly how this felt.
            if (pending.current !== null && performance.now() - pending.current.at < 1200) {
                const b = pending.current.box
                ctx.globalAlpha = 0.9
                ctx.strokeStyle = C.hover
                ctx.lineWidth = 3
                ctx.setLineDash([10, 6])
                ctx.lineDashOffset = -(performance.now() / 40) % 16
                roundRectPath(ctx, b[0], b[1], b[2], b[3]); ctx.stroke()
                ctx.setLineDash([])
                ctx.globalAlpha = 1
            }
            ctx.globalAlpha = 1
        }
        raf = requestAnimationFrame(frame)
        return () => cancelAnimationFrame(raf)
    }, [mode])

    // Which list a click tests against. Vehicle modes key on track_id, not
    // id — so it is normalised here instead of duplicating the hit-test.
    const targetsNow = (): { id: number; box: [number, number, number, number] }[] => {
        const r = latest.current
        if (!r) return []
        if (VEHICLE_CLICK_MODES[mode]) {
            return (r.vehicles ?? [])
                .filter(v => v.track_id != null)
                .map(v => ({ id: v.track_id as number, box: v.box }))
        }
        if (mode === 'crowd-management') {
            return (r.people ?? []).map(p => ({ id: p.id, box: p.box }))
        }
        return (r.persons ?? []).map(p => ({ id: p.id, box: p.box }))
    }

    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas || !clickable) return
        const { x, y } = toSourceCoords(canvas, e.clientX, e.clientY, fit)
        hovered.current = hitTest(targetsNow(), x, y)
    }

    const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas || !clickable) return
        const { x, y } = toSourceCoords(canvas, e.clientX, e.clientY, fit)
        const id = hitTest(targetsNow(), x, y)
        if (id === null) return
        const hitBox = targetsNow().find(t => t.id === id)?.box
        if (hitBox) pending.current = { box: hitBox, at: performance.now() }

        if (VEHICLE_CLICK_MODES[mode]) {
            // Vehicles are followed by track id; the plate (and, in
            // vehicle-plate-tracking, the persistent vehicle_id) is captured
            // on lock as the identity that survives that id changing. Both
            // modes expose the same request_follow(client_id, track_id)
            // shape server-side, so one event routes to whichever is active.
            getSocket().emit('set_follow_vehicle', { track_id: id })
            return
        }
        if (mode === 'human-tracking' || mode === 'crowd-management') {
            // Track id IS the selection key in both.
            getSocket().emit('select_person', { person_id: id })
            return
        }
        // person-tracking follows an ENROLLED IDENTITY, not a track — the lock
        // has to survive the track id changing when someone leaves and returns.
        // So a click only means something on a person who has been named.
        const ident = (latest.current?.identities ?? []).find(
            (i: { track_id: number }) => i.track_id === id,
        )
        if (ident?.person_id) {
            getSocket().emit('set_follow_person', { person_id: ident.person_id })
        } else {
            // Not an enrolled face. Previously this did nothing at all, which
            // is indistinguishable from a broken control. Fall back to
            // following the TRACK, the same way human-tracking does — the
            // operator pointed at a person, so follow that person.
            getSocket().emit('select_person', { person_id: id })
            pending.current = null
        }
    }

    return (
        <canvas
            ref={canvasRef}
            onPointerMove={onMove}
            // Touch has no hover: without this the highlight never appears on
            // a tablet and the whole affordance is invisible there. pointerdown
            // fires before click, so the target lights up under the finger.
            onPointerDown={onMove}
            onPointerLeave={() => { hovered.current = null }}
            onClick={onClick}
            style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                // MUST match the video element — see toSourceCoords.
                objectFit: fit === 'fit' ? 'contain' : 'cover',
                // Transparent to clicks EXCEPT where one does something, so it
                // never steals input from the controls underneath.
                pointerEvents: clickable ? 'auto' : 'none',
                cursor: clickable ? 'pointer' : 'default',
            }}
        />
    )
}

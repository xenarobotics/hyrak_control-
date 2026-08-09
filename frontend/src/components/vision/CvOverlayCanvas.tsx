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
    // Identity states. Green = enrolled, amber = present but unknown. Two
    // states, two colours, no captions needed for the second.
    known:    'rgb(52,211,153)',
    unknown:  'rgb(251,191,36)',
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

// Modern label: a rounded, translucent slate chip with a hairline in the
// accent colour and the text in that colour too.
//
// Replaces a hard black rectangle with white text, which read as a 2008 CCTV
// burn-in. Three things do the work: rounded corners, a translucent rather
// than opaque ground (so it sits ON the image instead of punching a hole in
// it), and colour carried by the text rather than a filled block.
function drawBadge(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    fg = C.white, _bg?: string,
) {
    const padX = 8, padY = 5, r = 7
    const m = ctx.measureText(text)
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
    const w = m.width + padX * 2
    const h = th + padY * 2
    const top = y - th - padY

    ctx.save()
    ctx.fillStyle = 'rgba(12,16,22,0.66)'
    ctx.beginPath(); ctx.roundRect(x, top, w, h, r); ctx.fill()
    ctx.strokeStyle = fg
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(x + 0.5, top + 0.5, w - 1, h - 1, r); ctx.stroke()
    ctx.restore()

    ctx.fillStyle = fg
    ctx.fillText(text, x + padX, y - 1)
}

// Direction-of-travel arrow, drawn along the vehicle's projected ground
// motion rather than its raw pixel velocity.
//
// The distinction is not pedantic. Perspective compresses the far half of the
// frame, so two vehicles in the SAME lane have visibly different pixel
// velocities depending on where they are on screen; arrows drawn from those
// would fan out across a straight road and look broken. `screen_dir` comes
// from projecting the vehicle a second ahead on the ground plane and back into
// the image, so parallel motion draws as parallel arrows.
function drawHeadingArrow(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, dx: number, dy: number,
    length: number, color: string,
) {
    const tipX = cx + dx * length, tipY = cy + dy * length
    // Perpendicular, for the head. Cheaper and steadier than a rotate().
    const px = -dy, py = dx
    const head = Math.max(5, length * 0.28)
    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tipX, tipY); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - dx * head + px * head * 0.5, tipY - dy * head + py * head * 0.5)
    ctx.lineTo(tipX - dx * head - px * head * 0.5, tipY - dy * head - py * head * 0.5)
    ctx.closePath(); ctx.fill()
    ctx.restore()
}

// Solid accent pill — for the ONE thing that matters in frame (a recognised
// name, the followed target). Deliberately louder than drawBadge so the
// hierarchy is obvious at a glance.
function drawPill(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
) {
    const padX = 10, padY = 6
    const m = ctx.measureText(text)
    const th = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
    const w = m.width + padX * 2
    const h = th + padY * 2
    const py = Math.max(4, y - h - 8)

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 1
    ctx.fillStyle = color
    ctx.beginPath(); ctx.roundRect(x, py, w, h, h / 2); ctx.fill()
    ctx.restore()

    ctx.fillStyle = 'rgb(8,12,18)'
    ctx.fillText(text, x + padX, py + padY + m.actualBoundingBoxAscent)
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
        drawSubjectRing(ctx, x1, y1, x2, y2, isPerson ? C.person : C.object, isPerson ? 2 : 1.5, 0.75)
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
        // GREEN = in the database, and the only thing that gets text: the
        // name. AMBER = a person, not recognised — no caption at all, because
        // "unknown" is already said by the colour, and the side panel carries
        // the detail. Captioning every stranger is what made the frame noisy.
        if (ident) {
            drawSubjectRing(ctx, x1, y1, x2, y2, C.known)
            drawPill(ctx, ident.name.toUpperCase(), x1, y1, C.known)
        } else {
            drawSubjectRing(ctx, x1, y1, x2, y2, C.unknown, 1.5, 0.55)
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
            // Selected but not yet flying at them. A name if we have one and
            // nothing otherwise — "PERSON FOUND" told the operator nothing
            // they could not already see.
            drawSubjectRing(ctx, x1, y1, x2, y2, C.locked, 2.5)
            drawCrosshair(ctx, tx, ty, C.locked, 6, 10)
            if (r.person_name) {
                drawPill(ctx, r.person_name.toUpperCase(), x1, y1, C.locked)
            }
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
        ctx.font = `600 ${Math.max(13, Math.round(H * 0.0155))}px 'Geist Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, 'Cascadia Code', Menlo, monospace`
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
        drawSubjectRing(ctx, x1, y1, x2, y2, C.person, 1.5, 0.5)
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

/** Soft-glow rounded ring — the modern replacement for corner brackets on
 *  anything that is a subject rather than clutter. */
function drawSubjectRing(
    ctx: CanvasRenderingContext2D,
    x1: number, y1: number, x2: number, y2: number,
    color: string, width = 2.5, alpha = 1,
) {
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.strokeStyle = color
    ctx.lineWidth = width
    roundRectPath(ctx, x1, y1, x2, y2); ctx.stroke()
    ctx.restore()
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
        else drawSubjectRing(ctx, x1, y1, x2, y2, C.vehicle, 1.5, 0.7)

        // ONE thing on screen per vehicle: the plate. vehicle_id, colour,
        // type and speed were all crammed into a single dense caption —
        // "719257C VH-000001 blue car ~48km/h" — which is what actually read
        // as dated, not the chip style. All of it is already in the side
        // panel, laid out properly, and none of it needs to be read off a
        // moving picture.
        //
        // A trailing "?" marks a reading only one frame produced. It is still
        // shown AND still logged: at drone standoff a single-frame read is
        // often the only read a passing vehicle will ever give.
        if (v.plate) {
            const text = `${v.plate}${v.plate_strong ? '' : '?'}`
            // Solid pill for the followed vehicle, quiet chip for the rest —
            // hierarchy by weight, not by cramming in more words.
            if (locked) drawPill(ctx, text, x1, y1, C.active)
            else drawBadge(ctx, text, x1, Math.max(16, y1 - 4),
                           v.plate_strong ? C.known : C.unknown)
        } else if (locked) {
            drawPill(ctx, v.vehicle_id ?? 'FOLLOWING', x1, y1, C.active)
        }

        if (v.plate_box) {
            const [px1, py1, px2, py2] = v.plate_box
            drawSubjectRing(ctx, px1, py1, px2, py2,
                            v.plate_strong ? C.known : C.unknown, 2)
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
// A LIST per mode, not one field. traffic-management draws vehicles AND
// people, and while only one could be smoothed the other was drawn raw — so
// person boxes snapped between detections at the analyser's rate while vehicle
// boxes glided. That is exactly the "smooth in other modules, jumping here"
// report: crowd-management smooths 'people', traffic did not.
const SMOOTHED_FIELDS: Record<string, string[]> = {
    'object-detection':      ['detections'],
    'human-tracking':        ['persons'],
    'person-tracking':       ['persons'],
    'crowd-management':      ['people'],
    'vehicle-plate-tracking': ['vehicles'],
    'traffic-management':     ['vehicles', 'people'],
}

// A mode listed in CLICK_TO_SELECT or drawn by the switch below must ALSO be
// in OVERLAY_CAPABLE (lib/videoSettings.ts), or this component is never
// mounted for it and every interaction here is dead code. In dev that
// disagreement is now loud instead of silent — traffic-management sat in this
// map with a full draw function and a click handler while falling through to
// the processed feed, which cost several rounds of debugging the wrong layer.
if (process.env.NODE_ENV !== 'production') {
    void import('@/lib/videoSettings').then(({ overlayCapableModes }) => {
        for (const m of Object.keys(CLICK_TO_SELECT)) {
            if (!overlayCapableModes().includes(m)) {
                console.error(
                    `[CvOverlayCanvas] "${m}" expects a client overlay but is not in `
                    + 'OVERLAY_CAPABLE — the canvas will never mount, so hover and '
                    + 'click-to-follow cannot work in that mode.',
                )
            }
        }
    })
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
    W: number, H: number,
): { x: number; y: number } {
    // W/H are the SOURCE FRAME size, passed in rather than read off the
    // canvas: the backing store is supersampled for sharpness, so
    // canvas.width is a multiple of the source width and using it here would
    // scale every click by that factor.
    const rect = canvas.getBoundingClientRect()
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
    // NO DENSITY GRID IN THIS MODE, and no counts burned into the picture.
    //
    // The grid is crowd-management's tool for answering "which zone is
    // busiest" over a static venue. Traffic is watched moving, and there the
    // tinted cells and their per-cell numbers sit on top of the vehicles and
    // people the operator is actually trying to look at, while the same
    // headcount is already on the panel — laid out properly, and readable
    // without staring through it.
    //
    // Same reasoning retires the corner readout: vehicle/people/plate counts
    // and the telemetry and ALPR warnings are all panel material. What earns
    // space on the video is only what is POSITIONAL — a box has to be on the
    // picture because it points at something in the picture. A number does
    // not.

    // ── People, named where recognised ───────────────────────────────────
    const byTrack = new Map((r.identities ?? []).map(i => [i.track_id, i]))
    // A person can be the followed subject in this mode, not just a vehicle,
    // so the lock has to read the same on both. Without this the drone flies
    // at someone with nothing on screen saying which one.
    const lockedTrack = r.locked_track_id ?? null
    const followedPerson = r.locked_kind === 'person' ? lockedTrack : null
    for (const p of r.people ?? []) {
        const [x1, y1, x2, y2] = p.box
        const ident = byTrack.get(p.id)
        ctx.globalAlpha = alphaOf(p)
        if (p.id === followedPerson) {
            drawLockedRing(ctx, x1, y1, x2, y2, C.active)
            drawPill(ctx, (ident?.name ?? 'FOLLOWING').toUpperCase(), x1, y1, C.active)
        } else if (ident) {
            drawSubjectRing(ctx, x1, y1, x2, y2, C.known)
            drawPill(ctx, ident.name.toUpperCase(), x1, y1, C.known)
        } else {
            drawSubjectRing(ctx, x1, y1, x2, y2, C.unknown, 1.5, 0.55)
        }
    }
    ctx.globalAlpha = 1

    // The recentering guide belongs to whichever subject is followed, so it is
    // drawn for a locked person here rather than only inside the vehicle loop.
    if (followedPerson !== null && r.tracking) {
        const p = (r.people ?? []).find(q => q.id === followedPerson)
        if (p) {
            const [x1, y1, x2, y2] = p.box
            const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
            ctx.strokeStyle = C.lightGray
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(tx, ty); ctx.stroke()
            drawCrosshair(ctx, tx, ty, C.white, 8, 12)
            ctx.fillStyle = 'rgb(180,180,180)'
            ctx.beginPath(); ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2); ctx.fill()
        }
    }

    for (const v of r.vehicles ?? []) {
        const [x1, y1, x2, y2] = v.box
        const locked = v.locked
        const wrongWay = v.against_flow === true
        ctx.globalAlpha = alphaOf(v)
        // Against-flow outranks the lock. A vehicle driving into the traffic
        // is the one thing on this picture that must not be missed, and grey
        // among twenty other greys is exactly how it would be.
        if (wrongWay) drawLockedRing(ctx, x1, y1, x2, y2, C.red)
        else if (locked) drawLockedRing(ctx, x1, y1, x2, y2, C.active)
        else drawSubjectRing(ctx, x1, y1, x2, y2, C.vehicle, 1.5, 0.7)

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
        const accent = wrongWay ? C.red : locked ? C.active : C.vehicle
        drawBadge(ctx, wrongWay ? `WRONG WAY  ${label}` : label,
                  x1, Math.max(16, y1 - 4), accent)

        // Where it is going, drawn from the vehicle's own centre. The arrow is
        // the point of the whole direction estimate: a bearing in a text label
        // has to be decoded against the drone's heading before it means
        // anything, while an arrow over the car is read instantly.
        if (v.screen_dir) {
            const [dx, dy] = v.screen_dir
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
            // Scaled to the vehicle so it stays proportionate as the box grows,
            // and clamped so a distant car's arrow is still visible and a near
            // one's does not span the frame.
            const len = Math.min(90, Math.max(22, (x2 - x1) * 0.55))
            drawHeadingArrow(ctx, cx, cy, dx, dy, len, accent)
        }

        // The plate bracket is placed RELATIVE to the vehicle box, so it
        // travels with the vehicle and vanishes with it. Drawn from absolute
        // coordinates it sat wherever the plate had been when OCR last ran on
        // that vehicle — which, on a per-frame budget of a couple of calls, is
        // often seconds and half a frame ago — and then lingered there while
        // the box itself was smoothed and faded away.
        if (v.plate_box_rel) {
            const [fx1, fy1, fx2, fy2] = v.plate_box_rel
            const bw = x2 - x1, bh = y2 - y1
            drawBrackets(ctx, x1 + fx1 * bw, y1 + fy1 * bh,
                              x1 + fx2 * bw, y1 + fy2 * bh, C.green, 2)
        }
    }

    // ── Recentering guide for a followed VEHICLE ─────────────────────────
    // Was drawn for a followed person and not for a vehicle, so the same
    // control looked half-implemented depending on what you picked. Same
    // shape as human-tracking's: a line from frame centre to the target, so
    // which way and how far it sits off-centre is visible at a glance rather
    // than inferred from the PD command.
    const followedVehicle = r.locked_kind !== 'person' ? lockedTrack : null
    if (followedVehicle !== null && r.tracking) {
        const v = (r.vehicles ?? []).find(q => q.track_id === followedVehicle)
        if (v) {
            const [x1, y1, x2, y2] = v.box
            const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2
            ctx.globalAlpha = 1
            ctx.strokeStyle = C.lightGray
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(tx, ty); ctx.stroke()
            drawCrosshair(ctx, tx, ty, C.white, 8, 12)
            ctx.fillStyle = 'rgb(180,180,180)'
            ctx.beginPath(); ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2); ctx.fill()
        }
    }
    ctx.globalAlpha = 1

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
    // Source frame size, shared between the render loop and the pointer
    // handlers so a click is mapped with the same dimensions it was drawn at.
    const sourceSize = useRef({ W: 1280, H: 720 })
    const lastPayload = useRef<CVResult | null>(null)

    useEffect(() => {
        if (!cvResults) return
        latest.current = cvResults
        for (const field of SMOOTHED_FIELDS[mode] ?? []) {
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
            sourceSize.current = { W, H }

            // SUPERSAMPLE THE BACKING STORE.
            //
            // The canvas used to be exactly the source frame — 1280x720, say —
            // and then CSS-stretched to fill the player. On a HiDPI screen
            // that is a 1280-wide bitmap blown up to 2560+ device pixels, so
            // every ring, pill and character came out soft and blocky. The
            // VIDEO underneath stayed sharp, which is what makes it read as
            // "the overlay is pixelated" rather than as a resolution problem.
            //
            // Drawing coordinates stay in SOURCE pixels: the transform below
            // absorbs the factor, so no drawing code changes and box
            // coordinates from the server still land where they should.
            const rect = canvas.getBoundingClientRect()
            const dpr = window.devicePixelRatio || 1
            // Never below 1 (that would blur boxes to gain nothing) and capped
            // at 3 — beyond that the memory cost climbs quadratically for a
            // difference no one can see.
            const ss = rect.width > 0
                ? Math.min(3, Math.max(1, (rect.width * dpr) / W))
                : 1
            const bw = Math.round(W * ss), bh = Math.round(H * ss)
            if (canvas.width !== bw || canvas.height !== bh) {
                canvas.width = bw
                canvas.height = bh
            }
            // Re-applied every frame: setting canvas.width resets the
            // transform, and a frame drawn untransformed would be a visible
            // jump rather than a silent no-op.
            ctx.setTransform(ss, 0, 0, ss, 0, 0)
            ctx.clearRect(0, 0, W, H)
            if (!r) return

            // Replace each raw list with its interpolated, faded one. Every
            // other field passes through untouched, so status badges and
            // counts keep reporting exactly what the server said.
            const fields = SMOOTHED_FIELDS[mode] ?? []
            const view: CVResult = fields.length
                ? fields.reduce<CVResult>(
                    (acc, f) => ({ ...acc, [f]: smoothers.current.sample(f) }),
                    r,
                  )
                : r

            ctx.font = `600 ${Math.max(13, Math.round(H * 0.0155))}px 'Geist Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, 'Cascadia Code', Menlo, monospace`
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
                // Must search the SAME lists targetsNow() offers, or a target
                // can be hoverable and clickable while showing no highlight —
                // which reads as a dead control. That was happening to people
                // in traffic-management: hovering set the id, the lookup
                // searched vehicles only, and nothing lit up.
                const p = VEHICLE_CLICK_MODES[mode]
                    ? ((view.vehicles ?? []).find(q => q.track_id === hovered.current)
                       ?? (view.people ?? []).find(q => q.id === hovered.current))
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
    /** What can be clicked, IN THE POSITIONS THEY ARE DRAWN.
     *
     *  This used to hit-test the raw payload while the canvas drew the
     *  SMOOTHED boxes, so the two disagreed by exactly the interpolation lag.
     *  The operator aims at the box they can see and the test runs against one
     *  somewhere else — the click lands in the gap and nothing is emitted, no
     *  error, no feedback.
     *
     *  Small when detections are fast, which is why it went unnoticed. In
     *  traffic-management, running native at ~20 fps against 30 fps video, the
     *  gap grew to most of a box and clicking stopped working altogether: not
     *  one set_follow_vehicle reached the server across a whole session, while
     *  the same click in plate mode locked first try.
     *
     *  Sampling the smoothers here means the hit box is the drawn box, by
     *  construction, at any detection rate. */
    const targetsNow = (): { id: number; box: [number, number, number, number] }[] => {
        const r = latest.current
        if (!r) return []
        const smoothed = (field: string) =>
            smoothers.current.sample(field) as unknown as
                { id?: number; track_id?: number; box: [number, number, number, number]; _a?: number }[]
        // A box mid-fade is a memory of a detection, not a target. Clicking one
        // would lock a track the analyser has already lost.
        type Clickable = {
            id?: number; track_id?: number
            box: [number, number, number, number]; _a?: number
        }
        const solid = (items: Clickable[]) => items.filter(i => (i._a ?? 1) > 0.55)

        if (VEHICLE_CLICK_MODES[mode]) {
            const vehicles = solid(smoothed('vehicles'))
                .filter(v => v.track_id != null)
                .map(v => ({ id: v.track_id as number, box: v.box }))
            // traffic-management follows PEOPLE as well as vehicles, and both
            // come out of one ByteTrack pass — so their ids share a space and
            // a person is just another target in the same list. No separate
            // event and no "which kind did you mean" in the payload.
            if (mode === 'traffic-management') {
                return vehicles.concat(
                    solid(smoothed('people')).map(p => ({ id: p.id as number, box: p.box })),
                )
            }
            return vehicles
        }
        if (mode === 'crowd-management') {
            return solid(smoothed('people')).map(p => ({ id: p.id as number, box: p.box }))
        }
        return solid(smoothed('persons')).map(p => ({ id: p.id as number, box: p.box }))
    }

    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas || !clickable) return
        const { W, H } = sourceSize.current
        const { x, y } = toSourceCoords(canvas, e.clientX, e.clientY, fit, W, H)
        hovered.current = hitTest(targetsNow(), x, y)
    }

    const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        if (!canvas || !clickable) return
        const { W, H } = sourceSize.current
        const { x, y } = toSourceCoords(canvas, e.clientX, e.clientY, fit, W, H)
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

// Verifies the six calibration orientations in DroneModel3D.
//
// WHY THIS EXISTS AS A SCRIPT. Getting a rotation sign wrong does not throw,
// does not fail the build, and does not look obviously wrong on screen — a
// quadcopter is close enough to symmetric that "resting on its left side" and
// "resting on its right side" are one glance apart. What it does instead is
// silently ask the operator to hold the aircraft the wrong way round for two
// minutes, and PX4 accepts whatever it is given.
//
// So the table is checked against the actual CSS rotation matrices rather than
// against a comment. It PARSES THE COMPONENT, so it cannot drift from a copy
// of the values that was right when it was written.
//
//   node scripts/verify-calibration-orientations.mjs

import { readFileSync } from 'node:fs'

const SRC = 'src/components/config/DroneModel3D.tsx'
const src = readFileSync(new URL(`../${SRC}`, import.meta.url), 'utf8')

const block = src.match(/SIDE_TRANSFORM[^{]*\{([\s\S]*?)\}/)
if (!block) {
    console.error(`Could not find SIDE_TRANSFORM in ${SRC}`)
    process.exit(1)
}

const table = {}
for (const m of block[1].matchAll(/(\w+)\s*:\s*'rotate([XY])\((-?[\d.]+)deg\)'/g)) {
    table[m[1]] = [m[2], Number(m[3])]
}

const rad = d => (d * Math.PI) / 180
// The CSS 3D rotation matrices, applied to a column vector in the element's
// local frame: +X right, +Y down the screen (aft on the aircraft), +Z toward
// the viewer (up on the aircraft).
const rotX = (v, d) => {
    const t = rad(d)
    return [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)]
}
const rotY = (v, d) => {
    const t = rad(d)
    return [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1], -v[0] * Math.sin(t) + v[2] * Math.cos(t)]
}

// PX4 names each orientation by WHICH FACE POINTS DOWN, so the aircraft's
// up-axis must end up pointing at the opposite face. Lying on its left side,
// the top faces right (+X); nose down, the top faces aft (+Y).
const EXPECT = {
    down:  [0, 0, 1],
    up:    [0, 0, -1],
    left:  [1, 0, 0],
    right: [-1, 0, 0],
    front: [0, 1, 0],
    back:  [0, -1, 0],
}

let failed = 0
for (const [side, expect] of Object.entries(EXPECT)) {
    const entry = table[side]
    if (!entry) {
        console.error(`✗ ${side.padEnd(6)} missing from SIDE_TRANSFORM`)
        failed++
        continue
    }
    const [axis, deg] = entry
    const v = (axis === 'X' ? rotX([0, 0, 1], deg) : rotY([0, 0, 1], deg))
        .map(n => (Math.abs(n) < 1e-9 ? 0 : Number(n.toFixed(6))))
    const ok = v.every((n, i) => Math.abs(n - expect[i]) < 1e-6)
    if (!ok) failed++
    console.log(
        `${ok ? '✓' : '✗'} ${side.padEnd(6)} rotate${axis}(${deg}deg) → up-axis ${JSON.stringify(v)}` +
        (ok ? '' : `  EXPECTED ${JSON.stringify(expect)}`)
    )
}

const extra = Object.keys(table).filter(k => !(k in EXPECT))
if (extra.length) {
    console.error(`✗ unexpected orientations: ${extra.join(', ')}`)
    failed++
}

console.log(failed === 0 ? '\nAll six orientations correct.' : `\n${failed} wrong.`)
process.exit(failed === 0 ? 0 : 1)

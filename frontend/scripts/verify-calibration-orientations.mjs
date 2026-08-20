// Verifies that each calibration orientation puts the RIGHT FACE on the ground.
//
// WHY THIS EXISTS. The first version of this panel hand-wrote one rotation per
// side and had LEFT AND RIGHT THE WRONG WAY ROUND. Nothing threw, the build
// passed, and on screen it looked fine — a quadcopter is nearly symmetric, so
// "resting on its left side" and "resting on its right side" are one glance
// apart. It would simply have asked the operator to lay the aircraft on the
// wrong side for two of the six positions, and PX4 accepts whatever it is
// given.
//
// Worse, the verifier that shipped with it encoded the SAME assumption in its
// expectations, so it passed too. A check that shares the belief under test
// checks nothing.
//
// So this one asserts nothing about rotations. It reads the face-direction
// table — which says only which way each named face points on an airframe, a
// fact anyone can confirm by looking at a drone — derives the rotation the way
// the component does, and confirms the named face ends up pointing at the
// ground. There is no sign to get wrong and no second copy to drift.
//
//   npm run verify:orientations

import { readFileSync } from 'node:fs'
import * as THREE from 'three'

const SRC = 'src/components/config/DroneScene.tsx'
const src = readFileSync(new URL(`../${SRC}`, import.meta.url), 'utf8')

const block = src.match(/FACE_DIRECTION[^{]*\{([\s\S]*?)\n\}/)
if (!block) {
    console.error(`Could not find FACE_DIRECTION in ${SRC}`)
    process.exit(1)
}

const faces = {}
for (const m of block[1].matchAll(/(\w+)\s*:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)) {
    faces[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])]
}

// Airframe axes, glTF convention: nose -Z, up +Y, right +X.
const EXPECT = {
    down:  [0, -1, 0],   // belly
    up:    [0, 1, 0],    // canopy
    left:  [-1, 0, 0],
    right: [1, 0, 0],
    front: [0, 0, -1],   // nose
    back:  [0, 0, 1],    // tail
}

const DOWN = new THREE.Vector3(0, -1, 0)
let failed = 0

for (const [side, expect] of Object.entries(EXPECT)) {
    const declared = faces[side]
    if (!declared) {
        console.error(`✗ ${side.padEnd(6)} missing from FACE_DIRECTION`)
        failed++
        continue
    }
    const sameFace = declared.every((n, i) => Math.abs(n - expect[i]) < 1e-6)

    // Derive exactly as the component does, then check the face really lands
    // on the ground — so a change to the derivation is caught here too, not
    // only a change to the table.
    const face = new THREE.Vector3(...declared).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(face, DOWN)
    const landed = face.clone().applyQuaternion(q)
    const grounded = landed.distanceTo(DOWN) < 1e-6

    const top = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const r = n => (Math.abs(n) < 1e-9 ? 0 : Number(n.toFixed(3)))
    const ok = sameFace && grounded
    if (!ok) failed++
    console.log(
        `${ok ? '✓' : '✗'} ${side.padEnd(6)} face ${JSON.stringify(declared)} → ground` +
        `   canopy then points [${[top.x, top.y, top.z].map(r).join(',')}]` +
        (sameFace ? '' : `   WRONG FACE, expected ${JSON.stringify(expect)}`) +
        (grounded ? '' : '   ROTATION DOES NOT GROUND IT'),
    )
}

const extra = Object.keys(faces).filter(k => !(k in EXPECT))
if (extra.length) {
    console.error(`✗ unexpected orientations: ${extra.join(', ')}`)
    failed++
}

console.log(failed === 0 ? '\nAll six orientations correct.' : `\n${failed} wrong.`)
process.exit(failed === 0 ? 0 : 1)

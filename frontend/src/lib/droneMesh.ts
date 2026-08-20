// A quadcopter built as real geometry, so it reads as an aircraft rather than
// as a diagram of one.
//
// THE PREVIOUS ATTEMPT WAS FLAT AND THAT WAS THE PROBLEM. CSS transforms can
// only stack and rotate rectangles: there is no light, so nothing has a lit
// edge and a shaded one, and an operator looking at it cannot tell a body from
// an arm or the top from the bottom — which is fatal for a control whose only
// job is "hold the aircraft THIS way up". Real geometry under real lights
// solves it for free, because that is how anyone reads a shape.
//
// PROCEDURAL, NOT AN ASSET, on purpose: it ships with no file to load, no
// licence to track, and it takes the accent colour from the panel so it
// matches the app in both themes. loadDroneModel() below is the door for a
// supplied .glb when there is one — that path replaces the airframe and keeps
// everything else (lights, orientation, arrows) exactly as it is.

import * as THREE from 'three'

export interface DroneParts {
    root: THREE.Group
    /** Spun by the render loop. Empty when a supplied model has no named props. */
    rotors: THREE.Object3D[]
    /** Recoloured when the calibration state changes. */
    accents: THREE.MeshStandardMaterial[]
    dispose: () => void
}

const ARM_ANGLES = [45, 135, 225, 315]      // X-frame, degrees clockwise from nose

/** Rounded rectangle as a Shape, for an extruded body with real chamfers.
 *  A plain BoxGeometry reads as a brick; the bevel is most of what makes this
 *  look like a moulded airframe rather than a placeholder. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
    const s = new THREE.Shape()
    s.moveTo(-w / 2 + r, -h / 2)
    s.lineTo(w / 2 - r, -h / 2)
    s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
    s.lineTo(w / 2, h / 2 - r)
    s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
    s.lineTo(-w / 2 + r, h / 2)
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
    s.lineTo(-w / 2, -h / 2 + r)
    s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
    return s
}

// ── Propeller ────────────────────────────────────────────────────────────────
//
// ONE MESH, not a hub with two boxes stuck on it. The box version read as two
// sticks, and it read that way because that is what it was: a real propeller
// is a continuous surface whose chord tapers and whose pitch twists along the
// span, and none of that survives being approximated by a cuboid.
//
// Built rather than downloaded on purpose. A model off the internet arrives
// with a licence to honour, a file to ship and an axis convention to fight,
// and the shape wanted here is a lofted surface with four numbers in it. The
// door for a supplied asset is loadDroneModel() at the bottom of this file —
// that path takes a whole airframe, propellers included.

const BLADE_SEGMENTS = 22
const BLADE_ROOT = 0.13
const BLADE_TIP = 1.12
/** Total washout from root to tip, radians. Real props twist a lot — a blade
 *  with a constant angle is the flat plate the last version looked like. */
const BLADE_TWIST = 0.62

/** Chord at a fraction of the span. Narrow at the root, widest around 60%,
 *  rounded off at the tip — the planform that makes a propeller recognisable
 *  in silhouette, which is the only way it is seen edge-on. */
function chordAt(t: number): number {
    return 0.1 + 0.24 * Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.06))
}

/** One blade, along +X, as a lofted surface: a cambered chord line swept
 *  outward while it tapers and twists.
 *
 *  `hand` flips the pitch, which is what makes a CW and a CCW propeller
 *  different objects. Adjacent rotors on a quad turn opposite ways, and two
 *  identical props on a four-motor aircraft is the kind of detail that reads
 *  as wrong without the viewer being able to say why.
 */
function bladeGeometry(hand: number): THREE.BufferGeometry {
    const positions: number[] = []
    const indices: number[] = []
    const rows = BLADE_SEGMENTS
    const cols = 6                       // points across the chord

    for (let i = 0; i <= rows; i++) {
        const t = i / rows
        const span = BLADE_ROOT + (BLADE_TIP - BLADE_ROOT) * t
        const chord = chordAt(t)
        // Washout: most of the twist is near the root, none at the tip.
        const twist = BLADE_TWIST * (1 - t) * hand
        for (let j = 0; j <= cols; j++) {
            const c = j / cols - 0.5                       // -0.5 .. 0.5 across chord
            // Camber: a shallow arc rather than a flat line, so the two faces
            // shade differently and the blade has an obvious leading edge.
            const camber = 0.055 * (0.25 - c * c)
            const yz = new THREE.Vector2(camber, c * chord)
                .rotateAround(new THREE.Vector2(0, 0), twist)
            positions.push(span, yz.x, yz.y)
        }
    }
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const a = i * (cols + 1) + j
            const b = a + cols + 1
            indices.push(a, b, a + 1, b, b + 1, a + 1)
        }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    return g
}

/** Hub plus both blades as ONE geometry, built synchronously.
 *
 *  Merged by hand rather than through BufferGeometryUtils so buildDrone stays
 *  synchronous — an async model means a frame where the aircraft has no
 *  propellers, and the panel's whole job is to be looked at.
 */
export function mergeSync(sign: number): THREE.BufferGeometry {
    const hub = new THREE.CylinderGeometry(0.115, 0.135, 0.15, 20)
    const blade = bladeGeometry(sign)
    const blades = [blade, blade.clone().rotateY(Math.PI)]
    const parts = [hub, ...blades].map(g => g.index ? g.toNonIndexed() : g)
    let n = 0
    for (const g of parts) n += g.getAttribute('position').count
    const pos = new Float32Array(n * 3)
    let o = 0
    for (const g of parts) {
        pos.set(g.getAttribute('position').array as Float32Array, o)
        o += g.getAttribute('position').count * 3
    }
    hub.dispose()
    blades.forEach(g => g.dispose())
    parts.forEach(g => g.dispose())
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    out.computeVertexNormals()
    return out
}

export function buildDrone(accentHex = 0x22d3ee): DroneParts {
    const root = new THREE.Group()
    const rotors: THREE.Object3D[] = []
    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []

    const track = <T extends THREE.BufferGeometry>(g: T) => { geometries.push(g); return g }
    const mat = <T extends THREE.Material>(m: T) => { materials.push(m); return m }

    const shell = mat(new THREE.MeshStandardMaterial({
        color: 0x2c3440, metalness: 0.35, roughness: 0.45,
    }))
    const dark = mat(new THREE.MeshStandardMaterial({
        color: 0x171b22, metalness: 0.5, roughness: 0.35,
    }))
    const carbon = mat(new THREE.MeshStandardMaterial({
        color: 0x0f1319, metalness: 0.2, roughness: 0.6,
    }))
    // Accent materials are held so the calibration state can recolour them —
    // the aircraft itself turning amber then green is a stronger signal than
    // any badge next to it, and it is visible from across a flight line.
    const accents: THREE.MeshStandardMaterial[] = []
    const makeAccent = (emissive: number) => {
        const m = mat(new THREE.MeshStandardMaterial({
            color: accentHex, emissive: accentHex, emissiveIntensity: emissive,
            metalness: 0.3, roughness: 0.4,
        }))
        accents.push(m)
        return m
    }
    // Bright enough to carry the calibration state on its own: the AIRCRAFT
    // turning amber and then green is the signal, not a badge beside it.
    const accentBody = makeAccent(0.55)
    const accentLed = makeAccent(2.2)

    // ── Fuselage ─────────────────────────────────────────────────────────
    const bodyGeo = track(new THREE.ExtrudeGeometry(roundedRect(1.55, 2.1, 0.42), {
        depth: 0.46, bevelEnabled: true, bevelSize: 0.09, bevelThickness: 0.09,
        bevelSegments: 4, curveSegments: 18,
    }))
    bodyGeo.center()
    const body = new THREE.Mesh(bodyGeo, shell)
    body.rotation.x = -Math.PI / 2          // extruded in Z, stood up into Y
    body.castShadow = true
    root.add(body)

    // Canopy — a clipped sphere. The single biggest cue that the top is the
    // top, which is the whole question this control asks.
    const canopyGeo = track(new THREE.SphereGeometry(0.78, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2))
    const canopy = new THREE.Mesh(canopyGeo, mat(new THREE.MeshStandardMaterial({
        color: 0x39434f, metalness: 0.55, roughness: 0.22,
    })))
    canopy.scale.set(0.95, 0.72, 1.3)
    canopy.position.y = 0.21
    canopy.castShadow = true
    root.add(canopy)

    // Nose flash, so FORWARD is unmistakable at any angle.
    const noseGeo = track(new THREE.ConeGeometry(0.26, 0.68, 4))
    const nose = new THREE.Mesh(noseGeo, accentBody)
    nose.rotation.set(Math.PI / 2, 0, Math.PI / 4)
    nose.position.set(0, 0.14, -1.2)
    root.add(nose)

    // ── Gimbal ball, under the nose ──────────────────────────────────────
    const gimbalArm = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.07, 0.07, 0.28, 12)), dark)
    gimbalArm.position.set(0, -0.32, -0.62)
    root.add(gimbalArm)
    const gimbal = new THREE.Mesh(track(new THREE.SphereGeometry(0.26, 24, 16)), dark)
    gimbal.position.set(0, -0.52, -0.66)
    gimbal.castShadow = true
    root.add(gimbal)
    const lens = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.13, 0.15, 0.1, 20)),
        mat(new THREE.MeshStandardMaterial({ color: 0x05070a, metalness: 0.9, roughness: 0.08 })))
    lens.rotation.x = Math.PI / 2
    lens.position.set(0, -0.52, -0.88)
    root.add(lens)

    // ── Arms, motors, rotors ─────────────────────────────────────────────
    const armGeo = track(new THREE.CylinderGeometry(0.085, 0.13, 1.55, 14))
    const canGeo = track(new THREE.CylinderGeometry(0.19, 0.225, 0.26, 24))
    const bellGeo = track(new THREE.CylinderGeometry(0.245, 0.215, 0.2, 24))
    const legGeo = track(new THREE.CylinderGeometry(0.05, 0.04, 0.75, 10))
    const footGeo = track(new THREE.CapsuleGeometry(0.055, 0.42, 4, 10))
    const ledGeo = track(new THREE.SphereGeometry(0.115, 14, 12))

    // Two handednesses, shared by four rotors. Built synchronously from the
    // hub so the model is never briefly propeller-less; the merged version
    // swaps in when the util resolves.
    const propMat = mat(new THREE.MeshStandardMaterial({
        color: 0x1a1f27, metalness: 0.25, roughness: 0.55,
        side: THREE.DoubleSide,
    }))
    const propGeo: THREE.BufferGeometry[] = [
        track(mergeSync(1)), track(mergeSync(-1)),
    ]

    ARM_ANGLES.forEach((deg, i) => {
        const front = deg === 45 || deg === 315
        const a = new THREE.Group()
        a.rotation.y = THREE.MathUtils.degToRad(-deg)
        root.add(a)

        const arm = new THREE.Mesh(armGeo, front ? accentBody : carbon)
        arm.rotation.x = Math.PI / 2
        arm.rotation.z = 0
        arm.position.set(0, 0.02, -0.92)
        arm.castShadow = true
        a.add(arm)

        const can = new THREE.Mesh(canGeo, dark)
        can.position.set(0, 0.15, -1.62)
        can.castShadow = true
        a.add(can)

        const bell = new THREE.Mesh(bellGeo, front ? accentBody : shell)
        bell.position.set(0, 0.35, -1.62)
        a.add(bell)

        // Rotor: ONE mesh — hub and both blades in a single lofted geometry.
        // Real blades rather than a disc, because a disc at rest is a plate and
        // the model has to look right STANDING STILL, which during a
        // calibration is the only way it is ever seen.
        //
        // Adjacent rotors turn opposite ways on a quad, so their blades are
        // mirrored. Building both handedness once and sharing the geometry
        // keeps it to two buffers for four rotors.
        const rotor = new THREE.Mesh(propGeo[i % 2], propMat)
        rotor.position.set(0, 0.5, -1.62)
        rotor.castShadow = true
        a.add(rotor)
        rotors.push(rotor)

        // Landing leg under each arm, angled out.
        const leg = new THREE.Mesh(legGeo, carbon)
        leg.position.set(0, -0.42, -0.86)
        leg.rotation.x = -0.28
        a.add(leg)
        const foot = new THREE.Mesh(footGeo, dark)
        foot.rotation.x = Math.PI / 2
        foot.position.set(0, -0.78, -0.98)
        a.add(foot)

        // Navigation LEDs — green forward, red aft, as on the real thing.
        const led = new THREE.Mesh(ledGeo, front ? accentLed : mat(new THREE.MeshStandardMaterial({
            color: 0xf87171, emissive: 0xf87171, emissiveIntensity: 1.2,
        })))
        led.position.set(0, -0.02, -1.62)
        a.add(led)
    })

    const dispose = () => {
        geometries.forEach(g => g.dispose())
        materials.forEach(m => m.dispose())
    }

    return { root, rotors, accents, dispose }
}

/** Load a supplied .glb instead of the procedural airframe.
 *
 *  DROP A FILE AT public/models/drone.glb AND IT IS USED. Nothing else about
 *  the panel changes — orientation, arrows, lighting and the calibration logic
 *  all act on the returned group, so a real model of the actual airframe is a
 *  file copy rather than a rewrite.
 *
 *  Conventions the model must follow, and they are the glTF defaults: +Y up,
 *  NOSE ALONG -Z. Anything named `rotor*`/`prop*` spins. The model is scaled to
 *  a ~4-unit span and centred, so its authored size does not matter.
 */
export async function loadDroneModel(url: string): Promise<DroneParts | null> {
    try {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
        const gltf = await new GLTFLoader().loadAsync(url)
        const root = gltf.scene

        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const span = Math.max(size.x, size.z) || 1
        root.scale.setScalar(4 / span)
        const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(4 / span)
        root.position.sub(centre)

        const rotors: THREE.Object3D[] = []
        const accents: THREE.MeshStandardMaterial[] = []
        root.traverse(o => {
            const n = o.name.toLowerCase()
            if (n.startsWith('rotor') || n.startsWith('prop')) rotors.push(o)
            const m = (o as THREE.Mesh).material
            if (m instanceof THREE.MeshStandardMaterial && n.includes('accent')) accents.push(m)
            o.castShadow = true
        })
        return { root, rotors, accents, dispose: () => {} }
    } catch {
        // A missing or broken file falls back to the built-in airframe rather
        // than leaving an empty panel — this path exists so a model can be
        // dropped in, and a typo in the filename must not break calibration.
        return null
    }
}

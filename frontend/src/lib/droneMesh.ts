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

// ── Fuselage ─────────────────────────────────────────────────────────────────
//
// A LOFTED MONOCOQUE, NOT A BOX WITH A DOME ON IT. The extruded-rectangle
// body read as a student project for exactly the reason a moulded airframe
// does not: a real fuselage is one continuous surface whose cross-section
// swells and tapers along its length. This is the same loft technique as the
// propeller blade — superellipse cross-sections (softly squared sides, the
// signature of injection-moulded shells) swept nose to tail under a width, a
// height and a camber profile, with the canopy hump folded into the height
// profile rather than glued on top.

const HULL_ROWS = 42
const HULL_COLS = 28

/** sign(v)·|v|^(2/p): the superellipse exponent map. p=2 is an ellipse;
 *  higher p squares the sides off the way a moulded shell does. */
function superp(v: number, p: number): number {
    return Math.sign(v) * Math.pow(Math.abs(v), 2 / p)
}

function hullGeometry(): THREE.BufferGeometry {
    const positions: number[] = []
    const indices: number[] = []
    for (let i = 0; i <= HULL_ROWS; i++) {
        const t = i / HULL_ROWS                    // 0 = nose tip, 1 = tail tip
        const z = -1.5 + t * 2.9
        // Width: quick rise off the nose, widest just ahead of centre, long
        // gentle taper into the tail. The asymmetry is what makes the shape
        // read as pointing somewhere.
        const wProfile = Math.sin(Math.PI * Math.pow(t, 0.66))
        const w = Math.max(0.012, 0.84 * Math.pow(wProfile, 0.6))
        // Height, split at the waterline: the top carries a gaussian canopy
        // hump peaking over the battery bay; the belly stays shallower and
        // flatter, which is where the flat-bottomed, humped-top silhouette
        // of every commercial airframe comes from.
        const hump = 1 + 0.5 * Math.exp(-Math.pow((t - 0.44) / 0.2, 2))
        const hUp = Math.max(0.012, 0.4 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.74)), 0.7) * hump)
        const hDn = Math.max(0.012, 0.3 * Math.pow(wProfile, 0.62))
        const cy = 0.1
        for (let j = 0; j < HULL_COLS; j++) {
            const th = (j / HULL_COLS) * Math.PI * 2
            const x = w * superp(Math.cos(th), 2.6)
            const sv = Math.sin(th)
            const y = cy + (sv >= 0 ? hUp : hDn) * superp(sv, 2.2)
            positions.push(x, y, z)
        }
    }
    for (let i = 0; i < HULL_ROWS; i++) {
        for (let j = 0; j < HULL_COLS; j++) {
            const j2 = (j + 1) % HULL_COLS         // wrap the seam so normals stay smooth
            const a = i * HULL_COLS + j
            const b = (i + 1) * HULL_COLS + j
            const c = i * HULL_COLS + j2
            const d = (i + 1) * HULL_COLS + j2
            // Wound OUTWARD. The first cut had these reversed, which
            // culled the near wall and drew the inside of the far one — the
            // hull looked transparent and lit wrong everywhere at once.
            indices.push(a, c, b, b, c, d)
        }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    return g
}

export function buildDrone(accentHex = 0x22d3ee): DroneParts {
    const root = new THREE.Group()
    const rotors: THREE.Object3D[] = []
    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []

    const track = <T extends THREE.BufferGeometry>(g: T) => { geometries.push(g); return g }
    const mat = <T extends THREE.Material>(m: T) => { materials.push(m); return m }

    // The light warm-gray of a commercial airframe. On this app's dark
    // stage it is also simply the most legible choice — the hull is the
    // brightest thing in the scene, so the silhouette reads first.
    // MeshPhysicalMaterial for the shell: the clearcoat layer is the
    // glossy-over-matte finish of an injection-moulded product, which no
    // single-lobe standard material can fake.
    const shell = mat(new THREE.MeshPhysicalMaterial({
        color: 0x9aa1ab, metalness: 0.1, roughness: 0.5,
        clearcoat: 0.65, clearcoatRoughness: 0.22,
    }))
    const shellLight = mat(new THREE.MeshPhysicalMaterial({
        color: 0xb3b9c2, metalness: 0.08, roughness: 0.45,
        clearcoat: 0.5, clearcoatRoughness: 0.25,
    }))
    const armShell = mat(new THREE.MeshStandardMaterial({
        color: 0x525a66, metalness: 0.3, roughness: 0.5,
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
    const navRed = mat(new THREE.MeshStandardMaterial({
        color: 0xef4444, emissive: 0xdc2626, emissiveIntensity: 0.85,
    }))
    const navGreen = mat(new THREE.MeshStandardMaterial({
        color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.85,
    }))

    // ── Fuselage ─────────────────────────────────────────────────────────
    const hull = new THREE.Mesh(track(hullGeometry()), shell)
    hull.castShadow = true
    root.add(hull)

    // Belly plate — the darker underside break line every moulded airframe
    // has, and a strong "this side is the bottom" cue.
    const belly = new THREE.Mesh(track(hullGeometry()), dark)
    belly.scale.set(0.78, 0.42, 0.8)
    belly.position.y = -0.08
    root.add(belly)

    // Forward obstacle-sensor eyes, toed slightly outward — the detail that
    // most says "commercial aircraft", and a second nose cue after the gimbal.
    const visor = new THREE.Mesh(
        track(new THREE.SphereGeometry(0.42, 24, 16)),
        mat(new THREE.MeshPhysicalMaterial({
            color: 0x10161f, metalness: 0.4, roughness: 0.1,
            clearcoat: 1.0, clearcoatRoughness: 0.08,
        })))
    visor.scale.set(0.95, 0.5, 0.62)
    visor.position.set(0, 0.28, -0.98)
    root.add(visor)

    const eyeGeo = track(new THREE.SphereGeometry(0.075, 14, 12))
    const eyeMat = mat(new THREE.MeshStandardMaterial({
        color: 0x0a1622, metalness: 0.9, roughness: 0.12,
    }))
    for (const x of [-0.2, 0.2]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat)
        eye.position.set(x, 0.16, -1.32)
        root.add(eye)
    }

    // ── Gimbal, under the nose ───────────────────────────────────────────
    //
    // A yoke, a ball and a lens barrel rather than a sphere on a peg. It is
    // the only asymmetric thing hanging off the airframe, which makes it the
    // feature that tells an operator at a glance which way the aircraft is
    // facing and which way up it is — worth more here than anywhere else on
    // the model.
    const yokeSide = track(new THREE.BoxGeometry(0.05, 0.3, 0.16))
    for (const x of [-0.2, 0.2]) {
        const y = new THREE.Mesh(yokeSide, dark)
        y.position.set(x, -0.34, -0.7)
        root.add(y)
    }
    const yokeTop = new THREE.Mesh(track(new THREE.BoxGeometry(0.45, 0.07, 0.16)), dark)
    yokeTop.position.set(0, -0.21, -0.7)
    root.add(yokeTop)

    const gimbalBody = new THREE.Mesh(
        track(new THREE.CapsuleGeometry(0.17, 0.16, 6, 18)), dark)
    gimbalBody.rotation.x = Math.PI / 2
    gimbalBody.position.set(0, -0.47, -0.72)
    gimbalBody.castShadow = true
    root.add(gimbalBody)

    const barrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.14, 0.16, 0.16, 24)), dark)
    barrel.rotation.x = Math.PI / 2
    barrel.position.set(0, -0.47, -0.9)
    root.add(barrel)
    const lensRing = new THREE.Mesh(
        track(new THREE.TorusGeometry(0.15, 0.022, 10, 28)), accentBody)
    lensRing.position.set(0, -0.47, -0.955)
    root.add(lensRing)
    const glass = new THREE.Mesh(
        track(new THREE.SphereGeometry(0.125, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2)),
        mat(new THREE.MeshStandardMaterial({
            color: 0x0a1622, metalness: 1.0, roughness: 0.06,
        })))
    glass.rotation.x = -Math.PI / 2
    glass.position.set(0, -0.47, -0.97)
    root.add(glass)

    // ── Antennas & GNSS mast, aft ────────────────────────────────────────
    //
    // The equipment cluster every working multirotor carries and every
    // placeholder model lacks. All of it sits at the TAIL, which gives the
    // silhouette a second orientation cue that survives any camera angle —
    // the gimbal says nose, this says tail.
    const mast = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.035, 0.05, 0.34, 10)), dark)
    mast.position.set(0, 0.5, 0.78)
    root.add(mast)
    const puck = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.22, 0.24, 0.08, 24)), shellLight)
    puck.position.set(0, 0.69, 0.78)
    puck.castShadow = true
    root.add(puck)
    const puckTop = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.085, 0.1, 0.03, 16)), accentBody)
    puckTop.position.set(0, 0.74, 0.78)
    root.add(puckTop)

    const antGeo = track(new THREE.CylinderGeometry(0.028, 0.034, 0.62, 8))
    const antTipGeo = track(new THREE.SphereGeometry(0.045, 10, 8))
    for (const x of [-0.42, 0.42]) {
        const ant = new THREE.Mesh(antGeo, dark)
        ant.position.set(x, 0.5, 1.0)
        ant.rotation.z = x > 0 ? -0.28 : 0.28
        ant.rotation.x = 0.34
        root.add(ant)
        const tip = new THREE.Mesh(antTipGeo, carbon)
        tip.position.set(x + (x > 0 ? 0.115 : -0.115), 0.78, 1.1)
        root.add(tip)
    }

    // ── Arms, motors, rotors ─────────────────────────────────────────────
    // A moulded slab, not a tube: wider than tall, with real corner
    // rounding — the cross-section of every injection-moulded arm.
    const armGeo = track(new THREE.ExtrudeGeometry(roundedRect(0.22, 0.11, 0.045), {
        depth: 1.35, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02,
        bevelSegments: 2, curveSegments: 8,
    }))
    const canGeo = track(new THREE.CylinderGeometry(0.19, 0.225, 0.26, 24))
    const bellGeo = track(new THREE.CylinderGeometry(0.245, 0.215, 0.2, 24))
    const skidGeo = track(new THREE.CapsuleGeometry(0.052, 1.5, 6, 12))
    const skidPadGeo = track(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 12))
    const ledGeo = track(new THREE.SphereGeometry(0.115, 14, 12))
    const nutGeo = track(new THREE.SphereGeometry(0.09, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2))

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

        const arm = new THREE.Mesh(armGeo, armShell)
        // Extruded along +Z; flipped to run outward, rooted INSIDE the hull
        // so the joint is hidden, with a slight rise to the motor.
        arm.rotation.x = Math.PI + 0.055
        arm.position.set(0, 0.13, -0.32)
        arm.castShadow = true
        a.add(arm)

        const can = new THREE.Mesh(canGeo, armShell)
        can.position.set(0, 0.15, -1.62)
        can.castShadow = true
        a.add(can)

        const bell = new THREE.Mesh(bellGeo, front ? accentBody : dark)
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
        rotor.position.set(0, 0.56, -1.62)
        rotor.castShadow = true
        a.add(rotor)
        rotors.push(rotor)

        // Prop nut — a domed cap on the hub. Small, and the difference
        // between a propeller that is FITTED and one that is resting there.
        const nut = new THREE.Mesh(nutGeo, dark)
        nut.position.set(0, 0.12, 0)
        rotor.add(nut)

        // Navigation LEDs, aviation convention: PORT (left) red, STARBOARD
        // (right) green. Deliberately NOT the calibration accent — position
        // lights that changed colour with the panel state would unteach the
        // one convention they exist to teach. ARM_ANGLES run clockwise from
        // the nose, so 45 and 135 are the starboard pair.
        const starboard = deg === 45 || deg === 135
        const led = new THREE.Mesh(ledGeo, starboard ? navGreen : navRed)
        led.position.set(0, -0.02, -1.62)
        a.add(led)
    })

    // ── Landing gear ─────────────────────────────────────────────────────
    //
    // BUILT POINT-TO-POINT. The first cut placed one tilted leg per arm and
    // two skid rails at hand-guessed coordinates, and they met nothing: the
    // legs hung clear of the fuselage and the rails floated under them. A
    // strut is a line between two points that both exist — where it leaves
    // the belly and where it lands on the rail — so those are the inputs,
    // and the cylinder is derived. There is no coordinate to guess wrong.
    const SKID_X = 0.98
    const SKID_Y = -0.9
    const strut = (from: THREE.Vector3, to: THREE.Vector3, r: number) => {
        const dir = new THREE.Vector3().subVectors(to, from)
        const len = dir.length()
        const g = track(new THREE.CylinderGeometry(r * 0.8, r, len, 10))
        const m = new THREE.Mesh(g, carbon)
        m.position.copy(from).addScaledVector(dir, 0.5)
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
        m.castShadow = true
        root.add(m)
    }
    for (const sx of [-1, 1]) {
        // Rail first, then two struts that END on its centreline. The strut
        // tops start INSIDE the hull (the belly at |x| 0.45 is ~0.2 deep),
        // so the joint is buried the way a moulded socket would be.
        const skid = new THREE.Mesh(skidGeo, dark)
        skid.rotation.x = Math.PI / 2
        skid.position.set(sx * SKID_X, SKID_Y, 0)
        skid.castShadow = true
        root.add(skid)
        for (const sz of [-0.55, 0.55]) {
            strut(
                new THREE.Vector3(sx * 0.42, -0.05, sz),
                new THREE.Vector3(sx * SKID_X, SKID_Y + 0.03, sz),
                0.055,
            )
        }
        for (const z of [-0.72, 0.72]) {
            const pad = new THREE.Mesh(skidPadGeo, carbon)
            pad.position.set(sx * SKID_X, SKID_Y - 0.05, z)
            root.add(pad)
        }
    }

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

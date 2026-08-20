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
    const canGeo = track(new THREE.CylinderGeometry(0.2, 0.23, 0.3, 20))
    const bellGeo = track(new THREE.CylinderGeometry(0.235, 0.2, 0.1, 20))
    const hubGeo = track(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 12))
    const bladeGeo = track(new THREE.BoxGeometry(1.15, 0.03, 0.26))
    const legGeo = track(new THREE.CylinderGeometry(0.05, 0.04, 0.75, 10))
    const footGeo = track(new THREE.CapsuleGeometry(0.055, 0.42, 4, 10))
    const ledGeo = track(new THREE.SphereGeometry(0.115, 14, 12))

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
        can.position.set(0, 0.17, -1.62)
        can.castShadow = true
        a.add(can)

        const bell = new THREE.Mesh(bellGeo, front ? accentBody : shell)
        bell.position.set(0, 0.33, -1.62)
        a.add(bell)

        // Rotor: a hub plus two blades, spun by the render loop. Real blades
        // rather than a disc, because a disc at rest is a plate and the model
        // has to look right STANDING STILL — which, during a calibration, is
        // the only way it is ever seen.
        const rotor = new THREE.Group()
        rotor.position.set(0, 0.46, -1.62)
        const hub = new THREE.Mesh(hubGeo, dark)
        rotor.add(hub)
        for (const side of [0, Math.PI]) {
            const blade = new THREE.Mesh(bladeGeo, mat(new THREE.MeshStandardMaterial({
                color: 0x1b2029, metalness: 0.1, roughness: 0.75,
                transparent: true, opacity: 0.95,
            })))
            blade.position.set(Math.cos(side) * 0.62, 0.02, Math.sin(side) * 0.62)
            blade.rotation.y = side
            blade.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.14   // pitch, and it alternates
            rotor.add(blade)
        }
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

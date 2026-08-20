'use client'

// The calibration viewport: a lit 3D aircraft that mirrors the one in the
// operator's hands, and an arrow saying which way to turn it.
//
// WHY THE LIVE ATTITUDE IS THE POINT. QGroundControl draws a picture of the
// position it WANTS and leaves the operator to work out how their aircraft
// relates to it. We already stream roll/pitch/yaw off the IMU at 10 Hz, so the
// model can simply BE the aircraft — turn the real one and this one turns with
// it. That converts "is this what it means by left side?" into a matching
// game, which needs no interpretation and no knowledge of PX4's vocabulary.
//
// TARGET ORIENTATIONS ARE DERIVED, NEVER TABULATED. The first version of this
// panel hand-wrote a rotation per side and got LEFT AND RIGHT THE WRONG WAY
// ROUND — silently, because a quadcopter is nearly symmetric and a wrong sign
// throws nothing. Here each side names only WHICH WAY THAT FACE POINTS ON THE
// AIRFRAME, which is a fact anyone can check by looking at a drone, and the
// rotation is whatever takes that face to the ground. There is no sign to get
// wrong.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

import { buildDrone, loadDroneModel, type DroneParts } from '@/lib/droneMesh'
import type { CalSide } from '@/types/calibration'

/** Which way each named face points on the airframe. Nose -Z, up +Y, right +X
 *  — the glTF convention, so a supplied model needs no adapter. */
export const FACE_DIRECTION: Record<CalSide, [number, number, number]> = {
    down:  [0, -1, 0],
    up:    [0, 1, 0],
    left:  [-1, 0, 0],
    right: [1, 0, 0],
    front: [0, 0, -1],
    back:  [0, 0, 1],
}

const WORLD_DOWN = new THREE.Vector3(0, -1, 0)

/** The attitude that puts `side` on the ground. */
export function orientationFor(side: CalSide): THREE.Quaternion {
    const face = new THREE.Vector3(...FACE_DIRECTION[side]).normalize()
    return new THREE.Quaternion().setFromUnitVectors(face, WORLD_DOWN)
}

/** Optional path to a supplied airframe. Absent by default; drop a file there
 *  and it replaces the built-in one with no other change. */
const MODEL_URL = '/models/drone.glb'

export interface Attitude { roll: number; pitch: number; yaw: number }

export function DroneScene({
    attitude, targetSide, accent = '#22d3ee', matched = false,
    live = true, height = 300,
}: {
    /** Live IMU attitude in degrees, or null to rest the model level. */
    attitude: Attitude | null
    /** The side PX4 is asking for, or null when nothing is being asked. */
    targetSide: CalSide | null
    accent?: string
    /** True once the aircraft is close enough to the requested attitude. */
    matched?: boolean
    /** False freezes the props — a calibration happens with motors off. */
    live?: boolean
    height?: number
}) {
    const hostRef = useRef<HTMLDivElement>(null)
    // Inputs the render loop reads every frame. Held in a ref rather than
    // closed over, so a 10 Hz telemetry update does not tear down and rebuild
    // a WebGL context ten times a second.
    const input = useRef({ attitude, targetSide, accent, matched, live })
    input.current = { attitude, targetSide, accent, matched, live }

    useEffect(() => {
        const host = hostRef.current
        if (!host) return

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.05
        host.appendChild(renderer.domElement)
        renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;touch-action:none'

        const scene = new THREE.Scene()
        // Close enough that the airframe FILLS the viewport. The first pass
        // framed it from 8 units out and the aircraft came out the size of a
        // thumbnail in a 310px panel — which is the same failure as the flat
        // version by another route: an operator cannot read an orientation
        // they have to squint at.
        const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
        camera.position.set(4.1, 3.0, 5.4)

        // A generated room environment rather than an HDRI file: proper image-
        // based lighting, so metal reads as metal and every edge has a lit side
        // and a shaded one — which is the whole reason the flat version was
        // unreadable — and it ships as zero bytes of asset.
        let pmrem: THREE.PMREMGenerator | null = null
        let envRT: THREE.WebGLRenderTarget | null = null
        void (async () => {
            try {
                const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
                pmrem = new THREE.PMREMGenerator(renderer)
                envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
                scene.environment = envRT.texture
            } catch { /* lights below still carry the scene */ }
        })()

        scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x14181f, 1.1))
        const key = new THREE.DirectionalLight(0xffffff, 2.2)
        key.position.set(5, 8, 4)
        scene.add(key)
        const rim = new THREE.DirectionalLight(0x7dd3fc, 1.5)
        rim.position.set(-6, 2, -5)
        scene.add(rim)

        // Contact shadow. A blurred blob on the ground, not a shadow map — it
        // costs nothing and it is what stops the aircraft looking like it is
        // floating in a void with no sense of which way is down.
        const shadow = new THREE.Mesh(
            new THREE.CircleGeometry(2.6, 48),
            new THREE.MeshBasicMaterial({
                map: radialShadowTexture(), transparent: true, opacity: 0.5,
                depthWrite: false,
            }),
        )
        shadow.rotation.x = -Math.PI / 2
        shadow.position.y = -1.35
        scene.add(shadow)

        // Ground grid, faint. Gives the horizon a plane to sit on so "level"
        // and "nose down" are legible as attitudes rather than as poses.
        const grid = new THREE.GridHelper(16, 16, 0x3d4b5c, 0x2a3542)
        grid.position.y = -1.36
        ;(grid.material as THREE.Material).transparent = true
        ;(grid.material as THREE.Material).opacity = 0.8
        scene.add(grid)

        // Declared before the async loads below, all of which check it: a
        // model or a controls module that resolves after unmount must not
        // attach itself to a scene that has already been torn down.
        let disposed = false

        const craft = new THREE.Group()
        scene.add(craft)

        let parts: DroneParts = buildDrone(new THREE.Color(accent).getHex())
        craft.add(parts.root)
        // A supplied model, if there is one, quietly replaces the built-in.
        void loadDroneModel(MODEL_URL).then(supplied => {
            if (!supplied || disposed) return
            craft.remove(parts.root)
            parts.dispose()
            parts = supplied
            craft.add(parts.root)
        })

        const arrow = buildRotationArrow()
        scene.add(arrow.group)
        arrow.group.visible = false

        let controls: { update: () => void; dispose: () => void } | null = null
        void (async () => {
            const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
            const c = new OrbitControls(camera, renderer.domElement)
            c.enableDamping = true
            c.dampingFactor = 0.08
            c.enablePan = false
            c.minDistance = 3.4
            c.maxDistance = 11
            // Stops short of the poles: looking exactly down the Y axis makes
            // every orientation look identical, which is the one view this
            // control must never offer.
            c.minPolarAngle = 0.35
            c.maxPolarAngle = Math.PI / 2 + 0.35
            c.target.set(0, 0, 0)
            if (!disposed) controls = c
            else c.dispose()
        })()

        const resize = () => {
            const w = host.clientWidth || 400
            const h = host.clientHeight || height
            renderer.setSize(w, h, false)
            camera.aspect = w / h
            camera.updateProjectionMatrix()
        }
        resize()
        const ro = new ResizeObserver(resize)
        ro.observe(host)

        const shown = new THREE.Quaternion()     // what is drawn, eased
        const wanted = new THREE.Quaternion()
        const euler = new THREE.Euler(0, 0, 0, 'YXZ')
        const accentColour = new THREE.Color()
        let raf = 0
        let spin = 0
        const clock = new THREE.Clock()

        const frame = () => {
            raf = requestAnimationFrame(frame)
            const dt = Math.min(clock.getDelta(), 0.1)
            const inp = input.current

            // ATTITUDE. PX4 reports body FRD in NED: roll positive = right side
            // down, pitch positive = nose up, yaw positive = nose swinging
            // right. The model is glTF-standard (nose -Z, up +Y), so pitch maps
            // straight across and the other two invert. Euler order YXZ applies
            // them yaw, then pitch, then roll — the aerospace sequence.
            if (inp.attitude) {
                euler.set(
                    THREE.MathUtils.degToRad(inp.attitude.pitch),
                    THREE.MathUtils.degToRad(-inp.attitude.yaw),
                    THREE.MathUtils.degToRad(-inp.attitude.roll),
                    'YXZ',
                )
                wanted.setFromEuler(euler)
            } else if (inp.targetSide) {
                // No telemetry: show the position being ASKED FOR rather than
                // nothing. Less useful than the live aircraft, still an answer
                // to "which way up".
                wanted.copy(orientationFor(inp.targetSide))
            } else {
                wanted.identity()
            }
            // Eased, not snapped: a 10 Hz attitude stream applied raw is a
            // stutter, and the smoothing also stops radio dropouts reading as
            // the aircraft being thrown around.
            shown.slerp(wanted, 1 - Math.pow(0.002, dt))
            craft.quaternion.copy(shown)

            // Props idle slowly — enough to look alive, never fast enough to
            // suggest the motors are armed during a calibration.
            spin += dt * (inp.live ? 1.6 : 0)
            parts.rotors.forEach((r, i) => { r.rotation.y = spin * (i % 2 ? -1 : 1) })

            accentColour.set(inp.matched ? '#4ade80' : inp.accent)
            parts.accents.forEach(m => {
                m.color.lerp(accentColour, 0.15)
                m.emissive.lerp(accentColour, 0.15)
            })

            // THE ARROW: the shortest turn from where the aircraft is to where
            // it is wanted, drawn in the plane of that turn. Hidden once the
            // two agree, because an arrow still pointing somewhere is an
            // instruction, and there is nothing left to do.
            if (inp.targetSide && !inp.matched) {
                const cur = new THREE.Vector3(0, 1, 0).applyQuaternion(shown)
                const tgt = new THREE.Vector3(0, 1, 0).applyQuaternion(orientationFor(inp.targetSide))
                const angle = cur.angleTo(tgt)
                if (angle > 0.12) {
                    const axis = new THREE.Vector3().crossVectors(cur, tgt).normalize()
                    arrow.group.visible = true
                    arrow.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)
                    arrow.setSweep(angle)
                    arrow.setColour(accentColour)
                    arrow.group.rotateY(spin * 0.6)          // marching, so the DIRECTION reads
                } else {
                    arrow.group.visible = false
                }
            } else {
                arrow.group.visible = false
            }

            controls?.update()
            renderer.render(scene, camera)
        }
        frame()

        return () => {
            disposed = true
            cancelAnimationFrame(raf)
            ro.disconnect()
            controls?.dispose()
            arrow.dispose()
            parts.dispose()
            envRT?.dispose()
            pmrem?.dispose()
            shadow.geometry.dispose()
            ;(shadow.material as THREE.Material).dispose()
            grid.dispose()
            renderer.dispose()
            host.removeChild(renderer.domElement)
        }
        // Built once. Everything that changes per frame is read from the ref
        // above — rebuilding a WebGL context on a telemetry tick would drop
        // the frame rate to nothing and reset the operator's camera angle
        // while they were using it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return <div ref={hostRef} style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden' }} />
}

/** The turn to make, as an arc with a head on the end.
 *
 *  DRAWN THROUGH THE AIRFRAME, not behind it. depthTest is off and it renders
 *  last, so the instruction is never hidden by the very object it is about —
 *  which happens for roughly half of the six positions once the operator
 *  starts orbiting the camera.
 *
 *  The head is aimed along the TANGENT at the end of the sweep rather than by
 *  a hand-written Euler triple. Same reasoning as the orientations themselves:
 *  a derived direction has no sign to get wrong, and an arrowhead pointing the
 *  wrong way round the circle is an instruction to rotate the aircraft
 *  backwards.
 */
// Outside the props (span ≈ 4.5) so the arc encircles the aircraft rather
// than cutting through it, and inside the frame at the default camera — the
// turn is often about the nose axis, which puts the arc in a VERTICAL plane
// where the viewport is shortest.
const ARROW_R = 2.55

function buildRotationArrow() {
    const group = new THREE.Group()
    group.renderOrder = 10
    const material = new THREE.MeshBasicMaterial({
        color: 0x22d3ee, transparent: true, opacity: 0.92,
        side: THREE.DoubleSide, depthTest: false,
    })
    const torus = new THREE.Mesh(
        new THREE.TorusGeometry(ARROW_R, 0.075, 10, 72, Math.PI / 2), material)
    torus.rotation.x = Math.PI / 2      // into the XZ plane; +theta runs +X -> -Z
    torus.renderOrder = 10
    group.add(torus)

    const headGeo = new THREE.ConeGeometry(0.24, 0.62, 18)
    const head = new THREE.Mesh(headGeo, material)
    head.renderOrder = 10
    group.add(head)

    const UP = new THREE.Vector3(0, 1, 0)
    const tangent = new THREE.Vector3()

    const setSweep = (angle: number) => {
        const sweep = Math.max(0.45, Math.min(Math.PI * 0.92, angle))
        torus.geometry.dispose()
        torus.geometry = new THREE.TorusGeometry(ARROW_R, 0.075, 10, 72, sweep)
        head.position.set(Math.cos(sweep) * ARROW_R, 0, -Math.sin(sweep) * ARROW_R)
        // d/dtheta of that position, normalised — the way the arc is heading
        // where it stops.
        tangent.set(-Math.sin(sweep), 0, -Math.cos(sweep)).normalize()
        head.quaternion.setFromUnitVectors(UP, tangent)
    }
    setSweep(Math.PI / 2)

    return {
        group, setSweep,
        setColour: (c: THREE.Color) => { material.color.lerp(c, 0.2) },
        dispose: () => { torus.geometry.dispose(); headGeo.dispose(); material.dispose() },
    }
}

/** Soft round gradient for the contact shadow, drawn once on a canvas. */
function radialShadowTexture(): THREE.Texture {
    const size = 256
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(0,0,0,0.85)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.28)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
}

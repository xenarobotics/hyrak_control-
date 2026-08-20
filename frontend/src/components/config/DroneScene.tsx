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

/** What the operator is being asked to DO right now.
 *
 *  Inferring this from "are we in position yet" was the reported confusion:
 *  during a compass calibration the arrow appeared while turning the aircraft,
 *  vanished the moment it arrived — and arriving is exactly when PX4 starts
 *  wanting it ROTATED. So the two instructions are now separate states with
 *  separate arrows, and neither is guessed. */
export type StageMode = 'reorient' | 'rotate' | 'hold' | 'idle'

/** A jump this big between two samples of a 10 Hz stream is not a movement. */
const GLITCH_RAD = THREE.MathUtils.degToRad(90)
/** …unless the next sample lands near the same place, in which case it was. */
const CONFIRM_RAD = THREE.MathUtils.degToRad(35)

export function DroneScene({
    attitude, targetSide, mode = 'idle', accent = '#22d3ee',
    live = true, height = 360,
}: {
    /** Live IMU attitude in degrees, or null to rest the model level. */
    attitude: Attitude | null
    /** The side PX4 is asking for, or null when nothing is being asked. */
    targetSide: CalSide | null
    /** reorient = turn it to the target; rotate = spin it about that axis;
     *  hold = keep it still; idle = nothing being asked. */
    mode?: StageMode
    accent?: string
    /** False freezes the props — a calibration happens with motors off. */
    live?: boolean
    height?: number
}) {
    const hostRef = useRef<HTMLDivElement>(null)
    // Inputs the render loop reads every frame. Held in a ref rather than
    // closed over, so a 10 Hz telemetry update does not tear down and rebuild
    // a WebGL context ten times a second.
    const input = useRef({ attitude, targetSide, accent, mode, live })
    input.current = { attitude, targetSide, accent, mode, live }

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
        camera.position.set(4.5, 3.3, 5.9)

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

        // THREE-POINT, and each one is doing a job.
        //
        // The first pass was a hard white key plus a cyan rim, which blew the
        // canopy to a mirror and left the underside — the skids, the gimbal,
        // the whole half of the aircraft that says WHICH WAY UP — as an
        // unreadable black mass. That matters more here than it would on a
        // product shot: half the orientations this panel asks for put the
        // bottom of the aircraft towards the viewer.
        scene.add(new THREE.HemisphereLight(0xc8dcff, 0x2a3444, 1.35))
        const key = new THREE.DirectionalLight(0xfff4e6, 1.85)
        key.position.set(5, 8, 4)
        scene.add(key)
        // Cool rim from behind, to separate the airframe from the background.
        const rim = new THREE.DirectionalLight(0x7dd3fc, 1.25)
        rim.position.set(-6, 3, -6)
        scene.add(rim)
        // Bounce off the ground, so the underside is lit rather than merely
        // less dark.
        const bounce = new THREE.DirectionalLight(0x9fb4d0, 0.8)
        bounce.position.set(0, -5, 2)
        scene.add(bounce)

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
        // Reused every frame — allocating vectors inside a 60 Hz loop is how a
        // smooth panel becomes a stuttering one after a minute of GC pressure.
        const up = new THREE.Vector3()
        const axisVec = new THREE.Vector3()
        const Y_UP = new THREE.Vector3(0, 1, 0)
        let raf = 0
        let spin = 0
        let demoSpin = 0
        let pending: THREE.Quaternion | null = null
        const Y_AXIS = new THREE.Vector3(0, 1, 0)
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
            // REJECT ONE-FRAME TELEPORTS.
            //
            // PX4 reports attitude as Euler angles, and near ±90° of pitch —
            // which is exactly where a compass calibration spends its time —
            // roll and yaw are degenerate: two consecutive samples can differ
            // by 180° while describing almost the same attitude. Fed straight
            // in, the model snapped right over and back, which is the "for a
            // split second it completely shifts orientation" flicker.
            //
            // Nothing physical moves 90° between two samples of a 10 Hz
            // stream, so a lone jump that large is discarded. If the NEXT
            // sample agrees with the rejected one it is real after all and is
            // taken — so a genuinely fast movement costs one frame of lag
            // rather than being filtered out.
            if (inp.attitude && shown.angleTo(wanted) > GLITCH_RAD) {
                if (pending && pending.angleTo(wanted) < CONFIRM_RAD) {
                    pending = null
                } else {
                    pending = wanted.clone()
                    wanted.copy(shown)
                }
            } else {
                pending = null
            }
            // Eased, not snapped: a 10 Hz attitude stream applied raw is a
            // stutter, and the smoothing also stops radio dropouts reading as
            // the aircraft being thrown around.
            shown.slerp(wanted, 1 - Math.pow(0.002, dt))
            craft.quaternion.copy(shown)

            // DEMONSTRATE THE SWEEP. During `rotate` the model turns about its
            // own vertical at the pace PX4 wants, so "rotate it steadily" is
            // shown at a speed rather than described in words.
            //
            // APPLIED AFTER THE COPY, and accumulated. The first cut called
            // rotateOnAxis by one frame's worth and then had the next frame's
            // quaternion copy overwrite it, so the model sat at a fixed small
            // offset and never actually turned.
            if (inp.mode === 'rotate') {
                demoSpin = (demoSpin + dt * 0.8) % (Math.PI * 2)
                craft.rotateOnAxis(Y_AXIS, demoSpin)
            } else {
                demoSpin = 0
            }

            // Props idle slowly — enough to look alive, never fast enough to
            // suggest the motors are armed during a calibration.
            spin += dt * (inp.live ? 1.6 : 0)
            parts.rotors.forEach((r, i) => { r.rotation.y = spin * (i % 2 ? -1 : 1) })



            accentColour.set(inp.accent)
            parts.accents.forEach(m => {
                m.color.lerp(accentColour, 0.15)
                m.emissive.lerp(accentColour, 0.15)
            })

            // TWO DIFFERENT INSTRUCTIONS, TWO DIFFERENT ARROWS.
            //
            //  reorient — the shortest turn from where the aircraft is to where
            //             it is wanted, drawn in the plane of that turn.
            //  rotate   — a compass sweep about the axis it is ALREADY on, which
            //             is what PX4 asks for once an orientation is detected.
            //             This is the one that used to vanish at exactly the
            //             moment it became the instruction.
            //  hold     — nothing. Any arrow at all reads as "keep moving it",
            //             and moving it is what fails an accelerometer side.
            if (inp.mode === 'reorient' && inp.targetSide) {
                const cur = up.set(0, 1, 0).applyQuaternion(shown).clone()
                const tgt = up.set(0, 1, 0).applyQuaternion(orientationFor(inp.targetSide)).clone()
                const angle = cur.angleTo(tgt)
                if (angle > 0.12) {
                    // Parallel vectors have no cross product; near 180° the
                    // axis is numerically anything at all, so a stable fallback
                    // keeps the arrow from flickering across the screen.
                    axisVec.crossVectors(cur, tgt)
                    if (axisVec.lengthSq() < 1e-6) axisVec.set(0, 0, 1)
                    axisVec.normalize()
                    arrow.group.visible = true
                    arrow.group.quaternion.setFromUnitVectors(Y_UP, axisVec)
                    arrow.setColour(accentColour)
                    arrow.group.rotateY(spin * 0.8)          // marching, so the DIRECTION reads
                } else {
                    arrow.group.visible = false
                }
            } else if (inp.mode === 'rotate') {
                // About the aircraft's own vertical, wherever that is pointing
                // now — the axis PX4 detected, not a world axis.
                axisVec.set(0, 1, 0).applyQuaternion(shown).normalize()
                arrow.group.visible = true
                arrow.group.quaternion.setFromUnitVectors(Y_UP, axisVec)
                arrow.setColour(accentColour)
                arrow.group.rotateY(spin * 1.4)
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
//: A rotation arrow is ICONOGRAPHY, not a gauge. Drawn proportional to the
//: angle still to go, a 90° turn came out as a quarter arc with most of a
//: circle of empty space between the tail and the head — which reads as a
//: stray stroke rather than "turn it this way". Kept near-complete so the
//: direction is unmistakable; how far is left to the colour and the words,
//: which say it better than an arc length nobody measures.
const ARROW_SWEEP = Math.PI * 1.58
const HEAD_LEN = 0.66

function buildRotationArrow() {
    const group = new THREE.Group()
    group.renderOrder = 10
    const material = new THREE.MeshBasicMaterial({
        color: 0x22d3ee, transparent: true, opacity: 0.92,
        side: THREE.DoubleSide, depthTest: false,
    })
    const torus = new THREE.Mesh(
        new THREE.TorusGeometry(ARROW_R, 0.075, 10, 96, ARROW_SWEEP), material)
    torus.rotation.x = Math.PI / 2      // into the XZ plane; +theta runs +X -> -Z
    torus.renderOrder = 10
    group.add(torus)

    const headGeo = new THREE.ConeGeometry(0.26, HEAD_LEN, 20)
    const head = new THREE.Mesh(headGeo, material)
    head.renderOrder = 10
    group.add(head)

    const UP = new THREE.Vector3(0, 1, 0)
    const tangent = new THREE.Vector3()

    const place = (sweep: number) => {
        // d/dtheta of the arc position, normalised — the way the arc is
        // heading where it stops.
        tangent.set(-Math.sin(sweep), 0, -Math.cos(sweep)).normalize()
        head.quaternion.setFromUnitVectors(UP, tangent)
        // PUSHED FORWARD BY HALF ITS LENGTH. A cone is centred on its own
        // middle, so placing it AT the arc's end buried half of it in the arc
        // and the head read as a lump partway along the line rather than as
        // the point of the arrow. Its base now meets the end of the stroke.
        head.position
            .set(Math.cos(sweep) * ARROW_R, 0, -Math.sin(sweep) * ARROW_R)
            .addScaledVector(tangent, HEAD_LEN * 0.5)
    }
    place(ARROW_SWEEP)

    return {
        group,
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

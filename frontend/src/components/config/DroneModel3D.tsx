'use client'

// A quadcopter you can turn over, built out of CSS 3D transforms.
//
// WHY NOT three.js. The job is to show an operator which way up to hold the
// aircraft, in six positions, and to move smoothly between them. That is six
// transform triples and a CSS transition — against which a WebGL engine is
// half a megabyte of dependency, a canvas that does not inherit the app's
// theme tokens, and a second rendering model to keep in step with the rest of
// a UI built entirely from styled divs. The model below is about 120 lines and
// animates for free.
//
// WHAT THE ORIENTATIONS MEAN. Aircraft axes are +X right, +Y aft, +Z up. The
// scene is tilted so screen-Z points world-up, and PX4 names each orientation
// by WHICH FACE POINTS DOWN — so "left" is the aircraft resting on its left
// side, and the transform is the one that rotates its up-axis onto +X. Getting
// a sign wrong here does not throw; it silently asks the operator to hold the
// aircraft the wrong way round for the whole calibration, so each is derived
// rather than guessed:
//
//   rotateY(θ) sends +Z to ( sinθ, 0, cosθ)   →  +90° puts "up" at +X  = on its LEFT side
//   rotateX(θ) sends +Z to (0, -sinθ, cosθ)   →  +90° puts "up" at -Y  = on its TAIL

export type Side = 'down' | 'up' | 'left' | 'right' | 'front' | 'back'

export const SIDE_TRANSFORM: Record<Side, string> = {
    down:  'rotateX(0deg)',
    up:    'rotateX(180deg)',
    left:  'rotateY(90deg)',
    right: 'rotateY(-90deg)',
    front: 'rotateX(-90deg)',
    back:  'rotateX(90deg)',
}

/** Plain-language name for each, because "back" and "front" describe which
 *  face points DOWN and read backwards to most people the first time. */
export const SIDE_NAMES: Record<Side, string> = {
    down: 'Level', up: 'Inverted', left: 'Left side', right: 'Right side',
    front: 'Nose down', back: 'Tail down',
}

const ARM_ANGLES = [45, 135, 225, 315]

export function DroneModel3D({
    side = 'down', spin = false, accent = '#22d3ee', size = 190, dim = false,
}: {
    /** Which face points down. */
    side?: Side
    /** Rotate continuously about the vertical axis — the compass instruction. */
    spin?: boolean
    accent?: string
    size?: number
    /** Greyed out: nothing is being asked of the operator right now. */
    dim?: boolean
}) {
    const s = size / 190                       // everything below is drawn at 190
    const px = (n: number) => `${n * s}px`
    const body = dim ? '#3f4753' : '#4b5563'
    const nose = dim ? '#4b5563' : accent

    return (
        <div style={{
            width: px(190), height: px(190), perspective: px(760),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
        }}>
            {/* The scene tilt. Fixed, so the aircraft's own rotation below is
                read as attitude rather than as camera movement. */}
            <div style={{
                width: px(190), height: px(190), transformStyle: 'preserve-3d',
                transform: 'rotateX(-58deg) rotateZ(0deg)',
            }}>
                {/* The aircraft. One transition on one property, so a change of
                    side is a single readable movement rather than six things
                    easing at once. */}
                <div
                    className={spin ? 'hyrak-cal-anim' : undefined}
                    style={{
                        width: '100%', height: '100%', transformStyle: 'preserve-3d',
                        transform: SIDE_TRANSFORM[side],
                        transition: 'transform 700ms cubic-bezier(.4,0,.2,1)',
                    }}
                >
                    <div
                        className={spin ? 'hyrak-cal-anim' : undefined}
                        style={{
                            width: '100%', height: '100%', transformStyle: 'preserve-3d',
                            animation: spin ? 'hyrak-cal-spin 3.6s linear infinite' : undefined,
                        }}
                    >
                        {ARM_ANGLES.map(a => (
                            <Arm key={a} angle={a} px={px} s={s}
                                 colour={a === 45 || a === 315 ? nose : body} />
                        ))}

                        {/* Hub — a real box, not a plate. Edge-on, a flat plate
                            disappears to a line, which is exactly the moment
                            (nose down, on its side) the operator most needs to
                            see which way it is facing. */}
                        <Face px={px} w={64} h={64} z={7} colour="#2b323d" border={body} radius={14} />
                        <Face px={px} w={64} h={64} z={-7} colour="#20252e" border={body} radius={14} />
                        <Rim px={px} s={s} colour={body} />

                        {/* Nose marker, carried above the hub so it stays
                            visible in every attitude. */}
                        <div style={{
                            position: 'absolute', left: '50%', top: '50%',
                            width: 0, height: 0,
                            borderLeft: `${px(11)} solid transparent`,
                            borderRight: `${px(11)} solid transparent`,
                            borderBottom: `${px(20)} solid ${nose}`,
                            transform: `translate(-50%,-50%) translateY(${px(-46)}) translateZ(${px(9)})`,
                        }} />
                    </div>
                </div>
            </div>
        </div>
    )
}

function Face({ px, w, h, z, colour, border, radius }: {
    px: (n: number) => string; w: number; h: number; z: number
    colour: string; border: string; radius: number
}) {
    return (
        <div style={{
            position: 'absolute', left: '50%', top: '50%',
            width: px(w), height: px(h), borderRadius: px(radius),
            background: colour, border: `1.5px solid ${border}`,
            transform: `translate(-50%,-50%) translateZ(${px(z)})`,
        }} />
    )
}

/** The four vertical edges of the hub. Cheaper than six full faces and enough
 *  to read as solid once the model is tilted. */
function Rim({ px, s, colour }: { px: (n: number) => string; s: number; colour: string }) {
    const sides = [
        { r: 'rotateX(90deg)', t: `translateY(${px(-32)})` },
        { r: 'rotateX(90deg)', t: `translateY(${px(32)})` },
        { r: 'rotateY(90deg)', t: `translateX(${px(-32)})` },
        { r: 'rotateY(90deg)', t: `translateX(${px(32)})` },
    ]
    return (
        <>
            {sides.map((f, i) => (
                <div key={i} style={{
                    position: 'absolute', left: '50%', top: '50%',
                    width: px(64), height: px(14),
                    background: 'rgba(43,50,61,0.92)',
                    border: `1px solid ${colour}`,
                    transform: `translate(-50%,-50%) ${f.t} ${f.r}`,
                }} />
            ))}
        </>
    )
}

function Arm({ angle, px, s, colour }: {
    angle: number; px: (n: number) => string; s: number; colour: string
}) {
    return (
        <div style={{
            position: 'absolute', left: '50%', top: '50%',
            transformStyle: 'preserve-3d',
            transform: `translate(-50%,-50%) rotateZ(${angle}deg)`,
        }}>
            {/* boom */}
            <div style={{
                position: 'absolute', left: px(-4), top: px(-4),
                width: px(8), height: px(66), borderRadius: px(4),
                background: colour, transformOrigin: 'top center',
            }} />
            {/* motor can */}
            <div style={{
                position: 'absolute', left: px(-9), top: px(54),
                width: px(18), height: px(18), borderRadius: '50%',
                background: '#1f242c', border: `1.5px solid ${colour}`,
                transform: `translateZ(${px(7)})`,
            }} />
            {/* prop disc — translucent, so it reads as spinning rather than as
                a solid plate hiding the airframe behind it */}
            <div style={{
                position: 'absolute', left: px(-27), top: px(36),
                width: px(54), height: px(54), borderRadius: '50%',
                border: `1.5px solid ${colour}`, opacity: 0.28,
                transform: `translateZ(${px(15)})`,
            }} />
        </div>
    )
}

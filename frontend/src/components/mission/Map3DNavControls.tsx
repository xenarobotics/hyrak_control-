'use client'

/**
 * On-screen camera controls for the 3D map: compass (tap for north up),
 * zoom, rotate and tilt. Each button works with a tap (one step) or held
 * (keeps going), so touch screens and trackpads get every gesture a mouse
 * has. Moves orbit the point at the centre of the view, the same point
 * right-drag and two-finger drag turn around.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Plus, Minus, RotateCcw, RotateCw, ChevronsUp, ChevronsDown, Navigation2 } from 'lucide-react'
import type * as CesiumNS from 'cesium'

type CesiumModule = typeof CesiumNS

// Per animation frame while a button is held (about 60 per second).
const TURN_RAD = 0.025       // ~90 degrees a second
const TILT_RAD = 0.016       // ~55 degrees a second
const ZOOM_STEP = 0.035      // ~8x closer a second
// Pitch limits: straight down, and a little above the horizon so the camera
// never ends up looking at the sky or under the ground.
const PITCH_MIN = -Math.PI / 2 + 0.001
const PITCH_MAX = -0.12
const RANGE_MIN = 8
const RANGE_MAX = 25_000_000

/** The ground point at the centre of the view, if the view centre hits the globe. */
function centreTarget(Cesium: CesiumModule, viewer: CesiumNS.Viewer): CesiumNS.Cartesian3 | undefined {
  const canvas = viewer.scene.canvas
  const c = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
  const onGlobe = viewer.camera.pickEllipsoid(c, Cesium.Ellipsoid.WGS84)
  if (!onGlobe) return undefined
  // pickPosition includes terrain and buildings, but is only trustworthy
  // when it lands near the ellipsoid hit (it can return junk off-globe).
  const precise = viewer.scene.pickPositionSupported ? viewer.scene.pickPosition(c) : undefined
  if (precise && Cesium.Cartesian3.distance(precise, onGlobe) < 20_000) return precise
  return onGlobe
}

/** Orbit the view centre: change heading, pitch and distance by the given amounts. */
function orbit(Cesium: CesiumModule, viewer: CesiumNS.Viewer, dHeading: number, dPitch: number, zoom: number) {
  const camera = viewer.camera
  const target = centreTarget(Cesium, viewer)
  if (!target) {
    // Looking past the globe: turn the whole Earth instead.
    if (dHeading) camera.rotateRight(dHeading)
    if (zoom) camera.zoomIn(camera.positionCartographic.height * zoom)
    return
  }
  const range = Cesium.Math.clamp(
    Cesium.Cartesian3.distance(camera.position, target) * (1 - zoom), RANGE_MIN, RANGE_MAX)
  const pitch = Cesium.Math.clamp(camera.pitch + dPitch, PITCH_MIN, PITCH_MAX)
  camera.lookAt(target, new Cesium.HeadingPitchRange(camera.heading + dHeading, pitch, range))
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
}

/** Turn the view to north up, keeping the same centre, tilt and distance. */
function northUp(Cesium: CesiumModule, viewer: CesiumNS.Viewer) {
  const camera = viewer.camera
  const target = centreTarget(Cesium, viewer)
  if (!target) {
    camera.flyTo({ destination: camera.position, orientation: { heading: 0, pitch: camera.pitch, roll: 0 }, duration: 0.5 })
    return
  }
  const range = Cesium.Cartesian3.distance(camera.position, target)
  camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), {
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.clamp(camera.pitch, PITCH_MIN, PITCH_MAX), range),
    duration: 0.5,
  })
}

export function Map3DNavControls({ Cesium, viewer, onUse, style }: {
  Cesium: CesiumModule
  viewer: CesiumNS.Viewer
  /** Called on every step, so a following camera pauses like it does for a gesture. */
  onUse?: () => void
  style?: CSSProperties
}) {
  const [headingDeg, setHeadingDeg] = useState(0)
  const holdRef = useRef<number | null>(null)

  // Compass needle follows the camera (only re-renders when it turns a degree).
  useEffect(() => {
    let last = NaN
    const remove = viewer.scene.postRender.addEventListener(() => {
      const deg = Math.round(Cesium.Math.toDegrees(viewer.camera.heading))
      if (deg !== last) { last = deg; setHeadingDeg(deg) }
    })
    return () => { remove() }
  }, [Cesium, viewer])

  const stop = () => {
    if (holdRef.current != null) cancelAnimationFrame(holdRef.current)
    holdRef.current = null
  }
  useEffect(() => stop, [])

  // One step now, then keep stepping every frame while the button is held.
  const hold = (dHeading: number, dPitch: number, zoom: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    stop()
    const step = () => {
      if (viewer.isDestroyed()) return stop()
      onUse?.()
      orbit(Cesium, viewer, dHeading, dPitch, zoom)
      holdRef.current = requestAnimationFrame(step)
    }
    step()
  }

  const btn = (label: string, icon: ReactNode, dH: number, dP: number, z: number) => (
    <button type="button" aria-label={label} title={label}
      onPointerDown={hold(dH, dP, z)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onContextMenu={e => e.preventDefault()}
      className="w-8 h-8 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-white/10 active:bg-white/20 transition-colors touch-none select-none">
      {icon}
    </button>
  )

  const panel = 'rounded-lg overflow-hidden border border-white/10 shadow-lg'
  const panelBg = { background: 'rgba(17, 19, 24, .88)', backdropFilter: 'blur(6px)' }

  return (
    <div className="absolute z-[5] flex flex-col items-center gap-2 select-none" style={style}
      onPointerDown={e => e.stopPropagation()}>
      <button type="button" onClick={() => { onUse?.(); northUp(Cesium, viewer) }}
        aria-label="Turn north up" title={'North up\n\nDrag: move   Scroll or pinch: zoom\nRight-drag, Ctrl+drag or two fingers: rotate and tilt'}
        className={`${panel} w-9 h-9 flex items-center justify-center hover:bg-white/10`} style={panelBg}>
        <Navigation2 size={15} className="text-rose-400"
          style={{ transform: `rotate(${-headingDeg}deg)`, transition: 'transform 80ms linear' }} fill="currentColor" />
      </button>
      <div className={`${panel} flex flex-col`} style={panelBg}>
        {btn('Zoom in', <Plus size={15} />, 0, 0, ZOOM_STEP)}
        <div className="h-px bg-white/10" />
        {btn('Zoom out', <Minus size={15} />, 0, 0, -ZOOM_STEP)}
      </div>
      <div className={`${panel} grid grid-cols-2`} style={panelBg}>
        {btn('Rotate left', <RotateCcw size={14} />, -TURN_RAD, 0, 0)}
        {btn('Rotate right', <RotateCw size={14} />, TURN_RAD, 0, 0)}
        {btn('Tilt toward the horizon', <ChevronsUp size={15} />, 0, TILT_RAD, 0)}
        {btn('Tilt to look down', <ChevronsDown size={15} />, 0, -TILT_RAD, 0)}
      </div>
    </div>
  )
}

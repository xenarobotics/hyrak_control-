'use client'

import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useMissionStore } from '@/store/mission'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { WP_META } from '@/types/mission'
import type { Waypoint } from '@/types/mission'

// ── Bezier smooth-path ──────────────────────────────────────────────────────

interface Pt2 { x: number; y: number }

function buildSmoothCoords(
  waypoints: Waypoint[],
  segsPerCurve = 12,
): { lat: number; lng: number; alt: number }[] {
  if (waypoints.length < 2) return waypoints.map(w => ({ lat: w.lat, lng: w.lng, alt: w.altitude }))
  if (!waypoints.some(w => (w.turnRadius ?? 0) > 0)) {
    return waypoints.map(w => ({ lat: w.lat, lng: w.lng, alt: w.altitude }))
  }

  const cLat = waypoints.reduce((s, w) => s + w.lat, 0) / waypoints.length
  const cLng = waypoints.reduce((s, w) => s + w.lng, 0) / waypoints.length
  const mPerLat = 111_320
  const mPerLng = 111_320 * Math.cos((cLat * Math.PI) / 180)

  const pts: Pt2[] = waypoints.map(w => ({
    x: (w.lng - cLng) * mPerLng,
    y: (w.lat - cLat) * mPerLat,
  }))

  type Pt3 = { x: number; y: number; alt: number }
  const result: Pt3[] = [{ ...pts[0], alt: waypoints[0].altitude }]

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
    const r = waypoints[i].turnRadius ?? 0
    if (r <= 0) { result.push({ ...curr, alt: waypoints[i].altitude }); continue }

    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y }
    const toNext = { x: next.x - curr.x, y: next.y - curr.y }
    const lenP = Math.hypot(toPrev.x, toPrev.y)
    const lenN = Math.hypot(toNext.x, toNext.y)
    if (lenP === 0 || lenN === 0) { result.push({ ...curr, alt: waypoints[i].altitude }); continue }

    const maxR = Math.min(lenP * 0.4, lenN * 0.4, r)
    const uP = { x: toPrev.x / lenP, y: toPrev.y / lenP }
    const uN = { x: toNext.x / lenN, y: toNext.y / lenN }
    const aS = { x: curr.x + uP.x * maxR, y: curr.y + uP.y * maxR }
    const aE = { x: curr.x + uN.x * maxR, y: curr.y + uN.y * maxR }

    const a0 = waypoints[i - 1].altitude
    const a1 = waypoints[i].altitude
    const a2 = waypoints[Math.min(i + 1, waypoints.length - 1)].altitude

    // Altitude at arcStart/arcEnd must match how far along each adjacent
    // segment those points actually sit (maxR / segment length) — not the
    // waypoint's own altitude — otherwise altitude races ahead of position
    // and the vertical profile kinks right where the horizontal curve is
    // smoothest. Then blend with the same quadratic Bezier weights as x/y
    // so the climb/descent follows the curve instead of a separate ramp.
    const altS = a1 + (a0 - a1) * (maxR / lenP)
    const altE = a1 + (a2 - a1) * (maxR / lenN)

    for (let s = 0; s <= segsPerCurve; s++) {
      const t = s / segsPerCurve, it = 1 - t
      result.push({
        x: it * it * aS.x + 2 * it * t * curr.x + t * t * aE.x,
        y: it * it * aS.y + 2 * it * t * curr.y + t * t * aE.y,
        alt: it * it * altS + 2 * it * t * a1 + t * t * altE,
      })
    }
  }

  result.push({ ...pts[pts.length - 1], alt: waypoints[waypoints.length - 1].altitude })
  return result.map(p => ({
    lng: cLng + p.x / mPerLng,
    lat: cLat + p.y / mPerLat,
    alt: p.alt,
  }))
}

// Inserts evenly-spaced points along each straight segment so terrain-follow
// can sample real ground height continuously between waypoints, not just at
// the waypoints themselves. Without this, a straight segment between two far
// apart waypoints is just one Cesium line between two points -- it can't bend
// to hug a hill in between since there's nothing sampled there. Capped per
// segment so a very long leg can't blow up the sample count.
function densify(
  points: { lat: number; lng: number; alt: number }[],
  metersPerSample = 25,
  maxPerSegment = 25,
): { lat: number; lng: number; alt: number }[] {
  if (points.length < 2) return points
  const out: typeof points = [points[0]]
  const mPerLat = 111_320
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const mPerLng = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
    const distM = Math.hypot((b.lat - a.lat) * mPerLat, (b.lng - a.lng) * mPerLng)
    const n = Math.min(maxPerSegment, Math.max(1, Math.round(distM / metersPerSample)))
    for (let s = 1; s <= n; s++) {
      const t = s / n
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        alt: a.alt + (b.alt - a.alt) * t,
      })
    }
  }
  return out
}

// ── Waypoint numbered-circle billboard ─────────────────────────────────────
// Single canvas element per waypoint replaces the old point + floating label
// + black-background-box combination (which showed three separate visual
// elements per marker). Number is drawn inside the coloured circle.
function makeWaypointCanvas(num: number, colorHex: string, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')!
  const r = size / 2

  // Subtle drop-shadow for legibility over terrain
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 4

  // Filled circle
  ctx.beginPath()
  ctx.arc(r, r, r - 1.5, 0, Math.PI * 2)
  ctx.fillStyle = colorHex
  ctx.fill()

  // White border ring
  ctx.shadowBlur = 0
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.stroke()

  // Waypoint number centred inside circle
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${size <= 28 ? 10 : 12}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(num), r, r + 0.5)

  return c
}

// ── Drone canvas billboard ──────────────────────────────────────────────────

function makeDroneCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 56; c.height = 56
  const ctx = c.getContext('2d')!

  // Outer ring
  ctx.beginPath()
  ctx.arc(28, 28, 26, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(239,68,68,0.3)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Heading arrow — always drawn pointing canvas-up; actual world-heading
  // rotation is applied via billboard.rotation in preUpdate every frame so
  // the arrow stays world-aligned even as the user orbits the globe.
  ctx.save()
  ctx.translate(28, 28)
  ctx.fillStyle = '#f87171'
  ctx.beginPath()
  ctx.moveTo(0, -25)
  ctx.lineTo(-8, -6)
  ctx.lineTo(0, -12)
  ctx.lineTo(8, -6)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  // Center circle
  ctx.beginPath()
  ctx.arc(28, 28, 10, 0, Math.PI * 2)
  ctx.fillStyle = '#dc2626'
  ctx.fill()
  ctx.strokeStyle = 'white'
  ctx.lineWidth = 2.5
  ctx.stroke()

  return c
}

// ── Component ───────────────────────────────────────────────────────────────

export default function MissionMap3D() {
  const containerRef    = useRef<HTMLDivElement>(null)
  const viewerRef       = useRef<any>(null)
  const CesiumRef       = useRef<any>(null)
  const wpEntitiesRef   = useRef<Map<string, any>>(new Map())
  const rtlEntityRef    = useRef<any>(null)
  const svEntitiesRef   = useRef<any[]>([])
  const pathEntityRef   = useRef<any>(null)
  const completedPathEntityRef = useRef<any>(null)
  const surveyEntityRef = useRef<any>(null)
  const droneEntityRef  = useRef<any>(null)
  const fleetEntitiesRef = useRef<Map<number, any>>(new Map())
  const handlerRef      = useRef<any>(null)
  const flewRef         = useRef(false)
  const draggingIdRef   = useRef<string | null>(null)
  const terrainReadyRef = useRef(false)
  const pathGenRef      = useRef(0)
  const pathSyncRef     = useRef<(() => void) | null>(null)
  const tileSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Chase-cam state — refs so the preUpdate listener always reads current values
  const followDroneRef  = useRef(false)
  const droneHeadingRef = useRef(0)
  // dronePosRef: lat/lng/absAlt for the chase cam — uses absolute_altitude_m
  // (WGS84/MSL from PX4, same datum as Cesium's Cartesian3.fromDegrees height)
  // so the camera is never placed underground at inland sites.
  const dronePosRef = useRef<{ lng: number; lat: number; relAlt: number; absAlt: number } | null>(null)
  // Chase-cam spherical offset relative to drone (in drone-heading-relative frame).
  // Defaults: 80 m behind drone, 25° above horizontal. Updated when Follow is
  // activated so the user can pre-position the camera and then click Follow to
  // lock that exact perspective. Scroll adjusts range while following.
  const followOffsetRef = useRef({ behindM: 30, upM: 10 })
  // Smooth camera state — EMA-interpolated values written every frame
  const camModeRef       = useRef<'follow' | 'perspective'>('follow')
  const camSmoothPosRef  = useRef<any>(null)   // Cartesian3 camera ECEF pos, null = uninitialised
  const camSmoothLookRef = useRef<any>(null)   // Cartesian3 look-target ECEF, null = uninitialised
  const perspOffsetRef   = useRef<any>(null)   // ECEF offset from drone to camera
  const userInteractingRef  = useRef(false)        // true while user is orbiting
  const inactivityTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tracks whether the Cesium viewer has finished its async init. viewerRef
  // is a ref, so flipping it alone doesn't re-trigger effects that bailed
  // out early because the viewer wasn't ready yet — this state does.
  const [viewerReady, setViewerReady] = useState(false)

  const cameraMode          = useMissionStore(s => s.cameraMode)
  const rawWaypoints        = useMissionStore(s => s.waypoints)
  const getRtlWaypoint      = useMissionStore(s => s.getRtlWaypoint)
  const rtlPosition         = useMissionStore(s => s.rtlPosition)
  const selectedId          = useMissionStore(s => s.selectedId)
  const surveyPolygon       = useMissionStore(s => s.surveyPolygon)
  const surveyMode          = useMissionStore(s => s.surveyMode)
  const terrainFollow       = useMissionStore(s => s.terrainFollow)
  const followDrone         = useMissionStore(s => s.followDrone)
  const setFollowDrone      = useMissionStore(s => s.setFollowDrone)

  // RTL is a separate, non-mission control now (see rtlPosition in the
  // mission store) — never part of the flown/displayed path. Defensive
  // filter in case older persisted data still has a legacy 'rtl' entry.
  const waypoints = useMemo(() => rawWaypoints.filter(w => w.type !== 'rtl'), [rawWaypoints])
  const telemetry           = useDroneStore(s => s.telemetry)
  const swarmEnabled        = useSwarmStore(s => s.enabled)
  const fleetDrones         = useSwarmStore(s => s.drones)
  // mission_current_index freezes at the last waypoint index after the mission
  // finishes (PX4 never resets it to -1 on its own), so the path would show
  // entirely green after completion. Treat it as -1 when mission_finished=true
  // so the full planned path reverts to blue once the flight is done.
  const rawMissionIndex   = telemetry?.mission_current_index ?? -1
  const missionFinished   = telemetry?.mission_finished ?? false
  const missionCurrentIndex = missionFinished ? -1 : rawMissionIndex

  // Keep the chase-cam ref in sync with store so the preUpdate listener (init
  // closure) always reads the current value without a stale-closure problem.
  useEffect(() => { followDroneRef.current = followDrone }, [followDrone])
  useEffect(() => {
    camModeRef.current = cameraMode
    // Reset relevant smooth state so the new mode starts from current position
    if (cameraMode === 'perspective') {
      perspOffsetRef.current = null       // capture offset on next frame
    } else {
      camSmoothPosRef.current  = null
      camSmoothLookRef.current = null
    }
  }, [cameraMode])

  // Reset smooth state whenever Follow is toggled on; clear timer on toggle off.
  useEffect(() => {
    if (followDrone) {
      useMissionStore.getState().setCameraMode('follow')  // always start in chase mode
      followOffsetRef.current = { behindM: 30, upM: 10 }
      camSmoothPosRef.current = null
      camSmoothLookRef.current = null
      perspOffsetRef.current  = null
      userInteractingRef.current = false
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current)
    } else {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current)
      userInteractingRef.current = false
    }
  }, [followDrone])

  // NOTE: we intentionally do NOT reset followDrone on unmount here.
  // React StrictMode calls cleanup between the two mount passes in development,
  // which would cancel the auto-follow that page.tsx just set before this
  // component even finished initializing. page.tsx resets followDrone when the
  // user explicitly switches to 2D or navigates away from the mission page.

  // ── Init Cesium viewer ───────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return
    let destroyed = false

    // Cesium requires its CSS for proper canvas sizing
    if (!document.getElementById('cesium-widgets-css')) {
      const link = document.createElement('link')
      link.id   = 'cesium-widgets-css'
      link.rel  = 'stylesheet'
      link.href = '/cesium/Widgets/widgets.css'
      document.head.appendChild(link)
    }

    // Must set base URL before importing Cesium
    ;(window as any).CESIUM_BASE_URL = '/cesium/'

    import('cesium').then(async (Cesium) => {
      if (destroyed || !containerRef.current) return

      CesiumRef.current = Cesium

      const ionToken   = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN
      const googleKey  = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

      if (ionToken) Cesium.Ion.defaultAccessToken = ionToken

      // ── Base imagery ─────────────────────────────────────────────────────
      // ArcGIS World Imagery renders "Map data not yet available" as pixel
      // text directly onto tile images (HTTP 200, not 404) for zoom 18-19 in
      // data-sparse regions (India, rural areas globally). Because it's a
      // valid tile response, Cesium has no fallback — it just displays the
      // text. The only fix is to not use ArcGIS at those zoom levels, or to
      // use a different provider that has genuine global coverage.
      //
      // With an Ion token: use Bing Maps Aerial via createWorldImageryAsync —
      // Bing has real high-resolution imagery globally including all of India
      // at zoom 18-19, with no placeholder tiles. ImageryLayer.fromProviderAsync
      // accepts the promise directly so the viewer starts up immediately and
      // the Bing tiles stream in as soon as the Ion auth resolves.
      //
      // Without an Ion token: fall back to ArcGIS capped at level 17. Level 17
      // has genuine global coverage without "not available" tiles; Cesium
      // upsamples those tiles for closer zoom positions so camera zoom is never
      // blocked, just blurrier at extreme close zoom.
      let baseLayer: any
      if (ionToken) {
        try {
          baseLayer = (Cesium as any).ImageryLayer.fromProviderAsync(
            (Cesium as any).createWorldImageryAsync({
              style: (Cesium as any).IonWorldImageryStyle?.AERIAL ?? 0,
            })
          )
        } catch (e) {
          console.warn('createWorldImageryAsync failed, falling back to ArcGIS:', e)
        }
      }
      if (!baseLayer) {
        baseLayer = new Cesium.ImageryLayer(
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 17,
            credit: new Cesium.Credit('Esri, DigitalGlobe, GeoEye', false),
          })
        )
      }

      // ── Viewer ──────────────────────────────────────────────────────────
      const viewer = new Cesium.Viewer(containerRef.current, {
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: true,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        baseLayer,
      })

      // Cleaner globe look
      viewer.scene.globe.enableLighting = true
      viewer.scene.fog.enabled = true
      viewer.scene.globe.showGroundAtmosphere = true
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true
      viewer.scene.backgroundColor = Cesium.Color.BLACK

      // Remove the ugly Cesium ion credit bar
      const creditContainer = viewer.cesiumWidget.creditContainer as HTMLElement
      creditContainer.style.display = 'none'

      viewerRef.current = viewer

      // ── Terrain ──────────────────────────────────────────────────────────
      // When an Ion token is set, use Cesium World Terrain — it's calibrated
      // against the same dataset as Cesium Ion OSM Buildings, so building
      // extrusions actually sit on the ground everywhere. Mixing OSM
      // Buildings with a third-party terrain provider (e.g. ArcGIS) causes
      // a height-datum mismatch that varies by region — buildings float or
      // sink relative to the terrain since the two were never calibrated
      // together. Falls back to free ArcGIS terrain when no token is set.
      try {
        const terrain = ionToken
          ? await Cesium.createWorldTerrainAsync({ requestVertexNormals: true })
          : await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
              'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
            )
        if (!destroyed) {
          viewer.scene.terrainProvider = terrain
          terrainReadyRef.current = true
        }
      } catch (e) {
        console.warn('Terrain provider failed:', e)
      }

      if (destroyed) return

      // ── CartoDB labels overlay (Cesium 1.138+ API: add ImageryLayer directly)
      viewer.imageryLayers.add(
        new Cesium.ImageryLayer(
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
            credit: new Cesium.Credit('© OpenStreetMap contributors © CARTO', false),
          })
        )
      )

      // ── 3D Buildings / Photorealistic tiles ────────────────────────────
      if (googleKey) {
        // Google Photorealistic 3D Tiles — best quality
        try {
          Cesium.GoogleMaps.defaultApiKey = googleKey
          const googleTileset = await Cesium.createGooglePhotorealistic3DTileset()
          viewer.scene.primitives.add(googleTileset)
        } catch (e) {
          console.warn('Google Photorealistic 3D failed:', e)
        }
      } else if (ionToken) {
        // Cesium Ion OSM Buildings
        try {
          const buildings = await Cesium.createOsmBuildingsAsync?.()
          if (buildings && !destroyed) viewer.scene.primitives.add(buildings)
        } catch (e) {
          console.warn('Cesium Ion OSM buildings failed:', e)
        }
      }

      if (destroyed) return

      // ── Mouse input handler ─────────────────────────────────────────────
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      handlerRef.current = handler

      // Temporarily pause chase cam for 3 s then smoothly return to follow.
      // The user's orbit/zoom is not interrupted — Cesium's own camera controller
      // still handles input; we simply stop overriding it during this window.
      const startInactivityTimer = () => {
        userInteractingRef.current = true
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current)
        inactivityTimerRef.current = setTimeout(() => {
          userInteractingRef.current = false
          camSmoothPosRef.current  = null
          camSmoothLookRef.current = null
          perspOffsetRef.current   = null
        }, 3000)
      }

      // LEFT_DOWN: pause follow temporarily (not permanently); start waypoint drag if needed.
      handler.setInputAction((down: any) => {
        if (followDroneRef.current) startInactivityTimer()
        const picked = viewer.scene.pick(down.position)
        if (picked?.id?._id?.startsWith?.('wp-')) {
          draggingIdRef.current = picked.id._id.replace('wp-', '')
          viewer.scene.screenSpaceCameraController.enableRotate = false
          viewer.scene.screenSpaceCameraController.enableTranslate = false
          viewer.scene.screenSpaceCameraController.enableTilt = false
        }
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

      // MOUSE_MOVE: drag waypoint
      handler.setInputAction((move: any) => {
        if (!draggingIdRef.current) return
        const cart = viewer.scene.pickPosition(move.endPosition)
          ?? viewer.camera.pickEllipsoid(move.endPosition, Cesium.Ellipsoid.WGS84)
        if (!cart) return
        const entity = viewer.entities.getById(`wp-${draggingIdRef.current}`)
        if (entity) (entity.position as any) = new Cesium.ConstantPositionProperty(cart)
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

      // LEFT_UP: end drag or click to add
      handler.setInputAction((up: any) => {
        if (draggingIdRef.current) {
          const entity = viewer.entities.getById(`wp-${draggingIdRef.current}`)
          if (entity) {
            const pos = entity.position?.getValue(viewer.clock.currentTime)
            if (pos) {
              const carto = Cesium.Cartographic.fromCartesian(pos)
              useMissionStore.getState().updateWaypoint(draggingIdRef.current!, {
                lat: Math.round(Cesium.Math.toDegrees(carto.latitude) * 1e7) / 1e7,
                lng: Math.round(Cesium.Math.toDegrees(carto.longitude) * 1e7) / 1e7,
              })
            }
          }
          draggingIdRef.current = null
          viewer.scene.screenSpaceCameraController.enableRotate = true
          viewer.scene.screenSpaceCameraController.enableTranslate = true
          viewer.scene.screenSpaceCameraController.enableTilt = true
          return
        }

        // Regular click — select or add waypoint
        const picked = viewer.scene.pick(up.position)
        if (picked?.id?._id?.startsWith?.('wp-')) {
          useMissionStore.getState().selectWaypoint(picked.id._id.replace('wp-', ''))
          return
        }
        if (picked?.id?._id?.startsWith?.('sv-')) return // survey vertex click

        const store = useMissionStore.getState()
        const cart = viewer.scene.pickPosition(up.position)
          ?? viewer.camera.pickEllipsoid(up.position, Cesium.Ellipsoid.WGS84)
        if (!cart) return
        const carto = Cesium.Cartographic.fromCartesian(cart)
        const lat = Cesium.Math.toDegrees(carto.latitude)
        const lng = Cesium.Math.toDegrees(carto.longitude)

        if (store.surveyMode) {
          store.addSurveyPoint(lat, lng)
        } else {
          store.addWaypoint(lat, lng)
        }
      }, Cesium.ScreenSpaceEventType.LEFT_UP)

      // Markers re-sample terrain live every frame (heightReference), but the
      // path line is a one-shot bake. Right after a fly-to, the higher-detail
      // tiles for the new view are still streaming in, so that one-shot bake
      // can be a bit off from where the (continuously-refining) markers settle
      // -- looking like the line doesn't quite meet the dots until something
      // else happens to force a re-sync. Re-bake once the tile queue drains.
      viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
        if (queued !== 0) return
        if (tileSettleTimer.current) clearTimeout(tileSettleTimer.current)
        tileSettleTimer.current = setTimeout(() => pathSyncRef.current?.(), 300)
      })

      // ── Chase-cam: runs every frame via preUpdate ──────────────────────
      // Positions the camera behind and above the drone, oriented
      // to follow the drone's heading. Called every frame so the chase stays
      // smooth between telemetry ticks. Any mouse interaction releases it.
      // Reuse a single ConstantProperty for rotation instead of allocating
      // a new one every frame — setValue updates it in-place with no GC churn.
      let droneRotationProp: any = null
      const chaseCamHandler = () => {
        // Keep the heading arrow world-aligned every frame. billboard.rotation
        // is in screen space (CCW positive), so we offset by camera.heading
        // to cancel out the camera's own yaw before applying drone heading.
        if (droneEntityRef.current?.billboard) {
          const rotRad = viewer.camera.heading - Cesium.Math.toRadians(droneHeadingRef.current)
          if (!droneRotationProp) {
            droneRotationProp = new Cesium.ConstantProperty(rotRad)
            droneEntityRef.current.billboard.rotation = droneRotationProp
          } else {
            droneRotationProp.setValue(rotRad)
          }
        }

        if (!followDroneRef.current || !dronePosRef.current) return

        const dp = dronePosRef.current
        // globe.getHeight() samples the same terrain dataset that
        // HeightReference.RELATIVE_TO_GROUND uses for the drone billboard — both
        // go through the same DEM. This guarantees the camera is placed at the
        // same absolute height as the rendered drone entity, regardless of whether
        // PX4 has sent home_alt yet (which caused the underground-camera bug at
        // elevated sites like Hyderabad where absAlt=0 before home is set).
        const droneCarto = Cesium.Cartographic.fromDegrees(dp.lng, dp.lat)
        const surfaceAlt = viewer.scene.globe.getHeight(droneCarto)
          ?? Math.max(dp.absAlt - dp.relAlt, 0)   // fallback: infer from PX4 if terrain not yet loaded
        const droneAbsPos = Cesium.Cartesian3.fromDegrees(dp.lng, dp.lat, surfaceAlt + dp.relAlt)

        if (camModeRef.current === 'follow') {
          // ── Follow / Chase mode — body-frame camera ─────────────────────
          //
          // All positioning is done in the drone's local ENU frame (East-North-Up)
          // at the drone's ECEF position, then transformed to world ECEF.
          // This avoids Euler-angle gimbal lock and never inverts the horizon.
          //
          // Aircraft body axes in ENU (heading measured CW from North):
          //   Forward: (sin H,  cos H, 0)
          //   Right:   (cos H, -sin H, 0)
          //   Up:      (0,      0,     1)
          //
          // Camera is placed behindM in the −forward direction and upM in +up,
          // then looks 20 m ahead of the drone (not at the drone center).
          const headingRad = Cesium.Math.toRadians(droneHeadingRef.current)
          const sinH = Math.sin(headingRad)
          const cosH = Math.cos(headingRad)
          const { behindM, upM } = followOffsetRef.current

          // Local ENU frame at drone's ECEF position
          const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(droneAbsPos)

          // Camera offset in ENU: behind = −forward, above = +Z
          const camOffsetENU = new Cesium.Cartesian3(-sinH * behindM, -cosH * behindM, upM)
          // multiplyByPoint applies translation + rotation → gives absolute ECEF position
          const targetCamPos = Cesium.Matrix4.multiplyByPoint(enuToEcef, camOffsetENU, new Cesium.Cartesian3())

          // Look-at target: 20 m ahead in drone's forward direction
          const lookOffsetENU = new Cesium.Cartesian3(sinH * 20, cosH * 20, 0)
          const targetLookPos = Cesium.Matrix4.multiplyByPoint(enuToEcef, lookOffsetENU, new Cesium.Cartesian3())

          // Initialise smooth state on first frame
          if (!camSmoothPosRef.current) {
            camSmoothPosRef.current  = Cesium.Cartesian3.clone(targetCamPos)
            camSmoothLookRef.current = Cesium.Cartesian3.clone(targetLookPos)
          }

          if (!userInteractingRef.current) {
            // EMA-smooth camera position and look target (α=0.08 ≈ 200 ms lag at 60 fps)
            Cesium.Cartesian3.lerp(camSmoothPosRef.current,  targetCamPos,  0.08, camSmoothPosRef.current)
            Cesium.Cartesian3.lerp(camSmoothLookRef.current, targetLookPos, 0.08, camSmoothLookRef.current)

            // Direction vector: from camera toward look target
            const direction = Cesium.Cartesian3.subtract(
              camSmoothLookRef.current,
              camSmoothPosRef.current,
              new Cesium.Cartesian3(),
            )
            Cesium.Cartesian3.normalize(direction, direction)

            // Up vector: ENU +Z (radial outward from Earth center at drone position).
            // Using ENU up — not body up — keeps the horizon level regardless of
            // drone pitch/roll and prevents any camera inversion.
            const upECEF = Cesium.Matrix4.multiplyByPointAsVector(
              enuToEcef,
              new Cesium.Cartesian3(0, 0, 1),
              new Cesium.Cartesian3(),
            )
            Cesium.Cartesian3.normalize(upECEF, upECEF)

            // setView with direction+up avoids all Euler-angle heading/pitch/roll
            // ambiguity — Cesium computes right = cross(direction, up) internally.
            viewer.camera.setView({
              destination: camSmoothPosRef.current,
              orientation: { direction, up: upECEF },
            })
          }
        } else {
          // ── Perspective / Orbit mode ────────────────────────────────────
          // Camera translates with the drone while preserving whatever
          // heading/pitch/roll the user has set. When the user is orbiting,
          // we track the offset live so resuming translate uses the new angle.
          if (userInteractingRef.current) {
            perspOffsetRef.current = Cesium.Cartesian3.subtract(
              viewer.camera.position,
              droneAbsPos,
              perspOffsetRef.current ?? new Cesium.Cartesian3(),
            )
            camSmoothPosRef.current = Cesium.Cartesian3.clone(viewer.camera.position)
            return
          }

          if (!perspOffsetRef.current) {
            perspOffsetRef.current = Cesium.Cartesian3.subtract(
              viewer.camera.position,
              droneAbsPos,
              new Cesium.Cartesian3(),
            )
            camSmoothPosRef.current = Cesium.Cartesian3.clone(viewer.camera.position)
          }

          const targetPos = Cesium.Cartesian3.add(
            droneAbsPos,
            perspOffsetRef.current,
            new Cesium.Cartesian3(),
          )
          Cesium.Cartesian3.lerp(camSmoothPosRef.current, targetPos, 0.10, camSmoothPosRef.current)
          // Preserve user's current orientation: read heading/pitch/roll then
          // re-apply at the new position via setView so the camera frame stays
          // valid (direct .position assignment leaves direction/up undefined).
          viewer.camera.setView({
            destination: camSmoothPosRef.current,
            orientation: {
              heading: viewer.camera.heading,
              pitch:   viewer.camera.pitch,
              roll:    viewer.camera.roll,
            },
          })
        }
      }
      viewer.scene.preUpdate.addEventListener(chaseCamHandler)

      // Middle/right drag also temporarily pauses follow; user re-engages by
      // letting the inactivity timer fire or pressing the Follow button again.
      handler.setInputAction(() => {
        if (followDroneRef.current) startInactivityTimer()
      }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)
      handler.setInputAction(() => {
        if (followDroneRef.current) startInactivityTimer()
      }, Cesium.ScreenSpaceEventType.RIGHT_DOWN)
      // Scroll adjusts the follow distance so the user can zoom in/out while
      // following. When NOT in follow mode, Cesium's own WHEEL handler (on a
      // separate ScreenSpaceEventHandler) handles zoom normally.
      handler.setInputAction((delta: number) => {
        if (followDroneRef.current) {
          // delta > 0: wheel forward (zoom in) → shrink range; < 0: zoom out
          const cur = followOffsetRef.current
          followOffsetRef.current = { ...cur, behindM: Math.max(10, Math.min(200, cur.behindM - delta * 0.02)) }
        }
      }, Cesium.ScreenSpaceEventType.WHEEL)

      setViewerReady(true)
      // Store the chaseCamHandler removal callback for cleanup
      ;(viewer as any)._chaseCamCleanup = () => viewer.scene.preUpdate.removeEventListener(chaseCamHandler)
    })

    return () => {
      destroyed = true
      if (tileSettleTimer.current) clearTimeout(tileSettleTimer.current)
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current)
      viewerRef.current?._chaseCamCleanup?.()
      handlerRef.current?.destroy()
      viewerRef.current?.destroy()
      viewerRef.current = null
      CesiumRef.current = null
      wpEntitiesRef.current.clear()
      svEntitiesRef.current = []
      pathEntityRef.current = null
      completedPathEntityRef.current = null
      surveyEntityRef.current = null
      droneEntityRef.current = null
      rtlEntityRef.current = null
      fleetEntitiesRef.current.clear()
      pathSyncRef.current = null
      flewRef.current = false
      draggingIdRef.current = null
      setViewerReady(false)
    }
  }, [])

  // ── Sync waypoints + path ────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!viewer || !Cesium) return

    const currentIds = new Set(waypoints.map(w => w.id))

    // Remove deleted waypoint entities
    for (const [id, entity] of wpEntitiesRef.current) {
      if (!currentIds.has(id)) {
        viewer.entities.remove(entity)
        wpEntitiesRef.current.delete(id)
      }
    }

    // Add/update waypoint entities — single numbered-circle billboard per point,
    // no separate label entity and no floating black background box.
    waypoints.forEach((wp, i) => {
      const isCurrent  = i === missionCurrentIndex
      const isSelected = wp.id === selectedId
      const colorHex   = isCurrent ? '#22c55e' : (WP_META[wp.type as keyof typeof WP_META]?.color ?? '#3b82f6')
      // Larger circle for the active or selected waypoint so it stands out
      const size       = (isSelected || isCurrent) ? 36 : 28
      // Height above the LOCAL ground at this exact point (RELATIVE_TO_GROUND
      // below samples terrain automatically) — always the configured altitude,
      // never zeroed. Terrain-follow vs. not is a path-shape distinction
      // (flat baseline vs. contour-hugging), not a "drop markers to the floor" one.
      const alt        = wp.altitude

      if (wpEntitiesRef.current.has(wp.id)) {
        const entity = wpEntitiesRef.current.get(wp.id)!
        entity.position = Cesium.Cartesian3.fromDegrees(wp.lng, wp.lat, alt)
        entity.billboard.image = new Cesium.ConstantProperty(makeWaypointCanvas(i + 1, colorHex, size))
        entity.billboard.width = new Cesium.ConstantProperty(size)
        entity.billboard.height = new Cesium.ConstantProperty(size)
      } else {
        const entity = viewer.entities.add({
          id: `wp-${wp.id}`,
          position: Cesium.Cartesian3.fromDegrees(wp.lng, wp.lat, alt),
          billboard: {
            image: makeWaypointCanvas(i + 1, colorHex, size),
            width: size,
            height: size,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // CENTER keeps the circle centred on the waypoint coordinate so the
            // path line visually passes through the middle of each marker.
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
          },
        })
        wpEntitiesRef.current.set(wp.id, entity)
      }
    })

    // ── RTL marker ──────────────────────────────────────────────────────────
    // Separate from the mission entities above — RTL is not part of the
    // flown path, just the point the drone goes to when triggered.
    if (waypoints.length > 0) {
      const rtl = getRtlWaypoint()
      const rtlColor = Cesium.Color.fromCssColorString('#a855f7')
      if (rtlEntityRef.current) {
        rtlEntityRef.current.position = Cesium.Cartesian3.fromDegrees(rtl.lng, rtl.lat, rtl.altitude)
      } else {
        rtlEntityRef.current = viewer.entities.add({
          id: 'rtl-marker',
          position: Cesium.Cartesian3.fromDegrees(rtl.lng, rtl.lat, rtl.altitude),
          point: {
            pixelSize: 13,
            color: rtlColor,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2.5,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: 'RTL',
            font: 'bold 11px monospace',
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            pixelOffset: new Cesium.Cartesian2(0, -22),
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: new Cesium.Color(0.66, 0.33, 0.97, 0.55),
          },
        })
      }
    } else if (rtlEntityRef.current) {
      viewer.entities.remove(rtlEntityRef.current)
      rtlEntityRef.current = null
    }

    // ── Mission path ───────────────────────────────────────────────────────
    // Waypoint markers use heightReference RELATIVE_TO_GROUND (Cesium samples
    // terrain under them automatically). A plain polyline has no such option,
    // so its z must be baked in as an absolute height — every point here is
    // its OWN sampled ground height + altitude, exactly matching how the
    // markers are positioned, so the line always passes through the dots
    // (the previous version anchored every point to waypoint[0]'s ground
    // height alone, which is fine on flat ground but badly wrong on a slope —
    // points far from waypoint 0 floated at the wrong absolute height).
    //   - terrain-follow ON:  densified with extra sample points along each
    //     leg so the line actually hugs the ground between waypoints too,
    //     not just at the waypoints themselves.
    //   - terrain-follow OFF: only the real waypoints/curve points are
    //     sampled — still exact at every waypoint, but no extra bump-chasing
    //     in between, matching how MAV_FRAME_GLOBAL_RELATIVE_ALT actually
    //     flies (interpolated between waypoint altitudes, not terrain).
    // Mirrors the 2D map: remaining route in blue/cyan, flown legs solid green
    // — same split, same colors, so switching views doesn't change the story.
    pathGenRef.current += 1
    const myGen = pathGenRef.current

    const commitSegment = (
      entityRef: { current: any },
      segmentWaypoints: Waypoint[],
      color: any,
      glow: boolean,
      useDensify: boolean,
    ) => {
      const viewer = viewerRef.current
      const Cesium = CesiumRef.current
      if (!viewer || !Cesium) return

      if (segmentWaypoints.length < 2) {
        if (entityRef.current) {
          viewer.entities.remove(entityRef.current)
          entityRef.current = null
        }
        return
      }

      const smooth = buildSmoothCoords(segmentWaypoints)
      const samplePoints = useDensify ? densify(smooth) : smooth

      const cartographics = samplePoints.map(p => Cesium.Cartographic.fromDegrees(p.lng, p.lat))
      Cesium.sampleTerrainMostDetailed(viewer.scene.terrainProvider, cartographics)
        .then((sampled: any[]) => commit(sampled.map((c: any) => c.height ?? 0)))
        .catch(() => commit(samplePoints.map(() => 0)))

      function commit(groundHeights: number[]) {
        if (pathGenRef.current !== myGen) return // superseded by a newer update
        // +0.3 m above the sampled terrain prevents z-fighting with the terrain
        // mesh surface, which causes the line to flicker in/out at low altitude.
        // 0.3 m is imperceptible from any normal viewing distance.
        const positions = samplePoints.map((p, i) =>
          Cesium.Cartesian3.fromDegrees(p.lng, p.lat, (groundHeights[i] ?? 0) + p.alt + 0.3)
        )
        const old = entityRef.current
        entityRef.current = viewer.entities.add({
          polyline: {
            positions: new Cesium.ConstantProperty(positions),
            width: glow ? 4 : 4,
            material: glow
              ? new Cesium.PolylineGlowMaterialProperty({ color, glowPower: 0.28, taperPower: 1.0 })
              : new Cesium.ColorMaterialProperty(color),
            // Higher alpha so the path stays clearly readable even when it passes
            // behind buildings or terrain (Cesium renders this material for
            // occluded segments instead of hiding them entirely).
            depthFailMaterial: new Cesium.ColorMaterialProperty(color.withAlpha(0.65)),
          },
        })
        if (old) viewer.entities.remove(old) // swap after the new line is in, no flicker
      }
    }

    const runPathSync = () => {
      const pathColor = terrainFollow
        ? new Cesium.Color(0.13, 0.83, 0.93, 1.0)   // cyan — terrain-follow (adapts)
        : new Cesium.Color(0.37, 0.64, 0.98, 1.0)   // blue — fixed altitude (doesn't adapt)
      const completedColor = new Cesium.Color(0.13, 0.77, 0.37, 1.0) // solid bold green

      if (missionCurrentIndex < 0) {
        // No active mission — full planned path only
        commitSegment(pathEntityRef, waypoints, pathColor, true, terrainFollow)
        commitSegment(completedPathEntityRef, [], completedColor, false, false)
      } else {
        const remaining = waypoints.slice(Math.max(0, missionCurrentIndex))
        const completed = waypoints.slice(0, Math.min(missionCurrentIndex + 1, waypoints.length))
        commitSegment(pathEntityRef, remaining, pathColor, true, terrainFollow)
        commitSegment(completedPathEntityRef, missionCurrentIndex >= 1 ? completed : [], completedColor, false, false)
      }
    }

    // Re-run with the latest closure once more detailed terrain tiles finish
    // loading (see the tileLoadProgressEvent listener below) — fixes the line
    // looking detached from the waypoint dots right after a fresh fly-to,
    // before the higher-detail tiles for this exact view have arrived.
    pathSyncRef.current = runPathSync
    runPathSync()

    // Fly to first waypoint if not done yet
    if (waypoints.length > 0 && !flewRef.current) {
      flewRef.current = true
      const wp0 = waypoints[0]
      const wp0Carto  = Cesium.Cartographic.fromDegrees(wp0.lng, wp0.lat)
      const wp0Ground = viewer.scene.globe.getHeight(wp0Carto) ?? 0
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(wp0.lng, wp0.lat, Math.max(wp0Ground + 400, 800)),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
        duration: 2,
      })
    }
  }, [waypoints, selectedId, missionCurrentIndex, terrainFollow, viewerReady, rtlPosition])

  // ── Survey polygon ───────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!viewer || !Cesium) return

    // Clear old survey entities
    if (surveyEntityRef.current) {
      viewer.entities.remove(surveyEntityRef.current)
      surveyEntityRef.current = null
    }
    svEntitiesRef.current.forEach(e => viewer.entities.remove(e))
    svEntitiesRef.current = []

    if (!surveyMode || surveyPolygon.length === 0) return

    // Survey polygon fill
    if (surveyPolygon.length >= 3) {
      surveyEntityRef.current = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            surveyPolygon.map((p: { lat: number; lng: number }) =>
              Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 2)
            )
          ),
          material: new Cesium.Color(0.66, 0.33, 0.97, 0.18),
          outline: true,
          outlineColor: new Cesium.Color(0.66, 0.33, 0.97, 0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      })
    }

    // Survey vertex markers
    surveyPolygon.forEach((p: { lat: number; lng: number }, i: number) => {
      const entity = viewer.entities.add({
        id: `sv-${i}`,
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat, 5),
        point: {
          pixelSize: 10,
          color: new Cesium.Color(0.66, 0.33, 0.97, 1.0),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: String(i + 1),
          font: '10px monospace',
          fillColor: Cesium.Color.WHITE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      svEntitiesRef.current.push(entity)
    })
  }, [surveyPolygon, surveyMode, viewerReady])

  // ── Drone live position ──────────────────────────────────────────────────
  const updateDrone = useCallback(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!viewer || !Cesium) return

    const dronePos = telemetry?.position
    if (!dronePos || dronePos.latitude_deg === 0) return

    const heading = telemetry?.heading_deg ?? 0
    const relAlt  = dronePos.relative_altitude_m ?? 0
    droneHeadingRef.current = heading
    dronePosRef.current = {
      lng: dronePos.longitude_deg,
      lat: dronePos.latitude_deg,
      relAlt,
      absAlt: dronePos.absolute_altitude_m ?? 0,
    }

    // Same height convention as waypoints/path: meters above local terrain
    // (AGL), not absolute MSL — keeps the drone aligned with the rendered
    // terrain mesh regardless of geoid/ellipsoid offset at this location.
    const position = Cesium.Cartesian3.fromDegrees(
      dronePos.longitude_deg,
      dronePos.latitude_deg,
      relAlt,
    )

    if (droneEntityRef.current) {
      droneEntityRef.current.position = position
      droneEntityRef.current.billboard.image = new Cesium.ConstantProperty(
        makeDroneCanvas()
      )
      droneEntityRef.current.label.text = new Cesium.ConstantProperty(
        `${relAlt.toFixed(1)} m`
      )
    } else {
      droneEntityRef.current = viewer.entities.add({
        position,
        billboard: {
          image: makeDroneCanvas(),
          width: 56,
          height: 56,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${relAlt.toFixed(1)} m`,
          font: 'bold 11px monospace',
          fillColor: Cesium.Color.WHITE,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          pixelOffset: new Cesium.Cartesian2(0, -42),
          showBackground: true,
          backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })

      // Fly to drone if no waypoints yet.
      // Height must be above terrain — use globe.getHeight so sites at elevated
      // altitude (e.g. Hyderabad ≈ 525 m) don't land the camera underground.
      if (!flewRef.current && useMissionStore.getState().waypoints.length === 0) {
        flewRef.current = true
        const flyCarto = Cesium.Cartographic.fromDegrees(dronePos.longitude_deg, dronePos.latitude_deg)
        const flyGroundAlt = viewer.scene.globe.getHeight(flyCarto) ?? 0
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            dronePos.longitude_deg,
            dronePos.latitude_deg,
            Math.max(flyGroundAlt + 400, 800),   // 400 m AGL, minimum 800 m MSL
          ),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
          duration: 1.5,
        })
      }
    }
  }, [telemetry, viewerReady])

  useEffect(() => { updateDrone() }, [updateDrone])

  // ── Fleet drone positions (swarm mode) ───────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!viewer || !Cesium) return

    // Remove all fleet entities when swarm is off or viewer not ready
    if (!swarmEnabled || !viewerReady) {
      for (const entity of fleetEntitiesRef.current.values()) {
        viewer.entities.remove(entity)
      }
      fleetEntitiesRef.current.clear()
      return
    }

    const currentIds = new Set(Object.keys(fleetDrones).map(Number))

    // Remove entities for drones that were removed from the fleet
    for (const [id, entity] of fleetEntitiesRef.current) {
      if (!currentIds.has(id)) {
        viewer.entities.remove(entity)
        fleetEntitiesRef.current.delete(id)
      }
    }

    // Add or update each fleet drone's entity
    for (const drone of Object.values(fleetDrones)) {
      const pos = drone.telemetry?.position
      if (!pos || pos.latitude_deg === 0) continue

      const color    = Cesium.Color.fromCssColorString(drone.color)
      const position = Cesium.Cartesian3.fromDegrees(
        pos.longitude_deg, pos.latitude_deg, pos.relative_altitude_m ?? 0
      )
      const altText  = `${(pos.relative_altitude_m ?? 0).toFixed(1)} m`

      if (fleetEntitiesRef.current.has(drone.id)) {
        const entity = fleetEntitiesRef.current.get(drone.id)!
        entity.position = position
        if (entity.label) {
          entity.label.text = new Cesium.ConstantProperty(`${drone.name}\n${altText}`)
        }
      } else {
        const entity = viewer.entities.add({
          id: `fleet-${drone.id}`,
          position,
          point: {
            pixelSize: 14,
            color,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2.5,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `${drone.name}\n${altText}`,
            font: 'bold 10px monospace',
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            pixelOffset: new Cesium.Cartesian2(0, -24),
            showBackground: true,
            backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
        fleetEntitiesRef.current.set(drone.id, entity)
      }
    }
  }, [fleetDrones, swarmEnabled, viewerReady])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Camera mode is controlled via the Follow split-button in the mission toolbar */}
    </div>
  )
}

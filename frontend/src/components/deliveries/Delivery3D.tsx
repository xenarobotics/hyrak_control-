'use client'

// 3D dispatch view - Cesium globe with terrain-correct geometry:
// - route ribbons at ground + relative altitude (sampleTerrainMostDetailed,
//   the same fix the Mission tab needed - raw relative altitudes render
//   UNDER the terrain at IITH's ~540 m elevation)
// - drones as persistent entities, positions lerped between telemetry
//   samples, height RELATIVE_TO_GROUND so they sit ON the world
// - AIRSPACE toggle: red/orange zones as extruded translucent volumes from
//   floor to ceiling - the 3D counterpart of the 2D land-use overlay
// - OSM building extrusions when a Cesium Ion token is configured
//
// Speed rules (this view must be interactive in 2-5 s, not minutes):
// - the Cesium module is preloaded via warmCesium() while the user is
//   still on the 2D map, so opening 3D doesn't pay the bundle download
// - the viewer goes live IMMEDIATELY on a flat globe; terrain and OSM
//   buildings stream in afterwards and the routes re-sample when ready
// - static entities rebuild only when their CONTENT changes (signature
//   string), not on every 3 s poll that recreates the props objects
// - terrain samples are cached per waypoint set, so a rebuild does not
//   re-fetch elevation tiles it already has

import { useEffect, useMemo, useRef, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { ZONE_COLORS, type ZoneFeature } from '@/components/admin/zones'
import type { MapDroneLive, MapPad, MapSelection } from './DeliveryMap'

const LERP_MS = 3200   // slightly over the telemetry poll period

// One shared import promise: warmCesium() starts the (large) chunk download
// early; the viewer init awaits the same promise instead of a fresh import.
let cesiumPromise: Promise<typeof import('cesium')> | null = null
export function warmCesium() {
    cesiumPromise ??= import('cesium')
    return cesiumPromise
}

// Elevation cache: waypoint-set signature -> ground heights. Survives
// remounts, so flipping 2D/3D or reopening an order costs no re-fetch.
const terrainCache = new Map<string, number[]>()

export default function Delivery3D({ pads, selection, drones, showAirspace }: {
    pads: MapPad[]
    selection: MapSelection
    drones: MapDroneLive[]
    showAirspace: boolean
}) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewerRef = useRef<any>(null)
    const CesiumRef = useRef<any>(null)
    const flownRef = useRef<string>('')
    const routeGenRef = useRef(0)
    const [zones, setZones] = useState<ZoneFeature[]>([])
    const [ready, setReady] = useState(false)          // viewer constructed
    const [terrainGen, setTerrainGen] = useState(0)    // bumps when terrain arrives
    const droneRefs = useRef<Map<string, {
        entity: any
        from: { lat: number; lng: number; alt: number }
        to: { lat: number; lng: number; alt: number }
        t0: number
    }>>(new Map())

    useEffect(() => {
        fetch(`${getServerUrl()}/api/zones`)
            .then(r => r.json())
            .then(j => setZones((j.features ?? []).filter((z: ZoneFeature) => z.properties.active)))
            .catch(() => { /* airspace stays hidden */ })
    }, [])

    // ── Viewer init - once, and live BEFORE terrain/buildings arrive ─────
    useEffect(() => {
        if (!containerRef.current || viewerRef.current) return
        let destroyed = false

        if (!document.getElementById('cesium-widgets-css')) {
            const link = document.createElement('link')
            link.id = 'cesium-widgets-css'
            link.rel = 'stylesheet'
            link.href = '/cesium/Widgets/widgets.css'
            document.head.appendChild(link)
        }
        ;(window as any).CESIUM_BASE_URL = '/cesium/'

        warmCesium().then((Cesium) => {
            if (destroyed || !containerRef.current) return
            CesiumRef.current = Cesium

            const ionToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN
            if (ionToken) Cesium.Ion.defaultAccessToken = ionToken

            let baseLayer: any
            if (ionToken) {
                try {
                    baseLayer = (Cesium as any).ImageryLayer.fromProviderAsync(
                        (Cesium as any).createWorldImageryAsync({
                            style: (Cesium as any).IonWorldImageryStyle?.AERIAL ?? 0,
                        })
                    )
                } catch { /* fall through to ArcGIS */ }
            }
            if (!baseLayer) {
                baseLayer = new Cesium.ImageryLayer(
                    new Cesium.UrlTemplateImageryProvider({
                        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                        maximumLevel: 17,
                        credit: new Cesium.Credit('Esri', false),
                    })
                )
            }

            const viewer = new Cesium.Viewer(containerRef.current, {
                animation: false, baseLayerPicker: false, fullscreenButton: false,
                geocoder: false, homeButton: false, infoBox: false,
                sceneModePicker: false, selectionIndicator: false,
                timeline: false, navigationHelpButton: false, baseLayer,
            })
            viewer.scene.globe.enableLighting = false
            viewer.scene.globe.depthTestAgainstTerrain = true
            ;(viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none'

            // Live now - the flat globe already shows pads, drones, routes.
            viewerRef.current = viewer
            flownRef.current = ''
            setReady(true)

            // Terrain streams in behind the first paint; routes re-sample
            // when it lands (terrainGen dependency below).
            const terrainReady = ionToken
                ? Cesium.createWorldTerrainAsync({ requestVertexNormals: true })
                : Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
                    'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer')
            terrainReady.then((tp: any) => {
                if (destroyed || viewer.isDestroyed?.()) return
                viewer.terrainProvider = tp
                terrainCache.clear()   // flat-globe zeros are now wrong
                setTerrainGen(g => g + 1)
            }).catch(() => { /* flat globe still works */ })

            if (ionToken) {
                Cesium.createOsmBuildingsAsync().then((b: any) => {
                    if (!destroyed && !viewer.isDestroyed?.()) {
                        viewer.scene.primitives.add(b)
                    }
                }).catch(() => { /* imagery-only view still works */ })
            }
        })

        return () => {
            // The viewer may finish constructing after unmount (imports and
            // provider awaits) - the destroyed flag above makes those paths
            // bail, and whatever exists now is torn down for real.
            destroyed = true
            viewerRef.current?.destroy?.()
            viewerRef.current = null
            droneRefs.current.clear()
        }
    }, [])

    // Rebuild static entities only when their CONTENT changes - the parent
    // recreates pads/selection objects on every poll, and tearing the scene
    // down every 3 s (with a terrain re-sample) is what made 3D crawl.
    const staticSig = useMemo(() => JSON.stringify({
        pads: pads.map(p => [p.name, p.kind, p.lat, p.lng]),
        sel: selection && {
            o: selection.order_no,
            pu: selection.pickup.name, dr: selection.dropoff.name,
            wp: selection.waypoints.map(w => [w.lat, w.lng, w.altitude]),
        },
        air: showAirspace, nz: zones.length,
    }), [pads, selection, showAirspace, zones])

    // ── Static entities: pads, route, airspace ───────────────────────────
    useEffect(() => {
        const viewer = viewerRef.current
        const Cesium = CesiumRef.current
        if (!ready || !viewer || !Cesium || viewer.isDestroyed?.()) return

        for (const e of [...viewer.entities.values]) {
            if (!e?.properties?.hyrakDrone) viewer.entities.remove(e)
        }

        for (const p of pads) {
            const hl = selection && p.name === selection.pickup.name ? '#4ade80'
                : selection && p.name === selection.dropoff.name ? '#f87171'
                    : p.kind === 'station' ? '#fbbf24' : '#06b6d4'
            viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
                point: {
                    pixelSize: p.kind === 'station' ? 11 : 9,
                    color: Cesium.Color.fromCssColorString(hl),
                    outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1.5,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
                label: {
                    text: p.name, font: '11px monospace',
                    fillColor: Cesium.Color.fromCssColorString(hl),
                    outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -16),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
            })
        }

        // Airspace volumes: each zone from its floor to its ceiling, in its
        // class colour. This is what "restricted" LOOKS like at altitude.
        if (showAirspace) {
            for (const z of zones) {
                const color = Cesium.Color.fromCssColorString(
                    ZONE_COLORS[z.properties.zone_class]).withAlpha(0.14)
                const outline = Cesium.Color.fromCssColorString(
                    ZONE_COLORS[z.properties.zone_class]).withAlpha(0.5)
                const rings = z.geometry.type === 'Polygon'
                    ? [z.geometry.coordinates as number[][][]]
                    : (z.geometry.coordinates as number[][][][])
                for (const poly of rings) {
                    const outer = poly[0]
                    if (!outer || outer.length < 4) continue
                    viewer.entities.add({
                        polygon: {
                            hierarchy: Cesium.Cartesian3.fromDegreesArray(
                                outer.flatMap(([lng, lat]) => [lng, lat])),
                            height: z.properties.floor_m || 0,
                            extrudedHeight: z.properties.ceiling_m ?? 120,
                            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                            extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                            material: color,
                            outline: true, outlineColor: outline,
                        },
                    })
                }
            }
        }

        // Route ribbon: sample terrain so "10 m relative" renders 10 m ABOVE
        // the ground here, not 530 m under it.
        if (selection && selection.waypoints.length >= 2) {
            const wps = selection.waypoints
            const myGen = ++routeGenRef.current
            const commit = (ground: number[]) => {
                if (routeGenRef.current !== myGen || viewer.isDestroyed?.()) return
                const positions = wps.map((w, i) =>
                    Cesium.Cartesian3.fromDegrees(
                        w.lng, w.lat, (ground[i] ?? 0) + w.altitude + 0.3))
                viewer.entities.add({
                    polyline: {
                        positions, width: 4,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            color: Cesium.Color.fromCssColorString('#22d3ee'),
                            glowPower: 0.25,
                        }),
                        depthFailMaterial: new Cesium.ColorMaterialProperty(
                            Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.55)),
                    },
                })
                viewer.entities.add({
                    wall: {
                        positions,
                        minimumHeights: ground.map(g => (g ?? 0) + 0.2),
                        material: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.10),
                    },
                })
                const ends: [typeof wps[0], string, string][] = [
                    [wps[0], '#4ade80', 'TAKEOFF'],
                    [wps[wps.length - 1], '#f87171', 'LAND'],
                ]
                for (const [w, color, text] of ends) {
                    viewer.entities.add({
                        position: Cesium.Cartesian3.fromDegrees(w.lng, w.lat),
                        point: {
                            pixelSize: 11, color: Cesium.Color.fromCssColorString(color),
                            outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
                            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                            disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        },
                        label: {
                            text, font: '10px monospace',
                            fillColor: Cesium.Color.fromCssColorString(color),
                            outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            pixelOffset: new Cesium.Cartesian2(0, 14),
                            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                            disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        },
                    })
                }
            }
            const cacheKey = wps.map(w => `${w.lat},${w.lng}`).join(';')
            const cached = terrainCache.get(cacheKey)
            if (cached) {
                commit(cached)
            } else {
                const cartographics = wps.map(w => Cesium.Cartographic.fromDegrees(w.lng, w.lat))
                Cesium.sampleTerrainMostDetailed(viewer.scene.terrainProvider, cartographics)
                    .then((sampled: any[]) => {
                        const ground = sampled.map((c: any) => c.height ?? 0)
                        terrainCache.set(cacheKey, ground)
                        commit(ground)
                    })
                    .catch(() => commit(wps.map(() => 0)))
            }
        }

        const key = selection?.order_no ?? (pads.length ? 'pads' : '')
        if (key && key !== flownRef.current) {
            flownRef.current = key
            const pts = selection
                ? selection.waypoints.map(w => Cesium.Cartesian3.fromDegrees(w.lng, w.lat))
                : pads.map(p => Cesium.Cartesian3.fromDegrees(p.lng, p.lat))
            if (pts.length) {
                const sphere = Cesium.BoundingSphere.fromPoints(pts)
                viewer.camera.flyToBoundingSphere(sphere, {
                    duration: 1.2,
                    offset: new Cesium.HeadingPitchRange(
                        0, Cesium.Math.toRadians(-40), sphere.radius * 3.0 + 350),
                })
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staticSig, ready, terrainGen])

    // ── Drones - persistent, interpolated, ON the terrain ────────────────
    useEffect(() => {
        const viewer = viewerRef.current
        const Cesium = CesiumRef.current
        if (!ready || !viewer || !Cesium || viewer.isDestroyed?.()) return

        const refs = droneRefs.current
        const seen = new Set<string>()

        for (const d of drones) {
            seen.add(d.id)
            // RELATIVE_TO_GROUND turns the telemetry's relative altitude
            // into "metres above the terrain at this exact spot".
            const target = { lat: d.lat, lng: d.lng, alt: Math.max(0.5, d.alt ?? 0) }
            const existing = refs.get(d.id)
            if (!existing) {
                const ref = { entity: null as any, from: target, to: target, t0: performance.now() }
                const position = new Cesium.CallbackProperty(() => {
                    const k = Math.min(1, (performance.now() - ref.t0) / LERP_MS)
                    const lat = ref.from.lat + (ref.to.lat - ref.from.lat) * k
                    const lng = ref.from.lng + (ref.to.lng - ref.from.lng) * k
                    const alt = ref.from.alt + (ref.to.alt - ref.from.alt) * k
                    return Cesium.Cartesian3.fromDegrees(lng, lat, alt)
                }, false)
                ref.entity = viewer.entities.add({
                    position,
                    properties: { hyrakDrone: true },
                    point: {
                        pixelSize: 10,
                        color: Cesium.Color.fromCssColorString(d.in_air ? '#fbbf24' : '#34d399'),
                        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
                        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    },
                    label: {
                        text: `${d.name} ${Math.round(d.battery)}%`, font: '10px monospace',
                        fillColor: Cesium.Color.fromCssColorString('#e4e4e7'),
                        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -16),
                        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    },
                })
                refs.set(d.id, ref)
            } else {
                const k = Math.min(1, (performance.now() - existing.t0) / LERP_MS)
                existing.from = {
                    lat: existing.from.lat + (existing.to.lat - existing.from.lat) * k,
                    lng: existing.from.lng + (existing.to.lng - existing.from.lng) * k,
                    alt: existing.from.alt + (existing.to.alt - existing.from.alt) * k,
                }
                existing.to = target
                existing.t0 = performance.now()
                existing.entity.label.text = new Cesium.ConstantProperty(
                    `${d.name} ${Math.round(d.battery)}%`)
                existing.entity.point.color = new Cesium.ConstantProperty(
                    Cesium.Color.fromCssColorString(d.in_air ? '#fbbf24' : '#34d399'))
            }
        }
        for (const [id, ref] of refs) {
            if (!seen.has(id)) {
                viewer.entities.remove(ref.entity)
                refs.delete(id)
            }
        }
    }, [drones, ready])

    return <div ref={containerRef} className="h-full w-full" />
}

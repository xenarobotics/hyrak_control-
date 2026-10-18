'use client'

import { useEffect, useMemo } from 'react'
import { hasRole } from '@/lib/auth'
import { useDroneStore } from '@/store/drone'
import { useLiveScope } from '@/hooks/useLiveScope'
import { useClientValueOn } from '@/hooks/useClientValue'
import {
    CAMERA_PREF_EVENT, DEFAULT_CAMERA, ensureMapSightingsFeed, firstUseSeen, markFirstUseSeen,
    readCameraPref, useMapSightingsStore, type CameraPref,
} from '@/lib/mapSightings'

// Modes whose output is not things on the ground (backend extract.SKIP_MODES).
const NO_MAP_MODES = new Set(['manual-control', 'depth-mapping', 'enhance', '3d-reconstruction', 'obstacle-avoidance'])

/** The live session's detections and the controls' state, for every map
 *  and the AI panel. */
export function useLiveSightings() {
    useEffect(() => { ensureMapSightingsFeed() }, [])
    const st = useMapSightingsStore()
    const mode = useDroneStore(s => s.mode)
    const { customer, perms } = useLiveScope()
    const modelRunning = !NO_MAP_MODES.has(mode)
    const list = useMemo(() => Object.values(st.sightings), [st.sightings])
    // Default ON while a model runs (or once anything is placed); the
    // operator's own choice wins once made.
    const show = st.show ?? (modelRunning || list.length > 0)
    // Writing history needs `fly` (customers) or the operator role (staff):
    // viewers see but cannot record or clear.
    const mayEdit = customer ? perms.includes('fly') : hasRole('operator')
    return { ...st, list, show, modelRunning, mayEdit }
}

/** The device's camera setting, live across components. */
export function useCameraPref(): CameraPref {
    return useClientValueOn(CAMERA_PREF_EVENT, readCameraPref, DEFAULT_CAMERA)
}

const FIRST_USE_EVENT = 'hyrak-map-first-use'

/** The one-line explanation shows until dismissed once, anywhere. */
export function useFirstUse(): [boolean, () => void] {
    const seen = useClientValueOn(FIRST_USE_EVENT, firstUseSeen, true)
    const dismiss = () => { markFirstUseSeen(); window.dispatchEvent(new Event(FIRST_USE_EVENT)) }
    return [!seen, dismiss]
}

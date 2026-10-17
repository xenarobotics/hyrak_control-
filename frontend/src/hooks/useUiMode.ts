'use client'

import { useSyncExternalStore } from 'react'
import { getUiMode, setUiMode, UI_MODE_EVENT, type UiMode } from '@/lib/uiPrefs'

function subscribe(onChange: () => void) {
    window.addEventListener(UI_MODE_EVENT, onChange)
    return () => window.removeEventListener(UI_MODE_EVENT, onChange)
}
const serverSnapshot = (): UiMode | null => null

/** The interface mode, live across components. null until hydrated (the
 *  server render cannot read localStorage), so callers render nothing
 *  mode-specific on the first pass instead of flashing the wrong UI. */
export function useUiMode(): [UiMode | null, (m: UiMode) => void] {
    const mode = useSyncExternalStore(subscribe, getUiMode, serverSnapshot)
    return [mode, setUiMode]
}

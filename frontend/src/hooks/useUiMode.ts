'use client'

import { useEffect, useState } from 'react'
import { getUiMode, setUiMode, UI_MODE_EVENT, type UiMode } from '@/lib/uiPrefs'

/** The interface mode, live across components. null until mounted (the
 *  server render cannot read localStorage), so callers render nothing
 *  mode-specific on the first pass instead of flashing the wrong UI. */
export function useUiMode(): [UiMode | null, (m: UiMode) => void] {
    const [mode, setMode] = useState<UiMode | null>(null)
    useEffect(() => {
        setMode(getUiMode())
        const on = (e: Event) => setMode((e as CustomEvent<UiMode>).detail)
        window.addEventListener(UI_MODE_EVENT, on)
        return () => window.removeEventListener(UI_MODE_EVENT, on)
    }, [])
    return [mode, setUiMode]
}

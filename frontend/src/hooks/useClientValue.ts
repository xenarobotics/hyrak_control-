'use client'

// Values that only exist in the browser, read without a hydration mismatch.
//
// The old pattern was `useState(fallback)` plus an effect that set the real
// value after mount. It works, but it is a render cascade by construction
// (every mount renders twice) and the React compiler rejects it. React's own
// answer is useSyncExternalStore: the server snapshot is used during the
// server render AND the hydrating client render, so the HTML matches, and the
// client snapshot takes over on the first post-hydration render - one render,
// no effect, no flash.

import { useCallback, useSyncExternalStore } from 'react'

const noSubscribe = () => () => {}

/** True once hydrated, false on the server and during hydration - the
 *  replacement for a `mounted` flag. */
export function useHydrated(): boolean {
    return useSyncExternalStore(noSubscribe, () => true, () => false)
}

/** A browser-only value (localStorage, navigator, ...). `read` runs on every
 *  render, so it must be cheap and return a primitive or a stable reference
 *  while nothing changed. It is not re-read on its own: pair it with local
 *  state for a value this component also changes, or use useClientValueOn
 *  when a window event announces changes. */
export function useClientValue<T>(read: () => T, serverValue: T): T {
    return useSyncExternalStore(noSubscribe, read, () => serverValue)
}

/** Same, re-read whenever `eventName` fires on window (the settings toggles
 *  dispatch one after writing localStorage). */
export function useClientValueOn<T>(eventName: string, read: () => T, serverValue: T): T {
    const subscribe = useCallback((onChange: () => void) => {
        window.addEventListener(eventName, onChange)
        return () => window.removeEventListener(eventName, onChange)
    }, [eventName])
    return useSyncExternalStore(subscribe, read, () => serverValue)
}

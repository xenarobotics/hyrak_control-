'use client'

import { useEffect } from 'react'

// Keep the screen awake while `active` is true.
//
// Why this exists: a slow, careful scan means the operator is walking without
// touching the screen. On an iPad (and Android) the display auto-locks after
// its idle timeout, and iOS stops the camera the instant the screen dims - so
// the WebRTC feed dies mid-scan and the reconstruction freezes with no error.
// This was showing up as scans stopping at ~75 s. The Screen Wake Lock API
// holds the display on for exactly as long as the capture runs.
//
// The lock is auto-released by the OS whenever the page is hidden (tab switch,
// app backgrounded), so it must be re-acquired on visibilitychange. Absent in
// some browsers/insecure contexts - degrades to a no-op, never throws.
export function useScreenWakeLock(active: boolean): void {
    useEffect(() => {
        if (!active) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nav = navigator as any
        if (!nav.wakeLock?.request) return   // unsupported - nothing to do

        let sentinel: { release: () => Promise<void>; released?: boolean } | null = null
        let cancelled = false

        const acquire = async () => {
            try {
                const s = await nav.wakeLock.request('screen')
                if (cancelled) { s.release?.(); return }
                sentinel = s
            } catch {
                // User denied, low battery, or unsupported - the scan still
                // works, the operator just needs to keep the screen awake.
            }
        }

        const onVisible = () => {
            // The OS drops the lock when the page hides; re-take it on return.
            if (document.visibilityState === 'visible') void acquire()
        }

        void acquire()
        document.addEventListener('visibilitychange', onVisible)

        return () => {
            cancelled = true
            document.removeEventListener('visibilitychange', onVisible)
            try { void sentinel?.release() } catch { /* already gone */ }
        }
    }, [active])
}

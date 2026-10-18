/**
 * Media from routes that need the bearer, for elements that cannot send it.
 *
 *  - useApiObjectUrl: a one-shot image (plate crop): fetched with the token
 *    into a blob, shown through an object URL that is revoked when the path
 *    changes or the component unmounts.
 *  - useTicketedStream: a long-lived MJPEG stream in an <img>: a 60 s URL
 *    ticket (POST /api/auth/url-ticket). Pass `onError` to the <img>; a
 *    dropped stream asks for a fresh ticket and reconnects.
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, ticketedUrl } from '@/lib/api'

export function useApiObjectUrl(path: string | null): string | null {
    const [shown, setShown] = useState<{ path: string; url: string } | null>(null)
    useEffect(() => {
        if (!path) return
        let alive = true
        let url: string | null = null
        void (async () => {
            try {
                const res = await apiFetch(path)
                if (!res.ok || !alive) return
                const blob = await res.blob()
                if (!alive) return
                url = URL.createObjectURL(blob)
                setShown({ path, url })
            } catch { /* backend away: the placeholder stays */ }
        })()
        return () => {
            alive = false
            if (url) URL.revokeObjectURL(url)
        }
    }, [path])
    return shown && shown.path === path ? shown.url : null
}

/** Reconnect delay after a stream error, growing to a cap so a dead engine
 *  is not asked for a ticket every second. */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 15_000

export function useTicketedStream(path: string | null): { src: string | null; onError: () => void; onLoad: () => void } {
    const [shown, setShown] = useState<{ path: string; url: string } | null>(null)
    // Bumped on every stream error; each bump fetches a new ticket.
    const [attempt, setAttempt] = useState(0)
    // Consecutive failures since the last frame, for the backoff only.
    const failures = useRef(0)
    useEffect(() => {
        if (!path) return
        let alive = true
        const n = failures.current
        const delay = n === 0 ? 0 : Math.min(RETRY_MIN_MS * 2 ** (n - 1), RETRY_MAX_MS)
        const retry = () => { failures.current += 1; setAttempt(a => a + 1) }
        const timer = setTimeout(() => {
            void ticketedUrl(path).then(url => {
                if (!alive) return
                if (url) setShown({ path, url })
                else retry()              // refused or unreachable: try again later
            }).catch(() => { if (alive) retry() })
        }, delay)
        return () => { alive = false; clearTimeout(timer) }
    }, [path, attempt])
    const onError = useCallback(() => { failures.current += 1; setAttempt(a => a + 1) }, [])
    // A frame arrived: the next drop reconnects without waiting.
    const onLoad = useCallback(() => { failures.current = 0 }, [])
    return { src: shown && shown.path === path ? shown.url : null, onError, onLoad }
}

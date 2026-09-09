// A setInterval that pauses while the tab is hidden.
//
// The dispatch board and the vision panels poll the backend every few
// seconds. Left running in a background tab they keep hitting the cloud
// server for a view nobody is looking at - wasted bandwidth on the VPS link
// and battery on the operator's iPad. visibleInterval skips ticks while
// document.hidden, and fires once the moment the tab is shown again so the
// view is fresh on return instead of stale for up to one interval.
//
// Returns a cleanup that clears the interval and the visibility listener.
export function visibleInterval(fn: () => void, ms: number): () => void {
    const hidden = () =>
        typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const id = setInterval(() => {
        if (!hidden()) fn()
    }, ms)

    const onVisible = () => {
        if (!hidden()) fn()
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
        clearInterval(id)
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisible)
        }
    }
}

'use client'

// WHAT THE STATUS BAR'S RTL DOES ON THE MISSION TAB.
//
// The Mission tab's RTL has always flown to the plan's RTL point (set in the
// waypoint panel, the takeoff point by default) with goto_custom_rtl, and
// asked "Land now?" once the drone was over it. The status bar that is on
// every page sends PX4's own Return instead, which flies to home and lands
// without asking. With both on the Mission tab, the bar's button (the one
// the eye finds) quietly replaced the plan's RTL. While the Mission tab is
// mounted it registers its own RTL here and the bar runs that; everywhere
// else the bar keeps PX4's Return, as the Command rail always did.

type RtlHandler = () => void

let handler: RtlHandler | null = null

/** Register the page's RTL; returns the unregister function. */
export function registerRtlOverride(fn: RtlHandler): () => void {
    handler = fn
    return () => { if (handler === fn) handler = null }
}

export function getRtlOverride(): RtlHandler | null {
    return handler
}

// Feature-detection + typed wrapper around window.hyrakNative, which only
// exists when this page is loaded inside the HYRAK desktop app (see
// desktop/src/preload.ts) instead of a plain browser tab. Its presence is
// the single signal the rest of the frontend checks before preferring a
// native bridge (raw UDP/TCP/serial/RTSP) over the browser-only fallback
// (an externally-run relay script, or "unsupported" for RTSP). The UI
// itself never branches on this - only the low-level data-source code does
// (see localSwarmRelay.ts for the first wired example).
//
// This is also the single place window.hyrakNative's shape is declared -
// nativeUpdater.ts reuses isDesktopApp() from here rather than redeclaring
// the global, to avoid two conflicting `declare global` blocks.

export interface BridgeEvent {
    bridge: string
    id: string
    type: string
    data?: Uint8Array
    meta?: Record<string, unknown>
}

export interface UpdaterEvent {
    type: 'checking' | 'available' | 'not-available' | 'download-progress' | 'downloaded' | 'error'
    version?: string
    percent?: number
    // Mirrors desktop/src/updater.ts - bytes and rate travel with percent so a
    // slow or Content-Length-less download can still be shown as moving.
    transferred?: number
    total?: number
    bytesPerSecond?: number
    message?: string
}

interface HyrakNativeBridgeApi {
    start: (kind: string, id: string, config: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }>
    stop: (kind: string, id: string) => Promise<void>
    send: (kind: string, id: string, data: Uint8Array, meta?: Record<string, unknown>) => void
    list: (kind: string) => Promise<unknown[]>
    onEvent: (cb: (event: BridgeEvent) => void) => () => void
    // Only implemented by desktop builds carrying the webrtc-sender bridge;
    // optional so an older shell degrades to "unavailable" rather than throwing.
    acceptWebrtcAnswer?: (id: string, sdp: string) => Promise<{ ok: boolean; error?: string }>
    // Reachability pre-check; optional so an older shell degrades gracefully.
    probeNetwork?: (targets: unknown[]) => Promise<unknown>
}

interface HyrakNativeUpdaterApi {
    appVersion: () => Promise<string>
    checkNow: () => Promise<void>
    authorizeDownload: () => Promise<void>
    install: () => Promise<void>
    onEvent: (cb: (event: UpdaterEvent) => void) => () => void
}

interface HyrakNative {
    isElectron: true
    bridge: HyrakNativeBridgeApi
    updater: HyrakNativeUpdaterApi
}

declare global {
    interface Window {
        hyrakNative?: HyrakNative
    }
}

export function isDesktopApp(): boolean {
    return typeof window !== 'undefined' && !!window.hyrakNative?.isElectron
}

export function nativeBridge(): HyrakNativeBridgeApi | null {
    return typeof window !== 'undefined' && window.hyrakNative ? window.hyrakNative.bridge : null
}

export function nativeUpdater(): HyrakNativeUpdaterApi | null {
    return typeof window !== 'undefined' && window.hyrakNative ? window.hyrakNative.updater : null
}

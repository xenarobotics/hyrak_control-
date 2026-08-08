// Common shape every native bridge implements. main.ts wires IPC handlers
// GENERICALLY over whatever's registered in registry.ts — adding a new
// protocol later (another video codec, HID, GStreamer pipelines, whatever
// comes up next) means one new file here implementing this interface plus
// one line in registry.ts. Nothing in main.ts, preload.ts, or the renderer
// API shape needs to change.

export interface BridgeEvent {
    bridge: string                    // e.g. 'udp', 'tcp', 'serial', 'rtsp'
    id: string                        // caller-assigned handle for this connection
    type: string                      // bridge-specific: 'data' | 'status' | 'error' | 'frame' | ...
    data?: Uint8Array
    meta?: Record<string, unknown>
}

export type EmitFn = (event: BridgeEvent) => void

export interface NativeBridge {
    readonly kind: string
    // `meta` lets a bridge return values the caller needs IMMEDIATELY —
    // anything the caller would otherwise have to catch from an event it may
    // not have subscribed to yet. Bridges emit their opening status event
    // before start() resolves, so a caller that subscribes afterwards misses
    // it and waits forever for something that already happened.
    start(id: string, config: Record<string, unknown>, emit: EmitFn): Promise<{ ok: boolean; error?: string; meta?: Record<string, unknown> }>
    stop(id: string): Promise<void>
    send(id: string, data: Uint8Array, meta?: Record<string, unknown>): void
    list?(): Promise<unknown[]>
}

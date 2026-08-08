import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BridgeEvent } from './bridges/types'
import type { UpdaterEvent } from './updater'

// Exposed to the loaded website as window.hyrakNative. Its mere presence IS
// the feature-detection signal the frontend uses to prefer a native bridge
// over the browser-only fallback (a locally-run relay script, or "not
// supported" for RTSP) — see frontend/src/lib/nativeBridge.ts.
//
// The bridge surface is deliberately generic (kind + id + config) rather
// than one method per protocol, so it never needs to change when
// bridges/registry.ts grows a new bridge — only the `kind` string passed
// in varies.
contextBridge.exposeInMainWorld('hyrakNative', {
    isElectron: true,

    bridge: {
        start: (kind: string, id: string, config: Record<string, unknown>) =>
            ipcRenderer.invoke('hyrak-bridge-start', kind, id, config),
        stop: (kind: string, id: string) =>
            ipcRenderer.invoke('hyrak-bridge-stop', kind, id),
        send: (kind: string, id: string, data: Uint8Array, meta?: Record<string, unknown>) =>
            ipcRenderer.send('hyrak-bridge-send', kind, id, data, meta),
        list: (kind: string) =>
            ipcRenderer.invoke('hyrak-bridge-list', kind),
        onEvent: (cb: (event: BridgeEvent) => void) => {
            const listener = (_evt: IpcRendererEvent, event: BridgeEvent) => cb(event)
            ipcRenderer.on('hyrak-bridge-event', listener)
            return () => ipcRenderer.removeListener('hyrak-bridge-event', listener)
        },
        // Hands the backend's SDP answer to the webrtc-sender bridge. Separate
        // from send() because it must be awaited and must report failure — see
        // the handler in app-main.ts.
        acceptWebrtcAnswer: (id: string, sdp: string) =>
            ipcRenderer.invoke('hyrak-webrtc-sender-answer', id, sdp) as
                Promise<{ ok: boolean; error?: string }>,
        // Reachability pre-check for the drone hardware — see netProbe.ts.
        probeNetwork: (targets: unknown[]) =>
            ipcRenderer.invoke('hyrak-net-probe', targets),
    },

    // Consent-gated: checkNow()/the automatic launch check only ever
    // report availability. Nothing downloads until authorizeDownload() is
    // called, and nothing restarts/installs until install() is — both are
    // meant to be wired to an explicit user action (see
    // frontend/src/components/updater/UpdatePrompt.tsx).
    updater: {
        appVersion: () => ipcRenderer.invoke('hyrak-app-version') as Promise<string>,
        checkNow: () => ipcRenderer.invoke('hyrak-updater-check'),
        authorizeDownload: () => ipcRenderer.invoke('hyrak-updater-authorize-download'),
        install: () => ipcRenderer.invoke('hyrak-updater-install'),
        onEvent: (cb: (event: UpdaterEvent) => void) => {
            const listener = (_evt: IpcRendererEvent, event: UpdaterEvent) => cb(event)
            ipcRenderer.on('hyrak-updater-event', listener)
            return () => ipcRenderer.removeListener('hyrak-updater-event', listener)
        },
    },
})

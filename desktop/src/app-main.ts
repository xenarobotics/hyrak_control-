import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import path from 'node:path'
import { bridges } from './bridges/registry'
import type { BridgeEvent } from './bridges/types'
import { registerUpdater, checkForUpdatesOnLaunch, setInstallTeardown } from './updater'
import { killAllTracked, reapOrphans, reapOutdatedInstances, reapStaleInstances, trackedCount } from './bridges/processGuard'
import { probeNetwork, type ProbeTarget } from './netProbe'
import ffmpegStaticPath from 'ffmpeg-static'

// Linux's sandbox situation is handled one level up, in main.ts, by
// re-execing with ELECTRON_DISABLE_SANDBOX set BEFORE this file (or
// `electron` itself) is ever loaded — doing it here was tried first and
// doesn't work: Electron's native bootstrap reads that decision before any
// of this app's JS runs, so a JS-level fix (even app.commandLine.
// appendSwitch placed at the very top of this file) is already too late.
// See main.ts for the full explanation.

// Expose the platform's HEVC decoder to WebCodecs where the OS genuinely has
// one. Windows and macOS need only this; on Linux it is a no-op in practice.
//
// This line used to also enable `VaapiVideoDecoder,VaapiVideoDecodeLinuxGL`
// with `--ignore-gpu-blocklist`, on the reasoning that Chromium disables
// Linux hardware video decode by default and turning it on must be an
// improvement. It was not. MEASURED on the reference laptop by feeding 180
// real access units from the ground decoder to a VideoDecoder:
//
//   flags                                    frames decoded
//   (none)                                   180 / 180
//   PlatformHEVCDecoderSupport               180 / 180
//   + VaapiVideoDecoder(+LinuxGL)            1 / 180, then "Decoding error"
//   + VaapiVideoDecoder + ignore-blocklist    2 / 180, then "Decoding error"
//
// So enabling VA-API in Chromium BROKE H.264 decoding outright on this
// machine, and the black picture that produced was mine, not the codec's.
//
// The cause is the one ADR-005 already documents one layer down: this laptop's
// first DRM render node is a firmware-disabled NVIDIA that cannot service
// VA-API at all, and both ffmpeg and Chromium reach for it first. ADR-005's
// conclusion applies unchanged here — never force a hardware path on the
// strength of it being *available*, and always leave a way down. Chromium's
// own default (software unless it is confident) is that policy already
// implemented, and `--ignore-gpu-blocklist` exists precisely to defeat it.
//
// Hardware decode is not abandoned: it is reached where it actually works,
// through Chromium's own judgement, and WebCodecsVideo retries in software if
// a decoder that claimed to work then fails.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

// The one thing that differs between environments. Everything else about
// this app — native bridges, the updater, window chrome — is fixed and
// ships the same regardless of which HYRAK deployment it points at.
const SITE_URL = process.env.HYRAK_SITE_URL || 'https://dev.xenarobotics.com'

// The landing page (frontend/src/app/page.tsx) exists to let a BROWSER
// visitor choose between "continue in browser" and "download the app" —
// that choice is already made by the time anyone's running this, so skip
// straight to Fly instead of showing them the same choice again.
const START_URL = `${SITE_URL}/fly`

let mainWindow: BrowserWindow | null = null

function emitToRenderer(webContents: WebContents) {
    return (event: BridgeEvent) => {
        if (!webContents.isDestroyed()) {
            webContents.send('hyrak-bridge-event', event)
        }
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        title: 'HYRAK',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })
    // Always load the site fresh, never from Electron's on-disk HTTP cache.
    //
    // This app is a shell around a CONTINUOUSLY DEPLOYED website — the whole
    // point of loading SITE_URL live is that the content layer updates
    // without shipping a new build. Chromium's cache actively fights that:
    // it persists across quit/relaunch (it lives in the user-data dir, not
    // memory), so a stale JS chunk survives restarting the app and the user
    // sees an old UI with no way to tell it's old. That cost us two
    // debugging rounds — a Settings page that kept rendering a previous
    // version while the very same URL in a browser showed the current one.
    //
    // The saving was never worth much: this is a small Next.js bundle over
    // a local tunnel, re-fetched once per launch.
    mainWindow.webContents.session.clearCache().catch(() => { /* non-fatal */ })
    mainWindow.loadURL(START_URL, { extraHeaders: 'pragma: no-cache\n' })

    // Ctrl/Cmd+Shift+R — reload ignoring cache, for when the page updates
    // mid-session (the dev server hot-reloads far more often than this app
    // relaunches). Plain Ctrl+R stays as Electron's normal reload.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        const mod = process.platform === 'darwin' ? input.meta : input.control
        if (mod && input.shift && input.key.toLowerCase() === 'r') {
            mainWindow?.webContents.reloadIgnoringCache()
            event.preventDefault()
            return
        }
        // DevTools, bound explicitly. This previously relied on Electron's
        // DEFAULT application menu supplying the accelerator, which is not
        // dependable — on this Linux build it did not reach the operator at
        // all, and "open DevTools" is the instruction that unblocks nearly
        // every video diagnosis. F12 as well as Ctrl/Cmd+Shift+I, because the
        // one you remember is the one that should work.
        const wantsDevTools = input.key === 'F12'
            || (mod && input.shift && input.key.toLowerCase() === 'i')
        if (wantsDevTools) {
            mainWindow?.webContents.toggleDevTools()
            event.preventDefault()
        }
    })

    mainWindow.on('closed', () => { mainWindow = null })
}

// ---- Generic IPC surface over whatever's registered in bridges/registry.ts
// The renderer (the loaded website) never touches dgram/net/serialport/
// ffmpeg directly — only through this. A new bridge kind needs ZERO new
// IPC wiring here; it's already reachable the moment it's added to the
// registry, since every handler below is written generically over `kind`.

ipcMain.handle(
    'hyrak-bridge-start',
    async (evt, kind: string, id: string, config: Record<string, unknown>) => {
        const bridge = bridges[kind]
        if (!bridge) return { ok: false, error: `unknown bridge: ${kind}` }
        return bridge.start(id, config, emitToRenderer(evt.sender))
    },
)

ipcMain.handle('hyrak-bridge-stop', async (_evt, kind: string, id: string) => {
    await bridges[kind]?.stop(id)
})

ipcMain.on(
    'hyrak-bridge-send',
    (_evt, kind: string, id: string, data: Uint8Array, meta?: Record<string, unknown>) => {
        bridges[kind]?.send(id, data, meta)
    },
)

ipcMain.handle('hyrak-bridge-list', async (_evt, kind: string) => {
    return (await bridges[kind]?.list?.()) ?? []
})

// The one non-generic handler, and it earns the exception.
//
// The WebRTC sender bridge negotiates a PeerConnection: it produces an offer
// from start(), and must then be handed the server's answer. That cannot go
// through `hyrak-bridge-send`, which is fire-and-forget (ipcMain.on, no reply) —
// a failed answer must report WHY, since the overwhelmingly likely cause is a
// codec/fmtp mismatch that is otherwise invisible.
//
// Signalling stays in the renderer deliberately: it already owns the
// authenticated socket.io connection and the session identity. This handler is
// only the conduit for one SDP string in the reverse direction.
ipcMain.handle(
    'hyrak-webrtc-sender-answer',
    async (_evt, id: string, sdp: string) => {
        const bridge = bridges['webrtc-sender'] as
            { acceptAnswer?: (id: string, sdp: string) => Promise<{ ok: boolean; error?: string }> }
        if (!bridge?.acceptAnswer) {
            return { ok: false, error: 'webrtc-sender bridge unavailable' }
        }
        return bridge.acceptAnswer(id, sdp)
    },
)

// Reachability pre-check. Only the main process can open a raw TCP/UDP socket,
// so the renderer cannot answer "is the camera reachable?" on its own — and that
// question is the one that would have short-circuited most of a debugging
// session. See netProbe.ts.
ipcMain.handle('hyrak-net-probe', async (_evt, targets: ProbeTarget[]) => {
    try {
        return await probeNetwork(targets ?? [])
    } catch (err) {
        return { addresses: [], results: [], error: (err as Error).message }
    }
})

// ONE instance by default; HYRAK_MULTI=1 restores side-by-side.
//
// The multi-instance policy has flip-flopped, each time on real evidence, so
// the history matters. 0.1.16 added a lock after four concurrent instances
// left nine orphaned ffmpeg processes; that was the orphan leak's fault (fixed
// in processGuard.ts) and the lock was removed to allow comparing two builds
// side by side. Then the field case arrived: a client reinstalls, the OLD
// version keeps running with a perfectly healthy mount, silently holds
// udp:5600, and the new version's video is dead with nothing a non-technical
// user can act on — "close the window and try again" doesn't help when the
// leftover has no window.
//
// So: outdated instances are killed at startup (reapOutdatedInstances — the
// dying process releases Electron's lock), then the single-instance lock
// arbitrates among same-version copies: the second launch hands over to the
// first, which raises its window. Developers comparing builds set
// HYRAK_MULTI=1, which skips both — the exclusive-hardware hazards (serial
// port, udp:5600) are then theirs to manage, as before.

const allowMulti = process.env.HYRAK_MULTI === '1'

if (!allowMulti) {
    // Before the lock, not after: if the lock holder is an OLDER version, we
    // must kill it first — deferring to it would leave the user running the
    // version they just replaced.
    const outdated = reapOutdatedInstances(app.getVersion())
    if (outdated.length) {
        console.warn(`killed ${outdated.length} outdated HYRAK instance(s): ${outdated.join(', ')}`)
    }
    if (!app.requestSingleInstanceLock()) {
        // A same-or-newer instance is already running; it gets the
        // 'second-instance' event and raises its window.
        app.quit()
    }
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
        }
    })
}

app.whenReady().then(() => {
    // Before anything else: clean up after a previous run that died without
    // getting to run its own teardown (crash, SIGKILL, `pkill`). Those
    // orphans are not harmless — nine of them once held ~1100% CPU and the
    // resulting starvation looked exactly like a network latency problem.
    // Scoped to OUR bundled ffmpeg with a dead/foreign parent, so a sibling
    // instance's children and any user-started ffmpeg are untouched.
    const reaped = reapOrphans((ffmpegStaticPath || '').replace('app.asar', 'app.asar.unpacked'))
    if (reaped.length) {
        console.warn(`reaped ${reaped.length} orphaned ffmpeg process(es) from a previous run: ${reaped.join(', ')}`)
    }

    // Ghosts of superseded versions. An update that leaves the OLD main
    // process alive is not cosmetic: it keeps udp:5600 bound, so the newly
    // installed version cannot read the air unit at all — observed with a
    // 0.1.30 process still holding the port after 0.1.31 was installed. Only
    // instances whose AppImage mount has already been unmounted are touched, so
    // a legitimate second window of the CURRENT version is left running.
    const stale = reapStaleInstances()
    if (stale.length) {
        console.warn(`killed ${stale.length} stale HYRAK instance(s) from a superseded version: ${stale.join(', ')}`)
    }

    createWindow()

    // Consent-gated: checks silently on launch, but the actual download
    // and restart-to-install steps both wait for explicit authorization
    // from the renderer's update prompt — see updater.ts and
    // frontend/src/components/updater/UpdatePrompt.tsx.
    // Free udp:5600 (and every other bound port) before the replacement
    // instance launches and tries to bind the same ones.
    setInstallTeardown(() => teardownBridges(true))
    registerUpdater(() => mainWindow?.webContents ?? null)
    checkForUpdatesOnLaunch()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Nothing stopped the bridges on quit before this existed, so every launch
// stranded its ffmpeg processes. They do not die on their own: ffmpeg writes
// to a pipe whose read end Electron's helper processes have inherited, so the
// EPIPE that would normally kill it never arrives.
let tornDown = false
function teardownBridges(immediate: boolean): void {
    if (tornDown) return
    tornDown = true
    const n = trackedCount()
    // Only child processes need this. Loopback HTTP servers, UDP sockets and
    // serial handles are all reclaimed by the OS when this process exits —
    // spawned ffmpeg is the one thing that outlives us.
    killAllTracked(immediate)
    if (n) console.warn(`app quit: killed ${n} tracked child process(es)`)
}

app.on('before-quit', () => teardownBridges(false))

// Last resort. Runs synchronously and cannot await, so it goes straight to
// SIGKILL — a leaked transcode is far worse than an unclean ffmpeg exit.
process.on('exit', () => teardownBridges(true))
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { teardownBridges(true); process.exit(0) })
}

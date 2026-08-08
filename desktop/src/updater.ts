import { app, ipcMain, type WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'

// Consent-gated update flow: the native shell (this app itself) never
// downloads or installs anything without the user explicitly clicking
// "Update now" — checking happens automatically on launch, but the actual
// download and restart-to-install steps both need authorization.
//
// This only ever concerns the native shell (a fixed/new bridge, an
// Electron security patch) — the content layer (frontend/, most of what
// changes daily) needs no updater at all, since main.ts just loads it live
// from SITE_URL on every launch.

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

// THE reason downloads appeared to hang forever with no progress.
//
// electron-builder embeds a block map at the tail of the AppImage (hence
// `blockMapSize` in latest-linux.yml — there is no separate .blockmap file for
// this target), and electron-updater's differential downloader fetches just
// those trailing bytes with an HTTP Range request before downloading anything
// else. The backend serves /releases through Starlette's StaticFiles, which on
// the pinned version (0.38.6) does NOT honour Range — verified: a ranged
// request for the last 150 KB returns `HTTP 200` with `content-length:
// 143165795` and no `accept-ranges` header, i.e. the whole 143 MB file.
//
// So the updater sat there consuming a 143 MB body it believed was a small
// blockmap range, and `download-progress` does not fire during that phase —
// producing a progress bar frozen at 0% with no error, indefinitely.
//
// A plain full download needs no Range support and emits progress normally.
// Differential updates were never actually working here, so nothing is lost;
// revisit only if /releases gains real Range support.
autoUpdater.disableDifferentialDownload = true

// How long quitAndInstall() gets to end this process before we exit ourselves.
// Long enough for a genuine clean shutdown (bridges stopping, ffmpeg being
// SIGTERMed) and short enough that the relaunched instance is not still waiting
// on a port when the user is already looking at its window.
const QUIT_AND_INSTALL_GRACE_MS = 4000

// Set by app-main.ts. Lets the install path stop the bridges without updater.ts
// importing them — it has no business knowing what a bridge is, and a direct
// import would make this module drag the whole bridge registry into scope.
let teardownForInstall: () => void = () => { /* nothing registered */ }
export function setInstallTeardown(fn: () => void): void {
    teardownForInstall = fn
}

export interface UpdaterEvent {
    type: 'checking' | 'available' | 'not-available' | 'download-progress' | 'downloaded' | 'error'
    version?: string
    percent?: number
    // Bytes and rate alongside percent: on a slow link a percentage alone
    // can sit on the same integer for a long time and look frozen, and if
    // the server sends no Content-Length there is no percent to show at all
    // — transferred bytes still prove the download is moving.
    transferred?: number
    total?: number
    bytesPerSecond?: number
    message?: string
}

let rendererSink: ((event: UpdaterEvent) => void) | null = null

function emit(event: UpdaterEvent) {
    rendererSink?.(event)
}

autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version }))
autoUpdater.on('update-not-available', () => emit({ type: 'not-available' }))
autoUpdater.on('download-progress', (progress) => emit({
    type: 'download-progress',
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
}))
autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version }))
autoUpdater.on('error', (err) => emit({ type: 'error', message: err.message }))

export function registerUpdater(getWebContents: () => WebContents | null) {
    rendererSink = (event) => {
        const wc = getWebContents()
        if (wc && !wc.isDestroyed()) wc.send('hyrak-updater-event', event)
    }

    ipcMain.handle('hyrak-updater-check', async () => {
        try {
            await autoUpdater.checkForUpdates()
        } catch (err) {
            // No published feed yet (dev/unpublished build) — not a real
            // error from the user's point of view, just "nothing to check".
            emit({ type: 'error', message: (err as Error).message })
        }
    })

    ipcMain.handle('hyrak-updater-authorize-download', async () => {
        // electron-updater's Linux path only knows how to replace an AppImage
        // IN PLACE, which it locates via the APPIMAGE env var the AppImage
        // runtime sets. Running from release/linux-unpacked or a dev `electron
        // .` means that variable is absent and downloadUpdate() fails deep
        // inside the library with a message that doesn't explain why. Say it
        // plainly up front instead of letting the UI sit on a dead progress
        // bar.
        if (process.platform === 'linux' && !process.env.APPIMAGE) {
            emit({
                type: 'error',
                message: 'Self-update needs the packaged AppImage — this build is running unpacked. '
                    + 'Download the latest AppImage manually from the releases page.',
            })
            return
        }
        try {
            await autoUpdater.downloadUpdate()
        } catch (err) {
            emit({ type: 'error', message: (err as Error).message })
        }
    })

    ipcMain.handle('hyrak-updater-install', () => {
        // Kill our own bridges first. quitAndInstall() relaunches immediately,
        // and the new process binds the same ports (udp:5600 for the air unit) —
        // if this one's sockets are still open when that happens, the fresh
        // instance loses the race and starts up unable to read the video.
        teardownForInstall()
        autoUpdater.quitAndInstall()
        // quitAndInstall() is not guaranteed to end this process. On AppImage it
        // spawns the replacement and calls app.quit(), and app.quit() is
        // cancellable — a pending before-quit handler, a modal, or a renderer
        // that never acknowledges leaves the OLD main process running while the
        // NEW one starts. That is exactly how a 0.1.30 instance ended up holding
        // udp:5600 after 0.1.31 was installed, running from an AppImage mount
        // that had already been unmounted.
        //
        // reapStaleInstances() cleans that up at the next launch, but the next
        // launch is precisely the run that needs the port. So also guarantee it
        // here: if we are still alive after the grace period, leave
        // unconditionally. There is nothing left worth saving at this point —
        // the replacement is already starting.
        const bail = setTimeout(() => {
            console.warn('quitAndInstall did not end this process — exiting to free the ports')
            app.exit(0)
        }, QUIT_AND_INSTALL_GRACE_MS)
        bail.unref?.()
    })

    ipcMain.handle('hyrak-app-version', () => app.getVersion())
}

export function checkForUpdatesOnLaunch() {
    autoUpdater.checkForUpdates().catch(() => { /* no published feed yet in dev — harmless */ })
}

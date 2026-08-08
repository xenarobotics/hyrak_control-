// Bootstrap only — deliberately does NOT `import` anything from `electron`
// (or anything that transitively does, like `electron-updater`), because
// requiring that module is itself enough to trigger Electron's native
// startup sequence, and that's exactly what needs to be intercepted here.
//
// Chromium's Linux sandbox needs its helper binary owned by root with the
// SUID bit set (chmod 4755) — impossible for an AppImage, which
// self-extracts into a fresh temp dir on EVERY launch, so those
// permissions can never persist there. Without a fix, the app aborts on
// launch with "SUID sandbox helper binary ... not configured correctly."
// This is a structural AppImage/Chromium conflict, not something fixable
// by changing how the app itself is built, and it hits every Electron app
// distributed as an AppImage (verified against a real packaged build).
//
// The fix is the ELECTRON_DISABLE_SANDBOX environment variable — but it
// has to be set in the process environment BEFORE Electron's native layer
// initializes, which happens as soon as `electron` is required, well
// before any app code (even the very first line of a "real" main.ts) gets
// a chance to run. Setting it from within the app's own JS — via
// `process.env.ELECTRON_DISABLE_SANDBOX = '1'` or
// `app.commandLine.appendSwitch('no-sandbox')`, both tried first — does
// NOT work, confirmed against a real packaged AppImage: the crash still
// happened. What DOES reliably work (also confirmed against the same
// build) is the env var being set before the process even starts. So:
// re-exec this exact binary once, with that env var set correctly for the
// new process, before `electron` is loaded at all.
//
// Windows/macOS don't use this sandboxing mechanism, so they skip this
// entirely and go straight to the real app.
//
// Renderer isolation itself is unrelated and stays fully on regardless
// (contextIsolation + nodeIntegration:false in app-main.ts) — the
// renderer still can't touch Node/require/fs directly even without
// Chromium's OS-level sandbox layer on top. Since this window only ever
// loads HYRAK's own first-party site rather than arbitrary third-party
// pages, that's a reasonable, industry-standard tradeoff — the same one
// VS Code, Discord, Slack and most other AppImage-distributed Electron
// apps make. Worth revisiting if Linux ever moves to a .deb/.rpm install
// instead, where the sandbox helper's permissions CAN be set correctly
// and persistently by the installer.

if (process.platform === 'linux' && !process.env.ELECTRON_DISABLE_SANDBOX) {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const result = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    })
    process.exit(result.status ?? (result.signal ? 1 : 0))
}

require('./app-main')

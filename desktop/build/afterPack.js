// Runs once after electron-builder unpacks the app, before any
// platform-specific packaging (AppImage/dmg/nsis) wraps it further.
//
// Linux only: renames the real Electron binary to <name>.bin and drops in
// a tiny shell script under the ORIGINAL name that exports
// ELECTRON_DISABLE_SANDBOX=1 before exec-ing it. This has to happen at
// this level — outside any of the app's own JavaScript — because the
// sandbox's FATAL abort happens in Electron/Chromium's native process
// bootstrap, before Node ever loads main.js. Setting the env var from
// within the app's own JS (tried first, including as the very first line
// of main.js) is confirmed too late against a real packaged build; even a
// same-process re-exec from within main.js doesn't help, since by the
// time that JS runs, the ORIGINAL process has already tripped (or is
// already committed to tripping) the same native check. The wrapper
// script is what every other AppImage-distributed Electron app does for
// exactly this reason — see main.ts and desktop/README.md for the full
// chain of what was tried and why each attempt failed before landing here.
//
// Why this is needed at all: Chromium's sandbox helper binary
// (chrome-sandbox) must be owned by root with the SUID bit (chmod 4755)
// to be used — impossible for an AppImage, which self-extracts into a
// fresh temp dir on every launch, so those permissions can never persist.
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'linux') return

    const exeName = context.packager.executableName
    const dir = context.appOutDir
    const realBin = path.join(dir, exeName)
    const renamedBin = path.join(dir, `${exeName}.bin`)

    if (!fs.existsSync(realBin)) {
        console.warn(`afterPack: expected binary not found at ${realBin}, skipping sandbox wrapper`)
        return
    }

    fs.renameSync(realBin, renamedBin)
    fs.writeFileSync(
        realBin,
        `#!/bin/sh\nexport ELECTRON_DISABLE_SANDBOX=1\nDIR="$(dirname "$(readlink -f "$0")")"\nexec "$DIR/${exeName}.bin" "$@"\n`,
        { mode: 0o755 },
    )
    console.log(`afterPack: wrapped ${exeName} with ELECTRON_DISABLE_SANDBOX launcher (AppImage/Chromium-sandbox conflict — see this file's header comment)`)
}

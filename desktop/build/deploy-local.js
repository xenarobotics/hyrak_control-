// Copies this machine's just-built installer(s) + electron-updater's
// manifest files (latest.yml / latest-mac.yml / latest-linux.yml) from
// release/ into ../releases/ — the folder the backend serves at /releases
// (see backend/app/config.py's releases_dir + server.py's static mount).
//
// This is the "generic" publish provider's whole point: electron-builder
// writes the installers + manifests locally, but does NO uploading itself
// — you own getting them onto your server. On a machine that already IS
// the server (true for this dev box today), that's just a local copy, as
// below. Building on a DIFFERENT machine (a CI runner for Windows/Mac,
// since those can't be cross-built from Linux) means that upload has to
// be a real remote copy instead — see the commented step in
// .github/workflows/desktop-release.yml.
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'release')
const DEST = path.join(__dirname, '..', '..', 'releases')

const PATTERNS = [/\.exe$/i, /\.dmg$/i, /\.AppImage$/i, /\.blockmap$/i, /^latest.*\.yml$/i]

fs.mkdirSync(DEST, { recursive: true })

if (!fs.existsSync(SRC)) {
    console.error(`nothing to deploy — ${SRC} doesn't exist (run npm run release first)`)
    process.exit(1)
}

let copied = 0
for (const name of fs.readdirSync(SRC)) {
    if (!PATTERNS.some(re => re.test(name))) continue
    const from = path.join(SRC, name)
    if (fs.statSync(from).isDirectory()) continue
    fs.copyFileSync(from, path.join(DEST, name))
    console.log(`copied ${name}`)
    copied++
}

if (copied === 0) {
    console.warn('no installer/manifest files found to copy — did the build actually produce any?')
} else {
    console.log(`done — ${copied} file(s) now served at /releases`)
}

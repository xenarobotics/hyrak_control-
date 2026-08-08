# HYRAK Desktop

The same site (`frontend/`), loaded live in a native window, plus a set of
native bridges the browser build structurally cannot have: raw UDP/TCP
sockets, native serial, and RTSP decode. Nothing about the UI changes —
this app has no pages of its own, it just gives the *same* pages a bigger
hardware surface to work with when `window.hyrakNative` is present.

## Why this exists

Three things came up in this project that a browser tab can never do,
no matter how the frontend is written, because browsers deliberately
don't expose raw socket APIs:

- **SITL over UDP** (single drone or a swarm) — needs a local relay today
  (`sitl_relay/swarm_relay.py` / `air_unit_relay/telemetry_relay.py`).
  This app absorbs that relay directly into the app itself — no separate
  script to run.
- **Your own air unit's wfb-ng UDP output** — same relay pattern, same fix.
- **RTSP cameras** (e.g. a SIYI transmission module) — previously ruled out
  entirely for the browser build. `bridges/rtspBridge.ts` makes this work,
  since ffmpeg (a native process, bundled — see below) can decode RTSP
  where no browser ever could.

## Architecture

```
main.ts         — Linux-only bootstrap (see "Linux sandbox" below), then
                   hands off to app-main.ts
app-main.ts     — creates the window, loads the live site, wires generic
                   IPC over whatever's in bridges/registry.ts
preload.ts      — exposes window.hyrakNative to the loaded page via
                   contextBridge (sandboxed, no direct Node access from
                   the renderer)
updater.ts      — consent-gated electron-updater wiring (see below)
bridges/
  types.ts      — the NativeBridge interface every bridge implements
  registry.ts   — the single place new bridges get registered
  udpBridge.ts  — N tagged local UDP ports, multiplexed — generalizes
                  BOTH the single-drone and swarm relay scripts into one
                  bridge (a swarm is just N ports instead of 1)
  tcpBridge.ts  — connect-out TCP relay (MAVLink-over-TCP links, gimbal/
                  camera control APIs that use TCP instead of UDP)
  serialBridge.ts — native serial (serialport pkg) as an alternative to
                  Web Serial for a real USB radio
  rtspBridge.ts — spawns a bundled ffmpeg, re-serves its MJPEG output as a
                  local multipart HTTP stream
  airUnitVideoBridge.ts — absorbs air_unit_relay/video_webcam.sh into the
                  app: same SDP + low-latency ffmpeg options already
                  proven in backend/app/webrtc/udp_video_source.py, output
                  goes straight to a v4l2loopback device instead of a
                  script the client has to run. Prefers a system ffmpeg
                  with VAAPI (hardware decode) when one exists, falls back
                  to the always-available bundled ffmpeg (software-only —
                  the bundled binary has no VAAPI compiled in, checked)
build/
  generate-icon.py, build-icons.js — reproducible icon pipeline (see
  "App icon" below); `npm run icons` runs both
  afterPack.js  — Linux sandbox fix, runs during packaging (see below)
```

**Adding a new protocol later** (a different codec, HID, a GStreamer
pipeline — whatever comes up next) means: implement `NativeBridge` in one
new file, add one line to `registry.ts`. `app-main.ts`'s IPC wiring and
`preload.ts`'s exposed API are both written generically over the registry
— neither needs to change.

## Linux sandbox (AppImage) — a real gotcha, worth understanding before touching main.ts

First launch of a built AppImage crashed instantly with `FATAL:
setuid_sandbox_host.cc ... chrome-sandbox ... not owned by root / mode
4755`. Cause: Chromium's Linux sandbox needs its helper binary owned by
root with the SUID bit set — impossible for an AppImage, which
self-extracts into a fresh temp dir on every launch, so that ownership can
never persist there. This isn't specific to this app; it hits every
Electron app distributed as an AppImage.

Three fixes were tried, in order, against a real packaged build — worth
recording so nobody "simplifies" this back to something that silently
stops working:

1. `app.commandLine.appendSwitch('no-sandbox')` in app-main.ts — **didn't
   work**. Electron's native bootstrap makes this decision before the
   app's own JS runs at all, so anything set from within it, no matter how
   early, is too late.
2. A same-process re-exec from `main.ts`, setting
   `ELECTRON_DISABLE_SANDBOX` for a child before `app-main.ts` (and
   `electron`) is even required — **also didn't work**. By the time that
   bootstrap JS runs, the ORIGINAL process has already committed to the
   same native check; re-execing from inside it is still too late.
3. **What actually works**: `build/afterPack.js` — an electron-builder
   hook that runs during packaging (not at app runtime at all). It renames
   the real binary from `hyrak-desktop` to `hyrak-desktop.bin` and drops
   in a tiny shell script under the original name that exports
   `ELECTRON_DISABLE_SANDBOX=1` *before* exec-ing the renamed binary. This
   sets the env var at the OS process level, before Electron's native
   layer ever starts — the only point early enough. Verified against a
   real built AppImage, run exactly as a user would (no manual flags):
   launches cleanly, no crash.

`main.ts`'s runtime re-exec (attempt 2) is left in as a harmless,
already-a-no-op fallback for any future Linux packaging path that doesn't
go through `afterPack.js` — it only fires if `ELECTRON_DISABLE_SANDBOX`
isn't already set, which the wrapper script now guarantees for AppImage.

Renderer isolation itself is unrelated to any of this and stays fully on
regardless (`contextIsolation: true`, `nodeIntegration: false` in
`app-main.ts`) — the page still can't touch Node/require/fs directly even
without Chromium's OS-level sandbox layer on top. Since this window only
ever loads HYRAK's own first-party site, that's a reasonable,
industry-standard tradeoff — the same one VS Code, Discord, Slack and most
other AppImage-distributed Electron apps make. Worth revisiting if Linux
ever moves to a `.deb`/`.rpm` install instead, where an installer CAN set
`chrome-sandbox`'s ownership correctly and have it persist.

## Two update layers — this is what avoids "please update the app"

1. **The content layer** (your day-to-day frontend work — most of what
   changes daily) needs **no update mechanism at all**. The window loads
   `HYRAK_SITE_URL` live on every launch, exactly like a browser tab. Ship
   a deploy to your server, every installed app shows it immediately.
2. **The native shell** (this folder — rare changes: a new/fixed bridge,
   an Electron security patch) uses `electron-updater`, wired in
   `updater.ts`. It checks the release feed (your own server's
   `/releases/` — see "Where builds live" below, not GitHub) silently on
   launch, but **never downloads or installs without explicit
   authorization**:
   - `checking-for-update` / `update-available` / `update-not-available` —
     reported to the renderer; nothing happens automatically.
   - The renderer's `UpdatePrompt` component
     (`frontend/src/components/updater/UpdatePrompt.tsx`) shows a popup on
     launch if one's available. Only clicking "Update now" calls
     `authorizeDownload()`, which starts the actual download.
   - Once downloaded, only clicking "Restart & install" calls `install()`
     (`autoUpdater.quitAndInstall()`) — the app never restarts itself
     unprompted.
   - Settings → About also has a manual "Check for updates" button, same
     API, for whenever — not just on launch.

## Renderer-side integration (frontend/)

`frontend/src/lib/nativeBridge.ts` detects `window.hyrakNative` and is the
single place the rest of the frontend checks before falling back to the
browser-only path (an externally-run relay script, or "unsupported" for
RTSP). `localSwarmRelay.ts` is wired as the first concrete example — when
running inside this app, it uses the native UDP bridge directly instead of
connecting out to a separately-run `swarm_relay.py`/`swarm_relay.exe`.

**RTSP → the existing video pipeline** (not yet wired into the UI, but the
glue is this small): the `rtsp` bridge's `status` event carries a
`streamUrl` (`http://127.0.0.1:PORT/stream`, plain multipart MJPEG — no
special support needed). Draw it onto a canvas and capture that:

```ts
const img = new Image()
img.crossOrigin = 'anonymous'
img.src = streamUrl
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d')!
function draw() { ctx.drawImage(img, 0, 0); requestAnimationFrame(draw) }
img.onload = () => { canvas.width = img.width; canvas.height = img.height; draw() }
const stream = canvas.captureStream(15) // a real MediaStream
// -> same startStream(stream) call already used for every other camera source
```

## ffmpeg — bundled, not a user dependency

`rtspBridge.ts` uses the `ffmpeg-static` npm package, which downloads a
real ffmpeg binary for the CURRENT platform at `npm install` time — so a
Windows CI runner gets a Windows ffmpeg.exe, a Mac runner gets a Mac
binary, etc., each bundled straight into that platform's installer.
`package.json`'s `build.asarUnpack` keeps it outside the asar archive
(binaries can't execute from inside one), and `rtspBridge.ts` corrects the
resolved path (`app.asar` → `app.asar.unpacked`) accordingly. Verified end
to end: built a real Linux AppImage and confirmed ffmpeg landed at
`resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg`.

## Where builds live — your own server, not GitHub

`package.json`'s `build.publish` uses electron-builder's **generic**
provider (`https://api.xenarobotics.com/releases/` — update this if the
backend's public URL ever changes) instead of GitHub Releases. "generic"
is the provider specifically meant for "I'll host these myself": running
`electron-builder --publish always` (the `release` npm script below)
writes the installers PLUS electron-updater's manifest files
(`latest.yml` / `latest-mac.yml` / `latest-linux.yml`) into `release/`,
but — unlike the `github`/`s3` providers — does no uploading on its own.
That upload is either:

- **A local copy**, when building on a machine that already IS the server
  (true for Linux today, since this dev box runs the backend too):
  `npm run deploy:local` builds and copies straight into `../releases/`,
  which `backend/app/server.py` serves at `/releases` (config:
  `backend/app/config.py`'s `releases_dir`, defaults to `<repo>/releases`).
- **An SSH/rsync step in CI**, for Windows/Mac, which can't be built on
  this Linux machine at all (see below) — `.github/workflows/
  desktop-release.yml` has this wired but **needs real secrets configured
  before it will actually deploy anything**: `DEPLOY_HOST`, `DEPLOY_USER`,
  `DEPLOY_SSH_KEY`, `DEPLOY_PATH` (repo Settings → Secrets and variables →
  Actions), plus the repo variable `DEPLOY_CONFIGURED=true` to turn the
  step on. Until then the workflow still builds successfully and uploads
  each platform's installer as a downloadable **workflow artifact** — so
  nothing is blocked, manual upload just works as a stand-in.

The landing page (`frontend/src/app/page.tsx` + `lib/desktopReleases.ts`)
reads the same manifests from `/releases/` to resolve the current version
and build a direct download link — auto-detects the visitor's platform,
lets them switch via a dropdown, size shown, and the click **starts the
download from the page itself** (an `<a download>`, not a redirect
anywhere). If no build has been deployed yet, it shows "No build
published yet" rather than linking anywhere.

```bash
npm install
npm run start             # dev: build + launch, points at HYRAK_SITE_URL
                           # (defaults to https://dev.xenarobotics.com)
HYRAK_SITE_URL=http://localhost:3000 npm run start   # point at local dev frontend

npm run icons              # regenerate build/icon.{ico,icns,png} from brand art
npm run dist                # build an installer for the CURRENT platform only,
                             # unpublished (no manifest files) — output in release/
npm run release              # build AND write the electron-updater manifests —
                             # still no upload (generic provider), just local files
npm run deploy:local          # release, then copy everything into ../releases/
                             # (only makes sense on a machine that IS the server)
```

## Cross-platform builds (Windows / macOS / Linux)

electron-builder can't reliably cross-compile a Windows `.exe` or macOS
`.dmg` from this Linux machine — each installer has to be built ON that
OS. `.github/workflows/desktop-release.yml` does this properly: a 3-way CI
matrix (`windows-latest` / `macos-latest` / `ubuntu-latest`), each building
its own installer and deploying it to the SAME server folder (see above),
triggered by pushing a `desktop-v*` tag:

```bash
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

macOS builds both `arm64` (Apple Silicon) and `x64` (Intel) as separate
`.dmg`s (`package.json`'s `build.mac.target`).

**Code signing** isn't set up (no certificates to configure it with) —
unsigned builds still install and run fine, they just trigger a Windows
SmartScreen / macOS Gatekeeper warning the user has to click through. The
CI workflow already has `CSC_LINK` / `CSC_KEY_PASSWORD` env vars wired for
whenever certificates exist (Windows: ~$100–400/yr from a CA; macOS: Apple
Developer Program $99/yr + notarization) — add them as repo secrets and
signing turns on with no other changes.

## App icon

Generated from `frontend/public/brand/icon.png` (confirmed to already be a
clean transparent PNG — no chroma-keying needed) composited onto the app's
dark chrome color (`#0a0a0c`, matching `main.ts`'s window
`backgroundColor`), then run through `icon-gen` for the platform formats.
Reproducible any time the brand mark changes:

```bash
npm run icons
```

Outputs `build/icon.ico` (Windows), `build/icon.icns` (macOS),
`build/icon.png` (Linux) — `package.json`'s `build.icon: "build/icon"`
points electron-builder at all three automatically.

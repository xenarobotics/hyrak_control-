import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Keeps spawned ffmpeg processes from outliving the app.
//
// Written after a real incident: four HYRAK instances had accumulated over
// ~40 minutes and left NINE orphaned ffmpeg processes pulling the same
// camera. Four of them were libx264 transcodes holding ~260% CPU each, with
// over an hour of accumulated CPU time apiece. Together with the Electron
// instances they pinned a 24-core machine at ~98% (load average 21.7 and
// climbing).
//
// The visible symptom was ~1s of video latency, and it was misdiagnosed
// repeatedly as a network problem — the WiFi link was in fact pristine
// (-33 dBm, 390 Mbit/s carrying 2 Mbit/s of video). A saturated CPU cannot be
// tuned away downstream: libx264 stops encoding in realtime, so frames queue
// at the encoder; Chromium's decoder is starved, so <video> buffers more; and
// the live-edge clamp cannot drain a backlog when playback itself is starved.
//
// Three independent failure modes produced those orphans, so there are three
// defences here, and all of them are needed:
//
//   1. Nothing stopped the bridges when the app quit — there was no
//      before-quit handler at all. `killAllTracked()` fixes that.
//   2. SIGTERM alone was assumed to work. Two of the nine orphans sat at 0%
//      CPU having ignored it. `killChild()` escalates.
//   3. If the app is SIGKILLed or crashes, no in-process handler can run at
//      all. `reapOrphans()` cleans up at the NEXT startup, which is the only
//      defence that covers that case — and it's the case that actually
//      happened.
//
// Why the children don't simply die on their own when the parent goes: ffmpeg
// writes to `pipe:1`, so a closed read end should give it EPIPE. But Electron
// forks helper processes (zygote, GPU, renderers) that inherit open file
// descriptors, so the read end of that pipe stays open after the main process
// is gone and ffmpeg never notices. Linux's PR_SET_PDEATHSIG would solve this
// at the source but is not reachable from Node without a native addon.

// How long a child gets to exit on SIGTERM before it is SIGKILLed. ffmpeg
// normally goes in well under a second; this is generous enough not to
// truncate a clean shutdown and short enough that quitting never feels hung.
const KILL_GRACE_MS = 1500

const tracked = new Set<ChildProcess>()

/** Registers a freshly spawned child so it can be killed on quit. Safe to
 *  call more than once for the same process. */
export function trackChild(proc: ChildProcess): void {
    tracked.add(proc)
    // Self-deregistering, so a long-lived app doesn't accumulate handles to
    // processes that exited hours ago.
    proc.once('exit', () => tracked.delete(proc))
}

function isAlive(proc: ChildProcess): boolean {
    return proc.exitCode === null && proc.signalCode === null
}

/** SIGTERM, then SIGKILL if the child is still alive after the grace period.
 *  Replaces bare `proc.kill('SIGTERM')`, which is what leaked. */
export function killChild(proc: ChildProcess | null | undefined): void {
    if (!proc || !isAlive(proc)) return
    try { proc.kill('SIGTERM') } catch { return /* already gone */ }
    const timer = setTimeout(() => {
        if (isAlive(proc)) {
            try { proc.kill('SIGKILL') } catch { /* raced with a clean exit */ }
        }
    }, KILL_GRACE_MS)
    // Don't hold the event loop open purely to escalate a kill — if the app is
    // shutting down it should be allowed to.
    timer.unref?.()
    proc.once('exit', () => clearTimeout(timer))
}

/** Kills every tracked child immediately. Called from `before-quit` and, as a
 *  last resort, from `process.on('exit')` — which is synchronous and cannot
 *  wait, hence SIGKILL with no grace period. */
export function killAllTracked(immediate = false): void {
    for (const proc of tracked) {
        try {
            proc.kill(immediate ? 'SIGKILL' : 'SIGTERM')
        } catch { /* already gone */ }
    }
    if (immediate) {
        tracked.clear()
        return
    }
    for (const proc of tracked) {
        const timer = setTimeout(() => {
            if (isAlive(proc)) {
                try { proc.kill('SIGKILL') } catch { /* raced */ }
            }
        }, KILL_GRACE_MS)
        timer.unref?.()
    }
}

/** Number of children currently tracked. Diagnostics only. */
export function trackedCount(): number {
    return tracked.size
}

function readProcFile(pid: string, name: string): string | null {
    try {
        return fs.readFileSync(path.join('/proc', pid, name), 'utf8')
    } catch {
        return null   // process exited between readdir and read, or not ours
    }
}

/** True when `pid`'s parent is gone or is not another instance of this app.
 *
 *  The ppid === 1 test alone is not reliable: under a systemd user session an
 *  orphan is reparented to `systemd --user`, not to init. So instead of
 *  guessing at the new parent's pid, look at what the parent actually IS —
 *  and treat "not an Electron/HYRAK process" as orphaned. That also makes the
 *  check safe to run while a SIBLING instance is live: its children still
 *  have a real HYRAK parent and are left alone. */
function isOrphaned(pid: string): boolean {
    const stat = readProcFile(pid, 'stat')
    if (!stat) return false
    // Field 4 is ppid, but the comm field (2) can itself contain spaces or
    // parentheses — so parse from the LAST ')' rather than splitting naively.
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const ppid = after[1]
    if (!ppid || ppid === '0') return false
    if (ppid === '1') return true
    const parentCmd = readProcFile(ppid, 'cmdline')
    if (!parentCmd) return true          // parent vanished — definitely orphaned
    return !/HYRAK|electron/i.test(parentCmd)
}

/** Kills ffmpeg processes left behind by a previous run.
 *
 *  This is the only defence that survives the app being SIGKILLed or
 *  crashing, because no in-process handler can run in that case. Linux only:
 *  it reads /proc. On other platforms it is a documented no-op rather than a
 *  half-working guess — the leak was observed on Linux, and a wrong process
 *  match on someone's workstation is worse than no cleanup.
 *
 *  Scoped deliberately narrowly: only processes whose executable is the
 *  ffmpeg WE bundle, and only those whose parent is gone. A system ffmpeg the
 *  user started themselves is never touched.
 *
 *  @param ffmpegPath the bundled binary path, so a system ffmpeg is excluded
 *  @returns pids killed, for logging */
/** The Electron main binary's filename inside the AppImage. */
const APP_BIN = 'hyrak-desktop.bin'

/** Kills app instances left over from a PREVIOUS VERSION after an update.
 *
 *  The observed failure: after "Update & restart", a 0.1.30 main process was
 *  still running while 0.1.31 was the installed version — holding udp:5600 and
 *  making the new instance's video unusable. Its ppid was `systemd --user`
 *  (reparented) and its executable was `/tmp/.mount_HYRAK-AEal2b/…`, a squashfs
 *  mount that no longer appeared in /proc/mounts at all.
 *
 *  That is the precise signature this looks for, and it is unambiguous: an
 *  AppImage's Electron binary lives ONLY inside that per-run mount, so if the
 *  path has gone the AppImage wrapper has already exited and unmounted it. The
 *  process is running from a filesystem that no longer exists — it cannot be
 *  anything but a leftover, and it can never be the version the user just
 *  installed.
 *
 *  Deliberately NOT a single-instance lock. Two instances of the CURRENT
 *  version are allowed on purpose (a live mount is never stale, so they are
 *  untouched) — only ghosts of superseded versions are removed.
 *
 *  Linux/AppImage only; on Windows the NSIS installer replaces the binary in
 *  place and there is no mount to disappear.
 *
 *  @returns pids killed, for logging */
export function reapStaleInstances(): number[] {
    if (process.platform !== 'linux') return []
    const killed: number[] = []
    let pids: string[]
    try {
        pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))
    } catch {
        return []
    }
    for (const pid of pids) {
        if (pid === String(process.pid)) continue
        let exe: string
        try {
            exe = fs.readlinkSync(path.join('/proc', pid, 'exe'))
        } catch {
            continue   // not ours to inspect, or already exited
        }
        // Linux appends this when the target was unlinked; an unmounted
        // squashfs instead leaves a path that simply no longer resolves. Treat
        // either as gone.
        const deleted = exe.endsWith(' (deleted)')
        const real = deleted ? exe.slice(0, -' (deleted)'.length) : exe
        if (path.basename(real) !== APP_BIN) continue
        // Only the main process. Helpers (zygote, GPU, renderers) share the
        // same binary and die with their parent, so signalling them separately
        // is noise at best.
        const cmdline = readProcFile(pid, 'cmdline')
        if (cmdline && cmdline.includes('--type=')) continue
        if (!deleted && fs.existsSync(real)) continue   // live mount — a legitimate sibling
        try {
            process.kill(Number(pid), 'SIGKILL')
            killed.push(Number(pid))
        } catch { /* exited between the check and the kill */ }
    }
    return killed
}

/** Kills running instances of an OLDER version whose mount is still alive.
 *
 *  reapStaleInstances only removes ghosts whose AppImage mount has vanished.
 *  The case it cannot see: the user downloads HYRAK-0.1.40.AppImage next to a
 *  still-running HYRAK-0.1.39.AppImage. The old mount is perfectly healthy, so
 *  the old instance looks like "a legitimate sibling" — while silently holding
 *  udp:5600, which makes the new version's video dead on arrival, with no
 *  error a non-technical user could act on.
 *
 *  The other instance's version comes from the APPIMAGE env var the AppImage
 *  runtime sets (…/HYRAK-0.1.39.AppImage). No parseable version = untouched:
 *  killing something we cannot positively identify as outdated is worse than
 *  leaving it.
 *
 *  Strictly OLDER versions only. Same version is the side-by-side-windows
 *  case; NEWER means we are the outdated one and app-main's single-instance
 *  lock will make this process defer instead.
 *
 *  @returns pids killed, for logging */
export function reapOutdatedInstances(ourVersion: string): number[] {
    if (process.platform !== 'linux') return []
    const ours = parseVersion(ourVersion)
    if (!ours) return []
    const killed: number[] = []
    let pids: string[]
    try {
        pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))
    } catch {
        return []
    }
    for (const pid of pids) {
        if (pid === String(process.pid)) continue
        let exe: string
        try {
            exe = fs.readlinkSync(path.join('/proc', pid, 'exe'))
        } catch {
            continue
        }
        if (path.basename(exe.replace(/ \(deleted\)$/, '')) !== APP_BIN) continue
        const cmdline = readProcFile(pid, 'cmdline')
        if (cmdline && cmdline.includes('--type=')) continue   // helper, dies with its main
        const environ = readProcFile(pid, 'environ')
        if (!environ) continue
        const appimage = environ.split('\0').find(e => e.startsWith('APPIMAGE='))
        const theirs = appimage ? parseVersion(path.basename(appimage)) : null
        if (!theirs || compareVersions(theirs, ours) >= 0) continue
        try {
            process.kill(Number(pid), 'SIGKILL')
            killed.push(Number(pid))
        } catch { /* exited between the check and the kill */ }
    }
    return killed
}

function parseVersion(s: string): [number, number, number] | null {
    const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i]
    }
    return 0
}

export function reapOrphans(ffmpegPath: string): number[] {
    if (process.platform !== 'linux') return []
    const killed: number[] = []
    let pids: string[]
    try {
        pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))
    } catch {
        return []
    }
    // The AppImage mounts itself under a per-run /tmp/.mount_HYRAK-xxxxxx
    // path, so the previous run's ffmpeg path never matches this run's
    // string exactly. Match on the stable trailing component instead.
    const marker = path.join('node_modules', 'ffmpeg-static', 'ffmpeg')
    for (const pid of pids) {
        if (pid === String(process.pid)) continue
        let exe: string
        try {
            exe = fs.readlinkSync(path.join('/proc', pid, 'exe'))
        } catch {
            continue   // not ours to inspect (permission) or already exited
        }
        const isOurFfmpeg = exe.endsWith(marker) || exe === ffmpegPath
        if (!isOurFfmpeg) continue
        if (!isOrphaned(pid)) continue
        try {
            process.kill(Number(pid), 'SIGKILL')
            killed.push(Number(pid))
        } catch { /* exited on its own between the check and the kill */ }
    }
    return killed
}

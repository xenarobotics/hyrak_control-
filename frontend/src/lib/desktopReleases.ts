// Resolves the right desktop installer for the visitor's platform against
// the backend's own /releases/ static folder — not GitHub. CI builds each
// platform's installer and copies it there (see
// desktop/build/deploy-local.js and desktop/package.json's "generic"
// publish provider), and electron-updater's manifest files
// (latest.yml / latest-mac.yml / latest-linux.yml) land alongside them.
//
// The filename is taken FROM the manifest, never reconstructed from a
// pattern. This file used to rebuild it as `HYRAK-${version}.AppImage` to
// match desktop/package.json's artifactName — and then artifactName gained
// an `-${arch}` segment, the real file became HYRAK-0.1.57-x86_64.AppImage,
// and every Linux download 404'd into "No build published yet" with nothing
// in the backend log to show for it. Any future artifactName change would
// break it again the same silent way. electron-updater already needs the
// exact name in the manifest, so the manifest is the authoritative source
// and reading it removes the whole class of bug.

import { getServerUrl } from './server-url'

export type Platform = 'windows' | 'mac-arm64' | 'mac-x64' | 'linux' | 'linux-arm64'

export const PLATFORM_LABELS: Record<Platform, string> = {
    windows: 'Windows',
    'mac-arm64': 'macOS (Apple Silicon)',
    'mac-x64': 'macOS (Intel)',
    linux: 'Linux (x86-64)',
    // Named after the board rather than just the architecture: the people who
    // need this build are looking for the ground unit, and "ARM64" alone reads
    // as a Raspberry Pi option to everyone else.
    'linux-arm64': 'Linux ARM64 (Orange Pi 5 / RK3588)',
}

export const PLATFORM_OPTIONS: Platform[] = [
    'windows', 'mac-arm64', 'mac-x64', 'linux', 'linux-arm64',
]

// Best-effort — browsers don't reliably expose Apple Silicon vs. Intel, so
// Mac defaults to Apple Silicon (the majority of Macs sold since 2020) and
// the dropdown lets anyone correct it either way.
export function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'windows'
    const ua = navigator.userAgent
    if (/Mac/i.test(ua)) return 'mac-arm64'
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) {
        // Linux on ARM is niche enough that x86-64 stays the default; only a
        // UA that actually says aarch64/arm64 flips it. Chromium on the
        // ground unit does report `aarch64` in the platform token. Android is
        // already excluded above — it is ARM too, and is not this product.
        return /aarch64|arm64/i.test(ua) ? 'linux-arm64' : 'linux'
    }
    return 'windows'
}

// electron-updater's per-platform manifest filenames.
const MANIFEST: Record<Platform, string> = {
    windows: 'latest.yml',
    'mac-arm64': 'latest-mac.yml',
    'mac-x64': 'latest-mac.yml',
    linux: 'latest-linux.yml',
    // electron-builder writes a SEPARATE manifest for a non-x64 Linux arch,
    // which is what lets both AppImages live in one folder and update
    // independently. The two builds are also versioned independently — the
    // arm64 one comes from the desktop-arm64 tree — so this must not be
    // assumed to match latest-linux.yml.
    'linux-arm64': 'latest-linux-arm64.yml',
}

const EXT_FOR: Record<Platform, string> = {
    windows: '.exe',
    'mac-arm64': '.dmg',
    'mac-x64': '.dmg',
    linux: '.AppImage',
    'linux-arm64': '.AppImage',
}

// electron-builder writes x86-64 as `x86_64` on Linux and `x64` on macOS,
// and ARM as `arm64` (occasionally `aarch64`) on both.
const IS_ARM = /(?:arm64|aarch64)/i

function matchesArch(fileName: string, platform: Platform): boolean {
    const arm = IS_ARM.test(fileName)
    switch (platform) {
        case 'mac-arm64':
        case 'linux-arm64':
            return arm
        // An arch-less name (older builds, and Windows, which ships one
        // installer) counts as x64 — only an explicit ARM marker excludes it.
        case 'mac-x64':
        case 'linux':
        case 'windows':
            return !arm
    }
}

/** Pull `version` and the artifact filenames out of an electron-updater
 *  manifest. Deliberately not a full YAML parse: these manifests are machine-
 *  written with a fixed shape, and a parser dependency for two fields would
 *  be the larger risk. */
function parseManifest(yaml: string): { version: string; files: string[] } | null {
    const version = yaml.match(/^version:\s*['"]?(\S+?)['"]?\s*$/m)?.[1]
    if (!version) return null

    const files: string[] = []
    // `  - url: NAME` under `files:`, plus the top-level `path: NAME` that
    // electron-updater itself falls back on.
    for (const m of yaml.matchAll(/^\s*(?:-\s*url|path):\s*['"]?(.+?)['"]?\s*$/gm)) {
        const name = m[1]
        // Blockmaps sit beside the installer and are not downloadable builds.
        if (name && !name.endsWith('.blockmap') && !files.includes(name)) files.push(name)
    }
    return files.length ? { version, files } : null
}

function pickFile(files: string[], platform: Platform): string | null {
    const ext = EXT_FOR[platform]
    const candidates = files.filter(f => f.endsWith(ext))
    if (!candidates.length) return null
    // Arch is a filter when it discriminates, and ignored when the manifest
    // only carries one build for this extension — a single-arch manifest
    // should still resolve rather than fail closed.
    return candidates.find(f => matchesArch(f, platform)) ?? (candidates.length === 1 ? candidates[0] : null)
}

export interface ReleaseAsset {
    url: string
    /** The artifact's on-disk name, undecorated — the `chmod +x` hint needs
     *  what the file is actually called, not the percent-encoded URL. */
    fileName: string
    version: string
    sizeBytes: number
}

export async function resolveLatestAsset(platform: Platform): Promise<ReleaseAsset | null> {
    try {
        const base = `${getServerUrl()}/releases`
        const manifestRes = await fetch(`${base}/${MANIFEST[platform]}`, { cache: 'no-store' })
        if (!manifestRes.ok) return null
        const manifest = parseManifest(await manifestRes.text())
        if (!manifest) return null
        const { version } = manifest

        const fileName = pickFile(manifest.files, platform)
        if (!fileName) return null
        const url = `${base}/${encodeURIComponent(fileName)}`
        const headRes = await fetch(url, { method: 'HEAD' })
        if (!headRes.ok) return null
        const sizeBytes = Number(headRes.headers.get('content-length') ?? 0)

        return { url, fileName, version, sizeBytes }
    } catch {
        return null
    }
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return ''
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

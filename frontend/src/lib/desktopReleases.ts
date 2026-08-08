// Resolves the right desktop installer for the visitor's platform against
// the backend's own /releases/ static folder — not GitHub. CI builds each
// platform's installer and copies it there (see
// desktop/build/deploy-local.js and desktop/package.json's "generic"
// publish provider), and electron-updater's manifest files
// (latest.yml / latest-mac.yml / latest-linux.yml) land alongside them —
// this reads those same manifests to figure out the current version, then
// builds the direct file URL from the known artifactName pattern (see
// desktop/package.json's build.win/mac/linux.artifactName).

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

// Matches desktop/package.json's build.win/mac/linux.artifactName exactly.
function fileNameFor(platform: Platform, version: string): string {
    switch (platform) {
        case 'windows':   return `HYRAK-Setup-${version}.exe`
        case 'mac-arm64': return `HYRAK-${version}-arm64.dmg`
        case 'mac-x64':   return `HYRAK-${version}-x64.dmg`
        case 'linux':     return `HYRAK-${version}.AppImage`
        // desktop-arm64/package.json's build.linux.artifactName —
        // `HYRAK-${version}-${arch}.${ext}`. The x64 build deliberately keeps
        // its arch-less name so every already-installed client's update URL
        // stays valid.
        case 'linux-arm64': return `HYRAK-${version}-arm64.AppImage`
    }
}

export interface ReleaseAsset {
    url: string
    version: string
    sizeBytes: number
}

export async function resolveLatestAsset(platform: Platform): Promise<ReleaseAsset | null> {
    try {
        const base = `${getServerUrl()}/releases`
        const manifestRes = await fetch(`${base}/${MANIFEST[platform]}`, { cache: 'no-store' })
        if (!manifestRes.ok) return null
        const yaml = await manifestRes.text()
        // Only the one field we need — the manifest format is simple
        // enough that a full YAML parser would be overkill for this.
        const versionMatch = yaml.match(/^version:\s*(\S+)/m)
        if (!versionMatch) return null
        const version = versionMatch[1]

        const fileName = fileNameFor(platform, version)
        const url = `${base}/${fileName}`
        const headRes = await fetch(url, { method: 'HEAD' })
        if (!headRes.ok) return null
        const sizeBytes = Number(headRes.headers.get('content-length') ?? 0)

        return { url, version, sizeBytes }
    } catch {
        return null
    }
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return ''
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

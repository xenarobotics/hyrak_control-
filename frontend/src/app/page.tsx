'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Globe, Download, Loader2, Copy, Check } from 'lucide-react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
    detectPlatform, resolveLatestAsset, formatBytes,
    PLATFORM_LABELS, PLATFORM_OPTIONS, type Platform, type ReleaseAsset,
} from '@/lib/desktopReleases'
import { useClientValue, useHydrated } from '@/hooks/useClientValue'

function CopyCommand({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            onClick={() => {
                void navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            }}
            aria-label={copied ? 'Copied' : 'Copy command'}
            title={copied ? 'Copied' : 'Copy command'}
            className="w-full min-h-8 flex items-center justify-between gap-2 text-[12px] font-code px-3 py-2 rounded-md border border-app-border bg-app-surface-2 text-app-text transition-colors"
        >
            <span className="truncate">{text}</span>
            {copied ? <Check size={14} className="shrink-0 text-app-accent" /> : <Copy size={14} className="shrink-0 text-app-text-muted" />}
        </button>
    )
}

function DesktopDownloadCard() {
    const mounted = useHydrated()
    const detected = useClientValue<Platform>(detectPlatform, 'windows')
    const [picked, setPlatform] = useState<Platform | null>(null)
    const platform = picked ?? detected
    // Which platform the asset was resolved FOR: loading is simply "the
    // answer on hand is not for the platform on screen", so switching
    // platforms needs no reset step.
    const [resolved, setResolved] = useState<{ platform: Platform; asset: ReleaseAsset | null } | null>(null)
    const loading = resolved?.platform !== platform
    const asset = loading ? null : resolved.asset

    useEffect(() => {
        if (!mounted) return
        let alive = true
        resolveLatestAsset(platform).then(a => { if (alive) setResolved({ platform, asset: a }) })
        return () => { alive = false }
    }, [platform, mounted])

    return (
        <div
            className="group flex flex-col items-start gap-3 rounded-[10px] border border-app-border bg-app-surface p-6 text-left shadow-[var(--app-shadow)] transition-colors hover:border-app-accent"
        >
            <div className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-app-accent-soft text-app-accent">
                <Download size={20} />
            </div>
            <div>
                <h2 className="text-[16px] font-bold mb-1">Download the desktop app</h2>
                <p className="text-[13px] leading-relaxed text-app-text-muted">
                    For simulators, swarms, air units and RTSP cameras. Updates itself.
                </p>
            </div>

            {mounted && (
                <Select value={platform} onValueChange={v => v && setPlatform(v as Platform)}>
                    <SelectTrigger className="h-9 w-full text-[14px]" aria-label="Platform">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {PLATFORM_OPTIONS.map(p => (
                            <SelectItem key={p} value={p} className="text-[14px]">
                                {PLATFORM_LABELS[p]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {/* download (not target=_blank) makes the click itself start
                saving the file on this page - no navigating to GitHub. Only
                a real <a href> when an asset actually resolved; otherwise a
                plain disabled button, never a link anywhere. */}
            {asset ? (
                <a
                    href={asset.url}
                    download
                    className="w-full min-h-10 flex items-center justify-center gap-1.5 text-[14px] py-2 rounded-md font-bold bg-app-accent text-app-accent-ink transition-opacity hover:opacity-90"
                >
                    Download{asset.sizeBytes ? ` (${formatBytes(asset.sizeBytes)})` : ''}
                </a>
            ) : (
                <button
                    disabled
                    title={mounted && loading ? 'Looking for the latest build' : 'No desktop build for this platform yet'}
                    className="w-full min-h-10 flex items-center justify-center gap-1.5 text-[14px] py-2 rounded-md font-semibold cursor-not-allowed border border-dashed border-app-border-strong bg-app-surface-2 text-app-text-muted"
                >
                    {mounted && loading ? <Loader2 size={16} className="animate-spin" /> : 'No build published yet'}
                </button>
            )}

            {/* AppImages arrive without the executable bit set - browsers
                never mark downloads executable, on any OS, for any app.
                Universal AppImage behavior, not specific to this build -
                worth saying up front instead of letting everyone hit
                "Permission denied" once and wonder if the download's bad. */}
            {asset && (platform === 'linux' || platform === 'linux-arm64') && (
                <div className="w-full flex flex-col gap-1.5">
                    <p className="text-[13px] text-app-text-muted">
                        First run: make the AppImage executable.
                    </p>
                    <CopyCommand text={`chmod +x ${asset.fileName} && ./${asset.fileName}`} />
                </div>
            )}
        </div>
    )
}

export default function LandingPage() {
    const router = useRouter()

    return (
        <div
            className="min-h-screen flex flex-col items-center justify-center px-4 py-12 sm:px-6 bg-app-bg text-app-text"
        >
            <div className="flex flex-col items-center gap-2 mb-12">
                <h1 className="text-[28px] leading-[34px] font-extrabold tracking-[0.06em]">HYRAK</h1>
                <span className="text-[14px] text-app-text-muted">
                    Cloud-native drone intelligence
                </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl items-start">
                {/* Browser */}
                <button
                    onClick={() => router.push('/fly')}
                    className="group flex flex-col items-start gap-3 rounded-[10px] border border-app-border bg-app-surface p-6 text-left shadow-[var(--app-shadow)] transition-colors hover:border-app-accent h-full"
                >
                    <div className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-app-accent-soft text-app-accent">
                        <Globe size={20} />
                    </div>
                    <div>
                        <h2 className="text-[16px] font-bold mb-1">Continue in the browser</h2>
                        <p className="text-[13px] leading-relaxed text-app-text-muted">
                            One drone or radio, camera and AI. Nothing to install.
                        </p>
                    </div>
                    <span className="mt-auto text-[14px] font-semibold text-app-accent">
                        Open Fly →
                    </span>
                </button>

                {/* Desktop app */}
                <DesktopDownloadCard />
            </div>

            <p className="mt-12 text-[13px] text-app-text-muted">
                Same account, same missions, either way.
            </p>
        </div>
    )
}

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Globe, Download, Loader2, Copy, Check } from 'lucide-react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
    detectPlatform, resolveLatestAsset, formatBytes,
    PLATFORM_LABELS, PLATFORM_OPTIONS, type Platform, type ReleaseAsset,
} from '@/lib/desktopReleases'

function CopyCommand({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            onClick={() => {
                void navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            }}
            className="w-full flex items-center justify-between gap-2 text-[11px] font-mono px-2.5 py-2 rounded-lg border transition-colors"
            style={{ borderColor: 'hsl(var(--app-border))', background: 'hsl(var(--app-surface-2))', color: 'hsl(var(--app-text))' }}
        >
            <span className="truncate">{text}</span>
            {copied ? <Check size={11} style={{ color: '#22d3ee' }} /> : <Copy size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />}
        </button>
    )
}

function DesktopDownloadCard() {
    const [platform, setPlatform] = useState<Platform>('windows')
    const [mounted, setMounted]   = useState(false)
    const [asset, setAsset]       = useState<ReleaseAsset | null>(null)
    const [loading, setLoading]   = useState(true)

    useEffect(() => {
        setMounted(true)
        setPlatform(detectPlatform())
    }, [])

    useEffect(() => {
        if (!mounted) return
        setLoading(true)
        setAsset(null)
        resolveLatestAsset(platform).then(a => { setAsset(a); setLoading(false) })
    }, [platform, mounted])

    return (
        <div
            className="group flex flex-col items-start gap-3 rounded-xl border p-6 text-left transition-colors hover:border-cyan-500"
            style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}
        >
            <div
                className="flex items-center justify-center w-9 h-9 rounded-lg"
                style={{ background: 'hsl(var(--app-surface-2))' }}
            >
                <Download size={16} style={{ color: 'hsl(var(--app-text))' }} />
            </div>
            <div>
                <div className="text-sm font-mono font-semibold mb-1">Download Desktop App</div>
                <p className="text-xs font-mono leading-relaxed" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    SITL, drone swarms, custom air units, RTSP cameras, multi-camera setups. Installs once, updates itself.
                </p>
            </div>

            {mounted && (
                <Select value={platform} onValueChange={v => v && setPlatform(v as Platform)}>
                    <SelectTrigger className="h-8 w-full text-xs font-mono">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {PLATFORM_OPTIONS.map(p => (
                            <SelectItem key={p} value={p} className="text-xs font-mono">
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
                    className="w-full flex items-center justify-center gap-1.5 text-xs font-mono py-2 rounded-lg font-semibold transition-colors"
                    style={{ background: '#22d3ee', color: 'black' }}
                >
                    Download{asset.sizeBytes ? ` (${formatBytes(asset.sizeBytes)})` : ''}
                </a>
            ) : (
                <button
                    disabled
                    className="w-full flex items-center justify-center gap-1.5 text-xs font-mono py-2 rounded-lg font-semibold cursor-not-allowed"
                    style={{ background: 'hsl(var(--app-surface-2))', color: 'hsl(var(--app-text-muted))' }}
                >
                    {mounted && loading ? <Loader2 size={12} className="animate-spin" /> : 'No build published yet'}
                </button>
            )}

            {/* AppImages arrive without the executable bit set - browsers
                never mark downloads executable, on any OS, for any app.
                Universal AppImage behavior, not specific to this build -
                worth saying up front instead of letting everyone hit
                "Permission denied" once and wonder if the download's bad. */}
            {asset && (platform === 'linux' || platform === 'linux-arm64') && (
                <div className="w-full flex flex-col gap-1.5">
                    <p className="text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                        First run - AppImages need the executable bit set manually:
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
            className="min-h-screen flex flex-col items-center justify-center px-6"
            style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}
        >
            <div className="flex flex-col items-center gap-2 mb-14">
                <span className="text-3xl font-mono font-bold tracking-[0.2em]">HYRAK</span>
                <span className="text-sm font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                    Cloud-native drone intelligence
                </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl items-start">
                {/* Browser */}
                <button
                    onClick={() => router.push('/fly')}
                    className="group flex flex-col items-start gap-3 rounded-xl border p-6 text-left transition-colors hover:border-cyan-500 h-full"
                    style={{ background: 'hsl(var(--app-surface))', borderColor: 'hsl(var(--app-border))' }}
                >
                    <div
                        className="flex items-center justify-center w-9 h-9 rounded-lg"
                        style={{ background: 'hsl(var(--app-surface-2))' }}
                    >
                        <Globe size={16} style={{ color: 'hsl(var(--app-text))' }} />
                    </div>
                    <div>
                        <div className="text-sm font-mono font-semibold mb-1">Continue in Browser</div>
                        <p className="text-xs font-mono leading-relaxed" style={{ color: 'hsl(var(--app-text-muted))' }}>
                            Camera, a single drone or telemetry radio, AI modules. Works instantly - nothing to install.
                        </p>
                    </div>
                    <span
                        className="mt-auto text-xs font-mono transition-colors group-hover:text-cyan-400"
                        style={{ color: 'hsl(var(--app-text-muted))' }}
                    >
                        Open Fly →
                    </span>
                </button>

                {/* Desktop app */}
                <DesktopDownloadCard />
            </div>

            <p className="mt-14 text-[10px] font-mono" style={{ color: 'hsl(var(--app-text-muted))' }}>
                Same account, same missions, either way.
            </p>
        </div>
    )
}

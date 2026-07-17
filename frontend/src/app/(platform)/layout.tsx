'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/controls/ThemeToggle'
import { ZoneBanner } from '@/components/controls/ZoneBanner'
import { useDrone } from '@/hooks/useDrone'
import { WebRTCProvider } from '@/contexts/WebRTCContext'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import Image from 'next/image'
import { Radio, Map, Bot, SlidersHorizontal, Settings, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSwarmStore } from '@/store/swarm'
import { FleetAside } from '@/components/swarm/FleetAside'

const NAV = [
    { href: '/fly',       label: 'Fly',     icon: Radio },
    { href: '/mission',   label: 'Mission',  icon: Map },
    { href: '/modules',   label: 'AI',       icon: Bot },
    { href: '/telemetry', label: 'Config',   icon: SlidersHorizontal },
    { href: '/settings',  label: 'Settings', icon: Settings },
]

// Mount socket ONCE at layout level — persists across all tab navigation
function DroneConnection() {
    useDrone()
    return null
}

// Lives inside WebRTCProvider so it can access streaming state
function PlatformNav() {
    const pathname = usePathname()
    const router = useRouter()
    const { isStreaming, stopStream } = useWebRTCContext()
    const { setMode, setCvResults } = useDroneStore()
    const [pendingHref, setPendingHref] = useState<string | null>(null)

    function handleNavClick(href: string, e: React.MouseEvent) {
        const onModulesPage = pathname === '/modules' || pathname.startsWith('/modules/')
        if (isStreaming && onModulesPage && href !== pathname) {
            e.preventDefault()
            setPendingHref(href)
        }
    }

    function handleLeave() {
        stopStream()
        getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
        setMode('manual-control')
        setCvResults(null)
        router.push(pendingHref!)
        setPendingHref(null)
    }

    function handleStay() {
        setPendingHref(null)
    }

    return (
        <>
            <aside
                className="w-16 flex flex-col items-center py-4 gap-1 shrink-0 border-r"
                style={{ background: 'hsl(var(--app-sidebar))', borderColor: 'hsl(var(--app-border))' }}
            >
                <div className="mb-6 p-2" title="HYRAK">
                    <Image src="/brand/icon-dark.png" alt="HYRAK" width={26} height={26}
                        className="dark:hidden" />
                    <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26}
                        className="hidden dark:block" />
                </div>

                {NAV.map(({ href, label, icon: Icon }) => {
                    const active = pathname === href || pathname.startsWith(href + '/')
                    return (
                        <Link
                            key={href}
                            href={href}
                            title={label}
                            onClick={(e) => handleNavClick(href, e)}
                            className={cn(
                                'flex flex-col items-center gap-1 w-12 py-2 rounded-lg text-xs transition-colors',
                                active
                                    ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                                    : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                            )}
                        >
                            <Icon size={18} />
                            <span className="text-[10px] font-mono">{label}</span>
                        </Link>
                    )
                })}

                <div className="mt-auto">
                    <ThemeToggle />
                </div>
            </aside>

            {/* Navigation guard popup */}
            {pendingHref && (
                <div
                    style={{
                        position: 'fixed', inset: 0, zIndex: 100,
                        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onClick={handleStay}
                >
                    <div
                        style={{
                            background: 'hsl(var(--app-surface))',
                            border: '1px solid hsl(var(--app-border))',
                            borderRadius: 16, padding: '24px 28px',
                            maxWidth: 360, width: '90%',
                            display: 'flex', flexDirection: 'column', gap: 16,
                            boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                                width: 36, height: 36, borderRadius: 10,
                                background: '#f59e0b18', border: '1px solid #f59e0b60',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                                <AlertTriangle size={18} style={{ color: '#f59e0b' }} />
                            </div>
                            <div>
                                <p style={{
                                    fontSize: 14, fontWeight: 600,
                                    color: 'hsl(var(--app-text))',
                                }}>
                                    Analysis is running
                                </p>
                                <p style={{
                                    fontSize: 12, color: 'hsl(var(--app-text-muted))',
                                    marginTop: 2,
                                }}>
                                    Leaving will stop the active analysis session.
                                </p>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <Button variant="outline" size="sm" onClick={handleStay}
                                className="font-mono text-xs">
                                Stay
                            </Button>
                            <Button variant="destructive" size="sm" onClick={handleLeave}
                                className="font-mono text-xs">
                                Stop &amp; Leave
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
    const [mounted, setMounted] = useState(false)
    const swarmEnabled = useSwarmStore(s => s.enabled)
    useEffect(() => { setMounted(true) }, [])

    return (
        <TooltipProvider>
            <DroneConnection />
            <WebRTCProvider>
                <div
                    className="flex h-screen overflow-hidden"
                    style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}
                >
                    <PlatformNav />
                    <ZoneBanner />
                    <main className="flex-1 overflow-hidden p-3 md:p-4">
                        {children}
                    </main>
                    {mounted && swarmEnabled && <FleetAside />}
                </div>
            </WebRTCProvider>
        </TooltipProvider>
    )
}

'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/controls/ThemeToggle'
import { ZoneBanner } from '@/components/controls/ZoneBanner'
import { UpdatePrompt } from '@/components/updater/UpdatePrompt'
import { LocalLinkPanel } from '@/components/controls/LocalLinkPanel'
import { useDrone, disconnectTelemetryLink } from '@/hooks/useDrone'
import { WebRTCProvider } from '@/contexts/WebRTCContext'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import Image from 'next/image'
import { Radio, Map, Bot, Package, SlidersHorizontal, Settings, AlertTriangle, LayoutDashboard, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUiMode } from '@/hooks/useUiMode'
import { useSwarmStore } from '@/store/swarm'
import { FleetAside } from '@/components/swarm/FleetAside'
import { StatusBar } from '@/components/layout/StatusBar'
import { getStatusBarEnabled, STATUSBAR_CHANGE_EVENT } from '@/lib/statusBarSettings'
import { useAuthGate, hasConsoleAccess } from '@/hooks/useAuthGate'
import { useClientValueOn, useHydrated } from '@/hooks/useClientValue'
import { WorkspaceSwitcher } from '@/components/layout/WorkspaceSwitcher'
import { CommandRefusalBanner } from '@/components/controls/CommandRefusalBanner'
import { useAccess } from '@/hooks/useAccess'
import { onWorkspaceSwitch } from '@/lib/workspaceSwitch'

const NAV = [
    { href: '/fly',       label: 'Fly',     icon: Radio },
    { href: '/command',   label: 'Command', icon: LayoutDashboard },
    { href: '/mission',   label: 'Mission',  icon: Map },
    { href: '/modules',   label: 'AI',       icon: Bot },
    { href: '/deliveries', label: 'Deliver', icon: Package },
    { href: '/telemetry', label: 'Config',   icon: SlidersHorizontal },
    { href: '/settings',  label: 'Settings', icon: Settings },
]

// Pages a customer-only account never opens (docs/ACCESS_MODEL.md section
// 8a): HYRAK's deliveries. The Mission tab is every customer's since phase
// 2b (their own workspace's plans and permits, section 8b).
const STAFF_ONLY_PATHS = ['/deliveries']
const isStaffOnlyPath = (path: string) => STAFF_ONLY_PATHS.some(p => path === p || path.startsWith(p + '/'))

// Mount socket ONCE at layout level - persists across all tab navigation
function DroneConnection() {
    useDrone()
    const { isCustomer } = useAccess()
    // Persisted swarm flag, read after mount (see store/swarm.ts hydrate).
    // Swarm and the fleet are staff-only: a customer never turns it on, even
    // when this tab last held a staff session.
    useEffect(() => { if (!isCustomer) useSwarmStore.getState().hydrate() }, [isCustomer])
    return null
}

// A customer's session belongs to one workspace, so switching ends it
// (lib/workspaceSwitch): stop the stream and release the drone link first,
// so nothing keeps feeding the old session while the socket reconnects.
function WorkspaceSwitchTeardown() {
    const { isStreaming, stopStream } = useWebRTCContext()
    const live = useRef({ isStreaming, stopStream })
    useEffect(() => { live.current = { isStreaming, stopStream } }, [isStreaming, stopStream])
    useEffect(() => onWorkspaceSwitch(async () => {
        if (live.current.isStreaming) live.current.stopStream()
        const st = useDroneStore.getState()
        if (st.mode !== 'manual-control') {
            getSocket().emit('set_analysis_mode', { mode: 'manual-control' })
            st.setMode('manual-control')
        }
        st.setCvResults(null)
        if (st.telemetryStatus !== 'disconnected') await disconnectTelemetryLink()
    }), [])
    return null
}

// Customer-only accounts with live access open only the session pages.
function StaffOnlyPathGuard() {
    const { isCustomer } = useAccess()
    const pathname = usePathname()
    const router = useRouter()
    const blocked = isCustomer && isStaffOnlyPath(pathname)
    useEffect(() => { if (blocked) router.replace('/command') }, [blocked, router])
    return null
}

// Lives inside WebRTCProvider so it can access streaming state
// Normal mode: three places with plain names. Dev mode: every tool.
const NAV_NORMAL = [
    { href: '/command',  label: 'Fly',      icon: Radio },
    { href: '/mission',  label: 'Plan',     icon: Map },
    { href: '/settings', label: 'Settings', icon: Settings },
]

// Customer-only accounts (docs/ACCESS_MODEL.md sections 8a, 8b): Fly, Plan,
// AI, Config and Settings in both modes, never Deliver.
const NAV_NORMAL_CUSTOMER = [
    { href: '/command',   label: 'Fly',      icon: Radio },
    { href: '/mission',   label: 'Plan',     icon: Map },
    { href: '/modules',   label: 'AI',       icon: Bot },
    { href: '/telemetry', label: 'Config',   icon: SlidersHorizontal },
    { href: '/settings',  label: 'Settings', icon: Settings },
]
const NAV_CUSTOMER = NAV.filter(n => !isStaffOnlyPath(n.href))

function navFor(normal: boolean, customer: boolean) {
    if (customer) return normal ? NAV_NORMAL_CUSTOMER : NAV_CUSTOMER
    return normal ? NAV_NORMAL : NAV
}

// The console entry point, for whoever can open /admin: staff (the HYRAK
// console) and customer owners and admins (the organization console). Its
// own tab, as the console page asks: a founder's console marks its socket
// session as admin, which must never be this flying tab's session.
function ConsoleLink({ normal }: { normal: boolean }) {
    const { user, workspaces } = useAccess()
    if (!user || !hasConsoleAccess(user, workspaces)) return null
    return (
        <a href="/admin" target="_blank" rel="noopener" title="Console (opens in a new tab)"
            className={cn(
                'flex flex-col items-center rounded-lg transition-colors',
                normal ? 'gap-1.5 w-20 py-3' : 'gap-1 w-12 py-2 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
            style={normal ? { color: 'var(--s-ink)' } : undefined}>
            <Building2 size={normal ? 22 : 18} />
            <span className={normal ? 'text-[14px] font-bold' : 'text-[10px] font-mono'}>Console</span>
        </a>
    )
}

function PlatformNav() {
    const [uiMode] = useUiMode()
    const normal = uiMode === 'normal'
    const { isCustomer } = useAccess()
    const nav = navFor(normal, isCustomer)
    const pathname = usePathname()
    const router = useRouter()
    const { isStreaming, stopStream } = useWebRTCContext()
    const setMode = useDroneStore(s => s.setMode)
    const setCvResults = useDroneStore(s => s.setCvResults)
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
                className={cn('flex flex-col items-center py-4 gap-1 shrink-0 border-r', normal ? 'hy-simple w-24 gap-2' : 'w-16')}
                style={normal ? { borderColor: 'var(--s-line)', background: 'var(--s-panel)' }
                    : { background: 'hsl(var(--app-sidebar))', borderColor: 'hsl(var(--app-border))' }}
            >
                <div className="mb-6 p-2" title="HYRAK">
                    {normal ? (
                        <Image src="/brand/icon-dark.png" alt="HYRAK" width={30} height={30} />
                    ) : (
                        <>
                            <Image src="/brand/icon-dark.png" alt="HYRAK" width={26} height={26}
                                className="dark:hidden" />
                            <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26}
                                className="hidden dark:block" />
                        </>
                    )}
                </div>

                <WorkspaceSwitcher normal={normal} />

                {nav.map(({ href, label, icon: Icon }) => {
                    const active = pathname === href || pathname.startsWith(href + '/')
                    return (
                        <Link
                            key={href}
                            href={href}
                            title={label}
                            onClick={(e) => handleNavClick(href, e)}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                                'flex flex-col items-center rounded-lg transition-colors',
                                normal ? 'gap-1.5 w-20 py-3' : 'gap-1 w-12 py-2 text-xs',
                                normal ? '' : active
                                    ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                                    : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                            )}
                            style={normal ? (active ? { background: 'var(--s-blue)', color: '#fff' } : { color: 'var(--s-ink)' }) : undefined}
                        >
                            <Icon size={normal ? 26 : 18} />
                            <span className={normal ? 'text-[16px] font-bold' : 'text-[10px] font-mono'}>{label}</span>
                        </Link>
                    )
                })}

                <div className="mt-auto flex flex-col items-center gap-1">
                    <ConsoleLink normal={normal} />
                    {!normal && <ThemeToggle />}
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
    // Every platform page is behind the login: no token, or a token the
    // server no longer accepts, goes to /login. The socket is not opened
    // until the check passes, so a signed-out tab never hits the server
    // with an empty credential. The landing page (/) stays public.
    //
    // Customer-only accounts get in when they can view a workspace (docs/
    // ACCESS_MODEL.md section 8a); without one they go to /account.
    const gate = useAuthGate('live')
    const mounted = useHydrated()
    const statusBarOn = useClientValueOn(STATUSBAR_CHANGE_EVENT, getStatusBarEnabled, false)
    const swarmEnabled = useSwarmStore(s => s.enabled)
    const { isCustomer } = useAccess()
    const pathname = usePathname()

    // Fly and Command carry their own status and flight controls - the global
    // bar would only duplicate them (and cover their OSD), so it's shown
    // everywhere else instead.
    const ownBar = ['/fly', '/command'].some(p => pathname === p || pathname.startsWith(p + '/'))
    const [uiMode] = useUiMode()
    const showStatusBar = mounted && statusBarOn && !ownBar && uiMode !== 'normal'

    if (gate !== 'ok') {
        return (
            <div className="flex h-full items-center justify-center"
                style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text-muted))' }}>
                <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.12em' }}>CHECKING SIGN-IN</span>
            </div>
        )
    }

    return (
        <TooltipProvider>
            <DroneConnection />
            <StaffOnlyPathGuard />
            <WebRTCProvider>
                <WorkspaceSwitchTeardown />
                <div
                    className="flex h-full overflow-hidden"
                    style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}
                >
                    <PlatformNav />
                    {/* Column to the right of the sidebar - status bar stays out of
                        the sidebar/logo area and persists across tab navigation
                        since this layout mounts once for the whole route group. */}
                    <div className="flex flex-col flex-1 overflow-hidden">
                        {showStatusBar && <StatusBar />}
                        <ZoneBanner />
                        <CommandRefusalBanner />
                        <main className="flex-1 overflow-hidden p-3 md:p-4"
                            style={uiMode === 'normal' ? { background: '#F4F7FB' } : undefined}>
                            {/* A staff-only page never renders for a customer,
                                not even for the frame before the redirect. */}
                            {isCustomer && isStaffOnlyPath(pathname) ? null : children}
                        </main>
                    </div>
                    {mounted && swarmEnabled && !isCustomer && <FleetAside />}
                </div>
                <UpdatePrompt />
                <LocalLinkPanel />
            </WebRTCProvider>
        </TooltipProvider>
    )
}

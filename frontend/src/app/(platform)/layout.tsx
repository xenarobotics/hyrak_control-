'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useTheme } from '@/lib/theme'
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
import { Radio, Map, Bot, Package, SlidersHorizontal, Settings, AlertTriangle, LayoutDashboard, Building2, Sun, Moon } from 'lucide-react'
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
import { TakeoverBanner } from '@/components/controls/TakeoverBanner'
import { RuleToasts } from '@/components/notifications/RuleToasts'
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
                'flex flex-col items-center rounded-[10px] transition-colors duration-[120ms]',
                normal ? 'gap-1.5 w-20 py-3' : RAIL_ITEM + ' ' + RAIL_IDLE,
            )}
            style={normal ? { color: 'var(--s-ink)' } : undefined}>
            <Building2 size={normal ? 22 : 20} />
            <span className={normal ? 'text-[14px] font-bold' : 'text-[12px] font-semibold'}>Console</span>
        </a>
    )
}

// Rail items (Dev mode). Muted text is the token that passes 4.5:1 on the
// sidebar in every theme; the active item is accent text on the accent wash.
const RAIL_ITEM = 'flex flex-col items-center justify-center gap-1 w-16 min-h-14 py-1.5'
const RAIL_IDLE = 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2'
const RAIL_ACTIVE = 'bg-app-accent-soft text-app-accent font-bold'

// The rail's quick theme switch. Same words as Settings (Dark, Midnight,
// Light); it flips between light and dark, and Settings reaches Midnight.
function RailThemeButton() {
    const { theme, setTheme } = useTheme()
    const mounted = useHydrated()
    if (!mounted) return <div className="w-16 h-14" />
    const light = theme === 'light'
    return (
        <button type="button" onClick={() => setTheme(light ? 'dark' : 'light')}
            title={light ? 'Switch to the dark theme' : 'Switch to the light theme'}
            className={cn('rounded-[10px] transition-colors duration-[120ms]', RAIL_ITEM, RAIL_IDLE)}>
            {light ? <Moon size={20} /> : <Sun size={20} />}
            <span className="text-[12px] font-semibold">{light ? 'Dark' : 'Light'}</span>
        </button>
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
            {/* A side rail from 768px up; below that a bottom tab bar, so the
                rail never eats a phone's width (design system 10). */}
            <aside
                aria-label="Main"
                className={cn(
                    'order-last flex shrink-0 flex-row items-stretch justify-around gap-0.5 border-t px-1 py-1',
                    'md:order-none md:flex-col md:items-center md:justify-start md:border-t-0 md:border-r md:px-0 md:py-4',
                    normal ? 'hy-simple md:w-24 md:gap-2' : 'md:w-[72px] md:gap-1',
                )}
                style={normal ? { borderColor: 'var(--s-line)', background: 'var(--s-panel)' }
                    : { background: 'hsl(var(--app-sidebar))', borderColor: 'hsl(var(--app-border))' }}
            >
                <div className="mb-4 hidden p-2 md:block" title="HYRAK">
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
                                'flex min-w-0 flex-1 flex-col items-center rounded-[10px] transition-colors duration-[120ms] md:flex-none',
                                normal ? 'gap-1 py-1.5 md:w-20 md:gap-1.5 md:py-3' : cn(RAIL_ITEM, 'w-auto md:w-16', active ? RAIL_ACTIVE : RAIL_IDLE),
                            )}
                            style={normal ? (active ? { background: 'var(--s-blue)', color: '#fff' } : { color: 'var(--s-ink)' }) : undefined}
                        >
                            <Icon size={normal ? 26 : 20} className="shrink-0" />
                            <span className={cn('whitespace-nowrap leading-tight', normal ? 'text-[14px] font-bold md:text-[16px]' : 'text-[12px] font-semibold')}>{label}</span>
                        </Link>
                    )
                })}

                <div className="mt-auto hidden flex-col items-center gap-1 md:flex">
                    <ConsoleLink normal={normal} />
                    {!normal && <RailThemeButton />}
                </div>
            </aside>

            {/* Navigation guard popup */}
            {pendingHref && (
                <div
                    style={{
                        position: 'fixed', inset: 0, zIndex: 100,
                        background: 'rgba(10,14,20,0.45)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onClick={handleStay}
                >
                    <div
                        style={{
                            background: 'hsl(var(--app-surface))',
                            border: '1px solid hsl(var(--app-border))',
                            borderRadius: 14, padding: 24,
                            maxWidth: 360, width: 'calc(100% - 32px)',
                            display: 'flex', flexDirection: 'column', gap: 16,
                            boxShadow: 'var(--app-shadow)',
                        }}
                        role="alertdialog" aria-modal="true" aria-labelledby="nav-guard-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 10,
                                background: 'var(--app-warn-soft)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                                <AlertTriangle size={20} style={{ color: 'var(--app-warn)' }} />
                            </div>
                            <div>
                                <p id="nav-guard-title" style={{
                                    fontSize: 18, fontWeight: 700,
                                    color: 'hsl(var(--app-text))',
                                }}>
                                    Analysis is running
                                </p>
                                <p style={{
                                    fontSize: 13, color: 'hsl(var(--app-text-muted))',
                                    marginTop: 2,
                                }}>
                                    Leaving stops it.
                                </p>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <Button variant="outline" onClick={handleStay}
                                className="h-9 px-3 text-[14px]" autoFocus>
                                Stay
                            </Button>
                            <Button variant="destructive" onClick={handleLeave}
                                className="h-9 px-3 text-[14px] font-semibold">
                                Stop and leave
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

    // ONE status bar for every page (docs/DESIGN_SYSTEM.md section 10). Fly
    // and Command no longer carry their own status strip or Kill, so the bar
    // is always on there whatever the Settings toggle says; elsewhere the
    // toggle still decides. Normal mode's Command (SimpleCommand) has its own
    // plain controls, so the bar stays off there.
    const flightPage = ['/fly', '/command'].some(p => pathname === p || pathname.startsWith(p + '/'))
    const [uiMode] = useUiMode()
    const normalCommand = uiMode === 'normal' && (pathname === '/command' || pathname.startsWith('/command/'))
    const showStatusBar = mounted && !normalCommand
        && (flightPage || (statusBarOn && uiMode !== 'normal'))

    if (gate !== 'ok') {
        return (
            <div className="flex h-full items-center justify-center"
                style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text-muted))' }}>
                <span role="status" style={{ fontSize: 13 }}>Checking sign-in</span>
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
                    className="flex h-full flex-col overflow-hidden md:flex-row"
                    style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}
                >
                    <PlatformNav />
                    {/* Column to the right of the sidebar - status bar stays out of
                        the sidebar/logo area and persists across tab navigation
                        since this layout mounts once for the whole route group. */}
                    <div className="flex min-h-0 min-w-0 flex-col flex-1 overflow-hidden">
                        {showStatusBar && <StatusBar tools={!flightPage} />}
                        <ZoneBanner />
                        <CommandRefusalBanner />
                        <TakeoverBanner />
                        <RuleToasts />
                        <main className="min-h-0 flex-1 overflow-hidden p-3 md:p-4"
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

'use client'

// The app shell's look for pages that live outside the (platform) group
// (/account and /admin open no live socket, so they cannot use its layout).
// Same rail as app/(platform)/layout.tsx: 72px on the left from 768px up,
// a bottom tab bar below that; the same 48px bar along the top, here holding
// the page title. Pages pass their own items, title and actions.

import * as React from 'react'
import Image from 'next/image'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FrameItem = {
    key: string
    label: string
    /** Tooltip, when the rail label is a short form. */
    title?: string
    icon: LucideIcon
    active?: boolean
    onClick?: () => void
    href?: string
    /** A small count in the corner (waiting permits). */
    badge?: number
}

// Same classes as the app rail (layout.tsx RAIL_ITEM / RAIL_IDLE / RAIL_ACTIVE).
const RAIL_ITEM = 'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 min-h-14 py-1.5 rounded-[10px] transition-colors duration-[140ms] md:w-16 md:flex-none'
const RAIL_IDLE = 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2'
const RAIL_ACTIVE = 'bg-app-accent-soft text-app-selected-ink font-bold'
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)]'

export function RailItem({ item }: { item: FrameItem }) {
    const { label, title, icon: Icon, active, onClick, href, badge } = item
    const body = (
        <>
            <Icon size={20} className="shrink-0" aria-hidden />
            <span className="whitespace-nowrap text-[12px] font-semibold leading-tight">{label}</span>
            {badge != null && badge > 0 && (
                <span className="absolute top-1 right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-app-warn px-1 text-[12px] font-bold tabular-nums text-app-accent-ink">
                    {badge}
                </span>
            )}
        </>
    )
    const cls = cn(RAIL_ITEM, active ? RAIL_ACTIVE : RAIL_IDLE, FOCUS)
    if (href) {
        return <a href={href} title={title ?? label} className={cls}>{body}</a>
    }
    return (
        <button type="button" onClick={onClick} title={title ?? label}
            aria-current={active ? 'page' : undefined} className={cn(cls, 'cursor-pointer')}>
            {body}
        </button>
    )
}

export function AppFrame({ items, railFooter, title, context, actions, children, label = 'Main' }: {
    items: FrameItem[]
    /** Extra rail entries at the bottom (desktop only, like the app's Console and theme). */
    railFooter?: React.ReactNode
    /** The page title: the one H1 on the page. */
    title: string
    /** One muted line after the title (hidden on phones). */
    context?: React.ReactNode
    /** Right side of the top bar. */
    actions?: React.ReactNode
    children: React.ReactNode
    label?: string
}) {
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-bg text-app-text md:flex-row">
            <aside aria-label={label}
                className={cn(
                    'order-last flex shrink-0 flex-row items-stretch justify-around gap-0.5 border-t border-app-border bg-app-sidebar px-1 py-1',
                    'md:order-none md:w-[72px] md:flex-col md:items-center md:justify-start md:gap-1 md:border-t-0 md:border-r md:px-0 md:py-4',
                )}>
                <div className="mb-4 hidden p-2 md:block" title="HYRAK">
                    <Image src="/brand/icon-dark.png" alt="HYRAK" width={26} height={26} className="dark:hidden" />
                    <Image src="/brand/icon.png" alt="HYRAK" width={26} height={26} className="hidden dark:block" />
                </div>
                {items.map(it => <RailItem key={it.key} item={it} />)}
                {railFooter && <div className="mt-auto hidden flex-col items-center gap-1 md:flex">{railFooter}</div>}
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <header className="relative z-[1100] flex h-12 shrink-0 items-center gap-3 border-b border-app-border bg-app-surface px-3 md:px-4 min-w-0">
                    <h1 className="m-0 truncate text-[22px] font-bold leading-7 text-app-text">{title}</h1>
                    {context && <span className="hidden min-w-0 truncate text-[13px] text-app-text-muted sm:inline">{context}</span>}
                    {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
                </header>
                {children}
            </div>
        </div>
    )
}

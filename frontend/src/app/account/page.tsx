'use client'

// /account - the whole app for an account with no live access: profile,
// password, devices and the active workspace's members and invites.
// Deliberately outside the (platform) group, which opens the live socket.
// Since phase 2a (docs/ACCESS_MODEL.md section 8a) customers with `view`
// on a workspace use the live app; this page is for accounts that can view
// none (no membership yet, or only disabled workspaces). Anyone with live
// access can still open it and gets a link back to the app.
//
// Same setup-screen layout as Settings: section navigation on the left,
// content up to 960px, headings instead of a card per group.

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { UserRound, Users, type LucideIcon } from 'lucide-react'
import { useAuthGate } from '@/hooks/useAuthGate'
import { useAccess } from '@/hooks/useAccess'
import { isCustomer, logout } from '@/lib/auth'
import { hasLiveAccess } from '@/hooks/useAuthGate'
import { cn } from '@/lib/utils'
import { DevicesGroup, PasswordGroup, ProfileGroup } from '@/components/settings/AccountSettings'
import { InvitesGroup, MembersGroup, WorkspaceGroup } from '@/components/settings/WorkspaceSettings'
import { S_LABEL, SButton } from '@/components/settings/primitives'

type Part = { id: string; label: string; icon: LucideIcon; blurb: string; sections: { label: string; Body: () => React.ReactNode }[] }

const PARTS: Part[] = [
    {
        id: 'account', label: 'Account', icon: UserRound,
        blurb: 'Your profile, password and signed-in devices',
        sections: [
            { label: 'Profile',    Body: ProfileGroup },
            { label: 'Password',   Body: PasswordGroup },
            { label: 'My devices', Body: DevicesGroup },
        ],
    },
    {
        id: 'workspace', label: 'Workspace', icon: Users,
        blurb: 'Who is in the active workspace, and invite links for new people',
        sections: [
            { label: 'Workspace', Body: WorkspaceGroup },
            { label: 'Members',   Body: MembersGroup },
            { label: 'Invites',   Body: InvitesGroup },
        ],
    },
]

export default function AccountPage() {
    const gate = useAuthGate('member')
    const { user, workspaces } = useAccess()
    const [partId, setPartId] = useState(PARTS[0].id)

    if (gate !== 'ok') {
        return (
            <div className="flex h-full items-center justify-center"
                style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text-muted))' }}>
                <span role="status" style={{ fontSize: 13 }}>Checking sign-in</span>
            </div>
        )
    }

    // The "next release" notice is only for an account that truly has no
    // viewable workspace; anyone with live access gets the way back instead.
    const live = !!user && hasLiveAccess(user, workspaces)
    const appHref = user && isCustomer(user) ? '/command' : '/fly'
    const part = PARTS.find(p => p.id === partId) ?? PARTS[0]

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}>
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-app-border bg-app-surface"
                style={{ minHeight: 56, padding: '8px clamp(16px, 3vw, 24px)' }}>
                <Image src="/brand/icon-dark.png" alt="" width={28} height={28} className="dark:hidden max-sm:hidden" />
                <Image src="/brand/icon.png" alt="" width={28} height={28} className="hidden sm:dark:block" />
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ fontSize: 18, lineHeight: '24px', fontWeight: 800, margin: 0, whiteSpace: 'nowrap' }}>Your account</h1>
                    <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {user?.display_name || user?.username}
                    </p>
                </div>
                {live && (
                    <Link href={appHref}
                        className="rounded-md px-2 text-app-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent"
                        style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, fontSize: 14, fontWeight: 700 }}>
                        Back to the app
                    </Link>
                )}
                <SButton onClick={() => { void logout().then(() => window.location.assign('/login')) }}>Sign out</SButton>
            </header>

            <div className="flex min-h-0 flex-1">
                <nav aria-label="Account sections" className="flex w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-app-border bg-app-surface px-2.5 py-5 max-md:hidden">
                    {PARTS.map(({ id, label, icon: Icon }) => {
                        const on = id === part.id
                        return (
                            <button key={id} onClick={() => setPartId(id)} aria-current={on ? 'page' : undefined}
                                className={cn(
                                    'relative flex min-h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-3 text-left text-[14px] transition-colors',
                                    on ? 'bg-app-accent-soft font-bold text-app-text'
                                        : 'font-semibold text-app-text-muted hover:bg-app-surface-2 hover:text-app-text',
                                )}>
                                <span aria-hidden className={cn('absolute inset-y-2 left-0 w-[3px] rounded-full bg-app-accent transition-opacity', on ? 'opacity-100' : 'opacity-0')} />
                                <Icon size={16} className={cn('shrink-0', on && 'text-app-accent')} />
                                {label}
                            </button>
                        )
                    })}
                </nav>

                <main className="min-w-0 flex-1 overflow-y-auto">
                    <div style={{ maxWidth: 824, padding: '24px clamp(16px, 3vw, 32px) 56px' }}>
                        {user && !live && (
                            <p style={{
                                margin: '0 0 20px', padding: '12px 16px', borderRadius: 10, fontSize: 14, lineHeight: 1.5,
                                border: '1px solid color-mix(in srgb, var(--app-warn) 40%, transparent)', background: 'var(--app-warn-soft)',
                            }}>
                                Your workspace is ready. Live flying arrives in the next release; for now,
                                manage your profile and invite your team here.
                            </p>
                        )}

                        {/* Phone width: the two parts become a segmented switch. */}
                        <div role="tablist" aria-label="Account sections" className="mb-5 grid grid-cols-2 gap-1 rounded-md border border-app-border bg-app-surface-2 p-1 md:hidden">
                            {PARTS.map(({ id, label }) => (
                                <button key={id} role="tab" aria-selected={id === part.id} onClick={() => setPartId(id)}
                                    className={cn('min-h-10 rounded-[5px] text-[14px] transition-colors',
                                        id === part.id ? 'bg-app-raised font-bold text-app-text shadow-sm' : 'font-semibold text-app-text-muted hover:text-app-text')}>
                                    {label}
                                </button>
                            ))}
                        </div>

                        <div key={part.id} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                            <h2 style={{ fontSize: 'var(--fs-xl)', lineHeight: '28px', fontWeight: 800, margin: 0 }}>{part.label}</h2>
                            <p style={{ fontSize: 14, color: 'hsl(var(--app-text-muted))', margin: '4px 0 0' }}>{part.blurb}</p>
                            {part.sections.map(({ label, Body }) => (
                                <section key={label} style={{ paddingTop: 28 }}>
                                    <h3 style={{ ...S_LABEL, margin: '0 0 4px' }}>{label}</h3>
                                    <Body />
                                </section>
                            ))}
                        </div>
                    </div>
                </main>
            </div>
        </div>
    )
}

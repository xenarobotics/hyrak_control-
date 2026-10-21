'use client'

// /account - the whole app for an account with no live access: profile,
// password, devices and the active workspace's members and invites.
// Deliberately outside the (platform) group, which opens the live socket.
// Since phase 2a (docs/ACCESS_MODEL.md section 8a) customers with `view`
// on a workspace use the live app; this page is for accounts that can view
// none (no membership yet, or only disabled workspaces). Anyone with live
// access can still open it and gets a link back to the app.
//
// The app shell's look (components/auth/AppFrame): the two parts sit in the
// rail like the app's tabs, the part's name is the page title in the top
// bar, and each group is a section heading below it.

import { useState } from 'react'
import { ArrowLeft, UserRound, Users, type LucideIcon } from 'lucide-react'
import { AppFrame, type FrameItem } from '@/components/auth/AppFrame'
import { useAuthGate } from '@/hooks/useAuthGate'
import { useAccess } from '@/hooks/useAccess'
import { isCustomer, logout } from '@/lib/auth'
import { hasLiveAccess } from '@/hooks/useAuthGate'
import { DevicesGroup, PasswordGroup, ProfileGroup } from '@/components/settings/AccountSettings'
import { InvitesGroup, MembersGroup, WorkspaceGroup } from '@/components/settings/WorkspaceSettings'
import { SButton } from '@/components/settings/primitives'

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

    const items: FrameItem[] = PARTS.map(({ id, label, icon }) => ({
        key: id, label, icon, active: id === part.id, onClick: () => setPartId(id),
    }))
    if (live) items.push({ key: 'app', label: 'App', title: 'Back to the app', icon: ArrowLeft, href: appHref })

    return (
        <AppFrame label="Account sections" items={items} title={part.label}
            context={user?.display_name || user?.username}
            actions={<SButton onClick={() => { void logout().then(() => window.location.assign('/login')) }}>Sign out</SButton>}>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <div style={{ maxWidth: 824, padding: '20px clamp(16px, 3vw, 32px) 56px' }}>
                    {user && !live && (
                        <p style={{
                            margin: '0 0 20px', padding: '12px 16px', borderRadius: 10, fontSize: 14, lineHeight: 1.5,
                            border: '1px solid color-mix(in srgb, var(--app-warn) 40%, transparent)', background: 'var(--app-warn-soft)',
                        }}>
                            Your workspace is ready. Live flying arrives in the next release; for now,
                            manage your profile and invite your team here.
                        </p>
                    )}

                    <div key={part.id} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                        <p style={{ fontSize: 14, color: 'hsl(var(--app-text-muted))', margin: 0 }}>{part.blurb}</p>
                        {part.sections.map(({ label, Body }) => (
                            <section key={label} style={{ paddingTop: 28 }}>
                                <h2 style={{ fontSize: 18, lineHeight: '24px', fontWeight: 700, color: 'hsl(var(--app-text))', margin: '0 0 4px' }}>{label}</h2>
                                <Body />
                            </section>
                        ))}
                    </div>
                </div>
            </main>
        </AppFrame>
    )
}

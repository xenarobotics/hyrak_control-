'use client'

// /account - the whole app for a customer-only account in phase 1
// (docs/ACCESS_MODEL.md section 8): profile, password, devices and the
// active workspace's members and invites. Deliberately outside the
// (platform) group: that layout opens the live socket, which the server
// refuses for these accounts until phase 2 scopes live sessions per
// workspace. Staff can open it too; they get a link back to the app.

import Image from 'next/image'
import Link from 'next/link'
import { useAuthGate } from '@/hooks/useAuthGate'
import { useAccess } from '@/hooks/useAccess'
import { logout } from '@/lib/auth'
import { DevicesGroup, PasswordGroup, ProfileGroup } from '@/components/settings/AccountSettings'
import { InvitesGroup, MembersGroup, WorkspaceGroup } from '@/components/settings/WorkspaceSettings'
import { S_LABEL, SButton } from '@/components/settings/primitives'

const SECTIONS: { label: string; Body: () => React.ReactNode }[] = [
    { label: 'PROFILE',    Body: ProfileGroup },
    { label: 'PASSWORD',   Body: PasswordGroup },
    { label: 'MY DEVICES', Body: DevicesGroup },
    { label: 'WORKSPACE',  Body: WorkspaceGroup },
    { label: 'MEMBERS',    Body: MembersGroup },
    { label: 'INVITES',    Body: InvitesGroup },
]

export default function AccountPage() {
    const gate = useAuthGate('member')
    const { user } = useAccess()

    if (gate !== 'ok') {
        return (
            <div className="flex h-full items-center justify-center"
                style={{ background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text-muted))' }}>
                <span style={{ fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.12em' }}>CHECKING SIGN-IN</span>
            </div>
        )
    }

    const member = user?.role === 'member'
    return (
        <div style={{ height: '100%', overflowY: 'auto', background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))' }}>
            <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 48px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Image src="/brand/icon-dark.png" alt="" width={28} height={28} className="dark:hidden" />
                    <Image src="/brand/icon.png" alt="" width={28} height={28} className="hidden dark:block" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Your account</p>
                        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>
                            {user?.display_name || user?.username}
                        </p>
                    </div>
                    {!member && (
                        <Link href="/fly" style={{ fontSize: 12, fontFamily: 'monospace', color: '#22d3ee' }}>Back to the app</Link>
                    )}
                    <SButton onClick={() => { void logout().then(() => window.location.assign('/login')) }}>Sign out</SButton>
                </header>

                {member && (
                    <p style={{
                        margin: 0, padding: '10px 14px', borderRadius: 10, fontSize: 12, lineHeight: 1.5,
                        border: '1px solid #f59e0b60', background: '#f59e0b14',
                    }}>
                        Your workspace is set up. Live video, telemetry and flying for customer
                        workspaces are switched on in the next release; until then you can manage
                        your profile and invite your team here.
                    </p>
                )}

                {SECTIONS.map(({ label, Body }) => (
                    <section key={label} style={{
                        padding: '14px 18px', borderRadius: 14,
                        background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))',
                    }}>
                        <p style={{ ...S_LABEL, margin: '0 0 6px' }}>{label}</p>
                        <Body />
                    </section>
                ))}
            </div>
        </div>
    )
}

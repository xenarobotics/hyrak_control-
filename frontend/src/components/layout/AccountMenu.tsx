'use client'

// The account menu at the foot of the rail (in the bottom tab bar on a
// phone): who is signed in, the workspace this browser is "in", Settings
// and Sign out. The workspace choice used to be its own tile at the top of
// the rail; it lives here now.
//
// Staff: the workspace list shows when they can reach more than one; the
// choice is a UI choice (their live session stays on HYRAK).
//
// Customer-only accounts (docs/ACCESS_MODEL.md section 8a): the active
// workspace is what their live session can reach, and the list holds only
// workspaces they can view. Picking another one stops the stream, releases
// the drone link and reconnects the socket (lib/workspaceSwitch).

import { useRouter } from 'next/navigation'
import { Building2, LogOut, Settings } from 'lucide-react'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
    DropdownMenuRadioItem, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuItem,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useAccess, useActiveWorkspace } from '@/hooks/useAccess'
import { KIND_LABELS, roleLabel } from '@/lib/access'
import { logout } from '@/lib/auth'
import { cn } from '@/lib/utils'

// Two letters that never read as a glyph: "IITH" gave "II", which in a
// filled tile looked like a pause button. One word takes its first and last
// letters ("IH"), more words their first letters; a repeated letter falls
// back to the first letter alone.
function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return '?'
    const pair = words.length === 1
        ? words[0][0] + (words[0].length > 1 ? words[0][words[0].length - 1] : '')
        : words[0][0] + words[1][0]
    const up = pair.toUpperCase()
    return up.length === 2 && up[0] === up[1] ? up[0] : up
}

export function AccountMenu({ normal }: { normal: boolean }) {
    const router = useRouter()
    const { user, isCustomer, isFounder } = useAccess()
    const { workspace, workspaces, setActive } = useActiveWorkspace()
    if (!user) return null

    const name = user.display_name?.trim() || user.username
    const kind = isFounder ? 'Founder' : isCustomer ? 'Customer' : 'HYRAK staff'
    const canSwitch = !!workspace && (isCustomer || workspaces.length > 1)
    const label = workspace ? `${name}, workspace ${workspace.name}` : name

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                title={`Account: ${label}`}
                aria-label={`Account: ${label}. Open the account menu`}
                className={cn(
                    'flex min-w-0 flex-1 flex-col items-center justify-center rounded-[10px] transition-colors duration-[140ms] md:flex-none',
                    normal ? 'gap-1 py-1.5 md:w-20 md:gap-1.5 md:py-2' : 'w-auto min-h-14 gap-1 py-1.5 md:w-16 text-app-text-muted hover:text-app-text hover:bg-app-surface-2',
                )}
                style={normal ? { color: 'var(--s-ink)' } : undefined}
            >
                <span className={cn(
                    'flex items-center justify-center rounded-full font-extrabold',
                    normal ? 'h-8 w-8 text-[13px]' : 'h-8 w-8 text-[12px] border border-app-border-strong bg-app-surface-2 text-app-text',
                )}
                    style={normal ? { background: 'var(--s-blue-soft)', color: 'var(--s-blue)' } : undefined}>
                    {initials(name)}
                </span>
                <span className={cn('whitespace-nowrap leading-tight', normal ? 'text-[14px] font-bold' : 'text-[12px] font-semibold')}>
                    Account
                </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-72">
                <div className="flex items-center gap-2.5 px-2 py-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-app-border-strong bg-app-surface-2 text-[13px] font-extrabold text-app-text">
                        {initials(name)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[14px] font-bold text-app-text">{name}</span>
                        <span className="truncate text-[12px] text-app-text-muted">{user.email || user.username} - {kind}</span>
                    </span>
                </div>
                {workspace && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel className="flex items-center gap-1.5 text-[12px] font-bold">
                                <Building2 size={14} /> Workspace
                            </DropdownMenuLabel>
                            {canSwitch ? (
                                <>
                                    {isCustomer && workspaces.length > 1 && (
                                        <p className="px-2 pb-1.5 text-[12px] leading-snug text-app-text-muted">
                                            Switching ends the live session: video stops and the drone link is released.
                                        </p>
                                    )}
                                    <DropdownMenuRadioGroup value={workspace.id} onValueChange={v => setActive(String(v))}>
                                        {workspaces.map(w => (
                                            <DropdownMenuRadioItem key={w.id} value={w.id} className="items-start">
                                                <span className="flex min-w-0 flex-col">
                                                    <span className="truncate">{w.name}</span>
                                                    <span className="truncate text-[12px] text-app-text-muted">
                                                        {KIND_LABELS[w.kind] ?? w.kind}
                                                        {w.my_role ? ` - ${roleLabel(w.my_role, w.kind)}` : ''}
                                                        {w.inherited ? ' (inherited)' : ''}
                                                    </span>
                                                </span>
                                            </DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
                                </>
                            ) : (
                                <p className="px-2 pb-1.5 text-[14px] text-app-text">{workspace.name}</p>
                            )}
                        </DropdownMenuGroup>
                    </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push('/settings')}>
                    <Settings size={16} /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { void logout().then(() => window.location.assign('/login')) }}>
                    <LogOut size={16} /> Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

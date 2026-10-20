'use client'

// Sidebar workspace switcher: the workspace this browser is "in".
//
// Staff: shown when they can reach more than one workspace; the choice is a
// UI choice (their live session stays on HYRAK).
//
// Customer-only accounts (docs/ACCESS_MODEL.md section 8a): always shown,
// since the active workspace is what their live session can reach, and it
// lists only workspaces they can view. Picking another one stops the stream,
// releases the drone link and reconnects the socket (lib/workspaceSwitch).

import { Building2 } from 'lucide-react'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
    DropdownMenuRadioItem, DropdownMenuTrigger, DropdownMenuGroup,
} from '@/components/ui/dropdown-menu'
import { useAccess, useActiveWorkspace } from '@/hooks/useAccess'
import { KIND_LABELS, roleLabel } from '@/lib/access'
import { cn } from '@/lib/utils'

function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return '?'
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
    return (words[0][0] + words[1][0]).toUpperCase()
}

export function WorkspaceSwitcher({ normal }: { normal: boolean }) {
    const { workspace, workspaces, setActive } = useActiveWorkspace()
    const { isCustomer } = useAccess()
    if (!workspace || (!isCustomer && workspaces.length <= 1)) return null

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                title={`Workspace: ${workspace.name}`}
                aria-label={`Workspace: ${workspace.name}. Switch workspace`}
                className={cn(
                    'flex flex-col items-center rounded-[10px] border transition-colors duration-[120ms]',
                    normal ? 'mb-3 w-20 gap-1 py-2' : 'w-12 gap-1 py-1.5 md:mb-3',
                    normal ? '' : 'border-app-border text-app-text-muted hover:text-app-text hover:bg-app-surface-2',
                )}
                style={normal ? { borderColor: 'var(--s-line)', color: 'var(--s-ink)' } : undefined}
            >
                <span className={cn(
                    'flex items-center justify-center rounded-md font-bold',
                    normal ? 'h-8 w-8 text-[14px]' : 'h-7 w-7 text-[12px] bg-app-accent-soft text-app-accent',
                )}
                    style={normal ? { background: 'var(--s-blue-soft)', color: 'var(--s-blue)' } : undefined}>
                    {initials(workspace.name)}
                </span>
                <span className={cn('max-w-full truncate px-1 text-[12px]', normal ? 'font-bold' : 'font-semibold')}>
                    {workspace.name}
                </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-64">
                <DropdownMenuGroup>
                    <DropdownMenuLabel className="flex items-center gap-1.5 text-[12px] font-bold tracking-[0.06em]">
                        <Building2 size={14} /> WORKSPACE
                    </DropdownMenuLabel>
                    {isCustomer && workspaces.length > 1 && (
                        <p className="px-2 pb-1.5 text-[12px] leading-snug text-muted-foreground">
                            Switching ends the live session: video stops and the drone link is released.
                        </p>
                    )}
                    <DropdownMenuRadioGroup value={workspace.id} onValueChange={v => setActive(String(v))}>
                        {workspaces.map(w => (
                            <DropdownMenuRadioItem key={w.id} value={w.id} className="items-start">
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate">{w.name}</span>
                                    <span className="truncate text-[12px] text-muted-foreground">
                                        {KIND_LABELS[w.kind] ?? w.kind}
                                        {w.my_role ? ` - ${roleLabel(w.my_role, w.kind)}` : ''}
                                        {w.inherited ? ' (inherited)' : ''}
                                    </span>
                                </span>
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

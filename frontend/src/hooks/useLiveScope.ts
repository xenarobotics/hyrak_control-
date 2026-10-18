'use client'

/**
 * What the live app offers this account (docs/ACCESS_MODEL.md section 8a).
 *
 * Staff see exactly what they saw before 2a: `customer` is false and
 * `canFly` true, whatever workspace is picked. A customer-only account is
 * scoped to its active workspace: the perms come from the server's
 * session_ready when it is for that workspace, else from the cached
 * workspace list. A customer without `fly` is a viewer: read-only UI.
 *
 * This only decides what the UI offers. The server checks every event.
 */
import { useActiveWorkspace, useAccess } from '@/hooks/useAccess'
import { useDroneStore } from '@/store/drone'
import type { Perm, WorkspaceInfo } from '@/lib/access'

export interface LiveScope {
    customer: boolean
    workspace: WorkspaceInfo | null
    perms: Perm[]
    canFly: boolean
    viewOnly: boolean
}

export function useLiveScope(): LiveScope {
    const { isCustomer: customer } = useAccess()
    const { workspace } = useActiveWorkspace()
    const session = useDroneStore(s => s.session)
    const sessionPerms = session?.perms && session.workspace_id === workspace?.id ? session.perms : null
    const perms = sessionPerms ?? workspace?.perms ?? []
    const canFly = !customer || perms.includes('fly')
    return { customer, workspace, perms, canFly, viewOnly: customer && !canFly }
}

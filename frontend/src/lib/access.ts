/**
 * The access model in types and pure helpers: workspaces, scoped roles,
 * permissions, and who may grant what (docs/ACCESS_MODEL.md sections 1-3).
 *
 * Nothing here talks to the server or the DOM, so it is safe to import from
 * any component. The server is always the final check: these helpers only
 * decide what the UI offers, never what is allowed.
 */

export type WorkspaceKind = 'platform' | 'organization' | 'individual' | 'client'
export type MemberRole = 'founder' | 'airspace' | 'manager' | 'owner' | 'admin' | 'pilot' | 'viewer'
export type ZoneLayer = 'regulatory' | 'area' | 'site'

export type Perm =
    | 'view' | 'fly' | 'plan' | 'models.run' | 'models.manage' | 'drones.manage'
    | 'members.manage' | 'children.manage' | 'zones.site' | 'zones.area'
    | 'permits.approve' | 'workspace.operating_area' | 'audit.view'
    | 'workspace.delete' | 'zones.regulatory' | 'staff.manage' | 'accounts'

export type GeoPolygon =
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface Membership {
    id: string
    workspace_id: string
    workspace_name: string
    workspace_kind: WorkspaceKind
    role: MemberRole
    area: GeoPolygon | null
    title: string | null
}

export interface WorkspaceInfo {
    id: string
    name: string
    kind: WorkspaceKind
    parent_id: string | null
    path: string
    operating_area: GeoPolygon | null
    my_role: MemberRole | null
    perms: Perm[]
    inherited: boolean
    disabled?: boolean
    /** Paid extras a founder switched on, e.g. { cloud_sim: true }. */
    features?: Record<string, boolean>
}

export const ROLE_LABELS: Record<MemberRole, string> = {
    founder: 'Founder',
    airspace: 'Airspace manager',
    manager: 'Manager / service operator',
    owner: 'Owner',
    admin: 'Admin',
    pilot: 'Pilot',
    viewer: 'Viewer',
}

export const KIND_LABELS: Record<WorkspaceKind, string> = {
    platform: 'Platform',
    organization: 'Organization',
    individual: 'Individual',
    client: 'Client',
}

export const LAYER_LABELS: Record<ZoneLayer, string> = {
    regulatory: 'Regulatory',
    area: 'Area',
    site: 'Site',
}

/** "HYRAK pilot" on the platform workspace, plain "Pilot" on a customer's. */
export function roleLabel(role: MemberRole | null | undefined, kind?: WorkspaceKind): string {
    if (!role) return '-'
    if (kind === 'platform' && (role === 'pilot' || role === 'viewer')) return `HYRAK ${role}`
    return ROLE_LABELS[role] ?? role
}

/** Roles that exist on a workspace of this kind, in rank order. */
export const ROLES_FOR_KIND: Record<WorkspaceKind, MemberRole[]> = {
    platform: ['founder', 'airspace', 'pilot', 'viewer'],
    organization: ['manager', 'owner', 'admin', 'pilot', 'viewer'],
    individual: ['manager', 'owner', 'admin', 'pilot', 'viewer'],
    client: ['manager', 'owner', 'admin', 'pilot', 'viewer'],
}

export function hasPerm(ws: WorkspaceInfo | null | undefined, perm: Perm): boolean {
    return !!ws && ws.perms.includes(perm)
}

/**
 * Roles the caller may hand out on `ws` ("Who may grant what"). Founders may
 * grant anything; owners, admins and managers grant customer roles in their
 * subtree. `pickable` drops airspace, which always needs an area drawn and
 * is granted from the console's STAFF tab; `invite` also drops manager,
 * which goes only to existing staff.
 */
export function grantableRoles(
    ws: WorkspaceInfo | null | undefined,
    isFounder: boolean,
    opts: { invite?: boolean; pickable?: boolean } = {},
): MemberRole[] {
    if (!ws) return []
    const exist = ROLES_FOR_KIND[ws.kind] ?? []
    let out: MemberRole[]
    if (isFounder) out = exist
    else if (ws.kind === 'platform') out = []
    else if (ws.my_role === 'owner' || ws.my_role === 'manager') out = ['owner', 'admin', 'pilot', 'viewer']
    else if (ws.my_role === 'admin') out = ['admin', 'pilot', 'viewer']
    else out = []
    out = out.filter(r => exist.includes(r))
    if (opts.invite || opts.pickable) out = out.filter(r => r !== 'airspace')
    if (opts.invite) out = out.filter(r => r !== 'manager')
    return out
}

/** Whether the caller may change or remove a membership of `role` on `ws`. */
export function canTouchMember(
    ws: WorkspaceInfo | null | undefined,
    role: MemberRole,
    isFounder: boolean,
): boolean {
    if (!hasPerm(ws, 'members.manage') && !isFounder) return false
    return grantableRoles(ws, isFounder).includes(role)
}

export interface WorkspaceNode extends WorkspaceInfo { children: WorkspaceNode[] }

const KIND_ORDER: Record<WorkspaceKind, number> = { platform: 0, organization: 1, individual: 2, client: 3 }

/** Flat list -> tree. A workspace whose parent the caller cannot see becomes a root. */
export function buildTree(list: WorkspaceInfo[]): WorkspaceNode[] {
    const nodes = new Map<string, WorkspaceNode>()
    for (const w of list) nodes.set(w.id, { ...w, children: [] })
    const roots: WorkspaceNode[] = []
    for (const n of nodes.values()) {
        const parent = n.parent_id ? nodes.get(n.parent_id) : undefined
        if (parent) parent.children.push(n)
        else roots.push(n)
    }
    const sort = (arr: WorkspaceNode[]) => {
        arr.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
        arr.forEach(n => sort(n.children))
    }
    sort(roots)
    return roots
}

/** The platform workspace, when the caller can see it. */
export function platformOf(list: WorkspaceInfo[]): WorkspaceInfo | null {
    return list.find(w => w.kind === 'platform') ?? null
}

/** `ws` and its ancestors, nearest first, as far as the caller can see. */
function lineage(ws: WorkspaceInfo, list: WorkspaceInfo[]): WorkspaceInfo[] {
    const byId = new Map(list.map(w => [w.id, w]))
    const out: WorkspaceInfo[] = []
    let cur: WorkspaceInfo | undefined = ws
    while (cur && out.length < 16) {
        out.push(cur)
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return out
}

export const ZONE_LAYER_PERM: Record<ZoneLayer, Perm> = {
    regulatory: 'zones.regulatory',
    area: 'zones.area',
    site: 'zones.site',
}

/**
 * The polygon the caller may draw a `layer` zone inside, on `ws` (section 3).
 * null means "no outline to show": regulatory zones go anywhere, and a
 * workspace without an operating area has nothing to draw against yet.
 * Area zones use the caller's membership area (on this workspace or the
 * nearest ancestor that carries one), else the operating area.
 */
export function editableArea(
    ws: WorkspaceInfo | null | undefined,
    layer: ZoneLayer,
    memberships: Membership[],
    list: WorkspaceInfo[],
): GeoPolygon | null {
    if (!ws || layer === 'regulatory') return null
    if (layer === 'area') {
        const chain = lineage(ws, list)
        for (const w of chain) {
            const m = memberships.find(x => x.workspace_id === w.id && x.area)
            if (m?.area) return m.area
        }
        // Airspace managers hold their area on the platform workspace and it
        // applies across every workspace.
        const air = memberships.find(x => x.role === 'airspace' && x.area)
        if (air?.area) return air.area
    }
    return ws.operating_area
}

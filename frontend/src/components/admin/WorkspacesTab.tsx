'use client'

// WORKSPACES tab of the HYRAK console: the tree of workspaces the caller can
// see (platform > organizations / individuals > clients) and, for the one
// selected, its members (direct and inherited), invites, drones and
// operating area. Founders create organizations and individuals; anyone
// with children.manage on an organization creates its clients. Every action
// is re-checked by the server and its message is shown verbatim.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import dynamic from 'next/dynamic'
import { ChevronRight } from 'lucide-react'
import { fetchMe } from '@/lib/auth'
import { useAccess } from '@/hooks/useAccess'
import {
    KIND_LABELS, buildTree, canTouchMember, grantableRoles, hasPerm, platformOf, roleLabel,
    type MemberRole, type WorkspaceInfo, type WorkspaceKind, type WorkspaceNode,
} from '@/lib/access'
import {
    absoluteUrl, addMember, createInvite, createWorkspace, deleteWorkspace, fmtWhen, isPendingInvite,
    listInvites, listMembers, listWorkspaceDrones, listWorkspaces, moveDrone, personName, removeMember,
    revokeInvite, updateMember, updateWorkspace, type ApiResult, type Invite, type Member, type WorkspaceDrone,
} from '@/lib/workspaces'
import { pointsFromPolygon, polygonFromPoints, type ZoneFeature } from '@/components/admin/zones'
import type { Outline } from '@/components/admin/AreaMap'
import { Btn, CopyLink, Empty, INPUT_CLS, LABEL_CLS, Notice, Section, Tag } from '@/components/admin/console'
import { ActivitySection } from '@/components/admin/ActivitySection'

const AreaMap = dynamic(() => import('@/components/admin/AreaMap'), { ssr: false })

const KIND_TAG: Record<WorkspaceKind, string> = { platform: 'HYRAK', organization: 'ORG', individual: 'IND', client: 'CLIENT' }

type CreateDraft = { kind: WorkspaceKind; parentId: string | null; parentName: string }

export default function WorkspacesTab({ zones }: { zones: ZoneFeature[] }) {
    const { isFounder } = useAccess()
    const [list, setList] = useState<WorkspaceInfo[] | null>(null)
    const [loadError, setLoadError] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [create, setCreate] = useState<CreateDraft | null>(null)
    const [createName, setCreateName] = useState('')
    const [createError, setCreateError] = useState('')
    const [creating, setCreating] = useState(false)

    const reload = useCallback(async () => {
        const r = await listWorkspaces()
        if (r.ok) { setList(r.data); setLoadError('') } else setLoadError(r.error)
    }, [])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reload sets state only after its fetch resolves
        void reload()
    }, [reload])

    // Something changed the caller's view of the world: refresh the tree and
    // the cached /auth/me (sidebar switcher, settings).
    const changed = useCallback(() => { void reload(); void fetchMe() }, [reload])

    const platform = list ? platformOf(list) : null
    const tree = list ? buildTree(list) : []
    const selected = list?.find(w => w.id === selectedId) ?? null

    const startCreate = (kind: WorkspaceKind, parent: WorkspaceInfo | null) => {
        setCreate({ kind, parentId: parent?.id ?? null, parentName: parent?.name ?? '' })
        setCreateName('')
        setCreateError('')
    }

    async function submitCreate(e: FormEvent) {
        e.preventDefault()
        if (!create || creating) return
        if (!createName.trim()) { setCreateError('Enter a name.'); return }
        setCreating(true); setCreateError('')
        const r = await createWorkspace({ name: createName.trim(), kind: create.kind, parent_id: create.parentId })
        setCreating(false)
        if (!r.ok) { setCreateError(r.error); return }
        const made = r.data && 'workspace' in r.data ? r.data.workspace : r.data as WorkspaceInfo
        setCreate(null)
        if (made?.id) setSelectedId(made.id)
        changed()
    }

    return (
        <div className="flex-1 flex min-w-0">
            {/* Tree column */}
            <div className="w-80 shrink-0 border-r border-zinc-800 flex flex-col">
                <div className="px-3 py-2.5 text-[10px] tracking-widest text-zinc-500 border-b border-zinc-800 flex items-center gap-2">
                    WORKSPACES - {list?.length ?? 0}
                    {isFounder && platform && (
                        <span className="ml-auto flex gap-1.5">
                            <Btn tone="cyan" onClick={() => startCreate('organization', platform)}>+ ORG</Btn>
                            <Btn tone="cyan" onClick={() => startCreate('individual', platform)}>+ INDIVIDUAL</Btn>
                        </span>
                    )}
                </div>

                {create && (
                    <form onSubmit={e => void submitCreate(e)} className="p-3 space-y-2 border-b border-zinc-800">
                        <div className="text-[10px] text-zinc-400">
                            NEW {KIND_LABELS[create.kind].toUpperCase()}
                            {create.parentName && <span className="text-zinc-600"> in {create.parentName}</span>}
                        </div>
                        <input autoFocus value={createName} onChange={e => { setCreateName(e.target.value); setCreateError('') }}
                            placeholder="name" aria-label="Workspace name" className={`${INPUT_CLS} w-full`} />
                        <Notice error={createError} />
                        <div className="flex gap-2">
                            <Btn type="submit" tone="emerald" disabled={creating} className="flex-1">
                                {creating ? 'CREATING…' : 'CREATE'}
                            </Btn>
                            <Btn onClick={() => setCreate(null)}>CANCEL</Btn>
                        </div>
                    </form>
                )}

                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                    {list === null && !loadError && <Empty>Loading workspaces…</Empty>}
                    {loadError && (
                        <div className="p-2 space-y-2">
                            <Notice error={loadError} />
                            <Btn onClick={() => void reload()}>RETRY</Btn>
                        </div>
                    )}
                    {list?.length === 0 && <Empty>No workspaces visible to you.</Empty>}
                    {tree.map(n => (
                        <TreeNode key={n.id} node={n} depth={0} selectedId={selectedId} onSelect={setSelectedId} />
                    ))}
                </div>
            </div>

            {/* Detail */}
            <div className="flex-1 overflow-y-auto">
                {!selected ? (
                    <div className="h-full flex items-center justify-center text-xs text-zinc-600">
                        Select a workspace to manage it
                    </div>
                ) : (
                    <WorkspaceDetail key={selected.id} ws={selected} list={list ?? []} zones={zones}
                        isFounder={isFounder} onChanged={changed}
                        onDeleted={() => { setSelectedId(null); changed() }}
                        onSelect={setSelectedId}
                        onCreateClient={() => startCreate('client', selected)} />
                )}
            </div>
        </div>
    )
}

function TreeNode({ node, depth, selectedId, onSelect }: {
    node: WorkspaceNode; depth: number; selectedId: string | null; onSelect: (id: string) => void
}) {
    const [open, setOpen] = useState(depth < 1)
    const has = node.children.length > 0
    const sel = node.id === selectedId
    return (
        <div>
            <div className={'flex items-center gap-1 rounded border transition-colors ' +
                (sel ? 'border-cyan-500 bg-cyan-500/5' : 'border-transparent hover:border-zinc-700')}
                style={{ paddingLeft: depth * 14 }}>
                <button onClick={() => setOpen(o => !o)} disabled={!has}
                    aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
                    className="w-5 h-7 flex items-center justify-center text-zinc-600 hover:text-zinc-300 disabled:opacity-0">
                    <ChevronRight size={12} className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
                </button>
                <button onClick={() => onSelect(node.id)} className="flex-1 min-w-0 text-left py-1.5 pr-2 flex items-center gap-2 text-xs">
                    <span className={'truncate ' + (node.disabled ? 'text-zinc-600 line-through' : 'text-zinc-100')}>{node.name}</span>
                    <Tag label={KIND_TAG[node.kind]} tone={node.kind === 'platform' ? 'cyan' : 'zinc'} />
                    {node.my_role && (
                        <span className="ml-auto text-[9px] text-zinc-600 truncate">
                            {roleLabel(node.my_role, node.kind).toUpperCase()}{node.inherited ? ' ↓' : ''}
                        </span>
                    )}
                </button>
            </div>
            {open && node.children.map(c => (
                <TreeNode key={c.id} node={c} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
            ))}
        </div>
    )
}

type Res = ApiResult<unknown>

function WorkspaceDetail({ ws, list, zones, isFounder, onChanged, onDeleted, onSelect, onCreateClient }: {
    ws: WorkspaceInfo
    list: WorkspaceInfo[]
    zones: ZoneFeature[]
    isFounder: boolean
    onChanged: () => void
    onDeleted: () => void
    onSelect: (id: string) => void
    onCreateClient: () => void
}) {
    const { user } = useAccess()
    const canMembers = hasPerm(ws, 'members.manage') || isFounder
    const canDrones = hasPerm(ws, 'drones.manage') || isFounder
    const canArea = hasPerm(ws, 'workspace.operating_area') || isFounder
    const canChildren = ws.kind === 'organization' && (hasPerm(ws, 'children.manage') || isFounder)
    const canDelete = hasPerm(ws, 'workspace.delete') || isFounder

    const [members, setMembers] = useState<Member[] | null>(null)
    const [invites, setInvites] = useState<Invite[] | null>(null)
    const [drones, setDrones] = useState<WorkspaceDrone[] | null>(null)
    const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ where: string; error?: string; ok?: string } | null>(null)

    const loadMembers = useCallback(async () => {
        const r = await listMembers(ws.id)
        if (r.ok) setMembers(r.data)
        setLoadErrors(e => ({ ...e, members: r.ok ? '' : r.error }))
    }, [ws.id])
    const loadInvites = useCallback(async () => {
        if (!canMembers) return
        const r = await listInvites(ws.id)
        if (r.ok) setInvites(r.data)
        setLoadErrors(e => ({ ...e, invites: r.ok ? '' : r.error }))
    }, [ws.id, canMembers])
    const loadDrones = useCallback(async () => {
        const r = await listWorkspaceDrones(ws.id)
        if (r.ok) setDrones(r.data)
        setLoadErrors(e => ({ ...e, drones: r.ok ? '' : r.error }))
    }, [ws.id])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- each loader sets state only after its fetch resolves
        void loadMembers(); void loadInvites(); void loadDrones()
    }, [loadMembers, loadInvites, loadDrones])

    /** Run a write, show the server's answer under `where`, then refresh. */
    async function act(where: string, key: string, run: () => Promise<Res>, ok: string, after?: () => void) {
        setBusy(key); setMsg(null)
        const r = await run()
        setBusy(null)
        if (!r.ok) { setMsg({ where, error: r.error }); return false }
        setMsg({ where, ok })
        after?.()
        return true
    }
    const note = (where: string) => msg?.where === where ? <Notice error={msg.error} ok={msg.ok} /> : null

    // ── Header actions ──
    const rename = () => {
        const name = window.prompt(`Rename ${ws.name}`, ws.name)?.trim()
        if (!name || name === ws.name) return
        void act('head', 'rename', () => updateWorkspace(ws.id, { name }), 'Renamed.', onChanged)
    }
    const toggleDisabled = () => {
        const verb = ws.disabled ? 'Enable' : 'Disable'
        if (!window.confirm(`${verb} ${ws.name}?`)) return
        void act('head', 'disable', () => updateWorkspace(ws.id, { disabled: !ws.disabled }), `${verb}d.`, onChanged)
    }
    // The cloud simulator is a premium extra a founder switches on per
    // workspace (docs/ACCESS_MODEL.md 8b). Staff never need it switched on.
    const cloudSim = ws.features?.cloud_sim === true
    const toggleCloudSim = () => {
        const verb = cloudSim ? 'Turn off' : 'Turn on'
        if (!window.confirm(`${verb} the cloud simulator (premium) for ${ws.name}?`)) return
        void act('head', 'cloud_sim', () => updateWorkspace(ws.id, { features: { cloud_sim: !cloudSim } }),
            cloudSim ? 'Cloud simulator turned off.' : 'Cloud simulator turned on.', onChanged)
    }
    // Custom models (upload ONNX / Hugging Face) are the same kind of
    // premium switch (docs/custom_models/DESIGN.md section 0).
    const customModels = ws.features?.custom_models === true
    const toggleCustomModels = () => {
        const verb = customModels ? 'Turn off' : 'Turn on'
        if (!window.confirm(`${verb} custom models (premium) for ${ws.name}?`)) return
        void act('head', 'custom_models', () => updateWorkspace(ws.id, { features: { custom_models: !customModels } }),
            customModels ? 'Custom models turned off. Their models stay stored but cannot run.' : 'Custom models turned on.', onChanged)
    }
    const remove = () => {
        const typed = window.prompt(`Delete ${ws.name} permanently? Type its name to confirm. Workspaces with clients or drones cannot be deleted.`)
        if (typed === null) return
        if (typed.trim() !== ws.name) { setMsg({ where: 'head', error: 'The name did not match. Nothing was deleted.' }); return }
        void act('head', 'delete', () => deleteWorkspace(ws.id), 'Deleted.', onDeleted)
    }

    const parent = list.find(w => w.id === ws.parent_id) ?? null
    const children = list.filter(w => w.parent_id === ws.id)

    return (
        <div className="max-w-3xl mx-auto p-5 space-y-4">
            <div className="space-y-1">
                <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg font-semibold text-zinc-100">{ws.name}</span>
                    <Tag label={KIND_LABELS[ws.kind].toUpperCase()} tone={ws.kind === 'platform' ? 'cyan' : 'zinc'} />
                    {ws.disabled && <Tag label="DISABLED" tone="red" />}
                    {cloudSim && <Tag label="CLOUD SIM" tone="cyan" />}
                    {customModels && <Tag label="CUSTOM MODELS" tone="cyan" />}
                    <span className="ml-auto flex gap-2">
                        {canMembers && <Btn onClick={rename} disabled={busy === 'rename'}>RENAME</Btn>}
                        {isFounder && ws.kind !== 'platform' && (
                            <Btn tone={ws.disabled ? 'emerald' : 'red'} onClick={toggleDisabled} disabled={busy === 'disable'}>
                                {ws.disabled ? 'ENABLE' : 'DISABLE'}
                            </Btn>
                        )}
                        {isFounder && ws.kind !== 'platform' && (
                            <Btn onClick={toggleCloudSim} disabled={busy === 'cloud_sim'}
                                title="Premium: a per-session simulator on the HYRAK server">
                                {cloudSim ? 'CLOUD SIM OFF' : 'CLOUD SIM ON'}
                            </Btn>
                        )}
                        {isFounder && ws.kind !== 'platform' && (
                            <Btn onClick={toggleCustomModels} disabled={busy === 'custom_models'}
                                title="Premium: upload ONNX models or import them from Hugging Face">
                                {customModels ? 'CUSTOM MODELS OFF' : 'CUSTOM MODELS ON'}
                            </Btn>
                        )}
                        {canDelete && ws.kind !== 'platform' && (
                            <Btn tone="red" onClick={remove} disabled={busy === 'delete'}>DELETE</Btn>
                        )}
                    </span>
                </div>
                <div className="text-[10px] text-zinc-600">
                    {parent ? <>in <button className="text-zinc-400 hover:text-cyan-400" onClick={() => onSelect(parent.id)}>{parent.name}</button> · </> : null}
                    your role {roleLabel(ws.my_role, ws.kind)}{ws.inherited ? ' (inherited)' : ''}
                </div>
                {note('head')}
            </div>

            {hasPerm(ws, 'view') && <ActivitySection workspaceId={ws.id} />}

            <OperatingArea ws={ws} parent={parent} zones={zones} canEdit={canArea} onChanged={onChanged} />

            <MembersSection ws={ws} list={list} members={members} loadError={loadErrors.members}
                canManage={canMembers} isFounder={isFounder} selfId={user?.id ?? null}
                busy={busy} act={act} note={note} reload={loadMembers} />

            {canMembers && (
                <InvitesSection ws={ws} invites={invites} loadError={loadErrors.invites}
                    isFounder={isFounder} busy={busy} act={act} note={note} reload={loadInvites} />
            )}

            <DronesSection ws={ws} list={list} drones={drones} loadError={loadErrors.drones}
                canManage={canDrones} isFounder={isFounder} busy={busy} act={act} note={note} reload={loadDrones} />

            {ws.kind === 'organization' && (
                <Section title={`CLIENTS - ${children.length}`}
                    right={canChildren ? <Btn tone="cyan" onClick={onCreateClient}>+ CLIENT</Btn> : null}>
                    {children.length === 0 ? (
                        <Empty>No clients yet. A client is a customer of {ws.name} with its own members and drones.</Empty>
                    ) : (
                        <div className="divide-y divide-zinc-900">
                            {children.map(c => (
                                <button key={c.id} onClick={() => onSelect(c.id)}
                                    className="w-full text-left px-3 py-2 text-[10px] flex items-center gap-3 hover:bg-zinc-900/50">
                                    <span className="text-zinc-200">{c.name}</span>
                                    {c.disabled && <Tag label="DISABLED" tone="red" />}
                                    <span className="ml-auto text-zinc-700">▸</span>
                                </button>
                            ))}
                        </div>
                    )}
                </Section>
            )}
        </div>
    )
}

type Act = (where: string, key: string, run: () => Promise<Res>, ok: string, after?: () => void) => Promise<boolean>
type Note = (where: string) => React.ReactNode

function OperatingArea({ ws, parent, zones, canEdit, onChanged }: {
    ws: WorkspaceInfo; parent: WorkspaceInfo | null; zones: ZoneFeature[]; canEdit: boolean; onChanged: () => void
}) {
    const [draft, setDraft] = useState<[number, number][] | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')

    const outlines: Outline[] = []
    if (parent?.operating_area) {
        outlines.push({ key: 'parent', geom: parent.operating_area, color: '#71717a', label: `${parent.name} operating area`, dashed: true })
    }
    if (ws.operating_area && !draft) {
        outlines.push({ key: 'own', geom: ws.operating_area, color: '#22d3ee', label: `${ws.name} operating area` })
    }

    async function save(area: ReturnType<typeof polygonFromPoints> | null) {
        setBusy(true); setError(''); setOk('')
        const r = await updateWorkspace(ws.id, { operating_area: area })
        setBusy(false)
        if (!r.ok) { setError(r.error); return }
        setDraft(null)
        setOk(area ? 'Operating area saved.' : 'Operating area removed.')
        onChanged()
    }

    return (
        <Section title="OPERATING AREA"
            right={canEdit && !draft ? (
                <>
                    <Btn tone="cyan" onClick={() => { setDraft(pointsFromPolygon(ws.operating_area)); setOk(''); setError('') }}>
                        {ws.operating_area ? 'EDIT AREA' : 'DRAW AREA'}
                    </Btn>
                    {ws.operating_area && (
                        <Btn tone="red" disabled={busy} onClick={() => {
                            if (window.confirm(`Remove the operating area of ${ws.name}? Site zones then have nothing to be drawn inside.`)) void save(null)
                        }}>REMOVE</Btn>
                    )}
                </>
            ) : null}>
            <div className="h-64 relative">
                <AreaMap outlines={outlines} zones={zones} draft={draft ?? []} fitKey={ws.id}
                    onMapClick={draft ? (lat, lng) => setDraft(p => [...(p ?? []), [lat, lng]]) : undefined} />
            </div>
            <div className="px-3 py-2 space-y-2 text-[10px]">
                {draft ? (
                    <>
                        <div className="text-zinc-500">
                            Click the map to add vertices ({draft.length} placed{draft.length < 3 ? `, need ${3 - draft.length} more` : ''}).
                            {parent?.operating_area && " The dashed outline is the parent workspace's area."}
                        </div>
                        <div className="flex gap-2">
                            <Btn tone="emerald" disabled={draft.length < 3 || busy} onClick={() => void save(polygonFromPoints(draft))}>
                                {busy ? 'SAVING…' : 'SAVE AREA'}
                            </Btn>
                            <Btn disabled={draft.length === 0} onClick={() => setDraft(p => (p ?? []).slice(0, -1))}>UNDO</Btn>
                            <Btn disabled={draft.length === 0} onClick={() => setDraft([])}>CLEAR</Btn>
                            <Btn onClick={() => { setDraft(null); setError('') }}>CANCEL</Btn>
                        </div>
                    </>
                ) : (
                    <div className="text-zinc-600">
                        {ws.operating_area
                            ? 'Site zones of this workspace, and area zones without their own area, must lie inside this outline.'
                            : canEdit
                                ? 'No operating area yet. Draw one so the workspace can add site zones.'
                                : 'No operating area yet. HYRAK staff set it.'}
                    </div>
                )}
                <Notice error={error} ok={ok} />
            </div>
        </Section>
    )
}

function MembersSection({ ws, list, members, loadError, canManage, isFounder, selfId, busy, act, note, reload }: {
    ws: WorkspaceInfo; list: WorkspaceInfo[]; members: Member[] | null; loadError?: string
    canManage: boolean; isFounder: boolean; selfId: string | null
    busy: string | null; act: Act; note: Note; reload: () => Promise<void>
}) {
    const grantable = grantableRoles(ws, isFounder, { pickable: true })
    const [login, setLogin] = useState('')
    const [title, setTitle] = useState('')
    const [role, setRole] = useState<MemberRole | null>(null)
    const addRole = role && grantable.includes(role) ? role : grantable[grantable.length - 1] ?? null
    const wsName = (id: string | null | undefined) => list.find(w => w.id === id)?.name ?? 'parent'

    async function add(e: FormEvent) {
        e.preventDefault()
        if (!addRole) return
        if (!login.trim()) return
        const who = login.trim()
        const done = await act('members', 'add', () => addMember(ws.id, { login: who, role: addRole, title: title.trim() || undefined }),
            `Added ${who} as ${roleLabel(addRole, ws.kind)}.`, () => void reload())
        if (done) { setLogin(''); setTitle('') }
    }

    const direct = members?.filter(m => !m.inherited_from) ?? []
    const inherited = members?.filter(m => m.inherited_from) ?? []

    const row = (m: Member) => {
        const inh = !!m.inherited_from
        const self = m.user.id === selfId
        const editable = canManage && !inh && !self && canTouchMember(ws, m.role, isFounder)
        const opts = grantable.includes(m.role) ? grantable : [m.role, ...grantable]
        return (
            <div key={`${m.id}-${m.workspace_id}`} className="px-3 py-2 text-[10px] flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-zinc-100 truncate">{personName(m.user)}</span>
                        {self && <Tag label="YOU" tone="cyan" />}
                        {inh && <Tag label={`INHERITED · ${wsName(m.inherited_from).toUpperCase()}`} tone="violet" />}
                        {m.area && <Tag label="AREA" tone="amber" />}
                    </div>
                    <div className="text-zinc-600 truncate">
                        {[m.user.email || m.user.username, m.title].filter(Boolean).join(' · ')}
                    </div>
                </div>
                {editable ? (
                    <>
                        <select value={m.role} disabled={busy === m.id} aria-label={`Role of ${personName(m.user)}`}
                            onChange={e => {
                                const r = e.target.value as MemberRole
                                void act('members', m.id, () => updateMember(ws.id, m.id, { role: r }),
                                    `${personName(m.user)} is now ${roleLabel(r, ws.kind)}.`, () => void reload())
                            }}
                            className={`${INPUT_CLS} py-1 text-[10px]`}>
                            {opts.map(r => <option key={r} value={r}>{roleLabel(r, ws.kind)}</option>)}
                        </select>
                        <Btn disabled={busy === m.id} onClick={() => {
                            const t = window.prompt(`Title for ${personName(m.user)} (empty to clear)`, m.title ?? '')
                            if (t === null) return
                            void act('members', m.id, () => updateMember(ws.id, m.id, { title: t.trim() }), 'Title saved.', () => void reload())
                        }}>TITLE</Btn>
                        <Btn tone="red" disabled={busy === m.id} onClick={() => {
                            if (!window.confirm(`Remove ${personName(m.user)} from ${ws.name}?`)) return
                            void act('members', m.id, () => removeMember(ws.id, m.id), `Removed ${personName(m.user)}.`, () => void reload())
                        }}>REMOVE</Btn>
                    </>
                ) : (
                    <span className="text-zinc-400 whitespace-nowrap">{roleLabel(m.role, ws.kind).toUpperCase()}</span>
                )}
            </div>
        )
    }

    return (
        <Section title={`MEMBERS - ${direct.length}${inherited.length ? ` + ${inherited.length} inherited` : ''}`}>
            {members === null && !loadError && <Empty>Loading members…</Empty>}
            {loadError && <div className="px-3 py-2"><Notice error={loadError} /></div>}
            {members?.length === 0 && <Empty>No members yet.</Empty>}
            <div className="divide-y divide-zinc-900">
                {direct.map(row)}
                {inherited.map(row)}
            </div>
            {canManage && addRole && (
                <form onSubmit={e => void add(e)} className="px-3 py-2 border-t border-zinc-800 flex flex-wrap items-end gap-2">
                    <div className="flex-[2_1_160px] min-w-0">
                        <label htmlFor={`add-login-${ws.id}`} className={LABEL_CLS}>ADD EXISTING ACCOUNT</label>
                        <input id={`add-login-${ws.id}`} value={login} onChange={e => setLogin(e.target.value)}
                            placeholder="email or username" autoCapitalize="none" spellCheck={false} className={`${INPUT_CLS} w-full`} />
                    </div>
                    <div>
                        <label htmlFor={`add-role-${ws.id}`} className={LABEL_CLS}>ROLE</label>
                        <select id={`add-role-${ws.id}`} value={addRole} onChange={e => setRole(e.target.value as MemberRole)} className={INPUT_CLS}>
                            {grantable.map(r => <option key={r} value={r}>{roleLabel(r, ws.kind)}</option>)}
                        </select>
                    </div>
                    <div className="flex-[1_1_120px] min-w-0">
                        <label htmlFor={`add-title-${ws.id}`} className={LABEL_CLS}>TITLE</label>
                        <input id={`add-title-${ws.id}`} value={title} onChange={e => setTitle(e.target.value)}
                            placeholder="optional" className={`${INPUT_CLS} w-full`} />
                    </div>
                    <Btn type="submit" tone="cyan" disabled={busy === 'add' || !login.trim()}>ADD</Btn>
                </form>
            )}
            <div className="px-3 pb-2 empty:hidden">{note('members')}</div>
        </Section>
    )
}

const EXPIRY_DAYS = [1, 3, 7, 14, 30]

function InvitesSection({ ws, invites, loadError, isFounder, busy, act, note, reload }: {
    ws: WorkspaceInfo; invites: Invite[] | null; loadError?: string; isFounder: boolean
    busy: string | null; act: Act; note: Note; reload: () => Promise<void>
}) {
    const roles = grantableRoles(ws, isFounder, { invite: true })
    const [role, setRole] = useState<MemberRole | null>(null)
    const inviteRole = role && roles.includes(role) ? role : roles[roles.length - 1] ?? null
    const [email, setEmail] = useState('')
    const [title, setTitle] = useState('')
    const [days, setDays] = useState(7)
    const [link, setLink] = useState<{ url: string; expires: string | null } | null>(null)

    async function create(e: FormEvent) {
        e.preventDefault()
        if (!inviteRole) return
        setLink(null)
        const issued: { v: { url: string; expires: string | null } | null } = { v: null }
        const done = await act('invites', 'invite', async () => {
            const r = await createInvite(ws.id, {
                role: inviteRole, email: email.trim() || undefined, title: title.trim() || undefined, expires_days: days,
            })
            if (r.ok) issued.v = { url: absoluteUrl(r.data.url), expires: r.data.invite?.expires_at ?? null }
            return r
        }, 'Invite created. Copy the link and send it yourself.', () => void reload())
        if (done && issued.v) { setLink(issued.v); setEmail(''); setTitle('') }
    }

    const pending = invites?.filter(i => isPendingInvite(i)) ?? []

    return (
        <Section title={`INVITES - ${pending.length} PENDING`}>
            {inviteRole ? (
                <form onSubmit={e => void create(e)} className="px-3 py-2 border-b border-zinc-800 space-y-2">
                    <div className="flex flex-wrap items-end gap-2">
                        <div>
                            <label htmlFor={`inv-role-${ws.id}`} className={LABEL_CLS}>ROLE</label>
                            <select id={`inv-role-${ws.id}`} value={inviteRole} onChange={e => setRole(e.target.value as MemberRole)} className={INPUT_CLS}>
                                {roles.map(r => <option key={r} value={r}>{roleLabel(r, ws.kind)}</option>)}
                            </select>
                        </div>
                        <div className="flex-[2_1_160px] min-w-0">
                            <label htmlFor={`inv-email-${ws.id}`} className={LABEL_CLS}>LOCK TO EMAIL</label>
                            <input id={`inv-email-${ws.id}`} type="email" value={email} onChange={e => setEmail(e.target.value)}
                                placeholder="optional - anyone with the link" spellCheck={false} className={`${INPUT_CLS} w-full`} />
                        </div>
                        <div className="flex-[1_1_100px] min-w-0">
                            <label htmlFor={`inv-title-${ws.id}`} className={LABEL_CLS}>TITLE</label>
                            <input id={`inv-title-${ws.id}`} value={title} onChange={e => setTitle(e.target.value)}
                                placeholder="optional" className={`${INPUT_CLS} w-full`} />
                        </div>
                        <div>
                            <label htmlFor={`inv-days-${ws.id}`} className={LABEL_CLS}>EXPIRES</label>
                            <select id={`inv-days-${ws.id}`} value={days} onChange={e => setDays(Number(e.target.value))} className={INPUT_CLS}>
                                {EXPIRY_DAYS.map(d => <option key={d} value={d}>{d}d</option>)}
                            </select>
                        </div>
                        <Btn type="submit" tone="cyan" disabled={busy === 'invite'}>{busy === 'invite' ? 'CREATING…' : 'CREATE LINK'}</Btn>
                    </div>
                    {link && (
                        <CopyLink label="INVITE LINK" url={link.url}
                            note={`Single use${link.expires ? `, expires ${fmtWhen(link.expires)}` : ''}. Not shown again.`} />
                    )}
                </form>
            ) : (
                <Empty>Your role cannot create invites here.</Empty>
            )}
            {invites === null && !loadError && <Empty>Loading invites…</Empty>}
            {loadError && <div className="px-3 py-2"><Notice error={loadError} /></div>}
            {invites && pending.length === 0 && <Empty>No pending invites.</Empty>}
            <div className="divide-y divide-zinc-900">
                {pending.map(i => (
                    <div key={i.id} className="px-3 py-2 text-[10px] flex items-center gap-3">
                        <Tag label={roleLabel(i.role, ws.kind).toUpperCase()} tone="zinc" />
                        <span className="text-zinc-300 truncate">{i.email || 'anyone with the link'}</span>
                        {i.title && <span className="text-zinc-600 truncate">{i.title}</span>}
                        <span className="ml-auto text-zinc-600 whitespace-nowrap">expires {fmtWhen(i.expires_at)}</span>
                        <Btn tone="red" disabled={busy === i.id} onClick={() => {
                            if (!window.confirm(`Revoke this ${roleLabel(i.role, ws.kind)} invite?`)) return
                            void act('invites', i.id, () => revokeInvite(ws.id, i.id), 'Invite revoked.', () => void reload())
                        }}>REVOKE</Btn>
                    </div>
                ))}
            </div>
            <div className="px-3 pb-2 empty:hidden">{note('invites')}</div>
        </Section>
    )
}

function DronesSection({ ws, list, drones, loadError, canManage, isFounder, busy, act, note, reload }: {
    ws: WorkspaceInfo; list: WorkspaceInfo[]; drones: WorkspaceDrone[] | null; loadError?: string
    canManage: boolean; isFounder: boolean; busy: string | null; act: Act; note: Note; reload: () => Promise<void>
}) {
    // Moving needs drones.manage on both ends.
    const targets = list.filter(w => w.id !== ws.id && (isFounder || hasPerm(w, 'drones.manage')))
    const [target, setTarget] = useState<Record<string, string>>({})

    return (
        <Section title={`DRONES - ${drones?.length ?? 0}`}>
            {drones === null && !loadError && <Empty>Loading drones…</Empty>}
            {loadError && <div className="px-3 py-2"><Notice error={loadError} /></div>}
            {drones?.length === 0 && <Empty>No drones in this workspace. Move one here from the workspace that holds it.</Empty>}
            <div className="divide-y divide-zinc-900">
                {drones?.map(d => {
                    const to = target[d.id] ?? ''
                    return (
                        <div key={d.id} className="px-3 py-2 text-[10px] flex items-center gap-3">
                            <span className="text-zinc-100 text-xs truncate">{d.name}</span>
                            {d.is_simulated && <Tag label="SIM" tone="amber" />}
                            <span className="text-zinc-700 truncate">{d.hardware_uid.slice(0, 12)}</span>
                            <span className="text-zinc-600 whitespace-nowrap">seen {fmtWhen(d.last_seen)}</span>
                            {canManage && targets.length > 0 && (
                                <span className="ml-auto flex items-center gap-2">
                                    <select value={to} aria-label={`Move ${d.name} to`}
                                        onChange={e => setTarget(t => ({ ...t, [d.id]: e.target.value }))}
                                        className={`${INPUT_CLS} py-1 text-[10px] max-w-[160px]`}>
                                        <option value="">move to…</option>
                                        {targets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                    </select>
                                    <Btn tone="cyan" disabled={!to || busy === d.id} onClick={() => {
                                        const dest = list.find(w => w.id === to)
                                        if (!dest || !window.confirm(`Move ${d.name} from ${ws.name} to ${dest.name}?`)) return
                                        void act('drones', d.id, () => moveDrone(d.id, dest.id), `${d.name} moved to ${dest.name}.`, () => void reload())
                                    }}>MOVE</Btn>
                                </span>
                            )}
                        </div>
                    )
                })}
            </div>
            <div className="px-3 pb-2 empty:hidden">{note('drones')}</div>
        </Section>
    )
}

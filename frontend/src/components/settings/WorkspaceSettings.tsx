'use client'

// Settings > Workspace: the active workspace (the sidebar switcher's
// choice), its members, and invites. People with members.manage on it
// (owners, admins, managers, founders) can add, change and remove members
// and create invite links; everyone else sees a read-only list. The server
// re-checks every change and its message is shown as is.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAccess, useActiveWorkspace } from '@/hooks/useAccess'
import {
    KIND_LABELS, canTouchMember, grantableRoles, hasPerm, roleLabel, type MemberRole, type WorkspaceInfo,
} from '@/lib/access'
import {
    absoluteUrl, addMember, copyText, createInvite, fmtWhen, isPendingInvite, listInvites, listMembers,
    personName, removeMember, revokeInvite, updateMember, type Invite, type Member,
} from '@/lib/workspaces'
import { Pill, PrefRow, S_INPUT, S_LABEL, S_NOTE, SButton, Status } from '@/components/settings/primitives'

function NoWorkspace() {
    return <p style={{ ...S_NOTE, padding: '10px 0' }}>You are not in a workspace yet. Ask for an invite link.</p>
}

function RoleSelect({ id, value, roles, kind, onChange, disabled }: {
    id?: string; value: MemberRole; roles: MemberRole[]; kind: WorkspaceInfo['kind']
    onChange: (r: MemberRole) => void; disabled?: boolean
}) {
    const opts = roles.includes(value) ? roles : [value, ...roles]
    return (
        <select id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value as MemberRole)}
            style={{ ...S_INPUT, paddingRight: 4 }}>
            {opts.map(r => <option key={r} value={r}>{roleLabel(r, kind)}</option>)}
        </select>
    )
}

export function WorkspaceGroup() {
    const { workspace, workspaces, setActive } = useActiveWorkspace()
    if (!workspace) return <NoWorkspace />
    return (
        <>
            <PrefRow label="Workspace"
                sub={workspaces.length > 1 ? 'The workspace this browser works in. Also switchable from the sidebar.' : undefined}
                right={workspaces.length > 1 ? (
                    <select aria-label="Active workspace" value={workspace.id} onChange={e => setActive(e.target.value)}
                        style={{ ...S_INPUT, maxWidth: 260 }}>
                        {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                ) : <span style={{ fontSize: 13, color: 'hsl(var(--app-text))' }}>{workspace.name}</span>} />
            <PrefRow label="Type" right={<span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                {KIND_LABELS[workspace.kind] ?? workspace.kind}</span>} />
            <PrefRow label="Your role"
                sub={workspace.inherited ? 'Held on a workspace above this one and applies here too' : undefined}
                right={<span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                    {roleLabel(workspace.my_role, workspace.kind)}</span>} />
        </>
    )
}

/** Fetch something for the active workspace, dropping a reply that lands
 *  after the person switched away. */
function useForWorkspace<T>(wsId: string | null, fetcher: (id: string) => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
    const [data, setData] = useState<T | null>(null)
    const [error, setError] = useState('')
    const [loadedFor, setLoadedFor] = useState(wsId)
    if (loadedFor !== wsId) { setLoadedFor(wsId); setData(null); setError('') }
    const seq = useRef(0)
    const reload = useCallback(async () => {
        if (!wsId) return
        const n = ++seq.current
        const r = await fetcher(wsId)
        if (n !== seq.current) return
        if (r.ok) { setData(r.data); setError('') } else setError(r.error)
    }, [wsId, fetcher])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reload sets state only after its fetch resolves
        void reload()
    }, [reload])
    return { data, error, reload }
}

export function MembersGroup() {
    const { workspace } = useActiveWorkspace()
    const { user, isFounder, workspaces } = useAccess()
    const { data: members, error: loadError, reload } = useForWorkspace<Member[]>(workspace?.id ?? null, listMembers)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [login, setLogin] = useState('')
    const [title, setTitle] = useState('')
    const grantable = grantableRoles(workspace, isFounder)
    const [role, setRole] = useState<MemberRole | null>(null)
    const addRole = role && grantable.includes(role) ? role : grantable[grantable.length - 1] ?? null

    if (!workspace) return <NoWorkspace />
    const ws = workspace
    const canManage = hasPerm(ws, 'members.manage') || isFounder
    const wsName = (id: string | null | undefined) => workspaces.find(w => w.id === id)?.name ?? 'a parent workspace'

    async function act(key: string, run: () => Promise<{ ok: boolean; error?: string }>, done: string) {
        setBusy(key); setError(''); setOk('')
        const r = await run()
        setBusy(null)
        if (!r.ok) { setError(r.error ?? 'That did not work.'); return false }
        setOk(done)
        void reload()
        return true
    }

    async function add(e: FormEvent) {
        e.preventDefault()
        if (!login.trim()) { setError('Enter an email or username.'); return }
        if (!addRole) return
        const who = login.trim()
        const added = await act('add', () => addMember(ws.id, { login: who, role: addRole, title: title.trim() || undefined }),
            `Added ${who} as ${roleLabel(addRole, ws.kind)}.`)
        if (added) { setLogin(''); setTitle('') }
    }

    const remove = (m: Member) => {
        if (!window.confirm(`Remove ${personName(m.user)} from ${ws.name}?`)) return
        void act(m.id, () => removeMember(ws.id, m.id), `Removed ${personName(m.user)}.`)
    }

    const changeRole = (m: Member, r: MemberRole) => {
        if (r === m.role) return
        void act(m.id, () => updateMember(ws.id, m.id, { role: r }), `${personName(m.user)} is now ${roleLabel(r, ws.kind)}.`)
    }

    return (
        <>
            {members === null && !loadError && <p style={{ ...S_NOTE, padding: '10px 0' }}>Loading members</p>}
            {loadError && <Status error={loadError} />}
            {members?.length === 0 && <p style={{ ...S_NOTE, padding: '10px 0' }}>No members yet.</p>}
            {members?.map(m => {
                const inherited = !!m.inherited_from
                const self = m.user.id === user?.id
                const editable = canManage && !inherited && !self && canTouchMember(ws, m.role, isFounder)
                return (
                    <PrefRow key={`${m.id}-${m.workspace_id}`}
                        label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {personName(m.user)}
                            {self && <Pill tone="cyan">YOU</Pill>}
                            {inherited && <Pill>VIA {wsName(m.inherited_from).toUpperCase()}</Pill>}
                        </span>}
                        sub={[m.user.email || m.user.username, m.title].filter(Boolean).join(' - ')}
                        right={editable ? (
                            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                <RoleSelect value={m.role} roles={grantable} kind={ws.kind}
                                    disabled={busy === m.id} onChange={r => changeRole(m, r)} />
                                <SButton tone="danger" disabled={busy === m.id} onClick={() => remove(m)}>Remove</SButton>
                            </span>
                        ) : (
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                                {roleLabel(m.role, ws.kind)}
                            </span>
                        )} />
                )
            })}

            {canManage && addRole && (
                <form onSubmit={e => void add(e)} noValidate style={{ padding: '12px 0 4px' }}>
                    <p style={{ ...S_NOTE, marginBottom: 8 }}>
                        Add someone who already has a HYRAK account. For a new person, create an invite link below.
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                        <div style={{ flex: '2 1 180px', minWidth: 0 }}>
                            <label htmlFor="mem-login" style={S_LABEL}>EMAIL OR USERNAME</label>
                            <input id="mem-login" value={login} autoCapitalize="none" spellCheck={false}
                                onChange={e => { setLogin(e.target.value); setError('') }} style={{ ...S_INPUT, width: '100%' }} />
                        </div>
                        <div>
                            <label htmlFor="mem-role" style={S_LABEL}>ROLE</label>
                            <RoleSelect id="mem-role" value={addRole} roles={grantable} kind={ws.kind} onChange={setRole} />
                        </div>
                        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                            <label htmlFor="mem-title" style={S_LABEL}>TITLE (OPTIONAL)</label>
                            <input id="mem-title" value={title} placeholder="e.g. Site lead"
                                onChange={e => setTitle(e.target.value)} style={{ ...S_INPUT, width: '100%' }} />
                        </div>
                        <SButton type="submit" tone="primary" disabled={busy === 'add'}>Add member</SButton>
                    </div>
                </form>
            )}
            <Status error={error} ok={ok} />
        </>
    )
}

const EXPIRY_DAYS = [1, 3, 7, 14, 30]

export function InvitesGroup() {
    const { workspace } = useActiveWorkspace()
    const { isFounder } = useAccess()
    const canManage = !!workspace && (hasPerm(workspace, 'members.manage') || isFounder)
    const { data: invites, error: loadError, reload } = useForWorkspace<Invite[]>(
        canManage ? workspace?.id ?? null : null, listInvites)
    const roles = grantableRoles(workspace, isFounder, { invite: true })
    const [role, setRole] = useState<MemberRole | null>(null)
    const inviteRole = role && roles.includes(role) ? role : roles[roles.length - 1] ?? null
    const [email, setEmail] = useState('')
    const [title, setTitle] = useState('')
    const [days, setDays] = useState(7)
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')
    const [link, setLink] = useState<{ url: string; expires: string | null } | null>(null)
    const [copied, setCopied] = useState('')
    const linkRef = useRef<HTMLInputElement>(null)

    if (!workspace) return <NoWorkspace />
    const ws = workspace
    if (!canManage) {
        return <p style={{ ...S_NOTE, padding: '10px 0' }}>Owners and admins of {ws.name} can invite people.</p>
    }

    async function create(e: FormEvent) {
        e.preventDefault()
        if (!inviteRole || busy) return
        if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            setError('Enter a valid email address, or leave it empty for anyone with the link.')
            return
        }
        setBusy('create'); setError(''); setOk(''); setLink(null); setCopied('')
        const r = await createInvite(ws.id, {
            role: inviteRole, email: email.trim() || undefined, title: title.trim() || undefined, expires_days: days,
        })
        setBusy(null)
        if (!r.ok) { setError(r.error); return }
        setLink({ url: absoluteUrl(r.data.url), expires: r.data.invite?.expires_at ?? null })
        setEmail(''); setTitle('')
        void reload()
    }

    function copy() {
        if (!link) return
        void copyText(link.url, linkRef.current).then(how =>
            setCopied(how === 'copied' ? 'Copied.' : 'Selected - press Ctrl+C to copy.'))
    }

    async function revoke(i: Invite) {
        if (!window.confirm(`Revoke the ${roleLabel(i.role, ws.kind)} invite${i.email ? ` for ${i.email}` : ''}?`)) return
        setBusy(i.id); setError(''); setOk('')
        const r = await revokeInvite(ws.id, i.id)
        setBusy(null)
        if (!r.ok) { setError(r.error); return }
        setOk('Invite revoked.')
        void reload()
    }

    const pending = invites?.filter(i => isPendingInvite(i)) ?? []

    return (
        <>
            {inviteRole ? (
                <form onSubmit={e => void create(e)} noValidate style={{ padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                        <div>
                            <label htmlFor="inv-role" style={S_LABEL}>ROLE</label>
                            <RoleSelect id="inv-role" value={inviteRole} roles={roles} kind={ws.kind} onChange={setRole} />
                        </div>
                        <div style={{ flex: '2 1 180px', minWidth: 0 }}>
                            <label htmlFor="inv-email" style={S_LABEL}>EMAIL (OPTIONAL)</label>
                            <input id="inv-email" type="email" value={email} spellCheck={false} placeholder="Anyone with the link"
                                onChange={e => { setEmail(e.target.value); setError('') }} style={{ ...S_INPUT, width: '100%' }} />
                        </div>
                        <div style={{ flex: '1 1 120px', minWidth: 0 }}>
                            <label htmlFor="inv-title" style={S_LABEL}>TITLE (OPTIONAL)</label>
                            <input id="inv-title" value={title} onChange={e => setTitle(e.target.value)}
                                style={{ ...S_INPUT, width: '100%' }} />
                        </div>
                        <div>
                            <label htmlFor="inv-days" style={S_LABEL}>EXPIRES</label>
                            <select id="inv-days" value={days} onChange={e => setDays(Number(e.target.value))} style={S_INPUT}>
                                {EXPIRY_DAYS.map(d => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
                            </select>
                        </div>
                        <SButton type="submit" tone="primary" disabled={busy === 'create'}>
                            {busy === 'create' ? 'Creating' : 'Create invite link'}
                        </SButton>
                    </div>
                    {link && (
                        <div style={{ marginTop: 12 }}>
                            <label htmlFor="inv-link" style={S_LABEL}>INVITE LINK</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <input id="inv-link" ref={linkRef} readOnly value={link.url} onFocus={e => e.currentTarget.select()}
                                    style={{ ...S_INPUT, flex: 1 }} />
                                <SButton tone="primary" onClick={copy}>Copy</SButton>
                            </div>
                            <p style={{ ...S_NOTE, marginTop: 5 }}>
                                {copied || `Send it yourself. It works once${link.expires ? ` and expires ${fmtWhen(link.expires)}` : ''}. It is not shown again.`}
                            </p>
                        </div>
                    )}
                </form>
            ) : (
                <p style={{ ...S_NOTE, padding: '10px 0' }}>Your role cannot invite people to {ws.name}.</p>
            )}

            {invites === null && !loadError && <p style={{ ...S_NOTE, padding: '10px 0' }}>Loading invites</p>}
            {loadError && <Status error={loadError} />}
            {invites && pending.length === 0 && <p style={{ ...S_NOTE, padding: '10px 0' }}>No pending invites.</p>}
            {pending.map(i => (
                <PrefRow key={i.id}
                    label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {i.email || 'Anyone with the link'}
                        <Pill>{roleLabel(i.role, ws.kind).toUpperCase()}</Pill>
                    </span>}
                    sub={[i.title, `Created ${fmtWhen(i.created_at)}`, `expires ${fmtWhen(i.expires_at)}`].filter(Boolean).join(' - ')}
                    right={<SButton tone="danger" disabled={busy === i.id} onClick={() => void revoke(i)}>Revoke</SButton>} />
            ))}
            <Status error={error} ok={ok} />
        </>
    )
}

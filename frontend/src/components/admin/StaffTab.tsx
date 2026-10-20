'use client'

// STAFF tab of the HYRAK console (founders only): staff accounts with all
// their memberships, granting the two staff-only roles - manager on a
// customer workspace (optional area) and airspace manager (area required) -
// and account-wide actions: disable, and a one-hour password reset link.
// Account actions are founder-only by design (docs/ACCESS_MODEL.md section
// 2): a customer admin must never be able to reset a staff password.

import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react'
import dynamic from 'next/dynamic'
import { Search } from 'lucide-react'
import { useAccess } from '@/hooks/useAccess'
import { platformOf, roleLabel, type GeoPolygon, type Membership, type WorkspaceInfo } from '@/lib/access'
import {
    absoluteUrl, addMember, issueResetLink, listStaff, listUsers, listWorkspaces, personName,
    removeMember, updateMember, updateUser, type AccountRow, type StaffAccount,
} from '@/lib/workspaces'
import { polygonFromPoints, type ZoneFeature } from '@/components/admin/zones'
import type { Outline } from '@/components/admin/AreaMap'
import { Btn, CopyLink, Empty, INPUT_CLS, LABEL_CLS, Notice, PageHead, Section, Tag, TH_CLS, TR_CLS } from '@/components/admin/console'
import { fmtShort } from '@/components/settings/primitives'

const AreaMap = dynamic(() => import('@/components/admin/AreaMap'), { ssr: false })

type GrantKind = 'manager' | 'airspace'

export default function StaffTab({ zones }: { zones: ZoneFeature[] }) {
    const { user: me } = useAccess()
    const [staff, setStaff] = useState<StaffAccount[] | null>(null)
    const [accounts, setAccounts] = useState<AccountRow[] | null>(null)
    const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [msg, setMsg] = useState<{ where: string; error?: string; ok?: string } | null>(null)
    const [resetLinks, setResetLinks] = useState<Record<string, { url: string; expires: string | null }>>({})
    const [search, setSearch] = useState('')
    const [grantLogin, setGrantLogin] = useState('')

    const loadStaff = useCallback(async () => {
        const r = await listStaff()
        if (r.ok) setStaff(r.data)
        setErrors(e => ({ ...e, staff: r.ok ? '' : r.error }))
    }, [])
    const loadAccounts = useCallback(async () => {
        const r = await listUsers()
        if (r.ok) setAccounts(r.data)
        setErrors(e => ({ ...e, accounts: r.ok ? '' : r.error }))
    }, [])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the loaders set state only after their fetches resolve
        void loadStaff(); void loadAccounts()
        void listWorkspaces().then(r => { if (r.ok) setWorkspaces(r.data) })
    }, [loadStaff, loadAccounts])

    const reloadAll = () => { void loadStaff(); void loadAccounts() }

    async function act(where: string, key: string, run: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
        setBusy(key); setMsg(null)
        const r = await run()
        setBusy(null)
        if (!r.ok) { setMsg({ where, error: r.error }); return false }
        setMsg({ where, ok })
        reloadAll()
        return true
    }
    const note = (where: string) => msg?.where === where ? <Notice error={msg.error} ok={msg.ok} /> : null

    const toggleDisabled = (a: AccountRow) => {
        const verb = a.disabled ? 'Enable' : 'Disable'
        const warn = a.disabled ? '' : ' They are signed out everywhere and cannot sign in until enabled again.'
        if (!window.confirm(`${verb} ${personName(a)}?${warn}`)) return
        void act(`acct-${a.id}`, `dis-${a.id}`, () => updateUser(a.id, { disabled: !a.disabled }), `${verb}d ${personName(a)}.`)
    }

    const resetLink = async (a: AccountRow) => {
        if (!window.confirm(`Issue a one-hour password reset link for ${personName(a)}? Anyone holding the link can set their password.`)) return
        setBusy(`reset-${a.id}`); setMsg(null)
        const r = await issueResetLink(a.id)
        setBusy(null)
        if (!r.ok) { setMsg({ where: `acct-${a.id}`, error: r.error }); return }
        setResetLinks(m => ({ ...m, [a.id]: { url: absoluteUrl(r.data.url), expires: r.data.expires_at } }))
    }

    const accountActions = (a: AccountRow) => (
        <>
            <Btn disabled={busy === `reset-${a.id}`} onClick={() => void resetLink(a)}>Reset link</Btn>
            {a.id !== me?.id && (
                <Btn tone={a.disabled ? 'emerald' : 'red'} disabled={busy === `dis-${a.id}`} onClick={() => toggleDisabled(a)}>
                    {a.disabled ? 'Enable' : 'Disable'}
                </Btn>
            )}
        </>
    )
    const accountExtras = (a: AccountRow) => (
        <>
            {resetLinks[a.id] && (
                <div className="pt-1">
                    <CopyLink label="PASSWORD RESET LINK" url={resetLinks[a.id].url}
                        note={`Single use${resetLinks[a.id].expires ? `, expires ${fmtShort(resetLinks[a.id].expires)}` : ''}. Send it to ${personName(a)} yourself.`} />
                </div>
            )}
            {note(`acct-${a.id}`)}
        </>
    )

    const q = search.trim().toLowerCase()
    const shownAccounts = (accounts ?? []).filter(a => !q
        || a.username.toLowerCase().includes(q)
        || (a.email ?? '').toLowerCase().includes(q)
        || (a.display_name ?? '').toLowerCase().includes(q))

    return (
        <div className="flex-1 flex flex-col lg:flex-row min-w-0 overflow-y-auto lg:overflow-hidden">
            <div className="flex-1 lg:overflow-y-auto">
                <div className="max-w-[960px] p-5 lg:px-8 lg:py-6 space-y-5">
                    <PageHead title="Staff" sub="Founders, managers and airspace staff, and every account on the platform" />
                    <Section title={`Staff (${staff?.length ?? 0})`}>
                        {staff === null && !errors.staff && <Empty>Loading staff…</Empty>}
                        {errors.staff && <div className="px-3 py-2"><Notice error={errors.staff} /></div>}
                        {staff?.length === 0 && <Empty>No staff accounts.</Empty>}
                        <div className="divide-y divide-app-border">
                            {staff?.map(({ user: a, memberships }) => (
                                <div key={a.id} className="px-3 py-3 space-y-2 text-[13px]">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[14px] font-bold text-app-text">{personName(a)}</span>
                                        <span className="text-app-text-muted">{a.email || a.username}</span>
                                        {a.id === me?.id && <Tag label="You" tone="cyan" icon={false} />}
                                        {a.disabled && <Tag label="Disabled" tone="red" />}
                                        <span className="ml-auto flex gap-2">
                                            <Btn tone="cyan" onClick={() => setGrantLogin(a.email || a.username)}>Grant</Btn>
                                            {accountActions(a)}
                                        </span>
                                    </div>
                                    <div className="space-y-1">
                                        {memberships.map(m => (
                                            <MembershipLine key={m.id} m={m} canRemove={a.id !== me?.id}
                                                busy={busy === m.id}
                                                onRemove={() => {
                                                    if (!window.confirm(`Remove ${personName(a)}'s ${roleLabel(m.role, m.workspace_kind)} role on ${m.workspace_name}?`)) return
                                                    void act(`acct-${a.id}`, m.id, () => removeMember(m.workspace_id, m.id), 'Membership removed.')
                                                }} />
                                        ))}
                                    </div>
                                    {accountExtras(a)}
                                </div>
                            ))}
                        </div>
                    </Section>

                    <Section title={`All accounts (${accounts?.length ?? 0})`}
                        right={
                            <span className="flex items-center gap-1.5 bg-app-surface-2 border border-app-border-strong rounded-md px-2 focus-within:border-app-accent">
                                <Search size={14} className="text-app-text-muted" aria-hidden />
                                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search accounts"
                                    aria-label="Search accounts"
                                    className="w-36 bg-transparent h-8 text-[13px] text-app-text outline-none placeholder:text-app-text-subtle " />
                            </span>
                        }>
                        {accounts === null && !errors.accounts && <Empty>Loading accounts…</Empty>}
                        {errors.accounts && <div className="px-3 py-2"><Notice error={errors.accounts} /></div>}
                        {accounts && shownAccounts.length === 0 && <Empty>{q ? 'No match.' : 'No accounts.'}</Empty>}
                        {shownAccounts.length > 0 && (
                            <div className="max-lg:overflow-x-auto">
                                <table className="w-full border-collapse text-[13px]">
                                    <thead className="sticky top-0 z-[1] bg-app-surface">
                                        <tr className="border-b border-app-border">
                                            <th className={TH_CLS}>Name</th>
                                            <th className={TH_CLS}>Username and email</th>
                                            <th className={TH_CLS}>Role</th>
                                            <th className={TH_CLS}>Last sign-in</th>
                                            <th className={TH_CLS}><span className="sr-only">Actions</span></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {shownAccounts.map(a => {
                                            const extras = accountExtras(a)
                                            return (
                                                <Fragment key={a.id}>
                                                    <tr className={TR_CLS}>
                                                        <td className="px-3 py-2 text-[14px] font-semibold text-app-text">{personName(a)}</td>
                                                        <td className="px-3 py-2 text-app-text-muted">
                                                            <div>{a.username}</div>
                                                            {a.email && <div className="break-all">{a.email}</div>}
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <span className="flex flex-wrap gap-1.5">
                                                                {a.is_founder ? <Tag label="Founder" tone="cyan" icon={false} />
                                                                    : a.is_staff ? <Tag label="Staff" tone="violet" icon={false} />
                                                                    : <span className="text-app-text-muted">-</span>}
                                                                {a.disabled && <Tag label="Disabled" tone="red" />}
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2 whitespace-nowrap tabular-nums text-app-text-muted">{fmtShort(a.last_login_at)}</td>
                                                        <td className="px-3 py-2"><span className="flex justify-end gap-2">{accountActions(a)}</span></td>
                                                    </tr>
                                                    {extras && <tr><td colSpan={5} className="px-3 pb-3">{extras}</td></tr>}
                                                </Fragment>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Section>
                </div>
            </div>

            <GrantPanel key={grantLogin} initialLogin={grantLogin} staff={staff ?? []} workspaces={workspaces}
                zones={zones} onGranted={reloadAll} />
        </div>
    )
}

function MembershipLine({ m, canRemove, busy, onRemove }: {
    m: Membership; canRemove: boolean; busy: boolean; onRemove: () => void
}) {
    return (
        <div className="flex items-center gap-2 pl-2 min-h-8 border-l-2 border-app-border">
            <Tag icon={false} label={roleLabel(m.role, m.workspace_kind)}
                tone={m.role === 'founder' ? 'cyan' : m.role === 'airspace' ? 'amber' : m.role === 'manager' ? 'violet' : 'zinc'} />
            <span className="text-app-text">{m.workspace_name}</span>
            {m.title && <span className="text-app-text-muted truncate">{m.title}</span>}
            {m.area && <Tag label="Area" tone="amber" icon={false} />}
            {canRemove && (
                <button onClick={onRemove} disabled={busy}
                    className="ml-auto h-8 px-2 rounded-md text-[13px] font-semibold text-app-text-muted hover:text-app-danger hover:bg-app-danger-soft disabled:text-app-text-subtle transition-colors duration-[120ms]">
                    Remove
                </button>
            )}
        </div>
    )
}

function GrantPanel({ initialLogin, staff, workspaces, zones, onGranted }: {
    initialLogin: string
    staff: StaffAccount[]
    workspaces: WorkspaceInfo[]
    zones: ZoneFeature[]
    onGranted: () => void
}) {
    const [kind, setKind] = useState<GrantKind>('manager')
    const [login, setLogin] = useState(initialLogin)
    const [wsId, setWsId] = useState('')
    const [title, setTitle] = useState('')
    const [draft, setDraft] = useState<[number, number][]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')

    const platform = platformOf(workspaces)
    const customers = workspaces.filter(w => w.kind !== 'platform')
    const target = kind === 'airspace' ? platform : customers.find(w => w.id === wsId) ?? null
    const outlines: Outline[] = target?.operating_area
        ? [{ key: target.id, geom: target.operating_area, color: '#71717a', label: `${target.name} operating area`, dashed: true }]
        : []

    async function grant(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setError(''); setOk('')
        const who = login.trim()
        if (!who) { setError('Enter the email or username of the account.'); return }
        if (!target) { setError(kind === 'manager' ? 'Pick a workspace.' : 'The HYRAK workspace is not visible.'); return }
        if (kind === 'airspace' && draft.length < 3) { setError('Draw the area on the map: an airspace manager always has one.'); return }
        if (draft.length > 0 && draft.length < 3) { setError('An area needs at least 3 vertices, or clear it.'); return }
        const area: GeoPolygon | null = draft.length >= 3 ? polygonFromPoints(draft) : null
        // One membership per person per workspace: if they already hold one
        // there (say a HYRAK viewer becoming an airspace manager), change it.
        const lw = who.toLowerCase()
        const holder = staff.find(s => s.user.username.toLowerCase() === lw || (s.user.email ?? '').toLowerCase() === lw)
        const existing = holder?.memberships.find(m => m.workspace_id === target.id)
        const body = { role: kind, area, title: title.trim() || undefined }
        setBusy(true)
        const r = existing
            ? await updateMember(target.id, existing.id, body)
            : await addMember(target.id, { login: who, ...body })
        setBusy(false)
        if (!r.ok) { setError(r.error); return }
        setOk(`${who} is now ${roleLabel(kind, target.kind)}${kind === 'manager' ? ` of ${target.name}` : ''}.`)
        setDraft([]); setTitle('')
        onGranted()
    }

    return (
        <section className="w-full lg:w-[420px] shrink-0 border-t lg:border-t-0 lg:border-l border-app-border bg-app-surface flex flex-col">
            <form onSubmit={e => void grant(e)} className="p-4 space-y-3 border-b border-app-border text-[13px]">
                <h2 className="text-[18px] font-bold text-app-text">Grant a staff role</h2>
                <div className="flex gap-1.5">
                    {(['manager', 'airspace'] as GrantKind[]).map(k => (
                        <button key={k} type="button" onClick={() => { setKind(k); setError('') }}
                            aria-pressed={kind === k}
                            className={'flex-1 h-8 rounded-md border text-[13px] font-semibold transition-colors duration-[120ms] ' +
                                (kind === k ? 'border-app-accent text-app-text font-bold bg-app-accent-soft' : 'border-app-border-strong text-app-text-muted hover:border-app-text-subtle')}>
                            {roleLabel(k)}
                        </button>
                    ))}
                </div>
                <div className="text-[13px] text-app-text-muted">
                    {kind === 'manager'
                        ? 'Runs a customer workspace: flies, plans, manages members, drones and area zones. Existing staff only.'
                        : 'Edits area zones and decides permits inside the drawn area. Cannot fly or see customer data.'}
                </div>
                <div>
                    <label htmlFor="grant-login" className={LABEL_CLS}>Account</label>
                    <input id="grant-login" value={login} onChange={e => setLogin(e.target.value)}
                        placeholder="email or username" autoCapitalize="none" spellCheck={false} className={`${INPUT_CLS} w-full`} />
                </div>
                {kind === 'manager' ? (
                    <div>
                        <label htmlFor="grant-ws" className={LABEL_CLS}>Workspace</label>
                        <select id="grant-ws" value={wsId} onChange={e => setWsId(e.target.value)} className={`${INPUT_CLS} w-full`}>
                            <option value="">Pick a workspace</option>
                            {customers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                    </div>
                ) : (
                    <div className="text-[12px] text-app-text-muted">Held on {platform?.name ?? 'HYRAK'}.</div>
                )}
                <div>
                    <label htmlFor="grant-title" className={LABEL_CLS}>Title</label>
                    <input id="grant-title" value={title} onChange={e => setTitle(e.target.value)}
                        placeholder={kind === 'manager' ? 'e.g. Service operator, IITH' : 'e.g. Airspace, Hyderabad west'}
                        className={`${INPUT_CLS} w-full`} />
                </div>
                <div className="flex items-center gap-2 text-[12px] font-bold text-app-text-muted">
                    <span>Area</span>
                    <span className="font-normal">{kind === 'airspace' ? 'required' : 'optional'}, <span className="tabular-nums">{draft.length}</span> points</span>
                    <span className="ml-auto flex gap-1.5">
                        <Btn disabled={draft.length === 0} onClick={() => setDraft(p => p.slice(0, -1))}>Undo</Btn>
                        <Btn disabled={draft.length === 0} onClick={() => setDraft([])}>Clear</Btn>
                    </span>
                </div>
                <Notice error={error} ok={ok} />
                <Btn type="submit" tone="primary" disabled={busy} className="w-full py-2">
                    {busy ? 'Granting…' : 'Grant'}
                </Btn>
            </form>
            <div className="flex-1 relative min-h-[240px]">
                <AreaMap outlines={outlines} zones={zones} draft={draft} draftColor="#f59e0b"
                    fitKey={target?.id ?? ''} onMapClick={(lat, lng) => setDraft(p => [...p, [lat, lng]])} />
                <div className="absolute left-2 bottom-2 z-[1000] text-[12px] text-overlay-text bg-overlay-scrim border border-overlay-border rounded-md px-2 py-1 pointer-events-none">
                    Click the map to draw the area
                </div>
            </div>
        </section>
    )
}

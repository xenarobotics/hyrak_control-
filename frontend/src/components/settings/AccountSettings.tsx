'use client'

// Settings > Account: the signed-in person's profile, password and signed-in
// devices. Unlike the rest of the settings page this lives on the server
// (/api/auth/me, /api/auth/sessions), so it follows the person to any
// browser.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { fetchMe, storeUser, type AuthUser } from '@/lib/auth'
import { useAccess } from '@/hooks/useAccess'
import {
    changePassword, listSessions, revokeOtherSessions, revokeSession, updateMe, type SessionRow,
} from '@/lib/workspaces'
import { passwordProblem } from '@/components/auth/AuthCard'
import { describeDevice, fmtShort, Pill, PrefRow, S_FIELD_LABEL, S_INPUT, S_NOTE, SButton, Status } from '@/components/settings/primitives'

export function ProfileGroup() {
    const { user } = useAccess()
    // Drafts start empty and fall back to the stored values, so a profile
    // that arrives after mount still shows without an effect.
    const [name, setName] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')

    if (!user) return <p style={{ ...S_NOTE, padding: '10px 0' }}>Not signed in.</p>

    const curName = name ?? user.display_name ?? ''
    const dirty = curName.trim() !== (user.display_name ?? '')

    async function save(e: FormEvent) {
        e.preventDefault()
        if (!dirty || busy || !user) return
        setBusy(true); setError(''); setOk('')
        const body = { display_name: curName.trim() }
        const r = await updateMe(body)
        setBusy(false)
        if (!r.ok) { setError(r.error); return }
        const next: AuthUser = { ...user, ...body, ...(r.data?.user ?? {}) }
        storeUser(next)
        setName(null)
        setOk('Profile saved.')
        void fetchMe()
    }

    return (
        <form onSubmit={e => void save(e)} noValidate>
            <PrefRow label="Username" sub="Sign in with this or your email"
                right={<span style={{ fontSize: 14, color: 'hsl(var(--app-text))' }}>{user.username}</span>} />
            <PrefRow label={<label htmlFor="acct-name">Display name</label>} sub="Shown to the people in your workspaces"
                right={<input id="acct-name" value={curName} autoComplete="name"
                    onChange={e => { setName(e.target.value); setOk('') }} style={{ ...S_INPUT, width: 220 }} />} />
            {/* Read-only in phase 1: an email is an identity claim that invites and
                member lookups trust, and nothing can verify a new address until
                outgoing email exists. A founder changes it from the console. */}
            <PrefRow label="Email"
                sub={user.email_verified ? 'Verified - sign in with this or your username'
                    : user.email ? 'Not verified - sign in with your username' : 'Ask HYRAK to add one'}
                right={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, color: 'hsl(var(--app-text))', overflowWrap: 'anywhere' }}>{user.email || '-'}</span>
                    {user.email && <Pill tone={user.email_verified ? 'cyan' : 'amber'}>{user.email_verified ? 'Verified' : 'Not verified'}</Pill>}
                </span>} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
                <SButton type="submit" tone="primary" disabled={!dirty || busy} title={!dirty && !busy ? 'Change your display name first' : undefined}>{busy ? 'Saving' : 'Save profile'}</SButton>
                <Status error={error} ok={ok} />
            </div>
        </form>
    )
}

export function PasswordGroup() {
    const { user } = useAccess()
    const [current, setCurrent] = useState('')
    const [next, setNext] = useState('')
    const [confirm, setConfirm] = useState('')
    const [touched, setTouched] = useState<Record<string, boolean>>({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')

    const problems = {
        current: current ? '' : 'Enter your current password.',
        next: passwordProblem(next),
        confirm: confirm === next ? '' : 'The passwords do not match.',
    }
    const show = (k: keyof typeof problems) => (touched[k] ? problems[k] : '')
    const touch = (k: string) => setTouched(t => ({ ...t, [k]: true }))

    async function submit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setTouched({ current: true, next: true, confirm: true })
        if (Object.values(problems).some(Boolean)) return
        setBusy(true); setError(''); setOk('')
        const r = await changePassword(current, next)
        setBusy(false)
        if (!r.ok) { setError(r.error); return }
        setCurrent(''); setNext(''); setConfirm(''); setTouched({})
        setOk('Password changed. Your other devices were signed out.')
    }

    const field = (id: string, label: string, value: string, set: (v: string) => void, k: keyof typeof problems, auto: string) => (
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label htmlFor={id} style={S_FIELD_LABEL}>{label}</label>
            <input id={id} type="password" autoComplete={auto} value={value}
                onChange={e => { set(e.target.value); setOk('') }} onBlur={() => touch(k)}
                aria-invalid={show(k) ? true : undefined}
                style={{ ...S_INPUT, width: '100%', ...(show(k) ? { borderColor: 'var(--app-danger)' } : null) }} />
            {show(k) && <p style={{ ...S_NOTE, color: 'var(--app-danger)', marginTop: 4 }}>{show(k)}</p>}
        </div>
    )

    return (
        <form onSubmit={e => void submit(e)} noValidate style={{ padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
            <p style={{ ...S_NOTE, marginBottom: 10 }}>
                At least 10 characters. Changing it signs out your other devices.
            </p>
            {/* Hidden username so password managers file the new password under the right account. */}
            <input type="text" autoComplete="username" hidden readOnly value={user?.username ?? ''} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {field('pw-current', 'Current password', current, setCurrent, 'current', 'current-password')}
                {field('pw-new', 'New password', next, setNext, 'next', 'new-password')}
                {field('pw-confirm', 'Confirm new password', confirm, setConfirm, 'confirm', 'new-password')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <SButton type="submit" tone="primary" disabled={busy}>{busy ? 'Changing' : 'Change password'}</SButton>
                <Status error={error} ok={ok} />
            </div>
        </form>
    )
}

export function DevicesGroup() {
    const [rows, setRows] = useState<SessionRow[] | null>(null)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')
    const [busyId, setBusyId] = useState<string | null>(null)

    const load = useCallback(async () => {
        const r = await listSessions()
        if (r.ok) { setRows(r.data); setError('') }
        else setError(r.error)
    }, [])
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load sets state only after its fetch resolves
        void load()
    }, [load])

    async function signOut(row: SessionRow) {
        setBusyId(row.id); setError(''); setOk('')
        const r = await revokeSession(row.id)
        setBusyId(null)
        if (!r.ok) { setError(r.error); return }
        setOk(`Signed out ${row.label || 'that device'}.`)
        void load()
    }

    async function signOutOthers() {
        if (!window.confirm('Sign out every device except this one?')) return
        setBusyId('others'); setError(''); setOk('')
        const r = await revokeOtherSessions()
        setBusyId(null)
        if (!r.ok) { setError(r.error); return }
        setOk('Every other device was signed out.')
        void load()
    }

    const others = rows?.filter(r => !r.current).length ?? 0

    return (
        <>
            {rows === null && !error && <p style={{ ...S_NOTE, padding: '10px 0' }}>Loading devices</p>}
            {rows?.length === 0 && <p style={{ ...S_NOTE, padding: '10px 0' }}>No signed-in devices.</p>}
            {/* People's browsers first; scripts and API clients (a token used
                from code) under their own heading, so a raw client name does
                not read like a strange device. */}
            {[false, true].map(scripts => {
                const list = (rows ?? []).filter(r => describeDevice(r.label).script === scripts)
                if (!list.length) return null
                return (
                    <div key={String(scripts)}>
                        {scripts && <h4 style={{ margin: 0, padding: '16px 0 0', fontSize: 14, fontWeight: 700, color: 'hsl(var(--app-text))' }}>Apps and scripts</h4>}
                        {list.map(r => {
                            const name = describeDevice(r.label).name
                            return (
                                <PrefRow key={r.id}
                                    label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        {name}
                                        {r.current && <Pill tone="cyan">This device</Pill>}
                                    </span>}
                                    sub={`Signed in ${fmtShort(r.created_at)}, last active ${fmtShort(r.last_seen_at)}`}
                                    right={r.current ? null : (
                                        // Neutral on purpose: one red button per row read as a
                                        // column of alarms. Red is kept for "sign out all".
                                        <SButton disabled={busyId === r.id} onClick={() => void signOut(r)}
                                            title={`Sign out ${name}`}>
                                            {busyId === r.id ? 'Signing out' : 'Sign out'}
                                        </SButton>
                                    )} />
                            )
                        })}
                    </div>
                )
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', flexWrap: 'wrap' }}>
                {others > 0 && (
                    <SButton tone="danger" disabled={busyId === 'others'} onClick={() => void signOutOthers()}>
                        Sign out all other devices
                    </SButton>
                )}
                {error && <SButton onClick={() => void load()}>Retry</SButton>}
                <Status error={error} ok={ok} />
            </div>
        </>
    )
}

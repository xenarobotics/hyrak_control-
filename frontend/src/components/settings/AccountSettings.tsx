'use client'

// Settings > Account: the signed-in person's profile, password and signed-in
// devices. Unlike the rest of the settings page this lives on the server
// (/api/auth/me, /api/auth/sessions), so it follows the person to any
// browser.

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { fetchMe, storeUser, type AuthUser } from '@/lib/auth'
import { useAccess } from '@/hooks/useAccess'
import {
    changePassword, fmtWhen, listSessions, revokeOtherSessions, revokeSession, updateMe, type SessionRow,
} from '@/lib/workspaces'
import { passwordProblem } from '@/components/auth/AuthCard'
import { Pill, PrefRow, S_INPUT, S_LABEL, S_NOTE, SButton, Status } from '@/components/settings/primitives'

export function ProfileGroup() {
    const { user } = useAccess()
    // Drafts start empty and fall back to the stored values, so a profile
    // that arrives after mount still shows without an effect.
    const [name, setName] = useState<string | null>(null)
    const [email, setEmail] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [ok, setOk] = useState('')

    if (!user) return <p style={{ ...S_NOTE, padding: '10px 0' }}>Not signed in.</p>

    const curName = name ?? user.display_name ?? ''
    const curEmail = email ?? user.email ?? ''
    const dirty = curName.trim() !== (user.display_name ?? '') || curEmail.trim() !== (user.email ?? '')

    async function save(e: FormEvent) {
        e.preventDefault()
        if (!dirty || busy || !user) return
        if (curEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(curEmail.trim())) {
            setError('Enter a valid email address.')
            return
        }
        setBusy(true); setError(''); setOk('')
        const body: { display_name?: string; email?: string } = {}
        if (curName.trim() !== (user.display_name ?? '')) body.display_name = curName.trim()
        if (curEmail.trim() !== (user.email ?? '')) body.email = curEmail.trim()
        const r = await updateMe(body)
        setBusy(false)
        if (!r.ok) { setError(r.error); return }
        const next: AuthUser = { ...user, ...body, ...(r.data?.user ?? {}) }
        storeUser(next)
        setName(null); setEmail(null)
        setOk('Profile saved.')
        void fetchMe()
    }

    return (
        <form onSubmit={e => void save(e)} noValidate>
            <PrefRow label="Username" sub="Sign in with this or your email"
                right={<span style={{ fontSize: 12, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>{user.username}</span>} />
            <PrefRow label={<label htmlFor="acct-name">Display name</label>} sub="Shown to the people in your workspaces"
                right={<input id="acct-name" value={curName} autoComplete="name"
                    onChange={e => { setName(e.target.value); setOk('') }} style={{ ...S_INPUT, width: 220 }} />} />
            <PrefRow label={<label htmlFor="acct-email">Email</label>} sub="Used to sign in"
                right={<input id="acct-email" type="email" value={curEmail} autoComplete="email" spellCheck={false}
                    onChange={e => { setEmail(e.target.value); setError(''); setOk('') }} style={{ ...S_INPUT, width: 220 }} />} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
                <SButton type="submit" tone="primary" disabled={!dirty || busy}>{busy ? 'Saving' : 'Save profile'}</SButton>
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
            <label htmlFor={id} style={S_LABEL}>{label}</label>
            <input id={id} type="password" autoComplete={auto} value={value}
                onChange={e => { set(e.target.value); setOk('') }} onBlur={() => touch(k)}
                aria-invalid={show(k) ? true : undefined}
                style={{ ...S_INPUT, width: '100%', ...(show(k) ? { borderColor: '#f87171' } : null) }} />
            {show(k) && <p style={{ ...S_NOTE, color: '#f87171', marginTop: 4 }}>{show(k)}</p>}
        </div>
    )

    return (
        <form onSubmit={e => void submit(e)} noValidate style={{ padding: '10px 0', borderBottom: '1px solid hsl(var(--app-border))' }}>
            <p style={{ ...S_NOTE, marginBottom: 10 }}>
                At least 10 characters, no other rules. Changing it signs out every other device.
            </p>
            {/* Hidden username so password managers file the new password under the right account. */}
            <input type="text" autoComplete="username" hidden readOnly value={user?.username ?? ''} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {field('pw-current', 'CURRENT PASSWORD', current, setCurrent, 'current', 'current-password')}
                {field('pw-new', 'NEW PASSWORD', next, setNext, 'next', 'new-password')}
                {field('pw-confirm', 'CONFIRM NEW PASSWORD', confirm, setConfirm, 'confirm', 'new-password')}
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
            {rows?.map(r => (
                <PrefRow key={r.id}
                    label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {r.label || 'Unnamed device'}
                        {r.current && <Pill tone="cyan">THIS DEVICE</Pill>}
                    </span>}
                    sub={`Signed in ${fmtWhen(r.created_at)} - last active ${fmtWhen(r.last_seen_at)}`}
                    right={r.current ? null : (
                        <SButton tone="danger" disabled={busyId === r.id} onClick={() => void signOut(r)}>
                            {busyId === r.id ? 'Signing out' : 'Sign out'}
                        </SButton>
                    )} />
            ))}
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

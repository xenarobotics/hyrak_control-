'use client'

// /invite/<token> - public. Shows who invited you to which workspace and as
// what, then either adds the membership to the account you are signed in
// with, or creates a new account (name, email, password) and signs it in.
// Invite links are single use and expire; the server says so in its reply.

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { fetchMe, getToken, getUser, logout, storeSession } from '@/lib/auth'
import { KIND_LABELS, roleLabel } from '@/lib/access'
import {
    acceptInviteSignedIn, acceptInviteSignUp, fmtWhen, personName, previewInvite, type InvitePreview,
} from '@/lib/workspaces'
import {
    AuthButton, AuthError, AuthField, AuthFrame, AUTH_NOTE, passwordProblem,
} from '@/components/auth/AuthCard'
import { useClientValue, useHydrated } from '@/hooks/useClientValue'

const AFTER_JOIN = '/fly'

export default function InvitePage() {
    const { token } = useParams<{ token: string }>()
    const router = useRouter()
    const [preview, setPreview] = useState<InvitePreview | null>(null)
    const [loadError, setLoadError] = useState('')
    // The server render has no localStorage: wait for hydration before
    // choosing between "join" and "create account".
    const hydrated = useHydrated()
    const storedName = useClientValue(() => {
        const u = getToken() ? getUser() : null
        return u ? personName(u) : ''
    }, '')
    const [signedOut, setSignedOut] = useState(false)
    const signedInName = !signedOut && storedName ? storedName : null

    useEffect(() => {
        let alive = true
        void previewInvite(token).then(r => {
            if (!alive) return
            if (r.ok) setPreview(r.data)
            else setLoadError(r.status === 404 || r.status === 410
                ? 'This invite link is not valid any more. It may have been used, revoked or expired. Ask for a new one.'
                : r.error)
        })
        return () => { alive = false }
    }, [token])

    if (loadError) {
        return (
            <AuthFrame title="Invite link" sub="HYRAK">
                <AuthError text={loadError} />
                <Link href="/login" style={{ ...AUTH_NOTE, textDecoration: 'underline' }}>Go to sign in</Link>
            </AuthFrame>
        )
    }
    if (!preview || !hydrated) {
        return (
            <AuthFrame title="Invite link" sub="Checking the invite">
                <Loader2 size={16} className="animate-spin" style={{ color: 'hsl(var(--app-text-muted))' }} />
            </AuthFrame>
        )
    }

    const role = roleLabel(preview.role, preview.workspace_kind)
    const sub = `${KIND_LABELS[preview.workspace_kind] ?? preview.workspace_kind} - invited as ${role}`
    const meta = [
        preview.title,
        preview.invited_by && `Invited by ${preview.invited_by}`,
        preview.expires_at && `Expires ${fmtWhen(preview.expires_at)}`,
    ].filter(Boolean).join(' - ')

    return signedInName
        ? <JoinSignedIn token={token} preview={preview} role={role} sub={sub} meta={meta} name={signedInName}
            onSignedOut={() => setSignedOut(true)} onJoined={() => router.replace(AFTER_JOIN)} />
        : <JoinSignUp token={token} preview={preview} sub={sub} meta={meta}
            onJoined={() => router.replace(AFTER_JOIN)} />
}

function JoinSignedIn({ token, preview, role, sub, meta, name, onSignedOut, onJoined }: {
    token: string; preview: InvitePreview; role: string; sub: string; meta: string; name: string
    onSignedOut: () => void; onJoined: () => void
}) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    async function join() {
        if (busy) return
        setBusy(true)
        setError('')
        const r = await acceptInviteSignedIn(token)
        if (r.ok) {
            await fetchMe()
            onJoined()
            return
        }
        setBusy(false)
        if (r.status === 401) {
            // The stored sign-in had expired: create or sign in fresh.
            await logout()
            onSignedOut()
            return
        }
        setError(r.error)
    }

    async function switchAccount() {
        await logout()
        onSignedOut()
    }

    return (
        <AuthFrame title={`Join ${preview.workspace_name}`} sub={sub}>
            {meta && <p style={AUTH_NOTE}>{meta}</p>}
            <p style={{ ...AUTH_NOTE, color: 'hsl(var(--app-text))' }}>Signed in as {name}.</p>
            <AuthError text={error} />
            <AuthButton type="button" busy={busy} busyText="Joining" onClick={() => void join()}>
                Join {preview.workspace_name} as {role}
            </AuthButton>
            <button type="button" onClick={() => void switchAccount()}
                style={{ ...AUTH_NOTE, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline' }}>
                Not you? Sign out and create a new account
            </button>
        </AuthFrame>
    )
}

function JoinSignUp({ token, preview, sub, meta, onJoined }: {
    token: string; preview: InvitePreview; sub: string; meta: string; onJoined: () => void
}) {
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    // Fields are checked when you leave them, and an error clears as soon as
    // the field is fixed.
    const [touched, setTouched] = useState<Record<string, boolean>>({})
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    const problems = {
        name: name.trim() ? '' : 'Enter your name.',
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? '' : 'Enter a valid email address.',
        password: passwordProblem(password),
        confirm: confirm === password ? '' : 'The passwords do not match.',
    }
    const show = (k: keyof typeof problems) => (touched[k] ? problems[k] : '')
    const touch = (k: string) => setTouched(t => ({ ...t, [k]: true }))

    async function onSubmit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setTouched({ name: true, email: true, password: true, confirm: true })
        if (Object.values(problems).some(Boolean)) return
        setBusy(true)
        setError('')
        const r = await acceptInviteSignUp(token, {
            display_name: name.trim(), email: email.trim(), password,
        })
        if (!r.ok || !r.data?.token || !r.data?.user) {
            setBusy(false)
            setError(r.ok ? 'The server did not return a sign-in. Try signing in.' : r.error)
            return
        }
        storeSession(r.data.token, r.data.user)
        await fetchMe()
        onJoined()
    }

    const next = encodeURIComponent(`/invite/${token}`)
    return (
        <AuthFrame title={`Join ${preview.workspace_name}`} sub={sub} onSubmit={e => void onSubmit(e)}>
            {meta && <p style={AUTH_NOTE}>{meta}</p>}
            <AuthField id="inv-name" label="YOUR NAME" autoComplete="name" autoFocus
                value={name} onChange={e => setName(e.target.value)} onBlur={() => touch('name')}
                error={show('name')} />
            <AuthField id="inv-email" label="EMAIL" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                value={email} onChange={e => setEmail(e.target.value)} onBlur={() => touch('email')}
                error={show('email')}
                hint={preview.email_locked ? 'This invite is for one email address. Use the one it was sent to.' : 'You sign in with this.'} />
            <AuthField id="inv-password" label="PASSWORD" type="password" autoComplete="new-password"
                value={password} onChange={e => setPassword(e.target.value)} onBlur={() => touch('password')}
                error={show('password')} hint="At least 10 characters. A short sentence works well." />
            <AuthField id="inv-confirm" label="CONFIRM PASSWORD" type="password" autoComplete="new-password"
                value={confirm} onChange={e => setConfirm(e.target.value)} onBlur={() => touch('confirm')}
                error={show('confirm')} />
            <AuthError text={error} />
            <AuthButton busy={busy} busyText="Creating account">Create account and join</AuthButton>
            <p style={AUTH_NOTE}>
                Already have an account? <Link href={`/login?next=${next}`} style={{ textDecoration: 'underline' }}>Sign in</Link> and
                you come straight back here to join.
            </p>
        </AuthFrame>
    )
}

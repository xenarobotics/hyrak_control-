'use client'

// /reset/<token> - public. Sets a new password from a one-hour, single-use
// reset link that a founder issued from the console (self-service "forgot
// password" arrives with outgoing email).

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { resetPassword } from '@/lib/workspaces'
import {
    AuthButton, AuthError, AuthField, AuthFrame, AUTH_NOTE, AUTH_PRIMARY, passwordProblem,
} from '@/components/auth/AuthCard'

export default function ResetPage() {
    const { token } = useParams<{ token: string }>()
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [touched, setTouched] = useState<Record<string, boolean>>({})
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState(false)

    const problems = {
        password: passwordProblem(password),
        confirm: confirm === password ? '' : 'The passwords do not match.',
    }
    const show = (k: keyof typeof problems) => (touched[k] ? problems[k] : '')

    async function onSubmit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setTouched({ password: true, confirm: true })
        if (problems.password || problems.confirm) return
        setBusy(true)
        setError('')
        const r = await resetPassword(token, password)
        setBusy(false)
        if (r.ok) { setDone(true); return }
        setError(r.status === 404 || r.status === 410
            ? 'This reset link is not valid any more. It may have been used or expired. Ask HYRAK for a new one.'
            : r.error)
    }

    if (done) {
        return (
            <AuthFrame title="Password changed" sub="HYRAK">
                <p style={AUTH_NOTE}>Sign in with your new password.</p>
                <Link href="/login" style={AUTH_PRIMARY}>
                    Go to sign in
                </Link>
            </AuthFrame>
        )
    }

    return (
        <AuthFrame title="Set a new password" sub="Reset links work once, for one hour" onSubmit={e => void onSubmit(e)}>
            <AuthField id="reset-password" label="New password" type="password" autoComplete="new-password" autoFocus
                value={password} onChange={e => setPassword(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, password: true }))}
                error={show('password')} hint="At least 10 characters. A short sentence works well." />
            <AuthField id="reset-confirm" label="Confirm password" type="password" autoComplete="new-password"
                value={confirm} onChange={e => setConfirm(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, confirm: true }))}
                error={show('confirm')} />
            <AuthError text={error} />
            <AuthButton busy={busy} busyText="Saving">Set password</AuthButton>
        </AuthFrame>
    )
}

'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getToken, login } from '@/lib/auth'
import { AuthButton, AuthError, AuthField, AuthFrame, AUTH_NOTE } from '@/components/auth/AuthCard'

const FALLBACK_NEXT = '/fly'

function safeNext(raw: string | null): string {
    // Only a same-origin path may win. A prefix test is not enough:
    // "/\\evil.com" is read as a host by browsers, and control characters
    // can split or hide the real target. Parse it against our origin and
    // insist the result stays there.
    if (!raw || typeof window === 'undefined') return FALLBACK_NEXT
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(raw)) return FALLBACK_NEXT
    if (!raw.startsWith('/') || raw.startsWith('//')) return FALLBACK_NEXT
    let url: URL
    try { url = new URL(raw, window.location.origin) } catch { return FALLBACK_NEXT }
    if (url.origin !== window.location.origin) return FALLBACK_NEXT
    // Validate what we will actually navigate to, not only the input: the
    // URL parser normalises, so rebuild a single-slash path and check again.
    const out = '/' + url.pathname.replace(/^\/+/, '') + url.search + url.hash
    if (!out.startsWith('/') || out.startsWith('//') || out.includes('\\')) return FALLBACK_NEXT
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(out)) return FALLBACK_NEXT
    if (out === '/login' || out.startsWith('/login/') || out.startsWith('/login?') || out.startsWith('/login#')) return FALLBACK_NEXT
    return out
}

function LoginForm() {
    const router = useRouter()
    const params = useSearchParams()
    const next = safeNext(params.get('next'))
    const [loginName, setLoginName] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    // Already signed in: straight through.
    useEffect(() => { if (getToken()) router.replace(next) }, [router, next])

    async function onSubmit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setError('')
        if (!loginName.trim() || !password) {
            setError('Enter your email or username, and your password.')
            return
        }
        setBusy(true)
        try {
            await login(loginName.trim(), password)
            router.replace(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign-in failed')
            setBusy(false)
        }
    }

    return (
        <AuthFrame title="Sign in to HYRAK" sub="Use your email or username" onSubmit={e => void onSubmit(e)}>
            <AuthField
                id="login-username" name="username" label="Email or username" type="text" autoComplete="username"
                autoFocus autoCapitalize="none" spellCheck={false}
                value={loginName} onChange={e => setLoginName(e.target.value)}
            />
            <AuthField
                id="login-password" name="password" label="Password" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)}
            />
            <AuthError text={error} />
            <AuthButton busy={busy} busyText="Signing in">Sign in</AuthButton>
            <p style={AUTH_NOTE}>
                No account? Ask your workspace owner for an invite link.
                Forgot your password? Ask HYRAK for a reset link.
            </p>
        </AuthFrame>
    )
}

// useSearchParams needs a Suspense boundary for the static build of this
// route; the fallback is the same empty frame the form sits in.
export default function LoginPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: '100%', background: 'hsl(var(--app-bg))' }} />}>
            <LoginForm />
        </Suspense>
    )
}

'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { Loader2 } from 'lucide-react'
import { getToken, login } from '@/lib/auth'

const LABEL: React.CSSProperties = {
    display: 'block', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
    letterSpacing: '0.12em', color: 'hsl(var(--app-text-muted))', marginBottom: 6,
}
const INPUT: React.CSSProperties = {
    width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
    color: 'hsl(var(--app-text))', outline: 'none',
}

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
    if (url.pathname.startsWith('/login')) return FALLBACK_NEXT
    return url.pathname + url.search + url.hash
}

function LoginForm() {
    const router = useRouter()
    const params = useSearchParams()
    const next = safeNext(params.get('next'))
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    // Already signed in: straight through.
    useEffect(() => { if (getToken()) router.replace(next) }, [router, next])

    async function onSubmit(e: FormEvent) {
        e.preventDefault()
        if (busy) return
        setError('')
        if (!username.trim() || !password) {
            setError('Enter your username and password.')
            return
        }
        setBusy(true)
        try {
            await login(username.trim(), password)
            router.replace(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign-in failed')
            setBusy(false)
        }
    }

    return (
        <div style={{
            minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))',
        }}>
            <form onSubmit={onSubmit} noValidate style={{
                width: '100%', maxWidth: 360, padding: '28px 28px 24px', borderRadius: 16,
                background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))',
                display: 'flex', flexDirection: 'column', gap: 16,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Image src="/brand/icon-dark.png" alt="" width={28} height={28} className="dark:hidden" />
                    <Image src="/brand/icon.png" alt="" width={28} height={28} className="hidden dark:block" />
                    <div>
                        <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Sign in to HYRAK</p>
                        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>
                            Flight control needs an operator account
                        </p>
                    </div>
                </div>

                <div>
                    <label htmlFor="login-username" style={LABEL}>USERNAME</label>
                    <input
                        id="login-username" name="username" type="text" autoComplete="username"
                        autoFocus autoCapitalize="none" spellCheck={false}
                        value={username} onChange={e => setUsername(e.target.value)}
                        style={INPUT}
                    />
                </div>
                <div>
                    <label htmlFor="login-password" style={LABEL}>PASSWORD</label>
                    <input
                        id="login-password" name="password" type="password" autoComplete="current-password"
                        value={password} onChange={e => setPassword(e.target.value)}
                        style={INPUT}
                    />
                </div>

                {error && (
                    <p role="alert" style={{
                        margin: 0, fontSize: 12, fontFamily: 'monospace', lineHeight: 1.5,
                        color: '#f87171',
                    }}>
                        {error}
                    </p>
                )}

                <button type="submit" disabled={busy} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '10px 14px', borderRadius: 8, border: 'none', cursor: busy ? 'default' : 'pointer',
                    background: '#22d3ee', color: '#0b1016', fontSize: 13, fontFamily: 'monospace', fontWeight: 700,
                    opacity: busy ? 0.7 : 1,
                }}>
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {busy ? 'Signing in' : 'Sign in'}
                </button>

                <p style={{ margin: 0, fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', lineHeight: 1.5 }}>
                    No account yet? An admin creates one on the server:
                    python -m app.auth.cli create-user
                </p>
            </form>
        </div>
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

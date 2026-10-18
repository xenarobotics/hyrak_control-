'use client'

// The frame shared by the public sign-in pages (/login, /invite/<token>,
// /reset/<token>): a centred card on the app background with the HYRAK mark,
// mono field labels and the cyan primary button.

import Image from 'next/image'
import { Loader2 } from 'lucide-react'

export const AUTH_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
    letterSpacing: '0.12em', color: 'hsl(var(--app-text-muted))', marginBottom: 6,
}
export const AUTH_INPUT: React.CSSProperties = {
    width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
    color: 'hsl(var(--app-text))', outline: 'none',
}
export const AUTH_NOTE: React.CSSProperties = {
    margin: 0, fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', lineHeight: 1.5,
}

export function AuthFrame({ title, sub, children, onSubmit }: {
    title: string
    sub?: React.ReactNode
    children: React.ReactNode
    onSubmit?: (e: React.FormEvent) => void
}) {
    const body = (
        <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Image src="/brand/icon-dark.png" alt="" width={28} height={28} className="dark:hidden" />
                <Image src="/brand/icon.png" alt="" width={28} height={28} className="hidden dark:block" />
                <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{title}</p>
                    {sub && (
                        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>
                            {sub}
                        </p>
                    )}
                </div>
            </div>
            {children}
        </>
    )
    const card: React.CSSProperties = {
        width: '100%', maxWidth: 380, padding: '28px 28px 24px', borderRadius: 16,
        background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))',
        display: 'flex', flexDirection: 'column', gap: 16,
    }
    return (
        <div style={{
            minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, background: 'hsl(var(--app-bg))', color: 'hsl(var(--app-text))',
        }}>
            {onSubmit
                ? <form onSubmit={onSubmit} noValidate style={card}>{body}</form>
                : <div style={card}>{body}</div>}
        </div>
    )
}

export function AuthField({ id, label, error, hint, ...input }: {
    id: string
    label: string
    error?: string
    hint?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <div>
            <label htmlFor={id} style={AUTH_LABEL}>{label}</label>
            <input
                id={id} aria-invalid={error ? true : undefined}
                aria-describedby={error || hint ? `${id}-note` : undefined}
                {...input}
                style={{ ...AUTH_INPUT, ...(error ? { borderColor: '#f87171' } : null), ...input.style }}
            />
            {(error || hint) && (
                <p id={`${id}-note`} style={{ ...AUTH_NOTE, marginTop: 5, color: error ? '#f87171' : AUTH_NOTE.color }}>
                    {error || hint}
                </p>
            )}
        </div>
    )
}

export function AuthError({ text }: { text: string }) {
    if (!text) return null
    return (
        <p role="alert" style={{ margin: 0, fontSize: 12, fontFamily: 'monospace', lineHeight: 1.5, color: '#f87171' }}>
            {text}
        </p>
    )
}

export function AuthButton({ busy, children, busyText, onClick, type = 'submit', subtle }: {
    busy?: boolean
    children: React.ReactNode
    busyText?: string
    onClick?: () => void
    type?: 'submit' | 'button'
    subtle?: boolean
}) {
    return (
        <button type={type} disabled={busy} onClick={onClick} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '10px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
            border: subtle ? '1px solid hsl(var(--app-border))' : 'none',
            background: subtle ? 'transparent' : '#22d3ee',
            color: subtle ? 'hsl(var(--app-text))' : '#0b1016',
            fontSize: 13, fontFamily: 'monospace', fontWeight: 700,
            opacity: busy ? 0.7 : 1,
        }}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy && busyText ? busyText : children}
        </button>
    )
}

export const MIN_PASSWORD = 10

/** NIST 800-63B: length only, no composition rules. '' when fine. */
export function passwordProblem(pw: string): string {
    if (!pw) return 'Choose a password.'
    if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
    return ''
}

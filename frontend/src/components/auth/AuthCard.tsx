'use client'

// The frame shared by the public sign-in pages (/login, /invite/<token>,
// /reset/<token>): a centred card on the app background with the HYRAK mark,
// sentence-case field labels and the accent primary button.

import Image from 'next/image'
import { Loader2 } from 'lucide-react'

export const AUTH_LABEL: React.CSSProperties = {
    display: 'block', fontSize: 13, fontWeight: 600,
    color: 'hsl(var(--app-text))', marginBottom: 6,
}
export const AUTH_INPUT: React.CSSProperties = {
    width: '100%', minHeight: 40, padding: '9px 12px', borderRadius: 6, fontSize: 14,
    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border-strong))',
    color: 'hsl(var(--app-text))',
}
export const AUTH_NOTE: React.CSSProperties = {
    margin: 0, fontSize: 13, color: 'hsl(var(--app-text-muted))', lineHeight: 1.5,
}
/** The filled accent action, for a link styled as the primary button. */
export const AUTH_PRIMARY: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 40, padding: '10px 16px', borderRadius: 6, border: 'none',
    background: 'var(--app-accent)', color: 'var(--app-accent-ink)',
    fontSize: 14, fontWeight: 700,
    transition: 'opacity var(--dur-fast) var(--ease-out)',
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
                <Image src="/brand/icon-dark.png" alt="" width={32} height={32} className="dark:hidden" />
                <Image src="/brand/icon.png" alt="" width={32} height={32} className="hidden dark:block" />
                <div style={{ minWidth: 0 }}>
                    <h1 style={{ fontSize: 'var(--fs-xl)', lineHeight: '28px', fontWeight: 700, margin: 0 }}>{title}</h1>
                    {sub && (
                        <p style={{ fontSize: 13, color: 'hsl(var(--app-text-muted))', margin: '2px 0 0' }}>
                            {sub}
                        </p>
                    )}
                </div>
            </div>
            {children}
        </>
    )
    const card: React.CSSProperties = {
        width: '100%', maxWidth: 400, padding: 24, borderRadius: 14,
        background: 'hsl(var(--app-surface))', border: '1px solid hsl(var(--app-border))',
        boxShadow: 'var(--app-shadow)',
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
                style={{ ...AUTH_INPUT, ...(error ? { borderColor: 'var(--app-danger)' } : null), ...input.style }}
            />
            {(error || hint) && (
                <p id={`${id}-note`} style={{ ...AUTH_NOTE, marginTop: 5, color: error ? 'var(--app-danger)' : AUTH_NOTE.color }}>
                    {error || hint}
                </p>
            )}
        </div>
    )
}

export function AuthError({ text }: { text: string }) {
    if (!text) return null
    return (
        <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--app-danger)' }}>
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
            ...AUTH_PRIMARY,
            cursor: busy ? 'progress' : 'pointer',
            border: subtle ? '1px solid hsl(var(--app-border-strong))' : 'none',
            background: subtle ? 'transparent' : 'var(--app-accent)',
            color: subtle ? 'hsl(var(--app-text))' : 'var(--app-accent-ink)',
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

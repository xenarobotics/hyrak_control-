'use client'

// Small pieces of the HYRAK console's visual language, shared by its tabs:
// mono uppercase labels, 1px zinc borders, toned outline buttons and tags.

import { useRef, useState } from 'react'
import { copyText } from '@/lib/workspaces'

export const INPUT_CLS = 'bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500 min-w-0'
export const LABEL_CLS = 'block text-[9px] tracking-widest text-zinc-500 mb-1'

export function Tag({ label, tone }: { label: string; tone: 'amber' | 'emerald' | 'red' | 'zinc' | 'violet' | 'cyan' }) {
    const cls = {
        amber:   'text-amber-500/80 border-amber-500/30',
        emerald: 'text-emerald-400 border-emerald-500/30',
        red:     'text-red-400 border-red-500/40',
        zinc:    'text-zinc-500 border-zinc-700',
        violet:  'text-violet-400 border-violet-500/30',
        cyan:    'text-cyan-400 border-cyan-500/30',
    }[tone]
    return <span className={`border rounded px-1 text-[10px] whitespace-nowrap ${cls}`}>{label}</span>
}

type Tone = 'plain' | 'cyan' | 'emerald' | 'red'
const BTN: Record<Tone, string> = {
    plain:   'border-zinc-700 text-zinc-400 hover:border-zinc-500',
    cyan:    'border-cyan-700 text-cyan-400 hover:border-cyan-500',
    emerald: 'border-emerald-700 text-emerald-400 hover:border-emerald-500',
    red:     'border-red-800 text-red-400 hover:border-red-600',
}

export function Btn({ tone = 'plain', onClick, disabled, type = 'button', children, className = '', title }: {
    tone?: Tone
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit'
    children: React.ReactNode
    className?: string
    title?: string
}) {
    return (
        <button type={type} onClick={onClick} disabled={disabled} title={title}
            className={`px-2 py-1 rounded border text-[10px] whitespace-nowrap disabled:border-zinc-800 disabled:text-zinc-600 ${BTN[tone]} ${className}`}>
            {children}
        </button>
    )
}

export function Section({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="border border-zinc-800 rounded">
            <div className="px-3 py-2 text-[10px] tracking-widest text-zinc-500 border-b border-zinc-800 flex items-center gap-2">
                <span className="truncate">{title}</span>
                {right && <span className="ml-auto flex items-center gap-2">{right}</span>}
            </div>
            {children}
        </div>
    )
}

/** The server's message, verbatim, or a short confirmation. */
export function Notice({ error, ok }: { error?: string; ok?: string }) {
    if (!error && !ok) return null
    return (
        <div role={error ? 'alert' : 'status'} className={`text-[10px] ${error ? 'text-red-400' : 'text-emerald-400'}`}>
            {error || ok}
        </div>
    )
}

export function Empty({ children }: { children: React.ReactNode }) {
    return <div className="p-3 text-[10px] text-zinc-600">{children}</div>
}

/** A one-time link (invite, password reset): read-only field + COPY. */
export function CopyLink({ label, url, note }: { label: string; url: string; note?: string }) {
    const ref = useRef<HTMLInputElement>(null)
    const [msg, setMsg] = useState('')
    return (
        <div className="space-y-1">
            <div className={LABEL_CLS}>{label}</div>
            <div className="flex gap-2">
                <input ref={ref} readOnly value={url} onFocus={e => e.currentTarget.select()}
                    aria-label={label} className={`${INPUT_CLS} flex-1`} />
                <Btn tone="cyan" onClick={() => {
                    void copyText(url, ref.current).then(how =>
                        setMsg(how === 'copied' ? 'COPIED' : 'SELECTED - PRESS CTRL+C'))
                }}>
                    {msg === 'COPIED' ? 'COPIED' : 'COPY'}
                </Btn>
            </div>
            <div className="text-[9px] text-zinc-600">{msg && msg !== 'COPIED' ? msg : note}</div>
        </div>
    )
}

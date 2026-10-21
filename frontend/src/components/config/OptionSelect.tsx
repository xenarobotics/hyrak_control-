'use client'

// A drop-in for a native <select> with a plain list of options, built on the
// shared Select (components/ui/select). One look for every picker in the app:
// same height, chevron, radius and popup as the status bar and /fly.
//
// Values keep their type: a numeric option comes back as a number, so a
// call site that did `+e.target.value` gets the same value it always did.

import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type Option<T extends string | number> = { value: T; label: React.ReactNode; disabled?: boolean }

export function OptionSelect<T extends string | number>({
    value, options, onChange, disabled, id, className, placeholder, size = 'default',
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledby, title,
}: {
    value: T | null | undefined
    options: ReadonlyArray<Option<T>>
    onChange: (v: T) => void
    disabled?: boolean
    id?: string
    className?: string
    placeholder?: string
    size?: 'sm' | 'default'
    'aria-label'?: string
    'aria-labelledby'?: string
    title?: string
}) {
    const key = value == null ? null : String(value)
    const current = options.find(o => String(o.value) === key)
    return (
        <Select
            value={key}
            disabled={disabled}
            onValueChange={(v) => {
                if (v == null) return
                const hit = options.find(o => String(o.value) === v)
                if (hit) onChange(hit.value)
            }}
        >
            <SelectTrigger id={id} size={size} aria-label={ariaLabel} aria-labelledby={ariaLabelledby} title={title}
                className={cn(
                    'w-full max-w-full min-w-0 overflow-hidden text-left [&>span]:min-w-0 [&>span]:truncate',
                    'disabled:opacity-100 data-[disabled]:opacity-100 data-[disabled]:cursor-not-allowed data-[disabled]:bg-app-surface-2 data-[disabled]:text-app-text-muted',
                    className,
                )}>
                <SelectValue placeholder={placeholder}>
                    {current ? current.label : (placeholder ?? '')}
                </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
                {options.map(o => (
                    <SelectItem key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
                        {o.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

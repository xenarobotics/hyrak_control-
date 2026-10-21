'use client'

// One segmented control for the whole app (docs/DESIGN_SYSTEM.md): a single
// choice out of a few, shown side by side. Inset track on surface-2, the
// chosen option on the accent tint with --app-selected-ink (4.5:1 or more
// in every theme). Wraps instead of
// overflowing when the row is narrow. Every option keeps a visible label.

import { cn } from '@/lib/utils'

export type SegmentedOption<T extends string> = {
    value: T
    label: React.ReactNode
    icon?: React.ReactNode
    /** Tooltip, e.g. what the option does or why it is unavailable. */
    title?: string
    disabled?: boolean
}

export function Segmented<T extends string>({
    value, options, onChange, ariaLabel, size = 'md', className,
}: {
    value: T
    options: SegmentedOption<T>[]
    onChange: (v: T) => void
    ariaLabel?: string
    /** md: 32px options (settings, forms). sm: 28px for dense toolbars. */
    size?: 'sm' | 'md'
    className?: string
}) {
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className={cn(
                'inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-app-border bg-app-surface-2 p-0.5',
                className,
            )}
        >
            {options.map(o => {
                const on = o.value === value
                return (
                    <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        disabled={o.disabled}
                        title={o.title}
                        onClick={() => { if (!on) onChange(o.value) }}
                        className={cn(
                            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] px-3 font-semibold',
                            'transition-[color,background-color,box-shadow] duration-[140ms] ease-[cubic-bezier(.2,.8,.2,1)]',
                            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-accent)]',
                            size === 'sm' ? 'h-7 text-[12px]' : 'h-8 text-[13px]',
                            on
                                ? 'bg-app-accent-soft text-app-selected-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--app-accent)_45%,transparent)]'
                                : 'text-app-text-muted hover:text-app-text hover:bg-app-surface',
                            o.disabled && 'cursor-not-allowed text-app-text-subtle hover:text-app-text-subtle',
                        )}
                    >
                        {o.icon}
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

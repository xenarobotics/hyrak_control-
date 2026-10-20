'use client'

// One attachment action as a button. An action that can hurt someone takes
// two presses: the first turns it amber ("Press again") for 4 s, the second
// fires it with confirm. A disabled button keeps its tooltip (on a wrapper,
// since a disabled button gets no pointer events in some browsers).

import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CONFIRM_WINDOW_MS } from '@/lib/attachments'
import a from './attachments.module.css'

export function ActionButton({ hazard, label, icon, title, disabledReason, onFire, className, armedLabel = 'Press again' }: {
    hazard: boolean
    label: string
    icon?: ReactNode
    /** Tooltip while enabled. */
    title?: string
    /** Disabled, and why (shown as the tooltip). */
    disabledReason?: string | null
    /** confirm is true after the second press of a hazard action. */
    onFire: (confirm: boolean) => void
    className?: string
    armedLabel?: string
}) {
    const [armed, setArmed] = useState(false)
    const disabled = !!disabledReason

    useEffect(() => {
        if (!armed) return
        const id = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS)
        return () => clearTimeout(id)
    }, [armed])

    const press = () => {
        if (disabled) return
        if (!hazard) { onFire(false); return }
        if (armed) { setArmed(false); onFire(true); return }
        setArmed(true)
    }
    const tip = disabledReason ?? (armed ? `Press again within ${CONFIRM_WINDOW_MS / 1000} s to ${label.toLowerCase()}` : title)
        ?? (hazard ? `${label}. Can hurt someone: press twice.` : label)

    const btn = (
        <button type="button" className={cn(a.act, className)} data-hazard={hazard} data-armed={armed && !disabled}
            disabled={disabled} onClick={press} title={disabled ? undefined : tip}
            aria-label={armed ? `${label}: ${armedLabel}` : label}>
            {icon}
            <span>{armed && !disabled ? armedLabel : label}</span>
        </button>
    )
    if (!disabled) return btn
    return <span title={tip} className={a.tipWrap}>{btn}</span>
}

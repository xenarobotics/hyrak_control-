import { cn } from '@/lib/utils'

/**
 * Disabled buttons get no pointer events, so their own title never shows.
 * This wrapper carries the "why" tooltip instead. Pass reason=null when the
 * control is enabled and the wrapper adds nothing.
 */
export function WhyDisabled({ reason, children, className }: {
    reason: string | null | undefined
    children: React.ReactNode
    className?: string
}) {
    if (!reason) return <>{children}</>
    return (
        <span title={reason} className={cn('block cursor-not-allowed', className)}>
            {children}
        </span>
    )
}

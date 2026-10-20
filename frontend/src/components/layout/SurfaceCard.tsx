import { cn } from '@/lib/utils'

/** The titled panel card used by the Fly and Command tabs. */
export function SurfaceCard({ title, children, className }: {
    title: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            className={cn('rounded-[10px] border border-app-border bg-app-surface p-4 shadow-[var(--app-shadow)] flex flex-col gap-3', className)}
        >
            <h2 className="m-0 text-[12px] font-bold uppercase tracking-[0.06em] text-app-text-muted">
                {title}
            </h2>
            {children}
        </div>
    )
}

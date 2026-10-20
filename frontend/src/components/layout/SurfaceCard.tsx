import { cn } from '@/lib/utils'

/** The titled panel card used by the Fly and Command tabs. */
export function SurfaceCard({ title, children, className }: {
    title: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            className={cn('rounded-[10px] border border-app-border bg-app-surface p-4 flex flex-col gap-3', className)}
        >
            <h2 className="m-0 text-[13px] font-bold text-app-text-muted">
                {title}
            </h2>
            {children}
        </div>
    )
}

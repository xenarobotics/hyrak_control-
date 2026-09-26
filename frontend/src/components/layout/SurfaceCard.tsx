import { cn } from '@/lib/utils'

/** The titled panel card used by the Fly and Command tabs. */
export function SurfaceCard({ title, children, className }: {
    title: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div
            className={cn('rounded-xl border p-4 flex flex-col gap-3', className)}
            style={{
                background: 'hsl(var(--app-surface))',
                borderColor: 'hsl(var(--app-border))',
            }}
        >
            <p className="text-[10px] font-mono tracking-widest"
                style={{ color: 'hsl(var(--app-text-muted))' }}
            >
                {title}
            </p>
            {children}
        </div>
    )
}

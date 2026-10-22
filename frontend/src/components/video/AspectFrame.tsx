'use client'

// The box the picture is drawn in, for every picture setting (VideoAspect in
// lib/videoSettings.ts):
//   fill / fit   the whole panel; children use object-fit cover / contain
//   16:9 4:3 1:1 a centred box of that shape, as large as the panel allows
//                (CSS container units, so no measuring); children fill it
//                with object-fit cover, cropping the source to the shape
// The video AND everything drawn over it (CvOverlayCanvas, the Copilot
// overlay) go inside one frame and take innerFit(aspect), so boxes and clicks
// land on the picture whichever option is chosen.
// The frame itself never takes pointer input (whatever sits under it, like
// the Start video button, stays clickable); a child that wants clicks sets
// pointer-events itself, as both overlays do.

import { aspectRatioOf, type VideoAspect } from '@/lib/videoSettings'
import { cn } from '@/lib/utils'

export function AspectFrame({ aspect, className, children }: {
    aspect: VideoAspect; className?: string; children: React.ReactNode
}) {
    const r = aspectRatioOf(aspect)
    if (r === null) return <div className={cn('absolute inset-0 pointer-events-none', className)}>{children}</div>
    return (
        <div className={cn('absolute inset-0 flex items-center justify-center pointer-events-none', className)}
            style={{ containerType: 'size' }}>
            <div className="relative overflow-hidden"
                style={{ width: `min(100cqw, ${r} * 100cqh)`, height: `min(100cqh, 100cqw / ${r})` }}>
                {children}
            </div>
        </div>
    )
}

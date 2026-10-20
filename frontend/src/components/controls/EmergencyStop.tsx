'use client'

import { useState } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { Button } from '@/components/ui/button'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from './flightStyles'

export function EmergencyStop() {
    const { emergencyStop } = useDrone()
    const [confirm, setConfirm] = useState(false)

    if (confirm) {
        return (
            <div className="flex flex-col gap-2 w-full" role="group" aria-label="Confirm kill">
                <span className="text-[14px] text-app-danger font-bold text-center">
                    Cut the motors now? A flying drone will fall.
                </span>
                <div className="flex gap-2 w-full">
                    <Button
                        size="sm"
                        className={cn('flex-1 h-10 rounded-md text-[14px] font-extrabold bg-app-danger text-[hsl(var(--app-bg))] hover:bg-app-danger hover:brightness-110', FOCUS)}
                        onClick={() => { emergencyStop(); setConfirm(false) }}
                    >
                        Confirm kill
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className={cn('flex-1 h-10 rounded-md text-[14px] font-bold text-app-text', FOCUS)}
                        onClick={() => setConfirm(false)}
                    >
                        Cancel
                    </Button>
                </div>
            </div>
        )
    }

    return (
        <Button
            size="sm"
            variant="outline"
            className={cn(
                'w-full h-10 rounded-md text-[14px] font-extrabold gap-2',
                'border-2 border-app-danger bg-app-danger text-[hsl(var(--app-bg))] hover:bg-app-danger hover:brightness-110',
                FOCUS,
            )}
            onClick={() => setConfirm(true)}
            title="Kill motors: cuts them at once. Asks you to confirm."
            aria-label="Kill motors"
        >
            <TriangleAlert size={16} />
            Kill
        </Button>
    )
}

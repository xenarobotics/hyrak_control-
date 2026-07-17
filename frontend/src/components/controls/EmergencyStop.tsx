'use client'

import { useState } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { Button } from '@/components/ui/button'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export function EmergencyStop() {
    const { emergencyStop } = useDrone()
    const [confirm, setConfirm] = useState(false)

    if (confirm) {
        return (
            <div className="flex flex-col gap-1.5 w-full">
                <span className="text-xs text-red-400 font-mono font-bold animate-pulse text-center">
                    CONFIRM KILL?
                </span>
                <div className="flex gap-1.5 w-full">
                    <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 font-mono font-bold"
                        onClick={() => { emergencyStop(); setConfirm(false) }}
                    >
                        YES — KILL
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 font-mono"
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
            variant="destructive"
            className={cn(
                'w-full font-mono font-bold gap-2',
                'ring-2 ring-red-500/50 hover:ring-red-500'
            )}
            onClick={() => setConfirm(true)}
        >
            <TriangleAlert size={14} />
            EMERGENCY STOP
        </Button>
    )
}
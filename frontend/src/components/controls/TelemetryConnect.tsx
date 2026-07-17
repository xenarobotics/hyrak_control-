'use client'

import { useState } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Wifi, WifiOff, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'

export function TelemetryConnect() {
    const { telemetryStatus, connectTelemetry } = useDrone()
    const [address, setAddress] = useState('udp://:14540')

    const isConnected = telemetryStatus === 'connected'
    const isConnecting = telemetryStatus === 'connecting'

    return (
        <div className="flex items-center gap-2">
            <div className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono',
                isConnected ? 'text-green-400' :
                    isConnecting ? 'text-yellow-400' : 'text-zinc-500'
            )}>
                {isConnecting
                    ? <Loader size={13} className="animate-spin" />
                    : isConnected
                        ? <Wifi size={13} />
                        : <WifiOff size={13} />
                }
                {telemetryStatus.toUpperCase()}
            </div>

            {!isConnected && (
                <>
                    <Input
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        className="h-8 w-48 font-mono text-xs"
                        placeholder="udp://:14540"
                        disabled={isConnecting}
                    />
                    <Button
                        size="sm"
                        onClick={() => connectTelemetry(address)}
                        disabled={isConnecting || !address}
                    >
                        Connect
                    </Button>
                </>
            )}
        </div>
    )
}
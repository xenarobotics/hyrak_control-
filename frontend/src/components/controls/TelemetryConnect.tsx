'use client'

import { useState } from 'react'
import { useDrone } from '@/hooks/useDrone'
import { getTelemetryAddress, setTelemetryAddress } from '@/lib/linkSettings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Wifi, WifiOff, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'

export function TelemetryConnect() {
    const { telemetryStatus, connectTelemetry, disconnectTelemetry } = useDrone()
    // Prefilled from Settings -> Comm links rather than a literal, so an
    // operator on a non-default port stops retyping it every connect.
    const [address, setAddress] = useState(() => getTelemetryAddress())
    const [busy, setBusy] = useState(false)

    const isConnected = telemetryStatus === 'connected'
    const isConnecting = telemetryStatus === 'connecting'

    // A link could be established and then never released without reloading
    // the page: the connect block was hidden entirely once connected, and
    // nothing ever emitted the backend's disconnect_telemetry.
    const handleDisconnect = async () => {
        setBusy(true)
        try { await disconnectTelemetry() } finally { setBusy(false) }
    }

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

            {isConnected ? (
                <Button
                    size="sm"
                    variant="outline"
                    className="font-mono text-xs gap-1.5"
                    onClick={handleDisconnect}
                    disabled={busy}
                >
                    {busy
                        ? <><Loader size={12} className="animate-spin" /> Disconnecting</>
                        : <><WifiOff size={12} /> Disconnect</>}
                </Button>
            ) : (
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
                        onClick={() => { setTelemetryAddress(address); connectTelemetry(address) }}
                        disabled={isConnecting || !address}
                    >
                        Connect
                    </Button>
                </>
            )}
        </div>
    )
}
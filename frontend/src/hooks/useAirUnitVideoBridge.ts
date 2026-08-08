'use client'

// Shared start/stop/status logic for the native air-unit video bridge
// (desktop/src/bridges/airUnitVideoBridge.ts) — used from both the Fly
// tab's device panel (the natural place to flip it on before flying) and
// Settings → Video (where port/device can be changed). Both use the SAME
// bridge id, so starting it from one place is immediately reflected in
// the other — there's only ever one such bridge running at a time.

import { useEffect, useState } from 'react'
import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'

export const AIR_UNIT_BRIDGE_ID = 'air-unit-video-bridge'

export interface AirUnitVideoStatus {
    msg: string
    error?: boolean
    log?: string
}

export function useAirUnitVideoBridge() {
    const [mounted, setMounted] = useState(false)
    const [running, setRunning] = useState(false)
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState<AirUnitVideoStatus | null>(null)

    useEffect(() => {
        setMounted(true)
        if (!isDesktopApp()) return
        return nativeBridge()?.onEvent((event: BridgeEvent) => {
            if (event.bridge !== 'air-unit-video' || event.id !== AIR_UNIT_BRIDGE_ID) return
            const meta = event.meta ?? {}
            if (meta.connected) {
                setRunning(true)
                setStatus({ msg: String(meta.note ?? 'running') })
            } else {
                setRunning(false)
                setStatus(meta.log
                    ? { msg: meta.error ? String(meta.error) : `ffmpeg exited (code ${meta.code ?? '?'})`, error: true, log: String(meta.log) }
                    : { msg: 'Stopped' })
            }
        })
    }, [])

    const start = async (config?: { port?: number; device?: string }): Promise<boolean> => {
        setBusy(true)
        setStatus(null)
        try {
            const result = await nativeBridge()?.start('air-unit-video', AIR_UNIT_BRIDGE_ID, {
                port: config?.port ?? 5600,
                device: config?.device ?? '/dev/video10',
                mode: 'auto',
            })
            if (result && !result.ok) {
                setStatus({ msg: result.error ?? 'Could not start', error: true })
                return false
            }
            return true
        } finally {
            setBusy(false)
        }
    }

    const stop = async () => {
        setBusy(true)
        try {
            await nativeBridge()?.stop('air-unit-video', AIR_UNIT_BRIDGE_ID)
            setRunning(false)
            setStatus({ msg: 'Stopped' })
        } finally {
            setBusy(false)
        }
    }

    return { supported: mounted && isDesktopApp(), running, busy, status, start, stop }
}

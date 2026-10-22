'use client'

import { getSocket } from '@/lib/socket'

export interface ActionResult { action: string; ok: boolean; error?: string | null; msg?: string | null }

/** Send a drone_action and resolve with its action_result (or a timeout).
 *  Results are matched by action name; fine for the Config pages, which
 *  never have two of the same action in flight that need telling apart. */
export function droneAction(action: string, data: Record<string, unknown> = {}, timeoutMs = 6000): Promise<ActionResult> {
    const socket = getSocket()
    return new Promise(resolve => {
        const done = (r: ActionResult) => { clearTimeout(t); socket.off('action_result', on); resolve(r) }
        const on = (r: ActionResult) => { if (r?.action === action) done(r) }
        const t = setTimeout(() => done({ action, ok: false, error: 'No answer from HYRAK. Check the connection' }), timeoutMs)
        socket.on('action_result', on)
        socket.emit('drone_action', { action, ...data })
    })
}

/** Fire and forget (keep-alives). */
export function droneActionNoWait(action: string, data: Record<string, unknown> = {}) {
    getSocket().emit('drone_action', { action, ...data })
}

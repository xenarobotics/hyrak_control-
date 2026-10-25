'use client'

// A short record of parameter writes for the Config setup pages: which
// parameter, from what to what, and the aircraft's answer (saved or
// refused). Built by watching the shared parameter copy
// (lib/vehicleParams.ts), so every write from any page appears, whoever
// made it: the old value is noted the moment a write starts waiting for its
// acknowledgement, the new value is the one the aircraft confirmed.

import { create } from 'zustand'
import { useEffect } from 'react'
import { useParamStore } from '@/lib/vehicleParams'

export interface WriteEntry {
    key: string
    from: number | null
    to: number | null
    state: 'pending' | 'saved' | 'refused'
    reason?: string
    at: number
}

const MAX = 12
export const useWriteLog = create<{ entries: WriteEntry[] }>(() => ({ entries: [] }))

let wired = false
function wire() {
    if (wired || typeof window === 'undefined') return
    wired = true
    let prev = useParamStore.getState()
    useParamStore.subscribe(s => {
        const p = prev
        prev = s
        if (!s.params && p.params) { useWriteLog.setState({ entries: [] }); return }
        const add: WriteEntry[] = []
        const update = (key: string, patch: Partial<WriteEntry>) => {
            useWriteLog.setState(st => {
                const i = st.entries.findIndex(e => e.key === key && e.state === 'pending')
                if (i < 0) return { entries: [{ key, from: null, to: null, state: 'pending', at: Date.now(), ...patch } as WriteEntry, ...st.entries].slice(0, MAX) }
                const entries = st.entries.slice()
                entries[i] = { ...entries[i], ...patch, at: Date.now() }
                return { entries }
            })
        }
        for (const key of Object.keys(s.pending)) {
            if (!p.pending[key]) add.push({ key, from: p.params?.[key]?.value ?? null, to: null, state: 'pending', at: Date.now() })
        }
        if (add.length) useWriteLog.setState(st => ({ entries: [...add.reverse(), ...st.entries].slice(0, MAX) }))
        for (const [key, t] of Object.entries(s.saved)) {
            if (p.saved[key] !== t) update(key, { state: 'saved', to: s.params?.[key]?.value ?? null })
        }
        for (const [key, why] of Object.entries(s.failed)) {
            if (p.failed[key] !== why) update(key, { state: 'refused', reason: why })
        }
    })
}

/** The recent writes, newest first. */
export function useParamWriteLog(): WriteEntry[] {
    useEffect(() => { wire() }, [])
    return useWriteLog(s => s.entries)
}

// Start watching as soon as the module loads, so a write made before the log
// is first shown still records the value it replaced.
wire()

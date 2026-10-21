'use client'

// Page-level Copilot wiring on Command, mounted whatever dock tab is open:
// the socket feed, hold V to talk, and follow me position sharing.

import { useEffect } from 'react'
import { ensureCopilotFeed, useCopilotStore } from '@/lib/copilot'
import { startTalk, stopTalk } from './PushToTalk'
import { FollowMeSharer } from './FollowMeSharer'

function typingTarget(el: Element | null): boolean {
    if (!el) return false
    const h = el as HTMLElement
    return h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable
}

export function CopilotHost() {
    const enabled = useCopilotStore(s => s.enabled)

    useEffect(() => { ensureCopilotFeed() }, [])

    // Hold V: only while Copilot is on and nothing that takes text has focus.
    useEffect(() => {
        if (!enabled) return
        let held = false
        const down = (e: KeyboardEvent) => {
            if (e.code !== 'KeyV' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
            if (typingTarget(document.activeElement) || typingTarget(e.target as Element)) return
            e.preventDefault()
            held = true
            void startTalk()
        }
        const up = (e: KeyboardEvent) => {
            if (e.code !== 'KeyV' || !held) return
            held = false
            stopTalk()
        }
        const blur = () => { if (held) { held = false; stopTalk() } }
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        window.addEventListener('blur', blur)
        return () => {
            window.removeEventListener('keydown', down)
            window.removeEventListener('keyup', up)
            window.removeEventListener('blur', blur)
            if (held) stopTalk()
        }
    }, [enabled])

    // Switched off (or leaving the page) mid-recording: send nothing more.
    useEffect(() => () => stopTalk(), [])

    return <FollowMeSharer />
}

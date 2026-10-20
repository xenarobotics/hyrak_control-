'use client'

// The running model's rules, compact: each switched-on rule with how close
// it is to firing (a thin bar filling to its "for" time, or "Waiting 12 s"
// after it fired) and what it did last. When a rule can hover or follow,
// the "Allow model control" switch for this flight sits here too, with why
// it switched itself off, and while following, a Stop button.

import { useEffect } from 'react'
import { BellRing, Crosshair, Hand, Loader, MapPin, Square, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ModelRule, RuleAction } from '@/lib/models'
import { ACTION_WORDS, ensureRulesFeed, movesDrone, pct, reasonText, useRulesStore } from '@/lib/modelRules'
import type { CVResult, RuleEvent } from '@/types/vision'
import { css as s } from './ui'

const ACTION_ICON: Record<RuleAction, typeof BellRing> = { alert: BellRing, mark: MapPin, hover: Hand, follow: Crosshair }

export function RulesLive({ rules, cv }: { rules: ModelRule[]; cv: CVResult | null }) {
    useEffect(() => { ensureRulesFeed() }, [])
    const on = rules.filter(r => r.enabled)
    const lastByRule = useRulesStore(st => st.lastByRule)
    const muted = useRulesStore(st => st.muted)
    const setMuted = useRulesStore(st => st.setMuted)
    const canMove = on.some(r => movesDrone(r.action))

    return (
        <div className={s.section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={s.label}>Rules</span>
                <button type="button" className={s.iconBtn} style={{ marginLeft: 'auto', width: 26, height: 26 }}
                    onClick={() => setMuted(!muted)} aria-label={muted ? 'Turn rule sounds on' : 'Mute rule sounds'}
                    title={muted ? 'Sounds off' : 'Sounds on'}>
                    {muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
                </button>
            </div>
            {on.length === 0 && <p className={s.muted}>All rules are off. Turn one on in the model&apos;s settings.</p>}
            {canMove && <ModelControl cv={cv} />}
            {on.map(r => (
                <LiveRule key={r.id} rule={r} cv={cv} last={lastByRule[r.id] ?? null} />
            ))}
        </div>
    )
}

function LiveRule({ rule: r, cv, last }: { rule: ModelRule; cv: CVResult | null; last: RuleEvent | null }) {
    const st = cv?.rules_state?.find(x => x.rule_id === r.id) ?? null
    const Icon = ACTION_ICON[r.action]
    const cooling = st && st.cooling_s > 0
    const seen = st?.seen_for_s ?? 0
    const fill = cooling ? Math.min(1, st!.cooling_s / Math.max(1, r.cooldown_s))
        : r.for_s > 0 ? Math.min(1, seen / r.for_s) : seen > 0 ? 1 : 0
    const state = st?.firing ? 'firing' : cooling ? 'cooling' : 'seen'
    const line = !cv ? 'Waiting for the first frame...'
        : st?.firing ? 'Doing it now'
            : cooling ? `Waiting ${Math.ceil(st!.cooling_s)} s before it can do it again`
                : seen > 0 ? (r.for_s > 0 ? `Seen for ${seen.toFixed(1)} of ${r.for_s} s` : 'Seen')
                    : `Watching for ${r.label}`

    return (
        <div className={cn(s.inset, s.liveRule)}>
            <div className={s.liveRuleHead}>
                <Icon size={13} aria-hidden style={{ color: 'var(--cm-accent)', flexShrink: 0 }} />
                <span>
                    <strong style={{ fontWeight: 600 }}>{r.label}</strong>
                    <span className={s.help}> above {pct(r.min_score)}{r.for_s > 0 ? ` for ${r.for_s} s` : ''}</span>
                </span>
                <span className={cn(s.chip, s.chipMute)}>{ACTION_WORDS[r.action].short}</span>
            </div>
            <span className={s.liveBar} data-state={state} aria-hidden><i style={{ width: `${fill * 100}%` }} /></span>
            <span className={s.help} aria-live="off">{line}</span>
            {last && <LastEvent e={last} />}
        </div>
    )
}

function LastEvent({ e }: { e: RuleEvent }) {
    const bad = e.status === 'refused' || e.status === 'stopped'
    const at = e.ts ? new Date(e.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
    return (
        <span className={s.help} style={{ display: 'flex', gap: 8, justifyContent: 'space-between', color: bad ? 'var(--cm-warn)' : undefined }}>
            <span style={{ minWidth: 0 }}>Last: {e.message}</span>
            <span className={s.mono} style={{ flexShrink: 0 }}>{at}</span>
        </span>
    )
}

/** "Allow model control" for this flight. Off at the start of every session. */
function ModelControl({ cv }: { cv: CVResult | null }) {
    const control = useRulesStore(st => st.control)
    const pending = useRulesStore(st => st.controlPending)
    const request = useRulesStore(st => st.requestControl)
    const on = control.enabled
    const followLabel = cv?.follow?.active ? cv.follow.label : control.following?.label ?? null
    const lost = cv?.follow?.active && (cv.follow.lost_s ?? 0) > 0
    // Why it is off, when the server switched it off or refused it.
    const why = !on ? reasonText(control.reason_code, control.reason) : null

    return (
        <div className={cn(s.inset, s.control)} data-on={on}>
            <label className={s.toggle} style={{ color: 'var(--cm-ink)', fontSize: 'var(--cm-text)', fontWeight: 600 }}>
                <input type="checkbox" checked={on} disabled={pending} aria-describedby="cm-control-help"
                    onChange={e => request(e.target.checked)} />
                Allow model control
                {pending && <Loader size={12} className="animate-spin motion-reduce:animate-none" aria-label="Waiting for the server" />}
            </label>
            <p id="cm-control-help" className={s.help} style={{ margin: 0 }}>
                {on
                    ? 'On for this flight. Hover and Follow rules can now stop or move the drone. Taking the remote, a staff takeover or a lost link turns it off.'
                    : 'Off. Hover and Follow rules will not move the drone until you turn this on. It is off again at the start of every flight.'}
            </p>
            {why && (
                <p className={s.help} role="status" style={{ margin: 0, color: 'var(--cm-warn)' }}>Turned off: {why}</p>
            )}
            {followLabel && on && (
                <div className={s.following}>
                    <Crosshair size={14} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>Following {followLabel}{lost ? ' (out of sight)' : ''}</span>
                    <button type="button" className={cn(s.btn, s.danger)} style={{ height: 26 }}
                        onClick={() => request(false)} title="Stops following and turns model control off">
                        <Square size={11} aria-hidden /> Stop
                    </button>
                </div>
            )}
        </div>
    )
}

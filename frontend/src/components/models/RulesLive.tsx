'use client'

// The running model's rules, at a glance. When a rule can hover or follow,
// the "Model control" switch for this flight comes first (off at the start
// of every flight; why it turned itself off shows as one chip), and while
// following, a Stop bar. Then one row per switched-on rule: its action icon
// inside a ring that fills while the class is seen and drains while the
// rule waits to fire again, and one status chip. The full sentence and the
// last message are in the row's tooltip.

import { useEffect } from 'react'
import { ArrowRight, Crosshair, Loader, ShieldCheck, ShieldOff, Square, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ModelRule } from '@/lib/models'
import { ensureRulesFeed, movesDrone, pct, reasonText, useRulesStore } from '@/lib/modelRules'
import type { CVResult, RuleEvent } from '@/types/vision'
import { actionFace, sentenceOf } from './ModelRules'
import { css as s } from './ui'

export function RulesLive({ rules, cv }: { rules: ModelRule[]; cv: CVResult | null }) {
    useEffect(() => { ensureRulesFeed() }, [])
    const on = rules.filter(r => r.enabled)
    const lastByRule = useRulesStore(st => st.lastByRule)
    const muted = useRulesStore(st => st.muted)
    const setMuted = useRulesStore(st => st.setMuted)
    const canMove = on.some(r => movesDrone(r.action))

    return (
        <div className={s.section}>
            <div className={s.rulesHead}>
                <span className={s.label}>Rules</span>
                <button type="button" className={s.iconBtn} style={{ marginLeft: 'auto', width: 26, height: 26 }}
                    onClick={() => setMuted(!muted)} aria-label={muted ? 'Turn rule sounds on' : 'Mute rule sounds'}
                    title={muted ? 'Sounds off' : 'Sounds on'}>
                    {muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
                </button>
            </div>
            {canMove && <ModelControl cv={cv} />}
            {on.length === 0
                ? <p className={s.muted}>All rules are off.</p>
                : (
                    <ul className={s.liveRules}>
                        {on.map(r => <LiveRule key={r.id} rule={r} cv={cv} last={lastByRule[r.id] ?? null} />)}
                    </ul>
                )}
        </div>
    )
}

const RING = 2 * Math.PI * 13

function LiveRule({ rule: r, cv, last }: { rule: ModelRule; cv: CVResult | null; last: RuleEvent | null }) {
    const st = cv?.rules_state?.find(x => x.rule_id === r.id) ?? null
    const { icon: Icon, short } = actionFace(r)
    const cooling = !!st && st.cooling_s > 0
    const seen = st?.seen_for_s ?? 0
    const fill = cooling ? Math.min(1, st!.cooling_s / Math.max(1, r.cooldown_s))
        : r.for_s > 0 ? Math.min(1, seen / r.for_s) : seen > 0 ? 1 : 0
    const ring = st?.firing ? 'firing' : cooling ? 'cooling' : 'seen'

    // One chip: what is happening now, or how the last attempt went.
    const recent = last && last.ts && Date.now() / 1000 - last.ts < 20 ? last : null
    const chip: { text: string; tone: string } =
        !cv ? { text: 'Starting', tone: s.chipMute }
            : recent?.status === 'awaiting_confirm' ? { text: 'Asking you', tone: s.chipInfo }
                : recent && (recent.status === 'refused' || recent.status === 'stopped') ? { text: 'Not done', tone: s.chipWarn }
                    : st?.firing ? { text: 'Now', tone: s.chipOk }
                        : cooling ? { text: `Again in ${Math.ceil(st!.cooling_s)} s`, tone: s.chipMute }
                            : seen > 0 ? { text: r.for_s > 0 ? `Seen ${seen.toFixed(1)} s` : 'Seen', tone: s.chipInfo }
                                : { text: 'Watching', tone: s.chipMute }
    const tip = [sentenceOf(r), last ? `Last: ${last.message}` : null].filter(Boolean).join('\n')

    return (
        <li className={s.liveRow} title={tip}>
            <span className={s.ring} data-state={ring} data-moves={movesDrone(r.action)}>
                <svg viewBox="0 0 32 32" aria-hidden>
                    <circle cx="16" cy="16" r="13" className={s.ringTrack} />
                    <circle cx="16" cy="16" r="13" className={s.ringFill}
                        strokeDasharray={RING} strokeDashoffset={RING * (1 - fill)} />
                </svg>
                <Icon size={13} aria-hidden />
            </span>
            <span className={s.liveText}>
                <span className={s.liveFlow}>
                    <strong>{r.label}</strong>
                    <ArrowRight size={11} aria-hidden style={{ color: 'var(--cm-ink-2)' }} />
                    <span>{short}</span>
                </span>
                <span className={s.ruleNumbers}>{pct(r.min_score)}{r.for_s > 0 ? ` · ${r.for_s} s` : ''}</span>
            </span>
            <span className={cn(s.chip, chip.tone)}>{chip.text}</span>
        </li>
    )
}

/** "Model control" for this flight. Off at the start of every session. */
function ModelControl({ cv }: { cv: CVResult | null }) {
    const control = useRulesStore(st => st.control)
    const pending = useRulesStore(st => st.controlPending)
    const request = useRulesStore(st => st.requestControl)
    const on = control.enabled
    const followLabel = cv?.follow?.active ? cv.follow.label : control.following?.label ?? null
    const lost = cv?.follow?.active && (cv.follow.lost_s ?? 0) > 0
    // Why it is off, when the server switched it off or refused it.
    const why = !on ? reasonText(control.reason_code, control.reason) : null
    const Shield = on ? ShieldCheck : ShieldOff

    return (
        <div className={cn(s.inset, s.control)} data-on={on}>
            <label className={s.controlRow}>
                <Shield size={18} aria-hidden className={s.controlIcon} />
                <span className={s.controlText}>
                    <span className={s.controlTitle}>Model control</span>
                    <span className={s.controlSub} id="cm-control-help">
                        {on ? 'Rules can stop or move the drone' : 'Rules will not move the drone'}
                    </span>
                </span>
                {pending && <Loader size={13} className="animate-spin motion-reduce:animate-none" aria-label="Waiting for the server" />}
                <span className={cn(s.toggle, s.toggleBig)}>
                    <input type="checkbox" checked={on} disabled={pending} aria-describedby="cm-control-help"
                        aria-label="Allow model control for this flight"
                        title="Off again at the start of every flight. Taking the remote, a staff takeover or a lost link turns it off."
                        onChange={e => request(e.target.checked)} />
                </span>
            </label>
            {why && <span className={cn(s.chip, s.chipWarn, s.whyChip)} role="status" title={why}>Off: {why}</span>}
            {followLabel && on && (
                <div className={s.following}>
                    <Crosshair size={14} aria-hidden style={{ color: 'var(--cm-accent)' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>Following {followLabel}{lost ? ' (out of sight)' : ''}</span>
                    <button type="button" className={cn(s.btn, s.danger)} style={{ height: 26 }}
                        onClick={() => request(false)} title="Stops following, holds, and turns model control off">
                        <Square size={11} aria-hidden /> Stop
                    </button>
                </div>
            )}
        </div>
    )
}

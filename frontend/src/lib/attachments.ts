'use client'

// Attachments: what is fitted to a drone (drop hook, gripper, winch, light,
// speaker, sprayer, or something custom) and how the flight controller
// drives it. Per drone, stored with the drone's registry record.
//
//   KINDS / kindMeta     plain words, icons, wiring options and default
//                        actions per kind (mirrors the server's defaults)
//   draftFor             a new attachment of a kind, defaults filled in
//   list/create/update/remove/testAttachment
//                        the REST calls (all paths live here)
//   useAttachmentStore   per-drone list cache, the last command per
//                        attachment (attachment_state)
//   ensureAttachmentFeed wires attachment_state / attachment_result to the
//                        store; results show in the app toast stack
//   sendAttachmentAction the in-flight socket event
//
// The server is the final check on everything: permissions, the guards
// (link, takeover, height, zones, people below) and validation.

import { useEffect } from 'react'
import { create } from 'zustand'
import {
    Anchor, Grab, Lightbulb, Megaphone, Package, Plug, SprayCan, type LucideIcon,
} from 'lucide-react'
import { apiJson } from './api'
import { problemFrom, type ApiProblem, type Result } from './models'
import { useRulesStore } from './modelRules'
import { getSocket } from './socket'
import { useDroneStore } from '@/store/drone'

// ── types ─────────────────────────────────────────────────────────────────

export type AttachmentKind = 'release' | 'gripper' | 'winch' | 'light' | 'speaker' | 'sprayer' | 'custom'

export type WiringType = 'actuator' | 'gripper' | 'winch'

export type Wiring =
    | { type: 'actuator'; index: number }
    | { type: 'gripper'; instance: number }
    | { type: 'winch'; instance: number }

export interface AttachmentAction {
    id: string
    /** Up to 24 characters. */
    label: string
    /** -1..1, actuator wiring only. */
    value?: number
    /** Can hurt someone: needs a confirm step and runs only in flight. */
    hazard: boolean
}

export interface AttachmentLimits {
    /** 0..500 m. */
    min_alt_m: number
    max_alt_m?: number | null
    /** Refuse when the AI sees a person below. */
    people_check: boolean
}

export interface Attachment {
    /** 8-16 chars [a-z0-9]. */
    id: string
    kind: AttachmentKind
    /** Up to 40 characters. */
    name: string
    icon?: string | null
    wiring: Wiring
    actions: AttachmentAction[]
    limits: AttachmentLimits
    enabled: boolean
}

export type AttachmentDraft = Omit<Attachment, 'id'>

/** One waypoint action, stored on the waypoint and uploaded with it. */
export interface WaypointAction {
    attachment_id: string
    action_id: string
    /** Sprayer level, 0..100 %. */
    value?: number
}

export const MAX_ATTACHMENTS = 8
export const MAX_WAYPOINT_ACTIONS = 3
export const ACTUATOR_OUTPUTS = [1, 2, 3, 4, 5, 6]
/** A two-step press waits this long for the second press. */
export const CONFIRM_WINDOW_MS = 4000

// ── per-kind defaults (mirrors the contract) ─────────────────────────────

export interface KindMeta {
    /** One word for a tile. */
    word: string
    defaultName: string
    icon: LucideIcon
    /** Allowed wirings, the first is the default. */
    wirings: WiringType[]
    actions: AttachmentAction[]
    /** Short facts for the tile tooltip and the card. */
    hint: string
    min_alt_m: number
}

export const KINDS: AttachmentKind[] = ['release', 'gripper', 'winch', 'light', 'speaker', 'sprayer', 'custom']

export const KIND_META: Record<AttachmentKind, KindMeta> = {
    release: {
        word: 'Drop', defaultName: 'Drop hook', icon: Package, wirings: ['actuator', 'gripper'],
        actions: [{ id: 'drop', label: 'Drop', value: 1, hazard: true }],
        hint: 'Lets go of a load. Only in flight, above the minimum height.', min_alt_m: 2,
    },
    gripper: {
        word: 'Gripper', defaultName: 'Gripper', icon: Grab, wirings: ['gripper', 'actuator'],
        actions: [
            { id: 'open', label: 'Open', value: 1, hazard: true },
            { id: 'close', label: 'Close', value: -1, hazard: false },
        ],
        hint: 'Opens and closes a claw. Opening can drop what it holds.', min_alt_m: 0,
    },
    winch: {
        word: 'Winch', defaultName: 'Winch', icon: Anchor, wirings: ['winch', 'actuator'],
        actions: [
            { id: 'lower', label: 'Lower', value: 1, hazard: true },
            { id: 'raise', label: 'Raise', value: -1, hazard: false },
            { id: 'stop', label: 'Stop', value: 0, hazard: false },
        ],
        hint: 'Lowers and raises a line. Lowering needs a clear space below.', min_alt_m: 0,
    },
    light: {
        word: 'Light', defaultName: 'Light', icon: Lightbulb, wirings: ['actuator'],
        actions: [
            { id: 'on', label: 'On', value: 1, hazard: false },
            { id: 'off', label: 'Off', value: -1, hazard: false },
        ],
        hint: 'A spotlight or beacon.', min_alt_m: 0,
    },
    speaker: {
        word: 'Speaker', defaultName: 'Speaker', icon: Megaphone, wirings: ['actuator'],
        actions: [
            { id: 'on', label: 'On', value: 1, hazard: false },
            { id: 'off', label: 'Off', value: -1, hazard: false },
        ],
        hint: 'A loudspeaker or siren.', min_alt_m: 0,
    },
    sprayer: {
        word: 'Sprayer', defaultName: 'Sprayer', icon: SprayCan, wirings: ['actuator'],
        actions: [
            { id: 'level', label: 'Spray', hazard: true },
            { id: 'off', label: 'Off', value: -1, hazard: false },
        ],
        hint: 'Sprays at a level you pick, 0 to 100%. Only in flight.', min_alt_m: 2,
    },
    custom: {
        word: 'Custom', defaultName: 'Custom', icon: Plug, wirings: ['actuator'],
        actions: [
            { id: 'on', label: 'On', value: 1, hazard: true },
            { id: 'off', label: 'Off', value: -1, hazard: true },
        ],
        hint: 'Anything else on an output: name 2 to 4 states.', min_alt_m: 0,
    },
}

/** The light's optional third state. */
export const STROBE_ACTION: AttachmentAction = { id: 'strobe', label: 'Strobe', value: 0, hazard: false }

export const WIRING_WORDS: Record<WiringType, { label: string; hint: string }> = {
    actuator: { label: 'Output', hint: 'A flight controller output set to Peripheral via Actuator Set.' },
    gripper: { label: 'Gripper', hint: 'The PX4 gripper (payload deliverer).' },
    winch: { label: 'Winch', hint: 'The PX4 winch driver.' },
}

export const QGC_HELP = (n: number | string = 'N') =>
    `In QGroundControl, Actuators, set the output to Peripheral via Actuator Set ${n}`

export function kindMeta(kind: string | null | undefined): KindMeta {
    return KIND_META[(kind as AttachmentKind)] ?? KIND_META.custom
}

/** "Output 3", "Gripper", "Winch". */
export function wiringLabel(w: Wiring | null | undefined): string {
    if (!w) return 'Not wired'
    if (w.type === 'actuator') return `Output ${w.index}`
    return WIRING_WORDS[w.type]?.label ?? w.type
}

export function defaultWiring(type: WiringType): Wiring {
    return type === 'actuator' ? { type: 'actuator', index: 1 } : { type, instance: 0 }
}

export const isHazardKind = (kind: AttachmentKind) =>
    KIND_META[kind].actions.some(a => a.hazard)

export const hasHazard = (a: Pick<Attachment, 'actions'>) => a.actions.some(x => x.hazard)

/** A new attachment of this kind, every default filled in. */
export function draftFor(kind: AttachmentKind): AttachmentDraft {
    const m = KIND_META[kind]
    return {
        kind,
        name: m.defaultName,
        wiring: defaultWiring(m.wirings[0]),
        actions: m.actions.map(a => ({ ...a })),
        limits: { min_alt_m: m.min_alt_m, people_check: isHazardKind(kind) },
        enabled: true,
    }
}

/** What the server gets: values only for actuator wiring. */
export function cleanDraft(d: AttachmentDraft): AttachmentDraft {
    const actuator = d.wiring.type === 'actuator'
    return {
        ...d,
        name: d.name.trim().slice(0, 40) || KIND_META[d.kind].defaultName,
        actions: d.actions.map(a => {
            const out: AttachmentAction = { id: a.id, label: a.label.trim().slice(0, 24) || a.id, hazard: !!a.hazard }
            if (actuator && typeof a.value === 'number') out.value = Math.max(-1, Math.min(1, a.value))
            return out
        }),
    }
}

/** "Spray 50%" for a sprayer level, the action's label otherwise. */
export function actionText(a: AttachmentAction, value?: number | null): string {
    if (a.id === 'level' && value != null) return `${a.label} ${Math.round(value)}%`
    return a.label
}

export const isLevel = (a: { id: string } | null | undefined) => a?.id === 'level'

/** A state id for a custom attachment: lower-case letters and digits. */
export function newActionId(taken: string[]): string {
    for (let i = 1; i < 99; i++) { const id = `s${i}`; if (!taken.includes(id)) return id }
    return `s${Date.now() % 1000}`
}

// ── plain reasons ─────────────────────────────────────────────────────────

export const ATTACHMENT_REASON: Record<string, string> = {
    needs_confirm: 'Press the button twice to confirm.',
    not_flying: 'Only works in flight. Use Test in Config on the bench.',
    too_low: 'The drone is below the minimum height for this.',
    no_altitude: 'The drone\'s height is not known, so this cannot be checked.',
    too_high: 'The drone is above the maximum height for this.',
    red_zone: 'The drone is in a no-fly zone.',
    orange_no_permit: 'The drone is in a restricted zone without a permit.',
    people_below: 'The AI sees a person below.',
    taken_over: 'HYRAK staff have taken over this flight.',
    no_link: 'No drone is connected.',
    no_attachment: 'The drone has no such attachment.',
    disabled: 'This attachment is switched off in Config.',
    not_supported: 'This flight controller cannot drive it.',
    failed: 'The drone did not accept the command.',
    model_control_off: 'Allow model control is off.',
    rules_changed: 'The rules were changed. Turn model control on again.',
    armed: 'Disarm the drone to test.',
    not_linked: 'Connect the drone to test.',
}

export function attachmentReason(code?: string | null, message?: string | null): string {
    if (message) return message
    if (code && ATTACHMENT_REASON[code]) return ATTACHMENT_REASON[code]
    return code ? 'It was not done.' : 'Done.'
}

// ── REST ──────────────────────────────────────────────────────────────────
// Paths in one place so they are easy to adjust.

const base = (droneId: string) => `/api/drones/${encodeURIComponent(droneId)}/attachments`
const one = (droneId: string, id: string) => `${base(droneId)}/${encodeURIComponent(id)}`

async function call<T>(path: string, init: Parameters<typeof apiJson>[1] = {}): Promise<Result<T>> {
    try {
        const r = await apiJson<T>(path, init)
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: problemFrom(r.data, r.status) }
    } catch {
        return { ok: false, error: problemFrom(null, 0) }
    }
}

export interface AttachmentList { attachments: Attachment[]; can_manage: boolean }

export async function listAttachments(droneId: string): Promise<Result<AttachmentList>> {
    const r = await call<Partial<AttachmentList>>(base(droneId))
    if (!r.ok) return r
    return {
        ok: true,
        data: {
            attachments: Array.isArray(r.data.attachments) ? r.data.attachments : [],
            can_manage: !!r.data.can_manage,
        },
    }
}

function unwrap(d: unknown): Attachment {
    const o = d as { attachment?: Attachment }
    return (o && typeof o === 'object' && o.attachment ? o.attachment : d) as Attachment
}

export async function createAttachment(droneId: string, draft: AttachmentDraft): Promise<Result<Attachment>> {
    const r = await call<unknown>(base(droneId), { method: 'POST', json: cleanDraft(draft) })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

export async function updateAttachment(droneId: string, id: string, patch: Partial<AttachmentDraft>): Promise<Result<Attachment>> {
    const r = await call<unknown>(one(droneId, id), { method: 'PATCH', json: patch })
    return r.ok ? { ok: true, data: unwrap(r.data) } : r
}

export async function deleteAttachment(droneId: string, id: string): Promise<Result<unknown>> {
    return call(one(droneId, id), { method: 'DELETE' })
}

export interface TestResult { ok: boolean; reason_code?: string | null; message: string }

/** Runs the real command on the bench: the server checks linked and disarmed. */
export async function testAttachment(droneId: string, id: string, actionId: string, value?: number): Promise<Result<TestResult>> {
    const body: { action_id: string; value?: number } = { action_id: actionId }
    if (value != null) body.value = value
    const r = await call<Partial<TestResult>>(`${one(droneId, id)}/test`, { method: 'POST', json: body })
    if (!r.ok) return r
    return { ok: true, data: { ok: !!r.data.ok, reason_code: r.data.reason_code ?? null, message: r.data.message ?? '' } }
}

// ── live state ────────────────────────────────────────────────────────────

export interface AttachmentStateEntry {
    id: string
    last_action_id: string | null
    /** Server time, seconds. */
    last_at: number | null
    ok: boolean
}

export interface AttachmentResult {
    attachment_id: string
    action_id: string
    ok: boolean
    reason_code?: string
    message: string
    ts?: number
}

interface DroneEntry {
    list: Attachment[]
    canManage: boolean
    loading: boolean
    error: ApiProblem | null
    loadedAt: number
}

interface AttachmentStore {
    byDrone: Record<string, DroneEntry>
    /** Last command per attachment in this session (attachment_state). */
    last: Record<string, AttachmentStateEntry>
    load: (droneId: string, force?: boolean) => Promise<void>
    setList: (droneId: string, list: Attachment[]) => void
    setLast: (entries: AttachmentStateEntry[]) => void
    reset: () => void
}

const EMPTY: DroneEntry = { list: [], canManage: false, loading: false, error: null, loadedAt: 0 }
/** A cached list is reused this long by strips and pickers. */
const FRESH_MS = 60_000

export const useAttachmentStore = create<AttachmentStore>((set, get) => ({
    byDrone: {},
    last: {},
    load: async (droneId, force = false) => {
        const cur = get().byDrone[droneId]
        if (cur?.loading) return
        if (!force && cur && !cur.error && Date.now() - cur.loadedAt < FRESH_MS) return
        set(s => ({ byDrone: { ...s.byDrone, [droneId]: { ...(cur ?? EMPTY), loading: true } } }))
        const r = await listAttachments(droneId)
        set(s => ({
            byDrone: {
                ...s.byDrone,
                [droneId]: r.ok
                    ? { list: r.data.attachments, canManage: r.data.can_manage, loading: false, error: null, loadedAt: Date.now() }
                    : { ...(s.byDrone[droneId] ?? EMPTY), loading: false, error: r.error, loadedAt: Date.now() },
            },
        }))
    },
    setList: (droneId, list) => set(s => ({
        byDrone: { ...s.byDrone, [droneId]: { ...(s.byDrone[droneId] ?? EMPTY), list, loadedAt: Date.now(), error: null } },
    })),
    setLast: (entries) => set(s => {
        const next = { ...s.last }
        for (const e of entries) if (e && e.id) next[e.id] = e
        return { last: next }
    }),
    reset: () => set({ last: {} }),
}))

/** The session's drone and its attachments, loaded once and shared. */
export function useSessionAttachments(): {
    droneId: string | null
    droneName: string | null
    attachments: Attachment[]
    canManage: boolean
    loading: boolean
    error: ApiProblem | null
    loaded: boolean
    reload: () => void
} {
    const drone = useDroneStore(s => s.session?.drone ?? null)
    const droneId = drone?.id ?? null
    const entry = useAttachmentStore(s => (droneId ? s.byDrone[droneId] : undefined))
    const load = useAttachmentStore(s => s.load)
    useEffect(() => {
        ensureAttachmentFeed()
        if (droneId) void load(droneId)
    }, [droneId, load])
    return {
        droneId,
        droneName: drone?.name ?? null,
        attachments: entry?.list ?? [],
        canManage: entry?.canManage ?? false,
        loading: !!entry?.loading,
        error: entry?.error ?? null,
        loaded: !!entry && entry.loadedAt > 0,
        reload: () => { if (droneId) void load(droneId, true) },
    }
}

// ── socket ────────────────────────────────────────────────────────────────

export interface AttachmentActionPayload {
    attachment_id: string
    action_id: string
    /** Sprayer level, 0..100. */
    value?: number
    confirm?: boolean
}

export function sendAttachmentAction(p: AttachmentActionPayload): void {
    getSocket().emit('attachment_action', p)
}

/** "Drop hook: Drop", from the cached lists. */
function describe(attachmentId: string, actionId: string): string | null {
    for (const d of Object.values(useAttachmentStore.getState().byDrone)) {
        const a = d.list.find(x => x.id === attachmentId)
        if (a) {
            const act = a.actions.find(x => x.id === actionId)
            return `${a.name}: ${act?.label ?? actionId}`
        }
    }
    return null
}

let attached = false

/** Wire attachment_state / attachment_result once per page. Results go to
 *  the one app toast stack (RuleToasts). */
export function ensureAttachmentFeed(): void {
    if (attached || typeof window === 'undefined') return
    attached = true
    const socket = getSocket()
    socket.on('attachment_state', (d: { attachments?: AttachmentStateEntry[] }) => {
        if (d && Array.isArray(d.attachments)) useAttachmentStore.getState().setLast(d.attachments)
    })
    socket.on('attachment_result', (r: AttachmentResult) => {
        if (!r || typeof r !== 'object' || !r.attachment_id) return
        const what = describe(r.attachment_id, r.action_id)
        const text = attachmentReason(r.reason_code, r.message)
        useRulesStore.getState().push({
            id: `att-${r.attachment_id}-${r.ts ?? Date.now()}`,
            kind: r.ok ? 'info' : 'warn',
            message: what && !text.startsWith(what) ? `${what}. ${text}` : text,
        })
        if (r.ok) {
            useAttachmentStore.getState().setLast([{
                id: r.attachment_id, last_action_id: r.action_id, last_at: r.ts ?? Date.now() / 1000, ok: true,
            }])
        }
    })
    // A new session starts with no last commands.
    let sessionId: string | null = useDroneStore.getState().session?.session_id ?? null
    socket.on('session_ready', (d: { session_id?: string }) => {
        if (d?.session_id && d.session_id !== sessionId) {
            sessionId = d.session_id
            useAttachmentStore.getState().reset()
        }
    })
}

// ── rules ─────────────────────────────────────────────────────────────────

/** The actions a rule can pick for a kind. Custom states are named per
 *  drone, so a custom kind offers the defaults plus any states of custom
 *  attachments already loaded here. */
export function ruleActionsFor(kind: AttachmentKind): AttachmentAction[] {
    const out = KIND_META[kind].actions.map(a => ({ ...a }))
    if (kind === 'light') out.push({ ...STROBE_ACTION })
    if (kind === 'custom') {
        for (const d of Object.values(useAttachmentStore.getState().byDrone)) {
            for (const a of d.list) {
                if (a.kind !== 'custom') continue
                for (const act of a.actions) if (!out.some(x => x.id === act.id)) out.push({ ...act, hazard: true })
            }
        }
    }
    return out
}

/** A rule's attachment action can hurt someone: it always asks first.
 *  Custom states always count, whatever one drone says. */
export function ruleHazard(kind: AttachmentKind | null | undefined, actionId: string | null | undefined): boolean {
    if (!kind) return true
    if (kind === 'custom') return true
    const a = KIND_META[kind]?.actions.find(x => x.id === actionId)
    return a ? a.hazard : false
}

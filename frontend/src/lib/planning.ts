/**
 * Missions and permits for the Mission tab (docs/ACCESS_MODEL.md 8b).
 *
 * Every call names the workspace it acts on: the live session's (a
 * customer's session belongs to one workspace; staff land on HYRAK) or,
 * before the socket is up, the active workspace. The server is the check;
 * `planningAccess` only decides what the page offers.
 */
import { apiJson } from './api'
import { hasRole, isCustomer } from './auth'
import { hasPerm, type WorkspaceInfo } from './access'
import type { Waypoint } from '@/types/mission'
import type { UploadWp } from './uploadPath'

export interface ZoneHit {
    id: string
    name: string
    zone_class: 'green' | 'orange' | 'red'
    permission_required?: boolean
}

export interface SavedMission {
    id: string
    workspace_id: string
    name: string
    drone_id: string | null
    requested_by: string
    profile_name: string
    status: string
    waypoint_count: number
    distance_m: number
    est_duration_s: number
    zones: ZoneHit[]
    created_at: string | null
    updated_at: string | null
    waypoints?: UploadWp[]
    editable?: boolean
}

export type PermitStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'withdrawn' | 'superseded'

export interface Permit {
    id: string
    workspace_id: string
    workspace_name?: string
    drone_id: string | null
    drone_name?: string | null
    mission_id: string | null
    kind: 'mission' | 'area'
    description: string
    waypoint_count: number
    waypoints?: UploadWp[]
    zones: ZoneHit[]
    status: PermitStatus
    status_effective: PermitStatus | 'expired'
    in_window: boolean
    valid_from: string | null
    valid_until: string | null
    requested_by_name: string
    requested_at: string | null
    decided_by_name: string
    decision_note: string
    decided_at: string | null
    can_decide?: boolean
}

export interface PathCheck {
    zone_class: 'green' | 'orange' | 'red'
    zones: ZoneHit[]
    /** none: fly it; ack: orange, acknowledge at upload or get a permit;
     *  permit: red, needs an approved permit; prohibited: no permit possible. */
    needs: 'none' | 'ack' | 'permit' | 'prohibited'
    permit: Permit | null
    workspace_id: string
}

export interface PlanningAccess {
    /** Save, edit, delete plans and request permits. */
    canPlan: boolean
    /** Upload to and command the drone. */
    canFly: boolean
}

/** What the page offers. Customers: their workspace perms. Staff: the
 *  compatibility rank, as before (HYRAK plans need an operator). */
export function planningAccess(ws: WorkspaceInfo | null, sessionPerms?: string[] | null): PlanningAccess {
    if (!isCustomer()) {
        const op = hasRole('operator')
        return { canPlan: op, canFly: op }
    }
    const has = (p: 'plan' | 'fly') => sessionPerms ? sessionPerms.includes(p) : hasPerm(ws, p)
    return { canPlan: has('plan'), canFly: has('fly') }
}

const q = (ws: string | null | undefined) => (ws ? `workspace_id=${encodeURIComponent(ws)}` : '')

function errorOf(data: unknown, fallback: string): string {
    const d = data as { detail?: unknown } | null
    return typeof d?.detail === 'string' ? d.detail : fallback
}

/** The upload shape of a planner waypoint (what the server stores). */
export function toWire(wps: Waypoint[]): UploadWp[] {
    return wps.map(w => ({
        lat: w.lat, lng: w.lng, altitude: w.altitude, speed: w.speed,
        hold_time: w.holdTime, type: w.type, yaw: w.yaw, turn_radius: w.turnRadius ?? 0,
    }))
}

export function fromWire(wps: UploadWp[], prefix: string): Waypoint[] {
    return wps.map((w, i) => ({
        id: `${prefix}_${i}`,
        lat: w.lat, lng: w.lng,
        altitude: w.altitude ?? 10,
        speed: w.speed ?? 5,
        holdTime: w.hold_time ?? 0,
        type: (w.type ?? 'waypoint') as Waypoint['type'],
        yaw: w.yaw ?? null,
        turnRadius: w.turn_radius ?? 0,
    }))
}

export async function listMissions(ws: string | null): Promise<SavedMission[]> {
    const r = await apiJson<{ missions?: SavedMission[]; detail?: string }>(`/api/missions?${q(ws)}`)
    if (!r.ok) throw new Error(errorOf(r.data, 'Could not load the saved missions'))
    return r.data.missions ?? []
}

export async function getMission(id: string): Promise<SavedMission> {
    const r = await apiJson<{ mission?: SavedMission }>(`/api/missions/${encodeURIComponent(id)}`)
    if (!r.ok || !r.data.mission) throw new Error(errorOf(r.data, 'Could not open that mission'))
    return r.data.mission
}

export async function saveMission(ws: string | null, name: string, wps: Waypoint[], droneId?: string | null): Promise<SavedMission> {
    const r = await apiJson<{ mission?: SavedMission }>('/api/missions', {
        method: 'POST',
        json: { workspace_id: ws, name, waypoints: toWire(wps), drone_id: droneId ?? null },
    })
    if (!r.ok || !r.data.mission) throw new Error(errorOf(r.data, 'Could not save the mission'))
    return r.data.mission
}

export async function updateMission(id: string, patch: { name?: string; waypoints?: Waypoint[] }): Promise<SavedMission> {
    const r = await apiJson<{ mission?: SavedMission }>(`/api/missions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: { ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.waypoints ? { waypoints: toWire(patch.waypoints) } : {}) },
    })
    if (!r.ok || !r.data.mission) throw new Error(errorOf(r.data, 'Could not update the mission'))
    return r.data.mission
}

export async function deleteMission(id: string): Promise<void> {
    const r = await apiJson(`/api/missions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!r.ok) throw new Error(errorOf(r.data, 'Could not delete the mission'))
}

export async function checkPath(ws: string | null, wps: UploadWp[], droneId?: string | null): Promise<PathCheck> {
    const r = await apiJson<PathCheck>('/api/zones/check-path', {
        method: 'POST',
        json: { workspace_id: ws, waypoints: wps, drone_id: droneId ?? null },
    })
    if (!r.ok) throw new Error(errorOf(r.data, 'Airspace check failed'))
    return r.data
}

export async function listPermits(ws: string | null): Promise<Permit[]> {
    const r = await apiJson<{ permits?: Permit[] }>(`/api/permits?${q(ws)}`)
    if (!r.ok) throw new Error(errorOf(r.data, 'Could not load the permits'))
    return r.data.permits ?? []
}

export interface PermitRequest {
    workspace_id: string | null
    description: string
    valid_from: string
    valid_until: string
    drone_id?: string | null
    mission_id?: string | null
    waypoints: UploadWp[]
}

export async function requestPermit(body: PermitRequest): Promise<Permit> {
    const r = await apiJson<{ permit?: Permit }>('/api/permits', { method: 'POST', json: body })
    if (!r.ok || !r.data.permit) throw new Error(errorOf(r.data, 'The permit request was not accepted'))
    return r.data.permit
}

export async function withdrawPermit(id: string): Promise<Permit> {
    const r = await apiJson<{ permit?: Permit }>(`/api/permits/${encodeURIComponent(id)}/withdraw`, { method: 'POST' })
    if (!r.ok || !r.data.permit) throw new Error(errorOf(r.data, 'Could not withdraw the permit'))
    return r.data.permit
}

export async function decidePermit(id: string, approve: boolean, note: string): Promise<Permit> {
    const r = await apiJson<{ permit?: Permit }>(`/api/permits/${encodeURIComponent(id)}/decision`, {
        method: 'POST', json: { approve, note },
    })
    if (!r.ok || !r.data.permit) throw new Error(errorOf(r.data, 'The decision was not recorded'))
    return r.data.permit
}

export const PERMIT_TONE: Record<string, { fg: string; label: string }> = {
    pending:    { fg: '#fbbf24', label: 'PENDING' },
    approved:   { fg: '#4ade80', label: 'APPROVED' },
    denied:     { fg: '#f87171', label: 'DENIED' },
    revoked:    { fg: '#f87171', label: 'REVOKED' },
    withdrawn:  { fg: '#9ca3af', label: 'WITHDRAWN' },
    superseded: { fg: '#fb923c', label: 'SUPERSEDED' },
    expired:    { fg: '#9ca3af', label: 'EXPIRED' },
}

export function fmtWhen(iso: string | null): string {
    if (!iso) return '-'
    const d = new Date(iso)
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

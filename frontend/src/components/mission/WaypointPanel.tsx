'use client'

import { useRef, useState } from 'react'
import { useMissionStore, RTL_SENTINEL_ID } from '@/store/mission'
import { useDroneStore } from '@/store/drone'
import { WP_META } from '@/types/mission'
import type { Waypoint } from '@/types/mission'
import { ChevronUp, ChevronDown, Trash2, MapPin, GripVertical, Navigation, Home, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS, LABEL } from '@/components/mission/ui'

// ── Distance helper (Haversine) ─────────────────────────────────────────────

function distM(a: Waypoint, b: Waypoint): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

// ── Component ───────────────────────────────────────────────────────────────

// readOnly: a viewer's plan (docs/ACCESS_MODEL.md 8d) - select to inspect,
// never reorder or remove.
export default function WaypointPanel({ readOnly = false }: { readOnly?: boolean } = {}) {
  const waypoints      = useMissionStore(s => s.waypoints)
  const selectedId     = useMissionStore(s => s.selectedId)
  const selectWaypoint = useMissionStore(s => s.selectWaypoint)
  const removeWaypoint = useMissionStore(s => s.removeWaypoint)
  const moveWaypoint    = useMissionStore(s => s.moveWaypoint)
  const getRtlWaypoint  = useMissionStore(s => s.getRtlWaypoint)

  // Active mission WP comes from live telemetry
  const missionCurrentIndex = useDroneStore(s => s.telemetry?.mission_current_index ?? -1)

  const dragIndexRef   = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [listOpen, setListOpen] = useState(true)

  // RTL is never part of the orderable/draggable list - defensive filter in
  // case older persisted/imported data still has a legacy 'rtl' type entry.
  const orderable = waypoints.filter(w => w.type !== 'rtl')
  const rtlActive = selectedId === RTL_SENTINEL_ID
  const rtlWp = getRtlWaypoint()

  return (
    <div className="flex flex-col gap-1 pr-1">
      {/* Waypoint list header - collapses just the orderable list, independent
          of the Mission Plan panel's own collapse arrow */}
      <button
        onClick={() => setListOpen(o => !o)}
        aria-expanded={listOpen}
        className={cn('flex items-center justify-between h-8 px-1.5 rounded-[6px] select-none hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)}
        title={listOpen ? 'Hide the list' : 'Show the list'}
      >
        <span className={LABEL}>Waypoints</span>
        <span className="flex items-center gap-1.5 text-app-text-muted">
          <span className="text-xs font-bold tabular-nums">{orderable.length}</span>
          <ChevronsUpDown size={14} aria-hidden />
        </span>
      </button>

      {listOpen && (orderable.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6 px-3 text-center">
          <span className="w-10 h-10 rounded-[10px] flex items-center justify-center bg-app-accent-soft text-app-accent">
            <MapPin size={20} aria-hidden />
          </span>
          <p className="text-[13px] font-semibold text-app-text-muted">
            {readOnly ? 'No waypoints yet' : 'Click the map to add waypoints'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1 overflow-y-auto max-h-[45vh] pr-1">
          {orderable.map((wp, i) => {
            const meta      = WP_META[wp.type]
            const active    = wp.id === selectedId
            const isCurrent = i === missionCurrentIndex  // drone currently flying to this WP
            const legDist   = i > 0 ? distM(orderable[i - 1], wp) : null
            const isOver    = dragOver === i
            const rawIdx    = waypoints.indexOf(wp)

            return (
              <div
                key={wp.id}
                draggable={!readOnly}
                onDragStart={e => {
                  dragIndexRef.current = rawIdx
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={e => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOver(i)
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => {
                  e.preventDefault()
                  const from = dragIndexRef.current
                  if (from !== null && from !== rawIdx) moveWaypoint(from, rawIdx)
                  dragIndexRef.current = null
                  setDragOver(null)
                }}
                onDragEnd={() => {
                  dragIndexRef.current = null
                  setDragOver(null)
                }}
                onClick={() => selectWaypoint(wp.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectWaypoint(wp.id) } }}
                role="button" tabIndex={0} aria-pressed={active}
                aria-label={`${meta.label} ${i + 1}, ${wp.altitude} m`}
                className={cn('group flex items-center gap-1.5 rounded-[6px] px-1.5 py-1.5 min-h-10 border select-none cursor-pointer transition-colors duration-[120ms]', FOCUS,
                  isCurrent ? 'bg-app-ok-soft border-app-ok/50'
                  : active ? 'bg-app-accent-soft border-app-accent/50'
                  : isOver ? 'bg-app-surface-2 border-app-border-strong border-dashed'
                  : 'border-transparent hover:bg-app-surface-2')}
              >
                {/* Drag grip - stops click propagation so it doesn't select the WP */}
                {!readOnly && <span
                  title="Drag to reorder"
                  className="shrink-0 text-app-text-subtle opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-[120ms] cursor-grab active:cursor-grabbing"
                  onClick={e => e.stopPropagation()}
                >
                  <GripVertical size={14} aria-hidden />
                </span>}

                {/* Number badge */}
                <div
                  className={cn('shrink-0 flex items-center justify-center rounded-full text-xs font-extrabold tabular-nums',
                    active ? 'text-white' : 'text-app-text bg-app-surface-2')}
                  style={{
                    width: 26, height: 26,
                    border: `2px solid ${meta.color}`,
                    ...(active ? { background: meta.color } : {}),
                  }}
                  aria-hidden
                >
                  {i + 1}
                </div>

                {/* Label + distance */}
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="flex items-center gap-1.5">
                    {isCurrent && <Navigation size={12} className="shrink-0 text-app-ok" aria-label="Flying to" />}
                    <span className={cn('text-[14px] font-bold truncate', isCurrent ? 'text-app-ok' : 'text-app-text')}>
                      {meta.label}
                    </span>
                    <span className="text-[13px] font-semibold tabular-nums text-app-text-muted">
                      {wp.altitude} m
                    </span>
                  </div>
                  {legDist !== null && (
                    <span className="text-xs tabular-nums text-app-text-muted" title="Distance from the previous waypoint">
                      +{fmtDist(legDist)}
                    </span>
                  )}
                </div>

                {/* Reorder arrows + delete - appear on hover / when active */}
                {!readOnly && <div
                  className={cn('shrink-0 flex items-center transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-within:opacity-100',
                    active ? 'opacity-100' : 'opacity-0')}
                >
                  <button
                    type="button"
                    title="Move up" aria-label="Move up"
                    disabled={i === 0}
                    className={cn('w-6 h-7 flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-raised disabled:text-app-text-subtle disabled:hover:bg-transparent', FOCUS)}
                    onClick={e => { e.stopPropagation(); if (i > 0) moveWaypoint(rawIdx, waypoints.indexOf(orderable[i - 1])) }}
                  >
                    <ChevronUp size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    title="Move down" aria-label="Move down"
                    disabled={i === orderable.length - 1}
                    className={cn('w-6 h-7 flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-raised disabled:text-app-text-subtle disabled:hover:bg-transparent', FOCUS)}
                    onClick={e => { e.stopPropagation(); if (i < orderable.length - 1) moveWaypoint(rawIdx, waypoints.indexOf(orderable[i + 1])) }}
                  >
                    <ChevronDown size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    title="Remove waypoint" aria-label="Remove waypoint"
                    className={cn('w-6 h-7 flex items-center justify-center rounded-[6px] text-app-danger hover:bg-app-danger-soft', FOCUS)}
                    onClick={e => { e.stopPropagation(); removeWaypoint(wp.id) }}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>}
              </div>
            )
          })}
        </div>
      ))}

      {/* ── RTL - separate, non-reorderable, always visible ──────────────── */}
      <div className="mt-1 pt-2 border-t border-app-border">
        <div
          onClick={() => selectWaypoint(rtlActive ? null : RTL_SENTINEL_ID)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectWaypoint(rtlActive ? null : RTL_SENTINEL_ID) } }}
          role="button" tabIndex={0} aria-pressed={rtlActive}
          title="Return-to-launch point. Click to edit."
          className={cn('group flex items-center gap-2 rounded-[6px] px-1.5 py-1.5 min-h-10 border select-none cursor-pointer transition-colors duration-[120ms]', FOCUS,
            rtlActive ? 'bg-app-accent-soft border-app-accent/50' : 'border-transparent hover:bg-app-surface-2')}
        >
          <div
            className={cn('shrink-0 flex items-center justify-center rounded-full', rtlActive ? 'text-white' : 'text-app-text bg-app-surface-2')}
            style={{
              width: 26, height: 26,
              border: '2px solid #a855f7',
              ...(rtlActive ? { background: '#a855f7' } : {}),
            }}
            aria-hidden
          >
            <Home size={13} />
          </div>
          <div className="flex-1 min-w-0 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] font-bold text-app-text">Return home</span>
              <span className="text-[13px] font-semibold tabular-nums text-app-text-muted">
                {rtlWp.altitude} m
              </span>
            </div>
            <span className="text-xs text-app-text-muted">RTL point</span>
          </div>
        </div>
      </div>
    </div>
  )
}

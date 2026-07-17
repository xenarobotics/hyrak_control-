'use client'

import { useRef, useState } from 'react'
import { useMissionStore, RTL_SENTINEL_ID } from '@/store/mission'
import { useDroneStore } from '@/store/drone'
import { WP_META } from '@/types/mission'
import type { Waypoint } from '@/types/mission'
import { ChevronUp, ChevronDown, Trash2, MapPin, GripVertical, Navigation, Home, ChevronsUpDown } from 'lucide-react'

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

export default function WaypointPanel() {
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

  // RTL is never part of the orderable/draggable list — defensive filter in
  // case older persisted/imported data still has a legacy 'rtl' type entry.
  const orderable = waypoints.filter(w => w.type !== 'rtl')
  const rtlActive = selectedId === RTL_SENTINEL_ID
  const rtlWp = getRtlWaypoint()

  return (
    <div className="flex flex-col gap-1 pr-1">
      {/* Waypoint list header — collapses just the orderable list, independent
          of the Mission Plan panel's own collapse arrow */}
      <button
        onClick={() => setListOpen(o => !o)}
        className="flex items-center justify-between px-1 py-1 select-none"
      >
        <span className="text-[9px] font-mono tracking-widest font-bold" style={{ color: '#6b7280' }}>
          WAYPOINTS
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono font-bold tabular-nums px-1 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,.06)', color: '#9ca3af' }}>
            {orderable.length}
          </span>
          <ChevronsUpDown size={11} color="#6b7280" />
        </span>
      </button>

      {listOpen && (orderable.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8 px-4 text-center">
          <MapPin size={26} color="#6b7280" />
          <p className="text-[11px] font-mono font-semibold" style={{ color: '#6b7280' }}>
            Click anywhere on the map<br />to add waypoints
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
                draggable
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
                className="group flex items-center gap-1.5 rounded-lg px-2 py-2.5 transition-all select-none cursor-pointer"
                style={{
                  background: isCurrent
                    ? 'rgba(34,197,94,.12)'
                    : active
                    ? 'rgba(59,130,246,.12)'
                    : isOver
                    ? 'rgba(168,85,247,.1)'
                    : 'transparent',
                  border: isCurrent
                    ? '1px solid rgba(34,197,94,.45)'
                    : active
                    ? '1px solid rgba(59,130,246,.3)'
                    : isOver
                    ? '1px solid rgba(168,85,247,.45)'
                    : '1px solid transparent',
                  transform: isOver ? 'translateY(-1px)' : 'translateY(0)',
                }}
              >
                {/* Drag grip — stops click propagation so it doesn't select the WP */}
                <span
                  title="Drag to reorder"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
                  style={{ color: '#4b5563' }}
                  onClick={e => e.stopPropagation()}
                >
                  <GripVertical size={13} />
                </span>

                {/* Number badge */}
                <div
                  className="shrink-0 flex items-center justify-center rounded-full text-[10px] font-bold"
                  style={{
                    width: 24, height: 24,
                    background: active ? meta.color : 'rgba(255,255,255,.06)',
                    border: `2px solid ${meta.color}`,
                    color: active ? '#fff' : meta.color,
                  }}
                >
                  {i + 1}
                </div>

                {/* Label + distance */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {isCurrent && <Navigation size={10} color="#4ade80" className="shrink-0" />}
                    <span className="text-[11px] font-mono font-bold truncate"
                      style={{ color: isCurrent ? '#4ade80' : '#e5e7eb' }}>
                      {meta.label}
                    </span>
                    <span className="text-[10px] font-mono font-semibold" style={{ color: '#9ca3af' }}>
                      {wp.altitude}m
                    </span>
                  </div>
                  {legDist !== null && (
                    <span className="text-[9px] font-mono font-medium" style={{ color: '#6b7280' }}>
                      {fmtDist(legDist)}
                    </span>
                  )}
                </div>

                {/* Reorder arrows + delete — appear on hover / when active */}
                <div
                  className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={active ? { opacity: 1 } : undefined}
                >
                  <span
                    title="Move up one step"
                    className="p-1 rounded-md cursor-pointer"
                    style={{ background: 'rgba(255,255,255,.08)', color: '#d1d5db' }}
                    onClick={e => { e.stopPropagation(); if (i > 0) moveWaypoint(rawIdx, waypoints.indexOf(orderable[i - 1])) }}
                  >
                    <ChevronUp size={11} />
                  </span>
                  <span
                    title="Move down one step"
                    className="p-1 rounded-md cursor-pointer"
                    style={{ background: 'rgba(255,255,255,.08)', color: '#d1d5db' }}
                    onClick={e => { e.stopPropagation(); if (i < orderable.length - 1) moveWaypoint(rawIdx, waypoints.indexOf(orderable[i + 1])) }}
                  >
                    <ChevronDown size={11} />
                  </span>
                  <span
                    title="Remove waypoint"
                    className="p-1 rounded-md cursor-pointer"
                    style={{ background: 'rgba(248,113,113,.15)', color: '#fca5a5' }}
                    onClick={e => { e.stopPropagation(); removeWaypoint(wp.id) }}
                  >
                    <Trash2 size={11} />
                  </span>
                </div>
              </div>
            )
          })}

          {/* Hint row */}
          {orderable.length > 1 && (
            <p className="text-[9px] font-mono text-center pt-1 pb-0.5" style={{ color: '#374151' }}>
              ⠿ drag to reorder · ↑↓ move one step
            </p>
          )}
        </div>
      ))}

      {/* ── RTL — separate, non-reorderable, always visible ──────────────── */}
      <div className="mt-1 pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,.08)' }}>
        <div
          onClick={() => selectWaypoint(rtlActive ? null : RTL_SENTINEL_ID)}
          className="group flex items-center gap-1.5 rounded-lg px-2 py-2.5 transition-all select-none cursor-pointer"
          style={{
            background: rtlActive ? 'rgba(168,85,247,.12)' : 'transparent',
            border: rtlActive ? '1px solid rgba(168,85,247,.4)' : '1px solid transparent',
          }}
        >
          <div
            className="shrink-0 flex items-center justify-center rounded-full"
            style={{
              width: 24, height: 24,
              background: rtlActive ? '#a855f7' : 'rgba(255,255,255,.06)',
              border: '2px solid #a855f7',
              color: rtlActive ? '#fff' : '#a855f7',
            }}
          >
            <Home size={12} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-mono font-bold" style={{ color: '#e5e7eb' }}>RTL</span>
              <span className="text-[10px] font-mono font-semibold" style={{ color: '#9ca3af' }}>
                {rtlWp.altitude}m
              </span>
            </div>
            <span className="text-[9px] font-mono font-medium" style={{ color: '#6b7280' }}>
              Return-to-launch point · click to edit
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

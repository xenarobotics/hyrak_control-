'use client'

import { useMemo } from 'react'
import { useMissionStore, RTL_SENTINEL_ID } from '@/store/mission'
import { WP_META } from '@/types/mission'
import type { WaypointType } from '@/types/mission'
import { Trash2, X, Home, RotateCcw, Compass, MousePointerClick } from 'lucide-react'
import { WaypointActions } from '@/components/attachments/WaypointActions'
import { cn } from '@/lib/utils'
import { FOCUS, LABEL, INPUT, BTN, BTN_DANGER } from '@/components/mission/ui'

function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// ── Slider + input combo ────────────────────────────────────────────────────

function Field({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-app-text">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min}
            step={step}
            value={value}
            aria-label={`${label} (${unit})`}
            onChange={e => {
              const v = Number(e.target.value)
              if (!isNaN(v)) onChange(Math.max(min, v))
            }}
            className={cn(INPUT, 'w-16 text-right font-bold')}
          />
          <span className="text-xs font-semibold w-7 text-app-text-muted">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={Math.max(max, value)}
        step={step}
        value={value}
        aria-label={label}
        onChange={e => onChange(Number(e.target.value))}
        className={cn('w-full h-5 cursor-pointer rounded-full', FOCUS)}
        style={{ accentColor: 'var(--app-accent)' }}
      />
    </div>
  )
}

/** Lat / lng pair. */
function Coord({ label, value, step, onChange }: {
  label: string; value: number; step: number; onChange: (v: number) => void
}) {
  return (
    <label className="flex-1 min-w-0 flex flex-col gap-1">
      <span className="text-xs font-semibold text-app-text-muted">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className={cn(INPUT, 'w-full font-semibold')}
      />
    </label>
  )
}

/** Panel header: icon tile, title, close. */
function Header({ badge, title, sub, onClose }: {
  badge: React.ReactNode; title: string; sub?: string; onClose: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        {badge}
        <div className="min-w-0 leading-tight">
          <p className="text-[16px] font-bold text-app-text truncate">{title}</p>
          {sub && <p className="text-xs text-app-text-muted truncate">{sub}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className={cn('w-8 h-8 shrink-0 flex items-center justify-center rounded-[6px] text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)}
        title="Close" aria-label="Close"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WaypointEditor() {
  const waypoints       = useMissionStore(s => s.waypoints)
  const selectedId      = useMissionStore(s => s.selectedId)
  const updateWaypoint  = useMissionStore(s => s.updateWaypoint)
  const removeWaypoint  = useMissionStore(s => s.removeWaypoint)
  const selectWaypoint  = useMissionStore(s => s.selectWaypoint)
  const rtlPosition     = useMissionStore(s => s.rtlPosition)
  const getRtlWaypoint  = useMissionStore(s => s.getRtlWaypoint)
  const setRtlPosition  = useMissionStore(s => s.setRtlPosition)
  const setRtlAltitude  = useMissionStore(s => s.setRtlAltitude)
  const resetRtlToTakeoff = useMissionStore(s => s.resetRtlToTakeoff)
  const autoHeading     = useMissionStore(s => s.autoHeading)

  const wp = useMemo(
    () => waypoints.find(w => w.id === selectedId),
    [waypoints, selectedId],
  )

  const index = wp ? waypoints.findIndex(w => w.id === wp.id) : -1

  // Auto-heading: compute the bearing from this waypoint toward the next one
  // (or the incoming bearing for the last waypoint). Shown when autoHeading is on.
  // Computed before the RTL and "no waypoint" returns below: a hook after a conditional
  // return breaks the rules of hooks.
  const autoYaw = useMemo(() => {
    if (!autoHeading || !wp) return null
    const next = waypoints[index + 1]
    if (next) return computeBearing(wp.lat, wp.lng, next.lat, next.lng)
    const prev = waypoints[index - 1]
    if (prev) return computeBearing(prev.lat, prev.lng, wp.lat, wp.lng)
    return null
  }, [autoHeading, wp, waypoints, index])

  if (selectedId === RTL_SENTINEL_ID) {
    const rtl = getRtlWaypoint()
    return (
      <div className="flex flex-col gap-4 px-1">
        <Header
          badge={<span className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white shrink-0" style={{ background: '#a855f7' }} aria-hidden><Home size={16} /></span>}
          title="Return home"
          sub={rtlPosition ? 'Custom RTL point' : 'Takeoff point'}
          onClose={() => selectWaypoint(null)}
        />

        <p className="text-[13px] text-app-text-muted">
          RTL stops the mission and flies here.
        </p>

        {/* Coordinates (editable) */}
        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>Position</span>
          <div className="flex gap-2">
            <Coord label="Lat" step={0.000001} value={rtl.lat}
              onChange={v => { if (!isNaN(v) && v >= -90 && v <= 90) setRtlPosition(v, rtl.lng) }} />
            <Coord label="Lng" step={0.000001} value={rtl.lng}
              onChange={v => { if (!isNaN(v) && v >= -180 && v <= 180) setRtlPosition(rtl.lat, v) }} />
          </div>
        </div>

        <Field
          label="Altitude"
          value={rtl.altitude}
          unit="m"
          min={1}
          max={120}
          step={1}
          onChange={setRtlAltitude}
        />

        <span title={rtlPosition ? 'Use the takeoff point again' : 'Already at the takeoff point'} className="flex">
          <button
            onClick={resetRtlToTakeoff}
            disabled={!rtlPosition}
            className={cn(BTN, 'w-full')}
          >
            <RotateCcw size={14} aria-hidden />
            Reset to takeoff
          </button>
        </span>
      </div>
    )
  }


  if (!wp) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-6 px-3 text-center">
        <span className="w-10 h-10 rounded-[10px] flex items-center justify-center bg-app-surface-2 text-app-text-muted">
          <MousePointerClick size={20} aria-hidden />
        </span>
        <p className="text-[13px] font-semibold text-app-text-muted">
          Select a waypoint to edit it
        </p>
      </div>
    )
  }

  const meta = WP_META[wp.type]
  // 'rtl' is excluded - RTL is edited via its own separate panel entry now
  const typeOptions: WaypointType[] = ['takeoff', 'waypoint', 'loiter', 'land']

  return (
    <div className="flex flex-col gap-4 px-1">
      <Header
        badge={
          <span className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-extrabold tabular-nums text-white shrink-0"
            style={{ background: meta.color }} aria-hidden>
            {index + 1}
          </span>
        }
        title={meta.label}
        sub={`Waypoint ${index + 1} of ${waypoints.length}`}
        onClose={() => selectWaypoint(null)}
      />

      {/* Type selector */}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Type</span>
        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Waypoint type">
          {typeOptions.map(t => {
            const m = WP_META[t]
            const active = wp.type === t
            return (
              <button
                key={t}
                onClick={() => updateWaypoint(wp.id, { type: t })}
                aria-pressed={active}
                className={cn('h-8 flex items-center justify-center gap-1.5 rounded-[6px] border text-[13px] font-semibold transition-colors duration-[120ms]', FOCUS,
                  active ? 'bg-app-accent-soft border-app-accent/60 text-app-text' : 'bg-app-surface-2 border-app-border text-app-text-muted hover:text-app-text')}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color }} aria-hidden />
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Coordinates (editable) */}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Position</span>
        <div className="flex gap-2">
          <Coord label="Lat" step={0.000001} value={wp.lat}
            onChange={v => { if (!isNaN(v) && v >= -90 && v <= 90) updateWaypoint(wp.id, { lat: Math.round(v * 1e7) / 1e7 }) }} />
          <Coord label="Lng" step={0.000001} value={wp.lng}
            onChange={v => { if (!isNaN(v) && v >= -180 && v <= 180) updateWaypoint(wp.id, { lng: Math.round(v * 1e7) / 1e7 }) }} />
        </div>
      </div>

      {/* Parameter sliders + input boxes */}
      <div className="flex flex-col gap-3">
        <span className={LABEL}>Flight</span>
        <Field
          label="Altitude"
          value={wp.altitude}
          unit="m"
          min={1}
          max={120}
          step={1}
          onChange={v => updateWaypoint(wp.id, { altitude: v })}
        />
        <Field
          label="Speed"
          value={wp.speed}
          unit="m/s"
          min={0.5}
          max={15}
          step={0.5}
          onChange={v => updateWaypoint(wp.id, { speed: v })}
        />
        <Field
          label="Hold"
          value={wp.holdTime}
          unit="s"
          min={0}
          max={60}
          step={1}
          onChange={v => updateWaypoint(wp.id, { holdTime: v })}
        />
        {autoHeading ? (
          // Auto-heading is ON - show the computed bearing, disable manual editing
          <div className="flex flex-col gap-1" title="Auto heading is on: the yaw is set when the plan is uploaded">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-app-text">Yaw</span>
              <div className="flex items-center gap-1.5">
                <Compass size={14} className="text-app-accent" aria-hidden />
                <span className="text-[14px] font-bold tabular-nums text-app-text">
                  {autoYaw !== null ? `${autoYaw.toFixed(0)}°` : '-'}
                </span>
                <span className="text-xs font-semibold w-7 text-app-text-muted">auto</span>
              </div>
            </div>
            <div className="w-full h-1.5 rounded-full bg-app-surface-2 border border-app-border overflow-hidden">
              <div
                className="h-full rounded-full bg-app-accent"
                style={{ width: `${autoYaw !== null ? (autoYaw / 360) * 100 : 0}%` }}
              />
            </div>
          </div>
        ) : (
          <Field
            label="Yaw"
            value={wp.yaw ?? 0}
            unit="deg"
            min={0}
            max={359}
            step={1}
            onChange={v => updateWaypoint(wp.id, { yaw: v === 0 ? null : v })}
          />
        )}
        <Field
          label="Turn radius"
          value={wp.turnRadius}
          unit="m"
          min={0}
          max={50}
          step={1}
          onChange={v => updateWaypoint(wp.id, { turnRadius: v })}
        />
      </div>

      {/* Attachment actions run here (uploaded with the mission) */}
      <WaypointActions
        actions={wp.actions ?? []}
        onChange={next => updateWaypoint(wp.id, { actions: next.length ? next : undefined })}
      />

      {/* Delete */}
      <button
        onClick={() => { removeWaypoint(wp.id); selectWaypoint(null) }}
        className={cn(BTN_DANGER, 'w-full')}
      >
        <Trash2 size={14} aria-hidden />
        Delete waypoint
      </button>
    </div>
  )
}

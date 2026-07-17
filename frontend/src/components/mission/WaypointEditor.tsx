'use client'

import { useMemo } from 'react'
import { useMissionStore, RTL_SENTINEL_ID } from '@/store/mission'
import { WP_META } from '@/types/mission'
import type { WaypointType } from '@/types/mission'
import { Trash2, X, Home, RotateCcw, Compass } from 'lucide-react'

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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono font-bold" style={{ color: '#e5e7eb' }}>
          {label}
        </span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min}
            step={step}
            value={value}
            onChange={e => {
              const v = Number(e.target.value)
              if (!isNaN(v)) onChange(Math.max(min, v))
            }}
            className="w-14 text-[11px] font-mono font-bold text-right tabular-nums rounded-md px-1.5 py-1 outline-none"
            style={{
              background: 'rgba(255,255,255,.08)',
              border: '1px solid rgba(255,255,255,.15)',
              color: '#fff',
            }}
          />
          <span className="text-[9px] font-mono font-semibold w-7" style={{ color: '#9ca3af' }}>
            {unit}
          </span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={Math.max(max, value)}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full cursor-pointer"
        style={{ accentColor: '#3b82f6' }}
      />
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

  if (selectedId === RTL_SENTINEL_ID) {
    const rtl = getRtlWaypoint()
    return (
      <div className="flex flex-col gap-4 px-1">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center"
              style={{ background: '#a855f7', color: '#fff' }}
            >
              <Home size={12} />
            </div>
            <span className="text-[13px] font-mono font-bold" style={{ color: '#fff' }}>RTL</span>
          </div>
          <button
            onClick={() => selectWaypoint(null)}
            className="p-1.5 rounded-md transition-colors"
            title="Deselect"
            style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af' }}
          >
            <X size={13} />
          </button>
        </div>

        <p className="text-[10px] font-mono leading-relaxed" style={{ color: '#9ca3af' }}>
          Where the drone flies when RTL is triggered — aborts the current mission immediately
          and goes here. Defaults to the takeoff point until you set a custom position.
        </p>

        {/* Coordinates (editable) */}
        <div>
          <span className="text-[9px] font-mono tracking-wider font-bold mb-1.5 block"
            style={{ color: '#9ca3af' }}>
            POSITION
          </span>
          <div className="flex gap-2">
            <div className="flex-1 flex flex-col gap-0.5">
              <span className="text-[8px] font-mono font-semibold" style={{ color: '#6b7280' }}>LAT</span>
              <input
                type="number"
                step={0.000001}
                value={rtl.lat}
                onChange={e => {
                  const v = Number(e.target.value)
                  if (!isNaN(v) && v >= -90 && v <= 90) setRtlPosition(v, rtl.lng)
                }}
                className="w-full rounded-md px-2 py-1.5 text-[10px] font-mono font-semibold tabular-nums outline-none"
                style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', color: '#fff' }}
              />
            </div>
            <div className="flex-1 flex flex-col gap-0.5">
              <span className="text-[8px] font-mono font-semibold" style={{ color: '#6b7280' }}>LNG</span>
              <input
                type="number"
                step={0.000001}
                value={rtl.lng}
                onChange={e => {
                  const v = Number(e.target.value)
                  if (!isNaN(v) && v >= -180 && v <= 180) setRtlPosition(rtl.lat, v)
                }}
                className="w-full rounded-md px-2 py-1.5 text-[10px] font-mono font-semibold tabular-nums outline-none"
                style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', color: '#fff' }}
              />
            </div>
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

        <button
          onClick={resetRtlToTakeoff}
          disabled={!rtlPosition}
          className="flex items-center justify-center gap-1.5 rounded-lg py-2 mt-1 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          style={{
            background: 'rgba(255,255,255,.06)',
            border: '1.5px solid rgba(255,255,255,.12)',
            color: '#9ca3af',
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          <RotateCcw size={13} />
          Reset to takeoff position
        </button>
      </div>
    )
  }

  if (!wp) {
    return (
      <div className="flex items-center justify-center h-full px-4">
        <p className="text-[11px] font-mono text-center leading-relaxed font-semibold" style={{ color: '#6b7280' }}>
          Select a waypoint<br />to edit properties
        </p>
      </div>
    )
  }

  const index = waypoints.findIndex(w => w.id === wp.id)
  const meta = WP_META[wp.type]

  // Auto-heading: compute the bearing from this waypoint toward the next one
  // (or the incoming bearing for the last waypoint). Shown when autoHeading is on.
  const autoYaw = useMemo(() => {
    if (!autoHeading) return null
    const next = waypoints[index + 1]
    if (next) return computeBearing(wp.lat, wp.lng, next.lat, next.lng)
    const prev = waypoints[index - 1]
    if (prev) return computeBearing(prev.lat, prev.lng, wp.lat, wp.lng)
    return null
  }, [autoHeading, wp, waypoints, index])
  // 'rtl' is excluded — RTL is edited via its own separate panel entry now
  const typeOptions: WaypointType[] = ['takeoff', 'waypoint', 'loiter', 'land']

  return (
    <div className="flex flex-col gap-4 px-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: meta.color, color: '#fff' }}
          >
            {index + 1}
          </div>
          <span className="text-[13px] font-mono font-bold" style={{ color: '#fff' }}>
            {meta.label}
          </span>
        </div>
        <button
          onClick={() => selectWaypoint(null)}
          className="p-1.5 rounded-md transition-colors"
          title="Deselect"
          style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Type selector */}
      <div>
        <span className="text-[9px] font-mono tracking-wider font-bold mb-2 block"
          style={{ color: '#9ca3af' }}>
          TYPE
        </span>
        <div className="grid grid-cols-3 gap-1">
          {typeOptions.map(t => {
            const m = WP_META[t]
            const active = wp.type === t
            return (
              <button
                key={t}
                onClick={() => updateWaypoint(wp.id, { type: t })}
                className="rounded-md py-1.5 text-[9px] font-mono font-bold transition-colors"
                style={{
                  background: active ? `${m.color}30` : 'rgba(255,255,255,.05)',
                  border: `1.5px solid ${active ? m.color : 'rgba(255,255,255,.1)'}`,
                  color: active ? m.color : '#9ca3af',
                }}
              >
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Coordinates (editable) */}
      <div>
        <span className="text-[9px] font-mono tracking-wider font-bold mb-1.5 block"
          style={{ color: '#9ca3af' }}>
          POSITION
        </span>
        <div className="flex gap-2">
          <div className="flex-1 flex flex-col gap-0.5">
            <span className="text-[8px] font-mono font-semibold" style={{ color: '#6b7280' }}>LAT</span>
            <input
              type="number"
              step={0.000001}
              value={wp.lat}
              onChange={e => {
                const v = Number(e.target.value)
                if (!isNaN(v) && v >= -90 && v <= 90) updateWaypoint(wp.id, { lat: Math.round(v * 1e7) / 1e7 })
              }}
              className="w-full rounded-md px-2 py-1.5 text-[10px] font-mono font-semibold tabular-nums outline-none"
              style={{
                background: 'rgba(255,255,255,.08)',
                border: '1px solid rgba(255,255,255,.15)',
                color: '#fff',
              }}
            />
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <span className="text-[8px] font-mono font-semibold" style={{ color: '#6b7280' }}>LNG</span>
            <input
              type="number"
              step={0.000001}
              value={wp.lng}
              onChange={e => {
                const v = Number(e.target.value)
                if (!isNaN(v) && v >= -180 && v <= 180) updateWaypoint(wp.id, { lng: Math.round(v * 1e7) / 1e7 })
              }}
              className="w-full rounded-md px-2 py-1.5 text-[10px] font-mono font-semibold tabular-nums outline-none"
              style={{
                background: 'rgba(255,255,255,.08)',
                border: '1px solid rgba(255,255,255,.15)',
                color: '#fff',
              }}
            />
          </div>
        </div>
      </div>

      {/* Parameter sliders + input boxes */}
      <div className="flex flex-col gap-3">
        <span className="text-[9px] font-mono tracking-wider font-bold"
          style={{ color: '#9ca3af' }}>
          PARAMETERS
        </span>
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
          // Auto-heading is ON — show the computed bearing, disable manual editing
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-bold" style={{ color: '#e5e7eb' }}>Yaw</span>
              <div className="flex items-center gap-1.5">
                <Compass size={11} color="#fbbf24" />
                <span className="text-[10px] font-mono font-semibold tabular-nums" style={{ color: '#fbbf24' }}>
                  {autoYaw !== null ? `${autoYaw.toFixed(0)}°` : '—'}
                </span>
                <span className="text-[9px] font-mono w-7" style={{ color: '#6b7280' }}>auto</span>
              </div>
            </div>
            <div
              className="w-full h-1.5 rounded-full"
              style={{ background: 'rgba(251,191,36,.15)', border: '1px solid rgba(251,191,36,.2)' }}
            >
              <div
                className="h-1.5 rounded-full"
                style={{
                  width: `${autoYaw !== null ? (autoYaw / 360) * 100 : 0}%`,
                  background: 'rgba(251,191,36,.5)',
                }}
              />
            </div>
            <p className="text-[9px] font-mono" style={{ color: '#6b7280' }}>
              Auto Heading ON — yaw set at upload
            </p>
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

      {/* Delete */}
      <button
        onClick={() => { removeWaypoint(wp.id); selectWaypoint(null) }}
        className="flex items-center justify-center gap-1.5 rounded-lg py-2 mt-1 transition-colors"
        style={{
          background: 'rgba(248, 113, 113, .15)',
          border: '1.5px solid rgba(248, 113, 113, .35)',
          color: '#fca5a5',
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'var(--font-geist-mono)',
        }}
      >
        <Trash2 size={13} />
        Delete waypoint
      </button>
    </div>
  )
}

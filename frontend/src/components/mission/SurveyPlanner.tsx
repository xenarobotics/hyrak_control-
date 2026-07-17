'use client'

import { useMissionStore } from '@/store/mission'
import FleetSurveyPanel from './FleetSurveyPanel'
import { Grid3X3, Eraser, Play, RefreshCw, X, MapPin, AlertTriangle, CornerDownRight, Undo2 } from 'lucide-react'

// ── Slider field ───────────────────────────────────────────────────────────

function SurveyField({
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
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono font-bold" style={{ color: '#e5e7eb' }}>
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
            className="w-14 text-[10px] font-mono font-bold text-right tabular-nums rounded-md px-1.5 py-0.5 outline-none"
            style={{
              background: 'rgba(255,255,255,.08)',
              border: '1px solid rgba(255,255,255,.15)',
              color: '#fff',
            }}
          />
          <span className="text-[8px] font-mono font-semibold w-6" style={{ color: '#9ca3af' }}>
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
        className="w-full h-1 rounded-full cursor-pointer"
        style={{ accentColor: '#a855f7' }}
      />
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SurveyPlanner() {
  const surveyMode        = useMissionStore(s => s.surveyMode)
  const surveyPolygon     = useMissionStore(s => s.surveyPolygon)
  const surveyConfig      = useMissionStore(s => s.surveyConfig)
  const surveyGenerated   = useMissionStore(s => s.surveyGenerated)
  const waypoints         = useMissionStore(s => s.waypoints)
  const setSurveyMode     = useMissionStore(s => s.setSurveyMode)
  const clearSurveyPolygon= useMissionStore(s => s.clearSurveyPolygon)
  const removeSurveyPoint = useMissionStore(s => s.removeSurveyPoint)
  const setSurveyConfig   = useMissionStore(s => s.setSurveyConfig)
  const generateSurveyWaypoints = useMissionStore(s => s.generateSurveyWaypoints)

  // Warn when existing manual waypoints would be overwritten by a first-time generate
  const showReplaceWarning = !surveyGenerated && waypoints.length > 0 && surveyPolygon.length >= 3
  // Show "Update" when a previous generation exists
  const isUpdate = surveyGenerated && surveyPolygon.length >= 3

  if (!surveyMode) {
    return (
      <button
        onClick={() => setSurveyMode(true)}
        className="flex items-center gap-2 w-full rounded-lg px-3 py-2.5 transition-colors"
        style={{
          background: 'rgba(168, 85, 247, .12)',
          border: '1.5px solid rgba(168, 85, 247, .3)',
          color: '#c084fc',
        }}
      >
        <Grid3X3 size={14} />
        <span className="text-[11px] font-mono font-bold">Area Survey</span>
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Grid3X3 size={14} color="#c084fc" />
          <span className="text-[12px] font-mono font-bold" style={{ color: '#fff' }}>
            Area Survey
          </span>
        </div>
        <button
          onClick={() => setSurveyMode(false)}
          className="p-1 rounded-md transition-colors"
          style={{ background: 'rgba(255,255,255,.08)', color: '#9ca3af' }}
          title="Close survey planner"
        >
          <X size={12} />
        </button>
      </div>

      {/* Polygon status + undo last point */}
      <div className="flex items-center gap-2">
        <div
          className="flex-1 rounded-lg px-3 py-2 flex items-center gap-2"
          style={{
            background: surveyPolygon.length >= 3
              ? 'rgba(34, 197, 94, .08)'
              : 'rgba(168, 85, 247, .08)',
            border: `1px solid ${surveyPolygon.length >= 3
              ? 'rgba(34, 197, 94, .25)'
              : 'rgba(168, 85, 247, .2)'}`,
          }}
        >
          <MapPin size={12} color={surveyPolygon.length >= 3 ? '#4ade80' : '#c084fc'} />
          <span className="text-[10px] font-mono font-semibold" style={{ color: surveyPolygon.length >= 3 ? '#86efac' : '#d8b4fe' }}>
            {surveyPolygon.length < 3
              ? `Click map to draw area (${surveyPolygon.length}/3+ pts)`
              : `${surveyPolygon.length} points · drag to edit`}
          </span>
        </div>
        {surveyPolygon.length > 0 && (
          <button
            onClick={() => removeSurveyPoint(surveyPolygon.length - 1)}
            title="Remove last point"
            className="p-2 rounded-lg flex-shrink-0 transition-colors"
            style={{
              background: 'rgba(255,255,255,.06)',
              border: '1px solid rgba(255,255,255,.1)',
              color: '#9ca3af',
            }}
          >
            <Undo2 size={12} />
          </button>
        )}
      </div>

      {/* Replace warning — only shown on first generate when manual wps exist */}
      {showReplaceWarning && (
        <div
          className="rounded-lg px-3 py-2 flex items-start gap-2"
          style={{
            background: 'rgba(245, 158, 11, .08)',
            border: '1px solid rgba(245, 158, 11, .3)',
          }}
        >
          <AlertTriangle size={12} color="#fbbf24" className="shrink-0 mt-0.5" />
          <span className="text-[10px] font-mono font-semibold leading-relaxed" style={{ color: '#fde68a' }}>
            Generate will replace your current {waypoints.length}-waypoint mission plan.
          </span>
        </div>
      )}

      {/* Config */}
      <div className="flex flex-col gap-2.5">
        <span className="text-[9px] font-mono tracking-wider font-bold" style={{ color: '#9ca3af' }}>
          PARAMETERS
        </span>

        <SurveyField label="Altitude"     value={surveyConfig.altitude}   unit="m"   min={5}   max={120} step={1}   onChange={v => setSurveyConfig({ altitude: v })} />
        <SurveyField label="Speed"        value={surveyConfig.speed}      unit="m/s" min={0.5} max={15}  step={0.5} onChange={v => setSurveyConfig({ speed: v })} />
        <SurveyField label="Line spacing" value={surveyConfig.spacing}    unit="m"   min={2}   max={100} step={1}   onChange={v => setSurveyConfig({ spacing: v })} />
        <SurveyField label="Scan angle"   value={surveyConfig.angle}      unit="°"   min={0}   max={179} step={1}   onChange={v => setSurveyConfig({ angle: v })} />
        <SurveyField label="Overshoot"    value={surveyConfig.overshoot}  unit="m"   min={0}   max={30}  step={1}   onChange={v => setSurveyConfig({ overshoot: v })} />
        <SurveyField label="Turn radius"  value={surveyConfig.turnRadius} unit="m"   min={0}   max={50}  step={1}   onChange={v => setSurveyConfig({ turnRadius: v })} />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-1">
        {/* Clear Area — removes the drawn polygon so user can redraw */}
        <button
          onClick={clearSurveyPolygon}
          disabled={surveyPolygon.length === 0}
          title="Clears the drawn area polygon so you can redraw. Mission waypoints are not affected until you Generate."
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          style={{
            background: 'rgba(255,255,255,.06)',
            border: '1.5px solid rgba(255,255,255,.12)',
            color: '#d1d5db',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          <Eraser size={11} />
          Clear Area
        </button>

        {/* Generate / Update */}
        <button
          onClick={generateSurveyWaypoints}
          disabled={surveyPolygon.length < 3}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          style={{
            background: isUpdate
              ? 'rgba(59, 130, 246, .2)'
              : showReplaceWarning
              ? 'rgba(245, 158, 11, .18)'
              : 'rgba(168, 85, 247, .2)',
            border: `1.5px solid ${isUpdate
              ? 'rgba(59, 130, 246, .45)'
              : showReplaceWarning
              ? 'rgba(245, 158, 11, .45)'
              : 'rgba(168, 85, 247, .45)'}`,
            color: isUpdate ? '#93c5fd' : showReplaceWarning ? '#fde68a' : '#d8b4fe',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: 'var(--font-geist-mono)',
          }}
        >
          {isUpdate ? <RefreshCw size={11} /> : <Play size={11} />}
          {isUpdate ? 'Update' : 'Generate'}
        </button>
      </div>

      {/* Multi-drone survey — visible in swarm mode with 2+ connected drones */}
      <FleetSurveyPanel />

      {/* Hint */}
      <div className="flex items-start gap-1.5">
        <CornerDownRight size={10} color="#374151" className="shrink-0 mt-0.5" />
        <span className="text-[9px] font-mono" style={{ color: '#374151' }}>
          Clear Area redraws the polygon. Waypoints stay until you Generate/Update.
        </span>
      </div>
    </div>
  )
}

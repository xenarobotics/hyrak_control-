'use client'

import { useMissionStore } from '@/store/mission'
import FleetSurveyPanel from './FleetSurveyPanel'
import { BTN, BTN_ACCENT, BTN_PRIMARY, BTN_WARN, FOCUS, INPUT, LABEL } from './ui'
import { cn } from '@/lib/utils'
import { Grid3X3, Eraser, Play, RefreshCw, X, MapPin, AlertTriangle, Undo2 } from 'lucide-react'

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
          <span className="text-xs text-app-text-muted w-7">{unit}</span>
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
        className={cn('w-full h-1 rounded-full cursor-pointer accent-[var(--app-accent)]', FOCUS)}
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
  const areaReady = surveyPolygon.length >= 3

  if (!surveyMode) {
    return (
      <button
        onClick={() => setSurveyMode(true)}
        className={cn(BTN_ACCENT, 'w-full justify-start')}
        title="Draw an area on the map and generate a lawnmower pattern over it"
      >
        <Grid3X3 size={14} />
        Area survey
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-[6px] bg-app-accent-soft text-app-accent flex items-center justify-center">
            <Grid3X3 size={14} />
          </span>
          <span className="text-base font-bold text-app-text">Area survey</span>
        </div>
        <button
          onClick={() => setSurveyMode(false)}
          className={cn('w-8 h-8 rounded-[6px] flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 transition-colors duration-[120ms]', FOCUS)}
          title="Close survey planner"
          aria-label="Close survey planner"
        >
          <X size={14} />
        </button>
      </div>

      {/* Polygon status + undo last point */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex-1 min-w-0 rounded-[6px] px-2.5 py-1.5 flex items-center gap-2 border text-[13px] font-semibold',
            areaReady ? 'bg-app-ok-soft border-app-ok/40 text-app-ok' : 'bg-app-surface-2 border-app-border text-app-text-muted',
          )}
          role="status"
        >
          <MapPin size={13} className="shrink-0" />
          <span className="truncate">
            {areaReady
              ? `${surveyPolygon.length} points, drag to edit`
              : `Click the map: ${surveyPolygon.length} of 3+ points`}
          </span>
        </div>
        {surveyPolygon.length > 0 && (
          <button
            onClick={() => removeSurveyPoint(surveyPolygon.length - 1)}
            title="Remove last point"
            aria-label="Remove last point"
            className={cn(BTN, 'w-8 px-0 shrink-0')}
          >
            <Undo2 size={14} />
          </button>
        )}
      </div>

      {/* Replace warning - only shown on first generate when manual wps exist */}
      {showReplaceWarning && (
        <div className="rounded-[6px] px-2.5 py-2 flex items-start gap-2 bg-app-warn-soft border border-app-warn/40 text-app-warn" role="status">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span className="text-[13px] font-semibold">
            Replaces your {waypoints.length} current waypoints.
          </span>
        </div>
      )}

      {/* Config */}
      <div className="flex flex-col gap-2.5">
        <span className={LABEL}>Pattern</span>

        <SurveyField label="Altitude"     value={surveyConfig.altitude}   unit="m"   min={5}   max={120} step={1}   onChange={v => setSurveyConfig({ altitude: v })} />
        <SurveyField label="Speed"        value={surveyConfig.speed}      unit="m/s" min={0.5} max={15}  step={0.5} onChange={v => setSurveyConfig({ speed: v })} />
        <SurveyField label="Line spacing" value={surveyConfig.spacing}    unit="m"   min={2}   max={100} step={1}   onChange={v => setSurveyConfig({ spacing: v })} />
        <SurveyField label="Scan angle"   value={surveyConfig.angle}      unit="°"   min={0}   max={179} step={1}   onChange={v => setSurveyConfig({ angle: v })} />
        <SurveyField label="Overshoot"    value={surveyConfig.overshoot}  unit="m"   min={0}   max={30}  step={1}   onChange={v => setSurveyConfig({ overshoot: v })} />
        <SurveyField label="Turn radius"  value={surveyConfig.turnRadius} unit="m"   min={0}   max={50}  step={1}   onChange={v => setSurveyConfig({ turnRadius: v })} />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-1">
        {/* Clear Area - removes the drawn polygon so user can redraw */}
        <button
          onClick={clearSurveyPolygon}
          disabled={surveyPolygon.length === 0}
          title={surveyPolygon.length === 0
            ? 'Nothing drawn yet'
            : 'Clear the drawn area to redraw it. Waypoints stay until you generate.'}
          className={cn(BTN, 'flex-1')}
        >
          <Eraser size={13} />
          Clear area
        </button>

        {/* Generate / Update */}
        <button
          onClick={generateSurveyWaypoints}
          disabled={!areaReady}
          title={!areaReady ? 'Draw at least 3 points first' : isUpdate ? 'Regenerate the waypoints for this area' : 'Generate waypoints for this area'}
          className={cn(showReplaceWarning ? BTN_WARN : BTN_PRIMARY, 'flex-1')}
        >
          {isUpdate ? <RefreshCw size={13} /> : <Play size={13} />}
          {isUpdate ? 'Update' : 'Generate'}
        </button>
      </div>

      {/* Multi-drone survey - visible in swarm mode with 2+ connected drones */}
      <FleetSurveyPanel />
    </div>
  )
}

'use client'

import { useState, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { Info, Maximize2, Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Preset = 'natural' | 'vivid' | 'cinematic' | 'flat' | 'custom'
type Denoise = 'off' | 'light' | 'medium' | 'strong'
type Resolution = 'native' | '1080p' | '1440p'
type AiUpscale = 'off' | '2x' | '4x'

interface EnhanceParams {
    denoise: Denoise
    sharpen: number
    preset: Preset
    contrast: number
    saturation: number
    brightness: number
    gamma: number
    resolution: Resolution
    ai_upscale: AiUpscale
    fps_cap: number
}

const DEFAULTS: EnhanceParams = {
    denoise: 'light',
    sharpen: 0.3,
    preset: 'natural',
    contrast: 1.0,
    saturation: 1.0,
    brightness: 0,
    gamma: 1.0,
    resolution: 'native',
    ai_upscale: 'off',
    fps_cap: 30,
}

const PRESET_VALUES: Record<Exclude<Preset, 'custom'>, Pick<EnhanceParams, 'contrast' | 'saturation' | 'brightness' | 'gamma'>> = {
    natural:   { contrast: 1.0,  saturation: 1.0,  brightness: 0,  gamma: 1.0 },
    vivid:     { contrast: 1.15, saturation: 1.35, brightness: 5,  gamma: 0.95 },
    cinematic: { contrast: 1.2,  saturation: 0.85, brightness: -5, gamma: 1.1 },
    flat:      { contrast: 0.9,  saturation: 0.9,  brightness: 10, gamma: 1.0 },
}

function Row({ label, tooltip, children }: { label: string; tooltip: string; children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))' }}>
                    {label}
                </span>
                <Tooltip>
                    <TooltipTrigger style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help' }}>
                        <Info size={11} style={{ color: 'hsl(var(--app-text-muted))' }} />
                    </TooltipTrigger>
                    <TooltipContent style={{ maxWidth: 230, fontSize: 11, lineHeight: 1.5 }}>
                        {tooltip}
                    </TooltipContent>
                </Tooltip>
            </div>
            {children}
        </div>
    )
}

function StyledSelect<T extends string>({
    value, options, onChange,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
    return (
        <select
            value={value}
            onChange={e => onChange(e.target.value as T)}
            style={{
                width: '100%', padding: '6px 8px', borderRadius: 8,
                background: 'hsl(var(--app-surface-2))',
                border: '1px solid hsl(var(--app-border))',
                color: 'hsl(var(--app-text))',
                fontSize: 11, fontFamily: 'monospace',
            }}
        >
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    )
}

function ParamSlider({
    value, min, max, step, format, onChange,
}: { value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={e => onChange(parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: '#fbbf24' }}
            />
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text))', width: 36, textAlign: 'right' }}>
                {format(value)}
            </span>
        </div>
    )
}

export function EnhancePanel() {
    const cvResults = useDroneStore(s => s.cvResults) as any
    const [params, setParams] = useState<EnhanceParams>(DEFAULTS)

    const inputRes = cvResults?.input_resolution ?? '—'
    const outputRes = cvResults?.output_resolution ?? '—'
    const upscaled = cvResults?.upscaled ?? false
    const upscaleMethod = cvResults?.upscale_method ?? 'none'
    const reused = cvResults?.reused_frame ?? false
    const inferenceMs = cvResults?.analysis_time_ms ?? 0

    const emit = useCallback((next: EnhanceParams) => {
        getSocket().emit('set_enhance_params', next)
    }, [])

    const update = (patch: Partial<EnhanceParams>) => {
        setParams(prev => {
            const next = { ...prev, ...patch, preset: 'custom' as Preset }
            emit(next)
            return next
        })
    }

    const applyPreset = (preset: Preset) => {
        setParams(prev => {
            const next = preset === 'custom'
                ? { ...prev, preset }
                : { ...prev, ...PRESET_VALUES[preset], preset }
            emit(next)
            return next
        })
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Resolution readout */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                borderRadius: 10, background: 'hsl(var(--app-surface-2))',
                border: '1px solid hsl(var(--app-border))',
            }}>
                <Maximize2 size={14} style={{ color: '#fbbf24', flexShrink: 0 }} />
                <div style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}>
                    <div style={{ color: 'hsl(var(--app-text-muted))' }}>
                        Input: <span style={{ color: 'hsl(var(--app-text))' }}>{inputRes}</span>
                    </div>
                    <div style={{ color: 'hsl(var(--app-text-muted))', marginTop: 2 }}>
                        Output: <span style={{ color: upscaled ? '#fbbf24' : 'hsl(var(--app-text))' }}>{outputRes}</span>
                        {upscaleMethod === 'ai' && ' (AI upscaled)'}
                        {upscaleMethod === 'lanczos' && ' (resized up)'}
                    </div>
                </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                    background: 'hsl(var(--app-surface-2))', border: '1px solid hsl(var(--app-border))',
                    borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: 'hsl(var(--app-text-muted))',
                }}>
                    <Gauge size={12} /> {inferenceMs.toFixed(0)}ms{reused ? ' (cached)' : ''}
                </div>
            </div>

            <Row label="DENOISE" tooltip="Removes speckle/snow-style noise from a glitchy analog (non-digital) FPV link, while keeping edges sharp. Off for a clean digital feed — denoising a feed that has no noise just softens detail for nothing.">
                <StyledSelect
                    value={params.denoise}
                    onChange={(v: Denoise) => update({ denoise: v })}
                    options={[
                        { value: 'off', label: 'Off' },
                        { value: 'light', label: 'Light' },
                        { value: 'medium', label: 'Medium' },
                        { value: 'strong', label: 'Strong — heavy interference' },
                    ]}
                />
            </Row>

            <Row label="SHARPEN" tooltip="Unsharp mask — boosts edge contrast to make detail pop. Too much creates a harsh, over-processed look with visible halos around edges.">
                <ParamSlider value={params.sharpen} min={0} max={1} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ sharpen: v })} />
            </Row>

            <Row label="LOOK" tooltip="Quick color-grade presets. Picking one sets Contrast/Saturation/Brightness/Gamma below — adjust any of them afterward and this switches to Custom.">
                <StyledSelect
                    value={params.preset}
                    onChange={(v: Preset) => applyPreset(v)}
                    options={[
                        { value: 'natural', label: 'Natural' },
                        { value: 'vivid', label: 'Vivid' },
                        { value: 'cinematic', label: 'Cinematic' },
                        { value: 'flat', label: 'Flat' },
                        { value: 'custom', label: 'Custom' },
                    ]}
                />
            </Row>

            <Row label="CONTRAST" tooltip="Difference between dark and light areas. Higher = punchier, but can clip detail in shadows/highlights.">
                <ParamSlider value={params.contrast} min={0.5} max={1.8} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ contrast: v })} />
            </Row>

            <Row label="SATURATION" tooltip="Color intensity. Higher = more vivid colors, lower = closer to grayscale.">
                <ParamSlider value={params.saturation} min={0} max={2} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ saturation: v })} />
            </Row>

            <Row label="BRIGHTNESS" tooltip="Flat offset added to every pixel. Use for a feed that's consistently too dark or too bright.">
                <ParamSlider value={params.brightness} min={-40} max={40} step={1} format={v => v.toFixed(0)} onChange={v => update({ brightness: v })} />
            </Row>

            <Row label="GAMMA" tooltip="Reshapes the brightness curve — values below 1 brighten midtones/shadows without blowing out highlights, values above 1 darken them. Different from Brightness, which shifts everything equally.">
                <ParamSlider value={params.gamma} min={0.5} max={1.8} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ gamma: v })} />
            </Row>

            <Row label="OUTPUT RESOLUTION" tooltip="Resizes the output with a sharp Lanczos resize. Not AI-generated detail — it cannot invent detail the source doesn't have, but it's a clean, sharp result at zero added latency, safe for live flying. Ignored when AI Upscale below is on.">
                <StyledSelect
                    value={params.resolution}
                    onChange={(v: Resolution) => update({ resolution: v })}
                    options={[
                        { value: 'native', label: 'Native (no resize)' },
                        { value: '1080p', label: '1080p' },
                        { value: '1440p', label: '1440p' },
                    ]}
                />
            </Row>

            <Row label="AI UPSCALE" tooltip="Real learned super-resolution (FSRCNN) instead of a plain resize — genuinely reconstructs detail rather than just stretching pixels. Measured on this machine: ~6-13 fps, CPU-bound (this build of OpenCV has no GPU path for it). It updates at its own pace and FPS Limit's caching covers the gap, so the live feed itself never stalls — but the enhanced image only refreshes a few times a second, not every frame. Overrides Output Resolution above. For full 24-30fps smoothness, use Output Resolution's plain resize instead.">
                <StyledSelect
                    value={params.ai_upscale}
                    onChange={(v: AiUpscale) => update({ ai_upscale: v })}
                    options={[
                        { value: 'off', label: 'Off' },
                        { value: '2x', label: '2x — sharper, ~13 fps' },
                        { value: '4x', label: '4x — max detail, ~6 fps' },
                    ]}
                />
            </Row>

            <Row label="FPS LIMIT" tooltip="Caps how often this enhancement pipeline re-processes a frame, to save CPU/GPU load. It does NOT change your camera's actual frame rate — frames between updates just reuse the last enhanced result. Lower this (5-10) when AI Upscale is on, since each AI-upscaled frame is much more expensive to compute.">
                <ParamSlider value={params.fps_cap} min={5} max={60} step={5} format={v => v.toFixed(0)} onChange={v => update({ fps_cap: v })} />
            </Row>

            <button
                onClick={() => { setParams(DEFAULTS); emit(DEFAULTS) }}
                style={{
                    fontSize: 10, fontFamily: 'monospace', padding: '5px 10px',
                    borderRadius: 6, border: '1px solid hsl(var(--app-border))',
                    background: 'none', cursor: 'pointer',
                    color: 'hsl(var(--app-text-muted))', alignSelf: 'flex-end',
                }}
            >
                Reset to defaults
            </button>
        </div>
    )
}

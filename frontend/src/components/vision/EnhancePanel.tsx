'use client'

import { useState, useCallback } from 'react'
import { useDroneStore } from '@/store/drone'
import { getSocket } from '@/lib/socket'
import { Info, Maximize2, Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LABEL, MUTED, TEXT, SURFACE_2, BORDER_STRONG, TILE, SECONDARY, NUM, chip, btn, FOCUS, TONE } from './panelStyle'

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={LABEL}>{label}</span>
                <Tooltip>
                    <TooltipTrigger aria-label={`About ${label.toLowerCase()}`} className={FOCUS}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, background: 'none', border: 'none', padding: 0, cursor: 'help', borderRadius: 6 }}>
                        <Info size={13} style={{ color: MUTED }} aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent style={{ maxWidth: 240, fontSize: 13, lineHeight: 1.5 }}>
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
            className={FOCUS}
            style={{
                width: '100%', height: 32, padding: '0 8px', borderRadius: 6,
                background: SURFACE_2,
                border: `1px solid ${BORDER_STRONG}`,
                color: TEXT, fontSize: 14,
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
                className={FOCUS}
                style={{ flex: 1, minHeight: 24, accentColor: 'var(--app-accent)' }}
            />
            <span style={{ fontSize: 13, fontWeight: 700, ...NUM, color: TEXT, width: 40, textAlign: 'right' }}>
                {format(value)}
            </span>
        </div>
    )
}

export function EnhancePanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const [params, setParams] = useState<EnhanceParams>(DEFAULTS)

    const inputRes = cvResults?.input_resolution ?? '-'
    const outputRes = cvResults?.output_resolution ?? '-'
    const upscaled = cvResults?.upscaled ?? false
    const upscaleMethod = cvResults?.upscale_method ?? 'none'
    const reused = cvResults?.reused_frame ?? false

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Resolution readout */}
            <div style={{
                ...TILE, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
            }}>
                <Maximize2 size={16} style={{ color: 'var(--app-accent)', flexShrink: 0 }} aria-hidden />
                <div style={{ flex: 1, ...SECONDARY, ...NUM }}>
                    <div>
                        In: <span style={{ color: TEXT, fontWeight: 700 }}>{inputRes}</span>
                    </div>
                    <div style={{ marginTop: 2 }}>
                        Out: <span style={{ color: upscaled ? TONE.accent.fg : TEXT, fontWeight: 700 }}>{outputRes}</span>
                        {upscaleMethod === 'ai' && ' (AI upscaled)'}
                        {upscaleMethod === 'lanczos' && ' (resized up)'}
                    </div>
                </div>
            </div>

            {reused && (
                <span style={chip('muted')}>
                    <Gauge size={13} aria-hidden /> Reusing the last frame
                </span>
            )}

            <Row label="Denoise" tooltip="Removes snow and speckle from an analog video link. Leave off for a clean digital feed: it only softens detail there.">
                <StyledSelect
                    value={params.denoise}
                    onChange={(v: Denoise) => update({ denoise: v })}
                    options={[
                        { value: 'off', label: 'Off' },
                        { value: 'light', label: 'Light' },
                        { value: 'medium', label: 'Medium' },
                        { value: 'strong', label: 'Strong - heavy interference' },
                    ]}
                />
            </Row>

            <Row label="Sharpen" tooltip="Makes edges crisper. Too much adds halos around edges.">
                <ParamSlider value={params.sharpen} min={0} max={1} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ sharpen: v })} />
            </Row>

            <Row label="Look" tooltip="Colour presets. Picking one sets the four sliders below; moving a slider switches this to Custom.">
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

            <Row label="Contrast" tooltip="Difference between dark and light areas. Too high loses detail in shadows and highlights.">
                <ParamSlider value={params.contrast} min={0.5} max={1.8} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ contrast: v })} />
            </Row>

            <Row label="Saturation" tooltip="Colour strength. Lower is closer to black and white.">
                <ParamSlider value={params.saturation} min={0} max={2} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ saturation: v })} />
            </Row>

            <Row label="Brightness" tooltip="Lightens or darkens the whole picture evenly.">
                <ParamSlider value={params.brightness} min={-40} max={40} step={1} format={v => v.toFixed(0)} onChange={v => update({ brightness: v })} />
            </Row>

            <Row label="Gamma" tooltip="Below 1 brightens shadows without washing out highlights; above 1 darkens them.">
                <ParamSlider value={params.gamma} min={0.5} max={1.8} step={0.05} format={v => v.toFixed(2)} onChange={v => update({ gamma: v })} />
            </Row>

            <Row label="Output size" tooltip="A sharp resize with no added delay, safe for live flying. It cannot add detail the camera did not capture. Ignored when AI upscale is on.">
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

            <Row label="AI upscale" tooltip="Rebuilds detail with an AI model (FSRCNN). Runs at about 6 to 13 fps on this server, so the enhanced picture refreshes a few times a second while the live feed keeps running. Overrides Output size.">
                <StyledSelect
                    value={params.ai_upscale}
                    onChange={(v: AiUpscale) => update({ ai_upscale: v })}
                    options={[
                        { value: 'off', label: 'Off' },
                        { value: '2x', label: '2x - sharper, ~13 fps' },
                        { value: '4x', label: '4x - max detail, ~6 fps' },
                    ]}
                />
            </Row>

            <Row label="FPS limit" tooltip="How often a frame is enhanced, to save server load. The camera frame rate does not change. Use 5 to 10 with AI upscale.">
                <ParamSlider value={params.fps_cap} min={5} max={60} step={5} format={v => v.toFixed(0)} onChange={v => update({ fps_cap: v })} />
            </Row>

            <button
                type="button"
                onClick={() => { setParams(DEFAULTS); emit(DEFAULTS) }}
                className={FOCUS}
                style={{ ...btn(), alignSelf: 'flex-end' }}
            >
                Reset to defaults
            </button>
        </div>
    )
}

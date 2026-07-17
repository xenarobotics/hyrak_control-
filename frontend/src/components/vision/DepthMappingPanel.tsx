'use client'

import { useDroneStore } from '@/store/drone'
import { Timer } from 'lucide-react'

export function DepthMappingPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const inferenceMs = cvResults?.analysis_time_ms ?? 0
    const minD = (cvResults as any)?.min_depth_m ?? 0
    const maxD = (cvResults as any)?.max_depth_m ?? 0
    const meanD = (cvResults as any)?.mean_depth_m ?? 0

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            <div style={{ display: 'flex', gap: 8 }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '4px 10px', borderRadius: 8,
                    background: 'hsl(var(--app-surface-2))',
                    border: '1px solid hsl(var(--app-border))',
                    fontSize: 11, fontFamily: 'monospace',
                    color: 'hsl(var(--app-text-muted))',
                }}>
                    <Timer size={12} />
                    {inferenceMs.toFixed(0)}ms · ZoeDepth
                </div>
            </div>

            {cvResults ? (
                <>
                    {/* Color scale */}
                    <div>
                        <div style={{
                            fontSize: 10, color: 'hsl(var(--app-text-muted))',
                            fontFamily: 'monospace', marginBottom: 6,
                        }}>
                            DEPTH SCALE — 0.3m to 5m
                        </div>
                        <div style={{
                            height: 18, borderRadius: 6,
                            background: 'linear-gradient(to right, #00007f, #0000ff, #007fff, #00ffff, #7fff7f, #ffff00, #ff7f00, #ff0000)',
                            border: '1px solid hsl(var(--app-border))',
                        }} />
                        <div style={{
                            display: 'flex', justifyContent: 'space-between',
                            marginTop: 4, fontSize: 10,
                            color: 'hsl(var(--app-text-muted))', fontFamily: 'monospace',
                        }}>
                            <span>0.3m (near)</span>
                            <span>5m+ (far)</span>
                        </div>
                    </div>

                    {/* Metric depth stats */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                        {[
                            { label: 'Min', value: minD, color: '#60a5fa' },
                            { label: 'Mean', value: meanD, color: '#4ade80' },
                            { label: 'Max', value: maxD, color: '#f87171' },
                        ].map(stat => (
                            <div key={stat.label} style={{
                                padding: '10px 8px', borderRadius: 8, textAlign: 'center',
                                background: 'hsl(var(--app-surface-2))',
                                border: '1px solid hsl(var(--app-border))',
                            }}>
                                <div style={{
                                    fontSize: 18, fontWeight: 700,
                                    fontFamily: 'monospace', color: stat.color,
                                }}>
                                    {stat.value.toFixed(2)}
                                </div>
                                <div style={{
                                    fontSize: 9, color: 'hsl(var(--app-text-muted))', marginTop: 2,
                                }}>
                                    {stat.label} (metres)
                                </div>
                            </div>
                        ))}
                    </div>

                    <div style={{
                        padding: '8px 12px', borderRadius: 8,
                        background: '#E1F5EE18',
                        border: '1px solid rgba(93,202,165,0.3)',
                        fontSize: 11, color: 'rgba(93,202,165,0.9)',
                        fontFamily: 'monospace',
                    }}>
                        ✓ ZoeDepth metric depth · Blue = near · Red = far
                    </div>
                </>
            ) : (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 100, color: 'hsl(var(--app-text-muted))',
                    fontSize: 12, fontFamily: 'monospace',
                }}>
                    Start stream in Depth mode
                </div>
            )}
        </div>
    )
}
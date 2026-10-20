'use client'

import { useDroneStore } from '@/store/drone'
import { LABEL, READOUT, UNIT, SECONDARY, TILE, NUM, BORDER, chip } from './panelStyle'

export function DepthMappingPanel() {
    const cvResults = useDroneStore(s => s.cvResults)
    const minD = cvResults?.min_depth_m ?? 0
    const maxD = cvResults?.max_depth_m ?? 0
    const meanD = cvResults?.mean_depth_m ?? 0

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {cvResults ? (
                <>
                    {/* Metric depth stats: nearest first, it is the one that matters */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                        {[
                            { label: 'Nearest', value: minD },
                            { label: 'Average', value: meanD },
                            { label: 'Farthest', value: maxD },
                        ].map(stat => (
                            <div key={stat.label} style={{ ...TILE, padding: '10px 8px', textAlign: 'center' }}>
                                <div style={{ ...READOUT, fontSize: 22 }}>
                                    {stat.value.toFixed(1)}<span style={UNIT}>m</span>
                                </div>
                                <div style={{ ...SECONDARY, marginTop: 2 }}>{stat.label}</div>
                            </div>
                        ))}
                    </div>

                    {/* Colour scale (the depth image's own colormap, not theme colours) */}
                    <div>
                        <div style={{ ...LABEL, marginBottom: 6 }}>Colour scale</div>
                        <div style={{
                            height: 16, borderRadius: 6,
                            background: 'linear-gradient(to right, #00007f, #0000ff, #007fff, #00ffff, #7fff7f, #ffff00, #ff7f00, #ff0000)',
                            border: `1px solid ${BORDER}`,
                        }} />
                        <div style={{
                            ...SECONDARY, ...NUM,
                            display: 'flex', justifyContent: 'space-between', marginTop: 4,
                        }}>
                            <span>Blue: near (0.3 m)</span>
                            <span>Red: far (5 m+)</span>
                        </div>
                    </div>

                    <span style={chip('ok')} title="Depth Anything 3, metric depth">Measured in metres</span>
                </>
            ) : (
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 100, ...SECONDARY,
                }}>
                    Waiting for video
                </div>
            )}
        </div>
    )
}

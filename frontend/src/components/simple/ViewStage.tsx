'use client'

// The big picture: what the drone's camera sees, or where it is on the map.
// The other view sits small in the corner; tapping it (or the Camera / Map
// switch) swaps them. Neither view is ever remounted, so the video does not
// restart when you swap.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { VideoStream } from '@/components/video/VideoStream'
import { useWebRTCContext } from '@/contexts/WebRTCContext'
import { getVideoSource, needsCameraSelection } from '@/lib/videoSource'

const MissionMap = dynamic(() => import('@/components/mission/MissionMap'), { ssr: false })

type View = 'camera' | 'map'
const KEY = 'hyrak-simple-view'

export function ViewStage({ alert }: { alert?: React.ReactNode }) {
    const [big, setBig] = useState<View>('camera')
    const [mounted, setMounted] = useState(false)
    const { isStreaming, isLoading, startStream, selectedCameraId } = useWebRTCContext()
    const camBlocked = needsCameraSelection(getVideoSource()) && !selectedCameraId
    useEffect(() => {
        setMounted(true)
        try { if (localStorage.getItem(KEY) === 'map') setBig('map') } catch { /* */ }
    }, [])
    const choose = (v: View) => { setBig(v); try { localStorage.setItem(KEY, v) } catch { /* */ } }

    const box = (v: View): React.CSSProperties => big === v
        ? { position: 'absolute', inset: 0 }
        : { position: 'absolute', right: 14, bottom: 14, width: 'min(30%, 300px)', aspectRatio: '16 / 10', zIndex: 20,
            borderRadius: 12, overflow: 'hidden', border: '3px solid #fff', boxShadow: '0 6px 20px rgba(15,30,51,.25)' }

    return (
        <section className="relative flex-1 min-h-0 rounded-[var(--s-radius)] overflow-hidden" style={{ background: '#0F1E33' }}
            aria-label={big === 'camera' ? 'Camera view' : 'Map view'}>
            <div style={box('camera')}>
                <div className="absolute inset-0 flex"><VideoStream bare noOsd cleanFeed /></div>
                {!isStreaming && big === 'camera' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6" style={{ color: '#C9D6E6' }}>
                        <p className="text-[19px]">The camera is off.</p>
                        <button type="button" onClick={() => startStream()} disabled={isLoading || camBlocked}
                            className="min-h-[56px] rounded-[var(--s-radius)] px-6 text-[19px] font-bold disabled:opacity-50"
                            style={{ background: '#fff', color: 'var(--s-blue)' }}>
                            {isLoading ? 'Starting the camera…' : 'Turn on the camera'}
                        </button>
                        {camBlocked && <p className="text-[15px]">Pick which camera in Settings first.</p>}
                    </div>
                )}
                {big !== 'camera' && (
                    <button type="button" onClick={() => choose('camera')} aria-label="Show the camera big"
                        className="absolute inset-0 z-10" style={{ background: 'transparent' }} />
                )}
            </div>
            <div style={box('map')}>
                {mounted && <MissionMap readOnly follow compact={big !== 'map'} layer="street" />}
                {big !== 'map' && (
                    <button type="button" onClick={() => choose('map')} aria-label="Show the map big"
                        className="absolute inset-0 z-[1000]" style={{ background: 'transparent' }} />
                )}
            </div>

            <div className="absolute left-3 top-3 z-[1100] flex rounded-xl p-1 gap-1" role="tablist" aria-label="Main view"
                style={{ background: 'rgba(255,255,255,.95)', boxShadow: '0 2px 10px rgba(15,30,51,.18)' }}>
                {(['camera', 'map'] as View[]).map(v => (
                    <button key={v} type="button" role="tab" aria-selected={big === v} onClick={() => choose(v)}
                        className="min-h-[44px] min-w-[96px] rounded-lg px-4 text-[17px] font-bold"
                        style={big === v ? { background: 'var(--s-blue)', color: '#fff' } : { color: 'var(--s-ink)' }}>
                        {v === 'camera' ? 'Camera' : 'Map'}
                    </button>
                ))}
            </div>
            {alert && <div className="absolute left-3 right-3 bottom-3 z-[1100] pointer-events-none flex justify-center">{alert}</div>}
        </section>
    )
}

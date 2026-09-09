'use client'

// Live 3D map view for the 3D SCAN mode - the thing the operator actually
// came for: the reconstructed point cloud growing in real time, with the
// camera's flight path, orbitable with the mouse. Dependency-free WebGL
// (no three.js in the bundle); data comes from the engine through the
// backend proxy: /map_preview (decimated colored surface points) and
// /trajectory (keyframe path + current pose).
//
// Coordinates: the engine's world frame is the first camera's OpenCV frame
// (x right, y DOWN, z forward). Rendered as (x, -y, z) so up is up.

import { useEffect, useRef, useState } from 'react'
import { getServerUrl } from '@/lib/server-url'
import { useDroneStore } from '@/store/drone'
import { RotateCcw, Video } from 'lucide-react'

const api = (p: string) => `${getServerUrl()}/api/recon${p}`

const VS = `
attribute vec3 aPos; attribute vec3 aCol;
uniform mat4 uMvp; uniform float uSize;
varying vec3 vCol;
void main() {
  gl_Position = uMvp * vec4(aPos.x, -aPos.y, aPos.z, 1.0);
  gl_PointSize = uSize;
  vCol = aCol;
}`
const FS = `
precision mediump float; varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }`

// -- tiny mat4 helpers (column-major) ---------------------------------------
function perspective(fovY: number, aspect: number, near: number, far: number) {
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far)
    return new Float32Array([
        f / aspect, 0, 0, 0, 0, f, 0, 0,
        0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
}
function mul(a: Float32Array, b: Float32Array) {
    const o = new Float32Array(16)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
        o[c * 4 + r] = s
    }
    return o
}
function lookAt(eye: number[], at: number[], up: number[]) {
    const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
    const norm = (v: number[]) => {
        const l = Math.hypot(v[0], v[1], v[2]) || 1
        return [v[0] / l, v[1] / l, v[2] / l]
    }
    const cross = (p: number[], q: number[]) => [
        p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]
    const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
    const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x)
    return new Float32Array([
        x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}

type Cloud = { xyz: Float32Array; rgb: Float32Array; n: number }

export function Recon3DView() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const [nPoints, setNPoints] = useState(0)
    const [showPip, setShowPip] = useState(true)
    // The analyzer publishes engine/tracking state as the mode's results, so
    // the map view can say what is happening instead of looking blank.
    const cv = useDroneStore(s => s.cvResults) as Record<string, unknown> | null
    const engineState = String(cv?.engine_state ?? 'starting')
    const trackState = String(cv?.tracking_state ?? 'n/a')
    const inputW = Number(cv?.input_w ?? 0)
    const inputH = Number(cv?.input_h ?? 0)
    // Below 1280 wide, small objects will not reconstruct - say so while the
    // scan is still running, not after the user has judged the result.
    const inputDegraded = inputW > 0 && inputW < 1280

    // Mutable render state lives in refs - the render loop reads it directly.
    const st = useRef({
        cloud: null as Cloud | null,
        traj: null as Float32Array | null,
        pose: null as number[] | null,          // [x, -y, z] display coords
        dirty: true,
        yaw: -0.7, pitch: 0.5, dist: 8,
        target: [0, 0, 2] as number[],
        userMoved: false,
    })

    // -- data polling --------------------------------------------------------
    useEffect(() => {
        let alive = true
        const pollCloud = async () => {
            try {
                const r = await fetch(api('/map_preview?max_points=20000'))
                if (!r.ok || !alive) return
                const j = await r.json()
                if (!j.n) return
                const xyz = new Float32Array(j.n * 3)
                const rgb = new Float32Array(j.n * 3)
                for (let i = 0; i < j.n; i++) {
                    xyz[i * 3] = j.xyz[i][0]; xyz[i * 3 + 1] = j.xyz[i][1]; xyz[i * 3 + 2] = j.xyz[i][2]
                    const c = j.rgb ? j.rgb[i] : [180, 180, 180]
                    rgb[i * 3] = c[0] / 255; rgb[i * 3 + 1] = c[1] / 255; rgb[i * 3 + 2] = c[2] / 255
                }
                st.current.cloud = { xyz, rgb, n: j.n }
                st.current.dirty = true
                setNPoints(j.n)
                if (!st.current.userMoved) {
                    // Auto-frame the growing map until the operator takes over.
                    let cx = 0, cy = 0, cz = 0
                    for (let i = 0; i < j.n; i++) { cx += xyz[i * 3]; cy -= xyz[i * 3 + 1]; cz += xyz[i * 3 + 2] }
                    st.current.target = [cx / j.n, cy / j.n, cz / j.n]
                    let rMax = 0.5
                    for (let i = 0; i < Math.min(j.n, 4000); i++) {
                        const dx = xyz[i * 3] - st.current.target[0]
                        const dy = -xyz[i * 3 + 1] - st.current.target[1]
                        const dz = xyz[i * 3 + 2] - st.current.target[2]
                        rMax = Math.max(rMax, Math.hypot(dx, dy, dz))
                    }
                    st.current.dist = Math.min(60, Math.max(2.5, rMax * 2.2))
                }
            } catch { /* engine warming up */ }
        }
        const pollTraj = async () => {
            try {
                const r = await fetch(api('/trajectory'))
                if (!r.ok || !alive) return
                const j = await r.json()
                if (j.traj?.length) {
                    const t = new Float32Array(j.traj.length * 3)
                    for (let i = 0; i < j.traj.length; i++) {
                        t[i * 3] = j.traj[i][0]; t[i * 3 + 1] = j.traj[i][1]; t[i * 3 + 2] = j.traj[i][2]
                    }
                    st.current.traj = t
                    if (j.last_T) {
                        st.current.pose = [j.last_T[0][3], j.last_T[1][3], j.last_T[2][3]]
                    }
                    st.current.dirty = true
                }
            } catch { /* engine warming up */ }
        }
        pollCloud(); pollTraj()
        const a = setInterval(pollCloud, 2000)
        const b = setInterval(pollTraj, 1000)
        return () => { alive = false; clearInterval(a); clearInterval(b) }
    }, [])

    // -- WebGL render loop ---------------------------------------------------
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const gl = canvas.getContext('webgl', { antialias: true })
        if (!gl) return

        const sh = (type: number, src: string) => {
            const s = gl.createShader(type)!
            gl.shaderSource(s, src); gl.compileShader(s)
            return s
        }
        const prog = gl.createProgram()!
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
        gl.linkProgram(prog); gl.useProgram(prog)
        const aPos = gl.getAttribLocation(prog, 'aPos')
        const aCol = gl.getAttribLocation(prog, 'aCol')
        const uMvp = gl.getUniformLocation(prog, 'uMvp')
        const uSize = gl.getUniformLocation(prog, 'uSize')
        const posBuf = gl.createBuffer(), colBuf = gl.createBuffer()
        const trajBuf = gl.createBuffer(), trajColBuf = gl.createBuffer()
        gl.enable(gl.DEPTH_TEST)

        let uploadedN = 0, uploadedTrajN = 0
        let raf = 0
        const draw = () => {
            raf = requestAnimationFrame(draw)
            const s = st.current
            const w = canvas.clientWidth, h = canvas.clientHeight
            if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
                canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio
                s.dirty = true
            }
            if (!s.dirty) return
            s.dirty = false
            gl.viewport(0, 0, canvas.width, canvas.height)
            gl.clearColor(0.04, 0.05, 0.07, 1)
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

            const eye = [
                s.target[0] + s.dist * Math.cos(s.pitch) * Math.sin(s.yaw),
                s.target[1] + s.dist * Math.sin(s.pitch),
                s.target[2] + s.dist * Math.cos(s.pitch) * Math.cos(s.yaw),
            ]
            const mvp = mul(perspective(0.9, w / Math.max(1, h), 0.05, 500),
                lookAt(eye, s.target, [0, 1, 0]))
            gl.uniformMatrix4fv(uMvp, false, mvp)

            if (s.cloud && s.cloud.n) {
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
                if (uploadedN !== s.cloud.n) gl.bufferData(gl.ARRAY_BUFFER, s.cloud.xyz, gl.DYNAMIC_DRAW)
                gl.enableVertexAttribArray(aPos)
                gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
                gl.bindBuffer(gl.ARRAY_BUFFER, colBuf)
                if (uploadedN !== s.cloud.n) gl.bufferData(gl.ARRAY_BUFFER, s.cloud.rgb, gl.DYNAMIC_DRAW)
                uploadedN = s.cloud.n
                gl.enableVertexAttribArray(aCol)
                gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0)
                gl.uniform1f(uSize, Math.max(2, 2.4 * devicePixelRatio))
                gl.drawArrays(gl.POINTS, 0, s.cloud.n)
            }
            if (s.traj) {
                const n = s.traj.length / 3
                gl.bindBuffer(gl.ARRAY_BUFFER, trajBuf)
                if (uploadedTrajN !== n) gl.bufferData(gl.ARRAY_BUFFER, s.traj, gl.DYNAMIC_DRAW)
                gl.enableVertexAttribArray(aPos)
                gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
                // Amber path - one flat color, reuse the color attrib.
                const amber = new Float32Array(n * 3)
                for (let i = 0; i < n; i++) { amber[i * 3] = 0.98; amber[i * 3 + 1] = 0.75; amber[i * 3 + 2] = 0.14 }
                gl.bindBuffer(gl.ARRAY_BUFFER, trajColBuf)
                if (uploadedTrajN !== n) gl.bufferData(gl.ARRAY_BUFFER, amber, gl.DYNAMIC_DRAW)
                uploadedTrajN = n
                gl.enableVertexAttribArray(aCol)
                gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0)
                gl.uniform1f(uSize, 6 * devicePixelRatio)
                gl.drawArrays(gl.LINE_STRIP, 0, n)
                gl.drawArrays(gl.POINTS, n - 1, 1)   // current camera marker
            }
        }
        draw()

        // -- orbit controls --------------------------------------------------
        let dragging = false, panning = false, lx = 0, ly = 0
        const down = (e: MouseEvent) => {
            dragging = true; panning = e.button === 2 || e.shiftKey
            lx = e.clientX; ly = e.clientY
        }
        const move = (e: MouseEvent) => {
            if (!dragging) return
            const s = st.current
            const dx = e.clientX - lx, dy = e.clientY - ly
            lx = e.clientX; ly = e.clientY
            s.userMoved = true
            if (panning) {
                const k = s.dist * 0.0016
                s.target[0] -= (dx * Math.cos(s.yaw) - 0) * k
                s.target[2] += (dx * Math.sin(s.yaw)) * k
                s.target[1] += dy * k
            } else {
                s.yaw -= dx * 0.008
                s.pitch = Math.min(1.5, Math.max(-1.5, s.pitch + dy * 0.008))
            }
            s.dirty = true
        }
        const up = () => { dragging = false }
        const wheel = (e: WheelEvent) => {
            e.preventDefault()
            const s = st.current
            s.userMoved = true
            s.dist = Math.min(120, Math.max(0.5, s.dist * (e.deltaY > 0 ? 1.12 : 0.89)))
            s.dirty = true
        }
        const ctx = (e: Event) => e.preventDefault()
        canvas.addEventListener('mousedown', down)
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        canvas.addEventListener('wheel', wheel, { passive: false })
        canvas.addEventListener('contextmenu', ctx)
        return () => {
            cancelAnimationFrame(raf)
            canvas.removeEventListener('mousedown', down)
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            canvas.removeEventListener('wheel', wheel)
            canvas.removeEventListener('contextmenu', ctx)
        }
    }, [])

    return (
        <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
            <canvas ref={canvasRef}
                style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />

            {nPoints === 0 && (() => {
                // Say exactly what is happening so it never reads as "broken".
                let head = 'STARTING 3D ENGINE...', sub = 'one moment', color = 'rgba(255,255,255,0.55)'
                if (engineState === 'failed') {
                    head = '3D ENGINE ERROR'
                    sub = String(cv?.engine_error ?? 'see server log')
                    color = '#f87171'
                } else if (engineState === 'running') {
                    if (trackState === 'initializing') {
                        // The engine holds here refusing to seed a map from a
                        // near-constant depth (a dark or textureless view -
                        // engine commit 026ed0e). Tell the user WHY, so a held
                        // init reads as an instruction, not a hang.
                        head = 'POINT AT A LIT, TEXTURED AREA TO START'
                        sub = 'aim at furniture, edges or a doorway, not a blank or dark wall'
                        color = '#fbbf24'
                    } else if (trackState === 'lost' || trackState === 'n/a') {
                        head = 'MOVE THE CAMERA SLOWLY TO BEGIN'
                        sub = 'point at textured surfaces, keep it lit'
                        color = '#fbbf24'
                    } else {
                        head = 'BUILDING THE FIRST SURFACE...'
                        sub = 'keep moving gently through the space'
                        color = '#34d399'
                    }
                }
                return (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        flexDirection: 'column', alignItems: 'center',
                        justifyContent: 'center', gap: 8, pointerEvents: 'none',
                        color, fontFamily: 'monospace', textAlign: 'center', padding: 20,
                    }}>
                        <p style={{ fontSize: 13, letterSpacing: 1 }}>{head}</p>
                        <p style={{ fontSize: 11, opacity: 0.8, maxWidth: 340 }}>{sub}</p>
                    </div>
                )
            })()}

            <div style={{
                position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6,
                fontFamily: 'monospace', fontSize: 10,
            }}>
                <span style={{
                    padding: '3px 8px', borderRadius: 6, color: '#34d399',
                    background: 'rgba(0,0,0,0.65)', border: '1px solid #34d39944',
                }}>LIVE 3D MAP · {nPoints.toLocaleString()} pts</span>
                <span style={{
                    padding: '3px 8px', borderRadius: 6, color: '#a1a1aa',
                    background: 'rgba(0,0,0,0.65)',
                }}>drag orbit · wheel zoom · shift-drag pan</span>
                {inputW > 0 && (
                    <span title={inputDegraded
                        ? 'The network is reducing your video in transit - detail below this cannot be reconstructed. Better connection = better scan.'
                        : 'Resolution actually reaching the reconstruction'}
                        style={{
                            padding: '3px 8px', borderRadius: 6,
                            color: inputDegraded ? '#fbbf24' : '#a1a1aa',
                            background: 'rgba(0,0,0,0.65)',
                            border: inputDegraded ? '1px solid #fbbf2455' : 'none',
                        }}>
                        INPUT {inputW}x{inputH}{inputDegraded ? ' - LINK DEGRADED' : ''}
                    </span>
                )}
            </div>

            <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                <button title="Re-frame the map"
                    onClick={() => { st.current.userMoved = false; st.current.dirty = true }}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px',
                        borderRadius: 6, fontSize: 10, fontFamily: 'monospace',
                        background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.15)',
                        color: '#e4e4e7', cursor: 'pointer',
                    }}>
                    <RotateCcw size={11} /> FIT
                </button>
                <button title="Toggle camera picture-in-picture"
                    onClick={() => setShowPip(v => !v)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px',
                        borderRadius: 6, fontSize: 10, fontFamily: 'monospace',
                        background: showPip ? 'rgba(52,211,153,0.18)' : 'rgba(0,0,0,0.65)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        color: showPip ? '#34d399' : '#e4e4e7', cursor: 'pointer',
                    }}>
                    <Video size={11} /> CAM
                </button>
            </div>

            {showPip && (
                <div style={{
                    position: 'absolute', bottom: 10, left: 10, width: 200,
                    aspectRatio: '16/9', borderRadius: 8, overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.2)', background: '#000',
                }}>
                    {/* The engine's echo of what it receives - also live proof
                        that frames are reaching the reconstruction. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={api('/stream/video')} alt="camera"
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                </div>
            )}
        </div>
    )
}

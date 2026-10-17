import { io, Socket } from 'socket.io-client'
import { getServerUrl } from './server-url'
import { getToken, redirectToLogin } from './auth'

let socket: Socket | null = null
// The cloud session this page holds. Offered back on every reconnect so a
// dropped socket reclaims its session - drone link, relay, flight record -
// instead of the server tearing it all down. Page lifetime only: a reload
// cannot resume a radio relay that died with the page. The resume_secret
// arrives in session_ready and must go back with the id: the id alone is
// visible in logs and the admin page and does not reclaim a drone.
let resumeSessionId: string | null = null
let resumeSecret: string | null = null

export function setResumeSession(id: string | null): void {
    resumeSessionId = id
    if (!id) resumeSecret = null
}

export function getSocket(): Socket {
    if (!socket) {
        socket = io(getServerUrl(), {
            // Re-evaluated on every (re)connect, so a login or a new
            // session id is picked up without rebuilding the socket.
            auth: (cb: (data: object) => void) =>
                cb({ token: getToken() ?? '', resume_session: resumeSessionId, resume_secret: resumeSecret }),
            transports: ['websocket'],
            reconnection: true,
            // Keep trying: the server holds the session for 90 s, and a
            // pilot's link must come back on its own, not after 10 tries.
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 3000,
            autoConnect: false,
        })
        socket.on('session_ready', (data: { session_id?: string; resume_secret?: string }) => {
            if (data?.resume_secret) resumeSecret = data.resume_secret
        })
        // The server refuses the handshake outright when the token is
        // missing, expired or revoked. Nothing will change by retrying;
        // go and sign in.
        socket.on('connect_error', (err: Error) => {
            if (err?.message === 'unauthorized') {
                socket?.disconnect()
                redirectToLogin()
            }
        })
        // DEV ONLY: a handle for driving the UI from the console.
        //
        // Panels that only appear while something is happening on the aircraft
        // - a calibration mid-run, a follow mid-chase - could not be looked at
        // without an aircraft, so they were designed blind and reviewed once,
        // late, by the one person who has the hardware. `__hyrakSocket.emit`
        // is the server-bound half; the useful half is calling the listeners
        // directly:
        //
        //   __hyrakSocket.listeners('calibration_state')[0]({ ... })
        //
        // Stripped from production builds by the NODE_ENV check, which Next
        // evaluates at build time and eliminates.
        if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
            ;(window as unknown as Record<string, unknown>).__hyrakSocket = socket
        }
    }
    return socket
}

export function connectSocket(): void {
    getSocket().connect()
}

export function disconnectSocket(): void {
    resumeSessionId = null
    resumeSecret = null
    if (socket) {
        socket.disconnect()
        socket = null
    }
}
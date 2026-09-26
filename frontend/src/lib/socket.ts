import { io, Socket } from 'socket.io-client'
import { getServerUrl } from './server-url'

const SECRET_TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || 'change_this_to_a_random_string'

let socket: Socket | null = null
// The cloud session this page holds. Offered back on every reconnect so a
// dropped socket reclaims its session - drone link, relay, flight record -
// instead of the server tearing it all down. Page lifetime only: a reload
// cannot resume a radio relay that died with the page.
let resumeSessionId: string | null = null

export function setResumeSession(id: string | null): void {
    resumeSessionId = id
}

export function getSocket(): Socket {
    if (!socket) {
        socket = io(getServerUrl(), {
            auth: (cb: (data: object) => void) =>
                cb({ token: SECRET_TOKEN, resume_session: resumeSessionId }),
            transports: ['websocket'],
            reconnection: true,
            // Keep trying: the server holds the session for 90 s, and a
            // pilot's link must come back on its own, not after 10 tries.
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 3000,
            autoConnect: false,
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
    if (socket) {
        socket.disconnect()
        socket = null
    }
}
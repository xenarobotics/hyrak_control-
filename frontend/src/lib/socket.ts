import { io, Socket } from 'socket.io-client'
import { getServerUrl } from './server-url'

const SECRET_TOKEN = process.env.NEXT_PUBLIC_SECRET_TOKEN || 'change_this_to_a_random_string'

let socket: Socket | null = null

export function getSocket(): Socket {
    if (!socket) {
        socket = io(getServerUrl(), {
            auth: { token: SECRET_TOKEN },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            autoConnect: false,
        })
    }
    return socket
}

export function connectSocket(): void {
    getSocket().connect()
}

export function disconnectSocket(): void {
    if (socket) {
        socket.disconnect()
        socket = null
    }
}
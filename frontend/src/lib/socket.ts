import { io, Socket } from 'socket.io-client'
import { getServerUrl } from './server-url'
import { fetchMe, getAccess, getToken, getUser, isCustomer, redirectToLogin } from './auth'
import {
    canView, getActiveWorkspace, readActiveWorkspaceId, setActiveWorkspaceId, viewableWorkspaces,
} from './activeWorkspace'

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

// ── Workspace scope (docs/ACCESS_MODEL.md section 8a) ───────────────────
//
// A customer-only account's session belongs to exactly one workspace: the
// handshake names it, and the server refuses with `no_workspace_access`
// when the account cannot view it. Staff send nothing and stay on HYRAK,
// exactly as before. `no_workspace_access` is NOT "signed out": only
// `unauthorized` is.

/** The workspace the last handshake asked for, so a refusal knows which one failed. */
let handshakeWorkspace: string | null = null
/** Workspaces refused since the last good session, so recovery never loops. */
const refusedWorkspaces = new Set<string>()
let recovering = false

function handshakeWorkspaceId(): string | null {
    if (!isCustomer(getUser())) return null
    return getActiveWorkspace()?.id ?? null
}

/** Accounts with no viewable workspace have only the standalone account page. */
function goToAccountPage(): void {
    if (typeof window === 'undefined') return
    if (!window.location.pathname.startsWith('/account')) window.location.assign('/account')
}

/**
 * The server refused the active workspace (or dropped the session): refresh
 * memberships, move to another viewable workspace and connect again, or go
 * to /account when none is left. `refused` is the workspace to skip.
 */
async function recoverWorkspace(refused: string | null): Promise<void> {
    if (recovering) return
    recovering = true
    try {
        if (refused) refusedWorkspaces.add(refused)
        const user = await fetchMe()
        if (!user) { redirectToLogin(); return }
        if (!isCustomer(user)) { socket?.connect(); return }
        const list = getAccess()?.workspaces ?? []
        const current = list.find(w => w.id === readActiveWorkspaceId())
        const next = current && canView(current) && !refusedWorkspaces.has(current.id)
            ? current
            : viewableWorkspaces(list).find(w => !refusedWorkspaces.has(w.id))
        if (!next) { goToAccountPage(); return }
        if (next.id !== readActiveWorkspaceId()) setActiveWorkspaceId(next.id)
        resumeSessionId = null
        resumeSecret = null
        socket?.connect()
    } finally {
        recovering = false
    }
}

export function getSocket(): Socket {
    if (!socket) {
        socket = io(getServerUrl(), {
            // Re-evaluated on every (re)connect, so a login or a new
            // session id is picked up without rebuilding the socket.
            auth: (cb: (data: object) => void) => {
                handshakeWorkspace = handshakeWorkspaceId()
                cb({
                    token: getToken() ?? '', resume_session: resumeSessionId, resume_secret: resumeSecret,
                    ...(handshakeWorkspace ? { workspace_id: handshakeWorkspace } : {}),
                })
            },
            transports: ['websocket'],
            reconnection: true,
            // Keep trying: the server holds the session for 90 s, and a
            // pilot's link must come back on its own, not after 10 tries.
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 3000,
            autoConnect: false,
        })
        socket.on('session_ready', (data: { session_id?: string; resume_secret?: string; workspace_id?: string }) => {
            if (data?.resume_secret) resumeSecret = data.resume_secret
            refusedWorkspaces.clear()
            // The server picked the default workspace (nothing was stored
            // yet): remember it, so the switcher shows where the session is.
            if (data?.workspace_id && isCustomer(getUser()) && data.workspace_id !== readActiveWorkspaceId()) {
                setActiveWorkspaceId(data.workspace_id)
            }
        })
        socket.on('connect_error', (err: Error) => {
            // The server refuses the handshake outright when the token is
            // missing, expired or revoked. Nothing will change by retrying;
            // go and sign in.
            if (err?.message === 'unauthorized') {
                socket?.disconnect()
                redirectToLogin()
                return
            }
            // Signed in, but not allowed into this workspace (or, from an
            // older server, no live access at all). A middleware refusal is
            // not retried by socket.io, so recovery reconnects by hand.
            if (err?.message === 'no_workspace_access') {
                socket?.disconnect()
                void recoverWorkspace(handshakeWorkspace)
                return
            }
            if (err?.message === 'no_live_access') {
                socket?.disconnect()
                goToAccountPage()
            }
        })
        // The server ends a customer's session that lost `view` (revalidation
        // every 60 s and on membership change). socket.io does not reconnect
        // after a server-side disconnect, so look again at what is viewable.
        socket.on('disconnect', (reason: string) => {
            if (reason === 'io server disconnect' && isCustomer(getUser())) void recoverWorkspace(null)
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

/**
 * Drop the current session and open a fresh one on the same socket object
 * (every listener stays attached). Used when the active workspace changes:
 * a session belongs to exactly one workspace, so it is not resumed.
 */
export function reconnectSocket(): void {
    resumeSessionId = null
    resumeSecret = null
    if (!socket) return
    socket.disconnect()
    socket.connect()
}

export function disconnectSocket(): void {
    resumeSessionId = null
    resumeSecret = null
    if (socket) {
        socket.disconnect()
        socket = null
    }
}
'use client'

// Tells the HYRAK ground decoder where to send the feeds.
//
// The decoder pushes video and MAVLink to ONE direct-UDP client, and it has
// to be told which machine that is. Left to itself it infers the answer from
// its own DHCP lease file — a safety net for clients that cannot speak up
// (VLC, a plain UDP consumer, a customer who just plugs a laptop in). We are
// not one of those, and inference has two failure modes we would inherit for
// no reason:
//
//   * A STATICALLY ADDRESSED PC never appears in the lease file at all, so
//     there is nothing to infer from.
//   * A STALE LEASE outlives the machine that held it. dnsmasq keeps leases
//     for 12 hours, so if this PC replaces another one the decoder keeps
//     aiming at the departed machine's address until the lease ages out —
//     a dead feed with nothing visibly wrong at either end.
//
// A registration is also a STRONGER claim than a lease: once we register, a
// lease renewal by some other machine cannot pull the stream away from us.
// That is the guarantee a primary ground station wants.
//
// The address is taken from the UDP source, so we never have to know or
// guess our own IP — a PC that has been given the wrong address in a settings
// box still gets the feeds. That is why the bare form is sent and never
// "HYRAK REGISTER <ip>", which exists for deliberately pointing the feeds at
// some other machine.
//
// Desktop only: this needs a raw UDP socket, which a browser tab cannot open.
// A browser session falls back to the decoder's lease-following, which is
// what that mechanism is for.

import { isDesktopApp, nativeBridge, type BridgeEvent } from '@/lib/nativeBridge'

/** The decoder's registration listener. Unauthenticated, and fine for the
 *  point-to-point cable it is designed for — anything that can reach this
 *  port can redirect the feeds, so it should not be exposed to a shared
 *  network without revisiting. */
export const HYRAK_REGISTER_PORT = 9000

const BRIDGE_ID = 'hyrak-register'

/** Re-register on a slow tick. The decoder has no keepalive requirement and
 *  never expires a client, so this is purely self-healing: if this PC's
 *  address changes, the next tick re-points both feeds with no user action.
 *  Re-registering the same address returns early on the decoder without
 *  restarting anything, so the repetition costs no stream churn. */
export const HYRAK_REGISTER_INTERVAL_MS = 10_000

export interface HyrakRegistration {
    state: 'ok' | 'idle' | 'error' | 'no-reply'
    /** Where the decoder says it is sending each feed — worth surfacing,
     *  because "registered fine, pointed somewhere else" is otherwise
     *  indistinguishable from "registered fine". */
    video?: string
    mavlink?: string
    rtsp?: string
    reason?: string
    at: number
}

/** Parses the decoder's one-line reply.
 *
 *  Kept pure and exported so the three reply shapes can be exercised without
 *  a desktop app, a socket or a decoder.
 */
export function parseRegistrationReply(line: string): HyrakRegistration {
    const at = Date.now()
    const text = (line || '').trim()
    if (/^HYRAK\s+OK\b/i.test(text)) {
        const field = (name: string) =>
            new RegExp(`\\b${name}=(\\S+)`, 'i').exec(text)?.[1]
        return {
            state: 'ok', at,
            video: field('video'),
            mavlink: field('mavlink'),
            rtsp: field('rtsp'),
        }
    }
    if (/^HYRAK\s+IDLE\b/i.test(text)) return { state: 'idle', at }
    if (/^HYRAK\s+ERR\b/i.test(text)) {
        return { state: 'error', at, reason: text.replace(/^HYRAK\s+ERR\s*/i, '').trim() || 'unspecified' }
    }
    // Anything else is not this protocol. Reporting it as an error rather
    // than guessing keeps a wrong-port reply from looking like success.
    return { state: 'error', at, reason: text ? `unrecognised reply: ${text.slice(0, 120)}` : 'empty reply' }
}

// WHO STILL WANTS THE DECODER POINTED HERE. Video and telemetry are started
// and stopped independently, and both need this. Without counting owners,
// releasing the telemetry link would stop the re-registration tick that video
// is relying on — and the loss is invisible, because stopping does not
// un-register anything: the decoder never expires a client, so the feeds keep
// flowing and only the self-healing goes away. It would be missed until the
// PC's address changed weeks later.
const owners = new Set<string>()

let active = false
let currentHost: string | null = null
let timer: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let last: HyrakRegistration | null = null
const listeners = new Set<(r: HyrakRegistration) => void>()

export const isHyrakRegistrationActive = () => active
export const getHyrakRegistration = () => last

export function onHyrakRegistration(cb: (r: HyrakRegistration) => void): () => void {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
}

function publish(r: HyrakRegistration) {
    last = r
    for (const cb of listeners) {
        try { cb(r) } catch { /* a listener must not break the tick */ }
    }
}

function sendLine(line: string) {
    nativeBridge()?.send('udp', BRIDGE_ID, new TextEncoder().encode(line))
}

function sendRegister() {
    // The BARE form. The decoder reads the address off the UDP source, so
    // this works even when our own idea of our address is wrong.
    sendLine('HYRAK REGISTER')
}

/** Hands the feeds back to whoever should have them next.
 *
 *  A REGISTRATION OUTLIVES THE PROCESS THAT MADE IT, which is the point —
 *  it is a strong claim, and a strong claim is what stops another machine's
 *  DHCP lease pulling the stream away mid-flight. The cost is symmetrical
 *  and only shows up after we are gone: nothing expires the claim (the
 *  decoder's CLIENT_TIMEOUT is 0), so the feeds stay pinned to this PC's
 *  address forever, and a later lease-following client on another machine
 *  can never take over, because weak never overrides strong.
 *
 *  So the claim has to be released deliberately. This is best-effort by
 *  nature — a crash or a pulled cable releases nothing, and no amount of
 *  client code fixes that — but a clean shutdown is the common case and
 *  costs one datagram.
 */
function sendUnregister() {
    sendLine('HYRAK UNREGISTER')
}

/** Starts registering with the decoder at `host`, and keeps doing so.
 *
 *  Safe to call from more than one place — video and telemetry both want the
 *  decoder pointed here, and registering twice is not different from
 *  registering once. Calling with a DIFFERENT host re-targets.
 */
export async function startHyrakRegistration(host: string, owner = 'default'): Promise<void> {
    const target = (host || '').trim()
    if (!target) return
    if (!isDesktopApp()) return          // browser: lease-following covers it
    owners.add(owner)
    if (active && currentHost === target) return
    // Re-targeting to a different host must tear the socket down FIRST, and
    // must not go through stopHyrakRegistration() — that one honours the
    // owner count, which we just incremented, so it would return early and
    // leave the old socket pointed at the old decoder.
    if (active) await teardown()

    const bridge = nativeBridge()
    if (!bridge) return

    const result = await bridge.start('udp', BRIDGE_ID, {
        // Port 0: an OS-chosen local port. We only ever speak first here, so
        // there is nothing that needs to find us on a known port.
        ports: [{ tag: 0, port: 0, remoteHost: target, remotePort: HYRAK_REGISTER_PORT, pinRemote: true }],
    })
    if (result && !result.ok) {
        publish({ state: 'error', at: Date.now(), reason: result.error || 'could not open a socket' })
        return
    }
    active = true
    currentHost = target

    unsubscribe = bridge.onEvent((event: BridgeEvent) => {
        if (event.bridge !== 'udp' || event.id !== BRIDGE_ID) return
        if (event.type !== 'data' || !event.data) return
        publish(parseRegistrationReply(new TextDecoder().decode(event.data)))
    })

    attachUnloadHook()
    sendRegister()
    timer = setInterval(sendRegister, HYRAK_REGISTER_INTERVAL_MS)
}

async function teardown(): Promise<void> {
    if (!active && !timer) return
    active = false
    currentHost = null
    if (timer) { clearInterval(timer); timer = null }
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    detachUnloadHook()
    sendUnregister()
    // Let the datagram actually leave before the socket closes under it.
    // dgram.send is asynchronous, so closing in the same tick can discard a
    // queued packet — and the packet whose whole job is to release the claim
    // is the worst one to lose.
    await new Promise(r => setTimeout(r, 50))
    try { await nativeBridge()?.stop('udp', BRIDGE_ID) } catch { /* already gone */ }
}

// THE CASE THAT ACTUALLY MATTERS is not a tidy stop() call — it is the app
// being closed, which is exactly when the claim would otherwise be stranded.
// pagehide fires on close and on navigation away, including the cases
// beforeunload misses on some platforms; both are registered because neither
// is reliable alone. Nothing can be awaited here, so this is one fire-and-
// forget datagram and no cleanup.
let unloadHook: (() => void) | null = null

function attachUnloadHook() {
    if (unloadHook || typeof window === 'undefined') return
    unloadHook = () => { if (active) sendUnregister() }
    window.addEventListener('pagehide', unloadHook)
    window.addEventListener('beforeunload', unloadHook)
}

function detachUnloadHook() {
    if (!unloadHook || typeof window === 'undefined') return
    window.removeEventListener('pagehide', unloadHook)
    window.removeEventListener('beforeunload', unloadHook)
    unloadHook = null
}

export async function stopHyrakRegistration(owner = 'default'): Promise<void> {
    owners.delete(owner)
    if (owners.size > 0) return          // someone else still needs the feeds here
    await teardown()
}

// Reachability pre-check for the drone hardware, surfaced in Settings.
//
// The question this answers — "can this machine actually reach the camera and
// the ground unit right now?" — is the one that would have short-circuited most
// of an evening's debugging. A laptop roamed across seven WiFi networks in one
// session, and each time it left the ground unit's network both video and
// telemetry failed with errors describing the symptom rather than the cause.
//
// Reports the SUBNET rather than the SSID on purpose. The SSID was actively
// misleading: a bridging ground unit hands out addresses from the phone it is
// uplinked to, so "connected to SIYI" was true while the camera sat on a
// different subnet entirely. What decides reachability is whether the target
// shares a subnet with one of this machine's own addresses.

import { isDesktopApp, nativeBridge } from '@/lib/nativeBridge'
import { getSiyiRtspUrl, getAirUnitVideoPort } from '@/lib/videoSource'
import { getSiyiTelemetryTarget } from '@/lib/siyiTelemetryRelay'

export interface ProbeResult {
    label: string
    host: string
    port: number
    kind: 'tcp' | 'udp'
    ok: boolean
    ms: number
    onLink: boolean
    error?: string
}

export interface ProbeReport {
    addresses: { iface: string; address: string; cidr: string }[]
    results: ProbeResult[]
    error?: string
}

/** Pulls host:port out of an rtsp:// URL. Returns null rather than guessing, so
 *  a malformed URL is reported as such instead of probing the wrong thing. */
function parseRtsp(url: string): { host: string; port: number } | null {
    const m = url.trim().match(/^rtsps?:\/\/(?:[^@/]*@)?\[?([^\]/:]+)\]?(?::(\d{1,5}))?/i)
    if (!m) return null
    return { host: m[1], port: m[2] ? Number(m[2]) : 554 }
}

function parseHostPort(target: string): { host: string; port: number } | null {
    const m = target.trim().match(/^\[?([^\]]+?)\]?:(\d{1,5})$/)
    if (!m) return null
    return { host: m[1], port: Number(m[2]) }
}

/** Probes whatever the current settings point at. Empty result list when the
 *  settings are unusable, so the UI can say "nothing to check". */
export async function probeDroneNetwork(): Promise<ProbeReport> {
    if (!isDesktopApp()) {
        return {
            addresses: [],
            results: [],
            error: 'Reachability checks need the HYRAK desktop app — a browser tab cannot open a socket.',
        }
    }
    const probe = nativeBridge()?.probeNetwork
    if (!probe) {
        return { addresses: [], results: [], error: 'This desktop build has no network probe. Update the app.' }
    }

    const targets: { label: string; host: string; port: number; kind: 'tcp' | 'udp' }[] = []

    const cam = parseRtsp(getSiyiRtspUrl())
    if (cam) targets.push({ label: 'Camera (RTSP)', host: cam.host, port: cam.port, kind: 'tcp' })

    const tel = parseHostPort(getSiyiTelemetryTarget())
    if (tel) targets.push({ label: 'Ground unit (telemetry)', host: tel.host, port: tel.port, kind: 'udp' })

    if (targets.length === 0) {
        return { addresses: [], results: [], error: 'No usable camera URL or telemetry target configured.' }
    }

    try {
        return await probe(targets) as ProbeReport
    } catch (e) {
        return { addresses: [], results: [], error: (e as Error).message }
    }
}

/** One-line human summary. Says what is WRONG and what to do, not just a state:
 *  "unreachable" alone is what we already had, and it was not enough. */
export function explainResult(r: ProbeResult, addresses: ProbeReport['addresses']): string {
    if (r.ok) {
        return r.onLink
            ? `reachable in ${r.ms}ms, on your subnet — this is the reliable case`
            : `reachable in ${r.ms}ms, but ROUTED via a gateway — depends on another `
              + 'device forwarding, which is what breaks intermittently'
    }
    if (!r.onLink) {
        const mine = addresses.map(a => a.cidr).join(', ') || 'none'
        return `unreachable, and NOT on your subnet (you have ${mine}). Either join the `
            + `network ${r.host} is on, or add a route to it.`
    }
    return `on your subnet but not answering (${r.error ?? 'no response'}) — powered off, `
        + 'or a different address than configured.'
}

/** Also expose it on the console, alongside __hyrakLiveEdge/__hyrakRtspPath. */
if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__hyrakNetCheck = probeDroneNetwork
}

// Referenced so the air-unit port stays part of this module's contract even
// though the air unit is probed by presence of RTP rather than a handshake.
export const AIR_UNIT_PORT_HINT = () => getAirUnitVideoPort()

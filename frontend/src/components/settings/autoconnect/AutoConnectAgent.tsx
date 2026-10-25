'use client'

// Mounted once in the platform layout. Turns "a vehicle appeared" into the
// same connect the operator would have clicked, and shows a small toast.
//
// Desktop: the main process reports vehicles (lib/autoConnect.ts explains the
// split). Browser: re-opens Web Serial ports this browser was granted before.
// Both obey the same two rules: never while the session has a link, and never
// a port that was present when a link ended (until it is replugged).

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useDrone, disconnectTelemetryLink } from '@/hooks/useDrone'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { useLiveScope } from '@/hooks/useLiveScope'
import { isDesktopApp, nativeAutoConnect } from '@/lib/nativeBridge'
import { listNativeSerialPorts } from '@/lib/nativeSerialRelay'
import { getSerialApi, listGrantedPorts, type SerialPortLike } from '@/lib/browserSerial'
import { getTelemetrySource, setTelemetrySource } from '@/lib/linkSettings'
import { UDP_14550_LINK } from '@/hooks/useTelemetryLink'
import {
    classifyWebSerial, loadAutoConnectConfig, probeWebSerial, useAutoConnectStore,
    type AutoConnectEvent, type AutoToast,
} from '@/lib/autoConnect'
import { toastStyle, toneColor, TOAST_IN, TOAST_OUT, usePresence } from '@/components/notifications/toast'

const TOAST_MS = 9000

/** Settings opens on the Comm links tab, where the auto-connect switches live. */
export function openLinkSettings(router: { push: (href: string) => void }) {
    try { localStorage.setItem('hyrak-settings-tab', JSON.stringify('links')) } catch { /* private window */ }
    router.push('/settings')
}

export function AutoConnectAgent() {
    const { connectNativeSerial, connectBrowserSerial, connectRemoteSitl, connectNativeRf } = useDrone()
    const telemetryStatus = useDroneStore(s => s.telemetryStatus)
    const connectionStatus = useDroneStore(s => s.connectionStatus)
    const hasSession = useDroneStore(s => !!s.session)
    const swarmOn = useSwarmStore(s => s.enabled)
    const { viewOnly, customer } = useLiveScope()
    const config = useAutoConnectStore(s => s.config)
    const loaded = useAutoConnectStore(s => s.loaded)

    const linkActive = telemetryStatus === 'connected' || telemetryStatus === 'connecting' || swarmOn
    const ready = loaded && connectionStatus === 'connected' && hasSession && !viewOnly

    // Live values for the event handlers, which are registered once.
    const live = useRef({ ready, linkActive, customer, config })
    useEffect(() => { live.current = { ready, linkActive, customer, config } }, [ready, linkActive, customer, config])
    const fns = useRef({ connectNativeSerial, connectBrowserSerial, connectRemoteSitl, connectNativeRf })
    useEffect(() => { fns.current = { connectNativeSerial, connectBrowserSerial, connectRemoteSitl, connectNativeRf } })

    useEffect(() => { void loadAutoConnectConfig() }, [])

    const desktop = isDesktopApp()

    // ---- tell the desktop detector when it may act
    useEffect(() => {
        if (!desktop) return
        nativeAutoConnect()?.gate({ ready, linkActive })
    }, [desktop, ready, linkActive])

    // ---- a link ended: leave every present port alone until replugged
    const prevActive = useRef(linkActive)
    const browserSuppressed = useRef(new Set<SerialPortLike>())
    useEffect(() => {
        const was = prevActive.current
        prevActive.current = linkActive
        if (!was || linkActive) return
        if (desktop) {
            nativeAutoConnect()?.suppress()
        } else {
            void listGrantedPorts().then(list => { for (const r of list) browserSuppressed.current.add(r.port) })
        }
    }, [linkActive, desktop])

    // ---- desktop: act on the detector's reports
    useEffect(() => {
        if (!desktop) return
        const api = nativeAutoConnect()
        if (!api) return
        return api.onEvent((raw) => {
            const e = raw as AutoConnectEvent
            const store = useAutoConnectStore.getState()
            if (e.type === 'ports') { useAutoConnectStore.setState({ ports: e.ports }); return }
            if (e.type === 'status') { useAutoConnectStore.setState({ status: e }); return }
            if (e.type !== 'vehicle') return
            const st = useDroneStore.getState()
            const busy = st.telemetryStatus === 'connected' || st.telemetryStatus === 'connecting'
            if (!live.current.ready || busy || !live.current.config.enabled) {
                api.release(e.key)
                return
            }
            if (e.link === 'serial') {
                void (async () => {
                    const list = await listNativeSerialPorts()
                    const idx = list.findIndex(r => r.path === e.path)
                    if (idx >= 0) setTelemetrySource(`nradio-${idx}`)
                    await fns.current.connectNativeSerial(e.path, e.baud)
                    const what = `${e.vehicle} on ${e.name} (${e.path})`
                    useAutoConnectStore.setState({ last: { at: Date.now(), what } })
                    store.setToast({ tone: 'ok', title: 'Vehicle connected automatically', body: what, action: 'disconnect' })
                })()
                return
            }
            // UDP
            if (e.systems.length > 1) {
                const list = e.systems.map(s => `system ${s.sysid}`).join(', ')
                store.setToast(live.current.customer ? {
                    tone: 'info', title: `${e.systems.length} vehicles on UDP ${e.port}`,
                    body: `Heard ${list}. Several vehicles share this port, so none was connected automatically. Pick one from the Link card.`,
                } : {
                    tone: 'info', title: `${e.systems.length} vehicles on UDP ${e.port}`,
                    body: `Heard ${list}. Open the fleet view to scan and fly them together.`,
                    action: 'fleet',
                })
                return
            }
            const one = e.systems[0]
            // An operator who flies through a HYRAK air unit (wfb-ng) gets
            // that link: its uplink is a separate port, which the plain relay
            // would never reach.
            if (getTelemetrySource() === 'air-unit-udp' && e.port === 14550) {
                void fns.current.connectNativeRf()
            } else {
                setTelemetrySource(UDP_14550_LINK)
                void fns.current.connectRemoteSitl(e.port)
            }
            const what = `${one.vehicle} on UDP ${e.port} (from ${one.from})`
            useAutoConnectStore.setState({ last: { at: Date.now(), what } })
            store.setToast({ tone: 'ok', title: 'Vehicle connected automatically', body: what, action: 'disconnect' })
        })
    }, [desktop])

    // ---- browser: reopen granted ports
    const probing = useRef(false)
    useEffect(() => {
        if (desktop) return
        const api = getSerialApi()
        if (!api) return
        const attempt = async () => {
            const { ready: r, linkActive: busy, config: c } = live.current
            if (!r || busy || !c.enabled || probing.current) return
            probing.current = true
            try {
                const granted = await listGrantedPorts()
                for (let i = 0; i < granted.length; i++) {
                    const g = granted[i]
                    if (browserSuppressed.current.has(g.port)) continue
                    const { cls, baud } = classifyWebSerial(g.port)
                    if ((cls === 'fc' && !c.usb) || (cls === 'sik' && !c.sik) || cls === 'other') continue
                    const found = await probeWebSerial(g.port, baud)
                    // Re-check: the operator may have connected meanwhile.
                    const st = useDroneStore.getState().telemetryStatus
                    if (st === 'connected' || st === 'connecting' || !live.current.config.enabled) return
                    if (!found) continue
                    browserSuppressed.current.add(g.port)
                    setTelemetrySource(`radio-${i}`)
                    await fns.current.connectBrowserSerial(g.port, baud)
                    const what = `${g.label} (a USB device this browser was allowed to use before)`
                    useAutoConnectStore.setState({ last: { at: Date.now(), what } })
                    useAutoConnectStore.getState().setToast({ tone: 'ok', title: 'Vehicle connected automatically', body: what, action: 'disconnect' })
                    return
                }
            } finally {
                probing.current = false
            }
        }
        const onConnect = () => { void attempt() }
        const onDisconnect = (ev: Event) => {
            // Unplugged: the next plug-in of this device is fair game again.
            const port = (ev.target ?? null) as SerialPortLike | null
            if (port) browserSuppressed.current.delete(port)
        }
        api.addEventListener?.('connect', onConnect)
        api.addEventListener?.('disconnect', onDisconnect as () => void)
        const timer = setInterval(() => { void attempt() }, 8000)
        void attempt()
        return () => {
            api.removeEventListener?.('connect', onConnect)
            api.removeEventListener?.('disconnect', onDisconnect as () => void)
            clearInterval(timer)
        }
    }, [desktop])

    return <AutoConnectToast />
}

function AutoConnectToast() {
    const toast = useAutoConnectStore(s => s.toast)
    const setToast = useAutoConnectStore(s => s.setToast)
    const { shown, leaving } = usePresence<AutoToast>(toast)
    const router = useRouter()

    useEffect(() => {
        if (!toast) return
        const id = setTimeout(() => setToast(null), TOAST_MS)
        return () => clearTimeout(id)
    }, [toast, setToast])

    if (!shown) return null
    const tone = shown.tone
    const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? TriangleAlert : Info
    const btn = 'min-h-8 rounded-md px-3 text-[13px] font-semibold transition-colors duration-[140ms] hover:bg-app-surface-2 border border-app-border-strong text-app-text'
    return (
        <div aria-label="Auto-connect"
            className="pointer-events-none fixed bottom-4 right-4 z-[2900] w-[min(380px,calc(100vw-32px))]">
            <div role="status"
                className={'pointer-events-auto flex flex-col gap-2 rounded-[10px] px-3.5 py-3 text-[13px] ' + (leaving ? TOAST_OUT : TOAST_IN)}
                style={toastStyle(tone === 'ok' ? 'ok' : tone)}>
                <div className="flex items-start gap-2.5">
                    <Icon size={18} className="mt-0.5 shrink-0" style={{ color: toneColor(tone === 'ok' ? 'ok' : tone) }} aria-hidden />
                    <div className="min-w-0 flex-1">
                        <div className="font-bold leading-snug">{shown.title}</div>
                        <div className="mt-0.5 leading-relaxed text-app-text-muted break-words">{shown.body}</div>
                    </div>
                    <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" title="Dismiss"
                        className="-my-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-app-text-muted transition-colors duration-[140ms] hover:bg-app-surface-2 hover:text-app-text">
                        <X size={16} aria-hidden />
                    </button>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    {shown.action === 'disconnect' && (
                        <button type="button" className={btn} onClick={() => { setToast(null); void disconnectTelemetryLink() }}>Disconnect</button>
                    )}
                    {shown.action === 'fleet' && (
                        <button type="button" className={btn} onClick={() => { setToast(null); useSwarmStore.getState().setEnabled(true) }}>Open fleet view</button>
                    )}
                    <button type="button" className={btn} onClick={() => { setToast(null); openLinkSettings(router) }}>Auto-connect settings</button>
                </div>
            </div>
        </div>
    )
}

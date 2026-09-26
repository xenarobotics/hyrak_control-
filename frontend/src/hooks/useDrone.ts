'use client'

import { useEffect, useCallback } from 'react'
import { getSocket, connectSocket, setResumeSession } from '@/lib/socket'
import { setCloudUp } from '@/lib/localLink'
import { startBrowserSerial, stopBrowserSerial, isBrowserSerialActive, type SerialPortLike } from '@/lib/browserSerial'
import { startLocalRelay, stopLocalRelay, isLocalRelayActive } from '@/lib/localRfRelay'
import { startRemoteSitlRelay, stopRemoteSitlRelay, isRemoteSitlRelayActive, setSitlSilenceHandler } from '@/lib/remoteSitlRelay'
import { startNativeSerial, stopNativeSerial, isNativeSerialActive, setSerialSilenceHandler, DEFAULT_SERIAL_BAUD } from '@/lib/nativeSerialRelay'
import { startNativeRfRelay, stopNativeRfRelay, isNativeRfRelayActive, setRfSilenceHandler } from '@/lib/nativeRfRelay'
import { stopSiyiTelemetry, isSiyiTelemetryActive } from '@/lib/siyiTelemetryRelay'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { colorForDrone, FLEET_SCAN_COUNT } from '@/lib/fleet'
import type { TelemetrySnapshot } from '@/types/telemetry'
import type { SessionInfo } from '@/types/session'
import type { CVResult } from '@/types/vision'

// Slightly past the server's SESSION_GRACE_S (90 s): after this the session is gone anyway.
const RESUME_GIVE_UP_MS = 95_000

/** How long a command may sit unanswered before the UI stops claiming it is
 *  in flight. Generous: a takeoff over a slow radio legitimately takes several
 *  seconds to acknowledge, and cutting the spinner short would put the button
 *  back to its idle look while the command is still very much alive. */
const ACTION_PENDING_TIMEOUT_MS = 8000

export function useDrone() {
    const store = useDroneStore()

    useEffect(() => {
        const socket = getSocket()
        if (!socket.connected && !socket.active) {
            store.setConnectionStatus('connecting')
            connectSocket()
        }

        // Named handler refs - .off(fn) removes ONLY this handler,
        // not all handlers for the event (which happens with bare .off('event')).
        // Critical: multiple components call useDrone(); without named refs,
        // one component's cleanup nukes every other component's listeners.
        const onConnect        = () => { setCloudUp(true); store.setConnectionStatus('connected') }
        // A dropped socket is NOT a lost session: the server holds the session,
        // its drone link and our radio relay for SESSION_GRACE_S and hands it
        // back when we reconnect. Tear down locally only if that fails.
        let giveUpTimer: ReturnType<typeof setTimeout> | null = null
        const fullReset = () => {
            if (giveUpTimer) { clearTimeout(giveUpTimer); giveUpTimer = null }
            setResumeSession(null)
            store.setConnectionStatus('disconnected')
            store.setTelemetryStatus('disconnected')
            store.reset()
            void stopBrowserSerial()
        }
        const onDisconnect     = (reason?: string) => {
            // The local link fallback takes over the radio/SITL link now (it
            // keeps a ground-station heartbeat going and offers HOLD/RTL/LAND).
            setCloudUp(false)
            // Our own disconnect (logout, page teardown): nothing to hold.
            if (reason === 'io client disconnect' || !useDroneStore.getState().session) {
                fullReset()
                return
            }
            store.setConnectionStatus('reconnecting')
            if (giveUpTimer) clearTimeout(giveUpTimer)
            giveUpTimer = setTimeout(fullReset, RESUME_GIVE_UP_MS)
        }
        const onConnectError   = () => store.setConnectionStatus('error')
        const onSessionReady = (data: SessionInfo) => {
            if (giveUpTimer) { clearTimeout(giveUpTimer); giveUpTimer = null }
            if (data.resumed) {
                // Same session, same drone link: keep everything as it is.
                store.setSession(data)
                store.setConnectionStatus('connected')
                console.info(`[socket] session resumed after ${data.away_s ?? '?'}s away`)
                window.dispatchEvent(new Event('hyrak-session-resumed'))   // video restarts itself
                return
            }
            if (useDroneStore.getState().session && useDroneStore.getState().session?.session_id !== data.session_id) {
                // The server could not give our session back (expired or restarted):
                // everything held locally belongs to a session that no longer exists.
                store.setTelemetryStatus('disconnected')
                store.reset()
                void stopBrowserSerial()
            }
            setResumeSession(data.session_id)
            store.setSession(data)
            // If swarm mode was enabled before this page load/reconnect, clear stale
            // drone entries and re-scan so the fleet repopulates automatically.
            const swarm = useSwarmStore.getState()
            if (swarm.enabled) {
                swarm.clearFleet()
                getSocket().emit('scan_swarm_drones', { count: FLEET_SCAN_COUNT })
            }
        }
        const onTelStatus      = (data: { status: string; message?: string }) => {
            store.setTelemetryStatus(data.status as any)
            if (data.status === 'error') {
                store.setTelemetryError(data.message || 'Connection failed')
            }
            // Link gone (disconnect, takeover, failed connect) → release the
            // local radio so the user can reconnect cleanly. No-op otherwise.
            if (data.status === 'disconnected' || data.status === 'error') {
                void stopBrowserSerial()
            }
        }

        // The backend's generic `error` event had NO listener at all, so every
        // path that reports failure that way instead of via telemetry_status
        // (e.g. connect_browser_serial's "No session found") left the UI stuck
        // on "connecting" forever with nothing to show - the connect flow can
        // only ever be un-stuck by a telemetry_status event. Treat it as a
        // failed connect whenever a connect is what we were waiting on.
        const onServerError = (data: { msg?: string }) => {
            console.error('Server error', data?.msg)
            if (useDroneStore.getState().telemetryStatus === 'connecting') {
                store.setTelemetryError(data?.msg || 'Connection failed')
                store.setTelemetryStatus('error')
                void stopBrowserSerial()
            }
        }

        // Primary drone telemetry - suppressed when a fleet drone has focus so
        // the OSD/HUD always shows the actively controlled vehicle's data.
        const onTelUpdate = (data: TelemetrySnapshot) => {
            const { enabled, activeDroneId } = useSwarmStore.getState()
            if (enabled && activeDroneId !== null) return
            store.setTelemetry(data)
        }

        const onCvResults      = (data: CVResult) => store.setCvResults(data)
        const onModeChanged    = (data: { mode: string }) => store.setMode(data.mode as any)
        const onModelStatus    = (data: { status: string; mode: string }) =>
            store.setModelLoading(data.status === 'loading')
        const onTrackingStatus = (_data: { active: boolean }) => { /* handled in panel */ }
        const onMissionUpload  = (data: { ok: boolean; count?: number; terrain_follow?: boolean; msg: string }) =>
            store.setMissionUploadResult(data)
        // Swarm mission upload result - mirror to primary store so the mission
        // page's upload indicator, orange-ack dialog and red/permit flow all
        // work for fleet drones exactly like the primary drone.
        const onSwarmMissionUpload = (data: {
            drone_id: number; ok: boolean; count?: number; msg: string
            needs_ack?: boolean; blocked?: 'red'; can_request?: boolean
            zones?: { id: string; name: string; zone_class: string }[]
        }) => {
            const { activeDroneId } = useSwarmStore.getState()
            if (data.drone_id === activeDroneId) {
                store.setMissionUploadResult({
                    ok: data.ok, count: data.count, msg: data.msg,
                    needs_ack: data.needs_ack, blocked: data.blocked,
                    can_request: data.can_request, zones: data.zones,
                })
            }
        }
        const onActionResult   = (data: { action: string; ok: boolean; msg?: string; error?: string }) =>
            store.setLastActionResult(data)
        const onDroneMission   = (data: { waypoints: any[] }) =>
            store.setDroneMissionOffer(data.waypoints)
        const onFcMessage      = (data: { severity: string; text: string; rank: number; ts: number }) =>
            store.addFcMessage(data)

        // Fleet drone telemetry - updates swarm store and also mirrors to the
        // primary store when this drone is the actively selected one.
        // We also mirror telemetryStatus → 'connected' so every connection-gated
        // UI element (ARM button, Upload button, mission controls) enables itself
        // for fleet drones exactly as it does for the primary drone.
        const onDroneTelemetry = (data: { drone_id: number } & TelemetrySnapshot) => {
            const { drone_id, ...snapshot } = data
            const swarm = useSwarmStore.getState()
            swarm.updateDroneTelemetry(drone_id, snapshot as TelemetrySnapshot)
            if (swarm.enabled && drone_id === swarm.activeDroneId) {
                store.setTelemetry(snapshot as TelemetrySnapshot)
                // Open every connection gate in the UI for this fleet drone
                const { telemetryStatus } = useDroneStore.getState()
                if (telemetryStatus !== 'connected') {
                    store.setTelemetryStatus('connected')
                }
            }
        }

        // Batched fleet telemetry - one event carries the latest snapshot for
        // every fleet drone. Single store update, then mirror the actively
        // controlled drone into the primary store (OSD/HUD/connection gates).
        const onFleetTelemetry = (data: { drones: Record<string, TelemetrySnapshot> }) => {
            const swarm = useSwarmStore.getState()
            // In-flight packets can arrive just after the user disables swarm
            // mode - applying them would resurrect the cleared drone list.
            if (!swarm.enabled) return
            swarm.updateFleetTelemetry(data.drones)
            const active = swarm.activeDroneId
            const snapshot = active !== null ? data.drones[String(active)] : undefined
            if (swarm.enabled && snapshot) {
                store.setTelemetry(snapshot)
                if (useDroneStore.getState().telemetryStatus !== 'connected') {
                    store.setTelemetryStatus('connected')
                }
            }
        }

        // Group command result - stash in the swarm store for FleetAside feedback
        const onSwarmGroupResult = (data: {
            action: string; ok_count: number; total: number
            results: Array<{ drone_id: number; ok: boolean; msg?: string }>
        }) => {
            useSwarmStore.getState().setGroupResult({
                action: data.action, okCount: data.ok_count, total: data.total, at: Date.now(),
            })
        }

        // Supervisor alerts - into the swarm store for the fleet panels
        const onFleetAlert = (data: {
            drone_id: number; kind: string
            severity: 'info' | 'warn' | 'critical'; msg: string; at: number
        }) => {
            useSwarmStore.getState().pushAlert({
                droneId: data.drone_id, kind: data.kind,
                severity: data.severity, msg: data.msg, at: data.at,
            })
        }

        const onSwarmDroneStatus = (data: {
            drone_id: number; connected: boolean; name?: string; color?: string
        }) => {
            useSwarmStore.getState().setDroneConnected(
                data.drone_id, data.connected, data.name, data.color
            )
        }

        // Swarm action result - route to primary store so DroneControls sees it
        const onSwarmActionResult = (data: { drone_id: number; action: string; ok: boolean }) => {
            const { activeDroneId } = useSwarmStore.getState()
            if (data.drone_id === activeDroneId) {
                store.setLastActionResult({ action: data.action, ok: data.ok })
            }
        }

        // Auto-scan results - populate store so FleetAside shows drones before
        // the individual swarm_drone_status events arrive.
        const onSwarmScanStarted = (_data: { ports: number[] }) => {
            useSwarmStore.getState().setScanStatus('scanning')
        }

        const onSwarmScanResult = (data: {
            drones: Array<{ port: number; drone_id: number; name: string; color: string }>
            found: number
        }) => {
            const swarm = useSwarmStore.getState()
            swarm.setScanStatus('done')
            data.drones.forEach((d) => {
                swarm.addDrone(d.drone_id, d.name, d.color ?? colorForDrone(d.drone_id))
            })
        }

        // Sync primary telemetry store whenever the selected fleet drone changes.
        // Without this, switching from Drone A → Drone B keeps showing A's stale
        // telemetry (e.g. is_armed=true) until the next packet arrives from B,
        // which misleads the ARM button and blocks takeoff.
        const swarmSub = useSwarmStore.subscribe((state, prev) => {
            if (prev.activeDroneId === state.activeDroneId) return

            if (state.activeDroneId === null) {
                // Deselected - gates should close
                useDroneStore.getState().setTelemetryStatus('disconnected')
                return
            }

            // Switched to a different drone: immediately push its stored telemetry
            // so the UI reflects the new drone's actual state rather than stale values.
            const newDrone = state.drones[state.activeDroneId]
            if (newDrone?.telemetry) {
                useDroneStore.getState().setTelemetry(newDrone.telemetry)
            } else {
                // No telemetry received yet - clear stale values
                useDroneStore.setState({ telemetry: null })
            }
            if (newDrone?.connected) {
                useDroneStore.getState().setTelemetryStatus('connected')
            }
        })

        socket.on('connect',               onConnect)
        socket.on('disconnect',            onDisconnect)
        socket.on('connect_error',         onConnectError)
        socket.on('session_ready',         onSessionReady)
        socket.on('error',                 onServerError)
        socket.on('telemetry_status',      onTelStatus)
        socket.on('telemetry_update',      onTelUpdate)
        socket.on('cv_results',            onCvResults)
        socket.on('mode_changed',          onModeChanged)
        socket.on('model_status',          onModelStatus)
        socket.on('tracking_status',       onTrackingStatus)
        socket.on('mission_upload_result',       onMissionUpload)
        socket.on('swarm_mission_upload_result', onSwarmMissionUpload)
        socket.on('action_result',         onActionResult)
        socket.on('drone_mission_loaded',  onDroneMission)
        socket.on('fc_message',            onFcMessage)
        socket.on('drone_telemetry',       onDroneTelemetry)
        socket.on('fleet_telemetry',       onFleetTelemetry)
        socket.on('swarm_drone_status',    onSwarmDroneStatus)
        socket.on('fleet_alert',           onFleetAlert)
        socket.on('swarm_action_result',   onSwarmActionResult)
        socket.on('swarm_group_result',    onSwarmGroupResult)
        socket.on('swarm_scan_started',    onSwarmScanStarted)
        socket.on('swarm_scan_result',     onSwarmScanResult)

        return () => {
            socket.off('connect',               onConnect)
            socket.off('disconnect',            onDisconnect)
            socket.off('connect_error',         onConnectError)
            socket.off('session_ready',         onSessionReady)
            socket.off('error',                 onServerError)
            socket.off('telemetry_status',      onTelStatus)
            socket.off('telemetry_update',      onTelUpdate)
            socket.off('cv_results',            onCvResults)
            socket.off('mode_changed',          onModeChanged)
            socket.off('model_status',          onModelStatus)
            socket.off('tracking_status',       onTrackingStatus)
            socket.off('mission_upload_result',       onMissionUpload)
            socket.off('swarm_mission_upload_result', onSwarmMissionUpload)
            socket.off('action_result',         onActionResult)
            socket.off('drone_mission_loaded',  onDroneMission)
            socket.off('fc_message',            onFcMessage)
            socket.off('drone_telemetry',       onDroneTelemetry)
            socket.off('fleet_telemetry',       onFleetTelemetry)
            socket.off('swarm_drone_status',    onSwarmDroneStatus)
            socket.off('fleet_alert',           onFleetAlert)
            socket.off('swarm_action_result',   onSwarmActionResult)
            socket.off('swarm_group_result',    onSwarmGroupResult)
            socket.off('swarm_scan_started',    onSwarmScanStarted)
            socket.off('swarm_scan_result',     onSwarmScanResult)
            swarmSub()
            // DO NOT call disconnectSocket() here - socket lives for app lifetime
        }
    }, [])

    const connectTelemetry = useCallback((address: string) => {
        store.setTelemetryStatus('connecting')
        getSocket().emit('connect_telemetry', { address })
    }, [])

    /** Tears the link down from this end.
     *
     *  The backend has handled `disconnect_telemetry` all along
     *  (events/telemetry_events.py) - it ends the flight recording, drops zone
     *  monitoring and clears the session's drone - but nothing in the UI ever
     *  emitted it, and TelemetryConnect hid its whole control block once
     *  connected. So a link could be established and then never released
     *  without reloading the page or restarting the backend.
     *
     *  Stops the LOCAL relay first. Every connect path other than a plain
     *  server-side UDP address is really "this device owns the radio and
     *  forwards MAVLink" - browser Web Serial, native serial, native RF - and
     *  those keep pumping regardless of what the server thinks. Telling the
     *  server to forget the link while a relay is still feeding it would have
     *  it immediately re-establish from the incoming traffic. */
    const disconnectTelemetry = useCallback(async () => {
        try {
            if (isBrowserSerialActive()) await stopBrowserSerial()
            if (isNativeSerialActive()) await stopNativeSerial()
            if (isNativeRfRelayActive()) await stopNativeRfRelay()
            // The other three relays are the same shape and were missed:
            // each one owns a source of MAVLink and keeps pumping it into the
            // server's serial_uplink after the link is "released". Any of
            // them still running re-establishes the link from its own traffic,
            // so Disconnect appears to do nothing at all.
            if (isLocalRelayActive()) await stopLocalRelay()
            if (isSiyiTelemetryActive()) await stopSiyiTelemetry()
            if (isRemoteSitlRelayActive()) await stopRemoteSitlRelay()
        } catch (err) {
            // A relay that fails to close cleanly must not block the
            // disconnect - the server-side teardown is what matters.
            console.error('Local relay teardown failed', err)
        }
        getSocket().emit('disconnect_telemetry')
        store.setTelemetryStatus('disconnected')
    }, [])

    // Cloud flow: the radio is on the USER'S device - the browser reads it
    // via Web Serial and relays MAVLink to the backend (lib/browserSerial.ts).
    const connectBrowserSerial = useCallback(async (radio: SerialPortLike, baudRate = 57600) => {
        if (isBrowserSerialActive()) return
        store.setTelemetryStatus('connecting')
        try {
            await startBrowserSerial(radio, baudRate)
        } catch (err) {
            // Port busy in another app/tab, or radio just unplugged
            console.error('Browser serial connect failed', err)
            store.setTelemetryError(err instanceof Error ? err.message : 'Could not open the radio port')
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // Same radio, same bytes, but opened natively instead of through Web
    // Serial - the desktop app's only working serial path, since Electron
    // ships navigator.serial with no port picker behind it
    // (see lib/nativeSerialRelay.ts).
    const connectNativeSerial = useCallback(async (path: string, baudRate = DEFAULT_SERIAL_BAUD) => {
        if (isNativeSerialActive()) return
        store.setTelemetryStatus('connecting')
        // A port that opens but never speaks is the common failure here (baud
        // mismatch, unpaired radios) - report that rather than the backend's
        // generic timeout, same as the SITL bridge does.
        setSerialSilenceHandler((message) => {
            store.setTelemetryError(message)
            store.setTelemetryStatus('error')
            void stopNativeSerial()
        })
        try {
            await startNativeSerial(path, baudRate)
        } catch (err) {
            console.error('Native serial connect failed', err)
            store.setTelemetryError(err instanceof Error ? err.message : 'Could not open the radio port')
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // Same wfb-ng ground station as connectLocalRelay, but reading its UDP
    // ports directly instead of through telemetry_relay.py - desktop only
    // (see lib/nativeRfRelay.ts). Preferred where available: one fewer process
    // for the operator to remember to start.
    const connectNativeRf = useCallback(async () => {
        if (isNativeRfRelayActive()) return
        store.setTelemetryStatus('connecting')
        setRfSilenceHandler((message) => {
            store.setTelemetryError(message)
            store.setTelemetryStatus('error')
            void stopNativeRfRelay()
        })
        try {
            await startNativeRfRelay()
        } catch (err) {
            console.error('Native RF relay connect failed', err)
            store.setTelemetryError(err instanceof Error ? err.message : 'Could not bind the air unit ports')
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // Same cloud flow, but for a custom RF air unit (wfb-ng) instead of a
    // USB radio - the browser can't read raw UDP directly, so a local relay
    // agent re-exposes it as a loopback WebSocket (lib/localRfRelay.ts).
    const connectLocalRelay = useCallback(async (url?: string) => {
        if (isLocalRelayActive()) return
        store.setTelemetryStatus('connecting')
        try {
            await startLocalRelay(url)
        } catch (err) {
            console.error('Local RF relay connect failed', err)
            store.setTelemetryError(err instanceof Error ? err.message : 'Could not reach the local relay')
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // The client's own SITL instance (port 14540, the classic PX4 default),
    // bridged via the desktop app's native UDP bridge - desktop only, no
    // browser path (see lib/remoteSitlRelay.ts).
    const connectRemoteSitl = useCallback(async (port?: number) => {
        if (isRemoteSitlRelayActive()) return
        store.setTelemetryStatus('connecting')
        // The port binding succeeding tells us nothing about whether SITL is
        // actually sending - report that specific case with its actual causes
        // instead of waiting out the backend's generic mavsdk timeout.
        setSitlSilenceHandler((message) => {
            store.setTelemetryError(message)
            store.setTelemetryStatus('error')
            void stopRemoteSitlRelay()
        })
        try {
            await startRemoteSitlRelay(port)
        } catch (err) {
            console.error('SITL bridge connect failed', err)
            store.setTelemetryError(err instanceof Error ? err.message : 'Could not start the SITL bridge')
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // Command routing. In swarm mode the CHECKBOXES are the only command
    // targets - one group action to every ticked drone (tick one box to fly
    // one drone). The highlighted (CTRL) drone only selects whose telemetry
    // is shown; with nothing ticked, commands are inert. Swarm off → primary.
    const sendAction = useCallback((action: string, payload?: Record<string, unknown>) => {
        const { enabled, selectedIds, drones } = useSwarmStore.getState()
        if (enabled) {
            const targets = selectedIds.filter(id => drones[id]?.connected)
            if (targets.length > 0) {
                getSocket().emit('swarm_group_action', { drone_ids: targets, action, ...payload })
            }
            return
        }
        // Mark it in flight BEFORE emitting. Everything up to the drone's ACK
        // is dead air - the button does not change, no spinner appears, and on
        // a 3DR radio that lasts about a second, which is long enough to read
        // as a click that missed. The press itself is the one event we can
        // report instantly, so report it.
        store.setPendingAction(action)
        getSocket().emit('drone_action', { action, ...payload })
        // A result that never comes must not leave the button spinning
        // forever - that trades one misleading state for a worse one. Clear
        // it only if THIS press is still the pending one, so a later command
        // is never cancelled by an earlier press's timer.
        const mine = useDroneStore.getState().pendingAction
        setTimeout(() => {
            if (useDroneStore.getState().pendingAction === mine) {
                useDroneStore.getState().setPendingAction(null)
            }
        }, ACTION_PENDING_TIMEOUT_MS)
    }, [])

    const arm          = useCallback(() => sendAction('arm'),    [sendAction])
    const disarm       = useCallback(() => sendAction('disarm'), [sendAction])
    const emergencyStop = useCallback(() => {
        sendAction('emergency_stop')
        store.setEmergencyConfirm(false)
    }, [sendAction])

    const setMode = useCallback((mode: string) => {
        store.setMode(mode as any)
        getSocket().emit('set_analysis_mode', { mode })
    }, [])

    return {
        ...store,
        connectTelemetry,
        disconnectTelemetry,
        connectBrowserSerial,
        connectNativeSerial,
        connectNativeRf,
        connectLocalRelay,
        connectRemoteSitl,
        arm,
        disarm,
        emergencyStop,
        setMode,
        sendAction,
    }
}

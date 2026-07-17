'use client'

import { useEffect, useCallback } from 'react'
import { getSocket, connectSocket } from '@/lib/socket'
import { startBrowserSerial, stopBrowserSerial, isBrowserSerialActive, type SerialPortLike } from '@/lib/browserSerial'
import { useDroneStore } from '@/store/drone'
import { useSwarmStore } from '@/store/swarm'
import { colorForDrone, FLEET_SCAN_COUNT } from '@/lib/fleet'
import type { TelemetrySnapshot } from '@/types/telemetry'
import type { SessionInfo } from '@/types/session'
import type { CVResult } from '@/types/vision'

export function useDrone() {
    const store = useDroneStore()

    useEffect(() => {
        const socket = getSocket()
        if (!socket.connected && !socket.active) {
            store.setConnectionStatus('connecting')
            connectSocket()
        }

        // Named handler refs — .off(fn) removes ONLY this handler,
        // not all handlers for the event (which happens with bare .off('event')).
        // Critical: multiple components call useDrone(); without named refs,
        // one component's cleanup nukes every other component's listeners.
        const onConnect        = () => store.setConnectionStatus('connected')
        const onDisconnect     = () => {
            store.setConnectionStatus('disconnected')
            store.setTelemetryStatus('disconnected')
            store.reset()
            void stopBrowserSerial()
        }
        const onConnectError   = () => store.setConnectionStatus('error')
        const onSessionReady = (data: SessionInfo) => {
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
            // Link gone (disconnect, takeover, failed connect) → release the
            // local radio so the user can reconnect cleanly. No-op otherwise.
            if (data.status === 'disconnected' || data.status === 'error') {
                void stopBrowserSerial()
            }
        }

        // Primary drone telemetry — suppressed when a fleet drone has focus so
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
        // Swarm mission upload result — mirror to primary store so the mission
        // page's upload indicator and error handling work for fleet drones.
        const onSwarmMissionUpload = (data: { drone_id: number; ok: boolean; count?: number; msg: string }) => {
            const { activeDroneId } = useSwarmStore.getState()
            if (data.drone_id === activeDroneId) {
                store.setMissionUploadResult({ ok: data.ok, count: data.count, msg: data.msg })
            }
        }
        const onActionResult   = (data: { action: string; ok: boolean; msg?: string }) =>
            store.setLastActionResult(data)
        const onDroneMission   = (data: { waypoints: any[] }) =>
            store.setDroneMissionOffer(data.waypoints)

        // Fleet drone telemetry — updates swarm store and also mirrors to the
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

        // Batched fleet telemetry — one event carries the latest snapshot for
        // every fleet drone. Single store update, then mirror the actively
        // controlled drone into the primary store (OSD/HUD/connection gates).
        const onFleetTelemetry = (data: { drones: Record<string, TelemetrySnapshot> }) => {
            const swarm = useSwarmStore.getState()
            // In-flight packets can arrive just after the user disables swarm
            // mode — applying them would resurrect the cleared drone list.
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

        // Group command result — stash in the swarm store for FleetAside feedback
        const onSwarmGroupResult = (data: {
            action: string; ok_count: number; total: number
            results: Array<{ drone_id: number; ok: boolean; msg?: string }>
        }) => {
            useSwarmStore.getState().setGroupResult({
                action: data.action, okCount: data.ok_count, total: data.total, at: Date.now(),
            })
        }

        const onSwarmDroneStatus = (data: {
            drone_id: number; connected: boolean; name?: string; color?: string
        }) => {
            useSwarmStore.getState().setDroneConnected(
                data.drone_id, data.connected, data.name, data.color
            )
        }

        // Swarm action result — route to primary store so DroneControls sees it
        const onSwarmActionResult = (data: { drone_id: number; action: string; ok: boolean }) => {
            const { activeDroneId } = useSwarmStore.getState()
            if (data.drone_id === activeDroneId) {
                store.setLastActionResult({ action: data.action, ok: data.ok })
            }
        }

        // Auto-scan results — populate store so FleetAside shows drones before
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
                // Deselected — gates should close
                useDroneStore.getState().setTelemetryStatus('disconnected')
                return
            }

            // Switched to a different drone: immediately push its stored telemetry
            // so the UI reflects the new drone's actual state rather than stale values.
            const newDrone = state.drones[state.activeDroneId]
            if (newDrone?.telemetry) {
                useDroneStore.getState().setTelemetry(newDrone.telemetry)
            } else {
                // No telemetry received yet — clear stale values
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
        socket.on('drone_telemetry',       onDroneTelemetry)
        socket.on('fleet_telemetry',       onFleetTelemetry)
        socket.on('swarm_drone_status',    onSwarmDroneStatus)
        socket.on('swarm_action_result',   onSwarmActionResult)
        socket.on('swarm_group_result',    onSwarmGroupResult)
        socket.on('swarm_scan_started',    onSwarmScanStarted)
        socket.on('swarm_scan_result',     onSwarmScanResult)

        return () => {
            socket.off('connect',               onConnect)
            socket.off('disconnect',            onDisconnect)
            socket.off('connect_error',         onConnectError)
            socket.off('session_ready',         onSessionReady)
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
            socket.off('drone_telemetry',       onDroneTelemetry)
            socket.off('fleet_telemetry',       onFleetTelemetry)
            socket.off('swarm_drone_status',    onSwarmDroneStatus)
            socket.off('swarm_action_result',   onSwarmActionResult)
            socket.off('swarm_group_result',    onSwarmGroupResult)
            socket.off('swarm_scan_started',    onSwarmScanStarted)
            socket.off('swarm_scan_result',     onSwarmScanResult)
            swarmSub()
            // DO NOT call disconnectSocket() here — socket lives for app lifetime
        }
    }, [])

    const connectTelemetry = useCallback((address: string) => {
        store.setTelemetryStatus('connecting')
        getSocket().emit('connect_telemetry', { address })
    }, [])

    // Cloud flow: the radio is on the USER'S device — the browser reads it
    // via Web Serial and relays MAVLink to the backend (lib/browserSerial.ts).
    const connectBrowserSerial = useCallback(async (radio: SerialPortLike, baudRate = 57600) => {
        if (isBrowserSerialActive()) return
        store.setTelemetryStatus('connecting')
        try {
            await startBrowserSerial(radio, baudRate)
        } catch (err) {
            // Port busy in another app/tab, or radio just unplugged
            console.error('Browser serial connect failed', err)
            store.setTelemetryStatus('disconnected')
        }
    }, [])

    // Command routing. In swarm mode the CHECKBOXES are the only command
    // targets — one group action to every ticked drone (tick one box to fly
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
        getSocket().emit('drone_action', { action, ...payload })
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
        connectBrowserSerial,
        arm,
        disarm,
        emergencyStop,
        setMode,
        sendAction,
    }
}

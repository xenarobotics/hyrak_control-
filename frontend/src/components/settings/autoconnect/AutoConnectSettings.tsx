'use client'

// Settings > Comm links > Auto-connect. Saved per device: in the desktop app's
// own config file, or in this browser's storage.

import { useEffect } from 'react'
import { isDesktopApp } from '@/lib/nativeBridge'
import { browserSerialSupported } from '@/lib/browserSerial'
import { PrefRow, S_NOTE, Pill } from '@/components/settings/primitives'
import { loadAutoConnectConfig, saveAutoConnectConfig, useAutoConnectStore, type AutoPort } from '@/lib/autoConnect'

function Switch({ value, onChange, label, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
    const on = value && !disabled
    return (
        <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled}
            onClick={() => onChange(!value)}
            className="hover:shadow-[0_0_0_3px_var(--app-accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-accent)] disabled:cursor-not-allowed disabled:hover:shadow-none"
            style={{
                width: 40, height: 24, borderRadius: 999, padding: 0, flexShrink: 0, position: 'relative',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
                background: on ? 'var(--app-accent)' : 'hsl(var(--app-surface-2))',
                border: `1px solid ${on ? 'var(--app-accent)' : 'hsl(var(--app-border-strong))'}`,
                transition: 'background-color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out)',
            }}>
            <span style={{
                position: 'absolute', top: 3, left: 3, width: 16, height: 16, borderRadius: '50%',
                background: on ? 'var(--app-accent-ink)' : 'hsl(var(--app-text-muted))',
                transform: value ? 'translateX(16px)' : 'none',
                transition: 'transform var(--dur) var(--ease-out), background-color var(--dur) var(--ease-out)',
            }} />
        </button>
    )
}

const STATE_WORD: Record<AutoPort['state'], string> = {
    idle: 'not checked yet', probing: 'checking for a vehicle', waiting: 'no vehicle heard yet',
    found: 'vehicle found', suppressed: 'left alone until replugged', ignored: 'not a vehicle link',
}

export function AutoConnectGroup() {
    const desktop = isDesktopApp()
    const config = useAutoConnectStore(s => s.config)
    const unsupported = useAutoConnectStore(s => s.unsupported)
    const ports = useAutoConnectStore(s => s.ports)
    const status = useAutoConnectStore(s => s.status)
    const last = useAutoConnectStore(s => s.last)
    useEffect(() => { void loadAutoConnectConfig() }, [])

    const off = !config.enabled
    const set = (patch: Partial<typeof config>) => { void saveAutoConnectConfig(patch) }
    const browserNoSerial = !desktop && !browserSerialSupported()

    if (desktop && unsupported) {
        return (
            <p style={{ ...S_NOTE, padding: '12px 0' }}>
                This copy of the HYRAK desktop app is older than auto-connect. Update it from Settings, About, then come back here.
            </p>
        )
    }

    const subRow = (label: string, sub: string, key: 'usb' | 'sik' | 'udp') => (
        <div style={{ paddingLeft: 16 }}>
            <PrefRow label={label} sub={sub}
                right={<Switch label={label} value={config[key]} disabled={off} onChange={v => set({ [key]: v })} />} />
        </div>
    )

    const statusLine = !status ? null
        : status.paused ? `Paused: ${status.reason}.`
        : status.probing ? `Checking ${status.probing} for a vehicle.`
        : status.udp === 'listening' ? `Listening on UDP ${config.udpPort}${ports.length ? ` and watching ${ports.length} serial port${ports.length === 1 ? '' : 's'}` : ''}.`
        : status.udp === 'busy' ? `UDP ${config.udpPort} is in use by another program (QGroundControl?). Retrying every 10 s.`
        : `Watching ${ports.length} serial port${ports.length === 1 ? '' : 's'}.`

    return (
        <>
            <PrefRow
                label="Auto-connect to vehicles"
                sub={desktop
                    ? 'Connects by itself when a flight controller or telemetry radio is plugged in, or a simulator starts sending on UDP 14550, like QGroundControl.'
                    : 'Reconnects USB devices this browser has already been allowed to use (with the + button on the Link card) as soon as they are plugged in. A browser cannot open a new device on its own: pick it once with +, after that it connects by itself. The desktop app also finds new devices and UDP simulators.'}
                tip="It never takes over a link you already have. After you disconnect, every device that was plugged in at that moment is left alone until you unplug it and plug it back in. A device is only used once a MAVLink heartbeat has been heard from it."
                right={<Switch label="Auto-connect to vehicles" value={config.enabled} onChange={v => set({ enabled: v })} />}
            />
            {browserNoSerial && (
                <p style={{ ...S_NOTE, padding: '8px 0 0' }}>This browser has no USB serial support, so only the desktop app can auto-connect here.</p>
            )}
            {subRow('USB flight controllers', 'Pixhawk, Cube, Holybro, ARK and other PX4 or ArduPilot boards on a USB cable.', 'usb')}
            {subRow('SiK / 3DR telemetry radios', 'FTDI and CP210x radios, opened at 57600 baud.', 'sik')}
            {desktop && subRow('UDP 14550 (simulator and companion)', 'PX4 SITL and most companion computers send here. If you fly with a HYRAK air unit, pick it on the Link card once and auto-connect uses it.', 'udp')}

            {desktop && (
                <PrefRow
                    label="Right now"
                    sub={off ? 'Auto-connect is off.' : (statusLine ?? 'Starting...')}
                    right={last ? <span style={{ fontSize: 12, color: 'hsl(var(--app-text-muted))', maxWidth: 260, display: 'inline-block', textAlign: 'right' }}>Last: {last.what}</span> : <span />}
                />
            )}
            {desktop && ports.length > 0 && (
                <ul aria-label="Serial ports on this computer" style={{ listStyle: 'none', margin: 0, padding: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ports.map(p => (
                        <li key={p.path} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, color: 'hsl(var(--app-text))' }}>
                            <span style={{ fontWeight: 600 }}>{p.cls === 'other' ? 'Other device' : p.name}</span>
                            <span style={{ fontFamily: 'var(--font-code, monospace)', fontSize: 12, color: 'hsl(var(--app-text-muted))' }}>{p.path}</span>
                            <Pill tone={p.state === 'found' ? 'cyan' : p.state === 'suppressed' ? 'amber' : 'muted'}>{STATE_WORD[p.state]}</Pill>
                        </li>
                    ))}
                </ul>
            )}
            <p style={{ ...S_NOTE, padding: '12px 0 0' }}>
                Saved on this {desktop ? 'computer' : 'browser'} only.
            </p>
        </>
    )
}

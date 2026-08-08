import type { NativeBridge } from './types'
import { UdpBridge } from './udpBridge'
import { TcpBridge } from './tcpBridge'
import { SerialBridge } from './serialBridge'
import { RtspBridge } from './rtspBridge'
import { RtspRelayBridge } from './rtspRelayBridge'
import { AirUnitVideoBridge } from './airUnitVideoBridge'
import { WebrtcSenderBridge } from './webrtcSenderBridge'
import { GstreamerBridge } from './gstreamerBridge'
import { ReceiverBridge } from './receiverBridge'

// Every supported protocol registers itself here, once. main.ts's IPC
// wiring and preload.ts's exposed API are both written generically against
// this map — adding a new protocol (another codec, HID, a GStreamer
// pipeline, whatever's next) means implementing NativeBridge in one new
// file and adding one line below. Nothing else in the app changes.
export const bridges: Record<string, NativeBridge> = {
    udp: new UdpBridge(),
    tcp: new TcpBridge(),
    serial: new SerialBridge(),
    rtsp: new RtspBridge(),
    'rtsp-relay': new RtspRelayBridge(),
    'air-unit-video': new AirUnitVideoBridge(),
    'webrtc-sender': new WebrtcSenderBridge(),
    'gstreamer-preview': new GstreamerBridge(),
    // The ground decoder's PC-side consumer. Cross-platform by construction —
    // see the header of receiverBridge.ts for why it does not simply extend
    // 'gstreamer-preview'.
    'hyrak-receiver': new ReceiverBridge(),
}

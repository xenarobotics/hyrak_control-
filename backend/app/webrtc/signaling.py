"""
WebRTC signaling via Socket.IO.
Handles offer/answer/ICE exchange.
"""
import asyncio
import functools
import ipaddress
import logging
import socket
import uuid
from typing import TYPE_CHECKING

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaRelay
from aiortc.sdp import candidate_from_sdp

from app.sessions import observer
from app.webrtc.peer_registry import PeerRegistry, PeerEntry
from app.webrtc.stream_track import MultiModeVideoStreamTrack

if TYPE_CHECKING:
    from app.vision.worker_pool import VisionWorkerPool
    from app.sessions.manager import SessionManager

logger = logging.getLogger("verocore.webrtc.signaling")

# One relay shared across all peers — efficient media routing
relay = MediaRelay()


def _on_link_networks() -> "list[ipaddress.IPv4Network]":
    """IPv4 networks this host is directly attached to, per the kernel.

    A route with no gateway is on-link: its destinations are reachable by
    talking to them directly, which is exactly the property that makes it safe
    to hand our address on that route to a client. Routes THROUGH a gateway are
    excluded, and so is the default route — under it every address in the world
    would look local.

    Linux-only by way of /proc/net/route. Anywhere else this returns nothing
    and callers fall back to the public host, which is the safe direction.
    """
    nets: "list[ipaddress.IPv4Network]" = []
    try:
        with open("/proc/net/route") as fh:
            next(fh)  # column headers
            for line in fh:
                cols = line.split()
                if len(cols) < 8:
                    continue
                # Each field is the 32-bit value in network byte order,
                # hex-printed from a little-endian word — so 0100A8C0 reads
                # back as 192.168.0.1.
                gateway = int.from_bytes(bytes.fromhex(cols[2]), "little")
                if gateway != 0:
                    continue
                mask = int.from_bytes(bytes.fromhex(cols[7]), "little")
                if mask == 0:
                    continue
                dest = int.from_bytes(bytes.fromhex(cols[1]), "little")
                nets.append(
                    ipaddress.IPv4Network((dest, bin(mask).count("1")), strict=False)
                )
    except (OSError, ValueError, StopIteration):
        return []
    return nets


def _is_own_address(addr: "ipaddress.IPv4Address | ipaddress.IPv6Address") -> bool:
    """Is this one of THIS host's own addresses?

    Binding is the test: the kernel only lets a socket claim an address that is
    actually assigned locally, and binding to port 0 sends nothing and reserves
    nothing worth caring about. Cheaper and more portable than enumerating
    interfaces, and it needs no third-party dependency.
    """
    family = socket.AF_INET6 if addr.version == 6 else socket.AF_INET
    try:
        s = socket.socket(family, socket.SOCK_DGRAM)
        try:
            s.bind((str(addr), 0))
            return True
        finally:
            s.close()
    except OSError:
        return False


def _relay_host_for(client_ip: str | None, public_host: str) -> str:
    """Which of OUR addresses this particular client should push video to.

    `relay_public_host` names the one address a client on the open internet
    can reach: the VPS, which DNATs the relay ports down a WireGuard tunnel to
    this machine. That is the right answer for a remote client and a bad one
    for every other client, because it sends video out to the internet and
    straight back to the same host. Measured cost of that round trip on the
    reference setup: ~40ms added, plus a total dependency on the client's
    network permitting outbound UDP on an arbitrary high port. Restrictive
    networks (a university's, in the case that prompted this) allow UDP only on
    53 and 123, which kills SRT while leaving the LAN video path untouched —
    presenting as "the ground decoder previews fine but the AI modules never
    receive anything".

    So: for a client that shares a network with us, hand back the address on
    OUR side of that shared network and skip the internet entirely. The kernel
    already knows which one that is — connecting a UDP socket sends no packets
    and just resolves the source address it would pick for that destination,
    which correctly yields 127.0.0.1 for a client on this machine, the LAN
    address for a client on the LAN, and the WireGuard address for a client in
    the tunnel.

    Anything else falls through to `public_host`. Note the trust boundary:
    `client_ip` comes from CF-Connecting-IP/X-Forwarded-For (see `connect` in
    server.py), so a proxy that failed to set either would make a remote client
    look local and get handed an unreachable address. That is what
    `relay_prefer_local_host` exists to switch off.

    A private address is NOT on its own evidence of a shared network — a
    client on some other 192.168.x LAN is as unreachable as any host on the
    internet, and asking the kernel for a source address towards it just
    returns whatever the DEFAULT route uses, which that client cannot reach.
    Measured while writing this: with the laptop on 10.183.197.7, a client
    claiming 192.168.0.55 resolved to 10.183.197.7 — plausible and wrong. So
    the client must fall inside a network we are actually attached to.
    """
    try:
        addr = ipaddress.ip_address((client_ip or "").strip())
    except ValueError:
        return public_host
    # Same machine, the dominant case: the desktop app and the server normally
    # run together. Loopback is the obvious form of it, but not the only one —
    # a browser reaching this host by its own global address arrives with that
    # address as the peer, which looks remote and is not. Observed on the
    # reference laptop, whose UI connects over its own public IPv6.
    #
    # Both answer 127.0.0.1 rather than the address asked about, because the
    # relay listener binds 0.0.0.0 (see _listen_url) and so accepts IPv4 only —
    # handing back an IPv6 host would produce a connect that cannot land.
    if addr.is_loopback or _is_own_address(addr):
        return "127.0.0.1"
    if addr.version != 4 or not addr.is_private:
        return public_host
    if not any(addr in net for net in _on_link_networks()):
        return public_host
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # Port 9 (discard) is never contacted — connect() on UDP sends
            # nothing and only resolves the local address for that route.
            s.connect((str(addr), 9))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return public_host


async def _add_ice_candidate(pc, cand_sdp, sdp_mid, sdp_mline_index):
    try:
        parsed = candidate_from_sdp(cand_sdp)
        candidate = RTCIceCandidate(
            foundation=getattr(parsed, "foundation", None),
            component=getattr(parsed, "component", None),
            protocol=getattr(parsed, "protocol", None),
            priority=getattr(parsed, "priority", None),
            ip=getattr(parsed, "ip", None),
            port=getattr(parsed, "port", None),
            type=getattr(parsed, "type", None),
            sdpMid=sdp_mid,
            sdpMLineIndex=sdp_mline_index,
            relatedAddress=getattr(parsed, "relatedAddress", None),
            relatedPort=getattr(parsed, "relatedPort", None),
            tcpType=getattr(parsed, "tcpType", None),
        )
        await pc.addIceCandidate(candidate)
    except Exception as e:
        logger.warning(f"ICE candidate error: {e}")


def _sort_relay_urls(urls) -> list[str]:
    """TURN urls ordered most-reachable first for aiortc: turns (TLS/TCP,
    :443 before :5349) > turn?transport=tcp > turn UDP. STUN order kept."""
    if isinstance(urls, str):
        urls = [urls]

    def rank(u: str):
        if u.startswith("turns:"):
            return (0, 0 if ":443" in u else 1)
        if u.startswith("turn:") and "transport=tcp" in u:
            return (1, 0)
        if u.startswith("turn:"):
            return (2, 0)
        return (3, 0)  # stun — irrelevant to turn selection

    return sorted(urls, key=rank)


def _attach_video_track(pc, entry, session, vision_pool, session_manager, sio, sid, source_track, client_overlay):
    """Wraps source_track (a browser-relayed camera track, or a server-side
    track like udp_video_source's) in the AI pipeline and either drives it
    internally (client-overlay) or sends the annotated result back to the
    browser (pc.addTrack)."""
    async def emit_cv_results(payload: dict):
        await sio.emit("cv_results", payload, to=sid)

    async def emit_admin_frame(session_id: str, jpeg: bytes):
        await sio.emit(
            "admin_frame",
            {"session_id": session_id, "jpeg": jpeg},
            room=observer.watch_room(session_id),
        )

    video_track = MultiModeVideoStreamTrack(
        source_track=source_track,
        session_id=session.session_id,
        vision_pool=vision_pool,
        session_manager=session_manager,
        emit_callback=emit_cv_results,
        snapshot_callback=emit_admin_frame,
        return_video=not client_overlay,
    )
    entry.tracks.append(video_track)
    if client_overlay:
        # No consumer pulls recv() without an outgoing track, so drive it
        # ourselves; exits when the source track ends.
        async def _drive():
            try:
                while True:
                    await video_track.recv()
            except Exception:
                pass
        entry.drive_task = asyncio.create_task(_drive())
        logger.info(f"Client-overlay pipeline for session {session.session_id[:8]}")
    else:
        pc.addTrack(video_track)
        logger.info(f"Video track attached for session {session.session_id[:8]}")


def register_webrtc_events(
    sio,
    peer_registry: PeerRegistry,
    vision_pool: "VisionWorkerPool",
    session_manager: "SessionManager",
):
    @sio.on("allocate_video_relay")
    async def on_allocate_video_relay(sid, data=None):
        """Reserve an inbound listener for the desktop app's zero-transcode
        RTSP relay and tell it where to push. Returned as a socket ack, so
        the client never needs to know its own session_id.

        MUST happen before the offer: the client needs somewhere to push,
        and on_offer waits for real frames to already be arriving.

        The address returned is a RAW SRT/TCP endpoint, not HTTP — it does
        NOT pass through the cloudflared tunnel, so `relay_public_host` has
        to name a directly reachable host with the relay ports forwarded.

        The host is chosen PER CLIENT rather than fixed: a client sharing a
        network with us is told to push there directly instead of out through
        `relay_public_host` and back. See `_relay_host_for`."""
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"error": "No session"}

        from app.config import get_settings
        from app.webrtc import relay_video_source
        cfg = get_settings()
        data = data or {}
        transport = data.get("transport") or cfg.relay_default_transport
        latency_ms = int(data.get("latencyMs") or cfg.relay_latency_ms)
        if transport not in relay_video_source.VALID_TRANSPORTS:
            return {"error": f"transport must be one of {relay_video_source.VALID_TRANSPORTS}"}

        try:
            ingest = await asyncio.get_event_loop().run_in_executor(
                None,
                functools.partial(
                    relay_video_source.allocate,
                    session.session_id, transport=transport, latency_ms=latency_ms,
                ),
            )
        except Exception as e:
            logger.error(f"Relay allocation failed for {session.session_id[:8]}: {e}")
            return {"error": str(e)}

        host = cfg.relay_public_host
        if cfg.relay_prefer_local_host:
            host = _relay_host_for(session.client_ip, cfg.relay_public_host)
        if host != cfg.relay_public_host:
            logger.info(
                f"Relay for {session.session_id[:8]}: client {session.client_ip} shares a "
                f"network — pushing to {host}:{ingest.public_port} instead of "
                f"{cfg.relay_public_host or '(unset)'}, skipping the internet round trip"
            )

        return {
            "host": host,
            "port": ingest.public_port,
            "transport": transport,
            "latencyMs": latency_ms,
            "streamId": ingest.token,
            # Let the UI say what's wrong instead of leaving the operator to
            # debug a silent SRT connect timeout. A local client always has a
            # reachable address, even with relay_public_host unset — so this
            # tracks the host we actually chose, not just the config value.
            "hostConfigured": bool(host),
        }

    @sio.on("release_video_relay")
    async def on_release_video_relay(sid, data=None):
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"ok": False}
        from app.webrtc import relay_video_source
        await relay_video_source.release_async(session.session_id)
        return {"ok": True}

    @sio.on("datachannel_video_offer")
    async def on_datachannel_video_offer(sid, data=None):
        """Accepts the desktop app's DataChannel offer for bit-exact video.

        A SECOND PeerConnection, separate from the browser's, carrying no media
        tracks at all — only a DataChannel of raw RTP packets. That is what
        makes H.265 possible: aiortc's video codec table is VP8/H.264 only, so
        HEVC cannot ride a media track here, but a DataChannel does not
        negotiate codecs. See datachannel_video_source.py.

        Answered as a socket ack rather than an `answer` event, because the
        browser's own negotiation uses that event and the two must not be
        confused for one another.
        """
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"error": "No session"}
        if not data or not data.get("sdp"):
            return {"error": "sdp required"}

        from app.webrtc import datachannel_video_source

        ingest = datachannel_video_source.allocate(session.session_id)
        pc = RTCPeerConnection()

        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(
                f"Video DataChannel open for {session.session_id[:8]} "
                f"(label={channel.label})"
            )

            @channel.on("message")
            def on_message(message):
                # Straight through, unchanged. Any parsing here would defeat
                # the entire point — the payload is deliberately opaque so the
                # codec never has to be negotiated.
                if isinstance(message, (bytes, bytearray)):
                    ingest.feed(bytes(message))

        @pc.on("connectionstatechange")
        async def on_state_change():
            logger.info(
                f"Video DataChannel PC for {session.session_id[:8]}: {pc.connectionState}"
            )
            if pc.connectionState in ("failed", "closed", "disconnected"):
                await datachannel_video_source.release_async(session.session_id)

        try:
            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=data["sdp"], type="offer")
            )
            await pc.setLocalDescription(await pc.createAnswer())
        except Exception as e:
            logger.error(
                f"DataChannel video offer failed for {session.session_id[:8]}: {e}"
            )
            await datachannel_video_source.release_async(session.session_id)
            return {"error": str(e)}

        # The port is returned so the caller can pass it back in the browser's
        # offer. The browser never discovers it any other way — it has no
        # session_id and no view of this PeerConnection.
        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
            "loopbackPort": ingest.loopback_port,
        }

    @sio.on("datachannel_video_stats")
    async def on_datachannel_video_stats(sid, data=None):
        session = session_manager.get_by_socket(sid)
        if not session:
            return {"error": "No session"}
        from app.webrtc import datachannel_video_source
        ingest = datachannel_video_source.get(session.session_id)
        return ingest.stats() if ingest else {"packets": 0, "bytes": 0}

    @sio.on("offer")
    async def on_offer(sid, data):
        session = session_manager.get_by_socket(sid)
        if not session:
            await sio.emit("error", {"msg": "No session"}, to=sid)
            return

        # Build RTCPeerConnection
        ice_servers = data.get("iceServers", [])
        # Only pass the fields aiortc knows — browser dicts can carry extras
        # (credentialType etc.) that would TypeError in the dataclass.
        # aiortc uses only the FIRST turn/turns url it encounters, so sort
        # TLS/TCP relays first: turn-over-UDP (the provider default first
        # entry) is dead on UDP-blocking networks like campus WiFi, while
        # turns:443 traverses essentially any firewall.
        ice_objs = [
            RTCIceServer(
                urls=_sort_relay_urls(s["urls"]),
                username=s.get("username"),
                credential=s.get("credential"),
            )
            for s in ice_servers
            if s.get("urls")
        ]
        config = RTCConfiguration(iceServers=ice_objs) if ice_objs else None
        pc = RTCPeerConnection(configuration=config)
        pc_id = f"pc_{uuid.uuid4()}"

        # Client-overlay stream: the browser displays a LOCAL picture (its own
        # camera, or the desktop app's air-unit preview) and draws cv_results
        # on a canvas — no downlink video at all. The uplink still feeds
        # inference, drone commands and the observer, and this side skips the
        # outbound H.264 encode entirely (~0.79 core/session at 1080p,
        # measured — the thing that capped delivery at 8.3fps of a 20fps
        # source).
        #
        # This used to be forced off for server-sourced feeds on the theory
        # that they have no local picture. That stopped being true when the
        # desktop app grew a local air-unit preview
        # (frontend/src/lib/airUnitPreview.ts), so the client's word is now
        # taken as-is: the client is the only side that knows whether a local
        # preview is actually running, and it only sends clientOverlay for a
        # source it can display locally.
        video_source = data.get("videoSource", "camera")
        # Must stay in step with isServerSourced() in frontend/src/lib/
        # videoSource.ts. When the two disagree the failure is silent and
        # total: the browser sends a recvonly transceiver and no track
        # (because ITS list says server-sourced) while the server sits
        # waiting on pc.on("track") (because THIS list says otherwise), so
        # nothing errors, the PC reports "connected", and the feed is black
        # forever. That is exactly what omitting air_unit_datachannel here
        # did while the DataChannel happily delivered 2013 packets.
        server_sourced = video_source in (
            "air_unit_udp", "siyi_rtsp", "rtsp_relay",
            "rtsp_datachannel", "air_unit_datachannel",
            "air_unit_srt", "air_unit_gst", "hyrak_receiver",
        )
        client_overlay = bool(data.get("clientOverlay"))

        entry = PeerEntry(
            pc_id=pc_id,
            session_id=session.session_id,
            socket_id=sid,
            pc=pc,
        )
        peer_registry.add(entry)
        session.pc_id = pc_id
        session.is_streaming = True

        # Register session with vision pool for current mode
        vision_pool.register_session(session.session_id, session.mode)

        @pc.on("connectionstatechange")
        async def on_state_change():
            logger.info(f"PC {pc_id[:8]} state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed", "disconnected"):
                session.is_streaming = False
                await vision_pool.unregister_session(session.session_id)
                await peer_registry.remove(pc_id)
                # Free the relay listener + its ffmpeg. No-op for every other
                # video source, so this needs no branch on video_source.
                from app.webrtc import relay_video_source
                await relay_video_source.release_async(session.session_id)

        if server_sourced:
            # No browser video track incoming (the offer only declares a
            # recvonly video transceiver) — source frames straight from the
            # network instead of waiting on pc.on("track").
            try:
                if video_source == "siyi_rtsp":
                    from app.webrtc.rtsp_video_source import open_rtsp_video
                    rtsp_url = data.get("rtspUrl") or "rtsp://192.168.144.25:8554/video1"
                    # Blocking (ffmpeg probes synchronously) — must not run
                    # directly on the event loop, it would freeze every other
                    # session (telemetry, other streams) for up to the timeout.
                    source_track = await asyncio.get_event_loop().run_in_executor(
                        None, open_rtsp_video, rtsp_url
                    )
                elif video_source in (
                    "rtsp_relay", "air_unit_srt", "air_unit_gst", "hyrak_receiver",
                ):
                    # The desktop app is pushing the ORIGINAL bytes to a
                    # listener allocated earlier via
                    # /api/webrtc/video-relay/allocate — nothing to open
                    # outbound here, just attach to what's already arriving.
                    #
                    # Every one of these lands here and they are indistinguishable
                    # from this side, which is the point: the relay is defined by
                    # how video ARRIVES (SRT/TCP/UDP into RelayIngest), not by
                    # what the client pointed ffmpeg at. rtsp_relay pulled a
                    # camera, air_unit_srt read wfb_rx's RTP off udp:5600,
                    # hyrak_receiver read the ground decoder over Ethernet — by
                    # the time it reaches this listener all of them are MPEG-TS
                    # carrying the source's untouched frames.
                    from app.webrtc import relay_video_source
                    ingest = relay_video_source.get(session.session_id)
                    if ingest is None:
                        raise RuntimeError(
                            "No video relay allocated for this session — the desktop app "
                            "must call POST /api/webrtc/video-relay/allocate and start "
                            "relaying before sending the offer."
                        )
                    # SAY WHAT IS BEING WAITED FOR, WHILE WAITING.
                    #
                    # open_track blocks for up to 25 s waiting for the desktop
                    # app to push video. For that whole time the operator sees
                    # a spinner and nothing else, and if it then fails they
                    # have watched "connecting" for 25 seconds and learned
                    # nothing — which reads as the mode being broken rather
                    # than the uplink being silent. It is the same 25 s
                    # whichever analysis mode is selected, so it also makes an
                    # uplink problem look like it belongs to whatever mode
                    # happened to be picked.
                    #
                    # ffmpeg already knows. It is the process holding the
                    # listener, and its stderr says whether the source ever
                    # connected — "404 Not Found" from the camera reaches this
                    # tail immediately, 25 s before the timeout fires.
                    async def _report_wait():
                        started = asyncio.get_event_loop().time()
                        while True:
                            await asyncio.sleep(3.0)
                            tail = [ln for ln in ingest.stderr_tail().strip().splitlines() if ln]
                            await sio.emit("stream_progress", {
                                "phase": "awaiting_video",
                                "seconds": round(
                                    asyncio.get_event_loop().time() - started
                                ),
                                "source": video_source,
                                "detail": (tail[-1][:200] if tail else
                                           "nothing has reached the relay listener yet"),
                            }, to=sid)

                    reporter = asyncio.create_task(_report_wait())
                    try:
                        source_track = await asyncio.get_event_loop().run_in_executor(
                            None, ingest.open_track
                        )
                    finally:
                        reporter.cancel()
                elif video_source in ("rtsp_datachannel", "air_unit_datachannel"):
                    # The desktop app is pushing RTP packets down a DataChannel
                    # (see datachannel_video_source.py) and the shim is writing
                    # them to a loopback UDP port. Nothing new to decode here:
                    # this is byte-identical to what the air unit puts on the
                    # wire, so the SAME H.265 reader handles it. That reuse is
                    # the whole reason this transport is viable — it never
                    # touches aiortc's VP8/H.264-only codec negotiation.
                    #
                    # Both DataChannel modes land here and are indistinguishable
                    # from this side: one had ffmpeg remux an RTSP camera, the
                    # other read the air unit's RTP straight off a UDP port, but
                    # what reaches the loopback socket is RTP/H.265 either way.
                    from app.webrtc import datachannel_video_source
                    from app.webrtc.udp_video_source import open_air_unit_video
                    ingest = datachannel_video_source.get(session.session_id)
                    if ingest is None:
                        raise RuntimeError(
                            "No DataChannel video ingest for this session — the desktop "
                            "app must send `datachannel_video_offer` and start pushing "
                            "before this offer."
                        )
                    source_track = await asyncio.get_event_loop().run_in_executor(
                        None,
                        functools.partial(
                            open_air_unit_video,
                            port=ingest.loopback_port,
                            timeout=15.0,
                            # No reorder window. SCTP delivered these in order
                            # (ordered:true) and this is a loopback socket, so
                            # there is nothing to wait for — and waiting is 100ms
                            # of pure latency. This is the single biggest lever
                            # measured on the gap to siyi_rtsp.
                            max_delay_us=0,
                        ),
                    )
                else:
                    from app.webrtc.udp_video_source import open_air_unit_video
                    video_port = int(data.get("airUnitVideoPort") or 5600)
                    source_track = await asyncio.get_event_loop().run_in_executor(
                        None, functools.partial(open_air_unit_video, port=video_port)
                    )
                # open_air_unit_video's SDP declares the stream format
                # statically from the SDP text alone, so it "succeeds" the
                # instant it's opened regardless of whether any real packets
                # are actually arriving — there's nothing to probe when the
                # format is pre-declared. Left unchecked, a genuinely dead
                # feed (nothing sending to this port at all — e.g. the
                # ground station is on a different machine than this
                # backend and its UDP traffic never left its own loopback)
                # would still negotiate a "connected" WebRTC session that
                # silently never delivers a single frame — connected but
                # black, no error anywhere. Confirm one real frame actually
                # arrives before treating this as a working source.
                try:
                    await asyncio.wait_for(source_track.recv(), timeout=5.0)
                except asyncio.TimeoutError:
                    source_track.stop()
                    raise RuntimeError(
                        f"Opened {video_source} but no video frames arrived within 5s — "
                        f"is the source actually sending to this server (not just to its "
                        f"own machine's localhost)?"
                    )
            except Exception as e:
                logger.error(f"Server-sourced video open failed ({video_source}): {e}")
                msg = str(e)
                if video_source in ("rtsp_relay", "air_unit_srt", "air_unit_gst"):
                    # ffmpeg's own words are far more useful than "no frames
                    # arrived" — it knows whether the SRT handshake was ever
                    # attempted, which distinguishes a blocked UDP path from
                    # a laptop that simply isn't relaying.
                    from app.webrtc import relay_video_source
                    ingest = relay_video_source.get(session.session_id)
                    tail = ingest.stderr_tail() if ingest else ""
                    if tail:
                        msg = f"{msg} — relay listener said: {tail.strip()}"
                    await relay_video_source.release_async(session.session_id)
                elif video_source in ("rtsp_datachannel", "air_unit_datachannel"):
                    # The single most useful thing to know here is whether the
                    # client's packets ever arrived. "0 packets" means the
                    # DataChannel or the client's ffmpeg is the problem; a large
                    # count with no decodable frames means the payload is not
                    # the RTP/H.265 the loopback SDP declares.
                    from app.webrtc import datachannel_video_source
                    ingest = datachannel_video_source.get(session.session_id)
                    if ingest is not None:
                        s = ingest.stats()
                        msg = (
                            f"{msg} — DataChannel forwarded {s['packets']} packets "
                            f"({s['bytes'] / 1e6:.1f} MB) to udp:{s['loopbackPort']}"
                            + (
                                ". Nothing arrived from the client at all."
                                if s["packets"] == 0
                                else ". Packets arrived but were not decodable as "
                                     "RTP/H.265 — check the client's payload type."
                            )
                        )
                    # Deliberately NOT released here: the desktop's DataChannel
                    # PeerConnection owns this ingest and may still be pushing.
                    # Tearing it down on a browser-side failure is the same
                    # ownership bug that made the relay go black.
                await sio.emit("error", {"msg": msg}, to=sid)
                await peer_registry.remove(pc_id)
                return
            _attach_video_track(
                pc, entry, session, vision_pool, session_manager, sio, sid,
                source_track, client_overlay,
            )
        else:
            @pc.on("track")
            def on_track(track):
                if track.kind != "video":
                    return
                # buffered=False: always hand recv() the NEWEST frame and drop
                # stale ones. The buffered default queues every frame
                # unboundedly, so whenever processing ran slower than the
                # camera the backlog grew and glass-to-glass latency crept
                # 300ms -> 1s+.
                _attach_video_track(
                    pc, entry, session, vision_pool, session_manager, sio, sid,
                    relay.subscribe(track, buffered=False), client_overlay,
                )

        try:
            await pc.setRemoteDescription(
                RTCSessionDescription(sdp=data["sdp"], type=data["type"])
            )

            # Apply any queued ICE candidates
            for cand_sdp, mid, mline in list(entry.pending_ice):
                await _add_ice_candidate(pc, cand_sdp, mid, mline)
            entry.pending_ice.clear()

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await sio.emit(
                "answer",
                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                to=sid,
            )
            logger.info(f"Answer sent for {pc_id[:8]}")

        except Exception as e:
            logger.exception(f"Offer handling error: {e}")
            await peer_registry.remove(pc_id)

    @sio.on("ice_candidate")
    async def on_ice_candidate(sid, data):
        entry = peer_registry.get_by_socket(sid)
        if not entry:
            return

        if not data:
            return

        cand_sdp = data.get("candidate")
        sdp_mid = data.get("sdpMid")
        sdp_mline_index = data.get("sdpMLineIndex")

        if not cand_sdp:
            return

        if entry.pc.remoteDescription is None:
            entry.pending_ice.append((cand_sdp, sdp_mid, sdp_mline_index))
            return

        await _add_ice_candidate(entry.pc, cand_sdp, sdp_mid, sdp_mline_index)

    @sio.on("stop_stream")
    async def on_stop_stream(sid):
        entry = peer_registry.get_by_socket(sid)
        if not entry:
            return
        session = session_manager.get(entry.session_id)
        if session:
            session.is_streaming = False
        await vision_pool.unregister_session(entry.session_id)
        await peer_registry.remove(entry.pc_id)
        await sio.emit("stream_stopped", {}, to=sid)
        logger.info(f"Stream stopped for {sid[:8]}")
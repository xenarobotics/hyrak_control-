"""
Server-side video ingestion from the air unit's UDP RTP/H.265 stream.

communication/start-gs.sh's wfb_rx delivers this to 127.0.0.1:5600 (port is
configurable, see below) - the same stream communication/gst-decode.sh
plays for local preview, with these exact
caps: "application/x-rtp,media=video,encoding-name=H265,clock-rate=90000,
payload=96". Lets a session skip browser camera capture entirely and have
the backend read the drone's actual video feed straight off the network,
decoding it with the same aiortc/PyAV machinery (MediaPlayer) used for
prerecorded-file playback elsewhere in aiortc - the resulting track drops
into MultiModeVideoStreamTrack exactly like a browser-relayed camera track.
"""
import logging
import os
import tempfile

from aiortc.contrib.media import MediaPlayer

from app.webrtc.live_player import as_live

logger = logging.getLogger("verocore.webrtc.udp_video_source")

_SDP_TEMPLATE = """v=0
o=- 0 0 IN IP4 127.0.0.1
s=hyrak-air-unit
c=IN IP4 127.0.0.1
t=0 0
m=video {port} RTP/AVP 96
a=rtpmap:96 H265/90000
"""

# Keyed by port - the port is user-configurable (Settings), so a single
# cached path would silently keep serving the old port's SDP after a change.
_sdp_paths: dict[tuple, str] = {}


def _sdp_file(port: int, params: dict[int, bytes] | None = None) -> str:
    """SDP for the port. `params` (nal_type -> Annex-B VPS/SPS/PPS) become
    sprop-vps/sps/pps lines so ffmpeg's parser and decoder start from them:
    the air unit's encoder sends its VPS once per run, so a reader that opens
    mid-run would otherwise wait for the next sender restart."""
    fmtp = ""
    if params:
        import base64
        names = {32: "sprop-vps", 33: "sprop-sps", 34: "sprop-pps"}
        parts = []
        for t in (32, 33, 34):
            nal = params.get(t)
            if nal:
                nal = nal[4:] if nal[:4] == b"\x00\x00\x00\x01" else nal[3:] if nal[:3] == b"\x00\x00\x01" else nal
                parts.append(f"{names[t]}={base64.b64encode(nal).decode()}")
        if parts:
            fmtp = "a=fmtp:96 " + ";".join(parts) + "\n"
    key = (port, fmtp)
    path = _sdp_paths.get(key)
    if path is None or not os.path.exists(path):
        fd, path = tempfile.mkstemp(suffix=".sdp", prefix=f"hyrak_air_unit_{port}_")
        with os.fdopen(fd, "w") as f:
            f.write(_SDP_TEMPLATE.format(port=port) + fmtp)
        _sdp_paths[key] = path
        logger.info(f"Air-unit SDP written to {path}" + (" (with parameter sets)" if fmtp else ""))
    return path


def open_air_unit_video(
    port: int = 5600,
    timeout: float = 5.0,
    max_delay_us: int = 100_000,
):
    """Returns an aiortc-compatible video MediaStreamTrack reading the air
    unit's live RTP/H.265 UDP stream. Blocking (ffmpeg probes the stream
    synchronously) - call via loop.run_in_executor, never directly from an
    async handler. Raises if the stream can't be opened within `timeout`
    seconds (e.g. nothing transmitting on that port yet)."""
    sdp_path = _sdp_file(port)
    player = MediaPlayer(
        sdp_path,
        format="sdp",
        options={
            "protocol_whitelist": "file,udp,rtp",
            # ffmpeg's defaults are tuned for smooth VOD/file playback -
            # buffer and reorder packets for robustness, which on a live
            # feed just adds fixed, permanent glass-to-glass delay (this
            # is what was producing ~1s of extra lag vs. gst-decode.sh's
            # deliberately low rtpjitterbuffer latency=50). Trading
            # reorder robustness for latency is the right call on a local,
            # low-loss RF link.
            "fflags": "nobuffer",
            "flags": "low_delay",
            # Microseconds - RTP reorder window, and a FLOOR on latency: the
            # demuxer holds packets this long in case an earlier one is still in
            # flight. 100ms is right for the air unit's RF link, where reordering
            # is real. It is pure cost when the transport already guarantees
            # order - the DataChannel path runs SCTP with ordered:true, so it
            # passes 0 and gets that 100ms back. Measured: rtsp_datachannel was
            # ~250ms behind siyi_rtsp, and siyi_rtsp's reader sets no max_delay
            # at all, which is what pointed here.
            "max_delay": str(max_delay_us),
            "reorder_queue_size": "0",   # RTP jitter/reorder buffer, in packets
        },
        timeout=timeout,
    )
    # "sdp" is not in aiortc's REAL_TIME_FORMATS either, so this path was
    # paced against PTS exactly like the SRT relay. See live_player.py.
    as_live(player, f"air-unit udp:{port}")
    if player.video is None:
        raise RuntimeError(
            f"No video stream on udp:{port} - is the air unit transmitting? "
            f"(communication/start-gs.sh on the ground-station side)"
        )
    logger.info(f"Air-unit video opened from udp:{port}")
    return player.video

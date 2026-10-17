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

def _sdp_file(port: int, params: dict[int, bytes] | None = None) -> str:
    """Writes the SDP for the port to a fresh temp file and returns its path.
    The CALLER removes it once ffmpeg has read it (open_air_unit_video does,
    in a finally). It used to be cached per (port, params) and never
    unlinked, so every distinct parameter set left a file in /tmp for the
    life of the machine.

    `params` (nal_type -> Annex-B VPS/SPS/PPS) become sprop-vps/sps/pps
    lines so ffmpeg's parser and decoder start from them: the air unit's
    encoder sends its VPS once per run, so a reader that opens mid-run would
    otherwise wait for the next sender restart."""
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
    fd, path = tempfile.mkstemp(suffix=".sdp", prefix=f"hyrak_air_unit_{port}_")
    with os.fdopen(fd, "w") as f:
        f.write(_SDP_TEMPLATE.format(port=port) + fmtp)
    logger.debug(f"Air-unit SDP written to {path}" + (" (with parameter sets)" if fmtp else ""))
    return path


def _remove_sdp(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


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
    try:
        player = _open_player(sdp_path, port, timeout, max_delay_us)
    finally:
        # ffmpeg reads the SDP synchronously inside MediaPlayer(); nothing
        # needs the file after that.
        _remove_sdp(sdp_path)
    if player.video is None:
        raise RuntimeError(
            f"No video stream on udp:{port} - is the air unit transmitting? "
            f"(communication/start-gs.sh on the ground-station side)"
        )
    logger.info(f"Air-unit video opened from udp:{port}")
    return player.video


def _open_player(sdp_path: str, port: int, timeout: float, max_delay_us: int) -> MediaPlayer:
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
    return player

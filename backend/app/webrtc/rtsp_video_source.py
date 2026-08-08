"""
Server-side video ingestion from an RTSP camera — e.g. a SIYI gimbal/transmission
module, which exposes its feed at rtsp://<ip>:8554/video1. Same idea as
udp_video_source.py's air-unit ingestion (backend reads the feed straight off
the network instead of the browser capturing a webcam), but RTSP is directly
openable by aiortc's MediaPlayer — no SDP-file trick needed.
"""
import logging

from aiortc.contrib.media import MediaPlayer

from app.webrtc.live_player import as_live

logger = logging.getLogger("verocore.webrtc.rtsp_video_source")


def open_rtsp_video(url: str, timeout: float = 15.0):
    """Returns an aiortc-compatible video MediaStreamTrack reading a live
    RTSP camera feed. Blocking (ffmpeg probes the stream synchronously) —
    call via loop.run_in_executor, never directly from an async handler.
    Raises if the stream can't be opened within `timeout` seconds (e.g. the
    camera is unreachable or not powered on).

    15s default (vs. udp_video_source's 5s for a local loopback stream):
    RTSP's DESCRIBE/SETUP/PLAY handshake plus waiting for a first decodable
    H.265 keyframe routinely takes several seconds over a real network —
    5s was tripping PyAV's own open/probe timeout ("Immediate exit
    requested") on a perfectly healthy SIYI stream."""
    player = MediaPlayer(
        url,
        options={
            # Most RTSP cameras (SIYI included) drop packets over the UDP
            # default on anything but a pristine LAN; TCP trades a little
            # latency for a stream that doesn't fall apart on real WiFi.
            "rtsp_transport": "tcp",
        },
        timeout=timeout,
    )
    # A no-op for real `rtsp://` (aiortc already treats that format as live),
    # but this accepts any URL the operator types — an http/mjpeg or file URL
    # would otherwise be PTS-paced. Uniform invariant: nothing reaches
    # MultiModeVideoStreamTrack still throttled.
    as_live(player, f"rtsp {url}")
    if player.video is None:
        raise RuntimeError(f"No video stream at {url} — is the camera powered on and reachable?")
    logger.info(f"RTSP video opened from {url}")
    return player.video

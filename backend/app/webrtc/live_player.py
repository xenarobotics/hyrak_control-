"""Disables aiortc's playback throttle on live sources.

aiortc decides whether a MediaPlayer is "live" by looking up the container
format in `REAL_TIME_FORMATS`:

    ['alsa', 'android_camera', 'avfoundation', 'bktr', 'decklink', 'dshow',
     'fbdev', 'gdigrab', 'iec61883', 'jack', 'kmsgrab', 'openal', 'oss',
     'pulse', 'sndio', 'rtsp', 'v4l2', 'vfwcap', 'x11grab']

That list contains capture devices and `rtsp`. It does NOT contain `mpegts`
(our SRT relay, opened as `udp://…`) or `sdp` (the air-unit RTP path). So
aiortc classifies both of those as *recorded media* and enables
`_throttle_playback`, which makes `PlayerStreamTrack.recv()` sleep until each
frame's PTS is due:

    if self._start is None:
        self._start = time.time() - data_time
    else:
        wait = self._start + data_time - time.time()
        await asyncio.sleep(wait)

For a file that is correct — it is what stops you decoding a movie at 900fps.
For a live feed it is actively harmful, and on our pipeline it was
catastrophic, because it interacts with `MultiModeVideoStreamTrack.
_skip_to_live_edge()`:

  1. `_start` is pinned once, on the first frame.
  2. The live-edge skipper drops the queued backlog and returns the NEWEST
     frame — jumping the PTS forward by however much had accumulated.
  3. The next `recv()` therefore holds a frame whose PTS is ~1 backlog ahead
     of `_start + elapsed`, so the throttle sleeps for the whole backlog.
  4. While it sleeps, another backlog accumulates. Go to 2.

The two mechanisms fight: one skips forward in stream time, the other insists
on sleeping that time off. It self-balances at *one frame per backlog*, which
is why the field logs read `1.0 fps delivered downstream` — identically, every
five seconds — while ~140 frames per 5s were arriving perfectly well. The
symptom looked exactly like a compute bottleneck and was not one: the same
track sustains 28.5 fps with real YOLO when the throttle is off.

This also explains why SIYI over RTSP never showed the problem. `rtsp` IS in
the list, so that path was never throttled.

Live sources pace themselves — that is what makes them live. Anything opened
here is arriving from a socket in real time, so the only correct playback rate
is "as fast as it arrives".
"""

import logging

from aiortc.contrib.media import MediaPlayer

logger = logging.getLogger("verocore.webrtc.live_player")


def as_live(player: MediaPlayer, what: str) -> MediaPlayer:
    """Marks `player` as a real-time source and returns it.

    Safe if aiortc already classified it as live (rtsp), and safe if a future
    aiortc renames the attribute — a missing throttle is the behaviour we
    want, so this must never be able to break stream startup.
    """
    try:
        if getattr(player, "_throttle_playback", False):
            player._throttle_playback = False
            logger.info(f"{what}: disabled aiortc playback throttle (live source)")
    except Exception:                                    # pragma: no cover
        logger.warning(
            f"{what}: could not clear aiortc's playback throttle — if video "
            "arrives at ~1 fps while the source is healthy, this is why."
        )
    return player

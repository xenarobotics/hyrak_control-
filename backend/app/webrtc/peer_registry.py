"""
Tracks all active WebRTC PeerConnections.
Keyed by pc_id (uuid), linked to session_id.

OWNERSHIP LIVES ON THE ENTRY. The shared feed port (feeds.py) and the relay
ingest (relay_video_source.py) used to be keyed by session, and released by
whichever PeerConnection happened to change state. A re-offer on the same
socket then had two entries for one session, and the OLD pc closing released
the port and the ffmpeg listener the NEW pc had just attached to: black video
and a leaked port (audit B5). Now the entry that acquired a resource is the
only thing that can release it, and that happens exactly once, in remove().
"""
import asyncio
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from aiortc import RTCPeerConnection
from aiortc.contrib.media import MediaStreamTrack

logger = logging.getLogger("verocore.webrtc.registry")


@dataclass
class PeerEntry:
    pc_id:      str
    session_id: str
    socket_id:  str
    pc:         RTCPeerConnection
    tracks:     List[MediaStreamTrack] = field(default_factory=list)
    pending_ice: list = field(default_factory=list)
    # Client-overlay streams have no outgoing track; this task pulls
    # frames through the pipeline instead.
    drive_task: Optional[asyncio.Task] = None
    # The 10 s outbound-stats logger for this pc; cancelled with the entry.
    stats_task: Optional[asyncio.Task] = None
    # Shared feed port (feeds.acquire) this pc holds one ref on, if any.
    feed_port: Optional[int] = None
    # True when this pc is the consumer of the session's relay ingest
    # (relay_video_source). Transferred, not duplicated, on a re-offer.
    owns_relay: bool = False


class PeerRegistry:
    def __init__(self):
        self._peers: Dict[str, PeerEntry] = {}

    def add(self, entry: PeerEntry):
        self._peers[entry.pc_id] = entry
        logger.info(f"Peer added: {entry.pc_id[:8]} session={entry.session_id[:8]}")

    def get(self, pc_id: str) -> Optional[PeerEntry]:
        return self._peers.get(pc_id)

    def get_by_socket(self, socket_id: str) -> Optional[PeerEntry]:
        for e in self._peers.values():
            if e.socket_id == socket_id:
                return e
        return None

    def get_by_session(self, session_id: str) -> Optional[PeerEntry]:
        for e in self._peers.values():
            if e.session_id == session_id:
                return e
        return None

    async def remove(self, pc_id: str):
        entry = self._peers.pop(pc_id, None)
        if not entry:
            return
        if entry.drive_task:
            entry.drive_task.cancel()
        if entry.stats_task:
            entry.stats_task.cancel()
        for track in entry.tracks:
            try:
                track.stop()
            except Exception:
                pass
        try:
            await entry.pc.close()
        except Exception:
            pass
        await self._release_resources(entry)
        logger.info(f"Peer removed: {pc_id[:8]}")

    async def _release_resources(self, entry: PeerEntry) -> None:
        """Free what THIS entry acquired - never anything keyed by session
        that another entry may be using."""
        fp, entry.feed_port = entry.feed_port, None
        if fp is not None:
            try:
                from app.webrtc import feeds
                await feeds.release(fp)
            except Exception as e:
                logger.warning(f"Peer {entry.pc_id[:8]}: feed udp:{fp} release failed: {e}")
        if entry.owns_relay:
            entry.owns_relay = False
            try:
                from app.webrtc import relay_video_source
                await relay_video_source.release_async(entry.session_id)
            except Exception as e:
                logger.warning(f"Peer {entry.pc_id[:8]}: relay release failed: {e}")

    @property
    def count(self) -> int:
        return len(self._peers)

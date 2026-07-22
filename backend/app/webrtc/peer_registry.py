"""
Tracks all active WebRTC PeerConnections.
Keyed by pc_id (uuid), linked to session_id.
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
        for track in entry.tracks:
            try:
                track.stop()
            except Exception:
                pass
        try:
            await entry.pc.close()
        except Exception:
            pass
        logger.info(f"Peer removed: {pc_id[:8]}")

    @property
    def count(self) -> int:
        return len(self._peers)
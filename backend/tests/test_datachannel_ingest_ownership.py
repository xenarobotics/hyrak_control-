"""
Audit B18: the DataChannel ingest keeps its PeerConnection, closes the one a
re-offer replaces, and is torn down only by the pc that currently feeds it.
"""
import asyncio

from aiortc import RTCPeerConnection

from app.webrtc import datachannel_video_source as dc


async def test_reoffer_closes_previous_pc_and_keeps_port():
    ingest = dc.allocate("sess-dc-1")
    try:
        pc1, pc2 = RTCPeerConnection(), RTCPeerConnection()
        await ingest.attach_pc(pc1)
        port = ingest.loopback_port
        assert dc.allocate("sess-dc-1") is ingest, "re-offer must reuse the live ingest"
        await ingest.attach_pc(pc2)
        assert pc1.connectionState == "closed"
        assert pc2.connectionState != "closed"
        assert ingest.pc is pc2 and ingest.loopback_port == port
    finally:
        await dc.release_async("sess-dc-1")


async def test_superseded_pc_cannot_release_the_ingest():
    ingest = dc.allocate("sess-dc-2")
    pc1, pc2 = RTCPeerConnection(), RTCPeerConnection()
    try:
        await ingest.attach_pc(pc1)
        await ingest.attach_pc(pc2)
        assert await dc.release_if_owner("sess-dc-2", pc1) is False
        assert dc.get("sess-dc-2") is ingest and not ingest.closed
        assert await dc.release_if_owner("sess-dc-2", pc2) is True
        assert dc.get("sess-dc-2") is None
        assert ingest.closed and pc2.connectionState == "closed"
    finally:
        await dc.release_async("sess-dc-2")
        await pc1.close()
        await pc2.close()


async def test_release_async_closes_the_pc():
    ingest = dc.allocate("sess-dc-3")
    pc = RTCPeerConnection()
    await ingest.attach_pc(pc)
    await dc.release_async("sess-dc-3")
    assert pc.connectionState == "closed"
    assert ingest.pc is None and ingest.closed


async def test_sync_release_schedules_pc_close_on_the_running_loop():
    ingest = dc.allocate("sess-dc-4")
    pc = RTCPeerConnection()
    await ingest.attach_pc(pc)
    dc.release("sess-dc-4")           # server.py's teardown path
    await asyncio.sleep(0.05)
    assert pc.connectionState == "closed"

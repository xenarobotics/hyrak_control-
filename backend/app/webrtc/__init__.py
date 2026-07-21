"""
WebRTC package init — raises aiortc's hard-coded encoder bitrate ceilings
before any peer connection is created (signaling imports this package first).

Stock aiortc caps the outgoing (processed) video at 1.5 Mbps VP8 / 3 Mbps
H264 and *starts* at 0.5/1 Mbps. 1080p at those rates is heavily smeared —
the receiver's bandwidth estimate (REMB) can never push the encoder past
the cap. The caps below let quality scale to what the link actually
supports; the encoder still adapts downward on congestion.
"""
from aiortc.codecs import h264, vpx

vpx.DEFAULT_BITRATE = 3_000_000
vpx.MAX_BITRATE = 12_000_000
h264.DEFAULT_BITRATE = 3_000_000
h264.MAX_BITRATE = 12_000_000

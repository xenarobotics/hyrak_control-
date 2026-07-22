"""
Cloudflare TURN credential minting.

STUN alone fails on networks that block UDP or use symmetric NAT (campus /
corporate WiFi) — media then needs a TURN relay, ideally turns: over TCP/TLS
which looks like ordinary HTTPS to the firewall. Cloudflare's TURN service
doesn't use static passwords: we hold a key ID + API token in .env and ask
their API for short-lived credentials, which both the browser and aiortc use.
"""
import logging
import time

import httpx

from app.config import get_settings

logger = logging.getLogger("verocore.webrtc.turn")

_CF_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
_TTL_SECONDS = 86400          # credentials valid 24h
_REFRESH_MARGIN = 3600        # mint fresh ones when <1h of life remains

# Served when no TURN key is configured or Cloudflare is unreachable —
# same as the previous hardcoded behaviour, direct paths only.
STUN_FALLBACK = [{"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]}]

_cache: list | None = None
_cache_expires: float = 0.0


async def get_ice_servers() -> list[dict]:
    global _cache, _cache_expires
    settings = get_settings()
    if not settings.turn_key_id or not settings.turn_api_token:
        return STUN_FALLBACK

    now = time.time()
    if _cache is not None and now < (_cache_expires - _REFRESH_MARGIN):
        return _cache

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                _CF_URL.format(key_id=settings.turn_key_id),
                headers={"Authorization": f"Bearer {settings.turn_api_token}"},
                json={"ttl": _TTL_SECONDS},
            )
            resp.raise_for_status()
            data = resp.json()
        servers = data.get("iceServers", [])
        # Older Cloudflare endpoint returns a single object, not a list
        if isinstance(servers, dict):
            servers = [servers]
        if not servers:
            raise ValueError(f"no iceServers in response: {data}")
        _cache = servers
        _cache_expires = now + _TTL_SECONDS
        logger.info("Minted Cloudflare TURN credentials (ttl %ds)", _TTL_SECONDS)
        return _cache
    except Exception as e:
        logger.warning(f"TURN credential mint failed, serving STUN-only: {e}")
        # Serve stale credentials over none if we have them
        return _cache if _cache is not None else STUN_FALLBACK

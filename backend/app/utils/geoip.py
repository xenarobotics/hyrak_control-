"""
IP → approximate location, for placing clients on the admin map when their
drone has no GPS fix. Uses ip-api.com (free tier, 45 req/min) with an
in-memory cache; a private/loopback client IP (LAN clients, or anything
that slipped past the tunnel headers) falls back to the SERVER's public
location, which is the right approximation for a LAN client anyway.
"""
import logging
import time
from ipaddress import ip_address

import httpx

logger = logging.getLogger("verocore.geoip")

_cache: dict[str, tuple[float, dict | None]] = {}
_TTL = 24 * 3600


def _is_private(ip: str) -> bool:
    try:
        a = ip_address(ip)
        return a.is_private or a.is_loopback or a.is_link_local
    except ValueError:
        return True


async def locate(ip: str | None) -> dict | None:
    """Returns {lat, lng, city, country} or None. Never raises."""
    key = ip if (ip and not _is_private(ip)) else "self"
    now = time.time()
    hit = _cache.get(key)
    if hit and (now - hit[0]) < _TTL:
        return hit[1]

    url = "http://ip-api.com/json/" if key == "self" else f"http://ip-api.com/json/{key}"
    result = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, params={"fields": "status,lat,lon,city,country"})
            data = resp.json()
            if data.get("status") == "success":
                result = {
                    "lat": data["lat"],
                    "lng": data["lon"],
                    "city": data.get("city", ""),
                    "country": data.get("country", ""),
                }
    except Exception as e:
        logger.warning(f"GeoIP lookup failed for {key}: {e}")

    _cache[key] = (now, result)
    return result

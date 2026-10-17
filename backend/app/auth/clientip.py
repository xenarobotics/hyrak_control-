"""
The client's real address, without trusting a header anyone can set.

Behind the Cloudflare tunnel the socket peer is loopback and the real
address is in CF-Connecting-IP (then X-Forwarded-For). Off the tunnel, a
client on the LAN could send those same headers to dodge the login rate
limit or forge the admin map; so the headers are honoured only when the
socket peer is a trusted proxy (TRUSTED_PROXIES in .env, comma-separated
IPs or CIDRs, default loopback only). Used by the login route and the
socket connect handler alike.
"""
from __future__ import annotations

import ipaddress
import logging

from app.config import get_settings

logger = logging.getLogger("verocore.auth.clientip")

_networks_cache: tuple[str, list] | None = None


def _trusted_networks() -> list:
    global _networks_cache
    raw = (get_settings().trusted_proxies or "").strip()
    if _networks_cache is not None and _networks_cache[0] == raw:
        return _networks_cache[1]
    nets = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            logger.warning(f"TRUSTED_PROXIES: ignoring unparseable entry {item!r}")
    _networks_cache = (raw, nets)
    return nets


def is_trusted_proxy(peer: str | None) -> bool:
    if not peer:
        return False
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in net for net in _trusted_networks())


def client_ip_from(peer: str | None, cf_connecting_ip: str | None,
                   x_forwarded_for: str | None) -> str:
    """The address to log, rate-limit and geolocate."""
    if is_trusted_proxy(peer):
        forwarded = (cf_connecting_ip or "").strip() or (x_forwarded_for or "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return (peer or "").strip() or "-"

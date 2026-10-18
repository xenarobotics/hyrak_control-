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


def _from_xff(x_forwarded_for: str | None) -> str | None:
    """The client per X-Forwarded-For, read from the RIGHT.

    Each proxy appends the address it received from, so only the entries a
    trusted proxy wrote can be believed; anything to their left was supplied
    by the client and is free text. Walk right to left and stop at the first
    address that is not one of our proxies. An unparseable entry ends the
    walk with no answer (the caller falls back to the socket peer)."""
    entries = [e.strip() for e in (x_forwarded_for or "").split(",") if e.strip()]
    for entry in reversed(entries):
        try:
            ipaddress.ip_address(entry)
        except ValueError:
            return None
        if not is_trusted_proxy(entry):
            return entry
    return None


def client_ip_from(peer: str | None, cf_connecting_ip: str | None,
                   x_forwarded_for: str | None) -> str:
    """The address to log, rate-limit and geolocate."""
    if is_trusted_proxy(peer):
        # cloudflared sets CF-Connecting-IP itself (overwriting any client
        # value), and it is only read when the peer is a trusted proxy.
        cf = (cf_connecting_ip or "").strip()
        if cf:
            return cf
        forwarded = _from_xff(x_forwarded_for)
        if forwarded:
            return forwarded
    return (peer or "").strip() or "-"


def client_ip(request) -> str:
    """client_ip_from for a FastAPI / Starlette request."""
    h = request.headers
    return client_ip_from(request.client.host if request.client else None,
                          h.get("cf-connecting-ip"), h.get("x-forwarded-for"))

#!/usr/bin/env bash
# Rebuild the SRT relay VPS.
#
# Run this ON A FRESH VPS, as root. It is idempotent — running it twice is
# safe. See docs/DISASTER_RECOVERY.md §3 for what this box is for.
#
# WHAT THIS BOX EXISTS TO DO
#   The HYRAK server sits behind double NAT on a restrictive network, so it has
#   no inbound public address. This VPS provides one: it accepts SRT on a
#   public IPv4 and DNATs it down a WireGuard tunnel to the server. That is
#   what makes "server on our network, client device anywhere" work at all —
#   and it is why a mesh VPN is not a substitute. A mesh needs software on
#   every client; this needs software on none.
#
# THE PORT RANGE IS 3478-3578. NOT 9000-9100.
#   Getting this wrong does not fail loudly. The relay allocates a listener on
#   3478, the client pushes to a port this box is not forwarding, and the
#   server reports "No video arrived on srt:3478 within 25s" — indistinguishable
#   from the VPS being down. The docs said 9000-9100 until 2026-08-18 and cost
#   a live debugging session.
#
#   3478 is the STUN port: any network that permits video calling permits it.
#   9000 was MEASURED to be dropped on the operator's own network while 3478
#   and 8801 got through, so the old range does not merely mismatch the code —
#   it reinstates the failure the change was made to fix.
#
# Usage:
#   ./rebuild-srt-relay.sh <server-wireguard-public-key>
#
# The server's public key comes from the HYRAK machine:
#   sudo wg show wg0 public-key      # or: wg pubkey < /etc/wireguard/private.key
#
# NOTHING SECRET IS PRINTED. The VPS private key is written to
# /etc/wireguard/ with mode 600 and never echoed; only the PUBLIC key is shown,
# because the server needs it.
set -euo pipefail

PEER_PUBKEY="${1:-}"
if [[ -z "$PEER_PUBKEY" ]]; then
    echo "usage: $0 <server-wireguard-public-key>" >&2
    echo "get it on the HYRAK server with: sudo wg show wg0 public-key" >&2
    exit 2
fi

WG_IF=wg0
WG_PORT=51820
VPS_ADDR=10.9.0.1
SERVER_ADDR=10.9.0.2
RELAY_PORT_LO=3478          # keep in step with _PUBLIC_PORT_BASE
RELAY_PORT_HI=3578          # keep in step with _PUBLIC_PORT_LIMIT

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard iptables-persistent netfilter-persistent

echo "==> wireguard keys"
umask 077
mkdir -p /etc/wireguard
if [[ ! -f /etc/wireguard/private.key ]]; then
    wg genkey > /etc/wireguard/private.key
    wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key
fi
chmod 600 /etc/wireguard/private.key

# The WAN interface, discovered rather than assumed — Vultr images have used
# both ens3 and enp1s0, and a hardcoded name silently breaks the return path.
WAN_IF="$(ip route show default | awk '/default/ {print $5; exit}')"
echo "    wan interface: $WAN_IF"

echo "==> ${WG_IF}.conf"
cat > "/etc/wireguard/${WG_IF}.conf" <<EOF
[Interface]
Address    = ${VPS_ADDR}/24
ListenPort = ${WG_PORT}
PostUp     = sysctl -w net.ipv4.ip_forward=1
# The server dials OUT to here, so this end never needs the peer's endpoint.
PrivateKey = $(cat /etc/wireguard/private.key)

[Peer]
# The HYRAK server.
PublicKey  = ${PEER_PUBKEY}
AllowedIPs = ${SERVER_ADDR}/32
EOF
chmod 600 "/etc/wireguard/${WG_IF}.conf"

echo "==> forwarding"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

echo "==> nat rules for udp ${RELAY_PORT_LO}-${RELAY_PORT_HI}"
# -C tests for the rule first so re-running does not stack duplicates.
add_rule() {
    local table="$1"; shift
    iptables -t "$table" -C "$@" 2>/dev/null || iptables -t "$table" -A "$@"
}
add_rule nat PREROUTING -i "$WAN_IF" -p udp \
    --dport "${RELAY_PORT_LO}:${RELAY_PORT_HI}" \
    -j DNAT --to-destination "${SERVER_ADDR}"
add_rule nat POSTROUTING -o "$WG_IF" -p udp \
    --dport "${RELAY_PORT_LO}:${RELAY_PORT_HI}" \
    -j MASQUERADE
add_rule filter FORWARD -i "$WAN_IF" -o "$WG_IF" -p udp \
    --dport "${RELAY_PORT_LO}:${RELAY_PORT_HI}" -j ACCEPT
add_rule filter FORWARD -i "$WG_IF" -o "$WAN_IF" -j ACCEPT

echo "==> persist"
# THE STEP THAT WAS MISSED LAST TIME. Without it the rules vanish on reboot and
# the box comes back looking healthy while forwarding nothing — see
# KNOWN_ISSUES.md.
netfilter-persistent save

echo "==> enable"
systemctl enable --now "wg-quick@${WG_IF}"
systemctl restart "wg-quick@${WG_IF}"

PUBLIC_IP="$(ip -4 addr show "$WAN_IF" | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)"

cat <<EOF

────────────────────────────────────────────────────────────────────
 SRT relay is up.

 VPS public key : $(cat /etc/wireguard/public.key)
 VPS public IP  : ${PUBLIC_IP}
 Tunnel         : ${VPS_ADDR} (vps) <-> ${SERVER_ADDR} (hyrak server)
 Forwarding     : udp ${RELAY_PORT_LO}-${RELAY_PORT_HI} -> ${SERVER_ADDR}

 ON THE HYRAK SERVER:
   1. Put the VPS public key above into /etc/wireguard/wg0.conf as the peer,
      with Endpoint = ${PUBLIC_IP}:${WG_PORT}, AllowedIPs = 10.9.0.0/24,
      and PersistentKeepalive = 25 (the server is the one behind NAT, so it
      must keep the mapping alive; without this the tunnel dies when idle).
   2. sudo systemctl restart wg-quick@wg0
   3. Set RELAY_PUBLIC_HOST=${PUBLIC_IP} in the root .env
   4. Restart the backend.

 VERIFY, in this order — each step rules out the one below it:
   ping 10.9.0.1                       from the server: tunnel up
   sudo wg show                        a recent handshake, not "never"
   nc -u -z -v ${PUBLIC_IP} 3478       from a CLIENT network: port open
   then start a session and watch for
   "Relay ingest ... listening srt:3478" followed by frames, not a 25s timeout
────────────────────────────────────────────────────────────────────
EOF

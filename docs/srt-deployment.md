# SRT deployment requirements

What has to be true for `air_unit_srt` / `rtsp_relay` (SRT transport) to work
with a **remote client and a hosted server**. Everything below is checked
against the code and the shipped binaries, not assumed — measured values are
marked.

SRT is the premium path, not the default. It needs infrastructure the
DataChannel transport does not, and it cannot work at all on a UDP-blocked
network. Ship DataChannel as the transport that always connects; enable SRT
per-deployment once the server has a real address.

---

## 1. Server: a directly reachable public address

**This is the blocker today.** `relay_public_host` is currently
`10.183.197.7` — RFC1918 private — while the machine's egress is
`27.59.61.160`. SRT therefore works only when client and server share a LAN.

Required:

| Item | Value |
|---|---|
| Public address | A real inbound-reachable IPv4, static or stable DNS |
| Inbound UDP | **3478–3578** open to the internet |
| Config | `RELAY_PUBLIC_HOST=<that address>` |
| NAT | If behind NAT, forward UDP 3478–3578 to the server |
| CGNAT | **Will not work** — no inbound path exists. Needs a VPS or equivalent |

### Why it cannot use the tunnel

`cloudflared` proxies HTTP (and TCP via `cloudflared access`). It carries **no
arbitrary inbound UDP**, so the SRT listener has to be exposed directly.
Signalling, the API and `/releases` keep going through the tunnel as they do
now — only this one listener needs a raw port.

Cloudflare Spectrum does carry UDP but is an Enterprise product; not a
practical answer at this stage.

### Port budget

`_PUBLIC_PORT_BASE=3478 … _PUBLIC_PORT_LIMIT=3578` → **100 concurrent relay
sessions**. Each session also takes one loopback port from `5700–5800`
(internal only, never exposed). Raise both ranges together if more concurrency
is needed.

---

## 2. Server: system ffmpeg with libsrt

PyAV's bundled FFmpeg has **no libsrt** — it raises `ProtocolNotFoundError` on
any `srt://` URL. That is why a standalone ffmpeg receives the SRT connection
and remuxes to loopback UDP, which PyAV opens happily.

```
verify:  ffmpeg -protocols | grep -x srt
         ffmpeg -buildconf | grep libsrt
```

Confirmed present on the current dev machine (`--enable-libsrt`). **This must
be checked on any new host** — many distro builds omit it. Without it,
`RelayIngest.start()` raises and the mode is unusable.

---

## 3. Client: nothing to install

Confirmed on the shipped binaries — no action needed:

| Build | libsrt |
|---|---|
| Linux `ffmpeg-static` | ✅ `--enable-libsrt` |
| Windows `ffmpeg.exe` | ✅ `--enable-libsrt` |

Client requirements are only:

- HYRAK desktop app (browser cannot run the relay)
- **Outbound UDP** to the server's port — a UDP-blocking network kills SRT
  outright, with no TLS/443 fallback of the kind TURN provides
- For `air_unit_srt`: `wfb_rx` delivering RTP/H.265 to `udp:5600` locally

---

## 4. Authentication and encryption

Every relay session generates a token used as the SRT **passphrase**
(`pbkeylen=16`, `enforced_encryption=1`). This gives admission control and
AES-128 on the wire in one mechanism.

Verified against a live listener:

```
wrong passphrase     REJECTED
no passphrase        REJECTED
correct passphrase   ACCEPTED
```

This is **required**, not optional, because the listener sits on a raw public
port. Before it existed, `streamid` was sent but never inspected, so any caller
reaching the port was accepted.

The passphrase is redacted from logs and status events on the client. It is
delivered over the authenticated socket.io connection.

---

## 5. Latency configuration

SRT's `latency` is a configured **budget**, not an emergent value: loss is
retransmitted inside that window, and anything not recovered in time is
dropped. It is therefore also a floor on glass-to-glass delay.

```
latency >= 2.5 x RTT    minimum useful
latency ~= 4 x RTT      comfortable on a lossy link
```

Measured RTT to a CDN edge from the dev machine: **35.7ms** (ICMP avg), **29ms**
TCP connect. Default is now **120ms** (~3.4x).

Three places must agree — `relay_latency_ms` is the one that actually wins:

| Where | Constant |
|---|---|
| `backend/app/config.py` | `relay_latency_ms` ← **effective value** |
| `backend/app/webrtc/relay_video_source.py` | `DEFAULT_LATENCY_MS` |
| `frontend/src/lib/videoSource.ts` | `DEFAULT_RELAY_LATENCY_MS` |

Re-tune per deployment: measure RTT from a representative client to the
server, then set ~3–4x that.

---

## 6. Interim option without a VPS: overlay network

To test SRT before hosting is sorted, put client and server on a WireGuard or
Tailscale overlay and set `RELAY_PUBLIC_HOST` to the server's overlay address
(`100.x` on Tailscale). The overlay handles NAT traversal, so no port
forwarding is needed.

Caveat worth measuring rather than assuming: if the overlay falls back to its
own relay (DERP on Tailscale), an extra hop has been added and the latency
advantage over the DataChannel may disappear. Compare, don't assume.

---

## 7. Checklist

```
SERVER
  [ ] public, inbound-reachable address (not CGNAT)
  [ ] UDP 3478-3578 open / forwarded
  [ ] RELAY_PUBLIC_HOST set to that address
  [ ] ffmpeg on PATH with --enable-libsrt
  [ ] relay_latency_ms tuned to ~3-4x measured client RTT
  [ ] concurrency: 100 sessions max, or widen both port ranges

CLIENT
  [ ] HYRAK desktop app (not a browser tab)
  [ ] outbound UDP permitted to the server port
  [ ] wfb_rx delivering to udp:5600  (air_unit_srt only)

VERIFY
  [ ] Settings shows the relay host as configured, not "unconfigured"
  [ ] a wrong passphrase is rejected by the listener
  [ ] track opens and frames decode end to end
```

---

## 8. Known rough edges

- **`open_track` takes ~12s** to first frame in testing (measured against a
  synthetic source), waiting out the retry loop and ffmpeg's MPEG-TS probe.
  Inside the 25s timeout but slow enough that an operator notices. Not yet
  tuned against a real link.
- **MPEG-TS overhead**: the SRT leg carries MPEG-TS, ~5–10% more bytes than the
  raw RTP the DataChannel forwards, plus a little packetisation latency.
- **No transcode is removed.** The server still re-encodes to H.264 for the
  browser because aiortc cannot negotiate H.265 — measured at **0.79 core per
  1080p session**. SRT changes only the client→server leg.
- **Untested on real hardware.** SRT has been verified end to end against a
  generated 1080p H.265 clip, not the RF link: actual latency, behaviour under
  RF loss, and real-world reachability are all still open.

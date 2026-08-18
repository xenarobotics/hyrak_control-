# Disaster recovery — rebuilding HYRAK from nothing

What you need to reconstruct a working system if this laptop dies, the VPS is
wiped, or the repo is the only thing left.

**This file contains no secrets and never should.** It records *where each
secret lives, what it is for, and how to reissue it*. A runbook that leaks the
thing it documents is worse than no runbook, because it turns one lost laptop
into a compromised deployment. Everything below is deliberately a pointer.

> If you are reading this after losing a machine, start at §6 (Recovery order).

---

## 1. What must be backed up that git does NOT hold

Git has the source. These are the things it deliberately does not, and losing
them costs real work:

| What | Where | Why git does not have it | How bad if lost |
|---|---|---|---|
| `.env` (root) | `hyrak_control/.env` | gitignored — holds `SECRET_TOKEN`, `DATABASE_URL`, TURN keys | **High** — reissue every credential |
| Postgres data | local Postgres, db per `DATABASE_URL` | a database, not source | **High** — plate history, crowd history, face gallery |
| Face gallery images | `.data/face_gallery/<person_id>/` | binary captures | **High** — enrolments must be redone from people you may not have access to again |
| Plate/vehicle captures | `.data/plate_captures/<session>/` | evidence images | Medium — historical only |
| RF encryption keys | `decoder/build/keys/gs.key`, `drone.key` | gitignored; `decoder/` is deliberately not a git repo | **Critical** — must match the key flashed on the air unit, cannot be regenerated independently |
| VPS WireGuard keys | on the VPS + this laptop | private keys | Medium — reissuable, but both ends must be redone together |
| PX4 airframe params | on the flight controller | lives on the FC | Medium — re-tunable but tedious |

**Minimum viable backup** — put these somewhere off this machine:

```
hyrak_control/.env
decoder/build/keys/            # gs.key + drone.key — RF link is dead without them
.data/face_gallery/            # enrolled identities
pg_dump of the hyrak database
```

`.data/plate_captures/` is optional (evidence, not config).

---

## 2. Credentials — what exists and how to reissue

Do **not** write values here. This is the index.

| Credential | Lives in | Used by | Reissue |
|---|---|---|---|
| `SECRET_TOKEN` | root `.env` + `frontend/.env.local` as `NEXT_PUBLIC_SECRET_TOKEN` | socket.io auth — **both must match** | Pick any random string; change both ends together |
| `DATABASE_URL` | root `.env` | Postgres | Recreate role + db, see §4 |
| `TURN_KEY_ID` / `TURN_API_TOKEN` | root `.env` | Cloudflare TURN for WebRTC | Regenerate in the Cloudflare dashboard |
| SRT passphrase | generated **per session** at runtime | SRT relay auth | Nothing to store — it is ephemeral by design |
| VPS root password | your password manager, **not here** | VPS console login | VPS provider console |
| WireGuard keys | VPS `/etc/wireguard/`, laptop `/etc/wireguard/` | tunnel to the VPS | `wg genkey`, update **both** peers |
| RF keys | `decoder/build/keys/` | wfb-ng link encryption | Must be regenerated **and reflashed to the air unit** — they are a matched pair |

**The one that bites:** `SECRET_TOKEN` is duplicated in two files. Changing one
and not the other produces a frontend that connects and then silently fails
auth — which looks like a broken backend.

---

## 3. VPS (SRT relay) — what it is and how to rebuild

Purpose: this server sits behind double NAT, so it has no inbound public
address. The VPS provides one, and a WireGuard tunnel carries SRT ingest back
here. Without it, SRT/`hyrak_receiver` transports cannot reach the server from
outside the LAN.

Rebuild:

1. Provision a small VPS with a **static public IPv4**.
2. Install WireGuard both ends; the VPS is the tunnel server.
   Address plan in use: VPS `10.9.0.1`, this machine `10.9.0.2`.
   SSH to the VPS is over the tunnel (`root@10.9.0.1`) — the public port 22
   is firewalled.
3. Open inbound **UDP 3478–3578** on the VPS and DNAT it over the tunnel to
   `10.9.0.2`. **Not 9000–9100** — see the warning below.
4. Set `RELAY_PUBLIC_HOST=<vps public ip>` in root `.env`.
> **The port range is 3478–3578, and getting it wrong fails silently.**
> This document said 9000–9100 until 2026-08-18, and `srt-deployment.md` said
> it in three places while its own checklist said 3478–3578. The code has been
> `_PUBLIC_PORT_BASE = 3478` since the change logged in CHANGELOG under
> "Relay ports 9000-9100 -> 3478-3578".
>
> A VPS rebuilt to the old range does not fail loudly. The relay allocates a
> listener on 3478, the client pushes to a port the VPS is not forwarding, and
> the server reports `No video arrived on srt:3478 within 25s` — identical to
> the VPS being down. That cost a live debugging session on 2026-08-18.
>
> Worse, 9000 is not merely stale: it is the port that was MEASURED to be
> dropped on the operator's network. `relay_video_source.py` records the test —
> UDP to 3478 and 8801 reached the relay while 443 and 9000 were dropped
> before leaving the network. Rebuilding to 9000–9100 reinstates the exact
> failure the change was made to fix.

5. **Persist the firewall** — `netfilter-persistent save`. Rules were left
   unsaved once and did not survive a reboot; see `KNOWN_ISSUES.md`.

See `docs/srt-deployment.md` for the full transport requirements and the
measured behaviour of each mode.

---

## 4. Postgres

```bash
# recreate
sudo -u postgres createuser --pwprompt hyrak
sudo -u postgres createdb -O hyrak hyrak
# point DATABASE_URL at it in .env, then:
cd backend && uv run alembic upgrade head
```

Backup / restore:

```bash
pg_dump "$DATABASE_URL" > hyrak-$(date +%F).sql
psql "$DATABASE_URL" < hyrak-YYYY-MM-DD.sql
```

Schema is entirely Alembic-managed — `alembic upgrade head` reconstructs it.
The **data** is what needs the dump.

Note the two categories the schema deliberately separates:
`crowd_snapshots` / `plate_events` describe a moment and are disposable;
`persons` / `person_faces` are durable biometric identity and are not.

---

## 5. Standing up the app from a clean machine

```bash
git clone <remote> hyrak_control && cd hyrak_control
cp .env.example .env          # then fill in — see §2
# frontend/.env.local needs NEXT_PUBLIC_SECRET_TOKEN matching SECRET_TOKEN

cd backend && uv sync && uv run alembic upgrade head
uv run python -m app.server            # or ./start.sh

cd ../frontend && npm install && npm run dev
```

Restore `.data/face_gallery/` and the Postgres dump before expecting face
recognition to know anyone.

---

## 6. Recovery order

1. Repo — `git clone`
2. `.env` (root) and `frontend/.env.local` — from backup, or reissue per §2
3. Postgres — create, `alembic upgrade head`, restore dump
4. `.data/face_gallery/` — restore, or re-enrol from the live feed
5. `decoder/build/keys/` — restore; **without these the RF link is dead** and
   the keys must match what is flashed on the air unit
6. VPS + WireGuard — §3, only needed for SRT transports
7. Verify: `cd backend && uv run pytest` should pass clean

---

## 7. Backup hygiene

- `.env.bak*` is now gitignored. It was **not**, and a timestamped backup of
  `.env` sat untracked in the repo root — one `git add .` from publishing every
  token in it.
- Commit often. A 17-day gap with 129 modified files happened once; the work
  survived only because the machine did.
- The two things with no substitute if lost are the **RF keys** (matched pair
  with the air unit) and the **face gallery** (people you may not be able to
  re-enrol). Everything else is reissuable.

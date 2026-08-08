# CONTRIBUTING

## Before you change anything

Read `AI_CONTEXT.md`, then `CURRENT_STATE.md`, then `SESSION_HANDOVER.md`.
For video work also read `video-transport-modes.md`. Check `ADR/` before
revisiting a decision — several were already made deliberately, with
alternatives recorded.

## Hard rules

1. **`communication/` is read-only.** It is the reference for the wfb-ng
   ground station. Never modify `start-gs.sh` or its siblings.
2. **Never print the socket.io shared secret** (`NEXT_PUBLIC_SECRET_TOKEN`,
   `secret_token`) or the TURN credentials in output, logs, or commits.
   Reference their presence; read them programmatically.
3. **Japesh runs all flight tests himself.** Do not launch autonomous test
   flights and do not write throwaway test scripts. Local diagnostic shell
   commands are encouraged.
4. **Do not strip the dense "why" comments.** Many encode a specific bug or
   constraint that cost days to find. If you change such code, update the
   comment rather than deleting it.
5. **Do not delete the v4l2loopback path** without reading ADR-003 — it is the
   only mode that works on UDP-blocking networks.

## Deploy discipline

| Change | What's needed |
|---|---|
| `frontend/**` | Nothing — `npm run dev` hot-reloads for browser *and* desktop users |
| `backend/**` | **Ask Japesh to `Ctrl+C` and rerun `./start.sh`.** There is no useful auto-reload |
| `desktop/src/**` or `desktop/build/**` | **Bump `desktop/package.json` version**, then `npm run deploy:local`. Skipping the bump makes electron-updater report clients as up-to-date |

## Verification before claiming done

```bash
cd backend  && python3 -m py_compile app/**/*.py
cd desktop  && npx tsc --noEmit -p tsconfig.json
cd frontend && node ./node_modules/typescript/bin/tsc --noEmit   # `tsc` alone may hit a permissions error
./scripts/sync-docs.sh                                            # documentation drift check
```

Report outcomes honestly: if something is unverified, say so. `KNOWN_ISSUES.md`
uses **MITIGATED** for "fix shipped, cause unproven" — use it.

## Debugging methodology (earned the hard way)

The 0.1.2 fix for the video Start failure was a plausible theory shipped
without reproduction, and it was **wrong**. The 0.1.3 fix came from
reproducing the failure with a synthetic stream. So:

1. **Reproduce before theorising.** Synthesise the input if you must —
   `ffmpeg -f lavfi -i testsrc2 ... -f rtp rtp://127.0.0.1:5600` stands in for
   the air unit; a tiny `dgram` script proves bind semantics.
2. **Verify the whole precondition chain** — device exists, ACL permits,
   module loaded, port free, capability *actually* works at runtime.
3. **Never trust a compile-time flag as a capability check** (ADR-005).
4. **Suspect silent success.** Both bugs this session shared one shape: an
   operation "succeeded" while delivering nothing. Any bind/open that can be
   silently useless needs a first-data signal.
5. **Check whether the feature already exists.** The server-sourced video path
   and the crowd/plate analyzers were both already built.

## Code conventions

**Backend (Python 3.11):** snake_case; `logging.getLogger("verocore.<area>")`
per module; guard every DB write with `db_available()` / `get_session()`;
blocking calls (ffmpeg probes, process kills) go through
`run_in_executor` — never on the event loop; every socket.io handler that
leaves the UI in a pending state must emit a terminal event (ADR-007).

**Frontend (Next.js/React):** `'use client'` where needed; Zustand for shared
state; camelCase; localStorage prefs namespaced `hyrak-*`; read localStorage
*after* mount to avoid hydration mismatches (see `VideoStream.tsx`'s
`isServerSourced`).

**Desktop (TypeScript/Electron):** implement `NativeBridge`, register in
`bridges/registry.ts` — nothing in `main.ts` or `preload.ts` should need to
change. Keep sockets and child processes in **main**; only frames or relayed
bytes cross IPC. Never send raw decoded video frames over IPC.

## Adding a video source

Four coordinated edits: `lib/videoSource.ts` (enum), `settings/page.tsx`
(`VideoGroup` chip + conditional `PrefRow`s), `webrtc/signaling.py` (source
branch, and the `server_sourced` tuple if applicable), and
`components/video/VideoStream.tsx` (what renders). Add a row to
`docs/video-transport-modes.md` with honest latency/CPU/bandwidth figures and a
"use when". Put the operator-facing guidance in the chip's `tip` — operators do
not read docs.

**Keep it a preset, not a knob.** Each enum value fixes source × transport ×
preview × downlink. Do not split those into separate settings (ADR-003).

## Documentation maintenance

Keep docs current in the same change as the code, not afterwards:

- New decision with alternatives → a new `docs/ADR/ADR-NNN-*.md`.
- Shipped change → append to `docs/CHANGELOG.md` (**append only**).
- Status change → edit `docs/CURRENT_STATE.md` and `docs/KNOWN_ISSUES.md`.
- End of a working session → add `docs/SESSION_LOGS/YYYY-MM-DD.md` and refresh
  `docs/SESSION_HANDOVER.md`.
- Touched a documented module → update `modules/<name>/`.

`./scripts/sync-docs.sh` reports drift (stale dates, version mismatches,
untracked files, missing module docs). It only reports; it never rewrites.
Consider wiring it as a git `pre-push` hook — see the script's header.

## Uncertainty

If you are not sure, write **"Needs verification."** Never invent a fact to
fill a documentation gap. Where code and docs disagree, **the code wins** —
fix the doc.

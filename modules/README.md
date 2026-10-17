# Module documentation index

Per-module docs. Each module directory holds `README.md` (purpose,
responsibilities, dependencies), `API.md` (public and internal surface),
`FLOW.md` (data flow), and `TODO.md`.

## Coverage

Documented in depth here (July 2026; the audit fix pass of 2026-10-17/18
changed parts of webrtc and telemetry, so check the source and
`docs/CHANGELOG.md` 2026-10-18 where they differ):

| Module | Path documented | Status |
|---|---|---|
| [desktop-bridges](desktop-bridges/) | `desktop/src/bridges/` | Current for the bridge contract; the full 9-bridge list is in `desktop/README.md` |
| [backend-webrtc](backend-webrtc/) | `backend/app/webrtc/` | Partly stale: PeerEntry now owns feed-port / relay release (`PeerRegistry.remove`), DataChannel PC kept per ingest |
| [backend-telemetry](backend-telemetry/) | `backend/app/telemetry/`, `backend/app/events/telemetry_events.py` | Partly stale: subscriptions retry via `_run_subscription`, Offboard keepalive, command events role-guarded |
| [frontend-transport](frontend-transport/) | `frontend/src/lib/` relays + `hooks/useDrone.ts` | Current for the relays; REST now goes through `lib/api.ts` with bearer headers |

Documented elsewhere:

| Area | Doc |
|---|---|
| `backend/app/auth/` | `docs/AUTH.md`, `SECURITY.md` |
| `backend/app/avoidance/` | `docs/avoidance/README.md` |
| `backend/app/db/` and every table | `docs/DATABASE.md` |
| `backend/app/vision/model_cache.py` | module docstring; `docs/CHANGELOG.md` 2026-10-18 |
| custom models (design only) | `docs/custom_models/DESIGN.md` |
| ground decoder / `hyrak_receiver` | `docs/GROUND_DECODER.md`, `docs/HYRAK_RECEIVER.md` |
| link resilience | `docs/LINK_RESILIENCE.md` |

**Not yet documented** (source is the reference): `backend/app/vision/`
(analyzers, worker pool), `backend/app/sessions/`, `backend/app/fleet/`,
`backend/app/tasks/`, `backend/app/planner/`, `backend/app/zones/`,
`backend/app/permits/`, `backend/app/flights/`, `backend/app/api/`,
`backend/app/registry/`, `backend/app/reconstruction/`,
`backend/app/sandbox/`, `backend/app/utils/`, `frontend/src/components/`,
`frontend/src/store/`, `frontend/src/contexts/`.

Add a module directory here when you first make a substantive change to one of
those, following the four-file shape above.

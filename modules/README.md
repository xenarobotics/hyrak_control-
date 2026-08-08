# Module documentation index

Per-module docs. Each module directory holds `README.md` (purpose,
responsibilities, dependencies), `API.md` (public and internal surface),
`FLOW.md` (data flow), and `TODO.md`.

## Coverage

Documented in depth — the modules created or modified in recent sessions:

| Module | Path documented | Status |
|---|---|---|
| [desktop-bridges](desktop-bridges/) | `desktop/src/bridges/` | Current |
| [backend-webrtc](backend-webrtc/) | `backend/app/webrtc/` | Current |
| [backend-telemetry](backend-telemetry/) | `backend/app/telemetry/`, `backend/app/events/telemetry_events.py` | Current |
| [frontend-transport](frontend-transport/) | `frontend/src/lib/` relays + `hooks/useDrone.ts` | Current |

**Not yet documented** (no changes in the documented sessions; source is the
reference for now): `backend/app/vision/`, `backend/app/sessions/`,
`backend/app/db/`, `backend/app/zones/`, `backend/app/permits/`,
`backend/app/flights/`, `backend/app/api/`, `backend/app/registry/`,
`backend/app/sandbox/`, `backend/app/utils/`, `frontend/src/components/`,
`frontend/src/store/`, `frontend/src/contexts/`.

Add a module directory here when you first make a substantive change to one of
those, following the four-file shape above.

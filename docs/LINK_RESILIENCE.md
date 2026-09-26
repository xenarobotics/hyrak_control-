# Link resilience for cloud-companion flight (2026-09-26)

HYRAK's companion computer is the cloud. These four pieces keep that design
safe when a link blinks; none of them moves control onto the aircraft.

| piece | where | what it does |
|---|---|---|
| Per-link watchdog | `backend/app/telemetry/manager.py` `_link_watch` | After 2 s with no message on a link: `LINK LOST: <fleet/session> link <address> (<kind>, our sysid N)` in the backend log, `link_ok=false` to the UI (OSD shows DRONE LINK LOST n s). `LINK RESTORED ... after Xs` when it comes back. MAVSDK's own "heartbeats timed out" never named the link. |
| Session survival | `backend/app/server.py`, `frontend/src/hooks/useDrone.ts`, `lib/socket.ts` | A dropped socket parks the session for 90 s (drone link, relay bridge, flight record, avoidance keep running). The client reconnects with its session id and reclaims it; its new socket joins the old socket rooms so every callback still reaches it. Socket liveness: 5 s (ping 2 s + timeout 3 s), was 30 s. The UI shows RECONNECTING, keeps drone state and the radio/SITL relay, drops relay packets while down (no stale replay), and restarts video after a resume. |
| Local link fallback | `frontend/src/lib/localLink.ts`, `components/controls/LocalLinkPanel.tsx` | While the cloud socket is down and this machine holds the radio/SITL relay: decodes the aircraft's own HEARTBEAT, SYS_STATUS, GLOBAL_POSITION_INT and COMMAND_ACK, sends a ground-station HEARTBEAT (sysid 250) once a second so a cloud blip does not trip PX4's link-loss failsafe, and offers HOLD / RETURN / LAND as MAV_CMD_DO_SET_MODE sent locally. Silent whenever the cloud is up. Encoding checked byte-for-byte against pymavlink. Runs in the page, so it works with the internet gone. |
| Failsafe pre-check | `backend/app/telemetry/failsafe_check.py` | Before arm / takeoff / mission start: refuses if `NAV_DLL_ACT` is 0 (no action on link loss), 5 or 6, or `COM_OBL_RC_ACT` is 6 or 7; warns for `COM_DL_LOSS_T` outside 3-30 s, `COM_OF_LOSS_T` below 0.5 s or above 5 s, and `RTL_RETURN_ALT` below the mission's highest waypoint. PX4's firmware default `NAV_DLL_ACT` is 0, so a real aircraft must set it (1 Hold or 2 Return); `hyrak_sim.sh` sets 2 for SITL. |

## How to see each one in SITL

- Watchdog: `grep "LINK LOST\|LINK RESTORED" .logs/backend.log`.
- Session survival: during a flight, turn the laptop's Wi-Fi off for 20 s and on again. The status pill shows RECONNECTING, then ONLINE; the backend logs `Resumed session ... after Ns away`; the drone link and mission carry on.
- Local fallback: same Wi-Fi test with the "SITL" or radio telemetry source. The CLOUD UNREACHABLE - LOCAL LINK panel appears with the aircraft's mode, altitude and battery; PX4 does not report "Connection to ground station lost"; HOLD / RETURN / LAND work with the Wi-Fi off.
- Failsafe check: with a SITL started before this change (`NAV_DLL_ACT` still 0), arming is refused with the reason; restart the sim with `./hyrak_sim.sh` to get `NAV_DLL_ACT=2`.

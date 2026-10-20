# Attachments: payloads and actuators on a drone

Things fitted to a drone that the pilot (or a mission, or a custom-model
rule) can switch: a release hook, a gripper, a winch, a light, a speaker, a
sprayer, or anything custom on a spare output. Backend: `backend/app/attachments/`.
Flight stack: **PX4 only** in v1. ArduPilot is not supported yet (its
servo/relay and gripper commands differ and have not been tested).

## 1. What is stored

Attachments belong to the physical drone (table `drone_attachments`,
migration `a7c3e9f1b2d4`), so they follow it between sessions and
workspaces. At most 8 per drone. Attachment ids are unique across drones.

```json
{
  "id": "a1b2c3d4e5f6",
  "kind": "release",
  "name": "Drop hook",
  "icon": "package-open",
  "wiring": {"type": "actuator", "index": 3},
  "actions": [{"id": "drop", "label": "Drop", "value": 1.0, "hazard": true}],
  "limits": {"min_alt_m": 2.0, "max_alt_m": null, "people_check": true},
  "enabled": true
}
```

| kind    | actions (hazard in bold)               | wiring              | default min height |
|---------|----------------------------------------|---------------------|--------------------|
| release | **drop**                               | actuator, gripper   | 2 m |
| gripper | **open**, close                        | gripper, actuator   | 0 m |
| winch   | **lower**, raise, stop                 | winch, actuator     | 0 m |
| light   | on, off, strobe (optional)             | actuator            | 0 m |
| speaker | on, off                                | actuator            | 0 m |
| sprayer | **level** (0 to 100 %), off            | actuator            | 2 m |
| custom  | 2 to 4 named states, each with a value and "can hurt someone" (default yes) | actuator | 0 m |

`people_check` defaults on when any action can hurt someone. Hazard flags of
the built-in kinds are fixed; labels and actuator values can be changed.

## 2. Wiring it in PX4

### Actuator output (any kind)

1. In QGroundControl open **Vehicle Setup > Actuators**.
2. Pick the output the device is plugged into (MAIN or AUX, PWM or DShot
   group) and set its function to **Peripheral via Actuator Set N**
   (N = 1 to 6). Set the PWM min/max (or disarmed/failsafe values) so the
   device rests in a safe state with no command.
3. In HYRAK, Config > Attachments, choose "Actuator output N" with the same N.

HYRAK sends `MAV_CMD_DO_SET_ACTUATOR` (MAVSDK `action.set_actuator(N, value)`)
with a value in -1..1. Defaults: on / open / drop = 1, off / close = -1,
winch lower = 1, raise = -1, stop = 0. The sprayer's level runs linearly from
its Off value (0 %) to its Spray value (100 %), which is -1..1 by default.
Use the Test buttons (drone linked and disarmed) to check the direction and
adjust the values.

### Gripper

PX4's payload deliverer drives a gripper (`PD_GRIPPER_EN = 1`,
`PD_GRIPPER_TYPE` for the servo type, plus the output set to **Gripper** in
the Actuators tab; `PD_GRIPPER_TO` is the time it waits for the gripper to
move). HYRAK uses the MAVSDK gripper plugin: drop and open = `release`,
close = `grab`, instance 0.

### Winch

MAVSDK winch plugin, instance 0: lower = `deliver` (lower, release, reel
up, lock), raise = `retract`, stop = `hold`. PX4 support for
`MAV_CMD_DO_WINCH` depends on the winch driver in your build; when the
flight controller rejects it the result says so (`failed`, with the
drone's words). If a winch is just a motor on an output, wire it as an
actuator instead.

The installed MAVSDK (3.15.3) has `action.set_actuator`, the gripper plugin
and the winch plugin. A plugin missing from a future install answers
`not_supported`.

## 3. Safety rules

Every in-flight use (Fly / Command strip, mission action, rule) runs these
guards at the moment it happens (`app/attachments/control.py: check`):

1. drone link up (`no_link`);
2. not taken over by HYRAK staff, unless the caller is the staff session
   holding the takeover (`taken_over`);
3. attachment fitted, action exists (`no_attachment`), enabled (`disabled`);
4. for an action that can hurt someone:
   * the pilot confirmed it (`needs_confirm`; the strip sends `confirm: true`
     after its two-step press, a mission's tick counts, a rule always asks);
   * not under the red-zone pushback, drone in the air (`red_zone`, `not_flying`);
   * height within limits (`too_low`, `too_high`);
   * zone at the drone's position: red refused, orange without a permit
     refused, a permit read that fails counts as none (`red_zone`,
     `orange_no_permit`);
   * people check: a person, pedestrian or people class at 0.4 or more in
     this session's AI results of the last 2 s refuses (`people_below`).
     With no fresh AI results the action goes and the answer says
     "no people check: no AI running".

Then the command; the drone saying no is `failed` with its reason, a missing
plugin `not_supported`. Every use, change and Test is an `audit_events` row
(`attachment.use`, `attachment.test`, `attachment.create|update|delete`) and
a `hyrak.audit` line.

**Test** (Config) runs the real command, only while the drone is linked
(`not_linked`) and DISARMED (`armed`), not under someone else's takeover.
It does not ask for a confirm: disarmed on the bench is the safety there.

Who: configure and Test need `drones.manage` on the drone's workspace
(owners, admins, managers, founders); listing needs `view`; using in flight
needs `fly` on the session and the drone (socket `attachment_action`,
guarded by `require_session_fly`).

## 4. API

```
GET    /api/attachments/kinds                      -> {kinds, icons, max_per_drone, actuator_outputs, custom_states}
GET    /api/drones/{drone_id}/attachments          -> {drone_id, attachments, can_manage, linked, armed, max}
POST   /api/drones/{drone_id}/attachments          body: record (id optional) -> {attachment}
PATCH  /api/drones/{drone_id}/attachments/{id}     body: changed fields       -> {attachment}
DELETE /api/drones/{drone_id}/attachments/{id}                                -> {ok: true}
POST   /api/drones/{drone_id}/attachments/{id}/test  body: {action_id, value?} -> attachment_result shape
```

Errors: `{"detail": {"code", "error"}}`, 400 `bad_request` with a plain
reason, 403 `forbidden`, 404 `not_found`, 503 `storage_failed`.

Socket, client to server: `attachment_action {attachment_id, action_id,
value?, confirm?}` (`value` = sprayer level 0..100; staff holding a takeover
add `target_session`). Server to client: `attachment_result {attachment_id,
action_id, ok, reason_code?, message, ts, name, source, level?, waypoint?,
rule_id?}` and `attachment_state {attachments: [{id, last_action_id,
last_at, ok}]}` (the last command sent, not hardware feedback).

## 5. Missions: done when reached

A waypoint may carry `actions: [{attachment_id, action_id, value?}]` (at
most 3), indexed by uploaded item. Hazard actions need the pilot's tick,
`allow_attachment_actions: true` in the `upload_mission` payload, or the
upload is refused (`code: needs_confirm`). The actions are **not** written
into the PX4 mission. The backend watches the flight
(`app/attachments/mission.py`) and, in MISSION mode, when the drone is
heading for that item and within 3 m of it (and 3 m in height, except with
terrain follow), runs them through the same guards as a button press. A
waypoint passed in a telemetry gap still runs its harmless actions; its
hazard ones are refused (`passed_waypoint`). Restarting the mission runs them
again.

Why not MissionRaw `DO_SET_ACTUATOR` / gripper / winch items: the guards
must hold at the moment of release (height, zone and permits now, people
below, takeover), which a DO item inside the flight controller cannot check;
and keeping one mission item per waypoint keeps `mission_current_index`
meaning the same everywhere. The cost is that it needs the link at that
moment; with no link nothing is dropped. `swarm_upload_mission` ignores
`actions` in v1.

## 6. Rules

Custom-model rules have a fifth action, `attachment` (see
`docs/custom_models/DESIGN.md`, "As built: rules"): kind + action (+ level),
resolved to the first enabled attachment of that kind on the session's
drone, needs model control, and always asks first when it can hurt someone.

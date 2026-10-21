# HYRAK Copilot

A voice-driven assistant on /command. The pilot holds push-to-talk (or the V
key, or types), says what they want, and HYRAK answers in text and voice. Anything
that moves the drone comes back as a plan card the pilot confirms; nothing moves on
a misheard word. Copilot only chooses from a fixed catalogue of skills, and every
skill runs through the same guards as the buttons.

Backend: `backend/app/copilot/`. Frontend: the Copilot tab in the command dock.
Contract between the two: socket events below.

## What it can do

| Say | Skill | Moves the drone | Confirm |
|---|---|---|---|
| "hold", "stop" | hold | stops | never: immediate, also ends any Copilot task |
| "land" | land | yes | yes |
| "come back", "return home" | return_home | yes | yes |
| "take off to 15 metres" | takeoff (2 to 120 m, arms first if needed) | yes | yes |
| "go up 10 metres", "climb to 40 m" | change_altitude | yes | yes |
| "move forward 20 metres", "go left 5 m" | move (relative to heading, -200 to 200 m) | yes | yes |
| "follow the man in the red shirt", "follow the white car" | follow | yes | yes, after the target is chosen |
| "follow me" | follow (the pilot's device position) | yes | yes |
| "track the red car" | track (highlight + map pin) | no | no |
| "stop following" | stop_task | stops | never |
| "count the people", "how many cars" | count | no | no |
| "what do you see?", "is anyone lying on the ground?" | describe | no | no |
| "survey a 50 metre radius at 30 metres" | survey (10 to 500 m) | yes (upload + start) | yes, with the plan on the map |
| "orbit here at 20 metres radius" | orbit (5 to 200 m, up to 5 m/s) | yes | yes |
| "battery?", "status" | status | no | no |

Plan cards expire after 15 s. "yes", "confirm", "do it" accept the open card; "no",
"cancel" decline it; "number two" picks a candidate on a choose card.

## Models

All load lazily on first use, stay loaded while any session has Copilot on, and
unload 10 minutes after the last one switches it off (`models.UNLOAD_AFTER_S`). Each
model has its own single-thread worker, so speech never queues behind vision.
Speech is warmed when Copilot is switched on.

- **Speech to text**: `openai/whisper-large-v3-turbo` through transformers, fp16 on
  CUDA (fp32 on CPU). The browser's recording (webm/opus, ogg, mp4 or wav) is decoded
  by ffmpeg to 16 kHz mono, at most 15 s and 1.5 MB. English by default;
  `COPILOT_STT_LANGUAGE=auto` lets Whisper detect the language. `COPILOT_STT_MODEL`
  overrides the repo.
- **Vision**: Florence-2 large, `florence-community/Florence-2-large`, through the
  native `Florence2ForConditionalGeneration` (no remote code), fp16. Open-vocabulary
  detection (phrase grounding as fallback) finds a described target; the detailed
  caption answers scene questions without Claude. `COPILOT_VISION_MODEL` overrides.
  Counts of people and vehicles come from the running tracker when there is one.
- **Planner**: a local parser first (no network, no key), then Claude when a key is set.
  Measured numbers are in "Measured" below.

## The planner

1. The local parser (`planner.parse_local`) runs first. Safety words (hold, stop,
   land, come back) and status never wait for the network or a busy planner.
2. With `ANTHROPIC_API_KEY` in the backend environment, everything else goes to Claude
   (`claude-opus-5-5`, adaptive thinking at effort low, one strict tool per skill,
   `tool_choice` auto with at most one call, server-side fallbacks `"default"`). Claude
   chooses a skill and writes the reply; it never sends a command. Its choice goes
   through the same argument checks, guards and plan cards as the local parser's.
   A refusal or a cut-off answer is never read as a plan. If Claude fails, the local
   parser's answer is used.
3. Scene questions with a key send the current camera frame (JPEG, at most 1280 px)
   to Claude; without one, Florence-2's caption answers.

The last 10 exchanges are kept as conversation context, per session, in memory.

### Enabling Claude

The owner adds `ANTHROPIC_API_KEY=...` to the backend's environment (the same place
the other backend secrets are set) and restarts the backend. Nothing else changes:
the planner chip in the Copilot tab switches from "Basic" to "Claude". Without the key
Copilot works with the local parser and Florence-2. The key is read only from the
environment by the official SDK and is never logged or sent to the browser.

## Safety

Every motion skill checks its guards when the plan is made and again, at that
moment, when the pilot confirms (`skills.guard`, `skills.control_reason`,
`skills.dest_reason`):

- **Fly access**: `socket_guard.session_may_fly` (staff: operator rank; customers:
  `fly` on the session workspace) and the drone not read-only for the session. The
  socket events themselves pass `require_session_fly` and are drone events
  (`socket_classes.DRONE_EVENTS`).
- **Takeover**: `takeover.blocking`. A taken-over session's Copilot events are refused
  by the socket guard, and a running task stops.
- **Pilot on the sticks**: `tel.pilot_has_control`.
- **Link**: connected and `link_ok`.
- **In the air**, except takeoff (which needs the ground).
- **Red-zone lock**: `session.zone_lock` (the zone monitor is flying it out).
- **Destination and path zones**: red refused, orange refused, unless an approved
  permit covers them, read fresh; a failed permit read counts as no permit. Climbs into
  a restricted layer (`engine.ceiling_at`) are refused.
- **Takeoff, land, return, hold and the survey start** go through
  `telemetry_events.run_guarded_action`, the code the `drone_action` handler runs:
  red zone with permits, link-loss failsafe check, avoidance notices and the camera
  interlock, the indoor takeoff cap.
- **Survey upload** goes through `telemetry_events.upload_mission_for`, the
  `upload_mission` path, with `permits.gate_upload` (orange is never acknowledged by
  voice).
- **Follow** uses the built-in trackers. Copilot puts the session on the person
  tracker or traffic management (the `set_analysis_mode` path), matches Florence-2's
  boxes to the tracker's track ids, then calls the tracker's own `follow_track` /
  `request_follow`, Offboard, guards again, `set_tracking`. Takeover skip, avoidance
  `guard_follow`, the stall brake and pilot-override handling apply unchanged.
- **Follow me** repositions toward a point 10 m from the pilot (on the drone's side),
  altitude held, at most once a second, each move zone-checked; it stops with HOLD when
  the position stops arriving for 5 s.
- **Orbit** uses MAVSDK `action.do_orbit` (`TelemetryManager.do_orbit`); without it
  the answer is "not supported".

A Copilot task stops on: staff takeover, pilot override, link loss, red-zone lock
(no HOLD: someone else owns the drone then), Copilot switched off or the pilot's page
gone, hold / stop / cancel (HOLD), the analysis mode changing under a follow or
track, and for orbit and survey the flight mode moving on.

## Socket events

Client to server (all `SESSION_COMMAND` and drone events):
`copilot_set {enabled}`, `copilot_audio {audio, mime}`, `copilot_text {text}`,
`copilot_confirm {token, accept}`, `copilot_choose {token, index}` (1-based, the
number shown), `copilot_cancel {}`, `copilot_pilot_position {lat, lon, accuracy_m}`.

Server to client (to the session's own socket): `copilot_state`, `copilot_message`,
`copilot_card_update`; `cv_results.copilot_target {box, label, track_id, kind, lost}`
while following or tracking, in source-frame pixels. Refusals of a `copilot_*`
event by the socket guard also arrive as a `copilot_message` (role `system`, status
`refused`).

The socket.io buffer is 2 MB (`max_http_buffer_size`) so a 1.5 MB recording fits.

## Measured

RTX 4070 laptop, 8 GB, fp16 (see the smoke script
`/home/japesh/hyrak-preview/work/copilot-backend/smoke_models.py`):

| | Load (weights in the OS page cache) | Inference (warm) | VRAM allocated |
|---|---|---|---|
| Whisper large-v3-turbo | 2.1 s | 150 ms for 3.8 s of speech (first call 380 ms); ffmpeg decode 45 ms | 1.54 GB |
| Florence-2 large | 0.5 s | grounding 150 to 260 ms, count grounding 220 ms, `<OD>` 620 ms, detailed caption 1.0 s | +1.48 GB |
| Both | | | 3.03 GB allocated, 3.26 GB peak; 8 MB after unload |

A cold first load reads about 3.2 GB of weights from disk and takes longer. Whisper
transcribed the flite sample "Follow the man in the red shirt and take off to fifteen
metres" exactly, from wav and from webm/opus.

Florence-2 note (measured): open-vocabulary detection tells attributes apart but often
returns one box for a bare class; phrase grounding finds every instance of a class but
drops attributes. Follow and track ask open-vocabulary first; counts ask phrase
grounding first (`vision.ground(..., every=True)`). Florence sometimes boxes the
described part (the jacket, the tie); matching accepts a box lying inside a track and
gives it to the smallest track around it.

## Files

| File | What |
|---|---|
| `app/copilot/stt.py` | ffmpeg decode, Whisper |
| `app/copilot/vision.py` | Florence-2 caption, grounding, detection |
| `app/copilot/models.py` | lazy model slots, one worker each, unload |
| `app/copilot/planner.py` | local parser, replies to cards, Claude planner |
| `app/copilot/skills.py` | catalogue, argument checks, tool schemas, guards |
| `app/copilot/survey.py` | circle lawnmower waypoints |
| `app/copilot/service.py` | per-session state, cards, tasks, hooks |
| `app/copilot/events.py` | socket handlers |
| `tests/test_copilot.py` | parser, planner, guards, cards, follow matching, survey, tasks, handlers |

## Logs and privacy

The server log records each Copilot exchange as metadata only (session,
role, status, text length, card kind) and every dropped voice clip (too
short, or silent with its level). What the pilot said and what Copilot
answered is logged only when `COPILOT_LOG_TRANSCRIPTS=1` is set, a
debugging opt-in for test setups; leave it off in production, where pilots
and customers speak. Audio is never stored.

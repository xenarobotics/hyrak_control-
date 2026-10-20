# Custom Models: design and architecture

## 0. Version 2 (2026-10-18): what is being built now

This section supersedes the rest of the document where they differ. Sections
1 onward are the original design and stay as background for the later
sandboxed steps.

### What the customer gets

The AI tab is one **Model library** with three kinds of model, and one way
to run any of them:

| kind | where it comes from | who can use it |
|---|---|---|
| **HYRAK models** (standard) | The built-in AI modes (Objects, People, Person tracking, Crowd, Plates, Depth, ...) plus models HYRAK publishes to its catalogue | Every workspace |
| **Uploaded models** (premium) | An ONNX file the customer uploads | Workspaces with the `custom_models` feature |
| **Hugging Face models** (premium) | A public Hugging Face repo that contains an ONNX file, pinned to the exact commit | Workspaces with the `custom_models` feature |

`custom_models` is a per-workspace switch in `workspaces.features`, the same
pattern as `cloud_sim`: off by default, founders turn it on in the console,
HYRAK staff can always use it. Quotas, storage limits and GPU limits per
workspace come later; the code keeps one settings knob per limit so they
are easy to add.

### Why ONNX only in this step

A model file is either data or code. ONNX (and safetensors) are data: the
runtime parses them and never executes Python from them. A PyTorch `.pt`
is a pickle: loading it can run any code. Code packages and
`requirements.txt` obviously run code. With no human review, a stranger's
code must only ever run inside a sandbox, which needs rootless podman plus
the NVIDIA container toolkit (owner installs it with sudo). So:

* **Step 1 (now)**: ONNX models, uploaded or from Hugging Face, tasks
  *detect objects* and *classify image*. No drone actions; results are
  overlays, a results panel, and optional alerts ("tell me when a `crack`
  is seen").
* **Step 2**: podman sandbox, then `.pt`, safetensors with an architecture,
  code packages, segmentation, and the behaviour API (drone actions).

Most YOLO, RT-DETR, classification and many Hugging Face vision models
export to ONNX, so step 1 already covers the common case.

### Simplicity rules for the interface

The audience includes people who have never trained a model. Everything is
designed for them first, without hiding power from experts.

1. **One library, one Run button.** Built-in modes and custom models look
   and run the same way: a card, a status, a Run button. No separate
   "custom" world.
2. **Three steps to add a model, in one panel**: *Choose a file* (drop an
   `.onnx` or paste a Hugging Face link) -> *Confirm what it does* (the
   system detects the task and class names and shows them for a yes/edit)
   -> *Test and save* (an automatic test run on sample images shows the
   boxes and the speed). Nothing else is required; everything else has a
   sensible default.
3. **Plain words.** "Finds objects and draws boxes", not "detection head";
   "Runs at 42 frames per second on our GPU", not "latency 23.8 ms".
   Technical details live behind a "Details" disclosure.
4. **Errors say what to do.** Every failure names the cause and the fix,
   e.g. "This file is a PyTorch model (.pt). Export it to ONNX first:
   `yolo export model=best.pt format=onnx`", "This Hugging Face repo has no
   .onnx file", "The model expects 3 inputs; HYRAK models need one image
   input".
5. **Status is always visible.** Each model card shows Ready, Checking or
   Needs attention (with the reason), never a silent failure.
6. **Locked, not hidden.** Without the premium feature the "Add model"
   button stays visible, opens an explanation of what it is and how to get
   it (ask HYRAK), and the HYRAK models keep working.

### Lifecycle (automatic, no human in the loop)

1. **Receive**: upload (size limit setting, default 500 MB) or Hugging Face
   download (public repos, resolved to a commit sha, only `.onnx` plus
   `config.json` / label files fetched). Stored at
   `<HYRAK_DATA_DIR>/workspaces/<workspace_id>/models/<model_id>/v<n>/`,
   checksum recorded.
2. **Inspect** (in a separate process): open with onnxruntime, read input
   and output shapes, ONNX metadata (Ultralytics exports store class names
   there), Hugging Face `config.json` `id2label`. Infer the task
   (YOLO-style `[1, 4+C, N]` or `[1, N, 4+C(+1)]`, RT-DETR style, or
   `[1, C]` = classify). Refuse custom ops and external data files that are
   missing, with a clear message.
3. **Test run** (separate process): run on bundled sample frames, measure
   latency and GPU memory, render a preview with boxes. Pass = Ready.
4. **Run**: a pilot picks the model in the AI tab like any mode; the
   session runs it through a `CustomModelAnalyzer` (a `BaseAnalyzer`) that
   sends frames to a per-model runner process (one process per running
   model, shared by sessions of the same workspace, crash-isolated, auto
   stopped when idle). Results use the existing `cv_results` shape so the
   existing overlay draws them.
5. **Versions**: re-uploading or re-importing makes a new version; the old
   one keeps working until the new one is Ready.

### Data and API

Tables (migration after `a7d3e9b1c4f2`, revision `d1e2f3a4b5c6`):
`models` (id, workspace_id, name, description, task, source
`upload|huggingface`, hf_repo, hf_revision, hf_file, status
`checking|ready|failed`, error, error_hint, current_version, published
(HYRAK catalogue), created_by, created_at, updated_at) and `model_versions`
(id, model_id, n, sha256, size_bytes, input_shape, labels, latency_ms,
gpu_mem_mb, preview_path, created_at).

Permissions (already in `perms.py`): listing needs `view`, adding /
editing / deleting / publishing needs `models.manage` (publishing to the
HYRAK catalogue: founders), running needs `models.run`.

REST, all under `/api/models`:
* `GET ?workspace_id=` -> `{hyrak: [...built-in modes and catalogue...],
  workspace: [...], premium: {enabled, reason}}`
* `POST` (multipart: file + name, workspace_id) -> model in `checking`
* `GET /huggingface/inspect?repo=` -> repo summary, sha, onnx files, labels
* `POST /huggingface` `{workspace_id, repo, file?, name?}` -> model in `checking`
* `GET|PATCH|DELETE /{id}`; PATCH edits name, description, labels, task
* `GET /{id}/preview` (image, URL ticket or blob), `POST /{id}/retest`
* `POST /{id}/publish` (founders) puts it in the HYRAK catalogue

Socket: `set_analysis_mode {mode: "custom:<model_id>"}` (already a session
command); progress pushes `model_status {id, status, step, error, hint}`.

### As built (backend, `feat/custom-models`, 2026-10-18)

Code in `backend/app/models_custom/`; tests in
`backend/tests/test_custom_models.py` and `test_custom_models_inspect.py`.
Where this differs from the text above, this wins.

**Storage and settings.** `HYRAK_DATA_DIR` (default `backend/data`,
gitignored), layout `workspaces/<ws>/models/<id>/v<n>/` with
`model.onnx`, Hugging Face companions (`*.onnx_data`, `config.json`,
`preprocessor_config.json`, `labels.txt`) and `preview.jpg`. A version
folder is never written twice: a file arrives in a unique `.incoming-*`
staging folder, the version row is reserved (unique `(model_id, n)`),
and the folder is renamed to `v<n>` only if that does not exist yet. The
sha256 of every model file is recorded and checked again before every
runner start (`file_changed` on a mismatch). The HYRAK catalogue keeps
its own copy of each pinned version under
`<HYRAK_DATA_DIR>/catalogue/<model_id>/v<n>/`, which no workspace writes. Knobs:
`CUSTOM_MODELS_MAX_MB` (500), `_MAX_PER_WORKSPACE` (50),
`_INSPECT_TIMEOUT_S`, `_TEST_TIMEOUT_S`, `_PARALLEL_CHECKS` (1),
`_HF_ENDPOINT`, `_HF_TIMEOUT_S`, `_HF_DOWNLOAD_TIMEOUT_S`, `_USE_GPU`,
`_MAX_RUNNERS` (4), `_GPU_MEM_LIMIT_MB` (2048, CUDA arena per runner),
`_CPU_THREADS` (2), `_RUNNER_IDLE_S` (60), `_RUNNER_START_TIMEOUT_S`,
`_INFER_TIMEOUT_S` (10).

**Tables** (migration `d1e2f3a4b5c6`): as listed above, plus on `models`
`settings` (JSON: `threshold`, `alert`, user `labels`, forced `task`),
`published_version` and `catalogue` (the pinned snapshot), and on
`model_versions` `file_name`, `hf_revision`, `status`, `error`,
`error_hint`, `task` and `details` (the inspect result, the test result,
and `failure {code, detail}`). `models.status/error` describe the newest
version; `current_version` is the newest READY version, the one that
runs. A failed new version leaves the previous one running.

**Entitlement.** `custom_models` joins `cloud_sim` in
`workspaces.FEATURES` (founder-only `PATCH /api/workspaces/{id}`), not
inherited by clients. Staff (any HYRAK membership, or the legacy token)
are always entitled. Needed to add models and to run the workspace's own
models; never for HYRAK modes or catalogue models.

**The checker.** `runner.py` is the only code that opens a customer file,
always as `python -I runner.py inspect|test|serve` (no `app` imports,
nothing from the working directory on `sys.path`), with a timeout and
its own process group. Inspect: sniffs non-ONNX bytes (PyTorch zip,
pickle, safetensors, TFLite, Keras, archives), uses the `onnx` package
when present to refuse custom operator domains, missing or escaping
external data and an opset newer than the runtime, then opens the model
with onnxruntime (CUDA, else CPU; never TensorRT) and reads one image
input (NCHW or NHWC, 1 or 3 channels, float32 / float16 / uint8, batch 1
or dynamic). Task and layout: Ultralytics metadata (`task`, `names`,
`imgsz`), Hugging Face `architectures` / `id2label` /
`preprocessor_config.json`, else shapes: `yolov8` `[1,4+C,N]`, `yolov8t`
`[1,N,4+C]`, `yolov5` `[1,N,5+C]`, `e2e` `[1,K,6]` (NMS inside),
`rtdetr` `[1,Q,4+C]` (Q <= 1000), `detr` (logits + pred_boxes),
`classify` `[1,C]`. Segment, pose and obb are refused. Test: two COCO
photos from the installed ultralytics package when present, then the
three synthetic street scenes in `models_custom/samples/`; median
latency, this process's GPU memory from `nvidia-smi`, a preview of the
picture with the most findings.

**Error table** (`errors.KNOWN_FAILURES`, code -> plain message + fix):
`pytorch_file`, `pickle_file`, `safetensors_file`, `tensorflow_file`,
`tflite_file`, `keras_file`, `tensorrt_file`, `archive_file`,
`wrong_extension`, `not_onnx`, `empty_file`, `too_large`,
`multiple_inputs`, `input_not_image`, `input_dtype`, `dynamic_input`,
`input_size_unusual`, `task_unsupported`, `unknown_layout`,
`opset_too_new`, `ir_too_new`, `custom_ops`, `external_data_missing`,
`load_failed`, `out_of_memory`, `run_failed`, `bad_output`, `timeout`,
`crashed`, `storage_failed`, `hf_bad_repo`, `hf_not_found`, `hf_gated`,
`hf_no_onnx`, `hf_choose_file`, `hf_file_not_found`, `hf_unreachable`,
`hf_download_failed`, `file_changed`, `not_entitled`, `quota`, `busy`, `not_ready`,
`forbidden`, `founders_only`, `published_locked`, `bad_request`,
`model_removed`, `not_found`, `runner_failed`. REST errors answer
`{"detail": {code, error, hint, detail}}`.

**REST** (all signed in; a workspace or model the caller cannot see is
404):

* `GET /api/models?workspace_id=` -> `{workspace_id, hyrak, workspace,
  premium: {enabled, reason}, can_manage, can_run, can_publish,
  limits: {max_mb, max_models}}`. `hyrak` holds the built-in modes
  `{id, kind: "builtin", mode, run_mode, name, description, icon, task,
  status: "ready", runnable, staff_only}` (no manual control; 3D scan for
  staff only) followed by catalogue cards. `workspace` holds full cards:
  `{id, kind: uploaded|huggingface, run_mode: "custom:<id>", name,
  description, icon, task, status, step, error, hint, runnable,
  published, published_version, workspace_id, source, hf: {repo,
  revision, file, url} | null, labels, version: {n, status, error, hint,
  sha256, size_bytes, file_name, hf_revision, task, input_shape,
  labels_count, latency_ms, fps, gpu_mem_mb, provider, preview,
  created_at}, current_version, latest_version, threshold, alert,
  created_by, created_at, updated_at}`.
* `POST` multipart `file`, `workspace_id`, `name?`, `description?`,
  `model_id?` (a new version) -> `{model}` in `checking`.
* `GET /huggingface/inspect?repo=&workspace_id=` -> `{repo, sha, url,
  pipeline_tag, task, library, license, onnx_files: [{path, size_bytes,
  too_large}], suggested_file, labels, ok}` (no .onnx: 200 with `ok:
  false` and the `hf_no_onnx` words).
* `POST /huggingface {workspace_id, repo, file?, name?, model_id?}` ->
  `{model}` in `checking`. 409 `hf_choose_file` lists the files.
* `GET /{id}` -> `{model}`, the full card plus `versions` (newest first)
  and `details` (inspect and test result, failure).
* `PATCH /{id}` `{name, description, labels, task, threshold, alert:
  {label, min_score, cooldown_s?} | null, classes_shown: [names] | null,
  tiling: off|auto|2x2|3x3}`; a changed task re-checks the newest
  version. Cards carry `threshold`, `classes_shown` and `tiling` (the
  catalogue card too, from the snapshot).
* `DELETE /{id}`, `GET /{id}/preview?version=` (bearer, or a URL ticket
  for this path), `POST /{id}/retest`, `POST /{id}/publish {published,
  version?}` (founders).

**The catalogue is pinned.** Publishing takes a snapshot of one ready
version (name, description, task, labels, threshold, the inspect spec,
speed, file hashes) and copies the version's files and preview into the
catalogue folder; catalogue sessions run from that copy. Other workspaces get a reduced card
(`{id, kind: "catalogue", run_mode, name, description, icon, task,
status, runnable, published, labels, threshold, version: {n, latency_ms,
fps, gpu_mem_mb, provider, input_shape, preview}}`, nothing about the
owning workspace, authors, other versions or failures) and run exactly
the pinned version with the snapshot's spec, without the owner's alert
rule. The owning workspace keeps editing, relabelling, re-uploading and
retesting its own copy; that changes only its own view and runs. Only a
founder publishes again or unpublishes; either puts every session running
the model on the catalogue path back on manual (the owning workspace's
too: it runs the catalogue pin when its feature is off). Deleting a
published model needs a founder (`published_locked`), and so does
deleting a workspace that owns published models (a delete blocker
computed in `workspaces.service.delete_workspace`, since the auth stores'
`workspace_usage` does not see the model tables). A founder-forced
workspace delete takes its models out of the catalogue: their rows
cascade, sessions running them go back to manual and the catalogue
copies are removed. Switching `custom_models` off stops the workspace's
customer sessions running its own models at once; catalogue models and
staff sessions run on.

**Socket.** No new client events. `set_analysis_mode {mode:
"custom:<id>"}` (session command, as before) resolves through
`service.resolve_run`: `models.run` on the session's workspace, the model
is the workspace's own (feature on, or staff) or in the catalogue, and
ready; refusals answer `error {msg, hint, event, code}` and
`model_status {status: "error", mode, error, code}`. Pushes (listed in
`socket_classes.PUSHED_EVENTS`): `model_status {id, workspace_id,
version, status, step, progress, error, hint, detail, current_version}`
to the model's workspace's sockets only, steps `received` (upload) or
`downloading` (Hugging Face), `inspecting`, `testing`, `done` (status
says ready or failed); `model_alert {model_id, model_name, label, score,
box, ts, message}` to the one session.

**Runtime.** `CustomModelMode` stands in for an `AnalysisMode` on the
session (`value` = `custom:<id>`) and builds a `CustomModelAnalyzer`
through the vision pool. One runner process per (session workspace,
model, version, own copy or catalogue), shared by that workspace's
sessions: frames through a
`/dev/shm` buffer, requests over a socketpair, one at a time (each
session already keeps only its newest frame). A crash, exit or answer
later than the infer timeout kills it; frames meanwhile report `error`
and `runner` (`crashed`, `restarting`) with no boxes while the video
keeps flowing; restart after 1, 2, 4 ... 30 s; five crashes in five
minutes and it stays down until its sessions leave. Stopped
`RUNNER_IDLE_S` after the last session leaves. Frames above 1920x1088
are scaled down and the boxes scaled back.

`cv_results` for a custom model: the object-detection shape (`objects`,
`detections [{name, box, score}]`, `person_count`, `total_count`) plus
`model_id`, `model_name`, `model_version`, `task`, `infer_ms`; a
classifier adds `predictions` (alias `classes`) `[{name, score}]`,
`top_class`, `top_score`. When the alert rule fires: `alert`,
`alert_hits [{label, score}]`, the `model_alert` event, and an
`admin_alert` (existing path, `source: "custom_model"`) to staff
consoles that can see the workspace. Nothing sets `drone_command`: step 1
has no drone actions and nothing for a takeover to stop.

**Browse** (`feat/hf-browse`, `models_custom/browse.py`). Open to anyone
with `view` on the workspace (premium or not); Add still needs
`models.manage` and the feature.

* `GET /huggingface/recommended?workspace_id=` -> `{workspace_id, premium,
  can_manage, categories: [{name, models: [{repo, file, name, category,
  task, what, license, license_note, classes_preview, fps, verified_at,
  url, added: model_id|null, added_status}]}]}`, from `models_custom/recommended.json`
  (validated at startup; a broken file logs and serves nothing). Categories
  in a fixed order: Drone and aerial view, Fire and safety, Roads and
  vehicles, Construction and people, Agriculture and nature, General
  purpose.
* `GET /huggingface/search?q=&task=all|detect|classify|segment&page=&ready=&workspace_id=`
  -> `{workspace_id, premium, can_manage, query, task, page (1-20),
  ready, has_more, cached, stale, results: [{repo, name, url, task
  (detect|classify|segment), downloads, likes, updated, license,
  license_note, onnx_files, suggested_file, runnable, reason, added,
  added_status}]}`. An empty `q` lists the most downloaded models, which
  is what the "All vision models" tab opens on. `ready=true` ("Ready to
  run only") lists only repos tagged `onnx` and keeps the runnable cards.
  One anonymous `list_models` call per pipeline tag (object-detection,
  image-classification, plus image-segmentation for `all`) with `expand`;
  private rows dropped. The listing has no file sizes (it refuses
  `usedStorage` in `expand`), so "Too large" shows only when a row carries
  its storage; Add always checks the size (`too_large`). Runnable first, then by downloads. Reasons:
  "Only PyTorch .pt files - supported after the HYRAK sandbox update",
  "Only PyTorch or safetensors weights - ...", "No ONNX file in this
  repo", "Gated - needs approval on Hugging Face", "Segmentation - coming
  soon", "Too large". Cached per (query, task, page, ready) for
  `CUSTOM_MODELS_HF_SEARCH_CACHE_S` (600, 256 entries); while the Hub or
  the per-user limit says wait, an older entry for the same query is
  served past its TTL with `stale: true`. Uncached searches
  limited to `CUSTOM_MODELS_HF_SEARCHES_PER_MINUTE` (20) per user
  (`search_rate_limited`, 429).
* HTTP 429 from the Hub is `hf_rate_limited` (429) on inspect, download
  and search, and starts a 30 s cooldown with no Hub calls.
* Panel: tabs "Recommended for drones" | "All vision models" | "Upload a
  file"; the library's "Browse models" (everyone) opens on All. A card
  for a model the workspace has shows Run once it is ready (closes the
  panel, runs `custom:<id>` like the library), else its status, which
  opens the model; step 3 has Run now next to Save. The model the panel
  added is highlighted in the library when the panel closes.
* `HF_TOKEN` (optional, SecretStr) is sent on single-repo calls (inspect,
  sizes, download) for higher limits; never on the search listing, and
  private repos are refused (`hf_not_found`) even when it could read them.
* Licence notes: AGPL ("Free to try; commercial use needs an Ultralytics
  licence or AGPL compliance.") and cc-by-nc ("Non-commercial use only.").

**Settings** (`feat/cm-settings`). Three run settings plus the task, in
`models.settings` (no migration): `threshold` (0.01-0.99, default 0.25),
`classes_shown` (null = all; a non-empty list of class names, deduplicated;
a class renamed through `labels` stays shown, followed by position) and
`tiling` (`off` default, `auto`, `2x2`, `3x3`).

* Live: a PATCH puts the run settings (and renamed labels, for that
  version only) in `runtime.set_live(model_id, ...)`; the owning
  workspace's analyzers read them on their next frame, with no runner
  restart. Catalogue runs keep the published snapshot, which now also
  pins `classes_shown` and `tiling`.
* Shown classes: the analyzer passes their class ids to the runner (a
  classifier's top 10 is then taken among them) and drops any other name
  before `objects`, `detections`, counts and the alert rule.
* Tiling (detect only; a classifier ignores it): the runner message is
  `("infer", h, w, c, threshold, {tiling, classes})`. The frame plus an
  n x n grid of tiles overlapping by 20% (`runner.tile_grid`, the last
  row and column flush with the edge), each letterboxed to the model's
  input; one `session.run` for all of them when the batch axis is
  dynamic (a model that refuses a real batch falls back to a loop for
  good), else one per tile. Boxes go back to frame pixels and merge with
  class-wise NMS at IoU 0.5 (`runner.merge_detections`). `auto` tiles
  2x2 on frames wider than 1280 px. A 2x2 frame is 5 model passes, 3x3
  is 10; `infer_ms` is the whole frame, and the analyzer's latest-frame
  policy drops frames while a slow one runs, so tiling never queues.
  Known limit: an object cut by a tile edge can add a partial box next to
  the full-frame one when their IoU is under 0.5.
* `cv_results` adds `threshold`, `classes_shown`, `tiling` (what ran on
  the frame: `off`, `2x2`, `3x3`), and a tally since the model started on
  the session: `run_frames`, `run_counts {name: {peak, frames}}` (detect:
  most at once and frames seen; classify: frames as the top answer).
* UI: the model panel has a Settings section (What it does, Sensitivity
  slider "Show a box when the model is at least N% sure" with a live
  hint, Only show these classes with search and Show all, Find small
  objects with Auto / 2x2 / 3x3 and a speed estimate from the test).
  Changes save on their own (the slider after a 400 ms pause) with a small
  "Saved"; viewers see the values as text. Add's Confirm step has the same
  three under a closed "More options". The results panel shows chips
  ("35% sure", "79 of 80 classes", "Tiling 2x2 - about 11 fps") that open
  the panel at that setting, and a per-class table (Now, Most at once) or,
  for a classifier, how often each answer was on top.

**Measured** (RTX 4070 laptop): Ultralytics YOLOv8n exported to ONNX
(opset 17) inspects as `yolov8`, 80 COCO names, tests at about 8 ms
(about 125 fps) and 228 MB GPU memory, finds the bus and four people in
the sample photo; served through a runner, a 1080p frame round trip is
about 9 ms of which about 8 ms is the model.

**Not yet.** No sandbox beyond the separate process (step 2: podman);
no per-workspace GPU quota beyond the per-runner CUDA arena limit;
model_status pushes reach only sockets in the model's workspace (a
founder adding a model from the console sees it on the REST card).
A check interrupted by a backend restart is re-run at startup.

### As built: rules (backend, 2026-10-20)

No-code rules replace "no drone actions" for step 1. A rule is a sentence
on a model: "When `label` is seen above `min_score` for `for_s` s, then
`action`", stored in `models.settings.rules` (no migration) and returned
as `rules` on every model card (`[]` when none; catalogue cards always
`[]`, as rules and alerts are the owning workspace's). The legacy `alert`
setting still runs unchanged.

* `app/models_custom/rules.py` (pure): `validate_rules` (id 8 to 16
  `[a-z0-9]`, label one of the model's classes case-insensitively,
  min_score 0.05 to 0.99, for_s 0 to 30, cooldown_s 5 to 600, at most 6
  rules, at most one enabled follow, no mark/follow on a classifier;
  PATCH answers 400 `bad_request` with the reason); `RuleEngine` (seen-for
  survives gaps up to 0.5 s, cooldown from each firing); `PendingConfirms`
  (single-use, per-session tokens, 10 s); `FollowTarget` (lock kept by
  IoU >= 0.1 or the nearest same-class centre within 20% of the frame
  diagonal) and `FollowController` (yaw PD from the shared calibration,
  forward PD on the range error against the box height at lock; caps
  forward 3 m/s, right 1.5 m/s, yaw 30 deg/s, down 0).
* The analyzer evaluates rules per frame: `rules_state` in cv_results, a
  private `_rule_fires`, and while a follow is on `follow {active, label,
  score, box, lost_s}` plus `drone_command` (zero while the target is
  unseen, `_follow_lost` after 3 s).
* `app/models_custom/actions.py` runs on the event loop from stream_track
  before the drone_command step: alert (rule_event + admin alert), mark
  (`mapdetect.live.pin`: a pinned sighting, pushed at once, written to
  `map_sightings` under the current flight whether recording is on or
  not; the table stores it as `source + "#pin"` and reads it back as
  `pinned: true, rule`; "Clear map" keeps pins), hover (pause the mission,
  else HOLD) and follow (`start_offboard`, then the analyzer steers).
  `drone_command` is stripped unless a rule follow is on.
* Moving actions need "Allow model control" (`set_model_control`, per
  session, in memory) and, unless the rule turns `confirm` off, the
  pilot's yes (`rule_confirm`). Every run re-checks all guards: model
  control, takeover, pilot control, link, in air, red-zone lock, model
  still running, and for follow the zone at the current position (red;
  orange that needs a permit and has none; no position fix = no zone, as
  in the zone monitor). The same checks run on every frame of a follow.
* Model control switches itself off on staff takeover, pilot override,
  red-zone lock, link loss (watchdog or link released), leaving the model
  (mode change, model removed) and the pilot's socket going away. Ending a
  follow commands HOLD only when nobody else owns the drone: not after a
  takeover (`_stop_ai_steering` holds), a pilot override, a red-zone lock
  (the pushback flies it out) or a lost link.
* Attachment action (2026-10-21, docs/ATTACHMENTS.md): `action:
  "attachment"` with `attachment_kind` (release, gripper, winch, light,
  speaker, sprayer, custom), `attachment_action` (an action id of that
  kind; any `[a-z0-9_]{1,24}` state id for custom) and, for the sprayer's
  `level`, `attachment_value` 0 to 100 (default 50). Validated in
  `rules.validate_rules` (so `service._valid_rules`). It needs model
  control like hover and follow (`rules.NEEDS_CONTROL`), is part of the
  accepted snapshot (`actions._moving_rules`, attachment fields included),
  so a live edit switches control off with `rules_changed`. An action
  that can hurt someone (and every custom one) is stored with `confirm:
  true` and always asks first. At fire time `actions.run_attachment`
  resolves the first enabled attachment of that kind on the session's
  drone (`no_attachment` when none) and runs it through
  `app/attachments/control.use`, the same guards as a button press.

## Original design (2026-10-17)

Status: DESIGN (2026-10-17). Superseded where section 0 differs.
Audience: Japesh, and whoever implements phases 1-4.

## 1. What this is

A new tab in the AI modules catalogue, "Custom", where a HYRAK user brings
their own model or code (bridge-crack detection, dam inspection, plant
health, a sensor-driven rule, anything) and it runs on the HYRAK servers
against the drone's live video and telemetry, exactly like the built-in
modules do. The user's laptop only has a browser and internet; the GPU work
is ours. Their code can ask the drone to do things (mark a spot, hover,
orbit, follow, come closer), through a vetted behaviour API, never raw
MAVLink.

Design goals, in priority order:

1. Safe. User code can never crash the backend, starve another session of
   GPU, read another user's data, or send an unguarded command to a
   vehicle.
2. Seamless. Upload, press Start, see results on the same overlay and panel
   layout as the built-in modes. No SSH, no Docker knowledge required.
3. Fast on the GPU. A custom YOLO should run at the same fps as our Objects
   mode, not at "python script" speed.
4. Reuses what exists. The frame path, FrameContext (telemetry snapshotted
   at capture), the latest-frame-drop policy, cv_results, CvOverlayCanvas,
   the follow controllers, avoidance, failsafes: all of it stays, the custom
   module is one more `BaseAnalyzer` in the registry.

## 2. How users bring their model: three tiers

Asking every user to write Python is wrong; most inspection customers have
a trained YOLO or a classifier and nothing else. Asking nobody to write
code is also wrong; the "sensor based" and "custom logic" cases need it.
So there are three tiers in one package format, and the UI picks the
simplest one for what the user has.

| Tier | Who | What they give us | What they configure |
|---|---|---|---|
| A. Weights only | Most inspection users | A weights file: Ultralytics `.pt`, ONNX, TorchScript, or a Hugging Face repo id | Dropdowns: task (detect / segment / classify / keypoints), class names, confidence, inference width, behaviour rules |
| B. Code package | Users with custom logic, sensor fusion, non-standard models | A zip (or git URL) with `hyrak.yaml`, `module.py`, optional `requirements.txt` and weights. Or write `module.py` in the browser editor from a template | Same dropdowns, plus params declared in the manifest (rendered as a form) |
| C. Container image | Later. Teams that need their own CUDA stack | A Dockerfile / OCI image that speaks the runner protocol | As B |

Tier A is actually a Tier B package we generate for them: we write the
manifest and pick one of our runner templates (`ultralytics`, `onnx`,
`hf_pipeline`). This means one runtime, one UI, and a user can "eject" from
A to B and edit the generated code.

Why not blocks (Scratch-style) or a terminal: blocks cannot express a
model; a terminal exposes the server and is the opposite of seamless. The
no-code need is covered by the **behaviour rule builder** (section 6), the
code need by a real editor. Both are dropdown-driven where the choices are
finite.

## 3. The package format

```
my-model.zip
  hyrak.yaml          required: manifest
  module.py           required for tier B (tier A: generated)
  requirements.txt    optional, pip names only (see sandbox limits)
  weights/            optional: *.pt *.onnx *.engine *.safetensors
  README.md           optional, shown on the model card
  samples/            optional: images or a short mp4 for "Test on clip"
```

`hyrak.yaml`:

```yaml
hyrak: 1                      # manifest version
name: Bridge crack detector
version: 0.3.0
runner: ultralytics           # ultralytics | onnx | hf_pipeline | python
entry: module.py:CrackModule  # tier B only; runner: python
inputs:
  video: true                 # wants frames
  telemetry: true             # wants FrameContext.telemetry
  sensors: [distance_sensor]  # MAVLink message names, optional
gpu:
  required: true
  vram_mb: 1500               # budget; runner is killed above 1.5x
  precision: fp16             # fp32 | fp16 | int8
  compile: tensorrt           # none | tensorrt (tier A only, done at upload)
  width: 640                  # inference width, UI can override
params:                       # rendered as the module's settings form
  - key: conf
    label: Confidence
    type: float
    min: 0.05
    max: 0.95
    default: 0.35
  - key: classes
    label: Classes to report
    type: multiselect
    options: [crack, spall, rust, vegetation]
    default: [crack, spall]
outputs:
  overlay: detections         # detections | segmentation | heatmap | text | none
  metrics: [crack_count, max_crack_width_mm]
rules:                        # behaviour rules, editable in the UI
  - when: {class: crack, conf_gt: 0.6, for_frames: 5}
    do: {action: mark_poi, label: "crack {track_id}", snapshot: true}
  - when: {class: crack, conf_gt: 0.8, for_frames: 10}
    do: {action: hover_and_zoom, standoff_m: 3, requires_confirm: true}
```

Everything the user needs to touch is in this file, and the UI edits it
through forms; nobody has to hand-write YAML unless they want to.

## 4. The SDK contract (tier B)

A tiny package, `hyrak_sdk`, installed into the runner. The user's class:

```python
from hyrak_sdk import Module, Frame, Context, Result, Detection, Event

class CrackModule(Module):
    def setup(self, ctx: Context):
        # runs once in the runner process, GPU already selected
        import torch
        self.model = torch.jit.load(ctx.weights("crack_ts.pt")).to(ctx.device).half().eval()

    def on_frame(self, frame: Frame, ctx: Context) -> Result:
        # frame.bgr: np.ndarray HxWx3 uint8 (read-only view of shared memory)
        # frame.captured_at: monotonic seconds, frame.index
        # ctx.telemetry: dict snapshot taken at capture (same as FrameContext)
        # ctx.params: current values of the manifest params
        dets = self.infer(frame.bgr)
        return Result(
            detections=[Detection(cls="crack", conf=d.conf, box=d.xyxy_norm, track_id=d.id) for d in dets],
            metrics={"crack_count": len(dets)},
            events=[Event("crack_seen", {"id": d.id}) for d in dets if d.conf > 0.8],
        )

    def on_sensor(self, name: str, msg: dict, ctx: Context): ...   # optional
    def on_param(self, key: str, value, ctx: Context): ...         # optional
    def teardown(self): ...                                         # optional
```

`Result` is the only thing that crosses the boundary. Its fields map 1:1
onto the existing `cv_results` payload the overlay already draws:

| Result field | cv_results | Drawn by |
|---|---|---|
| `detections[{cls, conf, box(norm xyxy), track_id, label}]` | `detections` + `frame_w/h` | existing `drawObjectDetection` |
| `masks` (RLE) / `heatmap` (uint8 PNG, small) | `overlay_png` | new generic overlay drawer |
| `text` (list of lines) | `text` | new generic text block |
| `metrics {name: number}` | `metrics` | generic metrics panel, auto-rendered |
| `events [{name, data}]` | `events` | rule engine input + event log |
| `actions [{action, args}]` | not forwarded raw; goes to the behaviour executor | section 6 |

There is deliberately **no** `send_mavlink`, `set_velocity` or socket in the
SDK. Code that wants the drone to move returns an action; the backend
decides whether and how.

What `Context` offers: `device` (cuda:0 or cpu), `weights(path)`,
`params`, `telemetry`, `log(...)` (ends up in the UI log panel),
`state` (a dict that persists across frames), `tracker()` (our ByteTrack
wrapper so users get stable ids without writing one), `geometry` (pixel to
metres helpers from `vision/geometry.py`, given telemetry and camera
profile).

## 5. Runtime: where the code runs and how frames reach it

### Isolation: a runner process per running model

User code never imports into the FastAPI process. Reasons: a segfault in
a CUDA kernel or a `while True` takes the whole platform (and every other
session) down; GPU memory leaks become ours; `requirements.txt` would
mutate the backend venv; and there is no way to put a CPU/VRAM budget on an
in-process thread.

```
 backend (FastAPI, asyncio)                      runner (one process per running model)
 ─────────────────────────────                   ─────────────────────────────────────────
 stream_track.py                                  hyrak_runner
   frame -> BGR ndarray                             loop:
   analyzer.submit_frame(...)                         wait notify  <── unix socket ──  frame ready (slot k, ctx json)
         │                                            frame = shm[slot k]   (zero-copy view)
   CustomModuleProxy(BaseAnalyzer)                    result = module.on_frame(frame, ctx)
     writes frame -> shm ring (3 slots)               send result json ──> unix socket
     sends {slot, context} ────────────────────►
     ◄──────────────────────── {result, timing}
     latest result cached, dropped if stale
     results -> cv_results (unchanged path)
     actions -> BehaviourExecutor
```

- **Frames**: a `multiprocessing.shared_memory` ring of 3 slots sized to
  the inference width. The proxy resizes (already done today for every
  module via inference width) and writes into the next free slot; the
  runner maps the same segment read-only. One 640x360 BGR frame is 690 kB:
  a memcpy, not a serialisation. The ZMQ+JPEG path the 3D-scan sidecar
  uses is the precedent; shared memory is cheaper and lossless.
- **Backpressure**: same policy as `BaseAnalyzer` today. If the runner is
  busy, the newest frame overwrites the oldest free slot; the runner only
  ever sees the latest. Nothing queues.
- **Control plane**: a Unix domain socket per runner, JSON lines:
  `hello`, `params`, `sensor`, `frame`, `result`, `log`, `stats`, `stop`.
- **Supervision**: the backend starts the runner on Start, restarts it up
  to 3 times on crash (the UI shows "Model crashed, restarting (2/3)"),
  kills it on Stop, mode switch, session end, VRAM over budget or 10 s
  without a heartbeat. Exactly the lifecycle `VisionWorkerPool` already
  has for in-process analyzers, so `register_session` / `unregister_session`
  are the hooks.

### Sandboxing, by phase

| Phase | Mechanism | Good enough for |
|---|---|---|
| 1 | Subprocess in a per-model venv (`uv venv`, cached by requirements hash), wrapped in `bwrap` (available on this host): read-only rootfs, only the package dir and `/dev/shm` segment mounted, `--unshare-net` (no network), GPU device nodes passed through, cgroup limits for CPU and RSS | Japesh's own and trusted customers' models, single server |
| 2 | Rootless `podman` (installed, 4.9.3) with the NVIDIA CDI spec (`nvidia-container-toolkit` is **not** installed yet; one apt package plus `nvidia-ctk cdi generate`). Same runner protocol; the shm segment and socket are bind-mounted | Untrusted multi-tenant, custom CUDA stacks (tier C) |

Both phases use the same `hyrak_runner` and the same proxy. Phase 1 is a
few hundred lines and ships first.

### Installing `requirements.txt`

At upload, not at Start. The server resolves and installs into the
model's venv with `uv` (seconds, cached), with an allowlist (PyPI only, no
`--index-url`, no `git+`, size cap) and the install log shown in the UI.
torch / torchvision / ultralytics / onnxruntime-gpu / opencv are
pre-provisioned in a shared base venv the model venv layers on top of, so
a typical model installs nothing.

## 6. Behaviour: how custom code moves the drone

Three layers, from safest to most capable. A model declares in its
manifest which layer it needs; the operator sees that at upload and must
enable it per session (same place as "Follow" is armed today).

**Layer 0: observe.** Overlays, metrics, events, snapshots, the event log.
No motion. Default.

**Layer 1: actions from a catalogue.** The runner (or a rule) returns an
action; the `BehaviourExecutor` in the backend runs it through the
existing command pipeline with every existing guard (geofence, avoidance
ceiling, operator HOLD, pilot override latch, link-loss failsafe, rate
limits). The catalogue:

| Action | What it does | Built on |
|---|---|---|
| `mark_poi(label, snapshot)` | Drops a POI at the drone's GPS (and the target's ground point if geometry can solve it), saves a frame | flights DB, `geometry.py` |
| `alert(level, text)` | Toast and event log; `critical` also pauses the mission (HOLD) | existing HOLD |
| `record(start/stop)` | Server-side recording of the processed feed | existing recorder |
| `hover(seconds)` | Pause the mission here | `pause_mission` / `hold` |
| `orbit(target, radius_m, seconds)` | Circle the detection | PX4 DO_ORBIT via telemetry manager |
| `follow(track_id)` | Hand the detection to the existing follow controllers (yaw PD, range PD, altitude mode) | `pursuit.py`, `human_tracker` state |
| `approach(track_id, standoff_m)` | Move toward a detection and stop at a standoff distance, keeping it centred | follow controllers with a range target, avoidance active |
| `goto_offset(forward_m, right_m, up_m)` | Small relative move, capped | `send_velocity_ned`, capped by manifest `max_move_m` |
| `resume()` / `rtl()` / `land()` | Mission control | existing actions |

Rules in the manifest map `events`/`detections` to actions with a
hysteresis (`for_frames`), and the UI builds them with dropdowns: *when*
[class] [confidence >] [for N frames] *then* [action] [args]
[ask me first?]. This is the "no-code behaviour" path; it covers "see a
crack, hover and photograph it", "see a person in the exclusion zone,
alert and hold", "plant stress index below X, mark POI".

**Layer 2: continuous control (future).** A `velocity_hint(forward, right,
down, yaw_rate)` per frame, for users who want their own tracker to steer.
It goes through the same `send_velocity_command` as our follow modes, but
additionally clamped by a per-model envelope (max speed, max distance from
the mission corridor, altitude band), and the keep-clear reflex and
avoidance remain in the loop in front of it. This is exactly what
human-tracking does internally today; exposing it is mostly the envelope.
Not in phase 1.

Every action with `requires_confirm: true` (default for anything that
moves) shows a confirm chip on the video for 10 s; the operator taps it or
it expires. `mark_poi`, `alert` and `record` never need confirmation.

## 7. Using the GPU fully

What the built-in modules do today and the custom path inherits: lazy
load, one model in VRAM per session, inference width per mode,
latest-frame drop, fp16 where the model supports it, result cache so the
video path never waits for inference.

What the custom path adds:

- **Prepare step at upload** (tier A): export to TensorRT (`ultralytics
  export format=engine half=True imgsz=<width>`) or ONNX Runtime CUDA EP
  with fp16; cached per (weights hash, width, precision). On the RTX 4070
  this is 2-4x over eager PyTorch for YOLO-class models. The user sees
  "Preparing for GPU (about 2 minutes)" once, then never again.
- **Benchmark at upload**: run the model on the bundled `samples/` (or our
  default clip) for 10 s and show *fps, p95 latency, VRAM*. The card shows
  these numbers; the Start button warns if VRAM would exceed what is free.
- **Budgets**: `gpu.vram_mb` from the manifest; the supervisor polls
  `nvidia-smi --query-compute-apps` per runner PID and kills a runner that
  exceeds 1.5x. One custom model per session; sessions share the GPU
  time-sliced as they do now. NVIDIA MPS can be enabled later for better
  concurrent utilisation without code changes.
- **Width control**: the `width` param is the single biggest lever and is
  on the panel, defaulting to the manifest value.
- **CPU side**: resize and colour conversion happen once in the proxy,
  into the shm slot, so the runner starts inference immediately.
- **No per-frame allocation**: the runner keeps a pinned input tensor and
  copies the shm view into it (`torch.from_numpy(view).to(device,
  non_blocking=True)`).

## 8. UI: the "Custom" tab

In `ModeSelector`, a tile "Custom" opens a sub-view (the first tile that
has children). Four screens:

1. **Library**: cards for each uploaded model (name, version, runner,
   fps/VRAM from the benchmark, status: Ready / Preparing / Failed /
   Running). Start runs the selected model as the session's mode
   (`custom:<model_id>`). Cards have Edit, Duplicate, Export, Delete.
2. **Add model** (wizard): choose *Weights file* / *Package zip* /
   *Git or Hugging Face URL* / *Start from template* (Blank, Detection,
   Classification, Segmentation, Sensor rule). Weights path asks task
   and class names with dropdowns, then runs Prepare + Benchmark with a
   progress panel.
3. **Editor**: Monaco (same editor as VS Code, loaded from CDN) with
   `module.py` and `hyrak.yaml` tabs, the manifest form on the right,
   **Test on clip** (runs the runner against a sample clip or the last
   recording and shows the overlay in the same video pane), **Logs**
   (runner stdout, `ctx.log`, crashes), **Rules** (the dropdown builder).
   Save = new version; the running instance is not touched until Restart.
4. **Running panel** (the right column on the AI page and the Command
   dock): auto-generated from the manifest: params form, metrics tiles,
   event log, action confirm chips, `ModulePerformance` unchanged.

The overlay: if `outputs.overlay` is `detections`, the existing
`drawObjectDetection` draws it with the model's class colours; `heatmap`
and `segmentation` get one new generic drawer that composites a PNG the
runner returns at reduced resolution. `CLICK_TO_SELECT` works for
detections with `track_id` (click a crack to `follow`/`approach` it).

## 9. Backend surface

- `AnalysisMode` gains one value, `CUSTOM = "custom"`; the model id
  travels with `set_analysis_mode {mode:"custom", model_id}`. The registry
  maps it to `CustomModuleProxy`, which the pool instantiates with the
  model id.
- REST: `POST /api/models` (multipart zip or weights, or `{url}`),
  `GET /api/models`, `GET /api/models/{id}`, `PUT /api/models/{id}/files`
  (editor save), `POST /api/models/{id}/prepare`, `POST
  /api/models/{id}/test` (clip), `GET /api/models/{id}/logs` (SSE),
  `DELETE /api/models/{id}`. Socket: `custom_params`, `custom_action_confirm`,
  `custom_log`, `custom_event`.
- Storage: `backend/data/models/<id>/{package, venv, engine cache,
  benchmark.json}`; Postgres table `custom_models` (id, owner, name,
  version, manifest json, status, benchmark, created). Owner is the
  session's user once auth exists; until then one shared library.
- Sensors (`inputs.sensors`): the telemetry manager already receives raw
  MAVLink; a small fan-out forwards the listed message types to the
  runner as `sensor` messages. Non-MAVLink sensors (a serial gauge on the
  client laptop) arrive the same way the Web Serial radio relay does and
  are out of scope for phase 1.

## 10. Swarm (future work, designed for, not built)

- A model instance per drone (runner per `(model, drone)`), sharing one
  venv and engine cache.
- `ctx.fleet` read-only view of other drones' positions; actions carry
  `drone_id`; a `group` action family (`split_area`, `converge_on(poi)`)
  built on the existing group commands.
- Shared `ctx.blackboard` (per-session KV) so instances can hand off a
  track id.

## 11. Phases

| Phase | Scope | Size |
|---|---|---|
| 1 | `hyrak_sdk`, `hyrak_runner`, shm ring + socket, `CustomModuleProxy`, supervisor, bwrap sandbox, per-model venv, tier A (ultralytics + onnx runners) with Prepare and Benchmark, REST + DB, Library + Add-model wizard, detections overlay, metrics panel, Layer 0 behaviour | ~2 weeks |
| 2 | Editor (Monaco), templates, Test on clip, logs, rule builder, Layer 1 actions (`mark_poi`, `alert`, `hover`, `follow`, `approach`, `orbit`), confirm chips | ~2 weeks |
| 3 | podman + CDI isolation, `hf_pipeline` runner, segmentation/heatmap overlay, sensor fan-out, MPS | ~1 week |
| 4 | Layer 2 velocity hints with envelope; swarm instances | later |

The cheap first slice, if you want to see it working before committing:
phase 1 without the wizard polish, with a YOLO `.pt` dropped into
`backend/data/models/<id>/` by hand and a hard-coded tile. That is the
runner, the proxy and the overlay, which is where all the risk is.

## 12. Open decisions

1. Phase 1 sandbox: bwrap subprocess (recommended, works today) vs
   podman from day one (needs `nvidia-container-toolkit` installed and a
   reboot-free CDI generate; ~1 hour).
2. Library scope before auth: one shared library on the server, or
   per-browser (localStorage id) visibility. Recommend shared until auth
   lands (auth is already an open item).
3. Whether tier A should also accept a Roboflow / Hugging Face model id
   directly (easy for HF; Roboflow needs their SDK and a key).

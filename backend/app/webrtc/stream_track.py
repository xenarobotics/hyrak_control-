import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import TYPE_CHECKING, Callable, Optional

import cv2
import numpy as np
from aiortc import MediaStreamTrack
from av import VideoFrame

from app.avoidance.sensing import camera as _sensing
from app.sessions import observer

if TYPE_CHECKING:
    from app.vision.worker_pool import VisionWorkerPool
    from app.sessions.manager import SessionManager

logger = logging.getLogger("verocore.webrtc.track")


class MultiModeVideoStreamTrack(MediaStreamTrack):
    kind = "video"

    def __init__(
        self,
        source_track:    MediaStreamTrack,
        session_id:      str,
        vision_pool:     "VisionWorkerPool",
        session_manager: "SessionManager",
        emit_callback:   Optional[Callable] = None,
        snapshot_callback: Optional[Callable] = None,
        return_video:    bool = True,
    ):
        super().__init__()
        self.track           = source_track
        self.session_id      = session_id
        self._vision_pool    = vision_pool
        self._session_mgr    = session_manager
        self._emit_callback  = emit_callback
        self._snapshot_cb    = snapshot_callback
        # False = client-overlay stream: the browser shows its own camera
        # and draws results itself, so we skip all output composition and
        # no downlink video exists - only cv_results payloads go back.
        self._return_video   = return_video
        # Last annotated output / meta for the CURRENT mode only. Cleared on
        # every mode change and whenever the analyzer is away (reloading),
        # so a mode switch can never show the previous mode's frozen frame
        # or draw its boxes over the new one (audit V7).
        self._frame_cache:   dict[str, np.ndarray] = {}
        self._meta_cache:    dict[str, dict] = {}
        self._last_mode:     str | None = None
        # Drone velocity commands: ONE latest-command slot drained by one
        # sender task. A create_task per result had no bound, so a stalled
        # MAVSDK call let tasks pile up at the result rate (audit V15).
        self._vel_slot:      tuple | None = None
        self._vel_event      = asyncio.Event()
        self._vel_task:      asyncio.Task | None = None
        # Pixel work (colour conversion, overlay drawing) runs here, off the
        # event loop - ~6-10ms/frame at 1080p that would otherwise delay
        # drone commands, telemetry and signaling for every session.
        # Single worker keeps frame order.
        self._px_executor    = ThreadPoolExecutor(max_workers=1)
        self._frame_count    = 0
        self._last_fps_time  = time.time()
        self._fps            = 0.0
        self._last_emit_time = 0.0
        self._last_snap_time = 0.0
        self._skipped        = 0
        self._last_skip_log  = 0.0
        self._source_fps     = 0.0
        # Skips inside the CURRENT 1s fps window (self._skipped is a separate
        # 5s accumulator owned by the warning log).
        self._skipped_window = 0
        # Per-stage accounting for the live-edge warning. Every stage of
        # recv() is timed, plus `outside` - the wall time between returning a
        # frame and being called again, which is everything we do NOT control
        # (aiortc's outbound encode, RTP packetisation, and any event-loop
        # starvation). Without that term the warning can only ever blame the
        # code it can see, which is exactly how this went unfixed.
        self._stage: dict[str, float] = {}
        self._stage_n = 0
        self._returned_at: float | None = None

    def _stage_add(self, name: str, seconds: float) -> None:
        self._stage[name] = self._stage.get(name, 0.0) + seconds

    def _lap(self, name: str, since: float) -> float:
        now = time.perf_counter()
        self._stage_add(name, now - since)
        return now

    def _stage_reset(self) -> None:
        self._stage.clear()
        self._stage_n = 0

    def _stage_ms(self) -> dict[str, float]:
        """Mean ms per frame for each stage, for the client's performance
        panel. Excludes source_wait, which is idle time rather than cost."""
        if not self._stage_n:
            return {}
        return {
            k: round(v / self._stage_n * 1000, 1)
            for k, v in self._stage.items() if k != "source_wait"
        }

    def _stage_report(self) -> str:
        if not self._stage_n:
            return "(no samples)"
        parts = sorted(self._stage.items(), key=lambda kv: -kv[1])
        return "  ".join(f"{k}={v / self._stage_n * 1000:.1f}ms" for k, v in parts)

    def _skip_to_live_edge(self, frame: VideoFrame) -> VideoFrame:
        """Discards any frames queued behind `frame` and returns the newest.

        aiortc's PlayerStreamTrack pushes decoded frames into an **unbounded**
        asyncio.Queue from its decode thread. So if `recv()` takes longer than a
        frame interval, the queue grows without bound and the delay grows with
        it, monotonically.

        NOTE: this used to claim `_throttle_playback` "applies only to file
        sources". That is false for our UDP paths - aiortc keys it off a
        container-format allow-list that contains `rtsp` but not `mpegts` or
        `sdp`, so both server-side UDP sources were being paced against PTS.
        Combined with the skip below it produced a feedback loop that pinned
        delivery at 1.0 fps; see webrtc/live_player.py. Every source that
        reaches this class must now pass through `as_live()`.

        AI modes are exactly that case. Manual control is a pure relay, but an
        analysis mode pays two round trips through a SINGLE-worker executor
        (`to_ndarray` then `_compose`), ~6-10ms each at 1080p plus overlay
        drawing - against a 33ms budget at 30fps. Once the total crosses the
        frame interval the stream never recovers on its own: the operator sees
        video that runs for a few seconds after starting analysis and then
        appears to freeze, because it is falling further behind every frame.

        Dropping the backlog is the correct trade for a live pilot view - a
        stale frame has no value, and the alternative is unbounded latency. This
        is the server-side counterpart of the client's live-edge clamp
        (frontend/src/lib/liveEdge.ts).
        """
        q = getattr(self.track, "_queue", None)
        if q is None:                      # not a PlayerStreamTrack (browser track)
            return frame
        skipped = 0
        while not q.empty():
            try:
                newer = q.get_nowait()
            except asyncio.QueueEmpty:
                break
            if newer is None:
                # End-of-stream sentinel. Put it back so the next recv() runs
                # aiortc's own teardown (stop() + MediaStreamError) rather than
                # this method inventing its own.
                q.put_nowait(None)
                break
            frame = newer
            skipped += 1
        if skipped:
            self._skipped += skipped
            self._skipped_window += skipped
            now = time.time()
            # Rate-limited: this fires per frame when saturated, and a log line
            # per frame is its own performance problem.
            if now - self._last_skip_log >= 5.0:
                self._last_skip_log = now
                # Name the actual consumer. The first version of this said
                # "analysis is slower than the incoming frame rate", which is
                # wrong whenever the session is in manual-control: there is no
                # analyzer at all on that path, and the cost is the outbound
                # H.264 encode (aiortc, libx264 at source resolution - measured
                # ~0.79 core for one 1080p session). Blaming analysis there
                # points at the wrong thing to fix.
                session = self._session_mgr.get(self.session_id)
                mode = session.mode.value if session and session.mode else "unknown"
                # Name the actual consumer, MEASURED - not guessed. The
                # previous version of this line asserted "analysis + the
                # outbound H.264 encode cannot keep up", and that assertion
                # sent the investigation into optimising a pipeline which
                # benchmarks at ~100 fps of headroom on this hardware while
                # delivering 1.0. A warning that names a culprit it has not
                # measured is worse than one that just reports the numbers.
                logger.warning(
                    f"Session {self.session_id[:8]}: dropped {self._skipped} stale frame(s) in 5s "
                    f"to hold the live edge - {self._fps:.1f} fps delivered downstream "
                    f"(mode={mode}). Per-frame inside recv(): {self._stage_report()}"
                )
                self._skipped = 0
                self._stage_reset()
        return frame

    async def recv(self) -> VideoFrame:
        _t = time.perf_counter()
        if self._returned_at is not None:
            # Time spent by our CALLER, not by us. For a processed stream that
            # is aiortc's encode + packetise; for client-overlay it is the
            # drive loop, so a large value there means the event loop is
            # starved by something else entirely.
            self._stage_add("outside", _t - self._returned_at)
        self._stage_n += 1

        frame = await self.track.recv()
        _t = self._lap("source_wait", _t)
        frame = self._skip_to_live_edge(frame)
        _t = self._lap("skip", _t)

        self._frame_count += 1
        now = time.time()
        if (now - self._last_fps_time) >= 1.0:
            elapsed = now - self._last_fps_time
            self._fps = self._frame_count / elapsed
            # What the SOURCE offered, not what we forwarded. The gap between
            # the two is the only honest measure of whether this pipeline is
            # keeping up, and it is invisible from the browser: in overlay
            # mode no video crosses WebRTC at all, so pc.getStats() reports
            # zeros forever and every client-side "performance" figure is
            # describing a transport the video does not use.
            self._source_fps = (self._frame_count + self._skipped_window) / elapsed
            self._frame_count = 0
            self._skipped_window = 0
            self._last_fps_time = now

        session = self._session_mgr.get(self.session_id)
        mode = session.mode if session else None

        # Fast path: manual control (or no session yet) is a pure relay.
        # Skip the BGR24 <-> native colour-space round trip entirely -
        # it was burning CPU on every frame for the most common mode.
        if mode is None or mode.value == "manual-control":
            self._maybe_snapshot(None, frame)
            # Obstacle avoidance watches the camera in the background when its
            # toggle is on - whatever tab the operator is on. Throttled and
            # non-blocking; the relay never waits for it.
            if _sensing.wants_frame(self.session_id, mode.value if mode else None):
                try:
                    img = await asyncio.get_running_loop().run_in_executor(
                        self._px_executor, partial(frame.to_ndarray, format="bgr24"))
                    _sensing.submit(self.session_id, img)
                except Exception:
                    pass
            self._returned_at = time.perf_counter()
            return frame

        if mode.value != self._last_mode:
            self._clear_caches()
            self._last_mode = mode.value

        analyzer = self._vision_pool.get_for_session(self.session_id)

        # While a model is (re)loading there's no annotated frame to draw
        # yet - relay the raw frame instead of paying for a wasted
        # conversion round trip. The caches go too: whatever they hold is
        # from before the reload and must not come back as the first frames
        # of the reloaded model.
        if analyzer is None:
            self._clear_caches()
            self._maybe_snapshot(None, frame)
            self._returned_at = time.perf_counter()
            return frame

        loop = asyncio.get_running_loop()

        # Client-overlay mode with the analyzer still busy on this session's
        # previous frame: submit_frame would only replace a frame it has not
        # looked at yet, so the 6-10 ms BGR conversion (1080p) buys nothing.
        # Skip both; the result check below still runs so a finished
        # inference is emitted on time (audit V13). Processed streams always
        # convert - the frame is composed from img_bgr either way.
        img_bgr: np.ndarray | None = None
        if self._return_video or not self._analyzer_busy(analyzer):
            img_bgr = await loop.run_in_executor(
                self._px_executor, partial(frame.to_ndarray, format="bgr24")
            )
            _t = self._lap("to_ndarray", _t)

            # Same background sensing for every analysis mode except Depth
            # mapping, which feeds avoidance itself. The frame is already BGR.
            if _sensing.wants_frame(self.session_id, mode.value):
                # Its own copy: _compose below draws the overlay INTO img_bgr in
                # place, and the depth sensor runs on another thread, so without
                # this the depth model could be shown badges and brackets.
                _sensing.submit(self.session_id, img_bgr.copy())

            try:
                # Telemetry is snapshotted HERE, next to the frame it belongs
                # to, and handed down with it. Reading it later - after
                # inference, where the plate/lat-lng block below does - is
                # fine for logging a position but useless for measuring
                # motion: by then it describes a different moment, and frames
                # get dropped in between.
                tel_mgr = self._session_mgr.get_telemetry(self.session_id)
                tel_snapshot = (
                    tel_mgr.snapshot.to_dict()
                    if tel_mgr and tel_mgr.is_connected else None
                )
                analyzer.submit_frame(self.session_id, img_bgr, telemetry=tel_snapshot)
            except Exception as e:
                logger.warning(f"Vision analyzer submit error (session {self.session_id[:8]}): {e}")
        else:
            self._stage_add("submit_skipped", 0.0)

        try:
            result = analyzer.get_latest_result(self.session_id)
        except Exception as e:
            logger.warning(f"Vision analyzer error (session {self.session_id[:8]}): {e}")
            result = None

        _t = self._lap("analyzer_io", _t)

        if result:
            annotated_bgr, meta = result
            # Detections on the map (app/mapdetect): every mode's boxes are
            # placed on the ground with the telemetry of their own capture.
            # Popped first so the snapshot never reaches the client.
            capture = meta.pop("_capture", None)
            try:
                from app.mapdetect import live as _map_live
                _map_live.ingest(self.session_id, mode.value, meta, capture, annotated_bgr)
            except Exception as e:
                from app.vision.base import warn_limited
                warn_limited(f"mapdetect:{self.session_id}",
                             f"Map detections failed for session {self.session_id[:8]}: {e!r}")
            self._frame_cache[mode.value] = annotated_bgr
            self._meta_cache[mode.value] = meta

            # ── DB persistence (crowd/plate modules queue writes here
            # since that's where their per-session state lives; this is
            # the first point back in the event loop to actually do it) ──
            pending_db = meta.pop("_pending_db", None)
            if pending_db:
                # Vehicle/plate events get the drone's own live GPS at
                # capture time - more meaningful than a static camera-ID
                # string, and this is the first point back in the event
                # loop where session_manager/telemetry are reachable.
                if any(ev.get("table") == "plate_event" for ev in pending_db):
                    tel = self._session_mgr.get_telemetry(self.session_id)
                    if tel and tel.is_connected:
                        pos = tel.snapshot.position
                        for ev in pending_db:
                            if ev.get("table") == "plate_event":
                                ev.setdefault("lat", pos.latitude_deg)
                                ev.setdefault("lng", pos.longitude_deg)
                                ev.setdefault("alt_m", pos.relative_altitude_m)
                from app.vision.persistence import persist_events
                asyncio.create_task(persist_events(self.session_id, pending_db))

            # Live face enrolment: the analyzer captured the shots in its
            # worker thread; writing them to the gallery needs the event
            # loop, which is here.
            enrol = meta.pop("_pending_enrolment", None)
            if enrol:
                asyncio.create_task(
                    self._enrol_captured(enrol["name"], enrol["paths"])
                )

            pending_alerts = meta.pop("_pending_admin_alerts", None)
            if pending_alerts:
                from app.events.admin_events import emit_admin_alert
                drone_name = (session.drone or {}).get("name") or f"session {self.session_id[:8]}"
                for alert in pending_alerts:
                    asyncio.create_task(emit_admin_alert(self._session_mgr, {
                        "session_id": self.session_id, "drone": drone_name,
                        "ts": time.time(), **alert,
                    }))

            # A custom model's alert rule fired: tell this session's own
            # socket (app/models_custom/analyzer.py).
            model_alerts = meta.pop("_pending_model_alerts", None)
            if model_alerts:
                from app.models_custom import notify as _model_notify
                for alert in model_alerts:
                    asyncio.create_task(_model_notify.model_alert(self.session_id, alert))

            # ── Send drone command directly to MAVLink ──────────────
            drone_cmd = meta.get("drone_command")
            if drone_cmd and drone_cmd.get("type") == "velocity":
                # HYRAK operations hold this session's drone: its AI follow
                # no longer steers it (docs/ACCESS_MODEL.md 8b "Takeover").
                from app.sessions import takeover as _takeover
                if _takeover.is_taken_over(self.session_id):
                    drone_cmd = None
            if drone_cmd and drone_cmd.get("type") == "velocity":
                tel = self._session_mgr.get_telemetry(self.session_id)
                if tel and tel.is_connected:
                    from app import latency_probe
                    latency_probe.note_setpoint(
                        tel, drone_cmd, meta.get("captured_at_mono"), meta.get("decided_at_mono"))
                    # Obstacle avoidance's follow guard: bends / slows /
                    # holds the tracker's horizontal command near
                    # obstacles; yaw and vertical stay the tracker's.
                    # Pass-through when avoidance is off or on error.
                    from app.avoidance.core import loop as _av_loop
                    fwd_g, right_g = _av_loop.guard_follow(
                        self.session_id,
                        drone_cmd.get("forward_m_s", 0.0),
                        drone_cmd.get("right_m_s", 0.0))
                    self._queue_velocity(tel, dict(
                        forward_m_s = fwd_g,
                        right_m_s   = right_g,
                        down_m_s    = drone_cmd.get("down_m_s",    0.0),
                        yaw_deg_s   = drone_cmd.get("yaw_deg_s",   0.0),
                    ))

            # ── Emit cv_results to frontend ─────────────────────────
            # Client-overlay streams draw boxes browser-side from these
            # payloads, so every fresh result goes out with the frame
            # size for coordinate scaling. Processed streams only feed
            # the results panel - 10Hz is plenty there.
            emit_now = time.time()
            if self._emit_callback and (
                not self._return_video
                or (emit_now - self._last_emit_time) > 0.1
            ):
                self._last_emit_time = emit_now
                try:
                    stages = self._stage_ms()
                    payload = {
                        "mode": mode.value, "session_id": self.session_id,
                        "frame_w": frame.width, "frame_h": frame.height,
                        # Server-side truth. The browser cannot derive any
                        # of this in overlay mode - there is no inbound
                        # RTP to measure.
                        "delivered_fps": round(self._fps, 1),
                        "source_fps": round(self._source_fps, 1),
                        "pipeline_ms": round(sum(stages.values()), 1),
                        **meta,
                    }
                    asyncio.create_task(self._emit_callback(payload))
                except Exception:
                    pass

        if not self._return_video:
            # Nobody watches this track's output - the signaling drive task
            # pulls frames just to keep the pipeline flowing.
            self._maybe_snapshot(img_bgr, frame)
            self._lap("emit_and_persist", _t)
            self._returned_at = time.perf_counter()
            return frame

        _t = self._lap("emit_and_persist", _t)
        out_bgr, out_frame = await loop.run_in_executor(
            self._px_executor, self._compose, analyzer, mode.value, img_bgr
        )
        _t = self._lap("compose", _t)
        self._maybe_snapshot(out_bgr)
        self._lap("snapshot", _t)

        out_frame.pts       = frame.pts
        out_frame.time_base = frame.time_base
        self._returned_at = time.perf_counter()
        return out_frame

    def _clear_caches(self) -> None:
        self._frame_cache.clear()
        self._meta_cache.clear()

    def _analyzer_busy(self, analyzer) -> bool:
        """Is the analyzer mid-inference for THIS session? Read-only peek at
        BaseAnalyzer's in-flight set; an analyzer without one is never busy."""
        inflight = getattr(analyzer, "_inflight", None)
        if not inflight:
            return False
        try:
            return self.session_id in inflight
        except TypeError:
            return False

    # ── Velocity command sender ──────────────────────────────────────────
    def _queue_velocity(self, tel, kwargs: dict) -> None:
        """Latest-wins: a newer setpoint replaces one still waiting to be
        sent. A single task drains the slot, so however slow the MAVSDK
        call gets there is never more than one in flight per track."""
        self._vel_slot = (tel, kwargs)
        self._vel_event.set()
        if self._vel_task is None or self._vel_task.done():
            try:
                self._vel_task = asyncio.get_running_loop().create_task(self._vel_sender())
            except RuntimeError:
                self._vel_task = None

    _VEL_SEND_TIMEOUT_S = 0.5

    async def _vel_sender(self) -> None:
        while True:
            await self._vel_event.wait()
            self._vel_event.clear()
            slot, self._vel_slot = self._vel_slot, None
            if slot is None:
                continue
            tel, kwargs = slot
            try:
                await asyncio.wait_for(
                    tel.send_velocity_command(**kwargs), timeout=self._VEL_SEND_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                logger.warning(
                    f"Session {self.session_id[:8]}: velocity command took longer than "
                    f"{self._VEL_SEND_TIMEOUT_S}s - dropped, the next setpoint supersedes it"
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Session {self.session_id[:8]}: velocity command failed: {e}")

    async def _enrol_captured(self, name: str, paths: list) -> None:
        """Write live-captured shots into the face gallery and tell the
        operator how many actually held a usable face - a shot silently
        dropped for having no detectable face is the difference between a
        gallery that works and one that quietly does not."""
        try:
            from app.vision.persistence import enrol_person_images, load_face_gallery
            results = await enrol_person_images(name, paths)
            ok = sum(1 for r in results if r.ok)
            logger.info(f"Live enrolment: {name!r} - {ok}/{len(results)} shots usable")
            # Reload the in-RAM index so the person is recognisable NOW,
            # rather than only after the session is restarted.
            analyzer = self._vision_pool.get_for_session(self.session_id)
            if analyzer is not None and hasattr(analyzer, "set_gallery"):
                analyzer.set_gallery(await load_face_gallery())
            if self._emit_callback:
                await self._emit_callback({
                    "mode": "person-tracking", "session_id": self.session_id,
                    "enrolment_result": {
                        "name": name, "ok": ok, "total": len(results),
                        "errors": [r.reason for r in results if not r.ok][:3],
                    },
                })
        except Exception as e:
            logger.warning(f"Live enrolment failed for {name!r}: {e}")

    # Overlay modes (detector/trackers) draw the latest results onto the
    # CURRENT camera frame - every frame is displayed, so the video is as
    # smooth as the fly-tab relay and only the annotations lag by one
    # inference. Transform modes (depth/enhancer) return None from
    # draw_overlay and fall back to the cached output frame.
    def _compose(self, analyzer, mode_value: str, img_bgr: np.ndarray):
        out_bgr = None
        if analyzer is not None:
            latest_meta = self._meta_cache.get(mode_value)
            if latest_meta is not None:
                out_bgr = analyzer.draw_overlay(img_bgr, latest_meta)
        if out_bgr is None:
            out_bgr = self._frame_cache.get(mode_value, img_bgr)
        return out_bgr, VideoFrame.from_ndarray(out_bgr, format="bgr24")

    # /admin observer mirror: ~4fps downscaled JPEGs of exactly what this
    # session sees (annotated when a vision mode is active). All work -
    # including the colour conversion on the manual fast path - is skipped
    # while nobody is watching.
    _SNAP_INTERVAL = 0.25
    _SNAP_WIDTH    = 640

    def _maybe_snapshot(self, img_bgr, frame=None):
        if not self._snapshot_cb or not observer.has_watchers(self.session_id):
            return
        now = time.time()
        if (now - self._last_snap_time) < self._SNAP_INTERVAL:
            return
        self._last_snap_time = now
        # Conversion, resize and JPEG encode all run on the pixel executor:
        # on the loop they cost every session a few ms per snapshot (audit
        # V14). Single worker, so snapshots stay in frame order.
        try:
            fut = asyncio.get_running_loop().run_in_executor(
                self._px_executor, self._encode_snapshot, img_bgr, frame
            )
        except RuntimeError:
            return   # executor shut down, or no loop
        fut.add_done_callback(self._on_snapshot_encoded)

    def _encode_snapshot(self, img_bgr, frame) -> bytes | None:
        if img_bgr is None:
            img_bgr = frame.to_ndarray(format="bgr24")
        h, w = img_bgr.shape[:2]
        if w > self._SNAP_WIDTH:
            img_bgr = cv2.resize(
                img_bgr, (self._SNAP_WIDTH, int(h * self._SNAP_WIDTH / w))
            )
        ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return buf.tobytes() if ok else None

    def _on_snapshot_encoded(self, fut) -> None:
        try:
            jpeg = fut.result()
        except Exception as e:
            logger.debug(f"snapshot encode failed: {e}")
            return
        if jpeg is None or not self._snapshot_cb:
            return
        try:
            asyncio.get_running_loop().create_task(self._snapshot_cb(self.session_id, jpeg))
        except RuntimeError:
            pass

    def stop(self):
        try:
            super().stop()
        except Exception:
            pass
        if self._vel_task is not None and not self._vel_task.done():
            self._vel_task.cancel()
        self._vel_slot = None
        try:
            self._px_executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        # Browser-relayed tracks are cleaned up by the peer connection
        # closing; a server-side source (e.g. udp_video_source's MediaPlayer
        # track) has nothing else to stop it and would otherwise leak its
        # decode thread/socket for the life of the process.
        try:
            self.track.stop()
        except Exception:
            pass

    @property
    def fps(self) -> float:
        return round(self._fps, 1)
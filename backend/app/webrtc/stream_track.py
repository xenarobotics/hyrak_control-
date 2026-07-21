import asyncio
import logging
import time
from typing import TYPE_CHECKING, Callable, Optional

import cv2
import numpy as np
from aiortc import MediaStreamTrack
from aiortc.contrib.media import MediaRelay
from av import VideoFrame

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
    ):
        super().__init__()
        self.track           = source_track
        self.session_id      = session_id
        self._vision_pool    = vision_pool
        self._session_mgr    = session_manager
        self._emit_callback  = emit_callback
        self._snapshot_cb    = snapshot_callback
        self._frame_cache:   dict[str, np.ndarray] = {}
        self._meta_cache:    dict[str, dict] = {}
        self._frame_count    = 0
        self._last_fps_time  = time.time()
        self._fps            = 0.0
        self._last_emit_time = 0.0
        self._last_snap_time = 0.0

    async def recv(self) -> VideoFrame:
        frame = await self.track.recv()

        self._frame_count += 1
        now = time.time()
        if (now - self._last_fps_time) >= 1.0:
            self._fps = self._frame_count / (now - self._last_fps_time)
            self._frame_count = 0
            self._last_fps_time = now

        session = self._session_mgr.get(self.session_id)
        mode = session.mode if session else None

        # Fast path: manual control (or no session yet) is a pure relay.
        # Skip the BGR24 <-> native colour-space round trip entirely —
        # it was burning CPU on every frame for the most common mode.
        if mode is None or mode.value == "manual-control":
            self._maybe_snapshot(None, frame)
            return frame

        analyzer = self._vision_pool.get_for_session(self.session_id)

        # While a model is (re)loading there's no annotated frame to draw
        # yet — relay the raw frame instead of paying for a wasted
        # conversion round trip.
        if analyzer is None and mode.value not in self._frame_cache:
            self._maybe_snapshot(None, frame)
            return frame

        img_bgr = frame.to_ndarray(format="bgr24")

        if analyzer:
            try:
                analyzer.submit_frame(self.session_id, img_bgr)
                result = analyzer.get_latest_result(self.session_id)
            except Exception as e:
                logger.warning(f"Vision analyzer error (session {self.session_id[:8]}): {e}")
                result = None

            if result:
                annotated_bgr, meta = result
                self._frame_cache[mode.value] = annotated_bgr
                self._meta_cache[mode.value] = meta

                # ── Send drone command directly to MAVLink ──────────────
                drone_cmd = meta.get("drone_command")
                if drone_cmd and drone_cmd.get("type") == "velocity":
                    tel = self._session_mgr.get_telemetry(self.session_id)
                    if tel and tel.is_connected:
                        asyncio.create_task(
                            tel.send_velocity_command(
                                forward_m_s = drone_cmd.get("forward_m_s", 0.0),
                                right_m_s   = drone_cmd.get("right_m_s",   0.0),
                                down_m_s    = drone_cmd.get("down_m_s",    0.0),
                                yaw_deg_s   = drone_cmd.get("yaw_deg_s",   0.0),
                            )
                        )

                # ── Emit cv_results to frontend (throttled 10Hz) ────────
                emit_now = time.time()
                if self._emit_callback and (emit_now - self._last_emit_time) > 0.1:
                    self._last_emit_time = emit_now
                    try:
                        payload = {"mode": mode.value, "session_id": self.session_id, **meta}
                        asyncio.create_task(self._emit_callback(payload))
                    except Exception:
                        pass

        # Overlay modes (detector/trackers) draw the latest results onto the
        # CURRENT camera frame — every frame is displayed, so the video is as
        # smooth as the fly-tab relay and only the annotations lag by one
        # inference. Transform modes (depth/enhancer) return None here and
        # fall back to the cached output frame.
        out_bgr = None
        if analyzer is not None:
            latest_meta = self._meta_cache.get(mode.value)
            if latest_meta is not None:
                out_bgr = analyzer.draw_overlay(img_bgr, latest_meta)
        if out_bgr is None:
            out_bgr = self._frame_cache.get(mode.value, img_bgr)
        self._maybe_snapshot(out_bgr)

        out_frame = VideoFrame.from_ndarray(out_bgr, format="bgr24")
        out_frame.pts       = frame.pts
        out_frame.time_base = frame.time_base
        return out_frame

    # /admin observer mirror: ~4fps downscaled JPEGs of exactly what this
    # session sees (annotated when a vision mode is active). All work —
    # including the colour conversion on the manual fast path — is skipped
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
        if img_bgr is None:
            img_bgr = frame.to_ndarray(format="bgr24")
        h, w = img_bgr.shape[:2]
        if w > self._SNAP_WIDTH:
            img_bgr = cv2.resize(
                img_bgr, (self._SNAP_WIDTH, int(h * self._SNAP_WIDTH / w))
            )
        ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            return
        try:
            asyncio.create_task(self._snapshot_cb(self.session_id, buf.tobytes()))
        except RuntimeError:
            pass

    def stop(self):
        try:
            super().stop()
        except Exception:
            pass

    @property
    def fps(self) -> float:
        return round(self._fps, 1)
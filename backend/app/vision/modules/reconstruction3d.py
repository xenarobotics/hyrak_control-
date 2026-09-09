"""3D reconstruction analysis mode.

Just another AI mode from the operator's point of view: pick your video
source in Settings like always, hit Start Analysis, and the session's frames
- browser webcam over WebRTC, air-unit ingest, whatever the platform is
configured to use - flow into the reconstruction engine. The engine is the
vendored dronemap sidecar (app/reconstruction/service.py); this module is
only the bridge: it forwards each frame over a local ZMQ socket and reports
the engine's tracking state back as the mode's live results.

Stopping the analysis (or switching modes) ends the scan and the engine
auto-exports the map - mesh, point cloud, trajectory - into the results
list the panel shows.
"""
import logging
import time
from typing import Any, Dict, Tuple

import cv2
import numpy as np

from app.reconstruction import service as recon
from app.vision.base import BaseAnalyzer

logger = logging.getLogger("verocore.vision.reconstruction3d")


class Reconstruction3D(BaseAnalyzer):
    MODE = "3d-reconstruction"

    #: JPEG quality for the frame bridge. 85 keeps corners/texture sharp
    #: enough for KLT tracking at a fraction of raw-frame bandwidth.
    JPEG_QUALITY = 85
    STATUS_POLL_S = 1.0

    def __init__(self, **kwargs):
        super().__init__(executor_workers=1, **kwargs)
        if not recon.installed():
            raise RuntimeError("Reconstruction engine not installed - run "
                               "reconstruction/install.sh on the server")

        import zmq
        self._ctx = zmq.Context.instance()
        self._pub = self._ctx.socket(zmq.PUB)
        # Tiny send queue + no linger: if the engine falls behind we drop
        # frames here rather than buffer stale ones - same drop-oldest
        # philosophy as the rest of the vision pipeline.
        self._pub.setsockopt(zmq.SNDHWM, 2)
        self._pub.setsockopt(zmq.LINGER, 0)
        self._pub.connect(f"tcp://127.0.0.1:{recon.ZMQ_PORT}")
        self._zmq = zmq

        # The engine boots on the FIRST frame, not here: correct tracking
        # needs the true frame geometry (a 4:3 webcam stretched onto a 16:9
        # preset gets anisotropic intrinsics and dies at LOST immediately),
        # and only the first frame knows it. Boot runs on its own thread so
        # frames keep flowing (and dropping harmlessly) meanwhile.
        import threading
        self._boot_lock = threading.Lock()
        self._boot_thread: threading.Thread | None = None
        self._boot_error = ""
        self._session_up = False

        self._status: Dict[str, Any] = {}
        self._last_poll = 0.0
        self._sent = 0
        self._last_diag = 0.0
        self._diag_sent = 0
        logger.info("Reconstruction3D bridge ready - engine boots on first frame")

    def _boot_engine(self, width: int, height: int) -> None:
        ok, msg = recon.start_zmq_session(width, height)
        if ok:
            self._session_up = True
            logger.info(f"✅ Reconstruction engine session up ({width}x{height})")
        else:
            self._boot_error = msg
            logger.error(f"Reconstruction engine boot failed: {msg}")

    @staticmethod
    def _resource_line() -> str:
        """Server load snapshot for the freeze diagnostic: if the machine is
        maxed at the freeze it is a resource wall; if it is idle, the video
        stream itself dropped (network/browser). Cheap - no subprocess."""
        import os
        parts = []
        try:
            la1, _, _ = os.getloadavg()
            parts.append(f"cpu_load={la1:.1f}/{os.cpu_count()}")
        except Exception:
            pass
        try:
            import torch
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                parts.append(f"vram_free={free // (1<<20)}MB/{total // (1<<20)}MB")
        except Exception:
            pass
        return " ".join(parts) or "resources n/a"

    @staticmethod
    def _friendly_error(raw: str) -> str:
        """Turn an engine stack-trace string into one operator-readable line."""
        if "out of memory" in raw.lower() or "cudaErrorMemoryAllocation" in raw:
            return ("Not enough free GPU memory - close other GPU apps "
                    "(Blender, extra browser tabs) and start the scan again")
        return raw.splitlines()[0][:160] if raw else ""

    def _ensure_booted(self, frame_bgr: np.ndarray) -> None:
        with self._boot_lock:
            if self._boot_thread is None:
                import threading
                h, w = frame_bgr.shape[:2]
                self._boot_thread = threading.Thread(
                    target=self._boot_engine, args=(w, h),
                    name="recon-engine-boot", daemon=True)
                self._boot_thread.start()

    def _analyze_frame_blocking(
        self, frame_bgr: np.ndarray
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        self._ensure_booted(frame_bgr)
        if self._boot_error:
            annotated = frame_bgr.copy()
            cv2.putText(annotated, "3D ENGINE FAILED - see server log",
                        (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (60, 60, 240), 2)
            return annotated, {"engine_state": "failed",
                               "engine_error": self._boot_error,
                               "tracking_state": "n/a",
                               "keyframes": 0, "landmarks": 0}
        okj, buf = cv2.imencode(
            ".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, self.JPEG_QUALITY])
        if okj:
            try:
                # Single-part JPEG: the engine's zmq ingest decodes it
                # directly. NOBLOCK + small HWM = drop instead of stall.
                self._pub.send(buf.tobytes(), self._zmq.NOBLOCK)
                self._sent += 1
            except self._zmq.ZMQError:
                pass  # engine busy - this frame is simply dropped

        now = time.monotonic()
        if now - self._last_poll > self.STATUS_POLL_S:
            self._last_poll = now
            self._status = recon.poll_status() or {"state": "unreachable"}

            # Freeze diagnostics: every 5 s, log how many frames THIS analyzer
            # has sent to the engine vs how many the engine reports receiving.
            # When a scan freezes this pins the blame precisely:
            #   sent climbing + engine frames flat  -> ENGINE stopped consuming
            #   sent flat                            -> browser feed stopped
            if now - self._last_diag > 5.0:
                sent_rate = (self._sent - self._diag_sent) / (now - self._last_diag)
                eng_frames = self._status.get("frames", 0)
                logger.info(
                    "3D bridge diag: analyzer sent=%d (%.1f/s) | engine "
                    "frames=%d state=%s track=%s | %s",
                    self._sent, sent_rate, eng_frames,
                    self._status.get("state"), self._status.get("tracking_state"),
                    self._resource_line())
                self._last_diag = now
                self._diag_sent = self._sent

        st = self._status
        # An engine that died AFTER a clean start (e.g. CUDA OOM ~4s in when
        # the card is shared with Blender/a browser) reports state=finished
        # with an error. Surface it as a failure so the UI stops "loading"
        # and says what happened, instead of spinning forever.
        engine_err = st.get("error") or ""
        eng_state = st.get("state", "n/a")
        if engine_err and eng_state in ("finished", "failed"):
            eng_state = "failed"
        meta: Dict[str, Any] = {
            "engine_state": eng_state,
            "engine_error": (self._friendly_error(engine_err) if engine_err else ""),
            "tracking_state": st.get("tracking_state", "n/a"),
            "keyframes": st.get("keyframes", 0),
            "landmarks": st.get("landmarks", 0),
            "frames_bridged": self._sent,
            # The resolution ACTUALLY arriving at the server - the ground
            # truth for "are my video settings taking effect". The user's
            # 1080p setting governs capture; WebRTC can still degrade in
            # transit, and the first corridor scan arrived at 640x360 with
            # nobody able to see that anywhere. Now the panel shows it live.
            "input_w": int(frame_bgr.shape[1]),
            "input_h": int(frame_bgr.shape[0]),
        }
        # The processed feed is the raw frame plus a small state banner -
        # reconstruction's real output is the 3D map, not an annotation.
        track = meta["tracking_state"]
        color = {"tracking": (74, 222, 128), "degraded": (36, 191, 251),
                 "lost": (113, 113, 248)}.get(track, (161, 161, 161))
        annotated = frame_bgr.copy()
        cv2.putText(annotated, f"3D SCAN [{track.upper()}]  kf {meta['keyframes']}",
                    (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
        cv2.putText(annotated, f"3D SCAN [{track.upper()}]  kf {meta['keyframes']}",
                    (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        return annotated, meta

    async def stop(self):
        # Mode switch / Stop Analysis = the scan is over: end the engine
        # session so it exports the map now instead of waiting out the
        # stall window. The engine process itself stays warm for the next
        # scan; only /api/recon/engine/shutdown kills it.
        try:
            self._pub.close(0)
        except Exception:
            pass
        try:
            import asyncio
            await asyncio.to_thread(recon.stop_session, "analysis stopped")
        except Exception:
            pass
        await super().stop()

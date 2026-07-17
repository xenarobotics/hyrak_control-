import asyncio
import sys
import uvicorn
from app.config import get_settings

settings = get_settings()

# Windows requires SelectorEventLoop for aiortc (WebRTC) to work correctly.
# ProactorEventLoop (Windows default) does not support all socket operations aiortc needs.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

if __name__ == "__main__":
    uvicorn.run(
        "app.server:create_app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        reload=True,
        # Without reload_dirs, uvicorn watches the whole CWD (backend/) recursively —
        # including .venv/ and any runtime files mavsdk_server or Python write during
        # a connect cycle. That was triggering a full worker reload (killing every
        # open WebSocket, including live telemetry) on every connect_telemetry call.
        reload_dirs=["app"],
        factory=True,
    )

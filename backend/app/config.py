from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from functools import lru_cache
from pathlib import Path
import torch

ROOT_DIR = Path(__file__).parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Server
    secret_token: str = Field(default="dev_token_change_in_production")
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8001)
    log_level: str = Field(default="info")
    allowed_origins: list[str] = Field(default=["http://localhost:3000"])

    # Vision
    default_yolo_model: str = Field(default="yolov8m.pt")
    inference_resize_width: int = Field(default=640)
    max_concurrent_sessions: int = Field(default=4)
    force_cpu: bool = Field(default=False)

    # Database — local Postgres for now; swapping to a managed provider
    # (Supabase/RDS are both Postgres) is just changing this URL.
    database_url: str = Field(
        default="postgresql+asyncpg://hyrak:hyrak_dev@127.0.0.1:5432/hyrak"
    )

    # Telemetry
    default_baud_rate: int = Field(default=57600)
    mavsdk_server_host: str = Field(default="localhost")
    mavsdk_server_port: int = Field(default=50051)
    sitl_address: str = Field(default="udpin://0.0.0.0:14540")

    @property
    def lan_origins(self) -> list[str]:
        """
        Frontend origin for whatever LAN IP this machine currently has — the
        CORS allowlist below is an exact-string match (no wildcard/regex
        support in either FastAPI's CORSMiddleware or python-engineio), and
        DHCP can reassign the LAN IP across reboots, so this is computed at
        startup instead of hardcoded in .env.
        """
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))  # doesn't actually send anything — just picks the outbound interface
            ip = s.getsockname()[0]
            s.close()
            return [f"http://{ip}:3000"]
        except Exception:
            return []

    @property
    def device(self) -> str:
        if self.force_cpu:
            return "cpu"
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    @property
    def gpu_count(self) -> int:
        return torch.cuda.device_count() if torch.cuda.is_available() else 0

    @property
    def gpu_info(self) -> list[dict]:
        if not torch.cuda.is_available():
            return []
        return [
            {
                "index": i,
                "name": torch.cuda.get_device_name(i),
                "memory_gb": round(
                    torch.cuda.get_device_properties(i).total_memory / 1e9, 1
                ),
            }
            for i in range(torch.cuda.device_count())
        ]


@lru_cache
def get_settings() -> Settings:
    """Returns cached settings instance. Import this everywhere."""
    return Settings()

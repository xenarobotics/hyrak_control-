import logging
import sys
from app.config import get_settings


def setup_logging() -> logging.Logger:
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )

    # Silence noisy third-party loggers
    logging.getLogger("aiortc").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("ultralytics").setLevel(logging.WARNING)

    return logging.getLogger("verocore")


logger = setup_logging()
"""Structured (JSON-lines) logging to stderr.

Kept dependency-free; swap in OpenTelemetry exporters later without touching
call sites (loggers are fetched by name, records carry structured extras).
"""

from __future__ import annotations

import json
import logging
import os
import sys

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str)


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    root = logging.getLogger("orrery")
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
        root.setLevel(os.environ.get("ORRERY_LOG_LEVEL", "WARNING").upper())
        root.propagate = False
    return logger

"""Structured execution events: append-only, codec-validated JSONL per run."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from strive import codec
from strive.contracts import Event


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EventLog:
    """Append-only event stream for one loop cycle.

    Every line is a codec-encoded ``event@1`` record; reading validates each
    line and fails loudly on interior corruption.
    """

    def __init__(self, path: Path, run_id: str) -> None:
        self._path = path
        self._run_id = run_id
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def emit(self, event_type: str, **payload: object) -> None:
        event = Event(ts=now_iso(), type=event_type, run_id=self._run_id, payload=payload)
        line = codec.dumps(event) + "\n"
        with self._path.open("ab") as handle:
            handle.write(line.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())

    def read_all(self) -> list[Event]:
        if not self._path.exists():
            return []
        events: list[Event] = []
        with self._path.open(encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    events.append(codec.loads(line, Event))
                except codec.SchemaError as exc:
                    raise codec.SchemaError(
                        f"{self._path}:{line_no}: {exc}"
                    ) from None
        return events

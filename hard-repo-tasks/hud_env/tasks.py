"""Generated HUD task bindings. Run with `hud eval tasks.py <model>`."""

from __future__ import annotations

import json
from pathlib import Path

from env import env, repair  # noqa: F401

ROWS = json.loads(Path(__file__).with_name("tasks.json").read_text())
tasks = [repair(**row["args"]) for row in ROWS]

for task, row in zip(tasks, ROWS, strict=True):
    task.slug = row["slug"]
    task.columns = row.get("columns", {})
    task.agent_config = row.get("agent_config", {})

del task, row

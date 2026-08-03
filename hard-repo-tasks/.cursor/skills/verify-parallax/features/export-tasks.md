# Export repository tasks

## Sub-features

- Export compiled public task data to HUD v6 JSON.
- Export compiled public task data to Verifiers v1 JSONL.
- Generate `taskset.py` beside a Verifiers export.
- Keep sealed recipes, gold patches, and check definitions out of exported
  task rows.

## How to get to it (user POV)

First compile one or more repository recipes. Keep the artifact root and each
`public/manifest.json`. Choose `hud` or `verifiers` as the export platform.

## Driving it with the Parallax CLI

```bash
uv run parallax export hud \
  /path/to/compiled-artifacts \
  /path/to/compiled-artifacts/<task-id>/public/manifest.json \
  --out /path/to/isolated/tasks.json

uv run parallax export verifiers \
  /path/to/compiled-artifacts \
  /path/to/compiled-artifacts/<task-id>/public/manifest.json \
  --out /path/to/isolated/tasks.jsonl
```

Inspect every emitted row and confirm it contains the task ID, source revision,
prompt, and encoded starter patch but no gold patch or recipe checks. The
Verifiers command must also emit `taskset.py` beside `tasks.jsonl`.

For the repository's current HUD task listing, use the separate HUD project:

```bash
cd hud_env
uv sync
uv run hud task list --source tasks.py
```

## Gotchas

Export consumes existing artifacts and does not compile or admit tasks. HUD
listing checks the adapter project, not a model rollout. Loading generated
Verifiers glue requires `uv sync --extra verifiers`; executing a task also
requires a container runtime and an evaluator image providing
`parallax-evaluator`. Those runtime conditions are not proved by file export.

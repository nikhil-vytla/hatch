# Compile a pinned repository recipe

## Sub-features

- Validate that the source checkout is clean and at the recipe's exact commit.
- Build temporary base, gold, and starter trees without changing the source.
- Run recipe admission checks.
- Emit public manifest and starter patch separately from sealed recipe, gold
  patch, and admission evidence.

## How to get to it (user POV)

From the repository root, prepare Parallax with `uv sync`. Obtain the source
repository named by the recipe and check out the exact revision in its
`source.revision` field. The source checkout must have no tracked or untracked
changes.

## Driving it with the Parallax CLI

```bash
uv run parallax compile \
  recipes/click/00-portable.json \
  /path/to/pinned/click \
  --out /path/to/isolated/output
```

Capture the command's JSON manifest and exit code. Inspect
`<output>/<task_id>/public/manifest.json`,
`<output>/<task_id>/public/starter.patch`, and the sealed admission record.
Proof requires all gold checks to pass and at least one intended starter check
to fail.

## Gotchas

Compilation refuses a dirty source or revision mismatch. Recipe checks execute
code from a trusted pinned repository in temporary copies, but the process does
not create a security sandbox. The skill does not ship the Click checkout, so
this path is unavailable until the exact source is present. Do not include the
fetched source repository in evidence.

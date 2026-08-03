"""Turn "n dragged-in files + a plain-language description" into a task bundle.

This prototypes the data-layer half of the non-technical-user flow. The user
gives a folder of arbitrary files and one sentence about what the agent
should do. We produce a deterministic, content-addressed task bundle:

  bundle/
    manifest.json        description + seed inventory, every file by digest
    setup_seed.sh        materializes seeds into the sandbox from the store
    grader_stub.py       runnable grader skeleton with the reward contract
    synthesis_prompt.md  the exact prompt an LLM synthesis step would get

Seed bytes live in a shared content-addressed store (--store), not in the
bundle. Two bundles that drop the same file share one stored object; that is
the same dedup argument the main design makes for rollout checkpoints,
demonstrated at drag-and-drop scale.

The scenario/grader generation itself is a model call in a real system; here
it is emitted as a prompt file plus a runnable stub, so the pipeline shape,
determinism, and dedup are testable today without any paid API.

Usage:
  python3 synth_task.py --files ./drops/expense_audit \
      --description "Find policy violations in these expense reports" \
      --name expense_audit --store ./store --out ./bundles/expense_audit
"""

import argparse
import hashlib
import json
import os
import shutil
import stat

TEXT_EXT = {".txt", ".md", ".csv", ".json", ".log", ".py", ".sh", ".yaml",
            ".yml", ".toml", ".xml", ".html"}


def sniff_kind(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXT:
        return {"csv": "tabular", "json": "structured", "log": "logs"}.get(
            ext.lstrip("."), "text")
    with open(path, "rb") as f:
        head = f.read(512)
    return "text" if not head or b"\x00" not in head else "binary"


def head_sample(path: str, kind: str, lines: int = 5) -> str | None:
    if kind == "binary":
        return None
    from itertools import islice
    with open(path, errors="replace") as f:
        return "".join(islice(f, lines))


def store_object(path: str, store: str) -> tuple[str, int]:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    dest = os.path.join(store, "objects", digest[:2], digest)
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(path, dest)
        os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)  # immutable-ish
    return digest, os.path.getsize(path)


SETUP_TEMPLATE = """#!/bin/sh
# Materialize seed files into the sandbox working directory from the
# content-addressed store. Hardlink when possible (zero-copy), else copy.
# STORE is mounted read-only into the sandbox by the platform.
set -e
STORE="${STORE:-/store}"
DEST="${DEST:-/work/seed}"
mkdir -p "$DEST"
{lines}
"""

GRADER_TEMPLATE = '''#!/usr/bin/env python3
"""Grader for task: {name}

Contract: run with the rollout's final /work as cwd, read-only access to the
seed manifest, print a float reward in [0, 1] on the last line of stdout.
Generated as a stub; the synthesis step (see synthesis_prompt.md) fills in
the checks. Sanity contract from the design doc: unchanged seed state must
score 0.0; a correct completion must score 1.0.
"""
import json, os, sys

MANIFEST = json.load(open(os.path.join(os.path.dirname(__file__), "manifest.json")))

def grade() -> float:
    # TODO(synthesis): replace with checks derived from the description:
    #   {description}
    # Available signals: files under cwd (agent's final state), MANIFEST
    # (seed inventory with digests -- detect modified/deleted seeds by
    # rehashing), and any task-specific outputs the scenario asks for.
    raise NotImplementedError("grader not yet synthesized")

if __name__ == "__main__":
    print(grade())
'''

PROMPT_TEMPLATE = """# Task synthesis request

You are generating an agent task from user-supplied files and a description.

## User description

{description}

## Seed file inventory

{inventory}

## Produce

1. `scenario.md`: the prompt shown to the agent. It must reference seed
   files by their paths under /work/seed and define a concrete, verifiable
   deliverable.
2. `grader.py`: implements `grade() -> float` in [0,1] per the contract in
   grader_stub.py. Prefer checks over final filesystem state (files the
   agent must create or modify), so grading works from a state checkpoint
   without a live agent. Unchanged seed state must score 0.0. Include at
   least one check that cannot be satisfied by an empty or trivial output.
3. `validation.md`: describe the null baseline (no-op agent) and oracle
   (reference solution) you would run to check that grade(null)=0 and
   grade(oracle)=1 before the task is published.
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", required=True)
    ap.add_argument("--description", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--store", default="./store")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    seeds = []
    setup_lines = []
    inventory_lines = []
    for root, _, files in os.walk(args.files):
        for fn in sorted(files):
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, args.files)
            digest, size = store_object(src, args.store)
            kind = sniff_kind(src)
            seeds.append({"path": rel, "sha256": digest, "bytes": size,
                          "kind": kind})
            obj = f'$STORE/objects/{digest[:2]}/{digest}'
            setup_lines.append(
                f'mkdir -p "$DEST/$(dirname "{rel}")" 2>/dev/null || true\n'
                f'ln "{obj}" "$DEST/{rel}" 2>/dev/null || cp "{obj}" "$DEST/{rel}"')
            sample = head_sample(src, kind)
            inventory_lines.append(
                f"- `{rel}` ({kind}, {size} bytes, sha256 {digest[:12]}...)"
                + (f"\n  sample:\n  ```\n  {sample.rstrip()}\n  ```"
                   if sample else ""))

    manifest = {"name": args.name, "description": args.description,
                "seeds": seeds,
                "store": os.path.relpath(args.store, args.out)}
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(args.out, "setup_seed.sh"), "w") as f:
        f.write(SETUP_TEMPLATE.replace("{lines}", "\n".join(setup_lines)))
    os.chmod(os.path.join(args.out, "setup_seed.sh"), 0o755)
    with open(os.path.join(args.out, "grader_stub.py"), "w") as f:
        f.write(GRADER_TEMPLATE.format(name=args.name,
                                       description=args.description))
    with open(os.path.join(args.out, "synthesis_prompt.md"), "w") as f:
        f.write(PROMPT_TEMPLATE.format(description=args.description,
                                       inventory="\n".join(inventory_lines)))

    n_objects = sum(len(files) for _, _, files in
                    os.walk(os.path.join(args.store, "objects")))
    print(f"bundle {args.name}: {len(seeds)} seeds, "
          f"{sum(s['bytes'] for s in seeds)} bytes; "
          f"store now holds {n_objects} unique objects")


if __name__ == "__main__":
    main()

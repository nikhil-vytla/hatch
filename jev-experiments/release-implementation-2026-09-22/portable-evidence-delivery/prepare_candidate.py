#!/usr/bin/env python3
"""Assemble a bounded portable-evidence candidate in a clean isolated checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

CANDIDATE = "acd35640945d13bc154765cef2db494026bc1b55"
PREFIX = "jev-experiments/roadmap/integration/"
HELPERS = ["portable-records.ts", "portable-records.test.ts", "portable-client-schemas.ts",
           "portable-clients.test.ts", "portable-index.ts", "portable-publication.test.ts",
           "evidence_index.py", "README.md", "evidence/index.json"]
PROJECTION = ["jev-experiments/capability-atlas-2026-09-22/publication-projection.ts",
              "jev-experiments/capability-atlas-2026-09-22/publication-projection.test.ts"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error("Choose a new report")
    def git(*parts):
        return subprocess.check_output(["git", *parts], cwd=args.repo, stderr=subprocess.PIPE)
    if git("rev-parse", "HEAD").decode().strip() != args.base or git("status", "--porcelain"):
        raise ValueError("Expected clean isolated base checkout")
    inventory = json.loads(args.inventory.read_text())
    by_path = {f["path"]: f for f in inventory["files"]}
    paths = sorted([PREFIX + name for name in HELPERS] + PROJECTION +
                   [name for name in by_path if name.startswith(PREFIX + "evidence/") and name.endswith(".portable.json")])
    removals = inventory["removals"]
    if len(removals) != 47 or sum(p.endswith(".portable.json") for p in paths) != 47:
        raise ValueError("Unexpected retained input selection")
    selected = {}
    # Validate the entire selection before editing the isolated tree.
    content = {}
    for name in paths:
        raw = git("show", CANDIDATE + ":" + name)
        if sha(raw) != by_path[name]["sha256"] or len(raw) != by_path[name]["bytes"] or len(raw) >= 2_000_000:
            raise ValueError("Candidate source does not match frozen selected input")
        content[name] = raw
    for entry in removals:
        if not entry["path"].startswith(PREFIX + "evidence/") or entry["replacedBy"] not in paths or sha(git("show", args.base + ":" + entry["path"])) != entry["predecessorSha256"]:
            raise ValueError("Original identity or replacement changed")
    for name, raw in content.items():
        target = args.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        selected[name] = {"sha256": sha(raw), "bytes": len(raw), "origin": "exact-candidate08", "candidate08Sha256": sha(raw)}
    for entry in removals:
        (args.repo / entry["path"]).unlink()
    # Main has the canonical build and benchmark projection already. Add only this projection.
    prepare = "jev-experiments/experience-prototypes/scripts/prepare.ts"
    raw = (args.repo / prepare).read_bytes()
    text = raw.decode()
    old = 'import { prepareLiveWorlds } from "../../live-worlds/prepare";\n'
    if text.count(old) != 1 or text.count('mkdirSync(dest, { recursive: true });\n') != 1:
        raise ValueError("Build preparation precondition changed")
    text = text.replace(old, old + 'import { preparePublicHarnessEvidence } from "../../capability-atlas-2026-09-22/publication-projection";\n')
    text = text.replace('mkdirSync(dest, { recursive: true });\n', 'mkdirSync(dest, { recursive: true });\npreparePublicHarnessEvidence(lab, resolve("public/routing-evidence"));\n')
    (args.repo / prepare).write_text(text)
    selected[prepare] = {"origin": "bounded-main-adaptation", "baseSha256": sha(raw)}
    ignore = "jev-experiments/experience-prototypes/.gitignore"
    raw = (args.repo / ignore).read_bytes()
    if b"public/routing-evidence/" in raw: raise ValueError("Ignore rule already present")
    (args.repo / ignore).write_bytes(raw + b"\n# Generated portable integration-evidence downloads.\npublic/routing-evidence/\n")
    selected[ignore] = {"origin": "bounded-main-adaptation", "baseSha256": sha(raw)}
    readme = PREFIX + "README.md"
    text = content[readme].decode()
    lead = text.split("\n\n")[1]
    if not lead.startswith("This page records historical client sessions."):
        raise ValueError("README adaptation precondition changed")
    text = text.replace(lead + "\n\n", "", 1)
    text = text.replace("the portable Codex format", "the portable client format")
    text = text.replace("The five historical Codex summaries and transcripts", "Retained OpenCode, Claude Code and Codex summaries and transcripts")
    text = text.replace("## Portable Codex records", "## Portable client records")
    for entry in removals:
        old = "evidence/" + entry["path"].removeprefix(PREFIX + "evidence/")
        new = "evidence/" + entry["replacedBy"].removeprefix(PREFIX + "evidence/")
        text = text.replace("(" + old + ")", "(" + new + ")")
    (args.repo / readme).write_text(text)
    selected[readme]["origin"] = "bounded-candidate08-documentation-adaptation"
    workflow = ".github/workflows/jev-portable-evidence.yml"
    if (args.repo / workflow).exists(): raise ValueError("Workflow already exists")
    (args.repo / workflow).write_text('''name: Jev portable evidence

on:
  pull_request:
    paths:
      - "jev-experiments/**"
      - ".github/workflows/jev-portable-evidence.yml"
  push:
    branches: [main]
    paths:
      - "jev-experiments/**"
      - ".github/workflows/jev-portable-evidence.yml"

permissions:
  contents: read

jobs:
  portable-evidence:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: "1.3.14"
      - name: Install application from its lockfile
        working-directory: jev-experiments/experience-prototypes
        run: bun install --frozen-lockfile
      - name: Build from committed evidence inputs
        working-directory: jev-experiments/experience-prototypes
        run: bun run build
      - name: Verify portable records, indexes and publication projections
        run: bun test jev-experiments/roadmap/integration/portable-records.test.ts jev-experiments/roadmap/integration/portable-clients.test.ts jev-experiments/roadmap/integration/portable-publication.test.ts jev-experiments/capability-atlas-2026-09-22/publication-projection.test.ts
      - name: Check archive index is already current
        run: |
          python3 jev-experiments/roadmap/integration/evidence_index.py
          git diff --exit-code -- jev-experiments/roadmap/integration/evidence/index.json
      - name: Verify public record integrity
        run: bun run jev-experiments/roadmap/verification/publication.ts
''')
    selected[workflow] = {"origin": "new-focused-provider-free-ci"}
    for name, metadata in selected.items():
        raw = (args.repo / name).read_bytes()
        metadata.update({"sha256": sha(raw), "bytes": len(raw)})
    result = {"base": args.base, "candidate08": CANDIDATE, "candidate08InventorySha256": sha(args.inventory.read_bytes()),
              "selected": selected, "removals": removals, "selectedCount": len(selected), "removalCount": len(removals),
              "runtimeChanges": False, "uiChanges": False, "dependenciesChanged": False, "pushed": False}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("base", "selectedCount", "removalCount", "runtimeChanges", "uiChanges")}))


if __name__ == "__main__":
    main()

"""Pinned public data; downloaded material stays in ignored .cache/."""

import csv
import fcntl
import hashlib
import io
import json
import random
import sys
from collections import defaultdict

import httpx

from .core import ROOT, save

CACHE = ROOT / ".cache"


def fetch(repo: str, branch: str, path: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    with (CACHE / "sources.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _fetch_locked(repo, branch, path)


def _fetch_locked(repo: str, branch: str, path: str) -> bytes:
    manifest_path = CACHE / "sources.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if repo not in manifest:
        response = httpx.get(f"https://api.github.com/repos/{repo}/commits/{branch}", timeout=30)
        response.raise_for_status()
        manifest[repo] = {"commit": response.json()["sha"], "files": {}}
    sha = manifest[repo]["commit"]
    local = CACHE / "upstream" / repo / sha / path
    if not local.exists():
        response = httpx.get(
            f"https://raw.githubusercontent.com/{repo}/{sha}/{path}",
            timeout=60,
            follow_redirects=True,
        )
        response.raise_for_status()
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(response.content)
    content = local.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    previous = manifest[repo]["files"].get(path)
    if previous and previous != checksum:
        raise ValueError(f"Cached source checksum changed: {repo}/{path}")
    manifest[repo]["files"][path] = checksum
    save(manifest_path, manifest)
    return content


def source_manifest():
    path = CACHE / "sources.json"
    return json.loads(path.read_text()) if path.exists() else {}


def banking(split="test"):
    repo = "PolyAI-LDN/task-specific-datasets"
    labels = json.loads(fetch(repo, "master", "banking_data/categories.json"))
    data = list(
        csv.DictReader(io.StringIO(fetch(repo, "master", f"banking_data/{split}.csv").decode()))
    )
    return [
        {"id": f"banking77/{split}/{i}", "text": r["text"], "target": r["category"]}
        for i, r in enumerate(data)
    ], {k: k.replace("_", " ") for k in labels}


def clinc(split="test"):
    data = json.loads(fetch("clinc/oos-eval", "master", "data/data_full.json"))
    labels = sorted({r[1] for r in data["train"]})
    rows = [
        {"id": f"clinc150/{split}/{i}", "text": r[0], "target": r[1]}
        for i, r in enumerate(data[split])
    ]
    rows += [
        {"id": f"clinc150/oos_{split}/{i}", "text": r[0], "target": "out_of_scope"}
        for i, r in enumerate(data[f"oos_{split}"])
    ]
    return rows, {
        **{k: k.replace("_", " ") for k in labels},
        "out_of_scope": "The request does not match ANY supported intent",
    }


def balanced(rows, per_class, seed=42, oos=None):
    groups = defaultdict(list)
    for row in rows:
        groups[row["target"]].append(row)
    rng, selected = random.Random(seed), []
    for label in sorted(groups):
        group = groups[label].copy()
        rng.shuffle(group)
        selected.extend(group[: oos if label == "out_of_scope" and oos is not None else per_class])
    rng.shuffle(selected)
    return selected


def judgebench(limit=100, seed=42):
    rows = []
    for model in ("gpt-4o-2024-05-13", "claude-3-5-sonnet-20240620"):
        content = fetch(
            "ScalerLab/JudgeBench", "main", f"data/dataset=judgebench,response_model={model}.jsonl"
        )
        rows.extend(json.loads(line) for line in content.splitlines() if line)
    # Stratify by source and response model, then round-robin across shuffled strata.
    groups = defaultdict(list)
    for r in rows:
        groups[(r["source"], r["response_model"])].append(r)
    rng = random.Random(seed)
    for group in groups.values():
        rng.shuffle(group)
    selected = []
    while len(selected) < min(limit, len(rows)):
        for key in sorted(groups):
            if groups[key] and len(selected) < limit:
                selected.append(groups[key].pop())
    return selected


def ifeval(limit=40, seed=42):
    repo, prefix = "google-research/google-research", "instruction_following_eval"
    content = fetch(repo, "master", f"{prefix}/data/input_data.jsonl")
    for name in (
        "instructions.py",
        "instructions_registry.py",
        "instructions_util.py",
        "evaluation_lib.py",
    ):
        fetch(repo, "master", f"{prefix}/{name}")
    sha = source_manifest()[repo]["commit"]
    root = CACHE / "upstream" / repo / sha
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    rows = [json.loads(line) for line in content.splitlines() if line]
    random.Random(seed).shuffle(rows)
    return rows[:limit]


def check_ifeval(row, text):
    from instruction_following_eval import evaluation_lib

    inp = evaluation_lib.InputExample(
        key=row["key"],
        instruction_id_list=row["instruction_id_list"],
        prompt=row["prompt"],
        kwargs=row["kwargs"],
    )
    strict = evaluation_lib.test_instruction_following_strict(inp, {row["prompt"]: text})
    loose = evaluation_lib.test_instruction_following_loose(inp, {row["prompt"]: text})
    return {
        "strict": bool(strict.follow_all_instructions),
        "loose": bool(loose.follow_all_instructions),
        "per_instruction": strict.follow_instruction_list,
    }


def train_validation(rows, seed=42, fraction=0.2):
    groups = defaultdict(list)
    for row in rows:
        groups[row["target"]].append(row)
    train, validation = [], []
    rng = random.Random(seed)
    for group in groups.values():
        rng.shuffle(group)
        cut = max(1, int(len(group) * fraction))
        validation.extend(group[:cut])
        train.extend(group[cut:])
    return train, validation

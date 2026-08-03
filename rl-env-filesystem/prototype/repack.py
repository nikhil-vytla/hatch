"""Decompose image layers by observed access, and evaluate prefetch policies.

Takes the per-task access profiles produced by analyze.py and:

1. Classifies every image file:
     hot   - accessed by >= 2 tasks (interpreter, libc, loader, shared libs)
     warm  - accessed by exactly 1 task (task-specific working set)
     cold  - accessed by no traced task
2. Emits repacked layer tars: one hot layer, one warm layer per task, one
   cold remainder, with real gzip sizes for honest compressed comparisons.
3. Evaluates delivery policies, including leave-one-out prefetch: for each
   task, pretend it is a NEW task, prefetch only what the OTHER tasks'
   profiles predict, and measure the miss bytes the sandbox would fault in
   lazily mid-rollout.

Usage: python3 repack.py task_a task_b ... (reads results/<task>.json)
"""

import gzip
import io
import json
import os
import sys
import tarfile

PROTO_DIR = os.path.dirname(os.path.abspath(__file__))
ROOTFS = os.path.join(PROTO_DIR, "image", "rootfs")


def load_profiles(tasks: list[str]) -> dict[str, dict]:
    profiles = {}
    for t in tasks:
        with open(os.path.join(PROTO_DIR, "results", f"{t}.json")) as f:
            profiles[t] = json.load(f)
    return profiles


def classify(profiles: dict, ownership: dict) -> tuple[dict, dict, set, set]:
    counts: dict[str, set] = {}
    for t, rep in profiles.items():
        for path in rep["profile"]:
            counts.setdefault(path, set()).add(t)
    hot = {p for p, ts in counts.items() if len(ts) >= 2}
    warm = {t: {p for p, ts in counts.items() if ts == {t}}
            for t in profiles}
    cold = set(ownership) - set(counts)
    return counts, warm, hot, cold


def pack(paths: set, name: str) -> tuple[int, int]:
    """Tar+gzip the given rootfs paths; return (uncompressed, compressed)."""
    buf = io.BytesIO()
    total = 0
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for p in sorted(paths):
            host = os.path.join(ROOTFS, p)
            if not os.path.isfile(host) or os.path.islink(host):
                continue
            tar.add(host, arcname=p)
            total += os.path.getsize(host)
    compressed = gzip.compress(buf.getvalue(), compresslevel=6)
    out = os.path.join(PROTO_DIR, "repacked", name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(compressed)
    return total, len(compressed)


def size_of(paths: set, ownership: dict) -> int:
    return sum(ownership[p]["size"] for p in paths if p in ownership)


def main() -> None:
    tasks = sys.argv[1:]
    with open(os.path.join(PROTO_DIR, "image", "layers.json")) as f:
        meta = json.load(f)
    ownership = meta["ownership"]
    profiles = load_profiles(tasks)

    counts, warm, hot, cold = classify(profiles, ownership)

    image_bytes = sum(o["size"] for o in ownership.values())
    image_comp = sum(l["compressed_bytes"] for l in meta["layers"])

    hot_u, hot_c = pack(hot, "hot.tar.gz")
    lines = ["# Repack and prefetch evaluation", ""]
    lines.append(f"Image: {meta['image']} + synthetic deps layer. "
                 f"{len(ownership)} files, {image_bytes/1e6:.1f} MB "
                 f"uncompressed, {image_comp/1e6:.1f} MB compressed.")
    lines.append("")
    lines.append("## Access-based decomposition")
    lines.append("")
    lines.append("| tier | files | uncompressed | compressed |")
    lines.append("| --- | --- | --- | --- |")
    lines.append(f"| hot (>=2 tasks) | {len(hot)} | {hot_u/1e6:.1f} MB | {hot_c/1e6:.1f} MB |")
    warm_rows = []
    for t in tasks:
        wu, wc = pack(warm[t], f"warm_{t}.tar.gz")
        warm_rows.append((t, len(warm[t]), wu, wc))
        lines.append(f"| warm ({t}) | {len(warm[t])} | {wu/1e6:.1f} MB | {wc/1e6:.1f} MB |")
    cold_bytes = size_of(cold, ownership)
    lines.append(f"| cold (never accessed) | {len(cold)} | {cold_bytes/1e6:.1f} MB | ~{cold_bytes/image_bytes*image_comp/1e6:.1f} MB |")
    lines.append("")

    lines.append("## Delivery policies: bytes before the agent can start")
    lines.append("")
    lines.append("| policy | bytes fetched up front | lazy tail during rollout |")
    lines.append("| --- | --- | --- |")
    lines.append(f"| eager full pull (baseline) | {image_comp/1e6:.1f} MB compressed | 0 |")
    lines.append(f"| lazy, no prefetch | ~index only (KBs) | up to task working set |")
    lines.append(f"| hot-layer prefetch | {hot_c/1e6:.1f} MB | task's warm set |")
    for t, n, wu, wc in warm_rows:
        lines.append(f"| hot + profile prefetch ({t}) | {(hot_c+wc)/1e6:.1f} MB | ~0 (profile hit) |")
    lines.append("")

    lines.append("## Leave-one-out: a NEW task arrives, prefetch from other tasks' profiles")
    lines.append("")
    lines.append("| held-out task | accessed bytes | covered by prefetch | missed (lazy faults) | coverage |")
    lines.append("| --- | --- | --- | --- | --- |")
    for held in tasks:
        others_touch = set()
        for t in tasks:
            if t != held:
                others_touch |= set(profiles[t]["profile"])
        held_profile = profiles[held]["profile"]
        acc = sum(p["bytes_est"] for p in held_profile.values())
        covered = sum(p["bytes_est"] for path, p in held_profile.items()
                      if path in others_touch)
        missed = acc - covered
        lines.append(f"| {held} | {acc/1e6:.1f} MB | {covered/1e6:.1f} MB "
                     f"| {missed/1e6:.1f} MB | {100*covered/acc:.0f}% |")
    lines.append("")
    lines.append("Reading: 'coverage' is how much of a never-before-seen task's "
                 "working set the union of other tasks' profiles would have "
                 "prefetched. The miss column is what a lazy filesystem would "
                 "fault in on demand, i.e. the mid-rollout latency exposure.")

    out = os.path.join(PROTO_DIR, "results", "summary.md")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

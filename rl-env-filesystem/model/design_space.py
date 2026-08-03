"""Enumerate the design space for an RL rollout data layer and prune it.

Companion to the README. Seven axes, a handful of hard constraints derived
from the seven jobs the layer must do, and a classification of every
combination as pruned, adapter-only (valid where a customer's runtime
cooperates, never required by the core product), or core-viable.

Run: python3 design_space.py
"""

from itertools import product

AXES = {
    "interface": [
        "object_api",           # A1: sandbox pulls blobs itself
        "fuse_posix",           # A2: userspace filesystem mount
        "block_device",         # A3: virtual block device
        "runtime_snapshotter",  # A4: container-runtime plugin
        "vm_image",             # A5: whole VM disk + memory image
    ],
    "capture": [
        "file_diff",       # B1
        "block_cow",       # B2
        "full_image",      # B3
        "fs_plus_memory",  # B4
        "full_vm",         # B5
    ],
    "addressing": [
        "path", "layer", "file_hash", "fixed_chunk", "content_defined_chunk",
    ],
    "materialization": [
        "eager", "lazy", "lazy_prefetch", "profile_prefetch",
    ],
    "topology": [
        "node_local", "zone_tier", "p2p", "multi_tier",
    ],
    "deployment": [
        "managed", "platform_account_data_plane", "self_hosted",
    ],
    "semantics": [
        "immutable_snapshots", "branchable", "shared_rw",
    ],
}

MEMORY_CAPTURE = {"fs_plus_memory", "full_vm"}
COOPERATING_INTERFACES = {"runtime_snapshotter", "vm_image"}


def classify(c: dict) -> tuple[str, str]:
    """Return (verdict, reason). Verdicts: pruned | adapter_only | core."""
    if c["interface"] == "object_api":
        return "pruned", "fails job 1: environments expect a filesystem"
    if c["semantics"] == "shared_rw":
        return "pruned", "fails jobs 3/5: concurrently mutable inputs are not re-gradable"
    if c["capture"] == "full_image":
        return "pruned", "fails job 5 economics: full copies per rollout vs diffs"
    if c["materialization"] != "eager" and c["addressing"] == "path":
        return "pruned", "lazy delivery needs a seekable index; paths give none"
    if c["deployment"] == "managed":
        return "pruned", "fails job 6/custody: kept only as an evaluation mode"
    if c["capture"] in MEMORY_CAPTURE and c["interface"] not in COOPERATING_INTERFACES:
        return "pruned", "memory capture needs runtime/hypervisor cooperation"
    if c["interface"] == "vm_image" or c["capture"] in MEMORY_CAPTURE:
        return "adapter_only", "valid where the customer's runtime exposes snapshot hooks"
    return "core", ""


RECOMMENDED = {
    "interface": "runtime_snapshotter",  # FUSE mount as the fallback path
    "capture": "block_cow",              # file_diff where the mount is file-backed
    "addressing": "content_defined_chunk",
    "materialization": "profile_prefetch",
    "topology": "multi_tier",
    "deployment": "platform_account_data_plane",
    "semantics": "branchable",
}


def main() -> None:
    names = list(AXES)
    combos = [dict(zip(names, values)) for values in product(*AXES.values())]

    tallies: dict[str, int] = {"core": 0, "adapter_only": 0, "pruned": 0}
    prune_reasons: dict[str, int] = {}
    for c in combos:
        verdict, reason = classify(c)
        tallies[verdict] += 1
        if verdict == "pruned":
            prune_reasons[reason] = prune_reasons.get(reason, 0) + 1

    nominal_ex_a1 = len(combos) - sum(
        1 for c in combos if c["interface"] == "object_api"
    )
    print(f"total combinations:              {len(combos):,}")
    print(f"nominal (excluding object-api):  {nominal_ex_a1:,}")
    print(f"core-viable:                     {tallies['core']:,}")
    print(f"adapter-only variants:           {tallies['adapter_only']:,}")
    print(f"pruned:                          {tallies['pruned']:,}")

    print("\npruning breakdown (first matching rule):")
    for reason, n in sorted(prune_reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {n:6,}  {reason}")

    verdict, _ = classify(RECOMMENDED)
    print(f"\nrecommended point (archetype 2) classifies as: {verdict}")
    for axis, choice in RECOMMENDED.items():
        print(f"  {axis:16} {choice}")


if __name__ == "__main__":
    main()

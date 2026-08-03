"""Join a task's strace output against the image's layer ownership map.

Produces, per task:
  - the set of image files actually accessed (opened/read/mapped/executed)
  - estimated unique bytes touched per file:
      min(sum of read() returns + file-backed mmap lengths, file size)
    (an upper bound per file; re-reads inflate the sum, the cap contains it)
  - per-layer utilization: accessed bytes / layer bytes
  - a task access profile JSON, which is precisely the artifact a
    profile-guided prefetcher needs

Usage: python3 analyze.py task_csv_report [task_b ...]
       (expects traces/<task>.raw and image/layers.json to exist)
"""

import json
import os
import re
import sys

PROTO_DIR = os.path.dirname(os.path.abspath(__file__))
ROOTFS_PREFIX = os.path.abspath(os.path.join(PROTO_DIR, "image", "rootfs"))

# strace -y annotates fds as 3</abs/host/path>. With -f, lines carry a pid.
RE_PID = re.compile(r"^(\d+)\s+(.*)$")
RE_OPENAT = re.compile(r'openat\([^,]+,\s*"([^"]+)".*\)\s+=\s+(-?\d+)')
RE_FDPATH = re.compile(r'\d+<([^<>]+)>')
RE_READ = re.compile(r'(?:read|pread64)\((\d+)<([^<>]+)>.*\)\s+=\s+(\d+)\s*$')
RE_MMAP = re.compile(r'mmap\(\S+,\s*(\d+),.*,\s*(\d+)<([^<>]+)>,')
RE_EXECVE = re.compile(r'execve\("([^"]+)"')
RE_UNFINISHED = re.compile(r'^(\w+)\((\d+)<([^<>]+)>.*<unfinished \.\.\.>$')
RE_RESUMED = re.compile(r'^<\.\.\. (\w+) resumed>.*\)\s+=\s+(\d+)\s*$')


def to_image_path(host_path: str) -> str | None:
    """Map a host path from the trace back into the image namespace."""
    p = os.path.abspath(host_path)
    if p.startswith(ROOTFS_PREFIX):
        rel = p[len(ROOTFS_PREFIX):].lstrip("/")
        return rel or None
    # chroot'd processes report in-chroot paths for openat string args
    if host_path.startswith("/"):
        return host_path.lstrip("/") or None
    return None


def parse_trace(path: str) -> tuple[dict, dict]:
    """Return ({image_path: bytes_touched_estimate}, stats)."""
    touched: dict[str, int] = {}
    stats = {"open_ok": 0, "open_enoent": 0, "reads": 0, "mmaps": 0}
    pending: dict[tuple[str, str], str] = {}  # (pid, syscall) -> image path

    with open(path, errors="replace") as f:
        for line in f:
            pid = "0"
            m = RE_PID.match(line)
            if m:
                pid, line = m.group(1), m.group(2)
            line = line.strip()

            m = RE_UNFINISHED.match(line)
            if m and m.group(1) in ("read", "pread64"):
                ip = to_image_path(m.group(3))
                if ip:
                    pending[(pid, m.group(1))] = ip
                continue
            m = RE_RESUMED.match(line)
            if m and (pid, m.group(1)) in pending:
                ip = pending.pop((pid, m.group(1)))
                touched[ip] = touched.get(ip, 0) + int(m.group(2))
                stats["reads"] += 1
                continue

            m = RE_READ.search(line)
            if m:
                ip = to_image_path(m.group(2))
                if ip:
                    touched[ip] = touched.get(ip, 0) + int(m.group(3))
                    stats["reads"] += 1
                continue
            m = RE_MMAP.search(line)
            if m:
                ip = to_image_path(m.group(3))
                if ip:
                    touched[ip] = touched.get(ip, 0) + int(m.group(1))
                    stats["mmaps"] += 1
                continue
            m = RE_OPENAT.search(line)
            if m:
                if int(m.group(2)) >= 0:
                    stats["open_ok"] += 1
                    ip = to_image_path(m.group(1))
                    if ip:
                        touched.setdefault(ip, 0)
                else:
                    stats["open_enoent"] += 1
                continue
            m = RE_EXECVE.search(line)
            if m:
                ip = to_image_path(m.group(1))
                if ip:
                    touched.setdefault(ip, 0)
    return touched, stats


def resolve_symlinks(image_path: str, ownership: dict) -> str:
    """Best-effort: the trace may reference a symlinked path; ownership keys
    are the real files. Follow links within the extracted rootfs."""
    if image_path in ownership:
        return image_path
    host = os.path.join(ROOTFS_PREFIX, image_path)
    try:
        real = os.path.realpath(host)
    except OSError:
        return image_path
    if real.startswith(ROOTFS_PREFIX):
        return real[len(ROOTFS_PREFIX):].lstrip("/")
    return image_path


def analyze(task: str, meta: dict) -> dict:
    ownership = meta["ownership"]
    layers = {l["id"]: l for l in meta["layers"]}
    touched, stats = parse_trace(os.path.join(PROTO_DIR, "traces", f"{task}.raw"))

    per_layer: dict[str, dict] = {
        lid: {"files": 0, "bytes": 0} for lid in layers}
    profile: dict[str, dict] = {}
    outside = 0
    for path, byte_sum in touched.items():
        rpath = resolve_symlinks(path, ownership)
        own = ownership.get(rpath)
        if own is None:
            outside += 1  # working writes (/work), /task, /proc-ish, etc.
            continue
        est = min(max(byte_sum, 1), own["size"]) if own["size"] else 0
        profile[rpath] = {"bytes_est": est, "size": own["size"],
                          "layer": own["layer"]}
        per_layer[own["layer"]]["files"] += 1
        per_layer[own["layer"]]["bytes"] += est

    image_files = len(ownership)
    image_bytes = sum(o["size"] for o in ownership.values())
    acc_files = len(profile)
    acc_bytes = sum(p["bytes_est"] for p in profile.values())

    report = {
        "task": task,
        "image_files": image_files, "image_bytes": image_bytes,
        "accessed_files": acc_files, "accessed_bytes": acc_bytes,
        "file_pct": 100 * acc_files / image_files,
        "byte_pct": 100 * acc_bytes / image_bytes,
        "outside_image_paths": outside,
        "trace_stats": stats,
        "per_layer": {
            lid: {
                **pl,
                "layer_files": layers[lid]["files"],
                "layer_bytes": layers[lid]["bytes"],
                "util_pct": (100 * pl["bytes"] / layers[lid]["bytes"])
                if layers[lid]["bytes"] else 0.0,
            } for lid, pl in per_layer.items()
        },
        "profile": profile,
    }
    return report


def main() -> None:
    with open(os.path.join(PROTO_DIR, "image", "layers.json")) as f:
        meta = json.load(f)

    for task in sys.argv[1:]:
        rep = analyze(task, meta)
        out = os.path.join(PROTO_DIR, "results", f"{task}.json")
        with open(out, "w") as f:
            json.dump(rep, f)
        print(f"\n=== {task} ===")
        print(f"accessed {rep['accessed_files']}/{rep['image_files']} files "
              f"({rep['file_pct']:.1f}%), "
              f"{rep['accessed_bytes']/1e6:.1f}/{rep['image_bytes']/1e6:.1f} MB "
              f"({rep['byte_pct']:.1f}%)")
        for lid, pl in rep["per_layer"].items():
            if pl["layer_bytes"]:
                print(f"  {lid:24} {pl['files']:5}/{pl['layer_files']:5} files "
                      f"{pl['bytes']/1e6:8.2f}/{pl['layer_bytes']/1e6:8.1f} MB "
                      f"({pl['util_pct']:5.1f}%)")


if __name__ == "__main__":
    main()

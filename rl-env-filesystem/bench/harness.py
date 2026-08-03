"""Benchmark harness for RL-rollout data-layer experiments.

Runs fleets of sandboxed rollouts under different data-layer configurations
and measures every phase, so the design axes in the README stop being
arguments and start being columns in a results table.

What is real vs modeled, stated plainly:
  - real: per-rollout copy-on-write sandboxes (overlayfs, tmpfs upperdir),
    task execution in a chroot, checkpoint capture (tar+gzip of the dirty
    upper layer), decoupled re-grading from the checkpoint alone, and all
    timings of those phases under real concurrency.
  - modeled: network fetch time, computed as bytes-a-policy-must-move /
    configured bandwidth, using byte counts measured by the prototype's
    access profiles. One machine cannot honestly measure a fleet's network,
    so it does not pretend to.

An experiment is a JSON spec (see experiments/):
  {
    "name": "...",
    "tasks": ["task_csv_report", ...],
    "delivery_policies": ["eager_full", "lazy_none", "hot_tier",
                           "profile", "profile_loo"],
    "capture": true,          # tar the COW upper layer post-task
    "regrade": true,          # re-grade from the checkpoint, no re-run
    "repeats": 1,
    "concurrency": 4,          # worker pool size (a stand-in for a fleet)
    "concurrency_sweep": [1, 4, 8],   # optional: overrides concurrency
    "bandwidth_mbps": 150
  }

Workers are a thread pool here; the run_rollout() function is a pure
function of (spec row -> record) with no shared mutable state, which is the
property that lets the same code fan out to remote executors later.

Usage: sudo -v && python3 harness.py experiments/delivery_policies.json
"""

import concurrent.futures as cf
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

BENCH_DIR = os.path.dirname(os.path.abspath(__file__))
PROTO_DIR = os.path.join(os.path.dirname(BENCH_DIR), "prototype")
ROOTFS = os.path.join(PROTO_DIR, "image", "rootfs")
SCRATCH = "/dev/shm/rlbench"   # tmpfs: overlay upperdirs cannot live on overlayfs

INDEX_BYTES = 256 * 1024       # metadata a lazy mount must fetch before start


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- profiles

class DeliveryModel:
    """Turns the prototype's measured access profiles into per-policy
    (upfront_bytes, lazy_bytes) predictions, in compressed terms."""

    def __init__(self, tasks: list[str]):
        with open(os.path.join(PROTO_DIR, "image", "layers.json")) as f:
            meta = json.load(f)
        self.image_comp = sum(l["compressed_bytes"] for l in meta["layers"])
        image_uncomp = sum(l["bytes"] for l in meta["layers"])
        self.ratio = self.image_comp / image_uncomp

        self.profiles = {}
        for t in tasks:
            with open(os.path.join(PROTO_DIR, "results", f"{t}.json")) as f:
                self.profiles[t] = json.load(f)

        counts: dict[str, set] = {}
        for t, rep in self.profiles.items():
            for p in rep["profile"]:
                counts.setdefault(p, set()).add(t)
        self.hot = {p for p, ts in counts.items() if len(ts) >= 2}
        sizes = meta["ownership"]
        self.size = lambda p: sizes[p]["size"] if p in sizes else 0

    def _bytes(self, paths) -> int:
        return int(sum(self.size(p) for p in paths) * self.ratio)

    def predict(self, task: str, policy: str) -> tuple[int, int]:
        prof = set(self.profiles[task]["profile"])
        accessed = self._bytes(prof)
        if policy == "eager_full":
            return self.image_comp, 0
        if policy == "lazy_none":
            return INDEX_BYTES, accessed
        if policy == "hot_tier":
            return INDEX_BYTES + self._bytes(self.hot), \
                   self._bytes(prof - self.hot)
        if policy == "profile":
            return INDEX_BYTES + self._bytes(self.hot | prof), 0
        if policy == "profile_loo":
            others = set()
            for t, rep in self.profiles.items():
                if t != task:
                    others |= set(rep["profile"])
            return INDEX_BYTES + self._bytes(others), \
                   self._bytes(prof - others)
        raise ValueError(f"unknown policy {policy}")


# ---------------------------------------------------------------- sandbox

class Sandbox:
    """One rollout's copy-on-write view of the environment image."""

    def __init__(self, rollout_id: str):
        self.base = os.path.join(SCRATCH, rollout_id)
        self.upper = os.path.join(self.base, "upper")
        self.work = os.path.join(self.base, "work")
        self.mnt = os.path.join(self.base, "mnt")
        self.mounted = False

    def mount(self) -> None:
        for d in (self.upper, self.work, self.mnt):
            os.makedirs(d, exist_ok=True)
        sh(["sudo", "mount", "-t", "overlay", "overlay",
            "-o", f"lowerdir={ROOTFS},upperdir={self.upper},workdir={self.work}",
            self.mnt])
        self.mounted = True

    def run_task(self, task: str) -> str:
        task_src = os.path.join(PROTO_DIR, "tasks", f"{task}.sh")
        sh(["sudo", "mkdir", "-p", os.path.join(self.mnt, "task")])
        sh(["sudo", "cp", task_src, os.path.join(self.mnt, "task", "run.sh")])
        out = sh(["sudo", "chroot", self.mnt, "/bin/sh", "/task/run.sh"])
        return out.stdout

    def capture(self, dest: str) -> tuple[int, str]:
        """Seal the dirty upper layer (minus the injected task script) as a
        checkpoint. Returns (bytes, sha256)."""
        sh(["sudo", "tar", "-C", self.upper, "--exclude=./task",
            "-czf", dest, "."])
        sh(["sudo", "chown", f"{os.getuid()}:{os.getgid()}", dest])
        h = hashlib.sha256()
        with open(dest, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return os.path.getsize(dest), h.hexdigest()

    def teardown(self) -> None:
        if self.mounted:
            subprocess.run(["sudo", "umount", "-l", self.mnt],
                           capture_output=True)
            self.mounted = False
        subprocess.run(["sudo", "rm", "-rf", self.base], capture_output=True)


def grade(task: str, work_dir: str) -> float:
    grader = os.path.join(BENCH_DIR, "graders", f"{task}.py")
    out = sh(["sudo", sys.executable, grader, work_dir])
    return float(out.stdout.strip().splitlines()[-1])


# ---------------------------------------------------------------- rollout

def run_rollout(row: dict, model: DeliveryModel) -> dict:
    rid = f"{row['task']}-{uuid.uuid4().hex[:8]}"
    sb = Sandbox(rid)
    rec = {"rollout_id": rid, **row, "ok": False}
    t = {}
    try:
        upfront, lazy = model.predict(row["task"], row["delivery"])
        bw = row["bandwidth_mbps"] * 1e6
        rec["bytes_upfront"] = upfront
        rec["bytes_lazy"] = lazy
        t["fetch_model_s"] = upfront / bw
        t["lazy_model_s"] = lazy / bw

        t0 = time.monotonic()
        sb.mount()
        t["mount_s"] = time.monotonic() - t0

        t0 = time.monotonic()
        sb.run_task(row["task"])
        t["task_s"] = time.monotonic() - t0

        t0 = time.monotonic()
        rec["reward"] = grade(row["task"], os.path.join(sb.mnt, "work"))
        t["grade_s"] = time.monotonic() - t0

        if row["capture"]:
            ckpt = os.path.join(SCRATCH, f"{rid}.ckpt.tar.gz")
            t0 = time.monotonic()
            size, digest = sb.capture(ckpt)
            t["capture_s"] = time.monotonic() - t0
            rec["ckpt_bytes"] = size
            rec["ckpt_sha256"] = digest

            if row["regrade"]:
                # Decoupled grading: sandbox is gone, only the diff remains.
                sb.teardown()
                restore = os.path.join(SCRATCH, f"{rid}.restore")
                t0 = time.monotonic()
                os.makedirs(restore, exist_ok=True)
                sh(["sudo", "tar", "-C", restore, "-xzf", ckpt])
                rec["regrade_reward"] = grade(
                    row["task"], os.path.join(restore, "work"))
                t["regrade_s"] = time.monotonic() - t0
                subprocess.run(["sudo", "rm", "-rf", restore],
                               capture_output=True)
            os.unlink(ckpt)

        rec["ok"] = True
    except subprocess.CalledProcessError as e:
        rec["error"] = (e.stderr or str(e))[-500:]
    finally:
        sb.teardown()
    rec["phases"] = {k: round(v, 4) for k, v in t.items()}
    return rec


# ---------------------------------------------------------------- driver

def expand(spec: dict) -> list[dict]:
    rows = []
    for task in spec["tasks"]:
        for policy in spec.get("delivery_policies", ["eager_full"]):
            for r in range(spec.get("repeats", 1)):
                rows.append({
                    "task": task, "delivery": policy, "repeat": r,
                    "capture": spec.get("capture", False),
                    "regrade": spec.get("regrade", False),
                    "bandwidth_mbps": spec.get("bandwidth_mbps", 150),
                })
    return rows


def run_batch(rows: list[dict], concurrency: int,
              model: DeliveryModel) -> tuple[list[dict], float]:
    t0 = time.monotonic()
    with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
        records = list(pool.map(lambda r: run_rollout(r, model), rows))
    return records, time.monotonic() - t0


def main() -> None:
    with open(sys.argv[1]) as f:
        spec = json.load(f)

    os.makedirs(SCRATCH, exist_ok=True)
    # Clear stale mounts from any previous crashed run.
    mounts = open("/proc/mounts").read()
    for line in mounts.splitlines():
        if SCRATCH in line:
            subprocess.run(["sudo", "umount", "-l", line.split()[1]],
                           capture_output=True)

    model = DeliveryModel(spec["tasks"])
    rows = expand(spec)

    results_dir = os.path.join(BENCH_DIR, "results")
    os.makedirs(results_dir, exist_ok=True)
    out_path = os.path.join(results_dir, f"{spec['name']}.jsonl")

    all_records = []
    sweeps = spec.get("concurrency_sweep") or [spec.get("concurrency", 4)]
    for conc in sweeps:
        records, wall = run_batch(rows, conc, model)
        for r in records:
            r["concurrency"] = conc
            r["batch_wall_s"] = round(wall, 3)
        all_records.extend(records)
        failures = [r for r in records if not r["ok"]]
        print(f"[{spec['name']}] concurrency={conc}: {len(records)} rollouts "
              f"in {wall:.1f}s wall, {len(failures)} failures")
        for f_ in failures[:3]:
            print("  FAIL", f_["rollout_id"], f_.get("error", "")[:200])

    with open(out_path, "w") as f:
        for r in all_records:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()

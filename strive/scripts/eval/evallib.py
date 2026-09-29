"""The eval's parts that don't spend anything: the task suite, workspaces,
checks, the plan and its cost estimate, reading a journal, and a small
client for the daemon's socket. run_eval.py drives them; selfcheck.py and
test_evallib.py test them.
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

STRIVE = Path(__file__).resolve().parents[2]
EVAL = STRIVE / "eval"
TEMPLATE = EVAL / "project"
TASKS = EVAL / "tasks"
MEMORIES = {"oracle": EVAL / "oracle-memory.md", "placebo": EVAL / "placebo-memory.md"}

ARMS = ("F", "L", "O", "P", "placebo")
# ADR-0021: how many sequences each arm runs.
SEQUENCES = {"F": 3, "L": 3, "O": 2, "P": 1, "placebo": 1}
LEARNS = {"L", "P"}
MEMORY_OF = {"O": "oracle", "placebo": "placebo"}
POISONED = ("regression-test", "changelog", "api-version")
TEST_INSTANCES = ("t1", "t2", "t3")
CALIBRATION = ("c1", "c2")
BLOCK = 3  # families introduced per round of an ordering
PROBES = 3  # early families probed again at the end of an ordering

# ---------------------------------------------------------------- the suite


@dataclass(frozen=True)
class Task:
    family: str
    instance: str
    role: str
    kind: str
    dir: Path

    @property
    def meta(self) -> dict:
        return json.loads((self.dir / "task.json").read_text())

    @property
    def instruction(self) -> str:
        return (self.dir / "instruction.md").read_text().strip()


def load_tasks(root: Path = TASKS) -> dict[tuple[str, str], Task]:
    tasks = {}
    for meta_path in sorted(root.glob("*/*/task.json")):
        m = json.loads(meta_path.read_text())
        tasks[(m["family"], m["instance"])] = Task(m["family"], m["instance"], m["role"], m["kind"], meta_path.parent)
    return tasks


def families(tasks: dict[tuple[str, str], Task]) -> list[str]:
    return sorted({f for f, _ in tasks})


def kinds(tasks: dict[tuple[str, str], Task]) -> dict[str, str]:
    return {t.family: t.kind for t in tasks.values()}


# ---------------------------------------------------------------- workspaces

GIT_ENV = {
    "GIT_AUTHOR_NAME": "tally",
    "GIT_AUTHOR_EMAIL": "dev@tally.example",
    "GIT_COMMITTER_NAME": "tally",
    "GIT_COMMITTER_EMAIL": "dev@tally.example",
    "GIT_AUTHOR_DATE": "2024-03-01T09:00:00Z",
    "GIT_COMMITTER_DATE": "2024-03-01T09:00:00Z",
}


def overlay(src: Path, dst: Path) -> None:
    for f in sorted(src.rglob("*")):
        if f.is_file():
            target = dst / f.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)


def git(ws: Path, *args: str) -> None:
    env = {**os.environ, **GIT_ENV}
    subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", *args], cwd=ws, env=env,
                   check=True, capture_output=True)


def prepare(task: Task, ws: Path, strive_dir: Path | None = None, memory: str | None = None,
            template: Path = TEMPLATE) -> None:
    """A fresh copy of the template at `ws` with the task set up, and its own
    git history of one commit, so the agent's diff is its own work.
    `strive_dir` is a carried-over .strive; `memory` a fixed memory's text."""
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(template, ws, ignore=shutil.ignore_patterns("__pycache__"))
    if (task.dir / "setup").is_dir():
        overlay(task.dir / "setup", ws)
    (ws / ".gitignore").write_text("__pycache__/\n")
    if strive_dir is not None and strive_dir.is_dir():
        shutil.copytree(strive_dir, ws / ".strive")
    if memory is not None:
        (ws / ".strive").mkdir(exist_ok=True)
        (ws / ".strive" / "memory.md").write_text(memory)
    git(ws, "init", "-q")
    # A person's global fsmonitor would leave a socket in .git that copies trip on.
    git(ws, "config", "core.fsmonitor", "false")
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", "tally 0.9.0")


def apply_oracle(task: Task, ws: Path) -> None:
    if (task.dir / "oracle").is_dir():
        overlay(task.dir / "oracle", ws)
    for argv in task.meta["oracle_run"]:
        argv = [sys.executable if a == "python3" else a for a in argv]
        subprocess.run(argv, cwd=ws, check=True, capture_output=True, timeout=120)


@dataclass
class CheckResult:
    passed: bool
    failed: list
    signals: dict
    raw: str = ""


def run_check(task: Task, ws: Path, timeout: int = 300) -> CheckResult:
    """Runs the task's check on `ws`. A check that can't say is a failure."""
    try:
        r = subprocess.run([sys.executable, str(task.dir / "check.py"), str(ws)], capture_output=True, text=True,
                           timeout=timeout, cwd=task.dir)
    except subprocess.TimeoutExpired:
        return CheckResult(False, [{"check": "the check finished", "detail": f"timed out after {timeout}s"}], {})
    lines = r.stdout.strip().splitlines()
    try:
        verdict = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        return CheckResult(False, [{"check": "the check reported", "detail": (r.stdout + r.stderr)[-2000:]}], {}, r.stdout)
    return CheckResult(r.returncode == 0 and verdict.get("pass") is True, verdict.get("failed", []),
                       verdict.get("signals", {}), r.stdout)


# What holds the answers: the checks, the oracles, and the file that writes them.
SECRET = ("tasks", "checklib.py", "build_tasks.py", "oracle-memory.md", "README.md")
# Text in a command or path that reaches for them.
PEEK_MARKERS = ("eval/tasks", "checklib", "build_tasks", "check-data", "oracle-memory", "/vault/")


def make_vault(dest: Path) -> Path:
    """A copy of eval/ for one sequence's checks, inside its STRIVE_HOME:
    strive's sandbox denies the agent all of strive's home."""
    shutil.copytree(EVAL, dest, ignore=shutil.ignore_patterns("__pycache__"))
    return dest


class SuiteLock:
    """Makes the checkout's copies of the answers unreadable while a run is
    in progress, so the agent can't read them either (its sandbox can't
    change permissions outside its workspace). Undone on exit, and by the
    next run if this one was killed."""

    def __init__(self) -> None:
        self.paths = [EVAL / p for p in SECRET]

    def __enter__(self) -> SuiteLock:
        for p in self.paths:
            p.chmod(0)
        return self

    def __exit__(self, *exc: object) -> None:
        unlock()


def unlock() -> None:
    for p in SECRET:
        path = EVAL / p
        if path.exists() and not os.access(path, os.R_OK):
            path.chmod(0o755 if path.is_dir() else 0o644)


def leaked(strive_dir: Path, task: Task) -> list[str]:
    """Strings unique to `task` found in the learned files: learning that
    saw the answer before the task ran."""
    if not strive_dir.is_dir():
        return []
    text = "\n".join(p.read_text(errors="replace") for p in strive_dir.rglob("*") if p.is_file())
    return [u for u in task.meta["unique"] if u in text]


# ---------------------------------------------------------------- the plan


@dataclass
class Trial:
    arm: str
    sequence: int  # the ordering (F, L, P) or repetition (O, placebo)
    position: int
    family: str
    instance: str
    role: str
    probe: bool = False

    @property
    def key(self) -> str:
        return f"{self.arm}/{self.sequence}/{self.position}"


def ordering(fams: list[str], k: int, seed: int) -> list[tuple[str, str, bool]]:
    """Ordering k: families interleaved, each seed before its tests, and
    the first families probed again at the end.

    Families come in a shuffled order, BLOCK at a time: family j's seed is
    in round j // BLOCK and its test i in the round after that, so each
    round mixes new seeds with tests of families seen earlier. Within a
    round the order is shuffled too."""
    rng = random.Random(seed * 1000 + k)
    order = list(fams)
    rng.shuffle(order)
    rounds: dict[int, list[tuple[str, str, bool]]] = {}
    for j, fam in enumerate(order):
        for r, inst in enumerate(("seed", *TEST_INSTANCES)):
            rounds.setdefault(j // BLOCK + r, []).append((fam, inst, False))
    seq: list[tuple[str, str, bool]] = []
    for r in sorted(rounds):
        items = rounds[r]
        rng.shuffle(items)
        seq += items
    seq += [(fam, TEST_INSTANCES[0], True) for fam in order[:PROBES]]
    return seq


def plan(tasks: dict[tuple[str, str], Task], arms: list[str], fams: list[str], seed: int,
         sequences: dict[str, int] | None = None) -> list[Trial]:
    sequences = sequences or SEQUENCES
    trials = []
    for arm in arms:
        for k in range(sequences[arm]):
            for pos, (fam, inst, probe) in enumerate(ordering(fams, k, seed)):
                if arm == "P" and inst == "seed" and fam in POISONED and (fam, "seed-poison") in tasks:
                    inst = "seed-poison"
                role = tasks[(fam, inst)].role
                trials.append(Trial(arm, k, pos, fam, inst, role, probe))
    return trials


def screen_plan(tasks: dict[tuple[str, str], Task], fams: list[str], reps: int = 1) -> list[Trial]:
    trials = []
    for arm in ("F", "O"):
        for k in range(reps):
            pos = 0
            for fam in fams:
                for inst in CALIBRATION:
                    trials.append(Trial(arm, k, pos, fam, inst, tasks[(fam, inst)].role))
                    pos += 1
    return trials


# ---------------------------------------------------------------- cost

# Dollars per million tokens, as strive's budget crate prices them.
PRICES = {
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0, "cache_write": 1.25, "cache_read": 0.1},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0, "cache_write": 3.75, "cache_read": 0.3},
}

# Tokens one agent task and one learner run (with its judge) use, low and
# high: an agent task is about 12 model calls on a context growing from 6k
# to 20k tokens, mostly served from the prompt cache.
ASSUMED = {
    "task": {"low": {"input": 4_000, "cache_write": 20_000, "cache_read": 90_000, "output": 2_500},
             "high": {"input": 6_000, "cache_write": 30_000, "cache_read": 160_000, "output": 4_000}},
    "learner": {"low": {"input": 2_000, "cache_write": 10_000, "cache_read": 8_000, "output": 1_000},
                "high": {"input": 4_000, "cache_write": 14_000, "cache_read": 20_000, "output": 1_500}},
}


def price_of(model: str) -> dict[str, float]:
    base = re.sub(r"-\d{8}$", "", model)
    if base not in PRICES:
        raise SystemExit(f"no price for {model}; add it to PRICES in scripts/eval/evallib.py")
    return PRICES[base]


def usd(tokens: dict[str, int], price: dict[str, float]) -> float:
    return sum(tokens[k] * price[k] for k in tokens) / 1_000_000


def estimate(trials: list[Trial], model: str, measured: dict | None = None) -> dict:
    """Low and high cost of running `trials`: from measured per-task and
    per-learner-run costs when given, else from ASSUMED."""
    n_tasks = len(trials)
    n_learn = sum(1 for t in trials if t.arm in LEARNS)
    price = price_of(model)
    if measured and measured.get("task"):
        task = {"low": measured["task"], "high": measured["task"] * 1.25}
        learner = {"low": measured.get("learner") or usd(ASSUMED["learner"]["low"], price),
                   "high": (measured.get("learner") or usd(ASSUMED["learner"]["high"], price)) * 1.25}
        basis = f"measured: ${measured['task']:.4f} a task over {measured['n_tasks']} tasks" + (
            f", ${measured['learner']:.4f} a learner run over {measured['n_learner']}" if measured.get("learner") else ""
        ) + "; high adds 25%"
    else:
        task = {b: usd(ASSUMED["task"][b], price) for b in ("low", "high")}
        learner = {b: usd(ASSUMED["learner"][b], price) for b in ("low", "high")}
        basis = "assumed token counts (below), not measured: run --screen first to measure"
    return {
        "tasks": n_tasks,
        "learner_runs": n_learn,
        "per_task": task,
        "per_learner_run": learner,
        "low": n_tasks * task["low"] + n_learn * learner["low"],
        "high": n_tasks * task["high"] + n_learn * learner["high"],
        "basis": basis,
    }


def measured_costs(results: Path) -> dict:
    tasks, learners = [], []
    for line in results.read_text().splitlines():
        r = json.loads(line)
        if r.get("type") != "trial":
            continue
        tasks.append(r["cost_usd"])
        if r.get("learner"):
            learners.append(r["learner"]["cost_usd"])
    if not tasks:
        raise SystemExit(f"{results}: no trials to measure from")
    return {"task": sum(tasks) / len(tasks), "n_tasks": len(tasks),
            "learner": sum(learners) / len(learners) if learners else None, "n_learner": len(learners)}


# ---------------------------------------------------------------- journals


@dataclass
class JournalSummary:
    turn_end: str | None = None
    turn_error: str = ""
    model_calls: int = 0
    assistant_messages: int = 0
    cost_usd: float = 0.0
    tokens: dict = field(default_factory=lambda: {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0})
    models: list = field(default_factory=list)
    response_digests: list = field(default_factory=list)
    memory_loaded: bool = False
    instructions: list = field(default_factory=list)
    commands: list = field(default_factory=list)
    paths: list = field(default_factory=list)


def read_journal(lines: list[str]) -> JournalSummary:
    s = JournalSummary()
    for line in lines:
        if not line.strip():
            continue
        e = json.loads(line)["event"]
        t = e["type"]
        if t == "modelCallStarted":
            s.model_calls += 1
            s.models.append(e["model"])
        elif t == "modelCallFinished":
            o = e["outcome"]
            s.cost_usd += o.get("costUsdMicros", 0) / 1_000_000
            if o["kind"] == "complete":
                u = o["usage"]
                s.tokens["input"] += u["input"]
                s.tokens["output"] += u["output"]
                s.tokens["cacheRead"] += u.get("cacheRead", 0)
                s.tokens["cacheWrite"] += u.get("cacheWrite", 0) + u.get("cacheWriteLong", 0)
            if e.get("response"):
                s.response_digests.append(e["response"])
        elif t == "assistantMessage":
            s.assistant_messages += 1
        elif t == "contextLoaded":
            s.instructions = [f["path"] for f in e.get("instructions", [])]
            s.memory_loaded = any(p.replace("\\", "/").endswith(".strive/memory.md") for p in s.instructions)
        elif t == "effectStarted":
            rec = e["record"]
            if "command" in rec:
                s.commands.append(rec["command"])
            if "path" in rec:
                s.paths.append(rec["path"])
        elif t == "turnEnded":
            r = e["reason"]
            s.turn_end = r["kind"]
            s.turn_error = r.get("error", "")
    return s


def followed_commands(summary: JournalSummary, patterns: list[str]) -> bool | None:
    """Whether a command the agent ran shows the lesson; None when the
    task has no command that would."""
    if not patterns:
        return None
    return any(re.search(p, c) for p in patterns for c in summary.commands)


def peeked(summary: JournalSummary, markers: list[str]) -> list[str]:
    """Commands or file paths that reach for the checks or the task suite."""
    hits = []
    for text in summary.commands + summary.paths:
        if any(m in text for m in markers):
            hits.append(text[:300])
    return hits


# ---------------------------------------------------------------- the daemon's socket


class Rpc:
    """Newline-delimited JSON-RPC 2.0 over strive's Unix socket."""

    def __init__(self, socket_path: Path, timeout: float = 60) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(str(socket_path))
        self.buf = b""
        self.next_id = 1
        version = 2
        try:
            self.call("initialize", {"protocolVersion": version, "client": {"name": "strive-eval", "version": "0"}})
        except RpcError as e:
            theirs = (e.data or {}).get("protocolVersion")
            if theirs is None:
                raise
            self.call("initialize", {"protocolVersion": theirs, "client": {"name": "strive-eval", "version": "0"}})

    def call(self, method: str, params: dict) -> dict:
        rid = self.next_id
        self.next_id += 1
        self.sock.sendall((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode())
        while True:
            while b"\n" not in self.buf:
                chunk = self.sock.recv(1 << 16)
                if not chunk:
                    raise RpcError(method, {"code": -1, "message": "the daemon closed the connection"})
                self.buf += chunk
            line, self.buf = self.buf.split(b"\n", 1)
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("id") != rid:
                continue  # a notification, or another reply
            if "error" in msg:
                raise RpcError(method, msg["error"])
            return msg.get("result", {})

    def close(self) -> None:
        self.sock.close()


class RpcError(Exception):
    def __init__(self, method: str, error: dict) -> None:
        super().__init__(f"{method}: {error.get('message')} ({error.get('code')})")
        self.data = error.get("data")


def trial_dict(t: Trial) -> dict:
    return asdict(t)

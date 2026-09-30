#!/usr/bin/env python3
"""ADR-0021's eval: does strive with learning on beat the same strive with
learning frozen, over a sequence of related tasks?

    python3 scripts/eval/run_eval.py --dry-run             # the plan and its cost; spends nothing
    python3 scripts/eval/run_eval.py --screen --yes        # calibration instances under F and O
    python3 scripts/eval/run_eval.py --families-from OUT/screen.json --yes
    python3 scripts/eval/run_eval.py --summarize OUT/results.jsonl

Arms (same pinned model, same task sequences): F frozen (no memory), L
learning (after each task the learner studies that session and every
proposal passing the static check is accepted), O oracle memory, P learning
with poisoned seeds, placebo (a same-length unrelated memory). Each task runs
in a fresh copy of eval/project with its setup applied; .strive/ carries
forward in L and P and is reset in F, O and placebo.

Fail-closed: a task whose oracle fails its check, a trial that doesn't
finish, or a model other than the pinned one fails the run. No retries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evallib as ev  # noqa: E402
import stats  # noqa: E402

DEFAULT_MODEL = "claude-haiku-4-5-20251001"


class RunFailed(Exception):
    pass


# ---------------------------------------------------------------- preflight


def verify_oracles(tasks: dict, keys: set[tuple[str, str]]) -> list[str]:
    """Every task to be run fails its check as set up and passes it with its oracle."""

    def one(key: tuple[str, str]) -> str | None:
        task = tasks[key]
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "ws"
            ev.prepare(task, ws)
            if ev.run_check(task, ws).passed:
                return f"{task.family}/{task.instance}: its check passes before any fix"
            ev.apply_oracle(task, ws)
            r = ev.run_check(task, ws)
            if not r.passed:
                return f"{task.family}/{task.instance}: its oracle fails its check: {json.dumps(r.failed)[:500]}"
        return None

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        return [p for p in pool.map(one, sorted(keys)) if p]


def upstream_is_local() -> bool:
    url = os.environ.get("STRIVE_UPSTREAM_ANTHROPIC", "")
    return bool(re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?/?", url))


# ---------------------------------------------------------------- running


class Sequence:
    """One arm's run through one ordering: a strive home of its own, one
    workspace path reused for every task (so it is one project to strive),
    and the .strive/ carried between tasks when the arm learns."""

    def __init__(self, runner: Runner, arm: str, k: int) -> None:
        self.r = runner
        self.arm = arm
        self.k = k
        self.root = Path(tempfile.mkdtemp(prefix=f"sev-{arm}{k}-", dir="/tmp")).resolve()
        # Outside the checkout, so nothing above the workspace leads to the suite.
        assert not self.root.is_relative_to(ev.STRIVE)
        self.home = self.root / "h"
        self.ws = self.root / "tally"
        self.home.mkdir()
        settings = {
            "model": runner.model,
            "judgeModel": runner.model,
            "budget": {"usd": runner.args.learner_budget},
            "turnSeconds": runner.args.turn_seconds,
        }
        (self.home / "settings.json").write_text(json.dumps(settings, indent=2))
        self.carried: Path | None = None
        # The checks run from here: inside strive's home, which the agent's sandbox can't read.
        self.vault = ev.make_vault(self.home / "vault")
        self.tasks = ev.load_tasks(self.vault / "tasks")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("STRIVE_") or k in (
            "STRIVE_UPSTREAM_ANTHROPIC", "STRIVE_UPSTREAM_OPENAI", "STRIVE_HOST", "STRIVE_TUI")}
        self.env["STRIVE_HOME"] = str(self.home)
        self.learning_seen = 0

    def start_daemon(self) -> None:
        # Here, not in the workspace: the workspace is replaced before each
        # task, and the daemon and the hosts it starts keep the directory
        # they were started in.
        started = subprocess.run([str(self.r.strive), "status", "--json"], cwd=self.root, env=self.env,
                                 capture_output=True, text=True, timeout=120)
        if started.returncode != 0:
            raise RunFailed(f"the daemon didn't start for {self.arm}/{self.k}: {started.stderr.strip()[-800:]}")

    def restart_daemon(self) -> None:
        """A fresh daemon, so the learner's host starts again and is given
        the memory as it is now: a running learner host keeps the learned
        files it was started with."""
        subprocess.run([str(self.r.strive), "stop"], cwd=self.root, env=self.env, capture_output=True, timeout=60)
        self.start_daemon()

    def strive(self, *args: str, stdin: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.r.strive), *args], cwd=self.ws, env=self.env, input=stdin, capture_output=True,
                              text=True, timeout=timeout)

    def rpc(self) -> ev.Rpc:
        return ev.Rpc(self.home / "run" / "strived.sock")

    def trial(self, t: ev.Trial) -> dict:
        task = self.tasks[(t.family, t.instance)]
        memory = None
        if self.arm in ev.MEMORY_OF:
            memory = (self.vault / ev.MEMORIES[ev.MEMORY_OF[self.arm]].name).read_text()
        ev.prepare(task, self.ws, self.carried if self.arm in ev.LEARNS else None, memory, self.vault / "project")
        leak = ev.leaked(self.ws / ".strive", task) if t.role in ("test", "calibration") and self.arm in ev.LEARNS else []
        started = time.time()
        try:
            run = self.strive("run", "--json", "--approvals", "full-auto", "--budget", str(self.r.args.task_budget), "-",
                              stdin=task.instruction, timeout=self.r.args.turn_seconds + 180)
        except subprocess.TimeoutExpired as e:
            raise RunFailed(f"{t.key} {t.family}/{t.instance}: strive run didn't exit within its time limit") from e
        stem = f"{self.arm}-{self.k}-{t.position:02d}-{t.family}-{t.instance}"
        (self.r.out / "journals" / f"{stem}.jsonl").write_text(run.stdout)
        (self.r.out / "journals" / f"{stem}.err").write_text(run.stderr)
        j = ev.read_journal(run.stdout.splitlines())
        if j.turn_end is None:
            raise RunFailed(f"{t.key} {t.family}/{t.instance}: the trial didn't finish (exit {run.returncode}): "
                            f"{run.stderr.strip()[-800:]}")
        completed = j.model_calls > 0 and j.tokens["output"] > 0
        if j.turn_end == "failed" and not completed:
            raise RunFailed(f"{t.key} {t.family}/{t.instance}: the model was never reached: {j.turn_error[:400]}")
        session = self.work_session(started)
        response_models = self.response_models(j.response_digests)
        model_ok = all(m == self.r.model for m in j.models) and all(self.r.pinned(m) for m in response_models)
        check = ev.run_check(task, self.ws)
        peek = ev.peeked(j, [str(ev.STRIVE), str(self.home), *ev.PEEK_MARKERS])
        record = {
            "type": "trial",
            "key": t.key,
            **asdict(t),
            "kind": task.kind,
            "passed": check.passed and not peek,
            "check_passed": check.passed,
            "check_failed": check.failed,
            "signals": check.signals,
            "followed": check.signals.get("followed", ev.followed_commands(j, task.meta["followed_commands"])),
            "followed_command": ev.followed_commands(j, task.meta["followed_commands"]),
            "turns": j.assistant_messages,
            "model_calls": j.model_calls,
            "cost_usd": j.cost_usd,
            "tokens": j.tokens,
            "memory_loaded": j.memory_loaded,
            "instructions": j.instructions,
            "turn_end": j.turn_end,
            "exit_code": run.returncode,
            "models": sorted(set(j.models)),
            "response_models": sorted(set(response_models)),
            "model_ok": model_ok,
            "peeked": peek,
            "leaked": leak,
            "session": session,
            "duration_s": round(time.time() - started, 1),
        }
        if not model_ok:
            self.r.write(record)
            raise RunFailed(f"{t.key}: a model other than {self.r.model} answered: {record['models']} {record['response_models']}")
        if self.arm in ev.LEARNS:
            record["learner"] = self.learn(session, stem)
            if not record["learner"]["model_ok"]:
                self.r.write(record)
                raise RunFailed(f"{t.key}: the learner or judge used a model other than {self.r.model}")
            saved = self.r.out / "strive" / stem
            if (self.ws / ".strive").is_dir():
                shutil.copytree(self.ws / ".strive", saved)
                self.carried = saved
        return record

    def work_session(self, started: float) -> str:
        c = self.rpc()
        try:
            sessions = c.call("session/list", {"cwd": str(self.ws)})["sessions"]
        finally:
            c.close()
        fresh = [s for s in sessions if s["createdAtMs"] >= (started - 5) * 1000]
        if not fresh:
            raise RunFailed(f"no work session was created in {self.ws}")
        return fresh[0]["id"]

    def response_models(self, digests: list[str]) -> list[str]:
        """The model each response says answered, from its recorded bytes."""
        if not digests:
            return []
        c = self.rpc()
        try:
            found = []
            for d in digests:
                text = c.call("blob/get", {"digest": d})["text"]
                m = re.search(r'"model"\s*:\s*"([^"]+)"', text)
                if m:
                    found.append(m.group(1))
            return found
        finally:
            c.close()

    def learn(self, session: str, stem: str) -> dict:
        """The learner on `session`, then every proposal that passed the
        static check accepted; the judge only advises, and its advice is kept."""
        if not self.r.args.keep_learner_host:
            self.restart_daemon()
        c = self.rpc()
        try:
            learning = c.call("learning/open", {"cwd": str(self.ws)})["id"]
            before = {p["id"] for p in c.call("proposal/list", {"cwd": str(self.ws)})["proposals"]}
        finally:
            c.close()
        started = time.time()
        run = self.strive("learn", "--session", session, timeout=self.r.args.turn_seconds + 600)
        c = self.rpc()
        try:
            entries = c.call("session/read", {"id": learning})["entries"]
            new = [e for e in entries if e["seq"] > self.learning_seen]
            self.learning_seen = entries[-1]["seq"] if entries else self.learning_seen
            (self.r.out / "journals" / f"{stem}.learner.jsonl").write_text("\n".join(json.dumps(e) for e in new) + "\n")
            deadline = time.time() + 300
            while True:
                listed = c.call("proposal/list", {"cwd": str(self.ws)})["proposals"]
                mine = [p for p in listed if p["id"] not in before]
                if all(p["status"] != "checking" for p in mine) or time.time() > deadline:
                    break
                time.sleep(1)
            proposals = []
            for p in mine:
                gates = {g["gate"]: g for g in p["gates"]}
                accepted = False
                after = p["status"]
                if p["status"] == "ready":
                    c.call("proposal/decide", {"cwd": str(self.ws), "proposal": p["id"], "decision": "accept"})
                    now = {q["id"]: q for q in c.call("proposal/list", {"cwd": str(self.ws)})["proposals"]}
                    after = now.get(p["id"], {}).get("status")
                    accepted = after == "applied"
                proposals.append({
                    "id": p["id"],
                    "artifact": p["proposal"].get("artifact"),
                    "summary": p["proposal"].get("summary"),
                    "status": p["status"],
                    "static": gates.get("static", {}).get("verdict"),
                    "judge": {"verdict": gates.get("judge", {}).get("verdict"),
                              "detail": gates.get("judge", {}).get("detail", "")[:600]},
                    "accepted": accepted,
                    "status_after": after,
                })
        finally:
            c.close()
        j = ev.read_journal([json.dumps({"event": e["event"]}) for e in new])
        return {
            "exit_code": run.returncode,
            "turn_end": j.turn_end,
            "cost_usd": j.cost_usd,
            "model_calls": j.model_calls,
            "models": sorted(set(j.models)),
            "model_ok": all(m == self.r.model for m in j.models),
            "proposals": proposals,
            "duration_s": round(time.time() - started, 1),
        }

    def close(self) -> None:
        try:
            c = self.rpc()
            try:
                learning = c.call("session/list", {"cwd": str(self.ws), "kind": "learning"})["sessions"]
                for s in learning:
                    read = c.call("session/read", {"id": s["id"]})
                    (self.r.out / "journals" / f"{self.arm}-{self.k}-learning-session.json").write_text(json.dumps(read))
            finally:
                c.close()
        except (OSError, ev.RpcError):
            pass
        subprocess.run([str(self.r.strive), "stop"], env=self.env, capture_output=True, timeout=60)
        shutil.rmtree(self.root, ignore_errors=True)


def completed_sequences(records: list[dict], trials: list[ev.Trial]) -> dict[tuple[str, int], list[dict]]:
    """From an earlier run's records, the sequences a resumed run can keep:
    every planned trial of the sequence has a result whose model was reached.
    A sequence cut short is run again from its start, since each later trial
    depends on what the earlier ones in the same sequence learned."""
    planned: dict[tuple[str, int], list[ev.Trial]] = {}
    for t in trials:
        planned.setdefault((t.arm, t.sequence), []).append(t)
    got: dict[str, dict] = {r["key"]: r for r in records if r.get("type") == "trial" and r.get("model_ok", True)}

    def same_task(t: ev.Trial) -> bool:
        # A key names only a slot, so a record from a different plan can sit under it.
        r = got.get(t.key)
        return r is not None and all(r.get(f) == getattr(t, f) for f in ("family", "instance", "role", "probe"))

    return {seq: [got[t.key] for t in sorted(ts, key=lambda t: t.position)]
            for seq, ts in planned.items() if all(same_task(t) for t in ts)}


# Settings that can differ between a run and its resumption: where output
# goes, the spending cap, the cost estimate and prompts. Not the suite lock:
# without it the agent can read the answers. Every other setting
# must match, so a setting added later is checked without being listed here.
RESUME_MAY_DIFFER = frozenset({"out", "resume", "yes", "max_usd", "calibration", "dry_run", "summarize"})


def resume_mismatch(earlier: dict, now: dict) -> list[str]:
    """The settings that differ between an earlier run's recorded args and this run's."""
    return sorted(k for k in earlier.keys() | now.keys() if k not in RESUME_MAY_DIFFER and earlier.get(k) != now.get(k))


def walk(root: Path) -> list[Path]:
    """Every file under root. An unreadable directory raises rather than being
    skipped, so a locked suite can't pass for an empty one."""
    def fail(e: OSError) -> None:
        raise e
    return [Path(d) / f for d, dirs, fs in os.walk(root, onerror=fail) if "__pycache__" not in Path(d).parts for f in fs]


def fingerprint(paths: list[Path], env: dict[str, str]) -> str:
    """A digest of what a trial's result depends on besides the settings: the
    files under paths (the suite, the runner, the binaries) and env (what
    redirects the daemon, and the tools a trial runs). The same paths can hold
    different contents."""
    h = hashlib.sha256()
    for root in paths:
        files = sorted(walk(root)) if root.is_dir() else [root]
        for f in files:
            h.update(f"{f.relative_to(root.parent)}\0{len(b := f.read_bytes())}\0".encode())
            h.update(b)
    for k in sorted(env):
        h.update(f"{k}={env[k]}\0".encode())
    return h.hexdigest()


def run_inputs(strive: Path) -> str:
    here = Path(__file__).resolve().parent
    tui = strive.with_name("strive-tui")
    paths = [ev.EVAL, here / "run_eval.py", here / "evallib.py", here / "stats.py", strive, *([tui] if tui.is_file() else [])]
    return fingerprint(paths, {**{k: v for k, v in os.environ.items() if k.startswith("STRIVE_")}, **toolchain()})


def toolchain() -> dict[str, str]:
    """What a trial runs besides strive: the checks run under this Python, and
    the agent's shell finds python3 and git on PATH."""
    tools = {"PATH": os.environ.get("PATH", ""), "checks": f"{sys.executable} {sys.version}"}
    for name in ("python3", "git"):
        found = shutil.which(name)
        out = subprocess.run([found, "--version"], capture_output=True, text=True).stdout.strip() if found else ""
        tools[name] = f"{found} {out}"
    return tools


class Runner:
    def __init__(self, args: argparse.Namespace, tasks: dict, trials: list[ev.Trial], out: Path) -> None:
        self.args = args
        self.tasks = tasks
        self.trials = trials
        self.out = out
        self.model = args.model
        self.strive = args.strive.resolve()
        self.results = out / "results.jsonl"
        self.spent = 0.0
        self.sequences: list[tuple[Sequence, list[ev.Trial]]] = []
        # Sequences kept from an earlier run (--resume): their records, not run again.
        self.kept: dict[tuple[str, int], list[dict]] = {}
        self.inputs = ""  # run_inputs(), set before the suite is locked

    def pinned(self, model: str) -> bool:
        return model == self.model or model.startswith(self.model + "-")

    def write(self, record: dict) -> None:
        with self.results.open("a") as f:
            f.write(json.dumps(record) + "\n")

    def run(self) -> list[dict]:
        (self.out / "journals").mkdir(parents=True, exist_ok=True)
        (self.out / "strive").mkdir(exist_ok=True)
        self.write({"type": "run", "model": self.model, "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "args": {k: str(v) for k, v in vars(self.args).items()}, "inputs": self.inputs})
        for t in self.trials:
            self.write({"type": "planned", "key": t.key, **asdict(t)})
        done: list[dict] = []
        for (arm, k), records in self.kept.items():
            for record in records:
                self.write({**record, "resumed_from": str(self.args.resume)})
                done.append(record)
                self.spent += record["cost_usd"] + (record.get("learner") or {}).get("cost_usd", 0.0)
            print(f"kept {arm} sequence {k} from {self.args.resume}: {len(records)} trials", flush=True)
        try:
            self._run(done)
        finally:
            for seq, _ in self.sequences:
                shutil.rmtree(seq.root, ignore_errors=True)
        missing = {t.key for t in self.trials} - {r["key"] for r in done}
        if missing:
            raise RunFailed(f"{len(missing)} planned trials have no result: {sorted(missing)[:10]}")
        return done

    def stage(self) -> None:
        """Every sequence's home and vault, made before the suite is locked."""
        groups: dict[tuple[str, int], list[ev.Trial]] = {}
        for t in self.trials:
            groups.setdefault((t.arm, t.sequence), []).append(t)
        self.sequences = [(Sequence(self, arm, k), ts) for (arm, k), ts in groups.items() if (arm, k) not in self.kept]

    def _run(self, done: list[dict]) -> None:
        for seq, ts in self.sequences:
            seq.start_daemon()
            try:
                for t in ts:
                    record = seq.trial(t)
                    self.write(record)
                    done.append(record)
                    self.spent += record["cost_usd"] + (record.get("learner") or {}).get("cost_usd", 0.0)
                    mark = "pass" if record["passed"] else "FAIL"
                    print(f"{t.key:<14} {t.family}/{t.instance:<12} {mark}  turns {record['turns']:<3} "
                          f"${record['cost_usd']:.4f}  memory {'yes' if record['memory_loaded'] else 'no '}"
                          + (f"  accepted {sum(p['accepted'] for p in record['learner']['proposals'])}"
                             if record.get("learner") else ""), flush=True)
                    if self.spent > self.args.max_usd:
                        raise RunFailed(f"spent ${self.spent:.2f}, over --max-usd {self.args.max_usd}")
            finally:
                seq.close()


# ---------------------------------------------------------------- output


def print_plan(trials: list[ev.Trial], tasks: dict, fams: list[str], args, screen: bool) -> None:
    arms = sorted({t.arm for t in trials}, key=ev.ARMS.index)
    print(f"strive: {args.strive} ({strive_version(args.strive)})")
    print(f"model: {args.model}   per-task budget: ${args.task_budget}   learner budget per sequence: "
          f"${args.learner_budget}   turn limit: {args.turn_seconds}s")
    print(f"families ({len(fams)}): {', '.join(fams)}")
    print(f"{'screen: calibration instances only' if screen else 'full run'}; arms: {', '.join(arms)}\n")
    print(f"{'arm':<8} {'sequences':>9} {'tasks':>6} {'seeds':>6} {'tests':>6} {'probes':>6} {'calib':>6} {'learner runs':>13}")
    for arm in arms:
        ts = [t for t in trials if t.arm == arm]
        print(f"{arm:<8} {len({t.sequence for t in ts}):>9} {len(ts):>6} "
              f"{sum(t.role in ('seed', 'poison') for t in ts):>6} {sum(t.role == 'test' and not t.probe for t in ts):>6} "
              f"{sum(t.probe for t in ts):>6} {sum(t.role == 'calibration' for t in ts):>6} "
              f"{len(ts) if arm in ev.LEARNS else 0:>13}")
    print(f"{'total':<8} {'':>9} {len(trials):>6}")
    if not screen:
        scored = [t for t in trials if t.arm == "L" and t.role == "test" and not t.probe
                  and tasks[(t.family, t.instance)].kind == "learnable"]
        print(f"\npaired L-F comparisons on learnable test instances: {len(scored)}")
        for k in sorted({t.sequence for t in trials if t.arm in ("F", "L")}):
            order = [t for t in trials if t.arm in ("F", "L") and t.sequence == k]
            order = [t for t in order if t.arm == order[0].arm]
            print(f"\nordering {k}: " + " ".join(f"{t.family}:{t.instance}{'*' if t.probe else ''}" for t in order))
        poisoned = sorted({t.family for t in trials if t.instance == "seed-poison"})
        if poisoned:
            print(f"\nP uses ordering 0 with poisoned seeds for: {', '.join(poisoned)}")
        print("(* a forgetting probe: an early family's first test, run again at the end)")


def print_estimate(est: dict, model: str) -> None:
    print(f"\ncost estimate ({model}): ${est['low']:.2f} to ${est['high']:.2f}")
    print(f"  {est['tasks']} agent tasks at ${est['per_task']['low']:.4f}-${est['per_task']['high']:.4f}; "
          f"{est['learner_runs']} learner runs (with the judge) at "
          f"${est['per_learner_run']['low']:.4f}-${est['per_learner_run']['high']:.4f}")
    print(f"  basis: {est['basis']}")
    if not est["basis"].startswith("measured"):
        p = ev.price_of(model)
        print(f"  prices per million tokens: input ${p['input']}, cache write ${p['cache_write']}, "
              f"cache read ${p['cache_read']}, output ${p['output']}")
        for what in ("task", "learner"):
            for b in ("low", "high"):
                a = ev.ASSUMED[what][b]
                print(f"  assumed {what} ({b}): {a['input']:,} input, {a['cache_write']:,} cache write, "
                      f"{a['cache_read']:,} cache read, {a['output']:,} output tokens")


def summarize(results: Path, tasks: dict, screen: bool, label: str) -> Path:
    rows = [json.loads(line) for line in results.read_text().splitlines()]
    trials = [r for r in rows if r.get("type") == "trial"]
    run = next((r for r in rows if r.get("type") == "run"), {})
    kinds = ev.kinds(tasks)
    meta = {"label": label, "model": run.get("model"), "trials": len(trials), "results": str(results),
            "cost_usd": sum(t["cost_usd"] + (t.get("learner") or {}).get("cost_usd", 0.0) for t in trials)}
    out = results.parent
    if screen:
        fams = stats.screen(trials, kinds)
        meta["paired"] = stats.screen_paired(trials)
        (out / "screen.json").write_text(json.dumps({"families": fams, "keep": [f for f, v in fams.items() if v["keep"]],
                                                     **meta}, indent=2))
        md = stats.screen_markdown(fams, meta)
        (out / "screen.md").write_text(md)
        print("\n" + md)
        return out / "screen.md"
    s = stats.summarize(trials, kinds)
    (out / "summary.json").write_text(json.dumps({**s, "meta": meta}, indent=2, default=str))
    md = stats.markdown(s, meta)
    (out / "summary.md").write_text(md)
    print("\n" + md)
    return out / "summary.md"


def isolation_probe(a: argparse.Namespace) -> int:
    """For selfcheck.py: an agent session (a scripted model told to cat a
    task's check from the vault and from the checkout) under the same
    sequence setup and lock as a run. Prints what each read returned."""
    out = Path(tempfile.mkdtemp(prefix="sev-probe-", dir="/tmp"))
    runner = Runner(a, ev.load_tasks(), [], out)
    seq = Sequence(runner, "F", 0)
    with ev.SuiteLock():
        seq.start_daemon()
        try:
            task = seq.tasks[("regression-test", "t1")]
            ev.prepare(task, seq.ws, template=seq.vault / "project")
            # The workspace's own README is the control: a read that should work.
            targets = {"workspace": seq.ws / "README.md", "vault": task.dir / "check.py",
                       "checkout": ev.TASKS / "regression-test" / "t1" / "check.py"}
            marks = {"workspace": "Invoices, VAT", "vault": "def check(ws)", "checkout": "def check(ws)"}
            command = "; ".join(f"echo '== {name}'; cat {path}" for name, path in targets.items())
            run = seq.strive("run", "--json", "--approvals", "full-auto", "--budget", "0.5", "-",
                             stdin=f"Run exactly this command: {command}")
            digests = [json.loads(line)["event"]["outcome"].get("output") for line in run.stdout.splitlines()
                       if '"effectFinished"' in line]
            c = seq.rpc()
            try:
                shown = "\n".join(c.call("blob/get", {"digest": d})["text"] for d in digests if d)
            finally:
                c.close()
            j = ev.read_journal(run.stdout.splitlines())
            sections = dict(re.findall(r"== (\w+)\n(.*?)(?=\n== |\Z)", shown, re.S))
            print(json.dumps({
                "readable": {name: marks[name] in sections.get(name, "") for name in targets},
                "shown": {name: sections.get(name, "")[:200] for name in targets},
                "peeked": ev.peeked(j, [str(ev.STRIVE), str(seq.home), *ev.PEEK_MARKERS]),
            }))
        finally:
            seq.close()
            shutil.rmtree(out, ignore_errors=True)
    return 0


# ---------------------------------------------------------------- main


def default_strive() -> Path:
    """This checkout's build first: an installed strive may be older than the suite expects."""
    for build in ("release", "debug"):
        p = ev.STRIVE / "target" / build / "strive"
        if p.exists():
            return p
    return Path(shutil.which("strive") or ev.STRIVE / "target/debug/strive")


def strive_version(strive: Path) -> str:
    try:
        return subprocess.run([str(strive), "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except OSError:
        return "not found"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="print the plan and its cost estimate, and stop")
    p.add_argument("--screen", action="store_true", help="run only the calibration instances, under F and O")
    p.add_argument("--screen-reps", type=int, default=1, help="repetitions of each calibration instance (default 1)")
    p.add_argument("--summarize", type=Path, metavar="RESULTS", help="rewrite the summary of a results.jsonl")
    p.add_argument("--arms", default=",".join(ev.ARMS), help="comma-separated, from F,L,O,P,placebo (default all)")
    p.add_argument("--families", help="comma-separated families (default all 12)")
    p.add_argument("--families-from", type=Path, metavar="SCREEN_JSON", help="the families a screen kept")
    p.add_argument("--sequences", type=int, help="at most this many sequences per arm (default ADR-0021's 3/3/2/1/1)")
    p.add_argument("--seed", type=int, default=2026, help="seeds the orderings (default 2026)")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"the pinned model (default {DEFAULT_MODEL})")
    p.add_argument("--task-budget", type=float, default=0.40, help="dollars per agent task (default 0.40)")
    p.add_argument("--learner-budget", type=float, default=4.0,
                   help="dollars for each sequence's learning session, all its learner and judge runs (default 4)")
    p.add_argument("--turn-seconds", type=int, default=600, help="time limit per task (default 600)")
    p.add_argument("--no-lock", action="store_true",
                   help="leave the checkout's checks and oracles readable during the run (the agent could read them)")
    p.add_argument("--isolation-probe", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--keep-learner-host", action="store_true",
                   help="don't restart the daemon before each learner run (the learner then keeps a stale view of memory)")
    p.add_argument("--max-usd", type=float, default=60.0, help="stop the run past this total (default 60)")
    p.add_argument("--calibration", type=Path, metavar="RESULTS", help="estimate cost from a screen's results.jsonl")
    p.add_argument("--strive", type=Path, default=default_strive(),
                   help="the strive binary (default: this checkout's target/release or target/debug build, else PATH's)")
    p.add_argument("--out", type=Path, help="output directory (default eval-runs/<time> under strive/)")
    p.add_argument("--yes", action="store_true", help="run for real (after reading the --dry-run estimate)")
    p.add_argument("--resume", type=Path, metavar="RESULTS",
                   help="keep an earlier run's finished sequences (same plan) from its results.jsonl; run the rest")
    a = p.parse_args()

    ev.unlock()  # a killed run may have left the suite locked
    if a.isolation_probe:
        return isolation_probe(a)
    tasks = ev.load_tasks()
    if a.summarize:
        first = json.loads(a.summarize.read_text().splitlines()[0])
        summarize(a.summarize, tasks, first.get("args", {}).get("screen") == "True", "resummarized")
        return 0
    fams = ev.families(tasks)
    if a.families:
        fams = [f.strip() for f in a.families.split(",")]
    if a.families_from:
        keep = set(json.loads(a.families_from.read_text())["keep"])
        fams = [f for f in fams if f in keep]
    unknown = [f for f in fams if f not in ev.families(tasks)]
    if unknown or not fams:
        print(f"unknown or no families: {unknown}", file=sys.stderr)
        return 2
    arms = [x.strip() for x in a.arms.split(",")]
    if any(x not in ev.ARMS for x in arms):
        print(f"arms are {', '.join(ev.ARMS)}", file=sys.stderr)
        return 2
    if a.screen:
        trials = ev.screen_plan(tasks, fams, a.screen_reps)
    else:
        seqs = {k: min(v, a.sequences) if a.sequences else v for k, v in ev.SEQUENCES.items()}
        trials = ev.plan(tasks, arms, fams, a.seed, seqs)
    measured = ev.measured_costs(a.calibration) if a.calibration else None
    est = ev.estimate(trials, a.model, measured)
    print_plan(trials, tasks, fams, a, a.screen)
    print_estimate(est, a.model)
    if a.dry_run:
        return 0
    if not a.yes:
        print("\nnot running: this spends real money. Read the estimate above, then add --yes.", file=sys.stderr)
        return 2
    if not a.strive.exists():
        print(f"no strive at {a.strive}: build it (cargo build -p strived) or pass --strive", file=sys.stderr)
        return 2
    if not upstream_is_local() and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY isn't set; the run's fresh STRIVE_HOME has no stored key", file=sys.stderr)
        return 2
    problems = verify_oracles(tasks, {(t.family, t.instance) for t in trials})
    if problems:
        print("refusing to run: these tasks can't be scored\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print(f"\nall {len({(t.family, t.instance) for t in trials})} tasks: unfixed fails its check, the oracle passes it")
    out = (a.out or ev.STRIVE / "eval-runs" / time.strftime("%Y%m%d-%H%M%S")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    runner = Runner(a, tasks, trials, out)
    # Before the suite is locked: afterwards its files can't be read.
    try:
        runner.inputs = run_inputs(a.strive.resolve())
    except PermissionError as e:
        print(f"can't read {e.filename}: is another run going? It locks the suite until it ends", file=sys.stderr)
        return 1
    if a.resume:
        earlier = [json.loads(line) for line in a.resume.read_text().splitlines() if line.strip()]
        run = next((r for r in earlier if r.get("type") == "run"), None)
        if run is None:
            print(f"refusing to resume: {a.resume} has no run record, so its settings are unknown", file=sys.stderr)
            return 1
        differ = resume_mismatch(run["args"], {k: str(v) for k, v in vars(a).items()})
        if differ:
            print(f"refusing to resume: these settings differ from {a.resume}'s run: " + ", ".join(differ)
                  + "\n  run with the same settings, or start a new run without --resume", file=sys.stderr)
            return 1
        if run.get("inputs") != runner.inputs:
            print(f"refusing to resume: the suite, the runner, the strive binaries or STRIVE_ settings changed since "
                  f"{a.resume}'s run (or it recorded none)\n  start a new run without --resume", file=sys.stderr)
            return 1
        runner.kept = completed_sequences(earlier, trials)
        print(f"resuming: {len(runner.kept)} finished sequences kept from {a.resume}")
    runner.stage()
    try:
        if a.no_lock:
            runner.run()
        else:
            print(f"until the run ends, these are unreadable: " + ", ".join(f"{ev.EVAL.name}/{p}" for p in ev.SECRET))
            with ev.SuiteLock():
                runner.run()
    except RunFailed as e:
        print(f"\nthe run failed: {e}\nresults so far: {runner.results}", file=sys.stderr)
        return 1
    summarize(runner.results, tasks, a.screen, "screen" if a.screen else "full run")
    print(f"results: {runner.results}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

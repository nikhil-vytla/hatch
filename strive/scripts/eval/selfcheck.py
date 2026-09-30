#!/usr/bin/env python3
"""Checks the eval without spending anything.

    python3 scripts/eval/selfcheck.py          # the suite: about a minute
    python3 scripts/eval/selfcheck.py --e2e    # also the runner against a scripted model

The suite checks: eval/tasks is what eval/build_tasks.py writes; the
template's own tests, lint and generated files pass; every task's check
fails on the task as set up and passes once its oracle is applied; a
workspace holds nothing of the checks, oracles or task files; where a family
names the terms of its rule, no set-up workspace contains them; a fix that
does the task but ignores the rule fails (only the rule's checks, where the
family says so); the memories are within 2% of each other's length. --e2e also runs scripts/eval/run_eval.py end to end on
two families against strive's FakeAnthropic (no key, no network), and
checks it wrote trials, learner runs and a summary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evallib as ev  # noqa: E402

failures: list[str] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    print(f"{'ok  ' if passed else 'FAIL'} {name}" + (f"\n     {detail}" if detail and not passed else ""))
    if not passed:
        failures.append(name)


def template_passes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp) / "ws"
        shutil.copytree(ev.TEMPLATE, ws, ignore=shutil.ignore_patterns("__pycache__"))
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "TALLY_FX_RATES": "tests/fixtures/rates.csv"}
        for argv in (["dev", "test"], ["dev", "lint"], ["tools/gen_records.py", "--check"], ["tools/lock.py", "--check"]):
            r = subprocess.run([sys.executable, *argv], cwd=ws, env=env, capture_output=True, text=True, timeout=120)
            ok(f"the template passes {' '.join(argv)}", r.returncode == 0, (r.stdout + r.stderr)[-1500:])


def rule_mentions(task: ev.Task, ws: Path) -> list[str]:
    """Where a set-up workspace states its family's rule: each of the
    family's patterns found in a file it isn't allowed in, as path: pattern."""
    hits = []
    for term in task.meta.get("hidden_terms", []):
        pattern = re.compile(term["pattern"], re.I)
        for p in sorted(ws.rglob("*")):
            rel = p.relative_to(ws).as_posix()
            if not p.is_file() or ".git" in p.relative_to(ws).parts or rel in term["allowed_in"]:
                continue
            if pattern.search(p.read_text(errors="replace")):
                hits.append(f"{rel}: {term['pattern']}")
    return hits


def one_task(task: ev.Task) -> list[tuple[str, bool, str]]:
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp) / "ws"
        ev.prepare(task, ws)
        leftovers = [str(p.relative_to(ws)) for p in ws.rglob("*") if p.name in ("check.py", "task.json", "check-data")]
        text = "\n".join(p.read_text(errors="replace") for p in ws.rglob("*") if p.is_file() and ".git" not in p.parts)
        markers = [m for m in (str(ev.EVAL), "checklib", "check-data", "build_tasks") if m in text]
        out.append((f"{task.family}/{task.instance}: the workspace holds nothing of the checks",
                    not leftovers and not markers, f"{leftovers} {markers}"))
        if task.meta.get("hidden_terms"):
            hits = rule_mentions(task, ws)
            out.append((f"{task.family}/{task.instance}: no workspace file states the rule", not hits, "; ".join(hits)))
        before = ev.run_check(task, ws)
        out.append((f"{task.family}/{task.instance}: fails before the fix", not before.passed, before.raw[-800:]))
        ev.apply_oracle(task, ws)
        after = ev.run_check(task, ws)
        out.append((f"{task.family}/{task.instance}: the oracle passes", after.passed, json.dumps(after.failed)[-1500:]))
    if (task.dir / "violation").is_dir():
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "ws"
            ev.prepare(task, ws)
            ev.overlay(task.dir / "violation", ws)
            broke = ev.run_check(task, ws)
            out.append((f"{task.family}/{task.instance}: a fix that ignores the rule fails", not broke.passed,
                        json.dumps(broke.signals)))
            if task.meta.get("naive_fails_only_on_rule"):
                others = [f["check"] for f in broke.failed if not f["check"].startswith("rule: ")]
                out.append((f"{task.family}/{task.instance}: that fix fails only the rule's checks", not others,
                            json.dumps(broke.failed)[-1500:]))
    return out


def suite() -> None:
    r = subprocess.run([sys.executable, str(ev.EVAL / "build_tasks.py"), "--check"], capture_output=True, text=True)
    ok("eval/tasks is what eval/build_tasks.py writes", r.returncode == 0, r.stderr)
    template_passes()
    tasks = ev.load_tasks()
    fams = ev.families(tasks)
    k = ev.kinds(tasks)
    ok("12 families: 9 learnable, 2 generic, 1 conflicting",
       (len(fams), sorted(k.values()).count("learnable"), sorted(k.values()).count("generic"),
        sorted(k.values()).count("conflict")) == (12, 9, 2, 1), str(k))
    for fam in fams:
        roles = sorted(t.role for t in tasks.values() if t.family == fam)
        want = ["calibration", "calibration", "seed", "test", "test", "test"]
        ok(f"{fam}: 1 seed, 3 test and 2 calibration instances", [r for r in roles if r != "poison"] == want, str(roles))
    ok("a poison seed for each poisoned family", all((f, "seed-poison") in tasks for f in ev.POISONED))
    a, b = (len(p.read_text()) for p in ev.MEMORIES.values())
    ok("the placebo memory is within 2% of the oracle memory's length", abs(a - b) <= 0.02 * a, f"{a} vs {b}")
    for fam in fams:
        ts = [t for t in tasks.values() if t.family == fam]
        terms = ts[0].meta.get("hidden_terms")
        if not terms:
            continue
        print(f"     {fam}: the rule's terms, scanned for in every set-up workspace: "
              + ", ".join(t["pattern"] + (f" (allowed in {', '.join(t['allowed_in'])})" if t["allowed_in"] else "")
                          for t in terms))
        naive = [t.instance for t in ts if t.role != "poison" and not (t.dir / "violation").is_dir()]
        ok(f"{fam}: every instance has a fix that ignores the rule", not naive, f"none for {naive}")
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for results in pool.map(one_task, tasks.values()):
            for name, passed, detail in results:
                ok(name, passed, detail)
    print(f"     ({len(tasks)} tasks checked in {time.monotonic() - started:.0f}s)")


def e2e(strive: Path, keep: bool) -> None:
    """The runner end to end against a scripted model: every arm, a small plan."""
    fake = subprocess.Popen(["bun", str(Path(__file__).resolve().parent / "fake_model.ts")], stdout=subprocess.PIPE,
                            text=True, cwd=ev.STRIVE)
    try:
        assert fake.stdout is not None
        url = fake.stdout.readline().strip()
        ok("the scripted model started", url.startswith("http://127.0.0.1:"), url)
        out = Path(tempfile.mkdtemp(prefix="strive-eval-e2e-"))
        env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY")}
        env.update({
            "STRIVE_UPSTREAM_ANTHROPIC": url,
            "STRIVE_UPSTREAM_OPENAI": "http://127.0.0.1:9",
            "ANTHROPIC_API_KEY": "sk-fake-e2e",
            "STRIVE_HOST": f"bun {ev.STRIVE / 'packages/host/src/main.ts'}",
        })
        probe = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "run_eval.py"), "--strive",
                                str(strive), "--turn-seconds", "120", "--isolation-probe"],
                               env=env, capture_output=True, text=True, timeout=600)
        try:
            seen = json.loads(probe.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            seen = {"readable": {}, "peeked": [], "error": (probe.stdout + probe.stderr)[-2000:]}
        readable = seen["readable"]
        ok("an agent command can read its own workspace (the probe's control)", readable.get("workspace") is True,
           json.dumps(seen)[:1500])
        ok("an agent command can't read a check in the vault (strive's home)", readable.get("vault") is False,
           json.dumps(seen)[:1500])
        ok("an agent command can't read a check in the checkout during a run", readable.get("checkout") is False,
           json.dumps(seen)[:1500])
        ok("reaching for the checks is flagged as peeking", len(seen["peeked"]) > 0, json.dumps(seen)[:800])
        ok("the checkout's checks are readable again after the run", os.access(ev.TASKS, os.R_OK))
        argv = [sys.executable, str(Path(__file__).resolve().parent / "run_eval.py"), "--strive", str(strive),
                "--out", str(out), "--families", "regression-test,conflicting-keys", "--sequences", "1",
                "--task-budget", "0.5", "--turn-seconds", "120", "--yes"]
        r = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=1800)
        ok("run_eval.py finished", r.returncode == 0, (r.stdout + r.stderr)[-3000:])
        results = out / "results.jsonl"
        rows = [json.loads(line) for line in results.read_text().splitlines()] if results.exists() else []
        trials = [x for x in rows if x.get("type") == "trial"]
        ok("results.jsonl has a trial for every planned task", len(trials) > 0 and all(
            any(t["key"] == p["key"] for t in trials) for p in rows if p.get("type") == "planned"), f"{len(trials)} trials")
        ok("every arm ran", {t["arm"] for t in trials} == set(ev.ARMS), str({t["arm"] for t in trials}))
        learned = [t for t in trials if t.get("learner")]
        ok("the learner ran after each L and P task", len(learned) == sum(1 for t in trials if t["arm"] in ev.LEARNS))
        unaccepted = [t["key"] for t in learned if not any(p["accepted"] for p in t["learner"]["proposals"])]
        ok("each learner run's proposal passed the static check and was accepted", learned and not unaccepted,
           f"none accepted after {unaccepted}")
        carried = [t for t in trials if t["arm"] == "L"]
        bullets = 0
        if carried:
            last = carried[-1]
            memory = out / "strive" / f"L-0-{last['position']:02d}-{last['family']}-{last['instance']}" / "memory.md"
            bullets = memory.read_text().count("\n- ") + 1 if memory.exists() else 0
        ok("L's memory carried forward, a bullet per task", carried and bullets == len(carried),
           f"{bullets} bullets, {len(carried)} tasks")
        ok("the judge's advice was recorded", all("judge" in p for t in learned for p in t["learner"]["proposals"]))
        loaded: dict[str, set] = {}
        for t in trials:
            if t["position"] > 0:
                loaded.setdefault(t["arm"], set()).add(t["memory_loaded"])
        ok("memory was loaded in every O, placebo, and later L and P task, never in F",
           loaded == {"F": {False}, "L": {True}, "O": {True}, "P": {True}, "placebo": {True}}, str(loaded))
        ok("cost and turns were read from the journals", all(t["cost_usd"] > 0 and t["turns"] > 0 for t in trials))
        ok("the model was the pinned one throughout", all(t["model_ok"] for t in trials))
        summary = out / "summary.md"
        ok("a summary was written", summary.exists() and "H1" in summary.read_text(),
           summary.read_text()[:500] if summary.exists() else "none")
        if summary.exists():
            print("\n" + summary.read_text())
        if not keep:
            shutil.rmtree(out, ignore_errors=True)
        else:
            print(f"     (kept {out})")
    finally:
        fake.terminate()
        fake.wait(timeout=10)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--e2e", action="store_true", help="also run the runner against a scripted model")
    p.add_argument("--only-e2e", action="store_true", help="skip the suite checks")
    p.add_argument("--strive", type=Path, default=ev.STRIVE / "target/debug/strive")
    p.add_argument("--keep", action="store_true", help="keep the e2e run's output directory")
    a = p.parse_args()
    if not a.only_e2e:
        suite()
    if a.e2e or a.only_e2e:
        if not a.strive.exists():
            ok(f"{a.strive} exists (cargo build -p strived)", False)
        else:
            e2e(a.strive, a.keep)
    print(f"\n{len(failures)} failed" if failures else "\nselfcheck: all passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

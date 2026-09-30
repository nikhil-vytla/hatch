#!/usr/bin/env python3
"""The learner alone, on the eval's seed sessions: does it propose the rule a
seed shows? Each seed task runs once (the agent, with no memory); then the
learner runs on that same session several times under each host given, from a
copy of the strive home as the seed left it. The agent's work is identical
across hosts, so only the learner differs.

    python3 scripts/eval/learner_probe.py --strive BIN --host NAME=DIR --host NAME=DIR --yes

A host DIR is a strive checkout; its packages/host runs the learner. The
model is pinned as in the eval, and the run stops at --max-usd.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evallib as ev  # noqa: E402
import run_eval  # noqa: E402

# What a proposal carrying the seed's rule mentions. Learnable seeds should
# get one; the controls (generic, conflicting) state no project rule, and a
# poisoned seed states a wrong one.
RULE_TERMS = {
    "api-version": r"API_VERSION",
    "audit-event": r"audit",
    "codeowners": r"CODEOWNERS|owner",
    "currency-coverage": r"JPY|yen|zero.decimal",
    "deprecate-alias": r"[Dd]eprecat",
    "lockfile": r"dev lock|tally\.lock",
    "regression-test": r"regression",
    "versionadded": r"versionadded",
    "conflicting-keys": r"camel|snake",
    "generic-logic": r"$^",
    "generic-parsing": r"$^",
}

# The most one run may spend, which the daemon enforces as its session's
# budget: a seed task's --budget, and each learner run's (every run opens a
# fresh learning session). The eval's L arm spent at most $0.07 on one.
SEED_USD = 0.4
LEARN_USD = 0.25


class Ledger:
    """--max-usd, held as the eval's gateway holds a session's budget: a run
    reserves its most before it starts, and settles at what it cost. A run
    whose cost is unknown (it raised) is charged all it reserved. Every
    record is written as it settles, so a seed that fails keeps its runs.
    Money is integer micro-USD, so what's held returns to exactly 0."""

    def __init__(self, cap: float, results: Path) -> None:
        self.cap = micros(cap)
        self.results = results
        self.spent_micros = 0
        self.held = 0
        self.changed = threading.Condition()

    @property
    def spent(self) -> float:
        return self.spent_micros / 1e6

    def reserve(self, usd: float) -> bool:
        """True once `usd` is held for a run. It waits while runs in flight
        hold what it needs, and is False when what's spent leaves too little."""
        want = micros(usd)
        with self.changed:
            while self.spent_micros + self.held + want > self.cap:
                if self.spent_micros + want > self.cap:
                    return False
                self.changed.wait()
            self.held += want
            return True

    def settle(self, reserved: float, record: dict) -> None:
        held = micros(reserved)
        cost = record.get("cost_usd")
        with self.changed:
            # What was held is released even if the record can't be written,
            # and the runs waiting on it are woken either way.
            try:
                self.held -= held
                self.spent_micros += held if cost is None else micros(cost)
                line = json.dumps(record)
                with self.results.open("a") as f:
                    f.write(line + "\n")
            finally:
                self.changed.notify_all()


def micros(usd: float) -> int:
    return round(usd * 1_000_000)


SEEDS = [(f, "seed") for f in RULE_TERMS] + [("api-version", "seed-poison"), ("regression-test", "seed-poison")]


def proposal_texts(seq: run_eval.Sequence, ids: set[int]) -> dict[int, str]:
    c = seq.rpc()
    try:
        listed = c.call("proposal/list", {"cwd": str(seq.ws)})["proposals"]
    finally:
        c.close()
    return {p["id"]: json.dumps(p["proposal"].get("change")) for p in listed if p["id"] in ids}


def first_request(seq: run_eval.Sequence, journal: Path) -> str:
    """The learner's first model request, as the gateway sent it."""
    for line in journal.read_text().splitlines():
        e = json.loads(line)["event"] if line.strip() else {}
        if e.get("type") == "modelCallStarted":
            c = seq.rpc()
            try:
                return c.call("blob/get", {"digest": e["request"]})["text"]
            finally:
                c.close()
    return ""


def probe(r: SimpleNamespace, seq: run_eval.Sequence, family: str, instance: str) -> None:
    i = seq.k
    stem = f"{family}-{instance}"
    ledger: Ledger = r.ledger
    try:
        if not ledger.reserve(SEED_USD):
            print(f"{stem:30} not run: --max-usd would be passed", flush=True)
            return
        try:
            seq.start_daemon()
            t = ev.Trial(arm="F", sequence=i, position=0, family=family, instance=instance, role="seed")
            seed = seq.trial(t)
        except BaseException as e:
            ledger.settle(SEED_USD, {"type": "seed", "family": family, "instance": instance, "cost_usd": None,
                                     "error": str(e)[:400]})
            raise
        ledger.settle(SEED_USD, {"type": "seed", "family": family, "instance": instance, "passed": seed["passed"],
                                 "cost_usd": seed["cost_usd"], "session": seed["session"]})
        subprocess.run([str(r.strive), "stop"], cwd=seq.root, env=seq.env, capture_output=True, timeout=60)
        snap = seq.root / "snap"
        # The socket and pid files are the stopped daemon's.
        shutil.copytree(seq.home, snap / "h", ignore=shutil.ignore_patterns("run"))
        shutil.copytree(seq.ws, snap / "tally")
        for rep in range(r.args.reps):
            # Alternate which host goes first, so neither always runs on a warmer API.
            for name, host in (r.hosts if rep % 2 == 0 else r.hosts[::-1]):
                for d, src in ((seq.home, snap / "h"), (seq.ws, snap / "tally")):
                    shutil.rmtree(d)
                    shutil.copytree(src, d)
                seq.env["STRIVE_HOST"] = f"bun {host}/packages/host/src/main.ts"
                seq.learning_seen = 0
                if not ledger.reserve(LEARN_USD):
                    print(f"{stem:30} {name:8} rep {rep}  not run: --max-usd would be passed", flush=True)
                    return
                try:
                    seq.start_daemon()
                    learned = seq.learn(seed["session"], f"{stem}-{name}-{rep}")
                    texts = proposal_texts(seq, {p["id"] for p in learned["proposals"]})
                    # Which learner prompt ran: the revised one names "a standing rule the user stated".
                    sent = first_request(seq, r.out / "journals" / f"{stem}-{name}-{rep}.learner.jsonl")
                    subprocess.run([str(r.strive), "stop"], cwd=seq.root, env=seq.env, capture_output=True, timeout=60)
                except BaseException as e:
                    ledger.settle(LEARN_USD, {"type": "learn", "family": family, "instance": instance, "host": name,
                                              "rep": rep, "cost_usd": None, "error": str(e)[:400]})
                    raise
                revised = "standing rule the user stated" in sent
                props = [{**p, "change": texts.get(p["id"], "")} for p in learned["proposals"]]
                hit = any(re.search(RULE_TERMS[family], p["change"] + " " + (p["summary"] or "")) for p in props)
                ledger.settle(LEARN_USD, {
                    "type": "learn", "family": family, "instance": instance, "host": name, "rep": rep,
                    "cost_usd": learned["cost_usd"], "model_ok": learned["model_ok"],
                    "turn_end": learned["turn_end"], "proposals": props, "rule_proposed": hit,
                    "revised_prompt": revised, "request_names_stated_rules": "read the user's messages too" in sent})
                print(f"{stem:30} {name:8} rep {rep}  {len(props)} proposed  rule {'yes' if hit else 'no '}"
                      f"  ${learned['cost_usd']:.4f}  revised prompt {'yes' if revised else 'no'}", flush=True)
                if not learned["model_ok"]:
                    raise run_eval.RunFailed(f"{stem}: the learner used a model other than {r.model}")
    finally:
        seq.close()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--strive", type=Path, required=True)
    p.add_argument("--host", action="append", required=True, metavar="NAME=DIR")
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--model", default=run_eval.DEFAULT_MODEL)
    p.add_argument("--max-usd", type=float, default=5.0)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seeds", help="only these, comma-separated: family/instance")
    p.add_argument("--yes", action="store_true")
    a = p.parse_args()
    seeds = [s for s in SEEDS if not a.seeds or "/".join(s) in a.seeds.split(",")]
    hosts = [(n, str(Path(d).resolve())) for n, d in (h.split("=", 1) for h in a.host)]
    # Typical costs, from the eval: a learner run $0.03-0.06, a seed task about $0.05.
    estimate = len(seeds) * (0.05 + a.reps * len(hosts) * 0.05)
    print(f"{len(seeds)} seeds x {a.reps} reps x {len(hosts)} hosts; about ${estimate:.2f}, capped at ${a.max_usd}")
    if not a.yes:
        print("not running: this spends real money; add --yes", file=sys.stderr)
        return 2
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "journals").mkdir(exist_ok=True)
    (a.out / "strive").mkdir(exist_ok=True)
    args = SimpleNamespace(learner_budget=LEARN_USD, turn_seconds=600, task_budget=SEED_USD, keep_learner_host=False,
                           reps=a.reps)
    results = a.out / "results.jsonl"
    ledger = Ledger(a.max_usd, results)
    # Sequence.trial writes a record the run can't use (another model answered) before
    # raising; the probe's own record of that seed is written when it settles.
    r = SimpleNamespace(model=a.model, args=args, strive=a.strive.resolve(), out=a.out, hosts=hosts, ledger=ledger,
                        pinned=lambda m: m == a.model or m.startswith(a.model + "-"),
                        write=lambda rec: print(f"not the pinned model: {rec.get('models')}", file=sys.stderr))
    # Each sequence copies the suite into its vault, so before the suite is locked.
    seqs = [run_eval.Sequence(r, "F", i) for i in range(len(seeds))]
    with ev.SuiteLock(), ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(probe, r, seq, f, inst) for seq, (f, inst) in zip(seqs, seeds)]
        for fut in futures:
            try:
                fut.result()
            except Exception as e:  # noqa: BLE001 - one seed failing leaves the others, and its records are written
                print(f"failed: {e}", file=sys.stderr)
    print(f"spent: ${ledger.spent:.2f} of ${a.max_usd}")
    if results.exists():
        summarize(results)
    return 0


def summarize(results: Path) -> None:
    recs = [json.loads(line) for line in results.read_text().splitlines() if line.strip()]
    learns = [x for x in recs if x["type"] == "learn" and "error" not in x]
    failed = [x for x in recs if "error" in x]
    hosts = sorted({x["host"] for x in learns})
    print(f"\n{'seed':30}" + "".join(f"{h:>14}" for h in hosts))
    for f, inst in SEEDS:
        if not any(x["family"] == f and x["instance"] == inst for x in learns):
            continue
        row = [x for x in learns if x["family"] == f and x["instance"] == inst]
        cells = [f"{sum(x['rule_proposed'] for x in row if x['host'] == h)}/{sum(x['host'] == h for x in row)}"
                 f" ({sum(len(x['proposals']) for x in row if x['host'] == h)})" for h in hosts]
        print(f"{f + '/' + inst:30}" + "".join(f"{c:>14}" for c in cells))
    print("cells: runs proposing the seed's rule / runs (all proposals made)")
    if failed:
        print(f"failed runs: {len(failed)} (charged what they reserved)")


if __name__ == "__main__":
    sys.exit(main())

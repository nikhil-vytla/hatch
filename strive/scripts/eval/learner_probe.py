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


def probe(r: SimpleNamespace, seq: run_eval.Sequence, family: str, instance: str) -> list[dict]:
    i = seq.k
    stem = f"{family}-{instance}"
    try:
        seq.start_daemon()
        t = ev.Trial(arm="F", sequence=i, position=0, family=family, instance=instance, role="seed")
        seed = seq.trial(t)
        subprocess.run([str(r.strive), "stop"], cwd=seq.root, env=seq.env, capture_output=True, timeout=60)
        snap = seq.root / "snap"
        # The socket and pid files are the stopped daemon's.
        shutil.copytree(seq.home, snap / "h", ignore=shutil.ignore_patterns("run"))
        shutil.copytree(seq.ws, snap / "tally")
        out = [{"type": "seed", "family": family, "instance": instance, "passed": seed["passed"],
                "cost_usd": seed["cost_usd"], "session": seed["session"]}]
        for rep in range(r.args.reps):
            # Alternate which host goes first, so neither always runs on a warmer API.
            for name, host in (r.hosts if rep % 2 == 0 else r.hosts[::-1]):
                for d, src in ((seq.home, snap / "h"), (seq.ws, snap / "tally")):
                    shutil.rmtree(d)
                    shutil.copytree(src, d)
                seq.env["STRIVE_HOST"] = f"bun {host}/packages/host/src/main.ts"
                seq.learning_seen = 0
                seq.start_daemon()
                learned = seq.learn(seed["session"], f"{stem}-{name}-{rep}")
                texts = proposal_texts(seq, {p["id"] for p in learned["proposals"]})
                # Which learner prompt ran: the revised one names "a standing rule the user stated".
                revised = "standing rule the user stated" in first_request(
                    seq, r.out / "journals" / f"{stem}-{name}-{rep}.learner.jsonl")
                subprocess.run([str(r.strive), "stop"], cwd=seq.root, env=seq.env, capture_output=True, timeout=60)
                props = [{**p, "change": texts.get(p["id"], "")} for p in learned["proposals"]]
                hit = any(re.search(RULE_TERMS[family], p["change"] + " " + (p["summary"] or "")) for p in props)
                out.append({"type": "learn", "family": family, "instance": instance, "host": name, "rep": rep,
                            "cost_usd": learned["cost_usd"], "model_ok": learned["model_ok"],
                            "turn_end": learned["turn_end"], "proposals": props, "rule_proposed": hit,
                            "revised_prompt": revised})
                print(f"{stem:30} {name:8} rep {rep}  {len(props)} proposed  rule {'yes' if hit else 'no '}"
                      f"  ${learned['cost_usd']:.4f}  revised prompt {'yes' if revised else 'no'}", flush=True)
                if not learned["model_ok"]:
                    raise run_eval.RunFailed(f"{stem}: the learner used a model other than {r.model}")
        return out
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
    p.add_argument("--yes", action="store_true")
    a = p.parse_args()
    hosts = [(n, str(Path(d).resolve())) for n, d in (h.split("=", 1) for h in a.host)]
    # Each learner run is about $0.03-0.06 (the eval's L arm); each seed about $0.05.
    estimate = len(SEEDS) * (0.05 + a.reps * len(hosts) * 0.05)
    print(f"{len(SEEDS)} seeds x {a.reps} reps x {len(hosts)} hosts; about ${estimate:.2f}, capped at ${a.max_usd}")
    if not a.yes:
        print("not running: this spends real money; add --yes", file=sys.stderr)
        return 2
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "journals").mkdir(exist_ok=True)
    (a.out / "strive").mkdir(exist_ok=True)
    args = SimpleNamespace(learner_budget=4.0, turn_seconds=600, task_budget=0.4, keep_learner_host=False, reps=a.reps)
    r = SimpleNamespace(model=a.model, args=args, strive=a.strive.resolve(), out=a.out, hosts=hosts, spent=0.0,
                        pinned=lambda m: m == a.model or m.startswith(a.model + "-"), write=lambda rec: None)
    results = a.out / "results.jsonl"
    # Each sequence copies the suite into its vault, so before the suite is locked.
    seqs = [run_eval.Sequence(r, "F", i) for i in range(len(SEEDS))]
    with ev.SuiteLock(), ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(probe, r, seq, f, inst) for seq, (f, inst) in zip(seqs, SEEDS)]
        for fut in futures:
            try:
                recs = fut.result()
            except run_eval.RunFailed as e:
                print(f"failed: {e}", file=sys.stderr)
                continue
            with results.open("a") as f:
                for rec in recs:
                    f.write(json.dumps(rec) + "\n")
            r.spent += sum(rec["cost_usd"] or 0 for rec in recs)
            if r.spent > a.max_usd:
                print(f"stopping: ${r.spent:.2f} spent", file=sys.stderr)
                for other in futures:
                    other.cancel()
    summarize(results)
    return 0


def summarize(results: Path) -> None:
    recs = [json.loads(line) for line in results.read_text().splitlines() if line.strip()]
    learns = [x for x in recs if x["type"] == "learn"]
    hosts = sorted({x["host"] for x in learns})
    print(f"\n{'seed':30}" + "".join(f"{h:>14}" for h in hosts))
    for f, inst in SEEDS:
        row = [x for x in learns if x["family"] == f and x["instance"] == inst]
        cells = [f"{sum(x['rule_proposed'] for x in row if x['host'] == h)}/{sum(x['host'] == h for x in row)}"
                 f" ({sum(len(x['proposals']) for x in row if x['host'] == h)})" for h in hosts]
        print(f"{f + '/' + inst:30}" + "".join(f"{c:>14}" for c in cells))
    print("cells: runs proposing the seed's rule / runs (all proposals made)")
    print(f"spent: ${sum(x['cost_usd'] or 0 for x in recs):.2f}")


if __name__ == "__main__":
    sys.exit(main())

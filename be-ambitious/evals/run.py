"""Run the be-ambitious evals against the free OpenCode DeepSeek model.

Stages (each resumable; results append to results/*.jsonl):
  gen      : 10 tasks x 3 conditions x N samples
  rubric   : blind binary rubric grading of every generation
  pairwise : baseline vs skill_full, both presentation orders
  trigger  : would the model load the skill, given a skill list and a query?

Usage: python3 run.py [gen|rubric|pairwise|trigger|all] [--samples N] [--workers K]
"""

import argparse
import json
import random
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from cases import DISTRACTOR_SKILLS, RUBRIC, RUBRIC_EXTRA, TASKS, TRIGGER_QUERIES, USER_TEMPLATE
from llm import ask

HERE = Path(__file__).parent
SKILL = HERE.parent / "be-ambitious"
RESULTS = HERE / "results"
RESULTS.mkdir(exist_ok=True)
_lock = threading.Lock()


def load_jsonl(name):
    p = RESULTS / name
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def append(name, row):
    with _lock, open(RESULTS / name, "a") as f:
        f.write(json.dumps(row) + "\n")


def skill_text(full: bool) -> str:
    parts = [f"=== be-ambitious/SKILL.md ===\n{(SKILL / 'SKILL.md').read_text()}"]
    if full:
        for sub in ("references", "assets"):
            for p in sorted((SKILL / sub).glob("*.md")):
                parts.append(f"=== be-ambitious/{sub}/{p.name} ===\n{p.read_text()}")
    return "\n\n".join(parts)


def gen_prompt(cond: str, task: str) -> str:
    user = USER_TEMPLATE.format(task=task)
    if cond == "baseline":
        return user
    if cond == "baseline_long":  # length control: same ask, matched verbosity
        return user + " Be thorough and detailed; aim for roughly 800 words."
    return (
        "You have the agent skill `be-ambitious` loaded. Its files are below; follow the skill (Advise mode).\n\n"
        f"{skill_text(full=cond.startswith('skill_full'))}\n\n=== USER MESSAGE ===\n{user}"
    )


def extract_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"no JSON in: {text[:200]}")
    return json.loads(m.group(0))


def run_pool(jobs, fn, workers):
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(fn, j): j for j in jobs}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                f.result()
            except Exception as e:  # keep going; failed jobs are retried on rerun
                print(f"  job {futs[f]} failed: {e}", file=sys.stderr)
            if i % 10 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)}", flush=True)


# ---------- stages ----------

CONDS = ["baseline", "skill_body", "skill_full"]
# *_v2 conditions use the same code path; they exist so v2 generations of the
# (edited) skill are stored separately from the v1 rows already on disk.


def stage_gen(samples, workers, conds=CONDS):
    done = {(r["task"], r["cond"], r["sample"]) for r in load_jsonl("gen.jsonl")}
    jobs = [(t, c, s) for t in TASKS for c in conds for s in range(samples) if (t, c, s) not in done]
    print(f"gen: {len(jobs)} to run")

    def go(job):
        t, c, s = job
        r = ask(gen_prompt(c, TASKS[t]))
        append("gen.jsonl", {"task": t, "cond": c, "sample": s, "text": r["text"],
                             "words": len(r["text"].split()), "tokens": r["tokens"],
                             "tool_calls": r["tool_calls"], "cost": r["cost"]})

    run_pool(jobs, go, workers)


RUBRIC_PROMPT = """You are grading a response that tries to help a user be more ambitious with a request they planned to give an AI model.

USER'S ORIGINAL REQUEST:
{task}

RESPONSE TO GRADE:
<<<
{response}
>>>

For each criterion below, answer 1 if the response clearly satisfies it, else 0. Be strict: partial or generic gestures score 0.

{criteria}

Reply with ONLY a JSON object mapping each criterion id to 0 or 1, e.g. {{"<id>": 1, ...}}. Do not use tools."""


def stage_rubric(workers):
    gens = load_jsonl("gen.jsonl")
    done = {(r["task"], r["cond"], r["sample"]) for r in load_jsonl("rubric.jsonl")}
    jobs = [g for g in gens if (g["task"], g["cond"], g["sample"]) not in done]
    criteria = "\n".join(f"- {k}: {v}" for k, v in RUBRIC.items())
    print(f"rubric: {len(jobs)} to grade")

    def go(g):
        p = RUBRIC_PROMPT.format(task=TASKS[g["task"]], response=g["text"], criteria=criteria)
        scores = extract_json(ask(p)["text"])
        scores = {k: int(bool(scores.get(k, 0))) for k in RUBRIC}
        append("rubric.jsonl", {"task": g["task"], "cond": g["cond"], "sample": g["sample"], "scores": scores})

    run_pool(jobs, go, workers)


PAIR_PROMPT = """A user planned to ask an AI model: "{task}"
They asked for help being more ambitious. Two assistants answered.

=== RESPONSE A ===
{a}

=== RESPONSE B ===
{b}

Which response would lead the user to get substantially more valuable, more ambitious, yet still achievable results from an AI model? Ignore length and formatting polish; judge the substance of what it would have the user ask for and how verifiable it is.
Reply with ONLY a JSON object: {{"winner": "A" or "B" or "tie", "reason": "<one sentence>"}}. Do not use tools."""


def stage_pairwise(workers, base="baseline", cond_b="skill_full"):
    gens = {(g["task"], g["cond"], g["sample"]): g for g in load_jsonl("gen.jsonl")}
    done = {(r["task"], r["sample"], r["order"]) for r in load_jsonl("pairwise.jsonl")
            if r["cond_b"] == cond_b and r.get("base", "baseline") == base}
    jobs = []
    for (t, c, s), g in gens.items():
        if c != base or (t, cond_b, s) not in gens:
            continue
        for order in ("base_first", "skill_first"):
            if (t, s, order) not in done:
                jobs.append((t, s, order))
    print(f"pairwise {base} vs {cond_b}: {len(jobs)} to judge")

    def go(job):
        t, s, order = job
        bt, sk = gens[(t, base, s)]["text"], gens[(t, cond_b, s)]["text"]
        a, b = (bt, sk) if order == "base_first" else (sk, bt)
        v = extract_json(ask(PAIR_PROMPT.format(task=TASKS[t], a=a, b=b))["text"])
        w = str(v.get("winner", "tie")).strip().upper()
        winner = "tie" if w not in ("A", "B") else (
            (base if w == "A" else cond_b) if order == "base_first" else (cond_b if w == "A" else base))
        append("pairwise.jsonl", {"task": t, "sample": s, "order": order, "base": base, "cond_b": cond_b,
                                  "winner": winner, "reason": v.get("reason", "")})

    run_pool(jobs, go, workers)


def stage_rubric_extra(workers):
    """Grade the post-hoc criteria (RUBRIC_EXTRA) on every generation, all conditions alike."""
    gens = load_jsonl("gen.jsonl")
    done = {(r["task"], r["cond"], r["sample"]) for r in load_jsonl("rubric_extra.jsonl")}
    jobs = [g for g in gens if (g["task"], g["cond"], g["sample"]) not in done]
    criteria = "\n".join(f"- {k}: {v}" for k, v in RUBRIC_EXTRA.items())
    print(f"rubric_extra: {len(jobs)} to grade")

    def go(g):
        p = RUBRIC_PROMPT.format(task=TASKS[g["task"]], response=g["text"], criteria=criteria)
        scores = extract_json(ask(p)["text"])
        scores = {k: int(bool(scores.get(k, 0))) for k in RUBRIC_EXTRA}
        append("rubric_extra.jsonl", {"task": g["task"], "cond": g["cond"], "sample": g["sample"], "scores": scores})

    run_pool(jobs, go, workers)


TRIGGER_PROMPT = """You are an agent with these skills available. Each skill's full instructions load only if you choose it.

{skills}

User message: "{query}"

Which single skill, if any, would you load before responding? Reply with ONLY a JSON object: {{"skill": "<skill name or none>"}}. Do not use tools."""


def stage_trigger(samples, workers):
    desc = re.search(r"^description: (.*)$", (SKILL / "SKILL.md").read_text(), re.M).group(1)
    done = {(r["qi"], r["sample"]) for r in load_jsonl("trigger.jsonl")}
    jobs = [(qi, s) for qi in range(len(TRIGGER_QUERIES)) for s in range(samples) if (qi, s) not in done]
    print(f"trigger: {len(jobs)} to run")

    def go(job):
        qi, s = job
        skills = list(DISTRACTOR_SKILLS.items()) + [("be-ambitious", desc)]
        random.Random(qi * 100 + s).shuffle(skills)  # vary position deterministically
        listing = "\n".join(f"- {n}: {d}" for n, d in skills)
        q, expected = TRIGGER_QUERIES[qi]
        chose = str(extract_json(ask(TRIGGER_PROMPT.format(skills=listing, query=q))["text"]).get("skill", "none"))
        append("trigger.jsonl", {"qi": qi, "sample": s, "query": q, "expected": expected,
                                 "chose": chose, "fired": chose.strip().lower() == "be-ambitious"})

    run_pool(jobs, go, workers)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["gen", "rubric", "rubric_extra", "pairwise", "trigger", "all"])
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--conds", default=",".join(CONDS), help="conditions for gen")
    ap.add_argument("--vs", default="skill_full", help="pairwise: condition compared against --base")
    ap.add_argument("--base", default="baseline", help="pairwise: reference condition")
    a = ap.parse_args()
    if a.stage in ("gen", "all"):
        stage_gen(a.samples, a.workers, a.conds.split(","))
    if a.stage in ("rubric", "all"):
        stage_rubric(a.workers)
    if a.stage in ("rubric_extra", "all"):
        stage_rubric_extra(a.workers)
    if a.stage in ("pairwise", "all"):
        stage_pairwise(a.workers, a.base, a.vs)
    if a.stage in ("trigger", "all"):
        stage_trigger(a.samples, a.workers)

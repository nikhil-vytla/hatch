"""Collect the Persona Cartography paper's own evals of the Qwen3-8B OCEAN adapters into one table.

Each adapter folder holds inspect-ai logs per scale ("base", "lora_+0p50x", ...): MMLU (300 questions, accuracy) and
a trait log-prob MCQ (1,500 items) that reports a score for all five traits, so every run also shows cross-trait
side effects. The newest log per folder is used.

  python analysis/persona/paper_evals.py OUT.csv
"""
import csv, json, re, sys
from collections import defaultdict

from huggingface_hub import HfApi, hf_hub_download

R = "persona-cartography/monorepo"
ROOT = re.compile(r"fine_tuning/qwen-3-8b-it/(?:ocean/(\w+)/(amplifier|suppressor)|other/(ocean_def_control)/amplifier)/"
                  r"[^/]+/evals/mcq/(mmlu|trait_logprobs)/[^/]+/(base|lora_[+-]\d+p\d+x)/[^/]+/native/inspect_logs/([^/]+\.json)$")


def scale_of(tag):
    if tag == "base":
        return 0.0
    m = re.match(r"lora_([+-])(\d+)p(\d+)x", tag)
    return (1 if m.group(1) == "+" else -1) * float(f"{m.group(2)}.{m.group(3)}")


def main(out):
    files = HfApi().list_repo_files(R, repo_type="dataset")
    newest = {}
    for f in files:
        m = ROOT.search(f)
        if not m:
            continue
        trait, direction, ctrl, ev, tag, name = m.groups()
        key = (trait or "control", direction or "control", ev, scale_of(tag))
        if key not in newest or name > newest[key][1]:
            newest[key] = (f, name)
    rows = []
    for (trait, direction, ev, scale), (f, _) in sorted(newest.items()):
        d = json.load(open(hf_hub_download(R, f, repo_type="dataset")))
        res = d.get("results") or {}
        for sc in res.get("scores", []):
            for metric, v in sc.get("metrics", {}).items():
                if metric.startswith("_") or metric == "stderr":
                    continue
                rows.append(dict(trait=trait, direction=direction, eval=ev, scale=scale, metric=metric,
                                 value=v.get("value"), n_samples=res.get("completed_samples"), log_file=f))
        print(f"{trait:17s} {direction:10s} {ev:15s} {scale:+.2f} done", flush=True)
    with open(out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)
    piv = defaultdict(dict)
    for r in rows:
        if r["eval"] == "mmlu" or r["metric"].lower() == r["trait"]:
            piv[(r["trait"], r["direction"], r["eval"])][r["scale"]] = r["value"]
    for k, v in sorted(piv.items()):
        print(k, {s: round(x, 3) for s, x in sorted(v.items())})


if __name__ == "__main__":
    main(sys.argv[1])

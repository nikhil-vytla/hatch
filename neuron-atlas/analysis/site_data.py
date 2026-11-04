"""Compact JSON files for the prototype pages (explorer/protos/), built from the Hub dataset plus local results.

  python analysis/site_data.py SCRATCH OUT_DIR
SCRATCH holds the local analysis outputs (lvp_*.json, pairs_judged.json, imitation_out.parquet, ...);
OUT_DIR gets vision.json, janus.json, lenses.json, identity.json.
"""
import json, os, re, sys
import duckdb
from huggingface_hub import hf_hub_download

R = "nikhilxvytla/neuron-atlas"
DIRS = ("up", "down", "left", "right", "up-left", "up-right", "down-left", "down-right")


def hub(path):
    return hf_hub_download(R, path, repo_type="dataset")


def answer_ok(kind, expected, text):
    t = (text or "").lower()
    if kind == "direction":  # the first direction phrase in the reply decides ("upwards", "top-left", "up and to the left")
        t = re.sub(r"\b(up|down)wards?\b", r"\1", t).replace("top", "up").replace("bottom", "down")
        m = re.search(r"\b(up|down|left|right)\b(?:(?:[- ]| and to the )(left|right)\b)?", t)
        if not m:
            return None
        return (m.group(1) + ("-" + m.group(2) if m.group(2) else "")) == expected
    if kind == "photo":
        return None
    if kind in ("count",):
        words = {"1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven"}
        return expected in re.findall(r"\d+", t) or words.get(expected, "#") in t
    return expected.lower() in t if expected else None


def vision(out):
    stim = json.load(open(hub("stimuli/stimuli.json")))
    meta = {s["id"]: s for s in stim}
    res = {"stimuli": stim, "runs": {}}
    for run, path in (("llm", "Qwen__Qwen2.5-VL-3B-Instruct/vlm_llm/vlm.parquet"),
                      ("vision", "Qwen__Qwen2.5-VL-3B-Instruct/vlm_vision15/vlm.parquet")):
        rows = duckdb.sql(f"select id, layer, neuron, dose, text from '{hub(path)}' order by id, layer, neuron, dose").fetchall()
        by = {}
        for sid, L, n, d, text in rows:
            if sid not in meta:
                continue
            s = meta[sid]
            e = by.setdefault(sid, {"base": None, "pushes": []})
            ok = answer_ok(s["kind"], s.get("expected", ""), text)
            if L < 0 or d == 0:
                e["base"] = {"text": text, "ok": ok}
            else:
                e["pushes"].append([int(L), int(n), round(float(d), 2), text, ok])
        res["runs"][run] = by
    json.dump(res, open(os.path.join(out, "vision.json"), "w"), separators=(",", ":"))


def janus(out):
    rows = duckdb.sql(f"select prompt, layer, neuron, dose, file from '{hub('deepseek-community__Janus-Pro-1B/gen_small/gen/index.parquet')}'").fetchall()
    base = f"https://huggingface.co/datasets/{R}/resolve/main/deepseek-community__Janus-Pro-1B/gen_small/gen/"
    json.dump({"base": base, "rows": [[p, int(L), int(n), round(float(d), 2), f] for p, L, n, d, f in rows]},
              open(os.path.join(out, "janus.json"), "w"), separators=(",", ":"))


def lenses(scratch, out):
    models = {"Qwen3.5-4B": "lvp_full.json", "Qwen3-8B": "lvp_8b.json", "SmolLM2-135M": "lvp_smol2.json",
              "Qwen3-0.6B": "lvp_06.json", "GPT-2": "lvp_g2.json", "R1-Distill-1.5B": "lvp_r1.json"}
    res = {"says_vs_does": {}, "become": {}}
    for name, f in models.items():
        p = os.path.join(scratch, f)
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        res["says_vs_does"][name] = {"summary": d["summary"], "by_layer": {L: {k: {x: round(v[x], 4) for x in ("hit", "null", "opposite")}
                                                                             for k, v in r.items()} for L, r in d["by_layer"].items()}}
    for name, f in (("Qwen3.5-4B", "lens_guided_eval.json"), ("SmolLM2-135M", "smol_lg_eval.json"), ("Qwen3-8B", "lg8b_eval.json")):
        p = os.path.join(scratch, f)
        if os.path.exists(p):
            d = json.load(open(p))
            res["become"][name] = {"summary": d["summary"],
                                   "examples": [{k: i[k] for k in ("name", "concept", "lens", "layer", "text", "becomes")} for i in d["items"] if i["becomes"]][:400]}
    json.dump(res, open(os.path.join(out, "lenses.json"), "w"), separators=(",", ":"))


def identity(scratch, out):
    res = {"layers": {}, "pairs": [], "imitation": [], "era": {}, "collapse": []}
    for name, slug in (("Qwen3.5-4B", "Qwen__Qwen3.5-4B"), ("Qwen3-8B", "Qwen__Qwen3-8B"), ("SmolLM2-135M", "HuggingFaceTB__SmolLM2-135M-Instruct"),
                       ("Qwen3-0.6B", "Qwen__Qwen3-0.6B")):
        for side, f in (("model", "sweep_stats.parquet"), ("user", "user_sweep_stats.parquet")):
            try:
                rows = duckdb.sql(f"select layer, reply_kind, sum(n_est) from '{hub(slug + '/' + f)}' group by 1, 2 order by 1").fetchall()
            except Exception:
                continue
            tab = {}
            for L, k, v in rows:
                tab.setdefault(int(L), {})[k] = float(v)
            res["layers"].setdefault(name, {})[side] = {L: {k: round(v / sum(t.values()), 4) for k, v in t.items()} for L, t in tab.items()}
    for name, d in (("Qwen3-0.6B raw", "pub_raw_q06"), ("Qwen3-0.6B-Base raw", "pub_raw_q06b")):
        p = os.path.join(scratch, d, "sweep_stats.parquet")
        if os.path.exists(p):
            tab = {}
            for L, k, v in duckdb.sql(f"select layer, reply_kind, sum(n_est) from '{p}' group by 1, 2").fetchall():
                tab.setdefault(int(L), {})[k] = float(v)
            res["layers"].setdefault(name, {})["model"] = {L: {k: round(v / sum(t.values()), 4) for k, v in t.items()} for L, t in tab.items()}
    p = os.path.join(scratch, "pairs_judged.json")
    if os.path.exists(p):
        res["pairs"] = [{k: x[k] for k in ("scale", "a", "b", "ta", "tb", "alone_a", "alone_b", "reply", "outcome", "who")} for x in json.load(open(p))]
    p = os.path.join(scratch, "imitation_out.parquet")
    if os.path.exists(p):
        res["imitation"] = duckdb.sql(f"select layer, neuron, dose, who, theme, push_text, you_are_text, roleplay_text, you_are_cos_L31, roleplay_cos_L31 from '{p}'").df().to_dict("records")
    era = os.path.join(scratch, "era")
    if os.path.isdir(era):
        years, places = {}, []
        for L, n, d, p_, t in duckdb.sql(f"select layer, neuron, dose, prompt, text from read_parquet('{era}/L*.parquet')").fetchall():
            if p_ == 0:
                m = re.search(r"\b(1[0-9]{3}|20[0-9]{2}|2[1-9][0-9]{2})\b", t or "")
                y = int(m.group(1)) if m else None
                years[str(y)] = years.get(str(y), 0) + 1
            elif t and re.search(r"\b(located in|I am in|I'm in|I live in|at home|sitting)\b", t, re.I) and not re.search(r"data cent|server|cloud|digital|virtual", t, re.I):
                places.append([int(L), int(n), round(float(d), 1), t[:160]])
        res["era"] = {"years": years, "places": places[:300]}
    p = os.path.join(scratch, "dlg_judge", "dialogue_judged.parquet")
    if os.path.exists(p):
        res["collapse"] = duckdb.sql(f"""select split_part(name, ':', 1) kind, opener, turn, avg(persona_present::int) present,
            avg(coherent::int) coherent, count(*) n from '{p}' where name <> 'baseline' group by all order by all""").df().to_dict("records")
    json.dump(res, open(os.path.join(out, "identity.json"), "w"), separators=(",", ":"), default=str)


if __name__ == "__main__":
    scratch, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    vision(out); janus(out); lenses(scratch, out); identity(scratch, out)
    for f in sorted(os.listdir(out)):
        print(f, os.path.getsize(os.path.join(out, f)) // 1024, "KB")

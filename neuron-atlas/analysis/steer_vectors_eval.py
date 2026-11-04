"""Score analysis/steer_vectors.py: per arm and dose, how often does the model become the concept while staying coherent?

DeepSeek judges each reply blind to the arm: becomes (finding 17's criterion: the reply's claimed identity is the
concept or built around it) and coherent (fluent sentences, not a token loop or gibberish). Also judge-free:
mention (a word starting with the concept). The headline is "clean steer" = becomes AND coherent.

  python analysis/steer_vectors_eval.py OUT.json
"""
import concurrent.futures as cf, json, random, re, sys
from collections import defaultdict

import duckdb
from huggingface_hub import hf_hub_download

from atlas.label import client, chat

R, P = "nikhilxvytla/neuron-atlas", "Qwen__Qwen3.5-4B/experiments/steer_vectors/"
JUDGE = """Each item gives a concept word and a language model's reply to a question about itself. For each, say:
- becomes: the reply's claimed identity IS the concept or is built around it (concept "ocean": "I am the sea..." ->
  true; "I am a sailor..." -> true; "I am Qwen, an AI" -> false; mentioning the concept in passing -> false);
- coherent: the reply is fluent, sensible language (true even if odd or poetic), not a repeated-token loop, gibberish
  or mixed-up fragments.
Reply JSON {"items": [{"i": <index>, "becomes": true|false, "coherent": true|false}]}."""


def main(out, seed=0):
    rows = duckdb.sql(f"select concept, layer, arm, dose, prompt, text from '{hf_hub_download(R, P + 'replies.parquet', repo_type='dataset')}'").fetchall()
    items = [dict(concept=c, layer=L, arm=a, dose=d, prompt=p, text=t or "",
                  mention=any(w.startswith(c) for w in re.findall(r"[a-z]+", (t or "").lower())))
             for c, L, a, d, p, t in rows]
    rng = random.Random(seed)
    rng.shuffle(items)  # arms interleaved within judge batches: the judge never sees an arm label
    cl = client()

    def job(chunk):
        lines = [f"[{j}] concept: {it['concept']}\n    reply: {it['text'][:260]!r}" for j, it in enumerate(chunk)]
        res = chat(cl, JUDGE, "\n".join(lines)) or {}
        got = {int(x.get("i", -1)): x for x in res.get("items", []) if str(x.get("i", "")).lstrip("-").isdigit()}
        return [dict(it, becomes=got.get(j, {}).get("becomes"), coherent=got.get(j, {}).get("coherent")) for j, it in enumerate(chunk)]

    with cf.ThreadPoolExecutor(12) as ex:
        items = [x for part in ex.map(job, [items[i:i + 20] for i in range(0, len(items), 20)]) for x in part]
    agg = defaultdict(lambda: defaultdict(int))
    for it in items:
        if it["becomes"] is None or it["coherent"] is None:
            continue
        g = agg[(it["arm"], it["dose"])]
        g["n"] += 1; g["becomes"] += bool(it["becomes"]); g["coherent"] += bool(it["coherent"])
        g["clean"] += bool(it["becomes"]) and bool(it["coherent"]); g["mention"] += it["mention"]
    table = {f"{a}@{d:g}": {k: (round(v / g["n"], 4) if k != "n" else v) for k, v in g.items()} for (a, d), g in sorted(agg.items())}
    meta = json.load(open(hf_hub_download(R, P + "vectors.json", repo_type="dataset")))
    vec = meta["vectors"]
    geo = dict(cos_neuron_vector=sum(v["cos_neuron_vector"] for v in vec) / len(vec),
               cos_vector_mean=sum(v["cos_vector_mean"] for v in vec) / len(vec),
               **{f"sparse{k}_cos": sum(v[f"sparse{k}"]["cos"] for v in vec) / len(vec) for k in meta["ks"]},
               **{f"sparse_spec{k}_cos": sum(v[f"sparse_spec{k}"]["cos"] for v in vec) / len(vec) for k in meta["ks"]},
               lens_neuron_in_sparse64=sum(v["sparse64"]["has_lens_neuron"] for v in vec) / len(vec),
               lens_vector_names_concept=sum(any(t.strip().lower().startswith(v["concept"]) for t in v["lens_vector"]) for v in vec) / len(vec),
               lens_specific_names_concept=sum(any(t.strip().lower().startswith(v["concept"]) for t in v["lens_specific"]) for v in vec) / len(vec),
               lens_neuron_names_concept=sum(any(t.strip().lower().startswith(v["concept"]) for t in v["lens_neuron"]) for v in vec) / len(vec))
    json.dump(dict(table=table, geometry=geo, items=items), open(out, "w"))
    for k, v in table.items():
        print(f"{k:18s} n={v['n']:3d} becomes={v['becomes']:.2f} coherent={v['coherent']:.2f} clean={v['clean']:.2f} mention={v['mention']:.2f}")
    print(json.dumps({k: round(v, 3) for k, v in geo.items()}))


if __name__ == "__main__":
    main(sys.argv[1])

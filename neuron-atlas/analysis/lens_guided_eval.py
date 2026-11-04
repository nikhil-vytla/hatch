"""Score lens-guided pushes: does a neuron chosen for saying CONCEPT make the model mention or become CONCEPT?

  python analysis/lens_guided_eval.py LENS_GUIDED.parquet LENS_KEY.json OUT.json
mention = the reply contains a word starting with the concept (cat -> cats, catlike); for random controls the concept is
drawn from the same concept list, so their rate is the chance level. becomes = a DeepSeek judge says the reply's
self-identity is the concept or closely tied to it.
"""
import concurrent.futures as cf, json, random, re, sys
import pyarrow.parquet as pq
from atlas.label import client, chat

JUDGE = """Each item gives a concept word and a language model's reply to a question about itself. Say whether the
reply's claimed identity IS the concept or is built around it (e.g. concept "ocean": "I am the sea..." -> true;
"I am a sailor..." -> true; "I am Qwen, an AI" -> false; a reply merely mentioning the concept in passing -> false).
Reply JSON {"items": [{"i": <index>, "becomes": true|false}]}."""


def main(path, key_path, out, seed=0):
    rows = pq.read_table(path).to_pylist()
    key = {k["name"]: k for k in json.load(open(key_path))}
    concepts = sorted({k["concept"] for k in key.values() if k["concept"]})
    rng = random.Random(seed)
    items = []
    for r in rows:
        k = key.get(r["name"])
        if not k:
            continue
        concept = k["concept"] or rng.choice(concepts)
        words = re.findall(r"[a-z]+", (r["text"] or "").lower())
        items.append(dict(name=r["name"], lens=k["lens"], concept=concept, layer=k["layer"], prompt=r["prompt"],
                          text=r["text"], mention=any(w.startswith(concept) for w in words)))
    cl = client()

    def job(chunk):
        lines = [f"[{j}] concept: {it['concept']}\n    reply: {it['text'][:260]!r}" for j, it in enumerate(chunk)]
        res = chat(cl, JUDGE, "\n".join(lines)) or {}
        got = {int(x.get("i", -1)): x for x in res.get("items", []) if str(x.get("i", "")).lstrip("-").isdigit()}
        return [dict(it, becomes=bool(got.get(j, {}).get("becomes"))) for j, it in enumerate(chunk)]

    chunks = [items[i:i + 20] for i in range(0, len(items), 20)]
    with cf.ThreadPoolExecutor(8) as ex:
        items = [x for part in ex.map(job, chunks) for x in part]
    summary = {}
    for lens in sorted({i["lens"] for i in items}):
        for band, lo, hi in (("all", 0, 99), ("L8-19", 8, 19), ("L20-31", 20, 99)):
            sub = [i for i in items if i["lens"] == lens and lo <= i["layer"] <= hi]
            if sub:
                summary[f"{lens}/{band}"] = dict(n=len(sub), mention=round(sum(i["mention"] for i in sub) / len(sub), 3),
                                                 becomes=round(sum(i["becomes"] for i in sub) / len(sub), 3))
    print(json.dumps(summary, indent=1))
    json.dump(dict(summary=summary, items=items), open(out, "w"), indent=0)


if __name__ == "__main__":
    main(*sys.argv[1:4])

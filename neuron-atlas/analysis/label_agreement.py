"""Do two independent labelers describe the same Qwen3-8B neurons alike? Ours (DeepSeek, from top activations) vs
neuron-lens (stdlogits, Claude, from activations + lens reads; CC BY 4.0). A DeepSeek judge rates each pair same /
related / different; a shuffled pairing gives the chance rate.

  python analysis/label_agreement.py OUT.json
"""
import concurrent.futures as cf, json, random, sys
import duckdb, pyarrow.parquet as pq
from huggingface_hub import HfFileSystem, hf_hub_download
from atlas.label import client, chat

SYS = """Two labelers described what makes the same language-model neuron fire. For each item say whether the two
descriptions name the same behaviour (same), overlapping or partly the same (related), or unrelated (different).
Reply JSON {"items": [{"i": <index>, "verdict": "same"|"related"|"different"}]}."""


def main(out, seed=0):
    ours = duckdb.sql(f"select layer, neuron, label, description from '{hf_hub_download('nikhilxvytla/neuron-atlas', 'Qwen__Qwen3-8B/labels.parquet', repo_type='dataset')}'").fetchall()
    fs = HfFileSystem(); theirs = {}
    for L in sorted({r[0] for r in ours}):
        with fs.open(f"datasets/stdlogits/neuron-lens/qwen3-8b/neurons/labels/L{L:02d}.parquet", "rb") as f:
            t = pq.read_table(f, columns=["neuron", "pole", "fires", "fires_conf"]).to_pydict()
        for n, p, fi, c in zip(t["neuron"], t["pole"], t["fires"], t["fires_conf"]):
            if p > 0:
                theirs[(L, int(n))] = (fi, c)
    items = [dict(layer=L, neuron=n, ours=f"{lab}: {d or ''}"[:220], theirs=theirs[(L, n)][0], conf=theirs[(L, n)][1])
             for L, n, lab, d in ours if (L, n) in theirs]
    rng = random.Random(seed); shuffled = [i["theirs"] for i in items]; rng.shuffle(shuffled)
    jobs = [dict(i, kind="matched") for i in items] + [dict(i, theirs=s, kind="shuffled") for i, s in zip(items, shuffled)]
    cl = client()

    def run(chunk):
        res = chat(cl, SYS, "\n".join(f"[{j}] A: {x['ours']!r}\n    B: {x['theirs']!r}" for j, x in enumerate(chunk))) or {}
        got = {int(x.get("i", -1)): x.get("verdict") for x in res.get("items", []) if str(x.get("i", "")).lstrip("-").isdigit()}
        return [dict(x, verdict=got.get(j)) for j, x in enumerate(chunk)]

    with cf.ThreadPoolExecutor(8) as ex:
        done = [x for part in ex.map(run, [jobs[k:k + 20] for k in range(0, len(jobs), 20)]) for x in part]
    summ = {}
    for kind in ("matched", "shuffled"):
        sub = [x for x in done if x["kind"] == kind and x["verdict"]]
        summ[kind] = {v: round(sum(x["verdict"] == v for x in sub) / len(sub), 3) for v in ("same", "related", "different")} | {"n": len(sub)}
    hi = [x for x in done if x["kind"] == "matched" and x["verdict"] and x["conf"] >= 0.7]
    summ["matched_their_conf>=0.7"] = {v: round(sum(x["verdict"] == v for x in hi) / max(len(hi), 1), 3) for v in ("same", "related", "different")} | {"n": len(hi)}
    print(json.dumps(summ, indent=1))
    json.dump(dict(summary=summ, items=done), open(out, "w"), indent=0)


if __name__ == "__main__":
    main(sys.argv[1])

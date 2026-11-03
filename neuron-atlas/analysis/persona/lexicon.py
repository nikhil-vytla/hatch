"""Big Five words at a neuron's two poles: which Qwen3-8B neurons' J-lens readouts name a trait, and are poles antonyms?

For each neuron the J-lens gives two top-10 token lists: what pushing it up writes (up pole) and what pushing it down
writes (down pole). A pole "names" a trait end when one of its tokens matches a word of that end's adjective list
(token == word, the token is a 5+ letter prefix of the word, or the token starts with the word). Goodfire's
"already clean" essay argues the negative pole is a separate, often contrasting job; here the test is whether a
neuron whose up pole names one end of a trait has the OTHER end at its down pole more often than chance (down poles
of random other neurons with the same up-pole hit rate).

  python analysis/persona/lexicon.py JLENS_DIR OUT.json
"""
import json, os, random, sys
from collections import Counter

import pyarrow.parquet as pq

LEX = {
    "O": (["creative", "imaginative", "curious", "artistic", "inventive", "original", "philosophical", "intellectual",
           "innovative", "adventurous", "poetic", "wonder", "visionary", "explore", "dream"],
          ["conventional", "unimaginative", "uncreative", "routine", "traditional", "predictable", "ordinary",
           "mundane", "literal", "conservative", "dull", "boring", "plain"]),
    "C": (["organized", "careful", "thorough", "efficient", "systematic", "disciplined", "responsible", "reliable",
           "precise", "diligent", "meticulous", "orderly", "punctual", "dutiful", "planned"],
          ["careless", "disorganized", "sloppy", "lazy", "messy", "impulsive", "haphazard", "negligent", "forgetful",
           "chaotic", "reckless", "procrastinate", "lax"]),
    "E": (["outgoing", "talkative", "energetic", "enthusiastic", "sociable", "bold", "cheerful", "excited", "lively",
           "party", "assertive", "exciting", "vibrant", "loud", "extrovert"],
          ["quiet", "shy", "reserved", "withdrawn", "introverted", "solitary", "timid", "bashful", "silent", "lonely",
           "aloof", "introvert", "passive"]),
    "A": (["kind", "warm", "friendly", "cooperative", "sympathetic", "generous", "gentle", "compassionate", "polite",
           "considerate", "caring", "supportive", "trusting", "empathetic", "agreeable"],
          ["rude", "harsh", "cold", "hostile", "critical", "unkind", "selfish", "cruel", "aggressive", "stubborn",
           "arrogant", "dismissive", "contempt", "rude", "spiteful"]),
    "N": (["anxious", "worried", "nervous", "tense", "fearful", "insecure", "moody", "stressed", "panic", "afraid",
           "scared", "overwhelmed", "upset", "irritable", "uneasy", "worry"],
          ["calm", "relaxed", "stable", "secure", "confident", "composed", "peaceful", "serene", "steady",
           "unflappable", "content", "comfortable", "carefree", "resilient"]),
}


def norm(tok):
    t = tok.strip().lower()
    return t if t.isalpha() and len(t) >= 3 else ""


def matches(tok, word):
    return tok == word or (len(tok) >= 5 and word.startswith(tok)) or (len(word) >= 4 and tok.startswith(word))


def pole_hits(tokens):
    """{(trait, end): first matching word} for a pole's token list; end 0 = high, 1 = low."""
    toks = [t for t in (norm(x) for x in tokens) if t]
    out = {}
    for trait, ends in LEX.items():
        for e, words in enumerate(ends):
            for t in toks:
                w = next((w for w in words if matches(t, w)), None)
                if w:
                    out[(trait, e)] = w
                    break
    return out


def main(jdir, out, lens="j", seed=0):
    rows = []
    for f in sorted(os.listdir(jdir)):
        if not (f.startswith("L") and f.endswith(".parquet")):
            continue
        L = int(f[1:3])
        t = pq.read_table(os.path.join(jdir, f), columns=["neuron", f"{lens}_up", f"{lens}_down"]).to_pydict()
        for n, up, dn in zip(t["neuron"], t[f"{lens}_up"], t[f"{lens}_down"]):
            hu, hd = pole_hits(up), pole_hits(dn)
            if hu or hd:
                rows.append(dict(layer=L, neuron=n, up={f"{k[0]}{'+-'[k[1]]}": v for k, v in hu.items()},
                                 down={f"{k[0]}{'+-'[k[1]]}": v for k, v in hd.items()},
                                 up_tokens=[x.strip() for x in up], down_tokens=[x.strip() for x in dn]))
        print(f"L{L:02d}: {len(rows)} neurons with a trait word so far", flush=True)
    n_total = sum(pq.read_metadata(os.path.join(jdir, f)).num_rows for f in os.listdir(jdir) if f.startswith("L") and f.endswith(".parquet"))
    # bipolar test: up names trait end e, down names the opposite end
    rng = random.Random(seed)
    downs = [r["down"] for r in rows] + [{}] * (n_total - len(rows))  # neurons with no trait word have empty poles
    stats = {}
    for trait in LEX:
        for e in (0, 1):
            k_up, k_opp, k_same = f"{trait}{'+-'[e]}", f"{trait}{'+-'[1 - e]}", f"{trait}{'+-'[e]}"
            has = [r for r in rows if k_up in r["up"]]
            opp = sum(k_opp in r["down"] for r in has)
            same = sum(k_same in r["down"] for r in has)
            chance = [sum(k_opp in rng.choice(downs) for _ in has) for _ in range(200)]
            stats[k_up] = dict(n_up=len(has), down_opposite=opp, down_same=same,
                               chance_opposite=sum(chance) / len(chance) if has else 0.0)
    layers = Counter(r["layer"] for r in rows)
    res = dict(lens=lens, n_neurons=n_total, n_with_trait_word=len(rows), by_layer=dict(sorted(layers.items())),
               bipolar=stats, neurons=rows)
    json.dump(res, open(out, "w"))
    print(json.dumps({k: v for k, v in res.items() if k in ("n_neurons", "n_with_trait_word")}))
    for k, v in stats.items():
        print(f"up {k:3s}: {v['n_up']:5d} neurons | down names opposite end {v['down_opposite']:4d} "
              f"(chance {v['chance_opposite']:.1f}) | same end {v['down_same']:4d}")


if __name__ == "__main__":
    main(*sys.argv[1:3])

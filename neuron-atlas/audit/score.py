"""Score the blind human audit: human answers vs the stored DeepSeek labels, and human vs human.

Export the page's ratings (ArtifactData list of collection "ratings" with out_dir, or any dump of the docs) into a
folder of JSON files, each {"answers": {item_id: answer}}; then
  python audit/score.py RATINGS_DIR
"""
import glob, json, os, sys
from collections import Counter
from itertools import combinations

HERE = os.path.dirname(__file__)


def kappa(pairs):
    if not pairs:
        return None
    n = len(pairs); po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / n / n
    return round((po - pe) / (1 - pe), 3) if pe < 1 else 1.0


def main(d):
    key = json.load(open(os.path.join(HERE, "key_deepseek.json")))
    raters = [json.load(open(f)).get("answers", {}) for f in glob.glob(os.path.join(d, "**", "*.json"), recursive=True)]
    raters = [r for r in raters if r]
    norm = lambda v: str(v).lower() if not isinstance(v, bool) else ("yes" if v else "no")
    for task in ("became", "fusion", "reply_kind", "label_agreement"):
        pairs = [(norm(key[i]), a) for r in raters for i, a in r.items() if i.startswith(task)]
        agree = sum(a == b for a, b in pairs) / len(pairs) if pairs else None
        hh = [(r1[i], r2[i]) for r1, r2 in combinations(raters, 2) for i in r1 if i in r2 and i.startswith(task)]
        print(f"{task:16s} human vs judge: n={len(pairs)} agreement={agree and round(agree, 3)} kappa={kappa(pairs)}  "
              f"human vs human: n={len(hh)} kappa={kappa(hh)}")
    print(f"{len(raters)} raters, {sum(len(r) for r in raters)} answers")


if __name__ == "__main__":
    main(sys.argv[1])

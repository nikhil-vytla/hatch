"""Train the tiny One box model: one shared TF-IDF vocabulary, one logistic head per question.

The recipe is the repo's existing tiny classifier (src/jev_lab/teach.py): word unigrams and
bigrams, sublinear TF, L2 normalisation, LogisticRegression(C=4). Labels are Jev's recorded
top answers on development prefixes (scripts/one-box-tiny-data.ts), so this is distillation of
Jev's outputs: a research-preview comparison, not a Jev replacement.

    bun packages/arena/scripts/one-box-tiny-data.ts
    uv run --no-project --with scikit-learn==1.9.1 --with numpy==2.5.3 \\
      python packages/arena/scripts/train-one-box-tiny.py

Writes src/one-box/tiny/{vectorizer,heads,parity,training}.json. With --cv, writes five
out-of-fold models to .cache/one-box-tiny/cv-<fold>/ instead.
"""

import json
import random
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/one-box/tiny"
MAX_FEATURES = 3000
DECIMALS = 4

rows = [json.loads(line) for line in (ROOT / ".cache/one-box-tiny/train.jsonl").read_text().splitlines() if line]
texts = [r["text"] for r in rows]
questions = list(rows[0]["labels"].keys())



def train(rows):
    """One shared vocabulary and a head per question, fit on these rows."""
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, max_features=MAX_FEATURES)
    x = vectorizer.fit_transform([r["text"] for r in rows])
    heads, training = {}, {"prefixes": len(rows), "vocabulary": len(vectorizer.vocabulary_), "questions": {}}

    for q in questions:
        usable = [i for i, r in enumerate(rows) if q in r["labels"]]
        y = [rows[i]["labels"][q] for i in usable]
        classes = sorted(set(y))

        if len(classes) == 1:
            # Jev gave one answer on every training prefix: the head always predicts it.
            heads[q] = {"classes": classes, "weights": [], "bias": [0.0]}
            training["questions"][q] = {"labelled": len(usable), "classes": classes, "trainAccuracy": 1.0}
            continue

        model = LogisticRegression(C=4, max_iter=1000, random_state=42).fit(x[usable], y)
        heads[q] = {
            "classes": model.classes_.tolist(),
            "weights": np.round(model.coef_, DECIMALS).tolist(),
            "bias": model.intercept_.tolist(),
        }
        training["questions"][q] = {
            "labelled": len(usable),
            "classes": model.classes_.tolist(),
            "trainAccuracy": round(float(np.mean(model.predict(x[usable]) == np.array(y))), 4),
        }

    return vectorizer, heads, training


def export(directory, vectorizer, heads):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "vectorizer.json").write_text(
        json.dumps(
            {
                "kind": "tfidf",
                "tokenizer": "lowercase Unicode words with at least two characters; word unigrams and bigrams; sublinear TF; L2 normalization",
                "vocabulary": {term: int(index) for term, index in vectorizer.vocabulary_.items()},
                "idf": vectorizer.idf_.tolist(),
            },
            separators=(",", ":"),
        )
    )
    (directory / "heads.json").write_text(json.dumps(heads, separators=(",", ":")))


if "--cv" in sys.argv:
    # Out-of-fold models for an honest development estimate (scripts/one-box-tiny-cv.ts).
    folds = json.loads((ROOT / ".cache/one-box-tiny/folds.json").read_text())
    for f, keys in enumerate(folds["foldKeys"]):
        held = set(keys)
        fold_rows = [r for r in rows if r["text"] not in held]
        vectorizer, heads, _ = train(fold_rows)
        export(ROOT / f".cache/one-box-tiny/cv-{f}", vectorizer, heads)
        print(f"fold {f}: trained on {len(fold_rows)} prefixes, {len(held)} held out")
    sys.exit(0)

vectorizer, heads, training = train(rows)


def probabilities(head, features):
    """What the exported (rounded) head predicts, computed on sklearn's own features."""
    if not head["weights"]:
        return np.ones((features.shape[0], 1))
    logits = features @ np.array(head["weights"]).T + np.array(head["bias"])
    if logits.shape[1] == 1:
        logits = np.hstack([np.zeros_like(logits), logits])
    logits -= logits.max(axis=1, keepdims=True)
    e = np.exp(logits)
    return e / e.sum(axis=1, keepdims=True)


# Parity: a sample of development prefixes with the exported model's probabilities, which the
# TypeScript inference must reproduce, including its tokenisation.
sample = random.Random(20260926).sample(texts, 200)
xs = vectorizer.transform(sample)
parity = [
    {"text": t, "probabilities": {q: probabilities(heads[q], xs[i]).ravel().tolist() for q in questions}}
    for i, t in enumerate(sample)
]

export(OUT, vectorizer, heads)
(OUT / "parity.json").write_text(json.dumps(parity, separators=(",", ":")))
(OUT / "training.json").write_text(json.dumps(training, indent=1))

print(json.dumps(training, indent=1))
for name in ["vectorizer.json", "heads.json", "parity.json"]:
    print(name, (OUT / name).stat().st_size, "bytes")

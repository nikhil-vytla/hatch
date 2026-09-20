"""Teacher labeling and real parameter updates on a small beverage policy."""

import random

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from .compositions import DRINKS, drink_cases
from .core import choice, noul


def features(train, test):
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)
    x = vectorizer.fit_transform([r["text"] for r in train])
    return vectorizer, x, vectorizer.transform([r["text"] for r in test])


def exported(vectorizer, model):
    return {
        "kind": "tfidf-logistic",
        "vocabulary": vectorizer.vocabulary_,
        "idf": vectorizer.idf_.tolist(),
        "classes": model.classes_.tolist(),
        "weights": model.coef_.tolist(),
        "bias": model.intercept_.tolist(),
        "tokenizer": "lowercase Unicode words with at least two characters; word unigrams and bigrams; sublinear TF; L2 normalization",
    }


async def teach(client, quick=False):
    pool, test = drink_cases(160, seed=7), drink_cases(80, seed=991, heldout=True)
    vectorizer, x, xt = features(pool, test)
    cache, failures, methods = {}, [], {}
    budget = 16 if quick else 32
    rng = random.Random(42)
    initial = rng.sample(range(len(pool)), 8)

    async def label(indices):
        pending = [i for i in indices if i not in cache]
        for start in range(0, len(pending), 8):
            batch = pending[start : start + 8]
            try:
                out = await client.evaluate(
                    {"menu": DRINKS, "requests": {str(i): pool[i]["text"] for i in batch}},
                    {
                        str(i): choice(
                            f"Choose the menu item matching request {i}. Use only supplied menu facts.",
                            {k: str(v) for k, v in DRINKS.items()},
                        )
                        for i in batch
                    },
                    "teacher/labels",
                )
                cache.update({i: out["answers"][str(i)] for i in batch})
            except Exception as exc:
                failures.append({"indices": batch, "error": str(exc)})

    for method in ("random", "uncertainty"):
        selected, curve, model = [], [], None
        for count in range(8, budget + 1, 8):
            available = [i for i in range(len(pool)) if i not in selected]
            if not selected:
                batch = initial
            elif method == "random" or model is None:
                batch = rng.sample(available, 8)
            else:
                uncertainty = 1 - model.predict_proba(x[available]).max(axis=1)
                batch = [available[j] for j in np.argsort(-uncertainty, kind="stable")[:8]]
            selected.extend(batch)
            await label(batch)
            usable = [i for i in selected if i in cache]
            labels = [cache[i]["value"] for i in usable]
            if len(set(labels)) < 2:
                curve.append(
                    {"attempted_labels": count, "available_labels": len(usable), "accuracy": None}
                )
                continue
            model = LogisticRegression(C=4, max_iter=500, random_state=42).fit(x[usable], labels)
            prediction = model.predict(xt)
            curve.append(
                {
                    "attempted_labels": count,
                    "available_labels": len(usable),
                    "accuracy": float(np.mean(prediction == [r["target"] for r in test])),
                    "teacher_agreement_with_oracle": float(
                        np.mean([cache[i]["value"] == pool[i]["target"] for i in usable])
                    ),
                }
            )
        methods[method] = {
            "curve": curve,
            "selected_ids": [pool[i]["id"] for i in selected],
            "model": exported(vectorizer, model) if model is not None else None,
        }
        client.run.checkpoint({"methods": methods, "failures": failures})
    return {
        "methods": methods,
        "unique_teacher_labels": len(cache),
        "failures": failures,
        "test_size": len(test),
        "teacher_rows": [
            {"text": pool[i]["text"], "target": pool[i]["target"], "answer": a}
            for i, a in cache.items()
        ],
        "note": "Labels train a local TF-IDF classifier. Both acquisition policies receive the same attempted label budget. "
        "A deterministic fictional menu supplies independent test labels. Small authored templates limit generalization.",
    }


def softmax(logits):
    values = np.exp(logits - logits.max(axis=-1, keepdims=True))
    return values / values.sum(axis=-1, keepdims=True)


def optimize_policy(x, rewards, xt, targets, steps=240):
    """Full-information contextual-bandit objective with exact policy gradient."""
    weights = np.zeros((x.shape[1], rewards.shape[1]))
    curve = []
    for step in range(steps + 1):
        probabilities = softmax(x @ weights)
        expected = (probabilities * rewards).sum(axis=1, keepdims=True)
        if step % 20 == 0:
            curve.append(
                {
                    "step": step,
                    "mean_teacher_reward": float(expected.mean()),
                    "oracle_test_accuracy": float(
                        np.mean(np.argmax(xt @ weights, axis=1) == targets)
                    ),
                }
            )
        if step == steps:
            break
        # Gradient of E_pi[r], with L2 regularization. Every update changes actual policy weights.
        weights += 3.0 * (x.T @ (probabilities * (rewards - expected)) / len(x) - 0.0001 * weights)
    return weights, curve


async def reward(client, quick=False):
    train, test = drink_cases(16 if quick else 48, seed=17), drink_cases(80, seed=82, heldout=True)
    labels, rows, failures = list(DRINKS), [], []
    for start in range(0, len(train), 4):
        batch = train[start : start + 4]
        try:
            out = await client.evaluate(
                {"menu": DRINKS, "requests": {str(i): r["text"] for i, r in enumerate(batch)}},
                {
                    f"{i}_{j}": noul(
                        f"Does menu item '{name}' satisfy ALL explicit requirements of request {i}? "
                        "Treat the supplied fictional menu facts as authoritative."
                    )
                    for i in range(len(batch))
                    for j, name in enumerate(labels)
                },
                "reward/annotation",
            )
            rows += [
                {**r, "rewards": [out["answers"][f"{i}_{j}"]["value"] for j in range(len(labels))]}
                for i, r in enumerate(batch)
            ]
        except Exception as exc:
            failures.append({"start": start, "error": str(exc)})
    if not rows:
        return {
            "status": "partial",
            "failures": failures,
            "error": "No reward annotations succeeded",
        }
    vectorizer, x, xt = features(rows, test)
    targets = np.array([labels.index(r["target"]) for r in test])
    weights, curve = optimize_policy(
        x.toarray(), np.array([r["rewards"] for r in rows]), xt.toarray(), targets
    )
    return {
        "curve": curve,
        "train_size": len(rows),
        "test_size": len(test),
        "rows": rows,
        "failures": failures,
        "nonzero_parameters": int(np.count_nonzero(weights)),
        "weight_l2": float(np.linalg.norm(weights)),
        "model": {
            "kind": "tfidf-bandit",
            "vocabulary": vectorizer.vocabulary_,
            "idf": vectorizer.idf_.tolist(),
            "classes": labels,
            "weights": weights.T.tolist(),
            "bias": [0] * len(labels),
        },
        "note": "Jev supplies scalar compatibility rewards; exact policy-gradient updates train a local linear policy. "
        "This is a contextual-bandit pilot, not LLM RLHF. Oracle test accuracy is independent of the reward model. "
        "The fixed 240-step recipe never selects a checkpoint using the test curve.",
    }

"""Offline audit of the published reward pilot. Makes no model/API calls.

Run from repository root:
  jev-experiments/.venv/bin/python jev-experiments/quality-and-simulation-review/probes/reward.py
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from jev_lab.compositions import DRINKS, drink_cases
from jev_lab.records import read_record
from jev_lab.teach import features, optimize_policy, softmax


def rate(prediction, target):
    return float(np.mean(np.asarray(prediction) == np.asarray(target)))


def rule(text):
    """A declared grammar baseline, using request text and public menu only."""
    text = text.lower()
    props = {
        "temperature": "hot" if re.search(r"\b(hot|warm)\b", text) else "cold",
        "caffeine": "without caffeine" not in text,
        "dairy": "without dairy" not in text,
        "sweet": "not sweet" not in text,
    }
    return next(name for name, facts in DRINKS.items() if facts == props)


def wilson(correct, total):
    z = 1.959963984540054
    p = correct / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * np.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [float(centre - half), float(centre + half)]


document = read_record(ROOT / "results/reward.jsonl")
r = document["result"]
train = r["rows"]
test = drink_cases(80, seed=82, heldout=True)
classes = list(DRINKS)
train_targets = np.array([classes.index(row["target"]) for row in train])
test_targets = np.array([classes.index(row["target"]) for row in test])
rewards = np.array([row["rewards"] for row in train])
vectorizer, x, xt = features(train, test)
weights, curve = optimize_policy(x.toarray(), rewards, xt.toarray(), test_targets)
train_p, test_p = softmax(x @ weights), softmax(xt @ weights)
prediction = np.argmax(test_p, axis=1)
normalized = [dict(row, text=row["text"].replace("warm", "hot").replace("chilled", "cold")) for row in test]
xn = vectorizer.transform([row["text"] for row in normalized])
teacher_labels = np.argmax(rewards, axis=1)
supervised = LogisticRegression(C=4, max_iter=500, random_state=42).fit(x, teacher_labels)
oracle_rewards = np.eye(len(classes))[train_targets]
oracle_weights, oracle_curve = optimize_policy(x.toarray(), oracle_rewards, xt.toarray(), test_targets)

swap_examples = []
for row in test:
    facts = dict(row["requirements"])
    facts["temperature"] = "cold" if facts["temperature"] == "hot" else "hot"
    other = next((name for name, props in DRINKS.items() if props == facts), None)
    if other is None:
        continue
    text = row["text"]
    changed = text.replace("warm", "chilled") if "warm" in text else text.replace("chilled", "warm")
    same = (vectorizer.transform([text]) != vectorizer.transform([changed])).nnz == 0
    swap_examples.append({"id": row["id"], "target": row["target"], "opposite_target": other, "identical_features": same})

seed_rows = []
for seed in range(20):
    cases = drink_cases(80, seed=seed, heldout=True)
    sx = vectorizer.transform([row["text"] for row in cases])
    sy = [classes.index(row["target"]) for row in cases]
    seed_rows.append({"seed": seed, "accuracy": rate(np.argmax(sx @ weights, axis=1), sy)})

missing = sorted(set(row["id"] for row in drink_cases(48, seed=17)) - {row["id"] for row in train})
correct = int(np.count_nonzero(prediction == test_targets))
answer = {
    "provenance": {"source": "jev-experiments/results/reward.jsonl", "manifest": document["manifest"], "no_network_calls": True},
    "coverage": {"planned_train": 48, "usable_train": len(train), "test": len(test), "missing_ids": missing, "train_classes": dict(Counter(row["target"] for row in train)), "failures": r["failures"]},
    "reproduction": {"weight_max_abs_difference": float(np.max(np.abs(weights.T - np.asarray(r["model"]["weights"])))), "curve_max_abs_difference": max(abs(a[key] - b[key]) for a, b in zip(curve, r["curve"]) for key in a), "shape": list(weights.shape), "nonzero_parameters": int(np.count_nonzero(weights)), "l2": float(np.linalg.norm(weights))},
    "teacher_reward_quality": {"argmax_correct": int(np.count_nonzero(teacher_labels == train_targets)), "total": len(train), "target_reward_min": float(rewards[np.arange(len(train)), train_targets].min()), "target_reward_max": float(rewards[np.arange(len(train)), train_targets].max()), "off_target_reward_max": float(rewards[~oracle_rewards.astype(bool)].max()), "mean_absolute_error_from_oracle": float(np.abs(rewards - oracle_rewards).mean())},
    "final_metrics": {"train_expected_teacher_reward": float(np.mean(np.sum(train_p * rewards, axis=1))), "train_expected_oracle_success": float(np.mean(train_p[np.arange(len(train)), train_targets])), "train_greedy_oracle_accuracy": rate(np.argmax(train_p, axis=1), train_targets), "test_expected_oracle_success": float(np.mean(test_p[np.arange(len(test)), test_targets])), "test_greedy_oracle_correct": correct, "test_greedy_oracle_accuracy": correct / len(test), "test_wilson95_iid_only": wilson(correct, len(test)), "untrained_greedy_accuracy": r["curve"][0]["oracle_test_accuracy"], "normalized_temperature_accuracy": rate(np.argmax(xn @ weights, axis=1), test_targets)},
    "baselines": {"fixed_class_accuracy": 0.125, "uniform_random_expected_accuracy": 0.125, "declared_grammar_rule_accuracy": rate([rule(row["text"]) for row in test], [row["target"] for row in test]), "teacher_argmax_supervised_accuracy": rate(supervised.predict(xt), test_targets), "teacher_argmax_supervised_normalized_temperature_accuracy": rate(supervised.predict(xn), test_targets), "exact_oracle_rewards_accuracy": oracle_curve[-1]["oracle_test_accuracy"]},
    "generator_audit": {"temperature_tokens_in_vocabulary": {word: word in vectorizer.vocabulary_ for word in ["hot", "cold", "warm", "chilled"]}, "opposite_temperature_pairs": len(swap_examples), "opposite_temperature_identical_features": sum(row["identical_features"] for row in swap_examples), "semantic_groups_without_temperature": len(set((row["caffeine"], row["dairy"], row["sweet"]) for row in DRINKS.values())), "class_count": len(DRINKS), "twenty_test_template_seeds_same_trained_policy": seed_rows, "seed_accuracy_mean": float(np.mean([row["accuracy"] for row in seed_rows])), "seed_accuracy_min": min(row["accuracy"] for row in seed_rows), "seed_accuracy_max": max(row["accuracy"] for row in seed_rows)},
    "curve": r["curve"],
    "test_predictions": [{"id": row["id"], "text": row["text"], "target": row["target"], "prediction": classes[int(prediction[i])], "normalized_prediction": classes[int(np.argmax(xn @ weights, axis=1)[i])]} for i, row in enumerate(test)],
    "limits": ["This probe is post hoc and does not tune an evaluated checkpoint.", "The grammar baseline is tailored to this public authored fixture grammar, not a general language solver.", "Twenty test seeds vary wording order and introductions; they are not twenty independent training runs.", "The Wilson interval assumes independent Bernoulli cases and is descriptive only for these repeated authored templates."],
}
destination = Path(__file__).with_suffix(".json")
destination.write_text(json.dumps(answer, indent=2) + "\n")
print(json.dumps({key: value for key, value in answer.items() if key not in ["test_predictions", "curve"]}, indent=2))

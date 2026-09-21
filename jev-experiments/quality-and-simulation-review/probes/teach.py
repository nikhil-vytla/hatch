"""Read-only audit of teach's published model and authored test generator.

Run from the repository root with Python 3 and Bun. No paid calls or training.
The probe executes only DRINKS and drink_cases from the current source AST,
and uses the repository's existing TypeScript predictor for model inference.
"""

import ast
from collections import Counter
import itertools
import json
from pathlib import Path
import random
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
source = ast.parse((ROOT / "src/jev_lab/compositions.py").read_text())
nodes = [n for n in source.body if (
    isinstance(n, ast.Assign)
    and any(isinstance(t, ast.Name) and t.id == "DRINKS" for t in n.targets)
) or (isinstance(n, ast.FunctionDef) and n.name == "drink_cases")]
scope = {"random": random}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "compositions.py", "exec"), scope)
drinks, generate = scope["DRINKS"], scope["drink_cases"]
pool, test = generate(160, seed=7), generate(80, seed=991, heldout=True)

record_lines = (ROOT / "results/teach.jsonl").read_text().splitlines()
document = json.loads(record_lines[0])["document"]
for line in record_lines[1:]:
    entry = json.loads(line)
    target = document
    for key in entry["path"]:
        target = target[key]
    assert entry["index"] == len(target)
    target.append(entry["value"])
result = document["result"]


def predictions(model, rows):
    completed = subprocess.run(
        ["bun", str(ROOT / "tests/predict-browser.ts")],
        input=json.dumps({"model": model, "texts": [r["text"] for r in rows]}),
        capture_output=True, text=True, check=True,
    )
    probs = json.loads(completed.stdout)
    return [max(p, key=p.get) for p in probs], probs


def accuracy(guesses, rows):
    return sum(g == r["target"] for g, r in zip(guesses, rows)) / len(rows)


exhaustive = []
for name, props in drinks.items():
    parts = [
        {"hot": "warm", "cold": "chilled"}[props["temperature"]],
        "with caffeine" if props["caffeine"] else "without caffeine",
        "with dairy milk" if props["dairy"] else "without dairy",
        "sweet" if props["sweet"] else "not sweet",
    ]
    for intro, ordered in itertools.product(
        ["Could you find me", "I'm in the mood for", "Please recommend", "I'd enjoy"],
        itertools.permutations(parts),
    ):
        exhaustive.append({"text": f"{intro} a drink that is {', '.join(ordered)}.", "target": name})

restored = [{**r, "text": r["text"].replace("warm", "hot").replace("chilled", "cold")} for r in test]
swapped = [{**r, "text": r["text"].replace("warm", "TEMP").replace("chilled", "warm").replace("TEMP", "chilled")} for r in test]
by_id = {r["id"]: r for r in pool}
summary = {
    "published_run": document["manifest"],
    "pool_count": len(pool), "pool_unique_texts": len({r["text"] for r in pool}),
    "test_count": len(test), "test_unique_texts": len({r["text"] for r in test}),
    "train_test_exact_overlap": len({r["text"] for r in pool} & {r["text"] for r in test}),
    "test_class_counts": dict(Counter(r["target"] for r in test)),
    "semantic_requirement_combinations": len({tuple(r["requirements"].items()) for r in test}),
    "full_authored_heldout_template_space": len(exhaustive),
    "unique_teacher_labels": result["unique_teacher_labels"],
    "distinct_teacher_texts": len({r["text"] for r in result["teacher_rows"]}),
    "teacher_errors": sum(r["target"] != r["answer"]["value"] for r in result["teacher_rows"]),
    "failures": result["failures"],
    "methods": {},
}
for name, method in result["methods"].items():
    model, selected = method["model"], method["selected_ids"]
    guesses, probs = predictions(model, test)
    ex_guesses, _ = predictions(model, exhaustive)
    restored_guesses, _ = predictions(model, restored)
    swapped_guesses, swapped_probs = predictions(model, swapped)
    feature_groups = {}
    for row in exhaustive:
        words = re.findall(r"\w{2,}", row["text"].lower())
        terms = [*words, *(f"{a} {b}" for a, b in zip(words, words[1:]))]
        counts = Counter(t for t in terms if t in model["vocabulary"])
        signature = tuple(sorted(counts.items()))
        feature_groups.setdefault(signature, Counter())[row["target"]] += 1
    summary["methods"][name] = {
        "curve": method["curve"],
        "selected_count": len(selected),
        "selected_unique_texts": len({by_id[i]["text"] for i in selected}),
        "distinct_texts_by_round": [len({by_id[i]["text"] for i in selected[:b]}) for b in [8, 16, 24, 32]],
        "selected_class_counts": dict(Counter(by_id[i]["target"] for i in selected)),
        "initial_class_counts": dict(Counter(by_id[i]["target"] for i in selected[:8])),
        "vocabulary_size": len(model["vocabulary"]),
        "temperature_words_in_vocabulary": {t: t in model["vocabulary"] for t in ["hot", "cold", "warm", "chilled"]},
        "reproduced_test_accuracy": accuracy(guesses, test),
        "all_768_authored_test_templates_accuracy": accuracy(ex_guesses, exhaustive),
        "same_feature_group_accuracy_upper_bound": sum(max(c.values()) for c in feature_groups.values()) / len(exhaustive),
        "diagnostic_temperature_restored_accuracy": accuracy(restored_guesses, restored),
        "temperature_swap_probability_changes": sum(a != b for a, b in zip(probs, swapped_probs)),
        "temperature_swap_prediction_changes": sum(a != b for a, b in zip(guesses, swapped_guesses)),
        "test_class_accuracy": {label: sum(g == r["target"] for g, r in zip(guesses, test) if r["target"] == label) / 10 for label in drinks},
    }
summary["shared_selected_ids"] = len(set(result["methods"]["random"]["selected_ids"]) & set(result["methods"]["uncertainty"]["selected_ids"]))
print(json.dumps(summary, indent=2))

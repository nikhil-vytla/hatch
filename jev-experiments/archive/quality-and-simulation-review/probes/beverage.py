"""Read-only evidence probe for Drink finder. No network or model calls."""

import collections
import itertools
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
records = [json.loads(line) for line in (root / "results/beverage.jsonl").read_text().splitlines()]
rows = [row["value"] for row in records if row.get("path") == ["result", "rows"]]
answered = [row for row in rows if "error" not in row]
menu = records[0]["document"]["result"]["menu"]
baseline_correct = 0
for row in answered:
    text = row["text"]
    preferences = {
        "temperature": "hot" if "warm" in text else "cold",
        "caffeine": "without caffeine" not in text,
        "dairy": "without dairy" not in text,
        "sweet": "not sweet" not in text,
    }
    matches = [name for name, facts in menu.items() if facts == preferences]
    baseline_correct += matches == [row["target"]]

match_counts = collections.Counter()
axes = [["hot", "cold", None]] + [[True, False, None]] * 3
for values in itertools.product(*axes):
    preferences = dict(zip(["temperature", "caffeine", "dairy", "sweet"], values))
    matches = [
        name for name, facts in menu.items()
        if all(value is None or facts[key] == value for key, value in preferences.items())
    ]
    match_counts[len(matches)] += 1

print(json.dumps({
    "attempted": len(rows),
    "completed": len(answered),
    "failed_case_ids": [row["id"] for row in rows if "error" in row],
    "unique_completed_request_texts": len({row["text"] for row in answered}),
    "exact_duplicate_texts": {text: count for text, count in collections.Counter(row["text"] for row in answered).items() if count > 1},
    "jev_correct_completed": sum(row["prediction"] == row["target"] for row in answered),
    "literal_phrase_baseline_correct_completed": baseline_correct,
    "completed_predictions_with_probability_one": sum(max(row["probabilities"].values()) == 1 for row in answered),
    "all_partial_preference_states": sum(match_counts.values()),
    "partial_states_by_number_of_matches": dict(sorted(match_counts.items())),
    "fully_specified_preference_states": 16,
    "fully_specified_supported_states": len(menu),
    "fully_specified_unsupported_states": 16 - len(menu),
    "note": "The literal baseline exploits known authored templates; this is not evidence of open-language performance."
}, indent=2))

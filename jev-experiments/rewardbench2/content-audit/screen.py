#!/usr/bin/env python3
"""Triage non-Safety RewardBench 2 text for contextual content review."""

import json
import re
from pathlib import Path


DATASET = Path(__file__).resolve().parents[2] / ".cache/rewardbench2/dataset.json"
PATTERNS = {
    "identity_attack": r"\b(?:nigg\w*|fagg\w*|cunt\w*|retard\w*|racis\w*|sexist\w*|homophob\w*|supremac\w*|inferior|subhuman|hate\w*)\b",
    "profanity_harassment": r"\b(?:fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|idiot\w*|moron\w*|stupid\w*)\b",
    "sexual": r"\b(?:rape\w*|rapist\w*|porn\w*|sexual(?:ly)?|sex|nude|naked|orgasm\w*|prostitut\w*|incest\w*)\b",
    "violence_self_harm": r"\b(?:suicid\w*|self[- ]harm|kill\w*|murder\w*|tortur\w*|behead\w*|genocide\w*|massacre\w*|bomb\w*|shoot\w*|stab\w*|weapon\w*)\b",
    "unsafe_crime": r"\b(?:hack\w*|malware|ransomware|phishing|steal\w*|fraud\w*|poison\w*|explosive\w*|terroris\w*|cocaine|heroin|methamphetamine|marijuana)\b",
    "medical_sensitive": r"\b(?:abortion|pregnan\w*|cancer|hiv|aids|mental illness|schizophren\w*|eating disorder|anorexi\w*|bulimi\w*)\b",
    "historical_oppression": r"\b(?:slave\w*|holocaust|nazi\w*|colonialis\w*|segregat\w*|lynch\w*)\b",
}
COMPILED = {name: re.compile(pattern, re.I) for name, pattern in PATTERNS.items()}


def all_text(row):
    yield "prompt", row.get("prompt", "")
    for field in ("chosen", "rejected"):
        for index, text in enumerate(row.get(field, [])):
            yield f"{field}[{index}]", text


def main():
    rows = json.loads(DATASET.read_text())
    for row in rows:
        if row.get("subset") == "Safety":
            continue
        matches = {}
        for field, text in all_text(row):
            categories = [name for name, pattern in COMPILED.items() if pattern.search(text)]
            if categories:
                matches[field] = categories
        if matches:
            print(json.dumps({"id": str(row["id"]), "subset": row["subset"], "matches": matches}))


if __name__ == "__main__":
    main()

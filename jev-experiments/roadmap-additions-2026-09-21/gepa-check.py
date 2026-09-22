#!/usr/bin/env python3
"""Check the published GEPA test arithmetic using only the Python standard library.

Run: python3 gepa-check.py

Downloads exactly two pinned prediction JSON files into memory. Does not install
dependencies, persist upstream data, or contact a model endpoint. HTTPS validation
uses Python's configured certificate trust store.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import ssl
import sys
import urllib.request

REVISION = "b746a0f0d1908adc6108e688208251e1e3b763df"
BASE = (
    "https://raw.githubusercontent.com/Praneeth16/Praneeth16.github.io/"
    f"{REVISION}/study/gepa/run"
)
EXPECTED_ROWS = 300
MAX_BYTES = 5_000_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_predictions(name: str) -> tuple[dict[str, dict], str]:
    url = f"{BASE}/test_{name}.json"
    context = ssl.create_default_context()
    # Python.org macOS installations may lack their optional certificate bundle.
    # Add the system CA bundle while retaining certificate/hostname verification.
    system_ca = Path("/etc/ssl/cert.pem")
    if sys.platform == "darwin" and system_ca.is_file():
        context.load_verify_locations(cafile=str(system_ca))
    with urllib.request.urlopen(url, timeout=60, context=context) as response:
        raw = response.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, f"{name}: response exceeds byte limit")
    rows = json.loads(raw)
    require(isinstance(rows, list), f"{name}: expected a JSON array")
    require(len(rows) == EXPECTED_ROWS, f"{name}: expected {EXPECTED_ROWS} rows")
    indexed: dict[str, dict] = {}
    for position, row in enumerate(rows):
        prefix = f"{name}, row {position}"
        require(isinstance(row, dict), f"{prefix}: expected an object")
        row_id = row.get("id")
        require(
            isinstance(row_id, str)
            and len(row_id) == 64
            and all(c in "0123456789abcdef" for c in row_id),
            f"{prefix}: invalid sentence hash",
        )
        require(row_id not in indexed, f"{prefix}: duplicate sentence hash")
        require(row.get("split") == "test", f"{prefix}: not a test record")
        require(row.get("status") == "ok", f"{prefix}: incomplete prediction")
        require(
            type(row.get("label")) is int and row["label"] in (0, 1),
            f"{prefix}: label must be 0 or 1",
        )
        p = row.get("p_ade")
        require(
            type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1,
            f"{prefix}: invalid probability",
        )
        indexed[row_id] = row
    return indexed, hashlib.sha256(raw).hexdigest()


def metrics(rows: dict[str, dict]) -> dict:
    tn = fp = fn = tp = 0
    for row in rows.values():
        prediction = row["p_ade"] >= 0.5
        if prediction and row["label"]:
            tp += 1
        elif prediction:
            fp += 1
        elif row["label"]:
            fn += 1
        else:
            tn += 1
    n = len(rows)
    return {
        "n": n,
        "positive_n": tp + fn,
        "brier": math.fsum((r["p_ade"] - r["label"]) ** 2 for r in rows.values()) / n,
        "accuracy": (tp + tn) / n,
        "precision": tp / (tp + fp) if tp + fp else 0.0,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0,
        "confusion_tn_fp_fn_tp": [tn, fp, fn, tp],
    }


def main() -> None:
    original, original_hash = read_predictions("original")
    selected, selected_hash = read_predictions("gepa")
    require(original.keys() == selected.keys(), "The two test ID sets differ")
    require(
        all(original[row_id]["label"] == selected[row_id]["label"] for row_id in original),
        "The two test label mappings differ",
    )
    print(json.dumps({
        "source_revision": REVISION,
        "matched_ids_and_labels": True,
        "classification_cutoff": 0.5,
        "inputs_sha256": {
            "test_original.json": original_hash,
            "test_gepa.json": selected_hash,
        },
        "original": metrics(original),
        "selected": metrics(selected),
    }, indent=2, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GEPA arithmetic check failed: {error}", file=sys.stderr)
        sys.exit(1)
